mod update;

use serde_json::Value;
use std::{fs, path::PathBuf};

/// Everything Hermes writes lives next to the exe (portable).
fn data_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("exe path");
    let dir = exe.parent().expect("exe dir").join("hermes-data");
    fs::create_dir_all(&dir).ok();
    dir
}

#[tauri::command]
fn data_path() -> String {
    data_dir().display().to_string()
}

#[tauri::command]
fn load_settings() -> Value {
    fs::read_to_string(data_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Write to a temp file then rename, so a crash never leaves a half-written settings.json.
#[tauri::command]
fn save_settings(settings: Value) -> Result<(), String> {
    let path = data_dir().join("settings.json");
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    update::cleanup_old_exe();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            data_path,
            load_settings,
            save_settings,
            update::check_update,
            update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
