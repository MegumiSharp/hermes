//! Eagle local API client (SPEC 4.3).
//! addFromPath replies "success" with the item id BEFORE Eagle has copied the file (videos take
//! seconds). Deleting the source early loses the import, so `add` waits until item/info reports
//! the item with the source's exact byte size.
use crate::net::{client, err};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

const API: &str = "http://localhost:41595/api";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub annotation: String,
}

pub async fn online() -> bool {
    // Eagle answers slowly while it imports or indexes: be patient and retry once before saying "closed".
    for _ in 0..2 {
        let req = client().get(format!("{API}/application/info")).timeout(Duration::from_secs(4));
        if req.send().await.is_ok_and(|r| r.status().is_success()) {
            return true;
        }
    }
    false
}

/// Imports a file into Uncategorized (no folderId) and returns once Eagle holds a complete copy,
/// so the caller may delete the source. Item name = file name without extension.
pub async fn add(path: &Path, meta: &Meta) -> Result<(), String> {
    let size = std::fs::metadata(path).map_err(err)?.len();
    let name = path.file_stem().unwrap_or_default().to_string_lossy();
    let body = serde_json::json!({
        "path": path, "name": name, "website": meta.website, "tags": meta.tags, "annotation": meta.annotation,
    });
    let res: serde_json::Value = client()
        .post(format!("{API}/item/addFromPath"))
        .json(&body)
        .send()
        .await
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let Some(id) = res["data"].as_str().filter(|_| res["status"] == "success") else {
        return Err(format!("Eagle refused the file: {res}"));
    };
    // Generous: Eagle copies big 4K files at disk speed. ponytail: fixed 30 min cap, scale by size if it ever trips.
    for _ in 0..3600 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let Ok(r) = client().get(format!("{API}/item/info?id={id}")).send().await else { continue };
        let Ok(info) = r.json::<serde_json::Value>().await else { continue };
        if info["status"] == "success" && info["data"]["size"].as_u64() == Some(size) {
            return Ok(());
        }
    }
    Err("Eagle did not confirm the import; the file was kept".into())
}

#[tauri::command]
pub async fn eagle_status() -> bool {
    online().await
}
