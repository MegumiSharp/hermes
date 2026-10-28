import "@fontsource-variable/inter";
import "./styles.css";
import "./tooltip";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { icon, IconName } from "./icons";
import { banner, clearers, flushSettings, h, modal, settings, saveSettings, saveSettingsSoon } from "./core";
import { mountBadge, mountTasks, mountToolDots } from "./activity";
import { mountQueue, setModuleNames } from "./queue";
import { exportUsage, startUsageTracking, track } from "./usage";
import { checkForUpdate, startUpdateChecks } from "./update";
import { renderBinaries, startBinaryChecks } from "./binaries";
import { renderVideo } from "./modules/video";
import { renderGallery } from "./modules/gallery";
import { renderRembg } from "./modules/rembg";
import { renderUpscale } from "./modules/upscale";
import { renderSpotify } from "./modules/spotify";
import { renderConverter } from "./modules/converter";
import { renderImgConv } from "./modules/imgconv";
import { renderDocConv } from "./modules/docconv";
import { renderAudible } from "./modules/audible";
import { renderDemucs } from "./modules/demucs";
import { renderWhisper } from "./modules/whisper";
import { renderThumbs } from "./modules/thumbs";

type Info = { about: string; sources?: string[]; formats?: string; engine: string; link?: string };
type Module = {
  id: string;
  name: string;
  icon: IconName;
  section: "tools" | "system";
  render(view: HTMLElement): void;
  info?: Info;
};

