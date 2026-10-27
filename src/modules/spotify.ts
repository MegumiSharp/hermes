// Spotify module: spotDL finds each Spotify track on YouTube Music and downloads it with the
// Spotify metadata and cover. Preview = `spotdl save` (song list JSON); download = one queue job.
import { invoke } from "@tauri-apps/api/core";
import { binariesReady, toolStatus } from "../binaries";
import { clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue } from "../queue";
import { folderField, paths } from "./common";

type Song = { name: string; artist: string; artists: string[]; album_name: string; duration: number; year?: number; cover_url?: string };
const FORMATS = {
  mp3: { label: "MP3 320 kbps", bitrate: "320k" },
  m4a: { label: "M4A (original, no re-encode)", bitrate: "disable" },
  opus: { label: "Opus (original, no re-encode)", bitrate: "disable" },
} as const;
type Format = keyof typeof FORMATS;
let probing = 0;
let draw: (msg?: string) => void = () => {}; // the list of the Spotify page currently open
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function renderSpotify(view: HTMLElement) {
  const { state, save } = memory("spotify", { url: "", folder: "", format: "mp3" as Format, songs: [] as Song[], listFile: "" });
  clearers.set("spotify", () => { Object.assign(state, { url: "", songs: [], listFile: "" }); save(); });

  const page = h(`<div class="page spotify">
    <div class="head"><div><h3>Spotify</h3><div class="sub">Songs, albums and playlists from Spotify links, matched on YouTube Music</div></div>
      <div class="right"><span class="chip" id="s-tool"><span class="dot"></span>spotDL</span></div></div>
    <form class="url" id="s-form">
      <label class="field">${icon("link")}<input id="s-url" placeholder="Paste a Spotify song, album, playlist or artist link" autocomplete="off" spellcheck="false"></label>
      <button class="btn" id="s-fetch" type="submit">Fetch</button>
    </form>
    <div class="s-list" id="s-list" hidden></div>
    <div class="opts">
      <div class="opt"><span class="field-label">Format</span><select class="select" id="s-format">
        ${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></div>
      <div id="s-dest"></div>
    </div>
    <div class="sub">Audio comes from YouTube Music (about 128-256 kbps); MP3 320 re-encodes it for compatibility, it does not add quality.</div>
    <div class="row2"><button class="btn primary" id="s-add" disabled>${icon("download")}Download</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const url = $<HTMLInputElement>("#s-url");
  const list = $("#s-list");
  const add = $<HTMLButtonElement>("#s-add");
  $("#s-dest").append(folderField(state, save, "s-folder"));
  toolStatus("spotdl").then((s) => {
    $("#s-tool").lastChild!.textContent = s?.ok ? `spotDL ${s.version}` : "spotDL missing";
    $("#s-tool").classList.toggle("bad", !s?.ok);
  });
  const fmt = $<HTMLSelectElement>("#s-format");
  fmt.value = state.format;
  fmt.onchange = () => { state.format = fmt.value as Format; save(); };

  draw = renderList;
  function renderList(msg?: string) {
    list.hidden = !msg && !state.songs.length;
    add.disabled = !state.songs.length || !state.listFile;
    if (msg) { list.className = "s-list msg"; list.textContent = msg; return; }
    const total = state.songs.reduce((a, s) => a + (s.duration || 0), 0);
    list.className = "s-list";
    list.replaceChildren(h(`<div class="s-head"><b>${state.songs.length} song${state.songs.length === 1 ? "" : "s"}</b><span class="sub">${Math.round(total / 60)} min</span></div>`),
      ...state.songs.slice(0, 300).map((s, i) => {
        const r = h(`<div class="s-row"><span class="mono sub">${i + 1}</span><span class="s-t"><b></b><span class="sub"></span></span><span class="mono sub">${mmss(s.duration || 0)}</span></div>`);
        r.querySelector("b")!.textContent = s.name;
        r.querySelector(".s-t .sub")!.textContent = [s.artists?.join(", ") || s.artist, s.album_name, s.year].filter(Boolean).join(" · ");
        return r;
      }),
      ...(state.songs.length > 300 ? [h(`<div class="sub">+${state.songs.length - 300} more</div>`)] : []));
    add.lastChild!.textContent = state.songs.length > 1 ? `Download ${state.songs.length} songs` : "Download";
  }

  async function probe() {
    const u = url.value.trim();
    if (!u) return;
    const id = ++probing;
    Object.assign(state, { url: u, songs: [], listFile: "" });
    save();
    draw("Reading the Spotify link");
    await binariesReady;
    const { data } = await paths;
    const name = `spotify-${Date.now()}.spotdl`;
    await invoke("make_dirs", { paths: [`${data}\\jobs`] });
    try {
      await invoke("tool_text", { bin: "spotdl.exe", args: ["save", u, "--save-file", `${data}\\jobs\\${name}`] });
      const songs = JSON.parse(await invoke<string>("read_job_file", { name })) as Song[];
      if (id !== probing) return;
      Object.assign(state, { songs, listFile: `${data}\\jobs\\${name}` });
      save();
      draw(songs.length ? undefined : "No songs found at this link.");
    } catch (e) {
      if (id === probing) draw(`Could not read this link: ${e}`);
    }
  }
  $<HTMLFormElement>("#s-form").onsubmit = (e) => { e.preventDefault(); probe(); };
  url.addEventListener("paste", () => setTimeout(probe, 0));
  url.addEventListener("input", () => { state.url = url.value; save(true); });

  add.onclick = async () => {
    const f = FORMATS[state.format];
    const title = state.songs.length === 1 ? `${state.songs[0].artist} - ${state.songs[0].name}` : `${state.songs[0].album_name || "Spotify"} · ${state.songs.length} songs`;
    await addJobs([{
      module: "spotify", title, pill: state.format.toUpperCase(),
      steps: [{
        type: "run", label: "Downloading", bin: "spotdl.exe", parser: "spotDl", duration: state.songs.length,
        args: ["download", state.listFile, "--output", `${state.folder}\\{artists} - {title}.{output-ext}`,
          "--format", state.format, "--bitrate", f.bitrate, "--threads", "4", "--print-errors", "--simple-tui"],
      }],
    }]);
  };

  url.value = state.url;
  renderList();
  mountQueue(page, "spotify");
  view.append(page);
}
