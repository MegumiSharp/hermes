// Video Downloader module (SPEC 5): yt-dlp + ffmpeg through the shared queue.
import { invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { binariesReady, toolStatus } from "../binaries";
import { cookieArgs, cookieLabel, cookiesModal, isCookieError, markBroken } from "../cookies";
import { banner, h, saveSettings, settings } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";

type Format = "best" | "1080p" | "mp4" | "mp3";
type Prefs = { format: Format; folder: string; eagle: boolean };

/** The subset of `yt-dlp -J` output we use. */
type Info = {
  _type?: string; id: string; title: string; channel?: string; uploader?: string; duration?: number;
  upload_date?: string; view_count?: number; thumbnail?: string; webpage_url?: string; url?: string;
  height?: number; fps?: number; vcodec?: string; acodec?: string; filesize?: number; filesize_approx?: number;
  requested_formats?: { vcodec?: string; acodec?: string; filesize?: number; filesize_approx?: number }[];
  entries?: Info[]; playlist_count?: number; thumbnails?: { url: string }[];
};

const SITE = "youtube";
const PROGRESS = "download:[hermes] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s";

const FORMATS: { id: Format; label: string; pill?: string; icon: "film" | "music"; hint: (i?: Info) => string }[] = [
  { id: "best", label: "Best quality", icon: "film", hint: (i) => (i?.height ? `${i.height}p ${codec(i.vcodec)}` : "Native format") },
  { id: "1080p", label: "1080p", icon: "film", hint: () => "MP4 H.264 when available" },
  { id: "mp4", label: "MP4", pill: "Converted", icon: "film", hint: () => "H.264 NVENC" },
  { id: "mp3", label: "Audio only", icon: "music", hint: () => "MP3 320 kbps" },
];
const PILL: Record<Format, string> = { best: "Best", "1080p": "1080p", mp4: "MP4 converted", mp3: "MP3" };

function codec(c?: string) {
  if (!c || c === "none") return "";
  if (c.startsWith("avc1")) return "H.264";
  if (c.startsWith("vp09") || c.startsWith("vp9")) return "VP9";
  if (c.startsWith("av01")) return "AV1";
  if (c.startsWith("mp4a")) return "AAC";
  return c.split(".")[0].toUpperCase();
}
const size = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
const clock = (s: number) => {
  s = Math.round(s);
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  return (hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, "0")}` : `${hms[1]}`) + `:${String(hms[2]).padStart(2, "0")}`;
};

/** A watch URL with &list= means "this video"; a bare playlist URL means the whole playlist. */
const singleVideo = (url: string) => /[?&]v=|youtu\.be\/|\/shorts\//.test(url);

// ---------- job building ----------

function download(url: string, format: Format, folder: string, cookies: string[]): Step {
  const args = [
    "--newline", "--progress", "--no-colors", "--encoding", "utf-8", "--no-playlist",
    "--progress-template", PROGRESS, "--print", "after_move:[file] %(filepath)s",
    "-o", `${folder}\\%(title).150B [%(id)s].%(ext)s`, ...cookies,
  ];
  const fmt: Record<Format, string[]> = {
    best: ["-f", "bv*+ba/b"],
    "1080p": ["-f", "bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]", "--merge-output-format", "mp4/mkv"],
    // always mkv so the converted .mp4 never collides with its source
    mp4: ["-f", "bv*+ba/b", "--remux-video", "mkv"],
    mp3: ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "320K", "--embed-thumbnail", "--embed-metadata"],
  };
  return { type: "run", label: "Downloading", bin: "yt-dlp.exe", parser: "ytDlp", args: [...args, ...fmt[format], url] };
}

/** H.264 + AAC sources only need a remux; everything else is encoded on the GPU for Premiere. */
function convert(duration: number, remux: boolean): Step {
  // ponytail: NVENC only (owner has an RTX 3060 Ti); add a libx264 fallback if Hermes runs on other GPUs
  const codecs = remux
    ? ["-c", "copy"]
    : ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k"];
  return {
    type: "run", label: remux ? "Remuxing" : "Converting (NVENC)", bin: "ffmpeg.exe", parser: "ffmpeg", duration, replace: true,
    outputs: ["{last_noext}.mp4"],
    args: ["-y", "-i", "{last}", "-map", "0:v:0", "-map", "0:a:0?", ...codecs, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "{last_noext}.mp4"],
  };
}

function videoJob(v: Info, channel: string, p: Prefs, cookies: string[]): NewJob {
  const url = v.webpage_url ?? v.url ?? `https://www.youtube.com/watch?v=${v.id}`;
  const steps: Step[] = [download(url, p.format, p.folder, cookies)];
  if (p.format === "mp4") {
    const f = v.requested_formats ?? [];
    const remux = f.some((x) => x.vcodec?.startsWith("avc1")) && f.some((x) => x.acodec?.startsWith("mp4a"));
    steps.push(convert(v.duration ?? 0, remux));
  }
  if (p.eagle) steps.push({ type: "eagle" });
  return { module: "video", title: v.title, pill: PILL[p.format], steps, eagle: { website: url, tags: [channel, url].filter(Boolean) } };
}

