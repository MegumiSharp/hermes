// Video Downloader module (SPEC 5): yt-dlp + ffmpeg through the shared queue.
import { invoke } from "@tauri-apps/api/core";
import { binariesReady, toolStatus } from "../binaries";
import { cookieArgs, cookieLabel, cookiesModal, isCookieError, markBroken } from "../cookies";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";
import { eagleControls, folderField } from "./common";

type Format = "best" | "2160" | "1440" | "1080" | "mp3";
type Prefs = { format: Format; folder: string; eagle: boolean; url: string; premiere: boolean; wholeList: boolean; cover: boolean; lyrics: boolean; wav: boolean };

type Fmt = { format_id?: string; ext?: string; vcodec?: string; acodec?: string; height?: number; fps?: number; tbr?: number; abr?: number; filesize?: number; filesize_approx?: number };
/** The subset of `yt-dlp -J` output we use. */
type Info = {
  _type?: string; id: string; title: string; channel?: string; uploader?: string; duration?: number;
  upload_date?: string; view_count?: number; thumbnail?: string; webpage_url?: string; url?: string;
  height?: number; fps?: number; vcodec?: string; acodec?: string; filesize?: number; filesize_approx?: number;
  requested_formats?: Fmt[]; formats?: Fmt[];
  entries?: Info[]; playlist_count?: number; thumbnails?: { url: string }[];
  language?: string; subtitles?: Record<string, unknown>; // subtitles = uploaded by the channel (auto captions are separate)
};

const SITE = "youtube";
const MIX_LIMIT = 50; // YouTube Mixes are endless
const PROGRESS = "download:[hermes] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s";

const FORMATS: { id: Format; label: string; height?: number; icon: "film" | "music" }[] = [
  { id: "best", label: "Best quality", icon: "film" },
  { id: "2160", label: "2160p (4K)", height: 2160, icon: "film" },
  { id: "1440", label: "1440p", height: 1440, icon: "film" },
  { id: "1080", label: "1080p", height: 1080, icon: "film" },
  { id: "mp3", label: "Audio only", icon: "music" },
];
const LABEL: Record<Format, string> = { best: "Best", "2160": "2160p", "1440": "1440p", "1080": "1080p", mp3: "MP3" };

