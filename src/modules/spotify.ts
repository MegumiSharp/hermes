// Spotify module. Reading a link: `spotdl save` (song list), then `spotdl save --preload` (spotDL's
// YouTube Music pick per song), then Hermes checks every pick (spotify-match.ts) and replaces fan
// uploads (osu!, covers, nightcore...) with the official YouTube Music track. Download: one spotDL
// job on the checked list (spotDL skips its own search when a song has a download_url).
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { binariesReady, toolStatus } from "../binaries";
import { clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue } from "../queue";
import { folderField, liveStatus, paths } from "./common";
import { distrust, META_PRINT, parseMeta, videoId } from "./spotify-match";

type Source = { url: string; title: string; channel: string; status: "ok" | "fixed" | "none"; why?: string };
type Song = {
  name: string; artist: string; artists: string[]; album_name: string; duration: number; year?: number; url: string;
  download_url?: string | null; src?: Source; use?: boolean; // use = download even without a reliable source
};
const FORMATS = {
  opus: { label: "Opus, original YouTube Music audio (no re-encode)", bitrate: "disable" },
  m4a: { label: "M4A, original YouTube Music audio (no re-encode)", bitrate: "disable" },
  mp3: { label: "MP3 320 kbps (re-encoded, for old players)", bitrate: "320k" },
} as const;
type Format = keyof typeof FORMATS;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const cut = (s: string) => (s.length > 70 ? `${s.slice(0, 70)}…` : s);

// module scope: a check started on an earlier visit keeps reporting to the page that is open now
const { state, save } = memory("spotify", { url: "", folder: "", format: "opus" as Format, songs: [] as Song[], listFile: "", checked: false });
const live = liveStatus("spotify-read");
let probing = 0;
let resumed = false; // a check interrupted by closing the app restarts once
let draw = () => {};

async function streamTool(bin: string, args: string[], onLine?: (l: string) => void): Promise<void> {
  await invoke("tool_stream", { id: live.stream(onLine), bin, args });
}

/** yt-dlp metadata of many videos, 10 per call; a failing video doesn't lose the others. */
async function metaOf(urls: string[], progress?: (done: number) => void) {
  const lines: string[] = [];
  for (let i = 0; i < urls.length; i += 10) {
    await streamTool("yt-dlp.exe", ["--skip-download", "--no-warnings", "--ignore-errors", "--print", META_PRINT, ...urls.slice(i, i + 10)], (l) => lines.push(l)).catch(() => {});
    progress?.(Math.min(i + 10, urls.length));
  }
  return parseMeta(lines);
}

/** Official YouTube Music tracks ("Songs" tab) for a song spotDL matched badly. */
async function findOfficial(s: Song): Promise<Source | undefined> {
  const ids: string[] = [];
  const q = encodeURIComponent(`${s.artists?.join(" ") || s.artist} ${s.name}`);
  await streamTool("yt-dlp.exe", ["--flat-playlist", "--no-warnings", "--playlist-end", "5", "--print", "%(id)s", `https://music.youtube.com/search?q=${q}#songs`],
    (l) => /^[\w-]{11}$/.test(l) && ids.push(l)).catch(() => {});
  const meta = await metaOf(ids.map((id) => `https://music.youtube.com/watch?v=${id}`));
  for (const id of ids) {
    const m = meta.get(id);
    if (m && !distrust(s, m)) return { url: `https://music.youtube.com/watch?v=${id}`, title: m.title, channel: m.artist || m.channel, status: "fixed" };
  }
}

