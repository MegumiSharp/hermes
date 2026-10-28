//! LibreOffice as an optional component (Document Converter: faithful DOCX/ODT/PPTX/XLSX → PDF,
//! PDF → DOCX). Not on GitHub: the official MSI from download.documentfoundation.org is unpacked
//! with `msiexec /a` (an administrative image: no install, no admin rights) into bin/libreoffice.
use crate::binaries::{bin_dir, NO_WINDOW};
use crate::net::{self, err};
use crate::data_dir;
use serde::Serialize;
use std::{fs, os::windows::process::CommandExt, path::PathBuf};
use tauri::{AppHandle, Emitter};

const STABLE: &str = "https://download.documentfoundation.org/libreoffice/stable/";

pub fn dir() -> PathBuf {
    bin_dir().join("libreoffice")
}
pub fn exe() -> PathBuf {
    dir().join("program").join("soffice.exe")
}
fn version_file() -> PathBuf {
    dir().join("hermes-version.txt")
}

#[derive(Serialize)]
pub struct OfficeStatus {
    installed: bool,
    version: String,
}

#[tauri::command]
pub fn office_status() -> OfficeStatus {
    OfficeStatus { installed: exe().exists(), version: fs::read_to_string(version_file()).unwrap_or_default().trim().into() }
}

/// Newest "x.y.z/" folder of the stable directory listing.
async fn latest_version() -> Result<String, String> {
    let html = net::client().get(STABLE).send().await.map_err(err)?.text().await.map_err(err)?;
    let mut versions: Vec<(Vec<u64>, String)> = html
        .split("href=\"")
        .filter_map(|s| s.split('"').next())
        .filter_map(|h| h.strip_suffix('/'))
        .filter(|v| v.split('.').count() == 3 && v.split('.').all(|p| p.parse::<u64>().is_ok()))
        .map(|v| (v.split('.').map(|p| p.parse().unwrap()).collect(), v.to_string()))
        .collect();
    versions.sort();
    versions.pop().map(|v| v.1).ok_or("No LibreOffice version found".into())
}

/// Downloads (~375 MB) and unpacks LibreOffice. Emits `office-progress` [stage, done, total].
#[tauri::command]
pub async fn office_install(app: AppHandle) -> Result<OfficeStatus, String> {
    let v = latest_version().await?;
    let tmp = data_dir().join("temp").join("libreoffice");
    fs::remove_dir_all(&tmp).ok();
    fs::create_dir_all(&tmp).map_err(err)?;
    let msi = tmp.join("libreoffice.msi");
    let url = format!("{STABLE}{v}/win/x86_64/LibreOffice_{v}_Win_x86-64.msi");
    net::download(&url, &msi, |done, total| {
        app.emit("office-progress", ("Downloading", done, total)).ok();
    })
    .await?;
    app.emit("office-progress", ("Unpacking", 0, 0)).ok();
    let target = tmp.join("image");
    let (m, t) = (msi.clone(), target.clone());
    let ok = tauri::async_runtime::spawn_blocking(move || {
        // msiexec wants PROPERTY="value": Rust would quote the whole argument (paths have spaces) and
        // msiexec would show its usage window instead of working silently
        std::process::Command::new("msiexec.exe")
            .raw_arg(format!("/a \"{}\" /qn TARGETDIR=\"{}\"", m.display(), t.display()))
            .creation_flags(NO_WINDOW)
            .status()
            .map(|s| s.success())
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    if !ok || !target.join("program").join("soffice.exe").exists() {
        fs::remove_dir_all(&tmp).ok();
        return Err("Could not unpack LibreOffice".into());
    }
    fs::remove_dir_all(dir()).ok();
    fs::rename(&target, dir()).map_err(err)?;
    fs::write(version_file(), &v).ok();
    fs::remove_dir_all(&tmp).ok();
    Ok(office_status())
}

#[tauri::command]
pub fn office_remove() -> Result<(), String> {
    fs::remove_dir_all(data_dir().join("libreoffice-profile")).ok();
    match fs::remove_dir_all(dir()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}
