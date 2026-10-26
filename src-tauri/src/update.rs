//! App self-update from GitHub Releases (SPEC 4.6).
use crate::net::{self, err};
use serde::Serialize;
use std::{fs, time::Duration};
use tauri::{AppHandle, Emitter};

const LATEST: &str = "https://api.github.com/repos/MegumiSharp/hermes/releases/latest";
const ASSET: &str = "Hermes.exe";

#[derive(Serialize)]
pub struct Update {
    version: String,
    url: String,
}

/// Newer release than the running app, or None (also None when the repo has no release yet).
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Update>, String> {
    let Some(rel) = net::latest_release(LATEST).await? else { return Ok(None) };
    let latest = semver::Version::parse(rel.tag.trim_start_matches('v')).map_err(err)?;
    if latest <= app.package_info().version {
        return Ok(None);
    }
    let (_, url) = rel
        .assets
        .into_iter()
        .find(|(name, _)| name == ASSET)
        .ok_or(format!("release {} has no {ASSET}", rel.tag))?;
    Ok(Some(Update { version: latest.to_string(), url }))
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

    net::download(&url, &new, |done, total| {
        app.emit("update-progress", (done, total)).ok();
    })
    .await?;
    if !net::is_exe(&new) {
        fs::remove_file(&new).ok();
        return Err("Downloaded file is not an exe".into());
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