async function check(id: number, data: string, list: string) {
  const n = state.songs.length;
  // 1. spotDL's pick per song
  let found = 0;
  live.set(`Finding each song on YouTube Music 0 / ${n}`, 0);
  const pre = `spotify-${Date.now()}-pre.spotdl`;
  await streamTool("spotdl.exe", ["save", list, "--save-file", `${data}\\jobs\\${pre}`, "--preload", "--simple-tui"], (l) => {
    if (/^Found url for |generated an exception/.test(l)) live.set(`Finding each song on YouTube Music ${++found} / ${n}`, found / n / 2);
  });
  if (id !== probing) return;
  const picked = (JSON.parse(await invoke<string>("read_job_file", { name: pre })) as (Song | null)[]).filter(Boolean) as Song[];
  const pick = new Map(picked.map((s) => [s.url, s.download_url]));
  // 2. is each pick trustworthy?
  const urls = state.songs.map((s) => pick.get(s.url)).filter(Boolean) as string[];
  const meta = await metaOf(urls, (done) => live.set(`Checking sources ${done} / ${urls.length}`, 0.5 + (done / Math.max(urls.length, 1)) * 0.3));
  if (id !== probing) return;
  for (const s of state.songs) {
    const url = pick.get(s.url);
    const m = url ? meta.get(videoId(url)) : undefined;
    const why = !url ? "spotDL found nothing" : !m ? "video unavailable" : distrust(s, m);
    s.src = url && m && !why ? { url, title: m.title, channel: m.artist || m.channel, status: "ok" } : { url: url ?? "", title: m?.title ?? "", channel: m?.channel ?? "", status: "none", why: why ?? "" };
  }
  save(); draw();
  // 3. replace bad picks with the official track
  const bad = state.songs.filter((s) => s.src?.status === "none");
  for (const [i, s] of bad.entries()) {
    live.set(`Looking for the official version ${i + 1} / ${bad.length}: ${s.artist} - ${s.name}`, 0.8 + (i / bad.length) * 0.2);
    const better = await findOfficial(s);
    if (id !== probing) return;
    if (better) s.src = { ...better, why: s.src?.why };
    save(); draw();
  }
  state.checked = true;
  save(); draw();
  live.done();
}

async function probe(u: string) {
  const id = ++probing;
  Object.assign(state, { url: u, songs: [], listFile: "", checked: false });
  save(); draw();
  live.set("Reading the Spotify link");
  await binariesReady;
  const { data } = await paths;
  const name = `spotify-${Date.now()}.spotdl`;
  await invoke("make_dirs", { paths: [`${data}\\jobs`] });
  try {
    await streamTool("spotdl.exe", ["save", u, "--save-file", `${data}\\jobs\\${name}`, "--simple-tui"]);
    const songs = (JSON.parse(await invoke<string>("read_job_file", { name })) as (Song | null)[]).filter(Boolean) as Song[];
    if (id !== probing) return;
    Object.assign(state, { songs, listFile: `${data}\\jobs\\${name}` });
    save(); draw();
    if (!songs.length) return live.fail("No songs found at this link.");
    await check(id, data, `${data}\\jobs\\${name}`);
  } catch (e) {
    if (id === probing) live.fail(`Could not read this link: ${e}`);
  }
}

