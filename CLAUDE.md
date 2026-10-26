# Hermes

Portable Windows utility app (no installer) for a content creator. Personal use, public repo
`MegumiSharp/hermes`, unsigned exe is fine.

- Full spec: [docs/SPEC.md](docs/SPEC.md) — read before changing behavior.
- Design: [design/mockups.html](design/mockups.html), chosen **01 Graphite / Amber**. App mark: feather ([design/icon.svg](design/icon.svg)).
- Work in tranches (SPEC section 9); finish, test and commit one before starting the next.
  Done: T0–T7 (all modules). Owner's manual test checklist: [docs/TEST-TODO.md](docs/TEST-TODO.md).

## Open issues (fix only when the owner asks)
- t3-test "failure keeps the tool's error": ffmpeg's final line is "Error opening input files: No such file or directory" (file name is on an earlier line). Decide: better error capture or relax the test.
- t4-test stops at the 2nd download: after "Add to queue" the preview is only hidden, its `.t` stays in the DOM, so `addAndWait` skips re-fetching and clicks a disabled button. Test bug; MP4/1080p/Eagle/playlist paths of T4 not yet covered by the automated run.
- t5-7-test gallery section: Wikimedia rate-limits this IP after repeated runs (429 → queue cooldown, test times out). Run with `ONLY=rembg,upscale` or point the gallery test at another source.
- v0.3.0 (T5-T7) not released yet: publishing needs the owner's go-ahead (`node scripts/release.mjs 0.3.0`).
- Hermes.exe needs the VC++ 2015-2022 runtime (MSVCP140.dll, from ONNX Runtime). Present on almost every PC.

## Conventions
- UI text in English. Owner talks in Italian.
- Minimal, dark, one accent color, Lucide line icons. No emoji anywhere in UI.
- Each module is self-contained; adding one touches only the registry in `src/main.ts`.
- Everything the app writes lives in `hermes-data/` next to the exe. Never commit it.
- External tools run hidden (`binaries::NO_WINDOW`), never a console window.
- Don't write project files with PowerShell `Set-Content`/`Out-File` (PS 5.1 adds a UTF-8 BOM that breaks JSON). Use the Write/Edit tools or node.

## Code map (keep this current; it exists so code doesn't need re-reading)

