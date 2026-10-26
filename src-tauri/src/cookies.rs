//! Cookies for sites that need a login (SPEC 4.4). Browser extraction is yt-dlp's
//! `--cookies-from-browser`; the fallback is a user-exported cookies.txt kept in hermes-data/cookies.
use crate::data_dir;
use std::{fs, path::PathBuf};

/// Browsers with a profile on this PC, in preference order (Firefox first: Chromium browsers on
/// Windows encrypt cookies with app-bound keys that extraction often can't read).
#[tauri::command]
pub fn detect_browsers() -> Vec<&'static str> {
    let env = |k| std::env::var_os(k).map(PathBuf::from).unwrap_or_default();
    let (roaming, local) = (env("APPDATA"), env("LOCALAPPDATA"));
    [
        ("firefox", roaming.join(r"Mozilla\Firefox\Profiles")),
        ("chrome", local.join(r"Google\Chrome\User Data")),
        ("edge", local.join(r"Microsoft\Edge\User Data")),
        ("brave", local.join(r"BraveSoftware\Brave-Browser\User Data")),
    ]
    .into_iter()
    .filter(|(_, p)| p.is_dir())
    .map(|(b, _)| b)
    .collect()
}

fn file(site: &str) -> Result<PathBuf, String> {
    if site.is_empty() || !site.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid site id".into());
    }
    let dir = data_dir().join("cookies");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{site}.txt")))
}

/// Saves an already validated cookies.txt for a site; returns its path for `--cookies`.
#[tauri::command]
pub fn cookies_write(site: String, text: String) -> Result<String, String> {
    let path = file(&site)?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Path of the saved cookies.txt for a site, if any.
#[tauri::command]
pub fn cookies_path(site: String) -> Option<String> {
    file(&site).ok().filter(|p| p.exists()).map(|p| p.display().to_string())
}
