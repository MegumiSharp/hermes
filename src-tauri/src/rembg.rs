//! Background removal (SPEC 7): rembg's ONNX models run natively with ONNX Runtime + DirectML
//! (any DX12 GPU, CPU fallback). Pre/post-processing mirrors rembg's sessions so results match.
//! Models live in hermes-data/models/rembg and are only downloaded after the user confirms.
use crate::{data_dir, net, now_ms};
use image::{imageops::FilterType, DynamicImage, GrayImage, ImageDecoder, ImageReader, Rgba, RgbaImage};
use ort::{ep, session::Session};
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter};

const BASE: &str = "https://github.com/danielgatis/rembg/releases/download/v0.0.0";
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    BiRefNet,
    IsNet,
    IsNetAnime,
    U2Net,
}

impl Kind {
    fn size(self) -> u32 {
        if self == Kind::U2Net { 320 } else { 1024 }
    }
    fn norm(self) -> ([f32; 3], [f32; 3]) {
        match self {
            Kind::IsNet => ([0.5; 3], [1.0; 3]),
            Kind::IsNetAnime => (IMAGENET_MEAN, [1.0; 3]),
            _ => (IMAGENET_MEAN, IMAGENET_STD),
        }
    }
}

struct Model {
    id: &'static str,
    name: &'static str,
    file: &'static str,
    mb: u32,
    speed: &'static str,
    use_case: &'static str,
    kind: Kind,
}

const MODELS: &[Model] = &[
    Model { id: "birefnet-general", name: "BiRefNet General", file: "BiRefNet-general-epoch_244.onnx", mb: 927, speed: "Slow", use_case: "Best overall: fine edges, hair, products", kind: Kind::BiRefNet },
    Model { id: "birefnet-general-lite", name: "BiRefNet General Lite", file: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx", mb: 213, speed: "Medium", use_case: "Lighter BiRefNet, good quality", kind: Kind::BiRefNet },
    Model { id: "birefnet-portrait", name: "BiRefNet Portrait", file: "BiRefNet-portrait-epoch_150.onnx", mb: 927, speed: "Slow", use_case: "People and portraits", kind: Kind::BiRefNet },
    Model { id: "birefnet-massive", name: "BiRefNet Massive", file: "BiRefNet-massive-TR_DIS5K_TR_TEs-epoch_420.onnx", mb: 927, speed: "Slow", use_case: "Complex scenes, many objects", kind: Kind::BiRefNet },
    Model { id: "isnet-general-use", name: "ISNet General", file: "isnet-general-use.onnx", mb: 170, speed: "Fast", use_case: "Objects and products, quick results", kind: Kind::IsNet },
    Model { id: "isnet-anime", name: "ISNet Anime", file: "isnet-anime.onnx", mb: 167, speed: "Fast", use_case: "Anime and illustrations", kind: Kind::IsNetAnime },
    Model { id: "u2net", name: "U2Net", file: "u2net.onnx", mb: 167, speed: "Fastest", use_case: "Legacy baseline", kind: Kind::U2Net },
];

fn model(id: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|m| m.id == id).ok_or(format!("unknown model {id}"))
}

fn models_dir() -> PathBuf {
    let d = data_dir().join("models").join("rembg");
    fs::create_dir_all(&d).ok();
    d
}

fn model_path(m: &Model) -> PathBuf {
    models_dir().join(m.file)
}

/// Installed models: (id, display name, release file name, local path).
pub fn installed() -> Vec<(&'static str, &'static str, &'static str, PathBuf)> {
    MODELS.iter().filter(|m| model_path(m).exists()).map(|m| (m.id, m.name, m.file, model_path(m))).collect()
}

pub const RELEASE_API: &str = "https://api.github.com/repos/danielgatis/rembg/releases/tags/v0.0.0";

/// Where module results live (kept for the before/after preview after Eagle import).
pub fn results_dir() -> PathBuf {
    let d = data_dir().join("results");
    fs::create_dir_all(&d).ok();
    d
}

