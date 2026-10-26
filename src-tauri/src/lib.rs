mod binaries;
mod eagle;
mod net;
mod queue;
mod update;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

/// Everything Hermes writes lives next to the exe (portable).
pub fn data_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("exe path");
    let dir = exe.parent().expect("exe dir").join("hermes-data");
    fs::create_dir_all(&dir).ok();
    dir
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Write to a temp file then rename, so a crash never leaves a half-written file.
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

static SETTINGS: LazyLock<Mutex<Value>> =
    LazyLock::new(|| Mutex::new(read_json(&data_dir().join("settings.json")).unwrap_or_else(|| serde_json::json!({}))));

/// One settings.json value, as last saved by the frontend (Null when unset).
pub fn setting(key: &str) -> Value {
    SETTINGS.lock().unwrap()[key].clone()
}

#[tauri::command]
fn data_path() -> String {
    data_dir().display().to_string()
}

#[tauri::command]
fn load_settings() -> Value {
    SETTINGS.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(settings: Value) -> Result<(), String> {
    write_json(&data_dir().join("settings.json"), &settings)?;
    *SETTINGS.lock().unwrap() = settings;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    update::cleanup_old_exe();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            queue::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data_path,
            load_settings,
            save_settings,
            update::check_update,
            update::install_update,
            binaries::binaries_init,
            binaries::binaries_latest,
            binaries::binary_update,
            eagle::eagle_status,
            queue::queue_get,
            queue::queue_add,
            queue::queue_action,
            queue::queue_pause_all,
            queue::queue_clear_finished,
            queue::queue_resume_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                queue::shutdown();
            }
        });
}