### Frontend (`src/`, vanilla TS + Vite, top-level await OK)
| File | Contents |
|---|---|
| `main.ts` | Entry. `Module` type `{id,name,icon,section:"tools"\|"system",render(view)}`, `modules[]` registry, `open(id)` (sets `.nav.on`, renders into `#view`, persists `settings.lastModule`), listens `hermes:open`, sidebar, title-bar `#wc-min/#wc-max/#wc-close`, `renderSettings` (`#data-path #open-data #update-status #check-update`), `soon(id,title,tranche)` placeholder that mounts that module's queue. Starts `startUpdateChecks()` + `startBinaryChecks()` |
| `core.ts` | `settings`, `saveSettings(patch)`, `navigate(id)`, `h(html)`, `banner({id,text(html),icon?,tone?:"accent"\|"warn",actions?})` → close (one per id, `[data-banner=id]` in `#banners`), `modal({title,body,actions?,onClose?})` → close (`actions: []` = none). `Action = {label,primary?,run?}`: `run` may be async, returning `false` keeps it open |
| `cookies.ts` | `cookieArgs(site)` → yt-dlp/gallery-dl args from `settings.cookies[site]` (`auto` = first of `detect_browsers`, Firefox preferred; `file` → `--cookies`), `cookieLabel(site)`, `isCookieError(msg)`, `markBroken(site)` (session: browser extraction failed → no cookies), `cookiesModal(site, reason?)` → Promise<changed> (source select `#ck-mode`, drop zone `.drop input`, result `.ck-result.ok/.bad`) |
| `cookies-validate.ts` | Pure: `SITES` (youtube: domain, login cookie names), `validateCookies(text, site)` → `{ok,count,signedIn,expires,error}`. Imported by tests under plain node |
| `modules/common.ts` | Shared module controls: `paths` (promise `{data,bin,results}`), `folderField(prefs,save,id)`, `eagleControls(prefs,save,id)` → [checkbox label, status chip `#<id>-state`], `dropZone({id,label,exts,multiple}, onFiles)` (HTML5 drop → `save_upload` bytes; Browse → dialog paths), `beforeAfter(before, after, labels)` (`.ba`, `--pos`, `aria-valuenow`), `resultsPanel(module)` (done image jobs with `source` → `.results .r-strip .r-thumb` + slider), `fileName`, `stem` |
| `modules/gallery.ts` | `renderGallery`. Probe `gallery-dl --resolve-json --range 1-N`; `[3,url,meta]` → `Item {key=filename.ext, kind, w, h, date, author, off}`. Filters (`settings.gallery.filters`: types, extOff, minW/H, date range, sizeMin/Max MB → `--filesize-*`, limit, skipDownloaded → `--download-archive hermes-data/gallery-archive.sqlite3`) and manual picks resolve client-side; final set goes to gallery-dl as `image-filter` in a `write_job_file` config. One job (not a group), parser `galleryDl` with `duration` = file count. Cookies only for `SITES` categories. DOM `#g-url #g-fetch #g-grid .tile(.off)[data-key] #g-summary #g-all #g-none #g-filters [data-type] .f-ext[data-ext] [data-num=minW..] [data-bool] #g-add #g-eagle` |
| `modules/rembg.ts` | `renderRembg`, `modelsModal()` (tick → total size → "Download models?" confirm → progress via `model-progress`; delete per model). Tabs Batch / Compare (`.tab[data-mode]`). Batch: `rembg` step (+ `eagle {keep:true}`; output in `results` dir when Eagle on, else folder). Compare: `rembg_compare` → `#r-grid .r-cell`, click → slider modal → Keep (Eagle job with `outputs`, or `copy_file`). DOM `#r-models #r-none #r-model #r-bgmode #r-color #r-crop #r-drop #r-drop-compare #r-pick #r-go` |
| `modules/upscale.ts` | `renderUpscale`. Models x4plus (4×), x4plus-anime (4×), animevideov3 (2/3/4×). Image job: realesrgan step (parser `percent`). Video job: ffprobe → extract jpg frames to `hermes-data/temp/upscale-*` → realesrgan folder → ffmpeg NVENC + original audio → `delete` step → Eagle. DOM `#u-model #u-scale #u-drop #u-video-note #u-go #u-tool` |
| `modules/video.ts` | `renderVideo`. Prefs `settings.video {format:"best"\|"1080p"\|"mp4"\|"mp3", folder, eagle}`. Probe = `tool_json yt-dlp -J --flat-playlist` (+`--no-playlist` for watch URLs); cookie error → retry without cookies + `cookiesModal`. Jobs: `download()` step (progress template + `[file]` print), `convert()` (NVENC h264/aac or `-c copy` if source avc1+mp4a; mp4 path downloads with `--remux-video mkv`, `replace: true`), Eagle step, tags = [channel, url]. Playlist → group. DOM ids `#v-url #v-fetch #v-preview(.loading/.error) #v-format .menu [data-format] #v-folder #v-eagle #v-eagle-state #v-add #v-cookies #v-ytdlp` |
| `icons.ts` | `icon(name)`, `IconName`. Lucide paths |
| `update.ts` | App self-update: `checkForUpdate()`, `startUpdateChecks()`, install modal (`update-progress` event) |
| `binaries.ts` | `binariesReady` (promise: tools extracted/verified — **modules await it before running tools**), `toolStatus(id)`, `startBinaryChecks()` (auto-update yt-dlp if `settings.autoUpdateYtdlp !== false`, banners `binaries-broken`, `binaries-update`, `bin-<id>`), `renderBinaries(view)` (rows `[data-bin=id]` `.bin-name .sub`=version `.chip` `.bin-latest`, buttons `[data-update=id]`, `#bin-check`, `#bin-auto`) |
| `queue.ts` | **Module API:** `addJobs(NewJob[])` (warns `eagle-offline` banner if needed), `queueAction(id, pause\|resume\|retry\|remove\|keep)`, `mountQueue(el, module?)`. Types `NewJob {module,title,pill?,steps?,eagle?:{website,tags,annotation},children?}` (children → expandable group), `Step = {type:"run",label,bin,args,parser:"ytDlp"\|"ffmpeg"\|"plain",outputs?,duration?} \| {type:"eagle"}`. DOM: `.item.<state>[data-job=id]`, `[data-act=pause\|resume\|retry\|keep\|reveal\|remove\|expand\|clear\|pauseAll\|resumeNow]`, cooldown `[data-until]` |
| `styles.css` | Tokens on `:root`. `.btn(.sm/.primary/.ghost)`, `.card .row .k .v`, `label.row` + `.switch`, `.chip(.bad) .dot`, `.pill`, `.sub`, `.banner(.warn)`, modal classes, `.bar(.thick) > i`, `.progress`, queue classes (`.queue .qhead .overall .list .item .kids`) |

