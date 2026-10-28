//! Official lyrics into an MP3: yt-dlp saves the video's own (uploader) subtitles next to the
//! audio as `<stem>.<lang>.srt`; this turns the best one into plain text and writes it as the ID3
//! lyrics frame (USLT) with FFmpeg. Missing subtitles are not an error: the song just has none.
use crate::binaries;
use std::{fs, os::windows::process::CommandExt, path::Path, process::Stdio};

/// Lyrics text from an SRT: no numbers, times, music notes or "[Music]" cues; repeats collapsed.
pub fn srt_text(srt: &str) -> String {
    let mut out: Vec<String> = vec![];
    for line in srt.lines().map(str::trim) {
        if line.is_empty() || line.chars().all(|c| c.is_ascii_digit()) || line.contains("-->") {
            continue;
        }
        let clean = line.replace(['♪', '♫', '♬'], "");
        let clean = clean.trim();
        // cue tags (<i>) and bracket-only cues: [Music], [♪♪♪], (applause)
        let clean: String = {
            let mut s = String::new();
            let mut tag = false;
            for c in clean.chars() {
                match c {
                    '<' => tag = true,
                    '>' => tag = false,
                    _ if !tag => s.push(c),
                    _ => {}
                }
            }
            s.trim().to_string()
        };
        let bracketed = (clean.starts_with('[') && clean.ends_with(']')) || (clean.starts_with('(') && clean.ends_with(')'));
        if clean.is_empty() || bracketed || out.last() == Some(&clean) {
            continue;
        }
        out.push(clean);
    }
    out.join("\n")
}

/// Embeds the subtitles saved next to `audio` (preferring `prefer` languages, then English) and deletes
/// them. Ok(Some(lang)) = embedded, Ok(None) = the video has no official subtitles.
pub fn embed(audio: &str, prefer: &[String]) -> Result<Option<String>, String> {
    let audio = Path::new(audio);
    let (Some(dir), Some(stem)) = (audio.parent(), audio.file_stem().and_then(|s| s.to_str())) else { return Ok(None) };
    let subs: Vec<(String, std::path::PathBuf)> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let lang = name.strip_prefix(stem)?.strip_prefix('.')?.strip_suffix(".srt")?.to_string();
            Some((lang, e.path()))
        })
        .collect();
    let rank = |lang: &str| {
        let base = lang.split(['-', '_']).next().unwrap_or(lang);
        prefer.iter().position(|p| p == lang || p == base).unwrap_or(if base == "en" { prefer.len() } else { prefer.len() + 1 })
    };
    let best = subs.iter().min_by_key(|(lang, _)| (rank(lang), lang.clone())).cloned();
    let result = match best {
        None => Ok(None),
        Some((lang, path)) => {
            let text = srt_text(&fs::read_to_string(&path).map_err(|e| e.to_string())?);
            if text.is_empty() {
                Ok(None)
            } else {
                write_lyrics(audio, &text).map(|_| Some(lang))
            }
        }
    };
    for (_, p) in &subs {
        fs::remove_file(p).ok();
    }
    result
}

fn write_lyrics(audio: &Path, text: &str) -> Result<(), String> {
    let tmp = audio.with_extension("lyrics.mp3");
    let ok = std::process::Command::new(binaries::bin_dir().join("ffmpeg.exe"))
        .args(["-v", "error", "-y", "-i"])
        .arg(audio)
        // copies the cover and every existing tag; only adds the lyrics (ID3 USLT)
        .args(["-map", "0", "-c", "copy", "-id3v2_version", "3", "-metadata"])
        .arg(format!("lyrics={text}"))
        .arg(&tmp)
        .stdin(Stdio::null())
        .creation_flags(binaries::NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?
        .success();
    if !ok {
        fs::remove_file(&tmp).ok();
        return Err("FFmpeg could not write the lyrics".into());
    }
    fs::rename(&tmp, audio).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_to_lyrics() {
        let srt = "1\n00:00:01,360 --> 00:00:03,040\n[♪♪♪]\n\n2\n00:00:18,640 --> 00:00:21,880\n♪ We're no strangers to love ♪\n\n3\n00:00:22,640 --> 00:00:26,960\n♪ You know the rules\nand so do I ♪\n\n4\n00:00:27,000 --> 00:00:28,000\n<i>and so do I</i>\n";
        assert_eq!(srt_text(srt), "We're no strangers to love\nYou know the rules\nand so do I");
    }
}