// Module registry: the only place that knows about every module.
const modules: Module[] = [
  {
    id: "video", name: "Video Downloader", icon: "download", section: "tools", render: renderVideo,
    info: {
      about: "Downloads videos, playlists and YouTube Mixes, or just the audio. Best quality, 4K, 1440p or 1080p (it tells you the container first), optional conversion to MP4 H.264 for Premiere on your GPU, or MP3 320 kbps with cover.",
      sources: ["YouTube (videos, Shorts, playlists)", "Vimeo", "TikTok", "Instagram", "X / Twitter", "Facebook", "Twitch (VODs, clips)", "Reddit", "SoundCloud", "Dailymotion", "Bilibili", "and 1,800+ more sites"],
      engine: "yt-dlp + FFmpeg", link: "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md",
    },
  },
  {
    id: "spotify", name: "Spotify", icon: "music", section: "tools", render: renderSpotify,
    info: {
      about: "Downloads Spotify songs, albums, playlists and artists with the Spotify title, artist, album, cover and lyrics. Every YouTube Music source is checked: fan uploads, covers and edits are replaced with the official track or skipped.",
      sources: ["open.spotify.com links: track, album, playlist, artist"],
      formats: "Opus or M4A without re-encoding (YouTube Music's own audio, about 130-160 kbps), or MP3 320 kbps.",
      engine: "spotDL + yt-dlp + FFmpeg", link: "https://github.com/spotDL/spotify-downloader",
    },
  },
  {
    id: "gallery", name: "Gallery Downloader", icon: "image", section: "tools", render: renderGallery,
    info: {
      about: "Downloads every image and video of a gallery, profile, post or board, with filters (type, size, resolution, date, title) and file-by-file selection.",
      sources: ["Instagram", "X / Twitter", "Pixiv", "Reddit", "DeviantArt", "ArtStation", "Tumblr", "Pinterest", "Bluesky", "Imgur", "Flickr", "Danbooru / boorus", "Kemono", "Wikipedia / Wikimedia", "and 300+ more sites"],
      engine: "gallery-dl", link: "https://github.com/mikf/gallery-dl/blob/master/docs/supportedsites.md",
    },
  },
  {
    id: "rembg", name: "Background Removal", icon: "scissors", section: "tools", render: renderRembg,
    info: {
      about: "Cuts the subject out of photos (transparent PNG, solid color or cropped). Compare several AI models on the same image and keep the best. Runs on your GPU.",
      formats: "PNG, JPG, WebP, BMP, TIFF in; PNG out. Paste images with Ctrl+V.", engine: "rembg models (BiRefNet, ISNet, U2Net) on ONNX Runtime + DirectML",
    },
  },
  {
    id: "upscale", name: "Image Upscale", icon: "maximize", section: "tools", render: renderUpscale,
    info: {
      about: "Enlarges images 2-4× with AI detail recovery: photo, illustration/anime and fast models. For videos use Video Converter.",
      formats: "PNG, JPG, WebP in; PNG out.", engine: "Real-ESRGAN (ncnn, Vulkan GPU)",
    },
  },
  {
    id: "converter", name: "Video Converter", icon: "film", section: "tools", render: renderConverter,
    info: {
      about: "Converts videos between formats, resizes them up or down (720p to 4K), changes frame rate and quality. Also extracts audio or makes GIFs.",
      formats: "MP4, MKV, MOV, WebM, AVI and more in; MP4 H.264/H.265 (GPU), ProRes 422, WebM VP9, GIF, MP3, WAV out.",
      engine: "FFmpeg (NVENC on NVIDIA GPUs)",
    },
  },
  {
    id: "imgconv", name: "Image Converter", icon: "fileImage", section: "tools", render: renderImgConv,
    info: {
      about: "Changes an image's format or size (never enlarges), or traces it into an SVG vector for logos, icons and drawings. Transparency is kept where the format supports it, otherwise it becomes white.",
      formats: "PNG, JPG, WebP, AVIF, HEIC, BMP, TIFF, GIF, ICO in; PNG, JPG, WebP, AVIF, TIFF, BMP, GIF, ICO (256 × 256) or SVG out.",
      engine: "FFmpeg + vtracer (vector tracing, built in)",
    },
  },
  {
    id: "docconv", name: "Document Converter", icon: "fileText", section: "tools", render: renderDocConv,
    info: {
      about: "Converts documents in every useful direction: Word, OpenDocument and RTF to PDF with the layout kept, PDF to editable Word, to page images or text, Markdown, LaTeX, web pages and e-books between each other, slides and spreadsheets to PDF.",
      formats: "DOCX, ODT, RTF, DOC, PPTX, XLSX, PDF, Markdown, LaTeX, HTML, EPUB, TXT in; PDF, DOCX, ODT, RTF, Markdown, HTML, EPUB, LaTeX, TXT, PNG/JPG pages out.",
      engine: "Pandoc, Tectonic (LaTeX), Poppler, LibreOffice: each downloaded only when a conversion needs it",
    },
  },
  {
    id: "demucs", name: "Stem Separation", icon: "waveform", section: "tools", render: renderDemucs,
    info: {
      about: "Splits a song into vocals, drums, bass and other (or 6 stems with guitar and piano), or simply vocals + instrumental.",
      formats: "MP3, WAV, FLAC, M4A, OGG and video files in; WAV, FLAC or MP3 out.", engine: "Demucs (Meta) on PyTorch CUDA",
    },
  },
  {
    id: "whisper", name: "Subtitles", icon: "captions", section: "tools", render: renderWhisper,
    info: {
      about: "Transcribes speech into subtitles (SRT, VTT) or plain text, in the spoken language or translated to English. Language is detected automatically.",
      formats: "Any video or audio file. Around 100 spoken languages.", engine: "faster-whisper (OpenAI Whisper models) on your GPU",
    },
  },
  {
    id: "audible", name: "Audible", icon: "headphones", section: "tools", render: renderAudible,
    info: {
      about: "Downloads the audiobooks you own as M4B files with chapters and cover, playable in any player. You sign in on Amazon's own page; Hermes never sees your password.",
      sources: ["Audible marketplaces: Italy, US, UK, Germany, France, Spain, Canada, Australia, India, Japan, Brazil"],
      engine: "audible-cli + FFmpeg",
    },
  },
  {
    id: "thumbs", name: "Thumbnail Tester", icon: "monitorPlay", section: "tools", render: renderThumbs,
    info: {
      about: "Previews your thumbnails and titles in a realistic YouTube feed next to real videos of your niche: home grid, search results, up-next sidebar and mobile, dark or light. Size view shows every size YouTube uses; B/W and Squint test legibility.",
      sources: ["Feed videos: a YouTube search of your niche (or a random topic)", "Your channel name and avatar from its link"],
      formats: "PNG, JPG, WebP thumbnails. Paste with Ctrl+V.", engine: "yt-dlp (search and channel info)",
    },
  },
  { id: "downloads", name: "Downloads", icon: "list", section: "system", render: renderDownloads },
  { id: "binaries", name: "Binaries", icon: "layers", section: "system", render: renderBinaries },
  { id: "settings", name: "Settings", icon: "sliders", section: "system", render: renderSettings },
];

setModuleNames((id) => modules.find((m) => m.id === id)?.name ?? id);