### Backend (`src-tauri/src/`)
| File | Contents |
|---|---|
| `lib.rs` | `data_dir()`, `now_ms()`, `read_json`, `write_json` (atomic), `setting(key)` (in-memory copy of settings.json, updated by `save_settings`). Commands `data_path`, `load_settings`, `save_settings`, `module_paths`, `write_job_file(name,text)` (hermes-data/jobs), `save_upload` (raw bytes + `x-name` header → hermes-data/uploads), `copy_file`, `make_dirs`. Asset protocol enabled (`convertFileSrc` for previews). Setup starts `queue::start`; on exit `queue::shutdown()` kills tools. Registers all commands |
| `net.rs` | `client()`, `err()`, `latest_release(api)` → `Option<Release{tag,date,assets}>` (GitHub + Codeberg/Gitea; **ETag cache** in `hermes-data/http-cache.json` so 304s don't burn the 60/h GitHub limit; 403/429 → "rate limit" error), `download(url,dest,progress)`, `is_exe(path)` |
| `update.rs` | `check_update`, `install_update(url)` (rename-swap + relaunch, disabled in debug), `cleanup_old_exe()` |
| `binaries.rs` | Tool table from `src-tauri/binaries.json` (`id,name,api,asset` glob where `*` excludes '-', `files`, `verify` args, `notify`). Payload appended to exe (see `scripts/pack.mjs`). `bin_dir()`, `command(file)` → hidden tokio Command with bin dir first on PATH + `PYTHONIOENCODING=utf-8`. Commands `tool_json(bin,args)` (stdout JSON; error = last `ERROR:` line), `binaries_init` (extract missing / older-than-bundled, re-extract broken, verify; returns `Status[]`), `binaries_latest` → `{versions, errors}`, `binary_update(id)` (download, `tar -xf` zips, rename-swap, emits `binary-progress` `[id,done,total]`). Installed versions in `bin/versions.json` (compare by release `date`) |
| `eagle.rs` | `online()`, `add(path, Meta)` — waits until `item/info` reports the item with the source's byte size (**addFromPath replies before copying**; deleting early loses videos). Command `eagle_status` |
| `rembg.rs` | `MODELS` (id, file in rembg's v0.0.0 release, MB, kind BiRefNet/IsNet/IsNetAnime/U2Net → input size + normalisation + sigmoid). ONNX Runtime `ort` 2.0-rc.15 with DirectML (+CPU fallback); one cached `Session` behind a mutex (serialises GPU). `DirectML.dll` is delay-loaded (`build.rs`) and loaded from bin/ first (`load_directml`). `remove(model,input,output,background,crop)` (queue step), commands `rembg_models`, `rembg_download(ids)` (`model-progress` `[id,done,total]`), `rembg_delete`, `rembg_compare(input, models)` → `{model,output,ms,error}`. `results_dir()` = hermes-data/results, `cleanup_results()` (7 days) at startup |
| `cookies.rs` | `detect_browsers` (profile dirs; order firefox, chrome, edge, brave), `cookies_write(site,text)` → path, `cookies_path(site)` |
| `queue.rs` | Jobs with `steps`: `Run` (parser `YtDlp`/`Ffmpeg`/`Plain`/`GalleryDl`/`Percent`, `{last}`/`{last_noext}` placeholders, `replace` flag; realesrgan runs one at a time), `Eagle {keep}` (import, delete unless keep), `Delete {paths}`, `Rembg {model,input,output,background,crop}`. Job fields incl. `source` (preview original) and pre-set `outputs`. Output read as bytes + lossy UTF-8. States `queued running paused waitingEagle done failed`. Persisted `queue.json` (Running→Queued on load). Scheduler: 1 s tick + `KICK`, `maxConcurrent` (default 3), group children spaced 2-5 s, rate-limit lines (429 / "Sign in to confirm") → `pausedUntil` absolute ms, backoff 5→10→…→60 min (reset on success), WaitingEagle rechecked every 10 s. Tool output: `[file] <path>` lines = outputs; `ERROR:` lines = error text. Kills with `taskkill /T`. Events `queue` (snapshot), `job` (`{id,progress,detail}`, ≤5/s). Commands `queue_get/add/action/pause_all/clear_finished/resume_now` |

Config: `tauri.conf.json` (frameless 1180×760, `bundle.active=false`), `capabilities/default.json`.

## Build, test, release
- Rust is at `%USERPROFILE%\.cargo\bin` (add to PATH in new shells).
- Dev: `npx tauri dev` (no payload: tools install via Binaries page). Release: `npm run build:exe` → `release/Hermes.exe`
  (tauri build + `scripts/pack.mjs`, which caches downloads in `vendor/`). Locally set `$env:GITHUB_TOKEN = gh auth token` first.
- **Testing (mandatory after every change):** `node scripts/smoke.mjs` (all modules, settings, window buttons)
  and the feature test of the tranche you touched: `node scripts/t3-test.mjs` (binaries, queue, Eagle; needs Eagle open),
  `node scripts/t4-test.mjs` (video downloader; needs network + Eagle), `node scripts/t5-7-test.mjs` (gallery, background
  removal incl. model download/compare/slider, upscale image + video). **Run tests in the background; never block on them.**
  Harness `scripts/smoke.mjs` exports `{ launch, connect, check, OUT }`; tests call backend commands with
  `page.evaluate(() => window.__TAURI_INTERNALS__.invoke(cmd, args))`. Unauthenticated GitHub API = 60/h per IP:
  many fresh-data launches in an hour exhaust it.
- Self-update E2E: `node scripts/update-test.mjs <dir with older Hermes.exe> <published version>`.
- Release: `node scripts/release.mjs X.Y.Z` (bump, commit, annotated tag, push) → `.github/workflows/release.yml` builds and publishes `release/Hermes.exe`.
- Rust unit tests: `cargo test --release` in `src-tauri`.

## Owner hardware
- GPU: NVIDIA RTX 3060 Ti (use NVENC for MP4 conversion). Editing target: Adobe Premiere.
