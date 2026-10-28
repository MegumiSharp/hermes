# Hermes — Specification

Portable Windows toolbox for a content creator. One exe, no installer, dark minimal UI.
Status: all tranches T0–T7 implemented. Manual checklist: `docs/TEST-TODO.md`.

---

## 1. Product decisions

| Topic | Decision |
|---|---|
| Name / mark | **Hermes**, feather icon (line SVG) |
| Platform | Windows 10/11 x64 only |
| Distribution | Single portable `Hermes.exe`, no installer, no registry writes. Size is not a concern |
| Signing | None (personal use, SmartScreen warning accepted) |
| UI language | English |
| Design | **01 Graphite / Amber** from `design/mockups.html` |
| Repo | Public GitHub repo, owner account `MegumiSharp` |
| Owner hardware | NVIDIA RTX 3060 Ti; editing in Adobe Premiere |

## 2. Modules (left sidebar)

| Module | Purpose | Engine |
|---|---|---|
| Video Downloader | Video/audio from YouTube and other sites | yt-dlp + ffmpeg |
| Gallery Downloader | Image/video galleries (Instagram, X, Pixiv, Reddit…) | gallery-dl |
| Background Removal | Cut out subjects from images | rembg models (BiRefNet / ISNet) via ONNX Runtime + DirectML |
| Upscale | Upscale images and videos | Real-ESRGAN (ncnn-vulkan) + ffmpeg |
| Binaries | Versions and updates of all bundled tools | — |
| Settings | Global settings | — |

Rule: each module is self-contained. Adding one never edits another, only the module registry.

## 3. Architecture

- **Tauri 2**: Rust backend, HTML/CSS/TypeScript frontend (no UI framework unless needed).
- External tools run as hidden child processes (no console window ever shown). Output parsed for progress.
- Shared services, used by all modules: **Queue**, **Binary manager**, **Eagle client**, **Cookies**, **Settings**, **Notifications** (banners + modals), **App updater**.

### Portable layout (next to the exe)
```
Hermes.exe
hermes-data/
  settings.json
  queue.json            # persisted queue
  cookies/              # user-provided cookies.txt files (never committed)
  bin/                  # yt-dlp.exe, gallery-dl.exe, ffmpeg.exe, ffprobe.exe, realesrgan-ncnn-vulkan.exe
  models/               # rembg ONNX models, Real-ESRGAN models
  temp/                 # video upscale frames, conversion scratch
  logs/
```

## 4. Shared services

### 4.1 Binary manager
- yt-dlp, gallery-dl, ffmpeg/ffprobe, realesrgan-ncnn-vulkan (+ its models) are **embedded in Hermes.exe**
  and extracted to `hermes-data/bin/` on first run or when missing/broken.
- Startup check: each binary runs with `--version`. Failure → re-extract; still failing → banner with Repair.
- **Updates happen in the app UI, never in a console**: Binaries page lists each tool with installed vs latest
  version (GitHub Releases API) and an Update button with a progress bar. Hermes downloads the official
  release asset itself and swaps the file.
  - yt-dlp: `yt-dlp/yt-dlp` → `yt-dlp.exe`. Option "Update yt-dlp automatically on launch" (default ON).
  - gallery-dl: Codeberg `mikf/gallery-dl` (moved off GitHub in 2026) → `gallery-dl.exe`.
  - ffmpeg: `BtbN/FFmpeg-Builds` → `ffmpeg-master-latest-win64-gpl.zip` (includes NVENC).
  - Real-ESRGAN: `xinntao/Real-ESRGAN` ncnn-vulkan build (unmaintained since 2022, stable; update check still shown).
- Large AI models are **downloaded in-app** only after explicit user confirmation (modal with names and total
  size, then progress), because embedding ~1 GB models in the exe is impractical (build memory, PE size).
  A module whose model is missing shows a notice with a "Download models" action instead of failing.

### 4.2 Queue
- One queue engine; each module submits jobs. Persisted to `queue.json`, restored on launch,
  unfinished downloads resume (`--continue`).
- Adding is never blocked: you can always enqueue; jobs start when a slot is free.
- Header: overall bar, percentage, **done / total**.
- Item: title, type pill, bar, %, speed, ETA, state.
  States: Queued, Waiting (cooldown), Downloading, Converting, Processing, Importing to Eagle, Done, Failed, Waiting for Eagle.