/** Everything in one place: background tasks + the queue of every tool. */
function renderDownloads(view: HTMLElement) {
  const page = h(`<div class="page downloads"><div class="head"><div><h3>Downloads</h3>
    <div class="sub">Everything Hermes is downloading or processing, from every tool. Expand an item to see its live console.</div></div></div>
    <div class="tasks queue"></div></div>`);
  mountTasks(page.querySelector(".tasks")!, (id) => modules.find((m) => m.id === id));
  mountQueue(page);
  view.append(page);
}

/** The "Clear" button: empties this tool's queue (except what is running) and its images/results. */
function clearButton(m: Module): HTMLElement {
  const b = h(`<button class="btn sm ghost" title="Remove this tool's finished, failed and waiting items and clear its images">${icon("broom")}Clear</button>`);
  b.onclick = async () => {
    await invoke("queue_clear_module", { module: m.id });
    clearers.get(m.id)?.();
    await flushSettings();
    open(m.id);
  };
  return b;
}

/** The "Info" button every tool shows in its header. */
function infoButton(m: Module): HTMLElement {
  const b = h(`<button class="btn sm ghost info-btn" title="What this tool does">${icon("info")}Info</button>`);
  b.onclick = () => {
    const i = m.info!;
    const body = h(`<div class="info">
      <p class="about"></p>
      ${i.sources ? `<div class="field-label">Downloads from</div><ul class="sources"></ul>` : ""}
      ${i.formats ? `<div class="field-label">Files</div><p class="formats"></p>` : ""}
      <div class="field-label">Powered by</div><p class="engine"></p>
      ${i.link ? `<button class="btn sm" data-link>${icon("link")}Full list of supported sites</button>` : ""}</div>`);
    body.querySelector(".about")!.textContent = i.about;
    body.querySelector(".engine")!.textContent = i.engine;
    if (i.formats) body.querySelector(".formats")!.textContent = i.formats;
    i.sources?.forEach((s) => { const li = document.createElement("li"); li.textContent = s; body.querySelector(".sources")!.append(li); });
    body.querySelector<HTMLButtonElement>("[data-link]")?.addEventListener("click", () => openUrl(i.link!));
    modal({ title: m.name, body });
  };
  return b;
}

const version = await getVersion();

async function renderSettings(view: HTMLElement) {
  const path: string = await invoke("data_path");
  const el = h(`<div class="page">
    <div class="head"><h3>Settings</h3></div>
    <div class="card"><div class="row"><div><div class="k">Version</div><div class="v mono">Hermes ${version}</div></div></div>
    <div class="row"><div><div class="k">Data folder</div><div class="v mono" id="data-path"></div></div><button class="btn sm" id="open-data">${icon("folder")}Open</button></div>
    <div class="row"><div><div class="k">Updates</div><div class="v" id="update-status">Checked automatically on launch and every 6 hours</div></div><button class="btn sm" id="check-update">${icon("refresh")}Check now</button></div></div>
  </div>`);
  const tools = h(`<div class="card" id="tool-toggles"><div class="row"><div><div class="k">Tools</div>
    <div class="sub">Drag a tool by its handle to change the sidebar order (or Alt+↑/↓). Hidden tools keep their settings and queue.</div></div></div></div>`);
  for (const m of ordered().filter((m) => m.section === "tools")) {
    const row = h(`<label class="row tool-row" data-order="${m.id}"><button class="grip" type="button" title="Drag to reorder">${icon("grip")}</button>
      <div class="v"></div><input type="checkbox" class="switch" data-tool="${m.id}"></label>`);
    row.querySelector(".v")!.textContent = m.name;
    const sw = row.querySelector("input")!;
    sw.checked = !hidden().includes(m.id);
    sw.onchange = () => {
      const next = sw.checked ? hidden().filter((x) => x !== m.id) : [...hidden(), m.id];
      if (next.length >= modules.filter((x) => x.section === "tools").length) {
        sw.checked = true; // keep at least one tool
        return;
      }
      saveSettings({ hiddenTools: next });
      renderSidebar();
      refreshDots();
    };
    tools.append(row);
  }
  sortable(tools);
  el.append(tools);
  el.append(usageCard(version));
  const prefs = h(`<div class="card"><label class="row"><div><div class="v">Show system stats in AI tools</div>
    <div class="sub">CPU, RAM, GPU load, VRAM and temperature above Background Removal, Upscale, Stem Separation and Subtitles.</div></div>
    <input type="checkbox" class="switch" id="show-stats"></label></div>`);
  const stats = prefs.querySelector<HTMLInputElement>("#show-stats")!;
  stats.checked = settings.showStats !== false;
  stats.onchange = () => saveSettings({ showStats: stats.checked });
  const par = h(`<div class="row"><div><div class="v">Downloads at the same time</div>
    <div class="sub">How many queue items run in parallel (1-10). Higher is faster but sites rate-limit sooner.</div></div>
    <input type="number" min="1" max="10" class="num" id="max-concurrent"></div>`);
  const max = par.querySelector<HTMLInputElement>("input")!;
  max.value = String(settings.maxConcurrent ?? 6);
  max.onchange = () => {
    const n = Math.min(10, Math.max(1, Math.round(Number(max.value) || 6)));
    max.value = String(n);
    saveSettings({ maxConcurrent: n });
  };
  prefs.append(par);
  el.append(prefs);
  el.querySelector("#data-path")!.textContent = path;
  (el.querySelector("#open-data") as HTMLElement).onclick = () => revealItemInDir(path);
  const status = el.querySelector("#update-status")!;
  const btn = el.querySelector("#check-update") as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true;
    status.textContent = "Checking";
    try {
      const u = await checkForUpdate();
      status.textContent = u ? `Hermes ${u.version} is available` : "You are on the latest version";
    } catch (e) {
      status.textContent = `Check failed: ${e}`;
    }
    btn.disabled = false;
  };
  view.append(el);
}

