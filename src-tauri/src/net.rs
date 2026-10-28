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
            return latest_from_pages(api).await;
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

/// GitHub's API allows 60 requests an hour per IP; the release pages don't count against it, so when the
/// API says no, read the latest tag and its date from the release page and the assets from its list.
async fn latest_from_pages(api: &str) -> Result<Option<Release>, String> {
    let limited = || "Update server rate limit reached, try again later".to_string();
    let repo = api.strip_prefix("https://api.github.com/repos/").and_then(|r| r.strip_suffix("/releases/latest")).ok_or_else(limited)?;
    let res = client().get(format!("https://github.com/{repo}/releases/latest")).send().await.map_err(err)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let res = res.error_for_status().map_err(|_| limited())?;
    // redirected to /<repo>/releases/tag/<tag>
    let Some(tag) = res.url().path().rsplit_once("/releases/tag/").map(|(_, t)| t.to_string()) else { return Ok(None) };
    let html = res.text().await.map_err(err)?;
    let date = html.split("datetime=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or_default().to_string();
    let list = client().get(format!("https://github.com/{repo}/releases/expanded_assets/{tag}")).send().await.map_err(err)?;
    let list = list.error_for_status().map_err(|_| limited())?.text().await.map_err(err)?;
    let prefix = format!("/{repo}/releases/download/{tag}/");
    let mut assets: Vec<(String, String)> = vec![];
    for href in list.split("href=\"").skip(1).filter_map(|s| s.split('"').next()) {
        // ponytail: names are taken as written in the link (no percent-decoding); fine for these release assets
        if let Some(name) = href.strip_prefix(&prefix) {
            if !assets.iter().any(|(n, _)| n == name) {
                assets.push((name.to_string(), format!("https://github.com{href}")));
            }
        }
    }
    if date.is_empty() || assets.is_empty() {
        return Err(limited()); // page layout changed: better no answer than a wrong one
    }
    Ok(Some(Release { tag, date, assets }))
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