- Groups: a playlist/gallery is one expandable item with its own done/total.
- Actions: pause/resume all, per item pause/cancel/retry/remove, clear finished, open folder.
- Concurrency: 3 downloads (setting 1–5), `-N 4` fragments each; 2 NVENC encodes; 1 GPU AI job at a time.
- **Cooldown with countdown**: between playlist items and after a rate-limit signal (HTTP 429,
  "confirm you're not a bot"), the queue enters Waiting with a visible countdown.
  The resume time is stored as an **absolute Windows clock timestamp** in `queue.json`, so it survives
  closing the app. Default spacing 2–5 s per item; on rate-limit 5 min, doubling up to 60 min.

### 4.3 Eagle client
- API `http://localhost:41595`. Health check `GET /api/application/info`.
- "Send to Eagle" checkbox per module (remembered, default ON in every module).
- Checkbox ON and Eagle not running → warning banner when adding and item state "Waiting for Eagle"
  with Retry / Keep in folder. Auto-retry when Eagle comes back.
- Import `POST /api/item/addFromPath`, no folderId → **Uncategorized**.
- Metadata: `website` = source URL, tags = channel/author name + source URL; `annotation` = title.
- After successful import the file is **deleted from the output folder** (Eagle keeps its copy).
  "Successful" = Eagle's item/info reports the item with the source's exact size; addFromPath alone
  replies before the copy is done. Without confirmation the file is kept and the item fails.

### 4.4 Cookies
- Per site (YouTube first, then gallery-dl sites). Mode: Auto / Firefox / Chrome / Edge / Brave / File / None.
- Auto: detect installed browsers, try `--cookies-from-browser` (Firefox first).
- **Fallback modal** when browser extraction fails:
  1. Explains why (Chromium on Windows encrypts cookies; browser must be closed).
  2. Step-by-step: install the open-source extension "Get cookies.txt LOCALLY", open the site logged in, export.
  3. Drop zone: drag the `cookies.txt` into the modal.
  4. Validation: Netscape format, correct domain (e.g. `.youtube.com`), login cookies present
     (YouTube: `SAPISID` / `__Secure-3PSID` / `LOGIN_INFO`), not expired; shows result and expiry date.
  5. Saved to `hermes-data/cookies/<site>.txt`, used via `--cookies`.
- Cookie files are sensitive: stored only locally, excluded from git.

### 4.5 Notifications
- **Banners** (top of content): app update, binary update, Eagle offline, cookie failure.
- **Modals**: cookies fallback, model download, confirmations.

### 4.6 App self-update
- GitHub Actions builds `Hermes.exe` on tag `v*` and attaches it to a Release.
- Check on launch and every 6 h (`/repos/MegumiSharp/<repo>/releases/latest`), semver compare.
- Banner "Hermes X.Y.Z is available" [Later] [Update] → download with progress, rename running exe
  to `Hermes.exe.old`, place new exe, relaunch, delete `.old` on next start. `hermes-data/` untouched.

## 5. Video Downloader (yt-dlp)

- URL + Fetch (paste auto-fetches). Metadata `yt-dlp -J` (`--flat-playlist` for playlists).
- Preview card: thumbnail, title, channel, duration, date, views, best resolution/codec, size estimate.

| Format option | Behavior |
|---|---|
| Best quality (default) | `bv*+ba/b`, native container (WebM/MKV for 4K VP9/AV1) |
| 1080p | `bv*[height<=1080]+ba/b[height<=1080]`, prefer H.264/MP4 |
| MP4 `CONVERTED` pill | best quality, then ffmpeg `h264_nvenc` (high quality preset) + AAC → `.mp4` (Premiere-safe). Remux only if already H.264+AAC |
| Audio only — MP3 | `-x --audio-format mp3 --audio-quality 0`, 320k, `--embed-thumbnail --embed-metadata` |

- Playlists: whole playlist as one expandable queue group.
- Subtitles: out of scope.

## 6. Gallery Downloader (gallery-dl)

- URL + Fetch → `gallery-dl -j` (simulate) lists items with metadata → **preview grid** with thumbnails.
- **Filter panel** (built into the module, applied live to the grid and passed to gallery-dl):
  - Media type: images / videos / GIFs
  - Extensions (jpg, png, webp, mp4…)
  - Minimum resolution (width/height, where the site provides it)
  - File size range (`--filesize-min/max`)
  - Date range (post date)
  - Item range (e.g. first 50, `--range`)
  - Skip already downloaded (archive file `hermes-data/gallery-archive.sqlite3`)