/// Deletes preview results older than 7 days.
pub fn cleanup_results() {
    let week = Duration::from_secs(7 * 24 * 3600);
    let dirs = [results_dir(), data_dir().join("thumbs")];
    for e in dirs.iter().flat_map(|d| fs::read_dir(d).into_iter().flatten().flatten()) {
        let old = e.metadata().and_then(|m| m.modified()).is_ok_and(|t| SystemTime::now().duration_since(t).unwrap_or_default() > week);
        if old {
            fs::remove_file(e.path()).ok();
        }
    }
}

// ---------- inference ----------

static ENV: LazyLock<Result<ort::environment::Environment, String>> = LazyLock::new(|| {
    load_directml();
    ort::init().with_name("hermes").build().map_err(|e| e.to_string())
});

/// DirectML.dll is delay-loaded (build.rs): load the bundled copy by full path first, so the
/// delay-load stub binds to it instead of an older System32 version.
fn load_directml() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
    }
    let dll = crate::binaries::bin_dir().join("DirectML.dll");
    if dll.exists() {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain([0]).collect();
        unsafe { LoadLibraryW(wide.as_ptr()) };
    }
}
/// How a model runs. Some models hit DirectML bugs in fused graph nodes ("DmlFusedNode_19_64"):
/// they fall back to DirectML without graph fusion, then to the CPU.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Gpu,
    GpuSafe,
    Cpu,
    /// "Gentle" setting: CPU on 2 threads only. Slower, but leaves the GPU (desktop, video) and
    /// most cores free, so the PC stays smooth.
    Gentle,
}

impl Mode {
    fn next(self) -> Option<Mode> {
        match self {
            Mode::Gpu => Some(Mode::GpuSafe),
            Mode::GpuSafe => Some(Mode::Cpu),
            Mode::Cpu | Mode::Gentle => None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Mode::Gpu => "GPU",
            Mode::GpuSafe => "GPU (safe mode)",
            Mode::Cpu => "CPU",
            Mode::Gentle => "CPU (gentle)",
        }
    }
}

/// One loaded model at a time (BiRefNet is ~1 GB of GPU memory). The lock also serialises GPU work.
static SESSION: Mutex<Option<(&'static str, Mode, Session)>> = Mutex::new(None);
/// Per model, the first mode that worked (skips known-bad modes for the next images).
static WORKING_MODE: LazyLock<Mutex<std::collections::HashMap<&'static str, Mode>>> = LazyLock::new(Default::default);

fn load(m: &'static Model, mode: Mode) -> Result<Session, String> {
    use ort::session::builder::GraphOptimizationLevel;
    let path = model_path(m);
    if !path.exists() {
        return Err(format!("Model {} is not downloaded", m.name));
    }
    let env = ENV.as_ref().map_err(Clone::clone)?;
    let e = |e: ort::Error<_>| e.to_string();
    let mut b = Session::builder(env).map_err(|e| e.to_string())?;
    b = match mode {
        Mode::Gpu | Mode::GpuSafe => b
            .with_memory_pattern(false) // required by DirectML
            .map_err(e)?
            .with_parallel_execution(false)
            .map_err(e)?
            .with_execution_providers([ep::DirectML::default().build().error_on_failure(), ep::CPU::default().build()])
            .map_err(e)?,
        Mode::Cpu | Mode::Gentle => b.with_execution_providers([ep::CPU::default().build()]).map_err(e)?,
    };
    // leave half the cores free so the PC stays responsive (CPU work: fallback mode + graph ops)
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    let threads = if mode == Mode::Gentle { 2 } else { (cores / 2).max(1) };
    b = b.with_intra_threads(threads).map_err(e)?.with_inter_threads(1).map_err(e)?;
    if mode == Mode::GpuSafe {
        b = b.with_optimization_level(GraphOptimizationLevel::Level1).map_err(e)?; // no node fusion
    }
    b.commit_from_file(path).map_err(|e| e.to_string())
}

fn open_image(path: &str) -> Result<DynamicImage, String> {
    let mut decoder = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| format!("Unsupported image: {e}"))?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation); // phone photos
    Ok(img)
}

