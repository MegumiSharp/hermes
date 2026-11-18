// Twitch: VODs, lives from the start (while they are still live), clips and hidden VODs (TwitchTracker,
// StreamsCharts, SullyGnome links) with twitch-dlp, a Node.js script installed on first use (twitch.rs).
// Fast: Twitch serves H.264 + AAC, so the MP4 is Premiere-ready without converting; From/To downloads only
// that part (cut at the nearest ~10 s fragment).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTask } from "../activity";
import { binariesReady } from "../binaries";
import { banner, clearers, h, memory, modal } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue } from "../queue";
import { folderField, liveStatus } from "./common";
import { parseTime, sectionArg, sectionTag, twitchKind } from "./twitch-core";

type Status = { installed: boolean; version: string; node: string; script: string };
type Info = { title: string; channel: string; thumb: string; duration: number; live: boolean; offline: boolean; formats: string[] };

const state = memory("twitch", { url: "", folder: "", quality: "best", from: "", to: "", unmute: "quality", wait: true });
let info: Info | null = null;
let infoUrl = "";
let updateChecked = false;

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s % 60)].map((n, i) => (i ? String(n).padStart(2, "0") : n)).join(":");
const safeName = (t: string) => t.replace(/[\\/:*?"<>|%]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);

/** twitch-dlp + Node.js, installed after asking; twitch-dlp itself is updated quietly once per session. */
async function ready(): Promise<Status | null> {
  let s = await invoke<Status>("twitch_status");
  if (s.installed) {
    if (!updateChecked) {
      updateChecked = true;
      invoke<string>("twitch_latest").then((v) => { if (v && v !== s.version) invoke("twitch_install").catch(() => {}); }).catch(() => {});
    }
    return s;
  }
  const yes = await new Promise<boolean>((done) => modal({
    title: "Install the Twitch downloader?",
    body: `<p>Twitch downloads use <b>twitch-dlp</b>, which runs on <b>Node.js</b>. Hermes downloads both once (about 35 MB) into its own folder; nothing is installed on Windows.</p>`,
    actions: [{ label: "Cancel", run: () => done(false) }, { label: "Install", primary: true, run: () => done(true) }],
    onClose: () => done(false),
  }));
  if (!yes) return null;
  const task = startTask("twitch-install", "Installing the Twitch downloader", "twitch");
  const off = await listen<[string, number, number]>("twitch-progress", ({ payload: [stage, done, total] }) =>
    task.update(total ? done / total : null, `${stage}${total ? ` ${Math.round(done / 1048576)} / ${Math.round(total / 1048576)} MB` : ""}`));
  try {
    s = await invoke<Status>("twitch_install");
    updateChecked = true;
    return s;
  } catch (e) {
    banner({ id: "twitch", tone: "warn", icon: "alert", text: `Installing the Twitch downloader failed: ${esc(String(e))}` });
    return null;
  } finally {
    off();
    task.end();
  }
}

export function renderTwitch(view: HTMLElement) {
  clearers.set("twitch", () => { state.state.url = ""; info = null; state.save(); });
  const p = state.state;
  const page = h(`<div class="page twitch">
    <div class="head">
      <div><h3>Twitch</h3><div class="sub">VODs, lives from the start, clips and hidden VODs. MP4 ready for Premiere, no conversion.</div></div>
      <div class="right"><span class="chip" id="tw-tool"><span class="dot"></span>twitch-dlp</span></div>
    </div>
    <form class="url" id="tw-form">
      <label class="field">${icon("link")}<input id="tw-url" placeholder="twitch.tv/videos/…, a channel (live), a clip or a TwitchTracker link" autocomplete="off" spellcheck="false"></label>
      <button class="btn" id="tw-check" type="submit">Check</button>
    </form>
    <div id="tw-live"></div>
    <div class="preview" id="tw-preview" hidden></div>
    <div class="opts">
      <div class="opt"><span class="field-label">From</span><label class="field" id="tw-from-box">${icon("clock")}<input id="tw-from" placeholder="Start, e.g. 1:25:00 (empty = beginning)" spellcheck="false"></label></div>
      <div class="opt"><span class="field-label">To</span><label class="field" id="tw-to-box">${icon("clock")}<input id="tw-to" placeholder="End, e.g. 1:40:00 (empty = end)" spellcheck="false"></label></div>
    </div>
    <div class="sub" id="tw-range"></div>
    <div class="opts">
      <div class="opt"><span class="field-label">Quality</span><select class="select" id="tw-quality"></select></div>
      <div class="opt"><span class="field-label">Muted parts</span><select class="select" id="tw-unmute">
        <option value="quality">Unmute when the best audio is available</option><option value="any">Unmute with any audio quality</option><option value="off">Leave muted</option></select></div>
    </div>
    <label class="check" id="tw-wait-box" title="Hermes checks every minute and starts the moment the channel goes live, from the start of the stream"><input type="checkbox" id="tw-wait"><span class="box">${icon("check")}</span>If the channel is offline, wait and download when it goes live</label>
    <div class="opts one" id="tw-dest"></div>
    <div class="row2"><button class="btn primary" id="tw-add" disabled>${icon("download")}Download</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const urlInput = $<HTMLInputElement>("#tw-url");
  const from = $<HTMLInputElement>("#tw-from"), to = $<HTMLInputElement>("#tw-to");
  const quality = $<HTMLSelectElement>("#tw-quality"), unmute = $<HTMLSelectElement>("#tw-unmute"), wait = $<HTMLInputElement>("#tw-wait");
  const addBtn = $<HTMLButtonElement>("#tw-add");
  const live = liveStatus("twitch-read");
  $("#tw-live").append(live.el);
  $("#tw-dest").append(folderField(p, () => state.save(), "tw-folder"));

  invoke<Status>("twitch_status").then((s) => {
    $("#tw-tool").lastChild!.textContent = s.installed ? `twitch-dlp ${s.version}` : "twitch-dlp · installs on first use";
  });

  urlInput.value = p.url; from.value = p.from; to.value = p.to; unmute.value = p.unmute; wait.checked = p.wait;
  function renderQuality() {
    const list = info?.formats.length ? info.formats : ["1080p60", "720p60", "480p", "360p", "Audio_Only"];
    const label = (f: string) => (f === "Audio_Only" ? "Audio only" : f.replace(/p(\d+)$/, "p $1 fps"));
    quality.innerHTML = [`<option value="best">Best (source)</option>`, ...list.map((f) => `<option value="${esc(f)}">${esc(label(f))}</option>`)].join("");
    quality.value = list.includes(p.quality) ? p.quality : "best";
  }
  function renderRange() {
    const a = parseTime(from.value), b = parseTime(to.value);
    const bad = a === null || b === null || (a != null && b != null && b <= a);
    $("#tw-from-box").classList.toggle("bad", a === null); $("#tw-to-box").classList.toggle("bad", b === null);
    const len = info?.duration && !info.live ? info.duration : 0;
    $("#tw-range").textContent = bad ? "Times look like 1:25:00, 85:00 or 5100 (seconds); To must be after From."
      : a == null && b == null ? (info?.live ? "Whole stream from its start; it keeps downloading until the stream ends." : "Whole video. Fill From / To to download only a part (cut to the nearest ~10 s).")
      : `Only ${clock(a ?? 0)} to ${b == null ? (len ? clock(len) : "the end") : clock(b)}${b != null || len ? ` (${clock((b ?? len) - (a ?? 0))})` : ""}, cut to the nearest ~10 s.`;
    return !bad;
  }
  function sync() {
    const kind = twitchKind(urlInput.value.trim());
    $("#tw-wait-box").hidden = kind !== "channel";
    addBtn.disabled = !kind || !renderRange();
  }
  function renderPreview() {
    const pv = $("#tw-preview");
    pv.hidden = !info;
    if (!info) return;
    const badge = info.offline ? `<span class="chip">Offline</span>` : info.live ? `<span class="chip bad">LIVE</span>` : "";
    pv.innerHTML = `<div class="thumb">${info.thumb ? `<img src="${esc(info.thumb)}" alt="">` : ""}${info.duration && !info.live ? `<span class="dur">${clock(info.duration)}</span>` : ""}</div>
      <div class="meta"><div class="t">${esc(info.title)}</div><div class="c">${esc(info.channel)}</div><div class="facts">${badge}</div></div>`;
  }

  /** Title, length and qualities (yt-dlp for the metadata, twitch-dlp -F for the formats it can pick). */
  async function check() {
    const url = urlInput.value.trim();
    if (!twitchKind(url)) return;
    const kind = twitchKind(url);
    live.set("Reading the Twitch link");
    await binariesReady;
    try {
      const meta = kind === "tracker" ? null : await invoke<any>("tool_json", { bin: "yt-dlp.exe", args: ["-J", "--no-playlist", "--skip-download", url], id: live.stream() }).catch((e) => {
        if (kind === "channel" && /not currently live|offline/i.test(String(e))) return { offline: true };
        throw e;
      });
      let formats: string[] = [];
      const s = await invoke<Status>("twitch_status");
      if (s.installed && !meta?.offline) {
        const out = await invoke<string>("tool_text", { bin: s.node, args: [s.script, url, "-F"] }).catch(() => "");
        formats = [...out.matchAll(/'(\d+p\d*|Audio_Only)'/g)].map((m) => m[1]).reverse();
      }
      const channel = url.match(/twitch\.tv\/([^/?#]+)/)?.[1] ?? "";
      info = {
        title: meta?.offline ? `${channel} is offline` : meta?.title ?? meta?.description ?? "Hidden VOD",
        channel: meta?.uploader ?? meta?.channel ?? channel,
        thumb: meta?.thumbnail ?? "", duration: Number(meta?.duration) || 0, live: !!meta?.is_live, offline: !!meta?.offline, formats,
      };
      infoUrl = url;
      live.done();
    } catch (e) {
      info = null;
      live.fail(`Could not read this link: ${String(e).replace(/^ERROR: /, "")}`);
    }
    renderPreview();
    renderQuality();
    sync();
  }

  $<HTMLFormElement>("#tw-form").onsubmit = (e) => { e.preventDefault(); check(); };
  urlInput.addEventListener("input", () => { p.url = urlInput.value; state.save(true); if (urlInput.value.trim() !== infoUrl) { info = null; renderPreview(); } sync(); });
  urlInput.addEventListener("change", () => { if (urlInput.value.trim() !== infoUrl) check(); });
  for (const [el, key] of [[from, "from"], [to, "to"]] as const) el.addEventListener("input", () => { p[key] = el.value; state.save(true); sync(); });
  quality.onchange = () => { p.quality = quality.value; state.save(); };
  unmute.onchange = () => { p.unmute = unmute.value; state.save(); };
  wait.onchange = () => { p.wait = wait.checked; state.save(); };

  addBtn.onclick = async () => {
    const url = urlInput.value.trim();
    const kind = twitchKind(url);
    if (!kind || !renderRange()) return;
    const s = await ready();
    if (!s) return;
    $("#tw-tool").lastChild!.textContent = `twitch-dlp ${s.version}`;
    // not checked yet (or checked before twitch-dlp was installed): read title and qualities first
    if (infoUrl !== url || !info?.formats.length) {
      addBtn.disabled = true;
      await check();
      if (!addBtn.isConnected) return;
    }
    await invoke("make_dirs", { paths: [p.folder] });
    const a = parseTime(from.value) ?? undefined, b = parseTime(to.value) ?? undefined;
    const id = url.match(/videos\/(\d+)/)?.[1] ?? url.match(/clip\/([\w-]+)/)?.[1] ?? url.match(/streams?\/(\d+)/)?.[1] ?? "";
    const channel = url.match(/(?:twitch\.tv|twitchtracker\.com|channels|channel)\/([^/?#]+)/)?.[1]?.replace(/^videos$/, "Twitch VOD") ?? "Twitch";
    const base = safeName(info && infoUrl === url && !info.offline ? info.title : kind === "channel" ? `${channel} live ${new Date().toISOString().slice(0, 10)}` : `${channel} ${id}`);
    const output = `${p.folder}\\${base}${id ? ` [${id}]` : ""}${sectionTag(a, b)}.mp4`;
    const args = [s.script, url, "-o", output, "--unmute", p.unmute];
    if (p.quality !== "best") args.push("-f", p.quality);
    if (a != null || b != null) args.push("--download-sections", sectionArg(a, b));
    if (kind === "channel") {
      args.push("--live-from-start");
      if (p.wait) args.push("--retry-streams", "60");
    }
    const waiting = kind === "channel" && p.wait && info?.offline;
    await addJobs([{
      module: "twitch", title: base, pill: kind === "channel" ? "LIVE" : kind === "clip" ? "Clip" : "VOD",
      steps: [{ type: "run", label: waiting ? "Waiting for the stream, then downloading" : "Downloading", bin: s.node, parser: "twitch", args, outputs: [output] }],
    }]);
    banner({ id: "twitch-added", icon: "check", text: kind === "channel" ? "Live download started from the beginning of the stream. It keeps going until the stream ends; stop it any time in the queue." : "Download started in the queue below." });
  };

  renderQuality();
  renderPreview();
  sync();
  if (p.url && !info) check();
  mountQueue(page, "twitch");
  view.append(page);
}