- Manual selection: checkbox per item in the grid, select all/none.
- Filters compile to `--filter` expressions plus native flags; the grid shows what will be downloaded.
- Cookies via shared Cookies service (many sites require login).
- A gallery is one queue item (one gallery-dl run) showing "files done / total"; Eagle import with author + source URL tags.
- Implementation: filters and manual picks are resolved in the preview, then passed to gallery-dl as an
  `image-filter` on `filename.extension` in a per-job config file. Files with identical names inside one URL are
  picked/skipped together.

## 7. Background Removal (rembg models)

- Engine: rembg's ONNX models run natively through ONNX Runtime with the **DirectML** provider
  (GPU, no Python, no CUDA install). Same quality as rembg.
- Models (selector): **BiRefNet General** (default, best edges/hair), BiRefNet General Lite, BiRefNet Portrait,
  BiRefNet Massive, ISNet General (fast), ISNet Anime, U2Net (legacy baseline).
- **Model manager**: list of every model with size, speed class, best use case and installed state.
  Nothing downloads silently: the user ticks the models, sees total size, confirms in a modal,
  then sees per-model progress. Models come from rembg's GitHub releases into `hermes-data/models/`.
  Installed models can be deleted to free space.
- **Compare mode**: pick one image + several installed models → results side by side in a grid,
  each with inference time; click one to open it in the before/after slider and keep it
  (only the kept result goes to Eagle). Helps choose the right model per situation.
- Input: drag & drop images or folder, or paste. Batch through the queue.
- Output: PNG with alpha. Options: background color/transparent, crop to subject. (Alpha matting refine: not
  implemented; BiRefNet edges rarely need it.)
- With Eagle on, results are kept in `hermes-data/results` (cleaned after 7 days) so the slider still works after import.
- **Before/after slider** on each result (drag handle) when processing finishes.
- Always sends to Eagle (checkbox default ON, same Eagle rules).

## 8. Upscale (Real-ESRGAN)

- Engine: `realesrgan-ncnn-vulkan` (Vulkan GPU).
- Models: realesrgan-x4plus (photo), x4plus-anime, animevideov3 (video). Scale 2x / 3x / 4x.
- Images: direct, batch through queue, before/after slider, Eagle.
- Video: ffmpeg extracts frames → upscale → reassemble with NVENC + original audio → temp frames deleted.
  Frames are JPEG (q2) to limit disk use; the whole clip is extracted at once (no chunking yet).
  Limitation: slow (minutes per minute of 1080p video) and disk-heavy (a few GB per minute).

## 8b. Persistence and visibility (T8)

- Every field, choice and pending file list of every tool is saved in `settings.json` as it changes
  (typing is debounced, flushed on close). Reopening Hermes restores them; URLs re-fetch their preview.
- Window size, position and maximized state are restored (settings.json, portable).
- Settings → Tools: hide tools you don't use (at least one stays visible); hidden tools keep their data.

## 10. Audible (T9)

- audible-cli (bundled) with config in `hermes-data/audible`. Sign-in: marketplace → Amazon page opens in the
  user's browser → user pastes the final "Page not found" address → device registered. Password never seen.
- Library list (cover, title, author, narrator, length, series) with search and multi-select, cached locally.
- Download: `audible download --aax-fallback --cover` → ffmpeg decrypt (AAXC key/iv from voucher, AAX
  activation bytes) → `<folder>\<Author>\<Title>.m4b` with chapters and cover; temp files removed.
- Note: removing DRM may breach Audible's terms and EU/Italian law; personal backups only.

## 11. AI runtime (T10/T11)

- Portable CPython 3.12 + PyTorch 2.5.1 CUDA 12.4 in `hermes-data/python`, installed only after a
  confirmation listing components and sizes; shared by Demucs and faster-whisper. Model caches in
  `hermes-data/models` (TORCH_HOME / HF_HOME). Each model download is confirmed on first use.

## 12. Stem Separation (Demucs)

- Models: htdemucs (standard), htdemucs_ft (best, 4× slower), htdemucs_6s (+ guitar, piano).
- All stems or vocals + instrumental; WAV, FLAC or MP3 320. Output `<folder>\Stems\<model>\<track> - <stem>`.

## 13. Subtitles (faster-whisper)

- Models large-v3-turbo (default), large-v3, medium, small, base. Language auto or chosen; transcribe or
  translate to English; SRT / VTT / TXT. GPU float16 with CPU int8 fallback.