// ---------- module ----------

export function renderVideo(view: HTMLElement) {
  const prefs: Prefs = { format: "best", folder: "", eagle: true, ...settings.video };
  const save = () => saveSettings({ video: prefs });
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
    <div class="preview" id="v-preview" hidden></div>
    <div class="opts">
      <div class="opt"><span class="field-label">Format</span>
        <div class="dropdown"><button class="select" id="v-format" aria-haspopup="listbox"></button><div class="menu" role="listbox" hidden></div></div></div>
      <div class="opt"><span class="field-label">Save to</span>
        <button class="field folder" id="v-folder">${icon("folder")}<span class="v mono"></span></button></div>
    </div>
    <div class="row2">
      <label class="check"><input type="checkbox" id="v-eagle"><span class="box">${icon("check")}</span>Send to Eagle<span class="s">Uncategorized</span></label>
      <span class="chip" id="v-eagle-state"><span class="dot"></span><span></span></span>
      <button class="btn primary" id="v-add" disabled>${icon("download")}Add to queue</button>
    </div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const urlInput = $<HTMLInputElement>("#v-url");
  const preview = $("#v-preview");
  const addBtn = $<HTMLButtonElement>("#v-add");

  // ----- header chips -----
  toolStatus("yt-dlp").then((yt) => {
    $("#v-ytdlp").lastChild!.textContent = yt?.version ? `yt-dlp ${yt.version}` : "yt-dlp missing";
    $("#v-ytdlp").classList.toggle("bad", !yt?.ok);
  });
  const refreshCookieChip = async () => ($("#v-cookies span").textContent = await cookieLabel(SITE));
  refreshCookieChip();
  $("#v-cookies").onclick = async () => {
    if (await cookiesModal(SITE)) refreshCookieChip();
  };

  // ----- format dropdown -----
  const fmtBtn = $<HTMLButtonElement>("#v-format");
  const menu = page.querySelector<HTMLElement>(".menu")!;
  function renderFormat() {
    const f = FORMATS.find((x) => x.id === prefs.format)!;
    fmtBtn.innerHTML = `${icon(f.icon)}<span>${f.label}</span>${f.pill ? `<span class="pill">${f.pill}</span>` : ""}<span class="chev">${icon("chevronDown")}</span>`;
    menu.innerHTML = FORMATS.map((x) => `
      <button class="mi ${x.id === prefs.format ? "on" : ""}" role="option" data-format="${x.id}" aria-selected="${x.id === prefs.format}">
        ${icon(x.icon)}<span>${x.label}</span>${x.pill ? `<span class="pill">${x.pill}</span>` : ""}
        <span class="d">${x.hint(info ?? undefined)}</span><span class="ck">${x.id === prefs.format ? icon("check") : ""}</span></button>
      ${x.id === "mp4" ? `<div class="sep"></div>` : ""}`).join("");
  }
  const closeMenu = () => {
    menu.hidden = true;
    if (!page.isConnected) document.removeEventListener("click", closeMenu);
  };
  fmtBtn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-format]");
    if (!b) return;
    prefs.format = b.dataset.format as Format;
    save();
    renderFormat();
    closeMenu();
  };
  document.addEventListener("click", closeMenu);
  page.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

  // ----- folder -----
  const folderLabel = $("#v-folder .v");
  (async () => {
    if (!prefs.folder) {
      prefs.folder = await join(await downloadDir(), "Hermes");
      save();
    }
    folderLabel.textContent = prefs.folder;
  })();
  $("#v-folder").onclick = async () => {
    const dir = await pickFolder({ directory: true, defaultPath: prefs.folder });
    if (typeof dir === "string") {
      prefs.folder = dir;
      folderLabel.textContent = dir;
      save();
    }
  };

  // ----- Eagle -----
  const eagleBox = $<HTMLInputElement>("#v-eagle");
  eagleBox.checked = prefs.eagle;
  eagleBox.onchange = () => { prefs.eagle = eagleBox.checked; save(); };
  const eagleChip = $("#v-eagle-state");
  const pollEagle = async () => {
    if (!page.isConnected) return clearInterval(eagleTimer);
    const on = await invoke<boolean>("eagle_status");
    eagleChip.classList.toggle("bad", !on);
    eagleChip.querySelector("span:last-child")!.textContent = on ? "Eagle connected" : "Eagle closed";
  };
  const eagleTimer = setInterval(pollEagle, 5000);
  pollEagle();

  // ----- probe -----
  async function probe() {
    const url = urlInput.value.trim();
    if (!url) return;
    const id = ++probing;
    info = null;
    addBtn.disabled = true;
    preview.hidden = false;
    preview.className = "preview loading";
    preview.innerHTML = `<div class="thumb"></div><div class="meta"><div class="t">Fetching info</div><div class="c">This takes a few seconds</div></div>`;
    await binariesReady;
    const run = async (cookies: string[]) =>
      invoke<Info>("tool_json", { bin: "yt-dlp.exe", args: ["-J", "--no-warnings", "--encoding", "utf-8", "--flat-playlist", ...(singleVideo(url) ? ["--no-playlist"] : []), ...cookies, url] });
    let result: Info;
    try {
      result = await run(await cookieArgs(SITE));
    } catch (e) {
      if (!isCookieError(String(e))) return id === probing && showError(String(e));
      // Browser cookies unreadable: continue without them and offer the fix.
      markBroken(SITE);
      refreshCookieChip();
      cookiesModal(SITE, String(e)).then((changed) => { if (changed) { refreshCookieChip(); probe(); } });
      try { result = await run([]); } catch (e2) { return id === probing && showError(String(e2)); }
    }
    if (id !== probing) return;
    info = result;
    showInfo(result);
    addBtn.disabled = false;
    renderFormat();
  }

  function showError(msg: string) {
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
    const line = [playlist ? "Playlist" : "", i.channel ?? i.uploader, i.view_count != null ? `${i.view_count.toLocaleString()} views` : "", date]
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

  // ----- add to queue -----
  addBtn.onclick = async () => {
    if (!info) return;
    const cookies = await cookieArgs(SITE);
    const channel = info.channel ?? info.uploader ?? "";
    const job = info._type === "playlist"
      ? { module: "video", title: info.title, pill: PILL[prefs.format], children: (info.entries ?? []).map((e) => videoJob(e, e.channel ?? e.uploader ?? channel, prefs, cookies)) }
      : videoJob(info, channel, prefs, cookies);
    if (job.children && !job.children.length) return banner({ id: "video-empty", tone: "warn", icon: "alert", text: "This playlist has no videos." });
    await addJobs([job]);
    urlInput.value = "";
    preview.hidden = true;
    info = null;
    addBtn.disabled = true;
    urlInput.focus();
  };

  renderFormat();
  mountQueue(page, "video");
  view.append(page);
}