export function renderSpotify(view: HTMLElement) {
  clearers.set("spotify", () => { probing++; live.done(); Object.assign(state, { url: "", songs: [], listFile: "", checked: false }); save(); });

  const page = h(`<div class="page spotify">
    <div class="head"><div><h3>Spotify</h3><div class="sub">Songs, albums and playlists from Spotify links, from official sources only</div></div>
      <div class="right"><span class="chip" id="s-tool"><span class="dot"></span>spotDL</span></div></div>
    <form class="url" id="s-form">
      <label class="field">${icon("link")}<input id="s-url" placeholder="Paste a Spotify song, album, playlist or artist link" autocomplete="off" spellcheck="false"></label>
      <button class="btn" id="s-fetch" type="submit">Fetch</button>
    </form>
    <div id="s-live"></div>
    <div class="s-list" id="s-list" hidden></div>
    <div class="opts">
      <div class="opt"><span class="field-label">Format</span><select class="select" id="s-format">
        ${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></div>
      <div id="s-dest"></div>
    </div>
    <div class="sub" id="s-note"></div>
    <div class="row2"><button class="btn primary" id="s-add" disabled>${icon("download")}Download</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const url = $<HTMLInputElement>("#s-url");
  const list = $("#s-list");
  const add = $<HTMLButtonElement>("#s-add");
  $("#s-live").append(live.el);
  $("#s-dest").append(folderField(state, save, "s-folder"));
  toolStatus("spotdl").then((s) => {
    $("#s-tool").lastChild!.textContent = s?.ok ? `spotDL ${s.version}` : "spotDL missing";
    $("#s-tool").classList.toggle("bad", !s?.ok);
  });
  const fmt = $<HTMLSelectElement>("#s-format");
  if (!(state.format in FORMATS)) state.format = "opus"; // "flac" from an earlier build
  fmt.value = state.format;
  $("#s-note").textContent = "Opus and M4A keep YouTube Music's own audio (about 130-160 kbps, the best YouTube has). Every source is checked: fan uploads, covers and edits are replaced or skipped.";
  fmt.onchange = () => { state.format = fmt.value as Format; save(); };

  const usable = (s: Song) => s.src?.status === "ok" || s.src?.status === "fixed" || (!!s.use && !!s.src?.url);
  draw = () => {
    if (!list.isConnected && !page.isConnected) return;
    list.hidden = !state.songs.length;
    const count = state.songs.filter(usable).length;
    add.disabled = !state.checked || !count;
    const total = state.songs.reduce((a, s) => a + (s.duration || 0), 0);
    const skipped = state.songs.filter((s) => s.src?.status === "none" && !s.use).length;
    list.replaceChildren(h(`<div class="s-head"><b>${state.songs.length} song${state.songs.length === 1 ? "" : "s"}</b><span class="sub">${Math.round(total / 60)} min${state.checked && skipped ? ` · ${skipped} without a reliable source` : ""}</span></div>`),
      ...state.songs.slice(0, 300).map((s, i) => {
        const r = h(`<div class="s-row"><span class="mono sub">${i + 1}</span><span class="s-t"><b></b><span class="sub"></span></span>
          <span class="s-src"></span><span class="mono sub">${mmss(s.duration || 0)}</span></div>`);
        r.querySelector("b")!.textContent = s.name;
        r.querySelector(".s-t .sub")!.textContent = [s.artists?.join(", ") || s.artist, s.album_name, s.year].filter(Boolean).join(" · ");
        const src = r.querySelector<HTMLElement>(".s-src")!;
        if (!s.src) src.append(h(`<span class="chip off"><span class="dot"></span>${state.checked ? "Not checked" : "Checking"}</span>`));
        else {
          const kind = { ok: ["", "Official"], fixed: ["", "Fixed"], none: ["bad", "No reliable source"] }[s.src.status];
          const chip = h(`<button class="chip chip-btn ${kind[0]}" type="button"><span class="dot"></span>${kind[1]}</button>`);
          chip.title = s.src.status === "none"
            ? `spotDL picked ${s.src.title ? `"${cut(s.src.title)}" by ${s.src.channel}` : "nothing"} (${s.src.why}). Skipped unless you choose Use anyway.`
            : `${s.src.status === "fixed" ? `spotDL's pick was rejected (${s.src.why}). Using: ` : ""}"${cut(s.src.title)}" by ${s.src.channel}. Click to open it.`;
          if (s.src.url) chip.onclick = () => openUrl(s.src!.url);
          src.append(chip);
          if (s.src.status === "none" && s.src.url) {
            const b = h(`<button class="btn sm ghost" type="button">${s.use ? "Skip" : "Use anyway"}</button>`);
            b.onclick = () => { s.use = !s.use; save(); draw(); };
            src.append(b);
          }
        }
        return r;
      }),
      ...(state.songs.length > 300 ? [h(`<div class="sub">+${state.songs.length - 300} more</div>`)] : []));
    add.lastChild!.textContent = count > 1 ? `Download ${count} songs` : "Download";
  };

  $<HTMLFormElement>("#s-form").onsubmit = (e) => { e.preventDefault(); if (url.value.trim()) probe(url.value.trim()); };
  url.addEventListener("paste", () => setTimeout(() => url.value.trim() && probe(url.value.trim()), 0));
  url.addEventListener("input", () => { state.url = url.value; save(true); });

  add.onclick = async () => {
    const songs = state.songs.filter(usable);
    const label = (x: Song) => `${x.artist} - ${x.name}`;
    // the checked source of every song goes into the list spotDL downloads from (it skips its own search)
    const name = `spotify-${Date.now()}-checked.spotdl`;
    const listFile = await invoke<string>("write_job_file", { name, text: JSON.stringify(songs.map(({ src, use, ...x }) => ({ ...x, download_url: src!.url }))) });
    await addJobs([{
      module: "spotify", title: songs.length === 1 ? label(songs[0]) : `${songs[0].album_name || "Spotify"} · ${songs.length} songs`, pill: state.format.toUpperCase(),
      steps: [{ type: "run", label: "Downloading", bin: "spotdl.exe", parser: "spotDl", duration: songs.length,
        args: ["download", listFile, "--output", `${state.folder}\\{artists} - {title}.{output-ext}`, "--format", state.format, "--bitrate", FORMATS[state.format].bitrate, "--threads", "4", "--print-errors", "--simple-tui"] }],
    }]);
  };

  url.value = state.url;
  draw();
  if (!resumed && state.url && state.songs.length && !state.checked) probe(state.url);
  resumed = true;
  mountQueue(page, "spotify");
  view.append(page);
}