function codec(c?: string) {
  if (!c || c === "none") return "";
  if (c.startsWith("avc1")) return "H.264";
  if (c.startsWith("vp09") || c.startsWith("vp9")) return "VP9";
  if (c.startsWith("av01")) return "AV1";
  if (c.startsWith("hev1") || c.startsWith("hvc1")) return "H.265";
  if (c.startsWith("mp4a")) return "AAC";
  if (c.startsWith("opus")) return "Opus";
  return c.split(".")[0].toUpperCase();
}
const size = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
const clock = (s: number) => {
  s = Math.round(s);
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  return (hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, "0")}` : `${hms[1]}`) + `:${String(hms[2]).padStart(2, "0")}`;
};

/** list= in the URL: a watch link inside a playlist/Mix (RD… = YouTube Mix). */
function listKind(url: string): "none" | "playlist" | "mix" {
  const list = /[?&]list=([^&]+)/.exec(url)?.[1];
  if (!list || !/[?&]v=|youtu\.be\//.test(url)) return "none"; // bare playlist URLs are always the whole list
  return list.startsWith("RD") ? "mix" : "playlist";
}

// ---------- what yt-dlp will pick ----------

const vRank = (c = "") => (c.startsWith("av01") ? 4 : c.startsWith("vp09") || c.startsWith("vp9") ? 3 : c.startsWith("hev1") || c.startsWith("hvc1") ? 2 : 1);
const aRank = (c = "") => (c.startsWith("opus") ? 3 : c.startsWith("vorbis") ? 2 : 1);

/** Mirrors yt-dlp's default choice (resolution, fps, codec AV1>VP9>H.264, Opus>AAC) and merge rules,
 *  so the user knows the container before downloading. */
function predict(i: Info, maxH?: number): { ext: string; v: Fmt; a?: Fmt } | null {
  let v: Fmt | undefined, a: Fmt | undefined;
  if (!maxH && i.requested_formats?.length) [v, a] = i.requested_formats; // exactly yt-dlp's own pick
  else {
    const vids = (i.formats ?? []).filter((f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && (f.height ?? 0) <= (maxH ?? 1e9));
    v = vids.sort((x, y) => (y.height ?? 0) - (x.height ?? 0) || (y.fps ?? 0) - (x.fps ?? 0) || vRank(y.vcodec) - vRank(x.vcodec) || (y.tbr ?? 0) - (x.tbr ?? 0))[0];
    a = (i.formats ?? []).filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
      .sort((x, y) => aRank(y.acodec) - aRank(x.acodec) || (y.abr ?? 0) - (x.abr ?? 0))[0];
  }
  if (!v) return null;
  const mp4ish = (e?: string) => e === "mp4" || e === "m4a";
  const ext = !a ? v.ext ?? "mp4" : mp4ish(v.ext) && mp4ish(a.ext) ? "mp4" : v.ext === "webm" && a.ext === "webm" ? "webm" : "mkv";
  return { ext, v, a };
}
const premiereReady = (p: { v: Fmt; a?: Fmt; ext: string } | null) => !!p && p.ext === "mp4" && !!p.v.vcodec?.startsWith("avc1") && (!p.a || !!p.a.acodec?.startsWith("mp4a"));

// ---------- job building ----------

function download(url: string, p: Prefs, cookies: string[], toMkv: boolean, subLangs = ""): Step {
  const args = [
    "--newline", "--progress", "--no-colors", "--encoding", "utf-8", "--no-playlist",
    "--progress-template", PROGRESS, "--print", "after_move:[file] %(filepath)s",
    "-o", `${p.folder}\\%(title).150B [%(id)s].%(ext)s`, ...cookies,
  ];
  const h = FORMATS.find((f) => f.id === p.format)?.height;
  const fmt = p.format !== "mp3"
    ? ["-f", h ? `bv*[height<=${h}]+ba/b[height<=${h}]` : "bv*+ba/b", ...(toMkv ? ["--remux-video", "mkv"] : [])] // mkv: the converted .mp4 never collides with its source
    : p.wav
      ? ["-f", "ba/b", "-x", "--audio-format", "wav", "--ppa", "ExtractAudio:-ar 48000"] // Premiere's native rate
      : ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "320K", "--embed-metadata",
        ...(p.cover ? ["--embed-thumbnail", "--ppa", "ThumbnailsConvertor:-vf crop=ih:ih"] : []), // square, like an album cover
        ...(subLangs ? ["--write-subs", "--sub-langs", subLangs, "--convert-subs", "srt"] : [])];
  return { type: "run", label: "Downloading", bin: "yt-dlp.exe", parser: "ytDlp", args: [...args, ...fmt, url] };
}

/** H.264 + AAC sources only need a remux; everything else is encoded on the GPU for Premiere. */
function convert(duration: number): Step {
  // ponytail: NVENC only (owner has an RTX 3060 Ti); add a libx264 fallback if Hermes runs on other GPUs
  return {
    type: "run", label: "Converting for Premiere (NVENC)", bin: "ffmpeg.exe", parser: "ffmpeg", duration, replace: true,
    outputs: ["{last_noext}.mp4"],
    args: ["-y", "-i", "{last}", "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
      "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "{last_noext}.mp4"],
  };
}

/** Official lyrics = subtitles uploaded by the channel, in the video's language when it has them.
 *  "" = none. Flat playlist entries don't list subtitles: ask for all, lyrics.rs keeps the best. */
function lyricsLangs(v: Info, p: Prefs): string {
  if (p.format !== "mp3" || p.wav || !p.lyrics) return "";
  if (!v.subtitles) return "all,-live_chat";
  const langs = Object.keys(v.subtitles).filter((l) => l !== "live_chat");
  return (v.language && langs.find((l) => l === v.language || l.startsWith(`${v.language}-`))) || langs.find((l) => l.startsWith("en")) || langs[0] || "";
}

const pillOf = (p: Prefs) => (p.format !== "mp3" ? `${LABEL[p.format]}${p.premiere ? " · MP4" : ""}` : p.wav ? "WAV · Montaggio" : "MP3");

function videoJob(v: Info, channel: string, p: Prefs, cookies: string[]): NewJob {
  const url = v.webpage_url ?? v.url ?? `https://www.youtube.com/watch?v=${v.id}`;
  const fh = FORMATS.find((f) => f.id === p.format)?.height;
  // flat playlist entries have no formats: convert unless we know it's already Premiere-ready
  const needsConvert = p.format !== "mp3" && p.premiere && !premiereReady(v.formats || v.requested_formats ? predict(v, fh) : null);
  const subLangs = lyricsLangs(v, p);
  const steps: Step[] = [download(url, p, cookies, needsConvert, subLangs)];
  if (needsConvert) steps.push(convert(v.duration ?? 0));
  if (subLangs) steps.push({ type: "lyrics", prefer: v.language ? [v.language] : [] });
  if (p.eagle) steps.push({ type: "eagle" });
  return { module: "video", pill: pillOf(p), title: v.title, steps, eagle: { website: url, tags: [channel, url].filter(Boolean) } };
}

