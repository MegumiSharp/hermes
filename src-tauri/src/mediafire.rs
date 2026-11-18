//! MediaFire links found in the posts of a gallery download (gallery-dl has no MediaFire support).
//! gallery-dl writes each post's metadata (text, embeds, attachments) to a JSON-lines file; this step
//! finds mediafire.com links in it and downloads them into `<folder>\MediaFire`.
use crate::net::{client, err};
use std::path::Path;

/// mediafire.com links in any text (JSON-escaped HTML included), in order, without duplicates.
pub fn links(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for (i, _) in text.match_indices("mediafire.com/") {
        let start = text[..i].rfind(|c: char| c == '"' || c == '\'' || c == '>' || c == '(' || c.is_whitespace()).map_or(0, |p| p + 1);
        let end = i + text[i..].find(|c: char| matches!(c, '"' | '\'' | '<' | '\\' | ')' | ']') || c.is_whitespace()).unwrap_or(text.len() - i);
        let raw = text[start..end].trim_end_matches(['.', ',', ';', ':', '!']).replace("&amp;", "&");
        let url = if raw.starts_with("http") { raw } else { format!("https://{}", raw.trim_start_matches("//")) };
        let path = &url[url.find("mediafire.com/").unwrap() + 14..];
        // files, folders and the old "?<key>" short links; not the home page, help or app links
        let useful = ["file/", "file_premium/", "folder/", "view/", "download/", "?"].iter().any(|p| path.len() > p.len() + 2 && path.starts_with(p));
        if useful && !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

/// The direct download link on a MediaFire file page (the Download button's href, or its base64
/// `data-scrambled-url` on pages that hide it).
pub fn direct_link(html: &str) -> Option<String> {
    if let Some(i) = html.find("id=\"downloadButton\"") {
        let tag_start = html[..i].rfind("<a").unwrap_or(0);
        let tag_end = i + html[i..].find('>').unwrap_or(0);
        let tag = &html[tag_start..tag_end];
        let attr = |name: &str| tag.split(&format!("{name}=\"")).nth(1).and_then(|s| s.split('"').next()).map(str::to_string);
        if let Some(h) = attr("href").filter(|h| h.starts_with("http")) {
            return Some(h.replace("&amp;", "&"));
        }
        if let Some(s) = attr("data-scrambled-url").and_then(|s| base64(&s)) {
            return Some(s);
        }
    }
    // layout changed: the first link to a download server
    let i = html.find("https://download")?;
    let url = html[i..].split(['"', '\'', ' ', '<']).next()?;
    url.contains(".mediafire.com/").then(|| url.to_string())
}

fn base64(s: &str) -> Option<String> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut bits, mut n, mut out) = (0u32, 0, vec![]);
    for c in s.bytes().filter(|&c| c != b'=') {
        bits = bits << 6 | A.iter().position(|&a| a == c)? as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
        }
    }
    String::from_utf8(out).ok()
}

/// File page links inside a MediaFire folder (and its subfolders), from MediaFire's public API.
/// ponytail: first 100 items per folder (one API chunk); add chunk paging if packs ever get bigger.
async fn folder_files(key: &str, depth: u8) -> Result<Vec<String>, String> {
    let get = |t: &str| format!("https://www.mediafire.com/api/1.5/folder/get_content.php?folder_key={key}&content_type={t}&chunk=1&response_format=json");
    let files: serde_json::Value = client().get(get("files")).send().await.map_err(err)?.json().await.map_err(err)?;
    let mut out: Vec<String> = files["response"]["folder_content"]["files"].as_array().into_iter().flatten()
        .filter_map(|f| f["links"]["normal_download"].as_str().map(str::to_string)).collect();
    if depth < 5 {
        let folders: serde_json::Value = client().get(get("folders")).send().await.map_err(err)?.json().await.map_err(err)?;
        for f in folders["response"]["folder_content"]["folders"].as_array().into_iter().flatten() {
            if let Some(k) = f["folderkey"].as_str() {
                out.extend(Box::pin(folder_files(k, depth + 1)).await?);
            }
        }
    }
    Ok(out)
}