/// Alpha mask (0-255) at the image's size, plus the device that produced it.
fn predict(m: &'static Model, img: &DynamicImage, gentle: bool) -> Result<(GrayImage, Mode), String> {
    let s = m.kind.size();
    let rgb = img.resize_exact(s, s, FilterType::Lanczos3).to_rgb8();
    let max = rgb.as_raw().iter().copied().max().unwrap_or(255).max(1) as f32; // rembg divides by the max pixel
    let (mean, std) = m.kind.norm();
    let n = (s * s) as usize;
    let mut data = vec![0f32; 3 * n];
    for (i, p) in rgb.pixels().enumerate() {
        for c in 0..3 {
            data[c * n + i] = (p[c] as f32 / max - mean[c]) / std[c];
        }
    }
    let shape = [1usize, 3, s as usize, s as usize];

    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let mut mode = if gentle { Mode::Gentle } else { WORKING_MODE.lock().unwrap().get(m.id).copied().unwrap_or(Mode::Gpu) };
    let raw: Vec<f32> = loop {
        let attempt = (|| {
            if guard.as_ref().is_none_or(|(id, md, _)| *id != m.id || *md != mode) {
                *guard = None; // free the previous model first
                *guard = Some((m.id, mode, load(m, mode)?));
            }
            let session = &mut guard.as_mut().unwrap().2;
            let input = ort::value::Tensor::from_array((shape, data.clone())).map_err(|e| e.to_string())?;
            let outputs = session.run(ort::inputs![input]).map_err(|e| e.to_string())?;
            let (_, out) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            Ok::<_, String>(out[..n].to_vec())
        })();
        match attempt {
            Ok(v) => break v,
            Err(e) => match mode.next() {
                Some(next) => {
                    *guard = None;
                    mode = next;
                }
                None => return Err(e),
            },
        }
    };
    if mode != Mode::Gentle {
        WORKING_MODE.lock().unwrap().insert(m.id, mode); // gentle is a choice, not a capability
    }
    let pred: Vec<f32> = raw.iter().map(|&v| if m.kind == Kind::BiRefNet { 1.0 / (1.0 + (-v).exp()) } else { v }).collect();
    let (lo, hi) = pred.iter().fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
    let range = (hi - lo).max(1e-6);
    let bytes: Vec<u8> = pred.iter().map(|v| (((v - lo) / range) * 255.0).round() as u8).collect();
    let mask = GrayImage::from_raw(s, s, bytes).ok_or("bad mask size")?;
    Ok((image::imageops::resize(&mask, img.width(), img.height(), FilterType::Lanczos3), mode))
}

/// Applies the mask; optional solid background ("#rrggbb") and crop to the subject.
fn compose(img: &DynamicImage, mask: &GrayImage, background: &str, crop: bool) -> RgbaImage {
    let mut out = img.to_rgba8();
    let bg = u32::from_str_radix(background.trim_start_matches('#'), 16).ok().filter(|_| background.len() == 7);
    for (p, a) in out.pixels_mut().zip(mask.pixels()) {
        let a = a[0];
        *p = match bg {
            None => Rgba([p[0], p[1], p[2], a]),
            Some(c) => {
                let mix = |fg: u8, bg: u32| ((fg as u32 * a as u32 + bg * (255 - a as u32)) / 255) as u8;
                Rgba([mix(p[0], c >> 16 & 255), mix(p[1], c >> 8 & 255), mix(p[2], c & 255), 255])
            }
        };
    }
    if crop {
        let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
        for (x, y, a) in mask.enumerate_pixels() {
            if a[0] > 16 {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
        }
        if x0 <= x1 && y0 <= y1 {
            return image::imageops::crop_imm(&out, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
        }
    }
    out
}

/// Inference runs below normal priority so the desktop stays fluid while a model works.
fn lower_thread_priority() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThread() -> *mut std::ffi::c_void;
        fn SetThreadPriority(thread: *mut std::ffi::c_void, priority: i32) -> i32;
    }
    const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) };
}

