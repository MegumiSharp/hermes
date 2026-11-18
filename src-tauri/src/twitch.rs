//! twitch-dlp (Twitch VODs, lives from the start, clips, hidden VODs, unmuting) as an optional component.
//! It is a Node.js script, so it comes with a portable node.exe: both live in bin/twitch/, with a
//! package.json that marks the script as an ES module and holds its version.
use crate::binaries::bin_dir;
use crate::net::{self, client, err};
use crate::data_dir;
use serde::Serialize;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Emitter};

const API: &str = "https://api.github.com/repos/DmitryScaletta/twitch-dlp/releases/latest";

pub fn dir() -> PathBuf {
    bin_dir().join("twitch")
}
fn version() -> String {
    let pkg: serde_json::Value = fs::read_to_string(dir().join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    pkg["version"].as_str().unwrap_or_default().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchStatus {
    installed: bool,
    version: String,
    node: String, // full path of node.exe (the queue runs it)
    script: String,
}

#[tauri::command]
pub fn twitch_status() -> TwitchStatus {
    let (node, script) = (dir().join("node.exe"), dir().join("twitch-dlp.js"));
    TwitchStatus {
        installed: node.exists() && script.exists(),
        version: version(),
        node: node.to_string_lossy().into(),
        script: script.to_string_lossy().into(),
    }
}

/// Newest twitch-dlp release tag (without "v").
#[tauri::command]
pub async fn twitch_latest() -> Result<String, String> {
    let rel = net::latest_release(API).await?.ok_or("no release")?;
    Ok(rel.tag.trim_start_matches('v').to_string())
}

/// Installs node.exe (current LTS, only if missing) and the latest twitch-dlp.js.
/// Emits "twitch-progress" [stage, done, total].
#[tauri::command]
pub async fn twitch_install(app: AppHandle) -> Result<TwitchStatus, String> {
    let d = dir();
    fs::create_dir_all(&d).map_err(err)?;
    let tmp = data_dir().join("temp").join("twitch");
    fs::remove_dir_all(&tmp).ok();
    fs::create_dir_all(&tmp).map_err(err)?;
    if !d.join("node.exe").exists() {
        let index: serde_json::Value = client().get("https://nodejs.org/dist/index.json").send().await.map_err(err)?.json().await.map_err(err)?;
        let v = index.as_array().into_iter().flatten()
            .find(|r| !r["lts"].is_boolean() && r["files"].as_array().is_some_and(|f| f.iter().any(|x| x == "win-x64-zip")))
            .and_then(|r| r["version"].as_str()).ok_or("no Node.js LTS for Windows")?.to_string();
        let zip = tmp.join("node.zip");
        net::download(&format!("https://nodejs.org/dist/{v}/node-{v}-win-x64.zip"), &zip, |done, total| {
            app.emit("twitch-progress", ("Node.js", done, total)).ok();
        })
        .await?;
        app.emit("twitch-progress", ("Unpacking Node.js", 0, 0)).ok();
        // only node.exe is needed (no npm): tar can extract one member of a zip
        let member = format!("node-{v}-win-x64/node.exe");
        let ok = crate::binaries::tar().arg("-xf").arg(&zip).arg("-C").arg(&tmp).arg(&member).status().map_err(err)?.success();
        let exe = tmp.join(&member);
        if !ok || !net::is_exe(&exe) {
            return Err("Could not unpack Node.js".into());
        }
        fs::rename(&exe, d.join("node.exe")).or_else(|_| fs::copy(&exe, d.join("node.exe")).map(|_| ())).map_err(err)?;
    }
    let rel = net::latest_release(API).await?.ok_or("no twitch-dlp release")?;
    let url = rel.assets.iter().find(|(n, _)| n == "twitch-dlp.js").map(|(_, u)| u.clone()).ok_or("no twitch-dlp.js in the release")?;
    let js = tmp.join("twitch-dlp.js");
    net::download(&url, &js, |done, total| {
        app.emit("twitch-progress", ("twitch-dlp", done, total)).ok();
    })
    .await?;
    if fs::metadata(&js).map(|m| m.len()).unwrap_or(0) < 1000 {
        return Err("twitch-dlp download is empty".into());
    }
    fs::copy(&js, d.join("twitch-dlp.js")).map_err(err)?;
    let version = rel.tag.trim_start_matches('v');
    fs::write(d.join("package.json"), format!(r#"{{"type": "module", "version": "{version}"}}"#)).map_err(err)?;
    fs::remove_dir_all(&tmp).ok();
    Ok(twitch_status())
}

#[tauri::command]
pub fn twitch_remove() -> Result<(), String> {
    fs::remove_dir_all(dir()).map_err(err)
}