/// Downloads one MediaFire file page into `dir`; returns the saved path (an existing file of the same
/// name is kept, not downloaded again).
async fn file(page: &str, dir: &Path, progress: &mut impl FnMut(u64, u64)) -> Result<String, String> {
    let html = client().get(page).header("User-Agent", "Mozilla/5.0").send().await.map_err(err)?.text().await.map_err(err)?;
    let url = direct_link(&html).ok_or("no download button (file removed or private?)")?;
    let name = crate::urlencoding_decode(url.rsplit('/').next().unwrap_or("download").split('?').next().unwrap_or("download"));
    let name: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    let dest = dir.join(&name);
    if dest.metadata().is_ok_and(|m| m.len() > 0) {
        return Ok(dest.to_string_lossy().into_owned());
    }
    let part = dir.join(format!("{name}.part"));
    crate::net::download(&url, &part, |d, t| progress(d, t)).await?;
    std::fs::rename(&part, &dest).map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Queue step: every MediaFire link in `posts` (gallery-dl's post metadata) into `<folder>\MediaFire`.
/// `say(progress, text)` reports; returns (saved files, failures as "link: reason").
pub async fn download_all(posts: &str, folder: &str, mut say: impl FnMut(f64, String)) -> (Vec<String>, Vec<String>) {
    let text = std::fs::read_to_string(posts).unwrap_or_default();
    let mut pages = vec![];
    let mut failed = vec![];
    for link in links(&text) {
        match link.split("/folder/").nth(1).map(|k| k.split(['/', '?', '#']).next().unwrap_or("").to_string()) {
            Some(key) => match folder_files(&key, 0).await {
                Ok(files) => pages.extend(files),
                Err(e) => failed.push(format!("{link}: {e}")),
            },
            None => pages.push(link),
        }
    }
    pages.dedup();
    let dir = Path::new(folder).join("MediaFire");
    if !pages.is_empty() {
        std::fs::create_dir_all(&dir).ok();
    }
    let mut saved = vec![];
    let n = pages.len();
    for (i, page) in pages.iter().enumerate() {
        let mut report = |d: u64, t: u64| {
            let part = if t > 0 { d as f64 / t as f64 } else { 0.0 };
            say((i as f64 + part) / n as f64, format!("MediaFire {} of {n} · {:.0} MB", i + 1, d as f64 / 1e6));
        };
        report(0, 0);
        match file(page, &dir, &mut report).await {
            Ok(p) => saved.push(p),
            Err(e) => failed.push(format!("{page}: {e}")),
        }
    }
    (saved, failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_links() {
        let post = r#"{"content": "<p>Pack: <a href=\"https://www.mediafire.com/file/abc123/pack.rar/file\">here</a> and mediafire.com/folder/xyz789 or http://www.mediafire.com/?k3y4b, again https://www.mediafire.com/file/abc123/pack.rar/file</p>", "x": "https://www.mediafire.com/ home"}"#;
        assert_eq!(links(post), vec![
            "https://www.mediafire.com/file/abc123/pack.rar/file",
            "https://mediafire.com/folder/xyz789",
            "http://www.mediafire.com/?k3y4b",
        ]);
    }

    #[test]
    fn reads_button() {
        let plain = r#"<a class="input popsok" aria-label="Download file" href="https://download1593.mediafire.com/abc/k/x.rar"   id="downloadButton" rel="nofollow">"#;
        assert_eq!(direct_link(plain).unwrap(), "https://download1593.mediafire.com/abc/k/x.rar");
        let scrambled = r#"<a href="javascript:void(0)" data-scrambled-url="aHR0cHM6Ly9kb3dubG9hZDEubWVkaWFmaXJlLmNvbS9hL2IucmFy" id="downloadButton">"#;
        assert_eq!(direct_link(scrambled).unwrap(), "https://download1.mediafire.com/a/b.rar");
    }

    /// Live: a public file and a public folder. cargo test --release mediafire_live -- --ignored
    #[tokio::test]
    #[ignore]
    async fn mediafire_live() {
        let dir = std::env::temp_dir().join("hermes-mediafire-test");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let posts = dir.join("posts.jsonl");
        std::fs::write(&posts, r#"{"content": "https://www.mediafire.com/file/k60ooi301s4vkfo/subdomains.txt/file"}"#).unwrap();
        let (saved, failed) = download_all(&posts.to_string_lossy(), &dir.to_string_lossy(), |_, _| {}).await;
        assert!(failed.is_empty(), "{failed:?}");
        assert!(saved[0].ends_with("subdomains.txt") && std::fs::metadata(&saved[0]).unwrap().len() == 564, "{saved:?}");
        assert!(!folder_files("dx6kfaasyo24l", 0).await.unwrap().is_empty());
    }
}
