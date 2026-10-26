//! Audible (SPEC 10): audible-cli for login/library/download, ffmpeg for the M4B conversion.
//! Config + auth live in hermes-data/audible (AUDIBLE_CONFIG_DIR, set in binaries::command).
//! Login: audible-cli prints an Amazon sign-in URL; the user signs in in their own browser and
//! pastes the final address back. Hermes never sees the Amazon password.
use crate::queue::{run_tool, Parser, Stop};
use crate::{binaries, data_dir};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH: &str = "hermes.json";

pub fn config_dir() -> PathBuf {
    let d = data_dir().join("audible");
    fs::create_dir_all(&d).ok();
    d
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub fn audible_status() -> Value {
    let country = fs::read_to_string(config_dir().join("config.toml"))
        .ok()
        .and_then(|c| c.lines().find_map(|l| l.strip_prefix("country_code = \"").map(|v| v.trim_end_matches('"').to_string())));
    serde_json::json!({ "loggedIn": config_dir().join(AUTH).exists(), "country": country })
}

// ---------- login ----------

struct Login {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    output: Arc<Mutex<String>>,
}

static LOGIN: tokio::sync::Mutex<Option<Login>> = tokio::sync::Mutex::const_new(None);

/// Starts `audible manage auth-file add --external-login`; returns the Amazon sign-in URL.
#[tauri::command]
pub async fn audible_login_start(country: String) -> Result<String, String> {
    if !country.chars().all(|c| c.is_ascii_lowercase()) || country.len() != 2 {
        return Err("invalid country".into());
    }
    let mut slot = LOGIN.lock().await;
    if let Some(old) = slot.take() {
        kill(old.child.id());
    }
    let dir = config_dir();
    fs::remove_file(dir.join(AUTH)).ok();
    fs::write(
        dir.join("config.toml"),
        format!("title = \"Audible Config File\"\n\n[APP]\nprimary_profile = \"hermes\"\n\n[profile.hermes]\nauth_file = \"{AUTH}\"\ncountry_code = \"{country}\"\n"),
    )
    .map_err(err)?;
    // -p "": no auth-file password (the interactive password prompt reads the console, not stdin)
    let mut child = binaries::command("audible.exe")
        .args(["manage", "auth-file", "add", "-f", AUTH, "-cc", &country, "--external-login", "-p", ""])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(err)?;
    let output = Arc::new(Mutex::new(String::new()));
    for mut pipe in [Box::new(child.stdout.take().unwrap()) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, Box::new(child.stderr.take().unwrap())] {
        let out = output.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                out.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
    }
    let stdin = child.stdin.take().unwrap();
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let text = output.lock().unwrap().clone();
        if let Some(url) = text.split_whitespace().find(|w| w.starts_with("https://") && w.contains("/ap/signin")) {
            let url = url.to_string();
            *slot = Some(Login { child, stdin, output });
            return Ok(url);
        }
        if let Ok(Some(_)) = child.try_wait() {
            return Err(format!("audible-cli stopped: {}", text.trim()));
        }
    }
    kill(child.id());
    Err("audible-cli did not provide a sign-in link".into())
}

/// Sends the address the browser ended on after sign-in; waits for the device registration.
#[tauri::command]
pub async fn audible_login_finish(url: String) -> Result<(), String> {
    let mut slot = LOGIN.lock().await;
    let mut login = slot.take().ok_or("Start the sign-in again")?;
    login.stdin.write_all(format!("{}\n", url.trim()).as_bytes()).await.map_err(err)?;
    login.stdin.flush().await.map_err(err)?;
    let status = tokio::time::timeout(Duration::from_secs(120), login.child.wait()).await;
    let text = login.output.lock().unwrap().clone();
    match status {
        Ok(Ok(s)) if s.success() && config_dir().join(AUTH).exists() => Ok(()),
        Ok(_) => Err(last_meaningful(&text)),
        Err(_) => {
            kill(login.child.id());
            Err("Timed out waiting for Audible".into())
        }
    }
}

fn last_meaningful(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let e = lines.iter().rev().find(|l| l.to_lowercase().contains("error")).or(lines.last());
    e.map_or("Sign-in failed".into(), |l| l.to_string())
}

fn kill(pid: Option<u32>) {
    if let Some(pid) = pid {
        let mut c = std::process::Command::new("taskkill");
        std::os::windows::process::CommandExt::creation_flags(&mut c, binaries::NO_WINDOW);
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).status().ok();
    }
}

/// Forgets the account on this PC (the device stays listed in the Amazon account).
#[tauri::command]
pub fn audible_logout() -> Result<(), String> {
    for f in [AUTH, "config.toml", "library.json", "activation_bytes"] {
        fs::remove_file(config_dir().join(f)).ok();
    }
    Ok(())
}

