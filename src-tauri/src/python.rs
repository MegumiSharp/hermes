//! Portable Python AI runtime (SPEC 11): an embeddable CPython in hermes-data/python with
//! PyTorch (CUDA 12.4) shared by Demucs and faster-whisper. Installed only after the user
//! confirms; everything stays inside hermes-data.
use crate::{binaries, data_dir, net, read_json, write_json};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Stdio};
use tauri::{AppHandle, Emitter};

const PYTHON_ZIP: &str = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip";
const GET_PIP: &str = "https://bootstrap.pypa.io/get-pip.py";
const TORCH: [&str; 4] = ["torch==2.5.1", "--index-url", "https://download.pytorch.org/whl/cu124", "--extra-index-url=https://pypi.org/simple"];
/// Scripts Hermes runs with this Python (kept in sync on every start).
const WHISPER_SCRIPT: &str = include_str!("../python/hermes_whisper.py");

pub fn dir() -> PathBuf {
    data_dir().join("python")
}

pub fn exe() -> PathBuf {
    dir().join("python.exe")
}

fn state_path() -> PathBuf {
    dir().join("hermes-installed.json")
}

/// `{ installed: {torch, demucs, whisper: bool}, dir }` (false when missing or outdated)
#[tauri::command]
pub fn python_status() -> Value {
    let s: Value = read_json(&state_path()).unwrap_or_else(|| json!({}));
    if exe().exists() {
        write_scripts();
    }
    let ok = |f| exe().exists() && is_installed(&s, f);
    json!({ "installed": { "torch": ok("torch"), "demucs": ok("demucs"), "whisper": ok("whisper") }, "dir": dir() })
}

fn write_scripts() {
    let d = dir().join("hermes");
    fs::create_dir_all(&d).ok();
    fs::write(d.join("hermes_whisper.py"), WHISPER_SCRIPT).ok();
}

/// Bump a revision when its package list changes: existing installs then re-run that pip step.
fn revision(feature: &str) -> i64 {
    match feature {
        "whisper" => 2, // 2: pin av==13.1.0 (faster-whisper 1.2.1 breaks on PyAV 14+)
        _ => 1,
    }
}

fn is_installed(s: &Value, feature: &str) -> bool {
    s[feature].as_i64().or(s[feature].as_bool().map(|b| b as i64)).unwrap_or(0) >= revision(feature)
}

fn mark(feature: &str) {
    let mut s: Value = read_json(&state_path()).unwrap_or_else(|| json!({}));
    s[feature] = json!(revision(feature));
    write_json(&state_path(), &s).ok();
}

/// Emits "python-progress" {stage, detail, pct (0-1 or null)}.
fn progress(app: &AppHandle, stage: &str, detail: &str, pct: Option<f64>) {
    app.emit("python-progress", json!({ "stage": stage, "detail": detail, "pct": pct })).ok();
}

/// Runs python with live output → progress events. pip's `--progress-bar raw` prints
/// "Progress <done> of <total>" lines while downloading.
async fn run_py(app: &AppHandle, stage: &str, args: &[&str]) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let mut child = binaries::command("python.exe")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let (mut b1, mut b2) = ([0u8; 4096], [0u8; 4096]);
    let (mut o_done, mut e_done) = (false, false);
    let mut tail = String::new();
    let mut pending = String::new();
    while !(o_done && e_done) {
        let chunk = tokio::select! {
            n = out.read(&mut b1), if !o_done => match n { Ok(0) | Err(_) => { o_done = true; continue } Ok(n) => String::from_utf8_lossy(&b1[..n]).to_string() },
            n = err.read(&mut b2), if !e_done => match n { Ok(0) | Err(_) => { e_done = true; continue } Ok(n) => String::from_utf8_lossy(&b2[..n]).to_string() },
        };
        pending.push_str(&chunk);
        while let Some(i) = pending.find(['\n', '\r']) {
            let line: String = pending.drain(..=i).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            tail = line.to_string();
            let pct = line.strip_prefix("Progress ").and_then(|p| {
                let (a, b) = p.split_once(" of ")?;
                Some(a.trim().parse::<f64>().ok()? / b.trim().parse::<f64>().ok()?.max(1.0))
            });
            progress(app, stage, if pct.is_some() { "" } else { line }, pct);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("{stage} failed: {tail}")) }
}

/// Installs Python (if needed), PyTorch and the requested features ("demucs", "whisper").
#[tauri::command]
pub async fn python_install(app: AppHandle, features: Vec<String>) -> Result<(), String> {
    let d = dir();
    if !exe().exists() {
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let zip = d.join("python.zip");
        progress(&app, "Downloading Python", "", Some(0.0));
        net::download(PYTHON_ZIP, &zip, |a, b| progress(&app, "Downloading Python", "", (b > 0).then(|| a as f64 / b as f64))).await?;
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut tar = std::process::Command::new(root.join(r"System32\tar.exe"));
        std::os::windows::process::CommandExt::creation_flags(&mut tar, binaries::NO_WINDOW);
        if !tar.arg("-xf").arg(&zip).arg("-C").arg(&d).status().map_err(|e| e.to_string())?.success() {
            return Err("Could not extract Python".into());
        }
        fs::remove_file(&zip).ok();
        // embeddable Python ignores site-packages until `import site` is enabled in its ._pth
        for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
            if e.path().extension().is_some_and(|x| x == "_pth") {
                let pth = fs::read_to_string(e.path()).unwrap_or_default().replace("#import site", "import site");
                fs::write(e.path(), format!("Lib\\site-packages\n{pth}")).map_err(|e| e.to_string())?;
            }
        }
        let get_pip = d.join("get-pip.py");
        net::download(GET_PIP, &get_pip, |_, _| {}).await?;
        run_py(&app, "Installing pip", &[&get_pip.to_string_lossy(), "--no-warn-script-location"]).await?;
        fs::remove_file(&get_pip).ok();
    }
    write_scripts();
    let pip = ["-m", "pip", "install", "--no-warn-script-location", "--progress-bar", "raw", "--disable-pip-version-check"];
    let installed: Value = read_json(&state_path()).unwrap_or_else(|| json!({}));
    if !is_installed(&installed, "torch") {
        let args: Vec<&str> = pip.iter().chain(TORCH.iter()).copied().collect();
        run_py(&app, "Installing PyTorch (CUDA)", &args).await?;
        mark("torch");
    }
    for f in &features {
        let pkg: &[&str] = match f.as_str() {
            "demucs" => &["demucs==4.1.0", "soundfile"],
            "whisper" => &["faster-whisper==1.2.1", "av==13.1.0"],
            _ => return Err(format!("unknown feature {f}")),
        };
        if is_installed(&installed, f) {
            continue;
        }
        let args: Vec<&str> = pip.iter().chain(pkg.iter()).copied().collect();
        run_py(&app, &format!("Installing {}", if f == "demucs" { "Demucs" } else { "faster-whisper" }), &args).await?;
        mark(f);
    }
    progress(&app, "Done", "", Some(1.0));
    Ok(())
}

/// Deletes the whole runtime (models in hermes-data/models stay).
#[tauri::command]
pub fn python_remove() -> Result<(), String> {
    fs::remove_dir_all(dir()).map_err(|e| e.to_string())
}

/// Names of downloaded faster-whisper models (folders "models--<org>--faster-whisper-<name>").
#[tauri::command]
pub fn whisper_models() -> Vec<String> {
    let d = data_dir().join("models").join("whisper");
    fs::read_dir(d)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().split("faster-whisper-").nth(1).map(String::from))
        .collect()
}
