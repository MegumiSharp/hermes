//! HTTP helpers shared by the app updater and the binary manager.
use std::{collections::HashMap, fs, io::Write, path::Path, sync::LazyLock};

static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().user_agent("Hermes").build().expect("http client"));

pub fn client() -> &'static reqwest::Client {
    &CLIENT
}

pub fn err(e: impl ToString) -> String {
    e.to_string()
}

/// A release from a GitHub or Gitea/Forgejo (Codeberg) API; both share these fields.
pub struct Release {
    pub tag: String,
    pub date: String,
    pub assets: Vec<(String, String)>, // (name, download url)
}

/// url -> (etag, body). GitHub allows 60 unauthenticated calls/hour, but a "304 Not Modified"
/// answer to If-None-Match does not count, so repeated checks stay free.
type Cache = HashMap<String, (String, serde_json::Value)>;

fn cache_path() -> std::path::PathBuf {
    crate::data_dir().join("http-cache.json")
}

/// `releases/latest`, or None when the repo has no release.
pub async fn latest_release(api: &str) -> Result<Option<Release>, String> {
    let mut cache: Cache = crate::read_json(&cache_path()).unwrap_or_default();
    let mut req = client().get(api);
    if let Some((etag, _)) = cache.get(api) {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let res = req.send().await.map_err(err)?;
    let v = match res.status() {
        reqwest::StatusCode::NOT_FOUND => return Ok(None),
        reqwest::StatusCode::NOT_MODIFIED => cache[api].1.clone(),
        s if s == reqwest::StatusCode::FORBIDDEN || s == reqwest::StatusCode::TOO_MANY_REQUESTS => {
            return Err("Update server rate limit reached, try again later".into());
        }
        _ => {
            let res = res.error_for_status().map_err(err)?;
            let etag = res.headers().get(reqwest::header::ETAG).and_then(|e| e.to_str().ok()).map(String::from);
            let v: serde_json::Value = res.json().await.map_err(err)?;
            if let Some(etag) = etag {
                cache.insert(api.to_string(), (etag, v.clone()));
                crate::write_json(&cache_path(), &cache).ok();
            }
            v
        }
    };
    let s = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
    let assets = v["assets"].as_array().into_iter().flatten();
    Ok(Some(Release {
        tag: s(&v["tag_name"]),
        date: s(&v["published_at"]),
        assets: assets.map(|a| (s(&a["name"]), s(&a["browser_download_url"]))).collect(),
    }))
}

/// Streams `url` to `dest`, calling `progress(done, total)` per chunk. Fails on a short download.
pub async fn download(url: &str, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let mut res = client().get(url).send().await.map_err(err)?.error_for_status().map_err(err)?;
    let total = res.content_length().unwrap_or(0);
    let mut file = fs::File::create(dest).map_err(err)?;
    let mut done = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(err)? {
        file.write_all(&chunk).map_err(err)?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    if total != 0 && done != total {
        drop(file);
        fs::remove_file(dest).ok();
        return Err(format!("Download incomplete ({done} of {total} bytes)"));
    }
    Ok(())
}

/// True when the file starts with the PE "MZ" header.
pub fn is_exe(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 2];
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"MZ"
}