// ---------- library ----------

/// The library as exported by audible-cli (cached in hermes-data/audible/library.json).
#[tauri::command]
pub async fn audible_library(refresh: bool) -> Result<Value, String> {
    let file = config_dir().join("library.json");
    if refresh || !file.exists() {
        let out = binaries::command("audible.exe")
            .args(["library", "export", "-f", "json", "-o"])
            .arg(&file)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(err)?;
        if !out.status.success() {
            return Err(last_meaningful(&format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))));
        }
    }
    serde_json::from_str(&fs::read_to_string(&file).map_err(err)?).map_err(err)
}

// ---------- download + convert (queue step) ----------

fn safe(name: &str) -> String {
    let s: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { "Unknown".into() } else { s.chars().take(150).collect() }
}

fn find_ext(dir: &Path, ext: &str) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)))
}

/// AAX key: the account's activation bytes (fetched once, cached).
async fn activation_bytes() -> Result<String, Stop> {
    let cache = config_dir().join("activation_bytes");
    if let Ok(b) = fs::read_to_string(&cache) {
        return Ok(b.trim().to_string());
    }
    let out = binaries::command("audible.exe").arg("activation-bytes").stdin(Stdio::null()).output().await.map_err(|e| Stop::Failed(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let bytes = text.split_whitespace().rev().find(|w| w.len() == 8 && w.chars().all(|c| c.is_ascii_hexdigit()));
    let bytes = bytes.ok_or_else(|| Stop::Failed("Could not get the activation bytes".into()))?.to_string();
    fs::write(&cache, &bytes).ok();
    Ok(bytes)
}

/// Downloads one book and converts it to `<folder>\<author>\<title>.m4b` (chapters + cover kept).
pub async fn download_book(id: &str, asin: &str, title: &str, author: &str, duration: f64, folder: &str) -> Result<Vec<String>, Stop> {
    let fail = |m: String| Stop::Failed(m);
    if !asin.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(fail("invalid ASIN".into()));
    }
    let work = config_dir().join("work").join(asin);
    fs::remove_dir_all(&work).ok();
    fs::create_dir_all(&work).map_err(|e| fail(e.to_string()))?;
    let w = work.display().to_string();
    let args: Vec<String> = ["download", "-a", asin, "--aax-fallback", "--cover", "--cover-size", "1215", "-o", &w, "-y", "--ignore-podcasts", "-f", "asin_ascii", "--timeout", "0"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    run_tool(id, "Downloading", "audible.exe", &args, Parser::Percent, 0.0).await?;

    let (decrypt, input) = if let Some(aaxc) = find_ext(&work, "aaxc") {
        let voucher = find_ext(&work, "voucher").ok_or_else(|| fail("Voucher file missing".into()))?;
        let v: Value = serde_json::from_str(&fs::read_to_string(voucher).map_err(|e| fail(e.to_string()))?).map_err(|e| fail(e.to_string()))?;
        let lic = &v["content_license"]["license_response"];
        let (key, iv) = (lic["key"].as_str().unwrap_or_default(), lic["iv"].as_str().unwrap_or_default());
        if key.is_empty() || iv.is_empty() {
            return Err(fail("Voucher has no key".into()));
        }
        (vec!["-audible_key".to_string(), key.into(), "-audible_iv".into(), iv.into()], aaxc)
    } else if let Some(aax) = find_ext(&work, "aax") {
        (vec!["-activation_bytes".to_string(), activation_bytes().await?], aax)
    } else {
        return Err(fail("Nothing was downloaded".into()));
    };

    let dir = PathBuf::from(folder).join(safe(author));
    fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    let out = dir.join(format!("{}.m4b", safe(title))).display().to_string();
    let mut args = vec!["-y".to_string()];
    args.extend(decrypt);
    args.extend(["-i".into(), input.display().to_string()]);
    let cover = find_ext(&work, "jpg");
    if let Some(c) = &cover {
        args.extend(["-i".into(), c.display().to_string()]);
    }
    args.extend(["-map".into(), "0:a".into(), "-c:a".into(), "copy".into(), "-map_chapters".into(), "0".into()]);
    if cover.is_some() {
        args.extend(["-map", "1:v", "-c:v", "copy", "-disposition:v:0", "attached_pic"].map(String::from));
    }
    args.extend(["-progress", "pipe:1", "-nostats"].map(String::from));
    args.push(out.clone());
    run_tool(id, "Converting to M4B", "ffmpeg.exe", &args, Parser::Ffmpeg, duration).await?;
    fs::remove_dir_all(&work).ok();
    Ok(vec![out])
}
