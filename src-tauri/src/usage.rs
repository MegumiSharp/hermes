//! Local usage statistics (Settings > Usage statistics): one JSON event per line in
//! hermes-data/usage.jsonl, never sent anywhere. The frontend decides what an event holds and
//! never puts file names, URLs or titles in it; export writes a file the owner can pass on.
use crate::{data_dir, now_ms};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::Mutex,
};

const MAX_BYTES: u64 = 4 * 1024 * 1024; // past this the oldest half is dropped

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    data_dir().join("usage.jsonl")
}

/// Appends one event (`{type, ...}`) with a timestamp.
#[tauri::command]
pub fn usage_log(mut event: Value) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(o) = event.as_object_mut() {
        o.insert("t".into(), json!(now_ms()));
    }
    let p = path();
    if fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let text = fs::read_to_string(&p).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        fs::write(&p, lines[lines.len() / 2..].join("\n") + "\n").map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&p).map_err(|e| e.to_string())?;
    writeln!(f, "{event}").map_err(|e| e.to_string())
}

/// Every event recorded so far (unreadable lines skipped).
#[tauri::command]
pub fn usage_read() -> Vec<Value> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    fs::read_to_string(path()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[tauri::command]
pub fn usage_clear() -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    fs::remove_file(path()).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e.to_string()) })
}

/// Writes the export the user saves (summary + events, built by the frontend) to `path`.
#[tauri::command]
pub fn usage_export(path: String, text: String) -> Result<(), String> {
    fs::write(path, text).map_err(|e| e.to_string())
}
