mod audible;
mod binaries;
mod cookies;
mod eagle;
mod net;
mod python;
mod queue;
mod rembg;
mod stats;
mod update;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

/// Everything Hermes writes lives next to the exe (portable).
pub fn data_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("exe path");
    let dir = exe.parent().expect("exe dir").join("hermes-data");
    fs::create_dir_all(&dir).ok();
    dir
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Write to a temp file then rename, so a crash never leaves a half-written file.
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

static SETTINGS: LazyLock<Mutex<Value>> =
    LazyLock::new(|| Mutex::new(read_json(&data_dir().join("settings.json")).unwrap_or_else(|| serde_json::json!({}))));

/// One settings.json value, as last saved by the frontend (Null when unset).
pub fn setting(key: &str) -> Value {
    SETTINGS.lock().unwrap()[key].clone()
}

#[tauri::command]
fn data_path() -> String {
    data_dir().display().to_string()
}

#[tauri::command]
fn load_settings() -> Value {
    SETTINGS.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(settings: Value) -> Result<(), String> {
    write_json(&data_dir().join("settings.json"), &settings)?;
    *SETTINGS.lock().unwrap() = settings;
    Ok(())
}

/// Folders modules need: `{ data, bin, results }`.
#[tauri::command]
fn module_paths() -> Value {
    serde_json::json!({
        "data": data_dir(), "bin": binaries::bin_dir(), "results": rembg::results_dir(), "python": python::dir(),
    })
}

/// Writes a per-job file (e.g. a gallery-dl filter config) to hermes-data/jobs; returns its path.
/// Kept until the queue no longer needs it; the folder is small text files only.
#[tauri::command]
fn write_job_file(name: String, text: String) -> Result<String, String> {
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err("invalid file name".into());
    }
    let dir = data_dir().join("jobs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Copies a result to a user folder ("Keep" in compare mode); creates the folder.
#[tauri::command]
fn copy_file(from: String, to: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&to).parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
}

/// Creates folders a job's tools expect to exist (ffmpeg won't create its output folder).
#[tauri::command]
fn make_dirs(paths: Vec<String>) -> Result<(), String> {
    paths.iter().try_for_each(|p| fs::create_dir_all(p).map_err(|e| e.to_string()))
}

/// Stores a file dropped onto the window (HTML5 drop gives bytes, not paths) in hermes-data/uploads.
/// Raw body = file bytes, header `x-name` = original file name. Returns the saved path.
#[tauri::command]
fn save_upload(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("upload");
    let name = urlencoding_decode(name);
    let safe: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    // own folder per drop: keeps the original file name (it ends up in output names and Eagle)
    let dir = data_dir().join("uploads").join(now_ms().to_string());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Header values are ASCII; the frontend sends the name with encodeURIComponent.
fn urlencoding_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    update::cleanup_old_exe();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The window starts hidden so the frontend can restore its saved size/position first.
            // Safety net: show it anyway if the frontend hasn't after 3 s.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(w) = tauri::Manager::get_webview_window(&handle, "main") {
                    if !w.is_visible().unwrap_or(true) {
                        w.show().ok();
                    }
                }
            });
            rembg::cleanup_results();
            queue::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data_path,
            load_settings,
            save_settings,
            update::check_update,
            update::install_update,
            binaries::binaries_init,
            binaries::binaries_latest,
            binaries::binary_update,
            binaries::tool_json,
            cookies::detect_browsers,
            cookies::cookies_write,
            cookies::cookies_path,
            eagle::eagle_status,
            queue::queue_get,
            queue::queue_add,
            queue::queue_action,
            queue::queue_pause_all,
            queue::queue_clear_finished,
            queue::queue_resume_now,
            audible::audible_status,
            audible::audible_login_start,
            audible::audible_login_finish,
            audible::audible_logout,
            audible::audible_library,
            python::python_status,
            python::python_install,
            python::python_remove,
            python::whisper_models,
            stats::system_stats,
            rembg::rembg_models,
            rembg::rembg_download,
            rembg::rembg_delete,
            rembg::rembg_compare,
            module_paths,
            write_job_file,
            save_upload,
            copy_file,
            make_dirs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                queue::shutdown();
            }
        });
}