/// Queue step entry point: input image -> PNG cut-out at `output`. Returns the device used.
pub async fn remove(model_id: &str, input: &str, output: &str, background: &str, crop: bool, gentle: bool) -> Result<&'static str, String> {
    let m = model(model_id)?;
    let (input, output, background) = (input.to_string(), output.to_string(), background.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        lower_thread_priority();
        let img = open_image(&input)?;
        let (mask, mode) = predict(m, &img, gentle)?;
        if let Some(dir) = PathBuf::from(&output).parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        compose(&img, &mask, &background, crop).save(&output).map_err(|e| e.to_string())?;
        Ok(mode.label())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Small cached JPEG (max 320 px) of an image for trays and result strips, so the UI never decodes
/// 20-megapixel originals just to show a card. Cache key = path + size + mtime.
#[tauri::command]
pub async fn thumbnail(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::hash::{Hash, Hasher};
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (path.as_str(), meta.len(), meta.modified().ok()).hash(&mut h);
        let dir = data_dir().join("thumbs");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("{:016x}.jpg", h.finish()));
        if !out.exists() {
            lower_thread_priority();
            let img = open_image(&path)?.thumbnail(320, 320);
            // JPEG has no alpha: flatten cut-outs on a neutral grey so they stay readable
            let mut bg = image::RgbImage::from_pixel(img.width(), img.height(), image::Rgb([40, 40, 44]));
            for (x, y, p) in img.to_rgba8().enumerate_pixels() {
                let a = p[3] as u32;
                let d = bg.get_pixel_mut(x, y);
                for c in 0..3 {
                    d[c] = ((p[c] as u32 * a + d[c] as u32 * (255 - a)) / 255) as u8;
                }
            }
            bg.save(&out).map_err(|e| e.to_string())?;
        }
        Ok(out.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: &'static str,
    name: &'static str,
    mb: u32,
    speed: &'static str,
    use_case: &'static str,
    installed: bool,
}

#[tauri::command]
pub fn rembg_models() -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|m| ModelInfo { id: m.id, name: m.name, mb: m.mb, speed: m.speed, use_case: m.use_case, installed: model_path(m).exists() })
        .collect()
}

/// Downloads models (user already confirmed names + total size). Emits "model-progress" [id, done, total].
#[tauri::command]
pub async fn rembg_download(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    for id in ids {
        let m = model(&id)?;
        let dest = model_path(m);
        if dest.exists() {
            continue;
        }
        let part = dest.with_extension("part");
        net::download(&format!("{BASE}/{}", m.file), &part, |done, total| {
            app.emit("model-progress", (&id, done, total)).ok();
        })
        .await?;
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn rembg_delete(id: String) -> Result<(), String> {
    let m = model(&id)?;
    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().is_some_and(|(loaded, ..)| *loaded == m.id) {
        *guard = None;
    }
    fs::remove_file(model_path(m)).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct CompareResult {
    model: String,
    output: String,
    ms: u64,
    device: String,
    error: Option<String>,
}

/// Runs several models on one image for the compare grid. Results go to hermes-data/results.
/// Emits "rembg-compare" with each result as it finishes, so the UI fills in progressively.
#[tauri::command]
pub async fn rembg_compare(app: AppHandle, input: String, models: Vec<String>, gentle: Option<bool>) -> Vec<CompareResult> {
    let gentle = gentle.unwrap_or(false);
    let stem = PathBuf::from(&input).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut out = vec![];
    for id in models {
        let output = results_dir().join(format!("{stem}-{id}-{}.png", now_ms())).display().to_string();
        let t = Instant::now();
        let r = remove(&id, &input, &output, "", false, gentle).await;
        let res = CompareResult {
            model: id,
            output,
            ms: t.elapsed().as_millis() as u64,
            device: r.as_ref().map(|d| d.to_string()).unwrap_or_default(),
            error: r.err(),
        };
        app.emit("rembg-compare", &res).ok();
        out.push(res);
    }
    out
}