const hidden = (): string[] => settings.hiddenTools ?? [];
/** Registry order, then the user's own order (Settings, drag a tool); tools added later go last. */
const ordered = () => {
  const order: string[] = settings.toolOrder ?? [];
  const rank = (m: Module) => (order.includes(m.id) ? order.indexOf(m.id) : order.length + modules.indexOf(m));
  return [...modules].sort((a, b) => rank(a) - rank(b));
};
const visible = () => ordered().filter((m) => !hidden().includes(m.id));
let current = "";

function open(id: string) {
  const mod = visible().find((m) => m.id === id) ?? visible()[0];
  current = mod.id;
  document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("on", (n as HTMLElement).dataset.id === mod.id));
  const view = document.getElementById("view")!;
  view.replaceChildren();
  mod.render(view);
  if (mod.info) {
    // modules may render asynchronously: attach once their header exists
    const attach = () => {
      const head = view.querySelector(".page > .head");
      if (!head) return requestAnimationFrame(attach);
      let right = head.querySelector(".right");
      if (!right) head.append((right = h(`<div class="right"></div>`)));
      right.prepend(clearButton(mod), infoButton(mod));
    };
    attach();
  }
  if (settings.lastModule !== mod.id) saveSettings({ lastModule: mod.id });
  track("open", { tool: mod.id });
  refreshDots?.(); // opening a tool marks its finished/failed work as seen
}

// ---------- sidebar ----------
const side = document.getElementById("side")!;
const badge = h(`<span class="nav-badge"></span>`); // running/queued count on "Downloads"
mountBadge(badge);
/** Settings > Usage statistics: local only, exported to a file the owner can pass on. */
function usageCard(version: string): HTMLElement {
  const card = h(`<div class="card" id="usage-card">
    <label class="row"><div><div class="v">Collect usage statistics</div>
      <div class="sub">Which tools you use, how long jobs and waits take, errors and startup time, to make Hermes faster. Stays in hermes-data on this PC; nothing is sent. Never file names, links or titles.</div></div>
      <input type="checkbox" class="switch" id="usage-on"></label>
    <div class="row"><div><div class="k">Recorded</div><div class="v" id="usage-count">…</div></div>
      <div class="right"><button class="btn sm" id="usage-export">${icon("download")}Export…</button><button class="btn sm ghost" id="usage-clear">${icon("trash")}Clear</button></div></div>
  </div>`);
  const count = card.querySelector<HTMLElement>("#usage-count")!;
  const refresh = async () => {
    const ev = await invoke<{ t: number }[]>("usage_read");
    count.textContent = ev.length ? `${ev.length} events since ${new Date(ev[0].t).toLocaleDateString()}` : "Nothing yet";
  };
  const on = card.querySelector<HTMLInputElement>("#usage-on")!;
  on.checked = settings.usageStats !== false;
  on.onchange = () => saveSettings({ usageStats: on.checked });
  card.querySelector<HTMLButtonElement>("#usage-export")!.onclick = async () => {
    const path = await exportUsage(version);
    if (path) banner({ id: "usage", icon: "check", text: "Usage statistics exported. Send the file to whoever is optimizing Hermes." });
  };
  card.querySelector<HTMLButtonElement>("#usage-clear")!.onclick = async () => { await invoke("usage_clear"); refresh(); };
  refresh();
  return card;
}

