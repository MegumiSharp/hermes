//! "Are my AI models up to date?" (Binaries page → AI models).
//! - rembg models: compared with the files in rembg's model release (size).
//! - Whisper models: compared with the Hugging Face revision (commit sha in the local cache).
//! - Python packages (PyTorch, Demucs, faster-whisper): installed vs PyPI. Hermes pins tested
//!   versions, so these are informational; new pins arrive with Hermes updates.
use crate::net::{client, err};
use crate::{data_dir, python, rembg};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf, process::Stdio};
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    kind: &'static str, // "rembg" | "whisper" | "python"
    id: String,
    name: String,
    installed: String,
    latest: String,
    outdated: bool,
    note: String,
}

async fn json(url: &str) -> Result<Value, String> {
    client().get(url).send().await.map_err(err)?.error_for_status().map_err(err)?.json().await.map_err(err)
}

fn whisper_dir() -> PathBuf {
    data_dir().join("models").join("whisper")
}

/// Downloaded Whisper models: (folder name, "org/repo", local sha).
fn whisper_models() -> Vec<(String, String, String)> {
    fs::read_dir(whisper_dir()).into_iter().flatten().flatten().filter_map(|e| {
        let dir = e.file_name().to_string_lossy().to_string();
        let repo = dir.strip_prefix("models--")?.replacen("--", "/", 1);
        let sha = fs::read_to_string(e.path().join("refs").join("main")).unwrap_or_default().trim().to_string();
        Some((dir, repo, sha))
    }).collect()
}

#[tauri::command]
pub async fn models_status() -> Vec<ModelStatus> {
    let mut out = vec![];

    // rembg: one API call lists every model file with its size
    let installed = rembg::installed();
    if !installed.is_empty() {
        let remote = json(rembg::RELEASE_API).await;
        for (id, name, file, path) in installed {
            let local = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let size = remote.as_ref().ok().and_then(|r| r["assets"].as_array()?.iter().find(|a| a["name"] == file)?["size"].as_u64());
            out.push(ModelStatus {
                kind: "rembg", id: id.into(), name: format!("{name} (Background Removal)"),
                installed: format!("{} MB", local / 1_048_576),
                latest: size.map_or("unknown".into(), |s| format!("{} MB", s / 1_048_576)),
                outdated: size.is_some_and(|s| s != local),
                note: if remote.is_err() { "Could not reach GitHub".into() } else { String::new() },
            });
        }
    }

    // Whisper: Hugging Face exposes the current commit sha of each model repo
    for (dir, repo, sha) in whisper_models() {
        let remote = json(&format!("https://huggingface.co/api/models/{repo}")).await;
        let latest = remote.as_ref().ok().and_then(|r| r["sha"].as_str().map(String::from));
        let name = repo.rsplit('/').next().unwrap_or(&repo).replace("faster-whisper-", "Whisper ");
        out.push(ModelStatus {
            kind: "whisper", id: dir, name: format!("{name} (Subtitles)"),
            installed: sha.get(..7).unwrap_or("?").into(),
            latest: latest.as_deref().and_then(|s| s.get(..7)).unwrap_or("unknown").into(),
            outdated: latest.is_some_and(|l| !sha.is_empty() && l != sha),
            note: if remote.is_err() { "Could not reach Hugging Face".into() } else { String::new() },
        });
    }

    // Python packages of the AI runtime
    if python::exe().exists() {
        let list = crate::binaries::command("python.exe")
            .args(["-m", "pip", "list", "--format", "json", "--disable-pip-version-check"])
            .stdin(Stdio::null())
            .output()
            .await;
        let pkgs: Vec<Value> = list.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or_default();
        for (pkg, label) in [("torch", "PyTorch"), ("demucs", "Demucs"), ("faster-whisper", "faster-whisper")] {
            let Some(v) = pkgs.iter().find(|p| p["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(pkg))) else { continue };
            let installed = v["version"].as_str().unwrap_or_default().to_string();
            let latest = json(&format!("https://pypi.org/pypi/{pkg}/json")).await.ok()
                .and_then(|j| j["info"]["version"].as_str().map(String::from)).unwrap_or_else(|| "unknown".into());
            let newer = latest != "unknown" && !installed.starts_with(&latest);
            out.push(ModelStatus {
                kind: "python", id: pkg.into(), name: format!("{label} (AI runtime)"), installed, latest,
                outdated: false, // pinned on purpose: updates arrive with Hermes once tested together
                note: if newer { "Newer version exists; Hermes adopts it after testing".into() } else { String::new() },
            });
        }
    }
    out
}

/// Re-downloads one model (rembg: replace the file; Whisper: refresh the Hugging Face snapshot).
#[tauri::command]
pub async fn model_update(app: AppHandle, kind: String, id: String) -> Result<(), String> {
    match kind.as_str() {
        "rembg" => {
            let (_, _, _, path) = rembg::installed().into_iter().find(|m| m.0 == id).ok_or("model not installed")?;
            fs::rename(&path, path.with_extension("old")).map_err(err)?; // restored if the download fails
            match rembg::rembg_download(app, vec![id]).await {
                Ok(()) => { fs::remove_file(path.with_extension("old")).ok(); Ok(()) }
                Err(e) => { fs::rename(path.with_extension("old"), &path).ok(); Err(e) }
            }
        }
        "whisper" => {
            let repo = whisper_models().into_iter().find(|m| m.0 == id).ok_or("model not installed")?.1;
            let code = format!("from huggingface_hub import snapshot_download; snapshot_download('{repo}', cache_dir=r'{}')", whisper_dir().display());
            let out = crate::binaries::command("python.exe").args(["-c", &code]).stdin(Stdio::null()).output().await.map_err(err)?;
            if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("update failed").to_string()) }
        }
        _ => Err("This component updates together with Hermes".into()),
    }
}