## 14. Thumbnail Tester (T14)

- Feed of real videos from `yt-dlp ytsearch30:<topic>` (random topic on first open, dice = new topic); other channels' avatars
  fetched one by one from their channel pages and remembered. Upload dates are not in search results: a stable fake age per video.
- Your thumbnails (drop/browse/paste, several = A/B variants with show/hide), title (100 max, warning over 60), duration,
  views, upload age, search description; channel link → name, avatar, subscribers.
- Devices: desktop home grid, search results, up-next sidebar, mobile phone frame; dark/light; checks B/W, squint (blur),
  watched bars, outline yours; shuffle/reset positions. Size view: 640/360/246/168/120 px; warns under 1280×720 or not 16:9.
- Everything (thumbnails, fields, feed, view) survives a restart.

## 15. Activity dots and performance (T14)

- Sidebar dot per tool: pulsing amber while it has running/queued jobs or background tasks, green when finished and red when
  failed until that tool is opened.
- Background Removal performance: Fast (GPU ladder) or Gentle (CPU, 2 threads, PC stays usable). Startup tool verification is
  cached by size+mtime (`bin/verified.json`); job console logs are fetched on demand (`queue_log`), not in queue snapshots;
  tray/compare previews use cached 320 px JPEGs (`hermes-data/thumbs`, 7 days); tray redraws only progress on ticks.
- Binaries → AI models: rembg model files vs the release's asset sizes, Whisper models vs the Hugging Face sha (Update re-downloads);
  Python packages vs PyPI, informational (pinned).

## 16. Spotify sources and quality (T15)

- spotDL matches songs on YouTube by title and length and can pick fan uploads (osu! beatmaps, covers, nightcore).
  Hermes checks every pick (length ±4 s, no altered-version words missing from the Spotify title, uploaded by the artist,
  "<artist> - Topic" or a YouTube Music artist field) and replaces rejected ones with the first trusted track of the YouTube
  Music "Songs" search; none found = "No reliable source", skipped unless the user picks "Use anyway". Each row links its source.
- Formats: Opus or M4A original (default Opus, the best audio YouTube has), MP3 320. Lossless FLAC via SpotiFLAC was evaluated
  and dropped (Oct 2026: Qobuz/Deezer/Amazon servers down, Tidal crashes on Windows pipes); revisit if it is fixed upstream.
- Reading a link shows live feedback (stage, n / total, elapsed, Details with the tool output). The download bar weights each
  song by stage so parallel songs move it before any finishes.

## 17. Video Downloader audio (T16)

- Audio only: MP3 320 kbps with tags, optional square cover (thumbnail cropped like an album cover) and optional official
  lyrics: subtitles uploaded by the channel (never automatic captions) in the video's language, else English, written as
  ID3 lyrics (USLT) as plain lines. Videos without them just have no lyrics (job note says so).
