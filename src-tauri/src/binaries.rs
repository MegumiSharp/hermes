//! Binary manager (SPEC 4.1): bundled tools live in hermes-data/bin.
//! Release builds carry the tools as a payload appended to Hermes.exe (scripts/pack.mjs):
//!   [exe][file bytes...][manifest json][u64 LE manifest length]["HERMESPK"]
//! Updates download the official release asset in-app; no console is ever shown.
use crate::net::{self, err};
use crate::{data_dir, read_json, write_json};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter};

pub const NO_WINDOW: u32 = 0x0800_0000;
const MAGIC: &[u8; 8] = b"HERMESPK";

#[derive(Deserialize)]
struct Tool {
    id: String,
    name: String,
    api: String,
    asset: String, // exact name or pattern with `*`
    files: Vec<String>,
    verify: Vec<String>,
    notify: bool,
}

static TOOLS: LazyLock<Vec<Tool>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../binaries.json")).expect("binaries.json"));

#[derive(Serialize, Deserialize, Clone)]
pub struct Ver {
    version: String,
    date: String, // release publish time, ISO 8601; newer = greater
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    id: String,
    name: String,
    version: Option<String>,
    date: Option<String>,
    ok: bool,
    error: Option<String>,
    notify: bool,
}

pub fn bin_dir() -> PathBuf {
    let dir = data_dir().join("bin");
    fs::create_dir_all(&dir).ok();
    dir
}

/// Hidden async command for a bundled tool, e.g. `command("yt-dlp.exe")`. The bin dir is put first
/// on PATH so tools find each other (yt-dlp and gallery-dl call ffmpeg).
pub fn command(file: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(bin_dir().join(file));
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs = vec![bin_dir()];
    dirs.extend(std::env::split_paths(&path));
    c.env("PATH", std::env::join_paths(dirs).unwrap_or(path));
    c.env("PYTHONIOENCODING", "utf-8"); // non-ASCII titles/paths in tool output
    c.creation_flags(NO_WINDOW);
    c
}

/// Runs a bundled tool that prints JSON (`yt-dlp -J`, `gallery-dl -j`) and returns it parsed.
/// On failure the error is the tool's last `ERROR:` line (or its last stderr line).
#[tauri::command]
pub async fn tool_json(bin: String, args: Vec<String>) -> Result<serde_json::Value, String> {
    let out = command(&bin).args(&args).stdin(std::process::Stdio::null()).output().await.map_err(err)?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let e = lines.iter().rev().find_map(|l| l.strip_prefix("ERROR: ")).or(lines.last().copied());
        return Err(e.unwrap_or("The tool failed without a message").to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("Unreadable tool output: {e}"))
}

fn tool(id: &str) -> Result<&'static Tool, String> {
    TOOLS.iter().find(|t| t.id == id).ok_or(format!("unknown tool {id}"))
}

fn versions_path() -> PathBuf {
    bin_dir().join("versions.json")
}

fn installed() -> HashMap<String, Ver> {
    read_json(&versions_path()).unwrap_or_default()
}

fn set_installed(id: &str, v: Ver) -> Result<(), String> {
    let mut all = installed();
    all.insert(id.into(), v);
    write_json(&versions_path(), &all)
}

// ---------- embedded payload ----------

#[derive(Deserialize)]
struct Entry {
    name: String,
    offset: u64,
    size: u64,
}

#[derive(Deserialize)]
struct Payload {
    tools: HashMap<String, Ver>,
    files: Vec<Entry>,
}