// ---------- module ----------

export function renderVideo(view: HTMLElement) {
  const { state: prefs, save } = memory<Prefs>("video", { format: "best", folder: "", eagle: true, url: "", premiere: false, wholeList: false, cover: true, lyrics: true, wav: false });
  // pre-T13 format names
  if ((prefs.format as string) === "1080p") prefs.format = "1080";
  if ((prefs.format as string) === "mp4") Object.assign(prefs, { format: "best", premiere: true });
  clearers.set("video", () => { prefs.url = ""; save(); });
  let info: Info | null = null;
  let probing = 0; // id of the latest probe, so stale results are dropped

  const page = h(`<div class="page video">
    <div class="head">
      <div><h3>Video Downloader</h3><div class="sub">Video and audio from YouTube and 1,800+ sites</div></div>
      <div class="right"><span class="chip" id="v-ytdlp"><span class="dot"></span>yt-dlp</span>
        <button class="chip chip-btn" id="v-cookies">${icon("cookie")}<span></span></button></div>
    </div>
    <form class="url" id="v-form">
      <label class="field">${icon("link")}<input id="v-url" placeholder="Paste a video or playlist URL" autocomplete="off" spellcheck="false"></label>
      <button class="btn" id="v-fetch" type="submit">Fetch</button>
    </form>
    <label class="check v-list" id="v-list" hidden><input type="checkbox" id="v-whole"><span class="box">${icon("check")}</span><span class="v-list-t"></span></label>
    <div class="preview" id="v-preview" hidden></div>
    <div class="opts">
      <div class="opt"><span class="field-label">Format</span>
        <div class="dropdown"><button class="select" id="v-format" aria-haspopup="listbox"></button><div class="menu" role="listbox" hidden></div></div></div>
      <div id="v-dest"></div>
    </div>
    <div class="v-out">
      <span class="sub" id="v-container"></span>
      <label class="check" id="v-premiere-box"><input type="checkbox" id="v-premiere"><span class="box">${icon("check")}</span>Convert to MP4 for Premiere<span class="s">H.264 + AAC, GPU</span></label>
      <div class="v-audio" id="v-audio">
        <label class="check" id="v-wav-box" title="Uncompressed WAV at 48 kHz, Premiere's native rate"><input type="checkbox" id="v-wav"><span class="box">${icon("check")}</span>WAV for editing<span class="s">48 kHz</span></label>
        <label class="check" id="v-cover-box" title="The video thumbnail, cropped square like an album cover"><input type="checkbox" id="v-cover"><span class="box">${icon("check")}</span>Embed cover<span class="s">square</span></label>
        <label class="check" id="v-lyrics-box" title="Subtitles the channel uploaded, when the video has them. Never automatic captions."><input type="checkbox" id="v-lyrics"><span class="box">${icon("check")}</span>Embed lyrics<span class="s">official only</span></label>
      </div>
    </div>
    <div class="row2"><button class="btn primary" id="v-add" disabled>${icon("download")}Add to queue</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const urlInput = $<HTMLInputElement>("#v-url");
  const preview = $("#v-preview");
  const addBtn = $<HTMLButtonElement>("#v-add");
  $("#v-dest").append(folderField(prefs, save, "v-folder"));
  $(".row2").prepend(...eagleControls(prefs, save, "v-eagle"));

  // ----- header chips -----
  toolStatus("yt-dlp").then((yt) => {
    $("#v-ytdlp").lastChild!.textContent = yt?.version ? `yt-dlp ${yt.version}` : "yt-dlp missing";
    $("#v-ytdlp").classList.toggle("bad", !yt?.ok);
  });
  const refreshCookieChip = async () => ($("#v-cookies span").textContent = await cookieLabel(SITE));
  refreshCookieChip();
  $("#v-cookies").onclick = async () => { if (await cookiesModal(SITE)) refreshCookieChip(); };

  // ----- playlist / Mix choice -----
  const listBox = $<HTMLInputElement>("#v-whole");
  listBox.checked = prefs.wholeList;
  listBox.onchange = () => { prefs.wholeList = listBox.checked; save(); probe(); };
  function renderListChoice() {
    const kind = listKind(urlInput.value.trim());
    $("#v-list").hidden = kind === "none";
    $(".v-list-t").textContent = kind === "mix"
      ? `This is a YouTube Mix: download the whole Mix (up to ${MIX_LIMIT} songs) instead of only this song`
      : "This video is in a playlist: download the whole playlist instead of only this video";
  }

  // ----- format dropdown + output notice -----
  const fmtBtn = $<HTMLButtonElement>("#v-format");
  const menu = page.querySelector<HTMLElement>(".menu")!;
  const maxHeight = () => (info && info._type !== "playlist" ? Math.max(0, ...(info.formats ?? []).map((f) => f.height ?? 0), info.height ?? 0) : 1e9);
  function hint(f: (typeof FORMATS)[number]): string {
    if (f.id === "mp3") return prefs.wav ? "WAV 48 kHz" : "MP3 320 kbps";
    if (!info || info._type === "playlist") return f.height ? `up to ${f.height}p` : "highest available";
    if (f.height && maxHeight() < f.height) return `not available (max ${maxHeight()}p)`;
    const p = predict(info, f.height);
    return p ? `${p.v.height ?? "?"}p ${codec(p.v.vcodec)} · ${p.ext.toUpperCase()}` : "";
  }
  function renderFormat() {
    const f = FORMATS.find((x) => x.id === prefs.format)!;
    fmtBtn.innerHTML = `${icon(f.icon)}<span>${f.label}</span><span class="chev">${icon("chevronDown")}</span>`;
    menu.innerHTML = FORMATS.map((x) => {
      const off = !!(x.height && info && info._type !== "playlist" && maxHeight() < x.height);
      return `<button class="mi ${x.id === prefs.format ? "on" : ""}" role="option" data-format="${x.id}" aria-selected="${x.id === prefs.format}" ${off ? "disabled" : ""}>
        ${icon(x.icon)}<span>${x.label}</span><span class="d">${hint(x)}</span><span class="ck">${x.id === prefs.format ? icon("check") : ""}</span></button>
        ${x.id === "1080" ? `<div class="sep"></div>` : ""}`;
    }).join("");
    renderOutput();
  }
  /** "Saved as WEBM (VP9 + Opus)": what the file will be, and whether Premiere can use it. */
  function renderOutput() {
    const audio = prefs.format === "mp3";
    $("#v-premiere-box").hidden = audio;
    $("#v-audio").hidden = !audio;
    $("#v-cover-box").hidden = $("#v-lyrics-box").hidden = prefs.wav; // WAV can't carry a cover or lyrics
    const el = $("#v-container");
    if (audio) {
      if (prefs.wav) { el.textContent = "Saved as WAV (48 kHz) for editing in Premiere."; return; }
      const subs = info && info._type !== "playlist" ? lyricsLangs(info, prefs) : "";
      const lyr = !prefs.lyrics ? "" : info && info._type !== "playlist" ? (subs ? ` and lyrics (${subs})` : ", no official lyrics for this video") : " and lyrics where the video has them";
      el.textContent = `Saved as MP3 320 kbps with tags${prefs.cover ? ", square cover" : ""}${lyr}.`;
      return;
    }
    if (!info) { el.textContent = ""; return; }
    if (info._type === "playlist") {
      el.textContent = prefs.premiere ? "Each video is saved as MP4 (H.264 + AAC)." : "Each video keeps its best container (usually MKV or WEBM).";
      return;
    }
    const p = predict(info, FORMATS.find((f) => f.id === prefs.format)?.height);
    if (!p) { el.textContent = ""; return; }
    const what = `${p.ext.toUpperCase()} (${[codec(p.v.vcodec), codec(p.a?.acodec)].filter(Boolean).join(" + ")}, ${p.v.height ?? "?"}p)`;
    el.textContent = prefs.premiere
      ? premiereReady(p) ? `Already ${what}: Premiere-ready, no conversion needed.` : `Downloaded as ${what}, then converted to MP4 H.264 + AAC for Premiere.`
      : `Saved as ${what}.${premiereReady(p) ? "" : " Premiere may not import it: tick the conversion below."}`;
  }
  const closeMenu = () => {
    menu.hidden = true;
    if (!page.isConnected) document.removeEventListener("click", closeMenu);
  };
  fmtBtn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-format]");
    if (!b || b.disabled) return;
    prefs.format = b.dataset.format as Format;
    save();
    renderFormat();
    closeMenu();
  };
  document.addEventListener("click", closeMenu);
  page.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  const premiere = $<HTMLInputElement>("#v-premiere");
  premiere.checked = prefs.premiere;
  premiere.onchange = () => { prefs.premiere = premiere.checked; save(); renderOutput(); };
  for (const key of ["wav", "cover", "lyrics"] as const) {
    const box = $<HTMLInputElement>(`#v-${key}`);
    box.checked = prefs[key];
    box.onchange = () => { prefs[key] = box.checked; save(); renderFormat(); };
  }

  // ----- probe -----
  async function probe() {
    const url = urlInput.value.trim();
    renderListChoice();
    if (!url) return;
    const id = ++probing;
    info = null;
    addBtn.disabled = true;
    preview.hidden = false;
    preview.className = "preview loading";
    preview.innerHTML = `<div class="thumb"></div><div class="meta"><div class="t">Fetching info</div><div class="c">This takes a few seconds</div></div>`;
    renderFormat();
    await binariesReady;
    const kind = listKind(url);
    const whole = kind !== "none" && prefs.wholeList;
    const scope = kind === "none" ? [] : whole ? ["--yes-playlist", ...(kind === "mix" ? ["--playlist-end", String(MIX_LIMIT)] : [])] : ["--no-playlist"];
    const run = async (cookies: string[]) =>
      invoke<Info>("tool_json", { bin: "yt-dlp.exe", args: ["-J", "--no-warnings", "--encoding", "utf-8", "--flat-playlist", ...scope, ...cookies, url] });
    let result: Info;
    try {
      result = await run(await cookieArgs(SITE));
    } catch (e) {
      if (!isCookieError(String(e))) return id === probing && showProbeError(String(e));
      // Browser cookies unreadable: continue without them and offer the fix.
      markBroken(SITE);
      refreshCookieChip();
      cookiesModal(SITE, String(e)).then((changed) => { if (changed) { refreshCookieChip(); probe(); } });
      try { result = await run([]); } catch (e2) { return id === probing && showProbeError(String(e2)); }
    }
    if (id !== probing) return;
    info = result;
    // a format the video doesn't have falls back to the best it has
    const fh = FORMATS.find((f) => f.id === prefs.format)?.height;
    if (fh && info._type !== "playlist" && maxHeight() < fh) prefs.format = "best";
    showInfo(result);
    addBtn.disabled = false;
    renderFormat();
  }

  function showProbeError(msg: string) {
    preview.className = "preview error";
    preview.innerHTML = `${icon("alert")}<div class="meta"><div class="t">Could not read this URL</div><div class="c"></div></div>`;
    preview.querySelector(".c")!.textContent = msg;
    if (/Sign in to confirm|age|members|private/i.test(msg)) {
      const b = h(`<button class="btn sm">${icon("cookie")}Set up cookies</button>`);
      b.onclick = async () => { if (await cookiesModal(SITE)) { refreshCookieChip(); probe(); } };
      preview.append(b);
    }
  }

  function showInfo(i: Info) {
    const playlist = i._type === "playlist";
    const thumb = i.thumbnail ?? i.thumbnails?.at(-1)?.url ?? i.entries?.[0]?.thumbnails?.at(-1)?.url;
    const f = i.requested_formats ?? [];
    const bytes = f.reduce((a, x) => a + (x.filesize ?? x.filesize_approx ?? 0), 0) || i.filesize || i.filesize_approx || 0;
    const facts = playlist
      ? [`${i.entries?.length ?? i.playlist_count ?? 0} videos`]
      : [i.height && `${i.height}p${i.fps && i.fps > 30 ? Math.round(i.fps) : ""}`, codec(f[0]?.vcodec ?? i.vcodec), codec(f[1]?.acodec ?? i.acodec), bytes && `~${size(bytes)}`];
    const date = i.upload_date?.replace(/(\d{4})(\d\d)(\d\d)/, "$1-$2-$3");
    const line = [playlist ? (listKind(urlInput.value) === "mix" ? "YouTube Mix" : "Playlist") : "", i.channel ?? i.uploader, i.view_count != null ? `${i.view_count.toLocaleString()} views` : "", date]
      .filter(Boolean).join(" · ");
    preview.className = "preview";
    preview.innerHTML = `<div class="thumb">${thumb ? `<img alt="" referrerpolicy="no-referrer">` : ""}${!playlist && i.duration ? `<span class="dur">${clock(i.duration)}</span>` : ""}</div>
      <div class="meta"><div class="t"></div><div class="c"></div><div class="facts">${facts.filter(Boolean).map((x) => `<span class="chip">${x}</span>`).join("")}</div></div>`;
    if (thumb) preview.querySelector("img")!.src = thumb;
    preview.querySelector(".t")!.textContent = i.title;
    preview.querySelector(".c")!.textContent = line;
  }

  $<HTMLFormElement>("#v-form").onsubmit = (e) => { e.preventDefault(); probe(); };
  urlInput.addEventListener("paste", () => setTimeout(probe, 0));
  urlInput.addEventListener("input", () => { prefs.url = urlInput.value; save(true); renderListChoice(); });

  // ----- add to queue -----
  addBtn.onclick = async () => {
    if (!info) return;
    const cookies = await cookieArgs(SITE);
    const channel = info.channel ?? info.uploader ?? "";
    const job = info._type === "playlist"
      ? { module: "video", title: info.title, pill: pillOf(prefs).replace(" · MP4", ""), children: (info.entries ?? []).map((e) => videoJob(e, e.channel ?? e.uploader ?? channel, prefs, cookies)) }
      : videoJob(info, channel, prefs, cookies);
    if (job.children && !job.children.length) return banner({ id: "video-empty", tone: "warn", icon: "alert", text: "This playlist has no videos." });
    await addJobs([job]);
    urlInput.value = prefs.url = "";
    save();
    preview.hidden = true;
    info = null;
    addBtn.disabled = true;
    renderListChoice();
    renderFormat();
    urlInput.focus();
  };

  renderFormat();
  if (prefs.url) {
    urlInput.value = prefs.url; // restored after a restart: fetch the preview again
    probe();
  }
  mountQueue(page, "video");
  view.append(page);
}