- "WAV for editing": PCM 16-bit 48 kHz for Premiere, pill "WAV · Montaggio" (owner's wording); WAV can't hold cover/lyrics.

## 18. Usage statistics (T19)

- Local only (`hermes-data/usage.jsonl`), on by default, Settings switch to stop. Records launches + startup time, tool opens,
  every finished job (tool, step tools, format pill, duration, result, error with paths/URLs/quoted names removed) and every
  visible wait (kind, duration, result). Never file names, links, titles or typed text.
- Settings > Usage statistics: count since date, Export… (save dialog: system snapshot, summary per tool and wait with
  median/p90 and top errors, raw events) and Clear.

## 19. Image Converter (T20a)

- In: PNG, JPG, WebP, AVIF, HEIC, BMP, TIFF, GIF, ICO. Out: PNG, JPG, WebP (high = lossless), AVIF, TIFF, BMP, GIF, ICO
  (256 × 256, transparent padding) or SVG (traced with vtracer, colour or black and white, three detail levels).
- Size: keep or cap the long side (3840 … 256), never enlarging. Formats without alpha get a white background.
  Same format as the source saves as "<name> (converted)". Optional copy to Eagle. Nothing to download.

## 20. Document Converter (T20b)

- Text formats (Markdown, HTML, LaTeX, EPUB, TXT) between each other and to DOCX/ODT/RTF with Pandoc; to PDF with Pandoc +
  Tectonic (LaTeX directly with Tectonic). DOCX/ODT/RTF/DOC/PPTX/XLSX to PDF, DOC/DOCX/ODT/RTF between each other and PDF to
  DOCX/ODT with LibreOffice; DOCX/ODT/RTF to text formats with Pandoc. PDF to page images (PNG/JPG, 150 dpi) and text with Poppler.
- Every engine is an optional component: the first conversion that needs it lists what will be downloaded with sizes and
  asks; LibreOffice (375 MB, 1.5 GB on disk) is unpacked from the official MSI without admin rights.
- Binaries lists every optional component and downloaded model with Remove/Delete (rembg, Whisper, Demucs, the AI runtime).

## 21. Pattern Generator (T21)

- Idea from durves.com, written from scratch: a dot grid (16-152 across) displaced by seeded simplex noise (direction = noise ×
  waves, distance = amplitude × |noise|, scale = frequency), dot radius, size of the area covered, dot colour, optional
  background, formats 1:1 / 16:9 / 9:16 / 4:5. Live preview; Random; up to 12 named presets.
- Export PNG at 1080p, 2160p or 4K long side (transparent without background) or SVG (one circle per dot) to the chosen
  folder, optional copy to Eagle. Everything remembered.

## 22. Pixel Art (T22)

- Idea from pixelartvillage.com, written from scratch, all in the app: pixel size 1-64, brightness / contrast / saturation,
  palettes (Pico-8, Game Boy, Sweetie 16, Endesga 32, CGA, 1-bit; imported from a Lospec link; pasted hex codes; or 1-64
  colours taken from the image by median cut), dithering (none, Floyd–Steinberg, ordered 4×4), grid with colour.
- Live preview of the selected image; export every image with the same settings as PNG: small (1 px per art pixel),
  original size or up to 2160 / 3840 px, always an integer scale so pixels stay crisp; optional copy to Eagle.

## 23. Backdrops (T23)

- Every tool can have its own background image (a transparent PNG/WebP), drawn faintly behind the page so it is
  there without getting in the way. Set from the **Backdrop** button in the tool's header: a panel beside the page
  with live result. Looks: Outline, Sketch, Glow, Ghost, B&W, Duotone, Halftone, Pixel, Faded colour; Visibility,
  Size, Detail, Softness, Position (left/center/right), Colour (amber/white/image), fade towards the content, mirror;
  Sample, None, Apply to all tools. Images are copied to `hermes-data/backdrops`; everything survives restarts.

## 24. Anya (T24)

- A companion with personality, never in the way: Anya stands in the bottom corner of the sidebar (the tool list
  scrolls above her) or in the window's bottom-right corner, wobbles gently, squishes while she talks and plays a
  short voice sound (volume adjustable). Her face is the app mark and icon.
- Each page has its own pose (Libbie art recoloured to Hermes' amber/cream/graphite). After a few quiet minutes she
  goes idle "working" on something (coffee, muffin, paperwork...); clicking her brings her back with a line about
  where you are.
- She talks in English, playful and a little tsundere but sweet: tips for the tool you're on, a cheer when a job
  ends, a word when one fails, random encouragement, and short video-game quotes cited with their source and
  followed by her own comment. On her own she talks only after a quiet stretch (Never / Sometimes / Often).
- Right-click: say something, game quote, hush for an hour, mute, settings, hide. Settings: on/off, voice, volume,
  size, position, wobble (off / gentle / lively), how often she talks. Everything survives restarts.

## 9. Delivery tranches

Each tranche ends with a working, committed build. Later tranches never require reworking earlier ones.

| # | Tranche | Done when |
|---|---|---|
| T0 | Toolchain + repo | Rust/MSVC installed, Tauri project builds, public GitHub repo, `hermes-data` git-ignored |
| T1 | App shell | Frameless window, title bar with feather mark, sidebar from module registry, Graphite/Amber theme, settings.json next to exe, banner + modal components |
| T2 | Release pipeline + self-update | Tag → Actions builds exe → Release; app detects, downloads, swaps, relaunches |
| T3 | Shared services | Binary manager (embed, extract, in-app updates), queue engine (persist, concurrency, cooldown countdown), Eagle client |
| T4 | Video Downloader | Everything in section 5 + cookies (auto + fallback modal) |
| T5 | Gallery Downloader | Everything in section 6 |
| T6 | Background Removal | Everything in section 7 |
| T7 | Upscale | Images first, then video pipeline |

## 10. Ideas parked
- faster-whisper: auto subtitles/transcripts.
- ffmpeg presets: compress/convert/trim for social formats.
- ExifTool: strip/edit metadata.
