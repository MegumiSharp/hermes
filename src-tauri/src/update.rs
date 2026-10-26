//! App self-update from GitHub Releases (SPEC 4.6).
use serde::Serialize;
use std::{fs, io::Write, time::Duration};
use tauri::{AppHandle, Emitter};

const LATEST: &str = "https://api.github.com/repos/MegumiSharp/hermes/releases/latest";
const ASSET: &str = "Hermes.exe";

#[derive(Serialize)]
pub struct Update {
    version: String,
    url: String,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent("Hermes").build().expect("http client")
}

/// Newer release than the running app, or None (also None when the repo has no release yet).
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Update>, String> {
    let res = client().get(LATEST).send().await.map_err(err)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let rel: serde_json::Value = res.error_for_status().map_err(err)?.json().await.map_err(err)?;
    let tag = rel["tag_name"].as_str().unwrap_or_default().trim_start_matches('v');
    let latest = semver::Version::parse(tag).map_err(err)?;
    if latest <= app.package_info().version {
        return Ok(None);
    }
    let url = rel["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"] == ASSET)
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or(format!("release {tag} has no {ASSET}"))?;
    Ok(Some(Update { version: latest.to_string(), url: url.into() }))
}

/// Downloads the new exe (emitting "update-progress" [done, total]), swaps it in and relaunches.
/// Windows lets a running exe be renamed but not overwritten, hence the .old dance.
#[tauri::command]
pub async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Updates are disabled in dev builds".into());
    }
    let exe = std::env::current_exe().map_err(err)?;
    let new = exe.with_extension("exe.new");
    let old = exe.with_extension("exe.old");

    let mut res = client().get(&url).send().await.map_err(err)?.error_for_status().map_err(err)?;
    let total = res.content_length().unwrap_or(0);
    let mut file = fs::File::create(&new).map_err(err)?;
    let mut done = 0u64;
    let mut head = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(err)? {
        if head.len() < 2 {
            head.extend_from_slice(&chunk[..chunk.len().min(2)]);
        }
        file.write_all(&chunk).map_err(err)?;
        done += chunk.len() as u64;
        app.emit("update-progress", (done, total)).ok();
    }
    drop(file);
    if (total != 0 && done != total) || !head.starts_with(b"MZ") {
        fs::remove_file(&new).ok();
        return Err("Downloaded file is incomplete or not an exe".into());
    }

    fs::remove_file(&old).ok();
    fs::rename(&exe, &old).map_err(err)?;
    if let Err(e) = fs::rename(&new, &exe) {
        fs::rename(&old, &exe).ok();
        return Err(err(e));
    }
    std::process::Command::new(&exe).spawn().map_err(err)?;
    app.exit(0);
    Ok(())
}

/// Removes Hermes.exe.old left by an update; retries while the previous process is still exiting.
pub fn cleanup_old_exe() {
    let Ok(exe) = std::env::current_exe() else { return };
    let old = exe.with_extension("exe.old");
    std::thread::spawn(move || {
        for _ in 0..20 {
            if !old.exists() || fs::remove_file(&old).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}