/** Pointer drag (HTML5 drag events clash with Tauri's file drop) + Alt+↑/↓ on a row's handle. */
function sortable(list: HTMLElement) {
  const rows = () => [...list.querySelectorAll<HTMLElement>(".tool-row")];
  const commit = () => {
    saveSettings({ toolOrder: rows().map((r) => r.dataset.order!) });
    renderSidebar();
    refreshDots();
  };
  list.addEventListener("click", (e) => { if ((e.target as Element).closest(".grip")) e.preventDefault(); }); // the handle is inside the label: don't toggle
  list.addEventListener("pointerdown", (e) => {
    const grip = (e.target as Element).closest<HTMLElement>(".grip");
    if (!grip) return;
    const row = grip.closest<HTMLElement>(".tool-row")!;
    e.preventDefault();
    row.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const over = rows().find((r) => r !== row && ev.clientY > r.getBoundingClientRect().top && ev.clientY < r.getBoundingClientRect().bottom);
      if (!over) return;
      const after = ev.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
      over.insertAdjacentElement(after ? "afterend" : "beforebegin", row);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      row.classList.remove("dragging");
      commit();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  });
  list.addEventListener("keydown", (e) => {
    const grip = (e.target as Element).closest<HTMLElement>(".grip");
    if (!grip || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const row = grip.closest<HTMLElement>(".tool-row")!;
    const sib = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (!sib?.classList.contains("tool-row")) return;
    sib.insertAdjacentElement(e.key === "ArrowUp" ? "beforebegin" : "afterend", row);
    grip.focus();
    commit();
  });
}

function renderSidebar() {
  side.replaceChildren();
  for (const section of ["tools", "system"] as const) {
    side.append(section === "tools" ? h(`<div class="label">Tools</div>`) : h(`<div class="spacer"></div>`));
    for (const m of visible().filter((m) => m.section === section)) {
      const n = h(`<button class="nav ${m.id === current ? "on" : ""}" data-id="${m.id}">${icon(m.icon)}<span>${m.name}</span>${m.section === "tools" ? `<i class="nav-dot"></i>` : ""}</button>`);
      n.onclick = () => open(m.id);
      if (m.id === "downloads") n.append(badge);
      side.append(n);
    }
  }
}
renderSidebar();
const refreshDots = mountToolDots((id) => side.querySelector<HTMLElement>(`.nav[data-id="${id}"] .nav-dot`), () => current);

// ---------- window: title bar + size/position remembered in settings.json (portable) ----------
const win = getCurrentWindow();
document.getElementById("mark")!.innerHTML = icon("feather");
document.getElementById("ver")!.textContent = version;
const wc = (id: string, ic: IconName, fn: () => void) => {
  const b = document.getElementById(id)!;
  b.innerHTML = icon(ic);
  b.onclick = fn;
};
wc("wc-min", "minus", () => win.minimize());
wc("wc-max", "square", () => win.toggleMaximize());
wc("wc-close", "x", async () => {
  await flushSettings();
  win.close();
});

async function restoreWindow() {
  const w = settings.window as { x: number; y: number; width: number; height: number; maximized: boolean } | undefined;
  if (w) {
    // only if the saved spot is still on a connected monitor
    const onScreen = (await availableMonitors()).some((m) =>
      w.x + 100 > m.position.x && w.x < m.position.x + m.size.width - 100 && w.y >= m.position.y - 10 && w.y < m.position.y + m.size.height - 100);
    if (onScreen) {
      await win.setSize(new PhysicalSize(w.width, w.height));
      await win.setPosition(new PhysicalPosition(w.x, w.y));
    }
    if (w.maximized) await win.maximize();
  }
  await win.show();
}
async function rememberWindow() {
  const maximized = await win.isMaximized();
  if (maximized || (await win.isMinimized())) {
    saveSettingsSoon({ window: { ...settings.window, maximized } });
    return;
  }
  const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
  saveSettingsSoon({ window: { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false } });
}
await restoreWindow();
track("launch", { version: await getVersion(), startupMs: await invoke<number>("startup_ms"), pageMs: Math.round(performance.now()) }); // exe start → window shown
startUsageTracking();
win.onResized(rememberWindow);
win.onMoved(rememberWindow);

window.addEventListener("hermes:open", (e) => open((e as CustomEvent<string>).detail));
open(settings.lastModule);
startUpdateChecks();
startBinaryChecks();