fn payload() -> Option<Payload> {
    let mut f = File::open(std::env::current_exe().ok()?).ok()?;
    let end = f.seek(SeekFrom::End(-16)).ok()?;
    let mut tail = [0u8; 16];
    f.read_exact(&mut tail).ok()?;
    if &tail[8..] != MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(tail[..8].try_into().ok()?);
    f.seek(SeekFrom::Start(end.checked_sub(len)?)).ok()?;
    let mut buf = vec![0; len as usize];
    f.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Moves `src` to bin/<name>. A running exe can be renamed but not overwritten, so the old one
/// is renamed to .old first (deleted now if possible, otherwise on next start).
fn install_file(src: &Path, name: &str) -> io::Result<()> {
    let dest = bin_dir().join(name);
    let old = dest.with_extension("old");
    fs::remove_file(&old).ok();
    if dest.exists() {
        fs::rename(&dest, &old)?;
    }
    if let Err(e) = fs::rename(src, &dest) {
        fs::rename(&old, &dest).ok();
        return Err(e);
    }
    fs::remove_file(&old).ok();
    Ok(())
}

fn extract(t: &Tool, p: &Payload) -> Result<(), String> {
    let ver = p.tools.get(&t.id).ok_or("not in payload")?;
    let mut exe = File::open(std::env::current_exe().map_err(err)?).map_err(err)?;
    for name in &t.files {
        let e = p.files.iter().find(|e| &e.name == name).ok_or(format!("{name} not in payload"))?;
        let tmp = bin_dir().join(format!("{name}.tmp"));
        exe.seek(SeekFrom::Start(e.offset)).map_err(err)?;
        io::copy(&mut (&mut exe).take(e.size), &mut File::create(&tmp).map_err(err)?).map_err(err)?;
        install_file(&tmp, name).map_err(err)?;
    }
    set_installed(&t.id, ver.clone())
}

/// Runs the tool's version command; Ok(first output line).
fn verify(t: &Tool) -> Result<String, String> {
    let exe = bin_dir().join(&t.files[0]);
    if !t.files.iter().all(|f| bin_dir().join(f).exists()) {
        return Err("Not installed".into());
    }
    let out = std::process::Command::new(&exe).args(&t.verify).creation_flags(NO_WINDOW).output().map_err(err)?;
    if !out.status.success() {
        return Err(format!("{} exited with {}", t.files[0], out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or_default().to_string())
}

fn status(t: &Tool, check: Result<String, String>) -> Status {
    let v = installed().remove(&t.id);
    Status {
        id: t.id.clone(),
        name: t.name.clone(),
        version: v.as_ref().map(|v| v.version.clone()),
        date: v.map(|v| v.date),
        ok: check.is_ok(),
        error: check.err(),
        notify: t.notify,
    }
}

/// Startup: extract missing/outdated tools from the payload, repair broken ones, report status.
#[tauri::command]
pub async fn binaries_init() -> Vec<Status> {
    static LOCK: Mutex<()> = Mutex::new(());
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(dir) = fs::read_dir(bin_dir()) {
            for f in dir.flatten().filter(|f| f.path().extension().is_some_and(|e| e == "old" || e == "tmp")) {
                fs::remove_file(f.path()).ok();
            }
        }
        let p = payload();
        let inst = installed();
        TOOLS
            .iter()
            .map(|t| {
                if let Some(p) = &p {
                    let embedded = p.tools.get(&t.id);
                    let stale = match (inst.get(&t.id), embedded) {
                        (Some(i), Some(e)) => e.date > i.date,
                        (None, Some(_)) => true,
                        _ => false,
                    };
                    let missing = !t.files.iter().all(|f| bin_dir().join(f).exists());
                    if missing || stale {
                        extract(t, p).ok();
                    }
                }
                let mut check = verify(t);
                if check.is_err() {
                    if let Some(p) = &p {
                        if extract(t, p).is_ok() {
                            check = verify(t);
                        }
                    }
                }
                status(t, check)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

// ---------- updates ----------

/// Matches `name` against a pattern whose `*` matches any text without '-' (so "gpl-*.zip"
/// skips "gpl-shared-9.0.zip"); Some(text matched by the first `*`).
fn glob(pat: &str, name: &str) -> Option<String> {
    let parts: Vec<&str> = pat.split('*').collect();
    if parts.len() == 1 {
        return (pat == name).then(String::new);
    }
    let mut rest = name.strip_prefix(parts[0])?;
    let mut first = None;
    for (i, p) in parts[1..].iter().enumerate() {
        let at = if i == parts.len() - 2 { rest.len().checked_sub(p.len()).filter(|_| rest.ends_with(p))? } else { rest.find(p)? };
        if rest[..at].contains('-') {
            return None;
        }
        first.get_or_insert_with(|| rest[..at].to_string());
        rest = &rest[at + p.len()..];
    }
    first
}

/// Numbers inside a string, for "n10.0" > "n9.0" style comparisons.
fn natural(s: &str) -> Vec<u64> {
    s.split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse().ok()).collect()
}

/// Latest release asset for a tool: (version info, asset name, url).
async fn latest(t: &Tool) -> Result<(Ver, String, String), String> {
    let rel = net::latest_release(&t.api).await?.ok_or("no release")?;
    let (cap, name, url) = rel
        .assets
        .into_iter()
        .filter_map(|(n, u)| glob(&t.asset, &n).map(|c| (c, n, u)))
        .max_by_key(|(c, ..)| natural(c))
        .ok_or(format!("no asset matching {}", t.asset))?;
    // Rolling "latest" releases (FFmpeg) have no version in the tag: use the asset's + build date.
    let version = if rel.tag == "latest" {
        format!("{cap} · {}", rel.date.get(..10).unwrap_or_default())
    } else {
        rel.tag.trim_start_matches('v').to_string()
    };
    Ok((Ver { version, date: rel.date }, name, url))
}

#[derive(Serialize)]
pub struct Latest {
    versions: HashMap<String, Ver>,
    errors: Vec<String>, // "<tool>: <reason>" for checks that failed
}

/// Latest available version per tool id.
#[tauri::command]
pub async fn binaries_latest() -> Latest {
    let mut out = Latest { versions: HashMap::new(), errors: vec![] };
    for t in TOOLS.iter() {
        match latest(t).await {
            Ok((v, ..)) => drop(out.versions.insert(t.id.clone(), v)),
            Err(e) => out.errors.push(format!("{}: {e}", t.name)),
        }
    }
    out
}

/// Downloads and installs the latest release of a tool. Emits "binary-progress" [id, done, total].
#[tauri::command]
pub async fn binary_update(app: AppHandle, id: String) -> Result<Status, String> {
    let t = tool(&id)?;
    let (ver, asset, url) = latest(t).await?;
    let tmp = data_dir().join("temp").join(format!("update-{id}"));
    fs::remove_dir_all(&tmp).ok();
    fs::create_dir_all(&tmp).map_err(err)?;
    let file = tmp.join(&asset);
    net::download(&url, &file, |done, total| {
        app.emit("binary-progress", (&id, done, total)).ok();
    })
    .await?;

    let result = (|| {
        let sources: Vec<PathBuf> = if asset.ends_with(".zip") {
            let ok = std::process::Command::new("tar")
                .arg("-xf")
                .arg(&file)
                .arg("-C")
                .arg(&tmp)
                .creation_flags(NO_WINDOW)
                .status()
                .map_err(err)?
                .success();
            if !ok {
                return Err("Could not extract the archive".to_string());
            }
            t.files.iter().map(|f| find(&tmp, f).ok_or(format!("{f} not in archive"))).collect::<Result<_, _>>()?
        } else {
            vec![file.clone()]
        };
        if !sources.iter().all(|s| net::is_exe(s)) {
            return Err("Downloaded file is not an exe".into());
        }
        for (src, name) in sources.iter().zip(&t.files) {
            install_file(src, name).map_err(err)?;
        }
        set_installed(&t.id, ver)
    })();
    fs::remove_dir_all(&tmp).ok();
    result?;
    Ok(status(t, verify(t)))
}

fn find(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find(&p, name) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_and_natural() {
        assert_eq!(glob("yt-dlp.exe", "yt-dlp.exe"), Some(String::new()));
        assert_eq!(glob("yt-dlp.exe", "yt-dlp_x86.exe"), None);
        let pat = "ffmpeg-n*-latest-win64-gpl-*.zip";
        assert_eq!(glob(pat, "ffmpeg-n9.0-latest-win64-gpl-9.0.zip").as_deref(), Some("9.0"));
        assert_eq!(glob(pat, "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip").as_deref(), None);
        assert_eq!(glob(pat, "ffmpeg-master-latest-win64-gpl.zip"), None);
        assert!(natural("10.0") > natural("9.1"));
    }
}
