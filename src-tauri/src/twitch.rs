//! twitch-dlp (Twitch VODs, lives from the start, clips, hidden VODs, unmuting) as an optional component.
//! It is a Node.js script, so it comes with a portable node.exe: both live in bin/twitch/, with a
//! package.json that marks the script as an ES module and holds its version.
use crate::binaries::bin_dir;
use crate::net::{self, client, err};
use crate::data_dir;
use serde::Serialize;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Emitter};

const API: &str = "https://api.github.com/repos/DmitryScaletta/twitch-dlp/releases/latest";

pub fn dir() -> PathBuf {
    bin_dir().join("twitch")
}
fn version() -> String {
    let pkg: serde_json::Value = fs::read_to_string(dir().join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    pkg["version"].as_str().unwrap_or_default().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchStatus {
    installed: bool,
    version: String,
    node: String, // full path of node.exe (the queue runs it)
    script: String,
}

#[tauri::command]
pub fn twitch_status() -> TwitchStatus {
    let (node, script) = (dir().join("node.exe"), dir().join("twitch-dlp.js"));
    TwitchStatus {
        installed: node.exists() && script.exists(),
        version: version(),
        node: node.to_string_lossy().into(),
        script: script.to_string_lossy().into(),
    }
}

/// Newest twitch-dlp release tag (without "v").
#[tauri::command]
pub async fn twitch_latest() -> Result<String, String> {
    let rel = net::latest_release(API).await?.ok_or("no release")?;
    Ok(rel.tag.trim_start_matches('v').to_string())
}

/// Installs node.exe (current LTS, only if missing) and the latest twitch-dlp.js.
/// Emits "twitch-progress" [stage, done, total].
#[tauri::command]
pub async fn twitch_install(app: AppHandle) -> Result<TwitchStatus, String> {
    let d = dir();
    fs::create_dir_all(&d).map_err(err)?;
    let tmp = data_dir().join("temp").join("twitch");
    fs::remove_dir_all(&tmp).ok();
    fs::create_dir_all(&tmp).map_err(err)?;
    if !d.join("node.exe").exists() {
        let index: serde_json::Value = client().get("https://nodejs.org/dist/index.json").send().await.map_err(err)?.json().await.map_err(err)?;
        let v = index.as_array().into_iter().flatten()
            .find(|r| !r["lts"].is_boolean() && r["files"].as_array().is_some_and(|f| f.iter().any(|x| x == "win-x64-zip")))
            .and_then(|r| r["version"].as_str()).ok_or("no Node.js LTS for Windows")?.to_string();
        let zip = tmp.join("node.zip");
        net::download(&format!("https://nodejs.org/dist/{v}/node-{v}-win-x64.zip"), &zip, |done, total| {
            app.emit("twitch-progress", ("Node.js", done, total)).ok();
        })
        .await?;
        app.emit("twitch-progress", ("Unpacking Node.js", 0, 0)).ok();
        // only node.exe is needed (no npm): tar can extract one member of a zip
        let member = format!("node-{v}-win-x64/node.exe");
        let ok = crate::binaries::tar().arg("-xf").arg(&zip).arg("-C").arg(&tmp).arg(&member).status().map_err(err)?.success();
        let exe = tmp.join(&member);
        if !ok || !net::is_exe(&exe) {
            return Err("Could not unpack Node.js".into());
        }
        fs::rename(&exe, d.join("node.exe")).or_else(|_| fs::copy(&exe, d.join("node.exe")).map(|_| ())).map_err(err)?;
    }
    let rel = net::latest_release(API).await?.ok_or("no twitch-dlp release")?;
    let url = rel.assets.iter().find(|(n, _)| n == "twitch-dlp.js").map(|(_, u)| u.clone()).ok_or("no twitch-dlp.js in the release")?;
    let js = tmp.join("twitch-dlp.js");
    net::download(&url, &js, |done, total| {
        app.emit("twitch-progress", ("twitch-dlp", done, total)).ok();
    })
    .await?;
    if fs::metadata(&js).map(|m| m.len()).unwrap_or(0) < 1000 {
        return Err("twitch-dlp download is empty".into());
    }
    fs::copy(&js, d.join("twitch-dlp.js")).map_err(err)?;
    let version = rel.tag.trim_start_matches('v');
    fs::write(d.join("package.json"), format!(r#"{{"type": "module", "version": "{version}"}}"#)).map_err(err)?;
    fs::remove_dir_all(&tmp).ok();
    Ok(twitch_status())
}

#[tauri::command]
pub fn twitch_remove() -> Result<(), String> {
    fs::remove_dir_all(dir()).map_err(err)
}

// ---- metadata (public GraphQL, works for subscriber-only VODs too) ----
// Twitch's own web Client-Id, used unauthenticated. The VideoMetadata/StreamMetadata queries are public,
// so Hermes reads title, length and thumbnail even when the video is subscriber-only (the stream itself is
// then fetched from the public CDN by twitch-dlp, the way the TwitchNoSub extension does).
const CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const Q_VIDEO: &str = "b3da056388e7d942c097815e6547094119d4c78400af72ca4ee045ba8b422690";
const Q_STREAM: &str = "8f3c9ee3a77ff7e648268ac5daad6b36f2add690c628ec819e2e26aebc5cb767";
const Q_TOKEN: &str = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
// CDN hosts that serve VOD segments; the same list twitch-dlp probes.
const VOD_DOMAINS: &[&str] = &[
    "ds0h3roq6wcgc", "d2nvs31859zcd8", "d2aba1wr3818hz", "d3c27h4odz752x", "dgeft87wbj63p", "d1m7jfoe9zdc1j",
    "d3vd9lfkzbru3h", "ddacn6pr5v0tl", "d3aqoihi2n8ty8", "d3fi1amfgojobc", "d2vi6trrdongqn", "d3stzm2eumvgb4",
];

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TwitchMeta {
    kind: String, // "vod" | "channel" | "clip" | ""
    id: String,
    title: String,
    channel: String,
    thumb: String,
    duration: f64,
    live: bool,
    offline: bool,
    sub_only: bool,     // the normal stream is gated, but the CDN copy is downloadable (TwitchNoSub)
    downloadable: bool, // a direct CDN playlist was found (VOD/sub-only)
}

async fn gql(query: &str, vars: serde_json::Value) -> Result<serde_json::Value, String> {
    let body = serde_json::json!([{ "operationName": "", "variables": vars, "extensions": { "persistedQuery": { "version": 1, "sha256Hash": query } } }]);
    let res = client().post("https://gql.twitch.tv/gql").header("Client-Id", CLIENT_ID).json(&body).send().await.map_err(err)?;
    let mut arr: serde_json::Value = res.error_for_status().map_err(err)?.json().await.map_err(err)?;
    Ok(arr.get_mut(0).map(serde_json::Value::take).unwrap_or_default())
}

/// `cf_vods/<subdomain>/<fullVodPath>/thumb/...` → the storage path used to build the CDN playlist URL.
fn vod_path_from_thumb(thumb: &str) -> Option<String> {
    let after = thumb.split("cf_vods/").nth(1)?;
    let rest = after.split_once('/').map(|(_, r)| r)?; // drop the subdomain
    let path = rest.split("/thumb/").next()?.trim_end_matches('/');
    (!path.is_empty()).then(|| path.to_string())
}

/// First CDN host that serves this VOD's chunked playlist (the download works without a token/subscription).
async fn find_vod_domain(vod_path: &str) -> Option<String> {
    for d in VOD_DOMAINS {
        let url = format!("https://{d}.cloudfront.net/{vod_path}/chunked/index-dvr.m3u8");
        if client().head(&url).send().await.is_ok_and(|r| r.status().is_success()) {
            return Some(url);
        }
    }
    None
}

/// Title, channel, length and thumbnail for a Twitch link, from the public GraphQL API — so a
/// subscriber-only VOD still reads (yt-dlp can't open those). For a VOD it also reports whether the
/// normal stream is gated (`subOnly`) and whether a direct CDN copy exists (`downloadable`).
#[tauri::command]
pub async fn twitch_meta(url: String) -> Result<TwitchMeta, String> {
    if let Some(id) = vod_id(&url) {
        let v = gql(Q_VIDEO, serde_json::json!({ "channelLogin": "", "videoID": id })).await?["data"]["video"].take();
        if v.is_null() {
            return Err("video not found (removed or never existed)".into());
        }
        let get = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let thumb = get("previewThumbnailURL");
        let mut m = TwitchMeta {
            kind: "vod".into(), id: id.to_string(), title: get("title"),
            channel: v["owner"]["displayName"].as_str().unwrap_or_default().to_string(),
            thumb: thumb.clone(), duration: v["lengthSeconds"].as_f64().unwrap_or(0.0), ..Default::default()
        };
        // can the normal (token) stream be opened? if not, it's subscriber-only / otherwise gated
        if token_stream_ok(id).await {
            m.downloadable = true;
        } else {
            m.sub_only = true; // gated: confirm the public CDN copy exists (the download path twitch-dlp uses)
            m.downloadable = match vod_path_from_thumb(&thumb) {
                Some(path) => find_vod_domain(&path).await.is_some(),
                None => false,
            };
        }
        return Ok(m);
    }
    if let Some(slug) = clip_slug(&url) {
        return Ok(TwitchMeta { kind: "clip".into(), id: slug.to_string(), channel: channel_login(&url).unwrap_or_default(), downloadable: true, ..Default::default() });
    }
    if url.contains("twitchtracker.com") || url.contains("streamscharts.com") || url.contains("sullygnome.com") {
        return Ok(TwitchMeta { kind: "tracker".into(), downloadable: true, ..Default::default() });
    }
    if let Some(login) = channel_login(&url) {
        let u = gql(Q_STREAM, serde_json::json!({ "channelLogin": login })).await?["data"]["user"].take();
        let live = !u["stream"].is_null();
        return Ok(TwitchMeta {
            kind: "channel".into(), channel: u["displayName"].as_str().unwrap_or(&login).to_string(),
            live, offline: !live, downloadable: live, ..Default::default()
        });
    }
    Err("not a Twitch link".into())
}

/// True when the normal signed VOD manifest opens (not subscriber-only / not gated).
async fn token_stream_ok(id: &str) -> bool {
    let token = gql(Q_TOKEN, serde_json::json!({ "isLive": false, "login": "", "isVod": true, "vodID": id, "playerType": "site", "platform": "web" })).await;
    let Ok(token) = token else { return false };
    let t = &token["data"]["videoPlaybackAccessToken"];
    let (Some(value), Some(sig)) = (t["value"].as_str(), t["signature"].as_str()) else { return false };
    let url = format!("https://usher.ttvnw.net/vod/{id}.m3u8?allow_source=true&allow_audio_only=true&player=twitchweb&sig={sig}&token={}", urlencoding(value));
    client().get(&url).send().await.is_ok_and(|r| r.status().is_success())
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

fn vod_id(url: &str) -> Option<&str> {
    let s = url.split("twitch.tv/videos/").nth(1)?;
    let id = s.split(['/', '?', '#']).next()?;
    id.chars().all(|c| c.is_ascii_digit()).then_some(id).filter(|i| !i.is_empty())
}
fn clip_slug(url: &str) -> Option<&str> {
    let s = url.split("/clip/").nth(1).or_else(|| url.split("clips.twitch.tv/").nth(1))?;
    let slug = s.split(['/', '?', '#']).next()?;
    (!slug.is_empty()).then_some(slug)
}
fn channel_login(url: &str) -> Option<String> {
    let s = url.split("twitch.tv/").nth(1)?;
    let name = s.split(['/', '?', '#']).next()?;
    (!name.is_empty() && name != "videos").then(|| name.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links() {
        assert_eq!(vod_id("https://www.twitch.tv/videos/2931596568"), Some("2931596568"));
        assert_eq!(vod_id("https://www.twitch.tv/zackrawrr"), None);
        assert_eq!(clip_slug("https://www.twitch.tv/x/clip/Funny-abc_1"), Some("Funny-abc_1"));
        assert_eq!(channel_login("https://www.twitch.tv/ZackRawrr").as_deref(), Some("zackrawrr"));
        assert_eq!(channel_login("https://www.twitch.tv/videos/1"), None);
    }

    #[test]
    fn thumb_to_path() {
        let t = "https://static-cdn.jtvnw.net/cf_vods/d2nvs31859zcd8/63d2587bd1cf93acb316_zackrawrr_318646622808_1794941140//thumb/thumb0-90x60.jpg";
        assert_eq!(vod_path_from_thumb(t).as_deref(), Some("63d2587bd1cf93acb316_zackrawrr_318646622808_1794941140"));
        assert_eq!(vod_path_from_thumb("no thumb here"), None);
    }

    /// Live: a public VOD reads and is downloadable. cargo test --release twitch_meta_live -- --ignored
    #[tokio::test]
    #[ignore]
    async fn twitch_meta_live() {
        let m = twitch_meta("https://www.twitch.tv/videos/2931596568".into()).await.unwrap();
        assert_eq!(m.kind, "vod");
        assert!(!m.title.is_empty() && m.duration > 0.0 && m.downloadable, "{m:?}");
    }
}
