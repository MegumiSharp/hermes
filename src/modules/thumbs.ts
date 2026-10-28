// Thumbnail Tester: your thumbnails and titles in a realistic YouTube feed (home, search, sidebar,
// mobile) next to real videos of your niche, plus a size sheet and legibility checks.
// Feed videos come from `yt-dlp ytsearchN:<topic>`; channel name/avatar from the channel page.
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { binariesReady } from "../binaries";
import { clearers, h, memory } from "../core";
import { icon, IconName } from "../icons";
import { dropZone, liveStatus } from "./common";
import { listen } from "@tauri-apps/api/event";

/** Lines a tool_stream call with id `sid` prints (background work with no visible status). */
const listenLines = (sid: string, on: (l: string) => void) =>
  listen<[string, string]>("tool-line", ({ payload: [id, l] }) => { if (id === sid) on(l); });

type Mine = { id: string; path: string; title: string; duration: string; on: boolean };
type Video = { id: string; title: string; channel: string; channelUrl: string; views: number; duration: number; desc: string; thumb: string; verified: boolean };
type Device = "home" | "search" | "sidebar" | "mobile";

const TOPICS = ["minecraft", "cooking recipes", "tech review", "travel vlog", "fitness workout", "personal finance", "gaming highlights",
  "photography tips", "music production", "anime review", "chess", "car review", "science explained", "history documentary",
  "productivity", "drawing tutorial", "football highlights", "podcast clips", "diy home", "movie analysis", "coding tutorial", "makeup tutorial"];
const DEVICES: [Device, string, IconName][] = [["home", "Home", "monitor"], ["search", "Search", "search"], ["sidebar", "Up next", "panelRight"], ["mobile", "Mobile", "smartphone"]];
// YouTube's own display sizes for a thumbnail (px, 16:9)
const SIZES: [number, string][] = [[640, "TV / large player end screen"], [360, "Home feed (desktop)"], [246, "Search on small windows"], [168, "Up next sidebar"], [120, "Playlists, notifications"]];
const MAX_TITLE = 100; // YouTube's limit
const CUT_TITLE = 60; // beyond this mobile and sidebar usually cut the title

const compact = (n: number) => n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K` : `${n}`;
const clock = (s: number) => {
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.round(s % 60);
  return `${hh ? `${hh}:${String(mm).padStart(2, "0")}` : mm}:${String(ss).padStart(2, "0")}`;
};
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
// flat search results carry no upload date: a stable, plausible age until the real one arrives (fetchDates)
const AGES = ["2 hours ago", "9 hours ago", "1 day ago", "3 days ago", "5 days ago", "1 week ago", "2 weeks ago", "3 weeks ago", "1 month ago", "2 months ago", "5 months ago", "1 year ago"];
const ageOf = (id: string) => AGES[hash(id) % AGES.length];
const since = (ms: number) => {
  const d = (Date.now() - ms) / 1000;
  const [n, unit] = d < 3600 ? [d / 60, "minute"] : d < 86400 ? [d / 3600, "hour"] : d < 7 * 86400 ? [d / 86400, "day"]
    : d < 30 * 86400 ? [d / (7 * 86400), "week"] : d < 365 * 86400 ? [d / (30 * 86400), "month"] : [d / (365 * 86400), "year"];
  const k = Math.max(1, Math.floor(n as number));
  return `${k} ${unit}${k > 1 ? "s" : ""} ago`;
};
const OUTLIER = 3; // views at least 3x the channel's subscribers
type Channel = { url: string; name: string; avatar: string; subs: number };
const avatarSize = (url: string) => url.replace(/=s\d+[^/]*$/, "=s88-c-k-c0x00ffffff-no-rj");
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; // transparent pixel
const shuffled = <T,>(a: T[]) => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

let avatarQueue = Promise.resolve(); // channel pages are fetched one at a time, in the background
let datesQueue = Promise.resolve();
const remember = <T,>(list: T[], item: T, same: (a: T) => boolean, max: number) => [item, ...list.filter((x) => !same(x))].slice(0, max);

// module scope: async work (avatar queue, searches) must keep saving the same object across visits
const { state, save } = memory("thumbs", {
  mine: [] as Mine[], topic: "", videos: [] as Video[], order: [] as number[], slots: [1, 6, 10, 15] as number[],
  channel: { url: "", name: "Your channel", avatar: "", subs: 0 }, views: "12K", age: "1 day ago", desc: "",
  avatars: {} as Record<string, string>, subs: {} as Record<string, number>, dates: {} as Record<string, number>,
  recentChannels: [] as Channel[], recentTopics: [] as string[], outliers: false,
  viewMode: "youtube" as "youtube" | "size", device: "home" as Device, dark: true,
  gray: false, blur: false, watched: false, highlight: true,
});
let searching = 0;
const live = liveStatus(); // module scope: a search started on an earlier visit reports to the open page

export function renderThumbs(view: HTMLElement) {
  clearers.set("thumbs", () => { Object.assign(state, { mine: [], videos: [], order: [], topic: "" }); save(); });

  const page = h(`<div class="page thumbs">
    <div class="head"><div><h3>Thumbnail Tester</h3><div class="sub">See your thumbnail and title next to real videos, on every device</div></div></div>
    <div class="card th-setup">
      <div class="th-mine"></div>
      <div class="th-meta">
        <div><span class="field-label">Your channel</span>
          <form class="url" id="t-ch-form"><label class="field">${icon("link")}<input id="t-ch" placeholder="Channel link, e.g. youtube.com/@name" spellcheck="false"></label>
          <button class="btn" type="submit" id="t-ch-fetch">Fetch</button></form>
          <div class="th-ch" id="t-ch-card"><img alt=""><div><b></b><div class="sub"></div></div></div>
          <div class="th-recent" id="t-ch-recent"></div></div>
        <div class="opts three">
          <div class="opt"><span class="field-label">Views</span><label class="field"><input id="t-views" placeholder="12K"></label></div>
          <div class="opt"><span class="field-label">Uploaded</span><label class="field"><input id="t-age" placeholder="1 day ago"></label></div>
          <div class="opt"><span class="field-label">Description</span><label class="field" title="Shown under your title in search results"><input id="t-desc" placeholder="Shown in search results"></label></div>
        </div>
        <div><span class="field-label">Videos around yours</span>
          <form class="url" id="t-topic-form"><label class="field">${icon("search")}<input id="t-topic" placeholder="Your niche or a search, e.g. minecraft builds" spellcheck="false"></label>
          <button class="btn" type="submit" id="t-search" title="Search YouTube (Enter)" aria-label="Search">${icon("search")}</button>
          <button class="btn" type="button" id="t-similar" title="Search YouTube with your thumbnail's title: the videos yours competes with">${icon("copy")}Find similar</button>
          <button class="btn" type="button" id="t-dice" title="Random topic">${icon("dice")}</button></form>
          <div class="th-recent" id="t-topic-recent"></div>
          <div id="t-status"></div></div>
      </div>
    </div>
    <div class="th-bar">
      <div class="seg" id="t-mode"><button data-mode="youtube">${icon("monitorPlay")}YouTube view</button><button data-mode="size">${icon("ruler")}Size view</button></div>
      <div class="seg" id="t-device">${DEVICES.map(([id, label, ic]) => `<button data-device="${id}" title="${label}">${icon(ic)}${label}</button>`).join("")}</div>
      <div class="seg" id="t-checks">
        <button data-check="dark" title="Dark theme">${icon("moon")}Dark</button>
        <button data-check="highlight" title="Outline your videos">${icon("eye")}Mine</button>
        <button data-check="gray" title="Grayscale: does it still read without color?">B/W</button>
        <button data-check="blur" title="Squint test: is it readable at a glance?">Squint</button>
        <button data-check="watched" title="Red 'watched' bar over other videos">Watched</button>
        <button data-check="outliers" title="Views divided by the channel's subscribers. x3 or more = a video doing far better than its channel">Outliers</button>
      </div>
      <div class="right">
        <button class="btn sm" id="t-shuffle" title="Shuffle positions">${icon("shuffle")}Shuffle</button>
        <button class="btn sm" id="t-reset" title="Default positions">${icon("retry")}Reset</button>
      </div>
    </div>
    <div class="th-stage" id="t-stage"></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const stage = $("#t-stage");
  $("#t-status").append(live.el);

  // ----- your thumbnails -----
  const mineEl = page.querySelector<HTMLElement>(".th-mine")!;
  const zone = dropZone({ id: "t-drop", label: "Drop thumbnails (16:9, 1280×720 or larger)", exts: ["png", "jpg", "jpeg", "webp"], multiple: true, paste: true }, (paths) => {
    const base = state.mine.at(-1)?.title ?? "";
    state.mine.push(...paths.map((path) => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, path, title: base, duration: "12:34", on: true })));
    save(); renderMine(); renderStage();
  });
  function renderSimilar() {
    const b = page.querySelector<HTMLButtonElement>("#t-similar");
    if (b) b.disabled = !state.mine.some((m) => m.on && m.title.trim());
  }
  function renderMine() {
    renderSimilar();
    mineEl.replaceChildren(...state.mine.map((m, i) => {
      const len = m.title.length;
      const r = h(`<div class="th-item ${m.on ? "" : "off"}" data-mine="${m.id}">
        <div class="th-img"><img alt=""><span class="th-letter">${String.fromCharCode(65 + i)}</span></div>
        <div class="th-fields">
          <label class="field"><input data-f="title" placeholder="Name it… (your video title)" maxlength="${MAX_TITLE}"></label>
          <div class="th-row"><label class="field th-dur"><input data-f="duration" placeholder="12:34"></label>
            <span class="sub th-len ${len > CUT_TITLE ? "warn" : ""}">${len}/${MAX_TITLE}${len > CUT_TITLE ? " · may be cut on mobile" : ""}</span>
            <span class="th-warn sub"></span>
            <button class="btn sm ghost" data-toggle title="${m.on ? "Hide from the feed" : "Show in the feed"}">${icon("eye")}${m.on ? "Shown" : "Hidden"}</button>
            <button class="btn sm ghost" data-remove title="Remove">${icon("trash")}</button></div>
        </div></div>`);
      const img = r.querySelector("img")!;
      img.src = convertFileSrc(m.path);
      img.onload = () => { // YouTube recommends 1280×720 and 16:9
        const w = img.naturalWidth, hh = img.naturalHeight;
        const issues = [w < 1280 ? `${w}×${hh}, use 1280×720 or more` : "", Math.abs(w / hh - 16 / 9) > 0.02 ? "not 16:9, YouTube adds bars" : ""].filter(Boolean);
        r.querySelector(".th-warn")!.textContent = issues.join(" · ");
      };
      r.querySelector<HTMLInputElement>('[data-f="title"]')!.value = m.title;
      r.querySelector<HTMLInputElement>('[data-f="duration"]')!.value = m.duration;
      return r;
    }), zone);
  }
  mineEl.addEventListener("input", (e) => {
    const inp = e.target as HTMLInputElement;
    const m = state.mine.find((x) => x.id === inp.closest<HTMLElement>("[data-mine]")?.dataset.mine);
    if (!m || !inp.dataset.f) return;
    (m as any)[inp.dataset.f] = inp.value;
    save(true);
    const len = inp.closest(".th-item")!.querySelector(".th-len");
    if (inp.dataset.f === "title" && len) {
      len.textContent = `${m.title.length}/${MAX_TITLE}${m.title.length > CUT_TITLE ? " · may be cut on mobile" : ""}`;
      len.classList.toggle("warn", m.title.length > CUT_TITLE);
    }
    renderStage();
    renderSimilar();
  });
  mineEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-toggle], [data-remove]");
    const id = b?.closest<HTMLElement>("[data-mine]")?.dataset.mine;
    if (!b || !id) return;
    if (b.hasAttribute("data-remove")) state.mine = state.mine.filter((m) => m.id !== id);
    else { const m = state.mine.find((x) => x.id === id)!; m.on = !m.on; }
    save(); renderMine(); renderStage();
  });

  // ----- channel -----
  const ch = $<HTMLInputElement>("#t-ch");
  ch.oninput = () => { state.channel.url = ch.value; save(true); };
  function renderChannel() {
    const c = state.channel;
    const card = $("#t-ch-card");
    card.hidden = !c.avatar && c.name === "Your channel";
    card.querySelector("img")!.src = c.avatar || "";
    card.querySelector("b")!.textContent = c.name;
    card.querySelector(".sub")!.textContent = c.subs ? `${compact(c.subs)} subscribers` : "";
  }
  $<HTMLFormElement>("#t-ch-form").onsubmit = async (e) => {
    e.preventDefault();
    const u = ch.value.trim();
    if (!u) return;
    const btn = $<HTMLButtonElement>("#t-ch-fetch");
    btn.disabled = true;
    try {
      await binariesReady;
      live.set("Reading the channel");
      const j = await invoke<any>("tool_json", { id: live.stream(), bin: "yt-dlp.exe", args: ["-J", "--no-warnings", "--encoding", "utf-8", "--flat-playlist", "--playlist-items", "0", /^https?:/.test(u) ? u : `https://www.youtube.com/${u.startsWith("@") ? u : `@${u}`}`] });
      const av = (j.thumbnails ?? []).find((t: any) => t.id === "avatar_uncropped")?.url ?? "";
      state.channel = { url: u, name: j.channel || j.uploader || j.title || "Your channel", avatar: av ? avatarSize(av) : "", subs: j.channel_follower_count ?? 0 };
      state.recentChannels = remember(state.recentChannels, { ...state.channel }, (x) => x.url === u, 6);
      live.done();
    } catch (err) {
      live.fail(`Could not read this channel: ${err}`);
    }
    btn.disabled = false;
    save(); renderChannel(); renderRecent(); renderStage();
  };
  /** Last channels and searches as one-click picks: they change rarely. */
  function renderRecent() {
    $("#t-ch-recent").replaceChildren(...state.recentChannels.filter((c) => c.url !== state.channel.url).map((c) => {
      const b = h(`<button class="chip chip-btn" type="button"><img alt=""><span></span></button>`);
      b.querySelector("img")!.src = c.avatar || BLANK;
      b.querySelector("span")!.textContent = c.name;
      b.title = `Use ${c.name}`;
      b.onclick = () => { state.channel = { ...c }; ch.value = c.url; save(); renderChannel(); renderRecent(); renderStage(); };
      return b;
    }));
    $("#t-topic-recent").replaceChildren(...state.recentTopics.filter((t) => t !== state.topic).map((t) => {
      const b = h(`<button class="chip chip-btn" type="button">${icon("search")}<span></span></button>`);
      b.querySelector("span")!.textContent = t;
      b.onclick = () => search(t, true);
      return b;
    }));
  }

  for (const [id, key] of [["#t-views", "views"], ["#t-age", "age"], ["#t-desc", "desc"]] as const) {
    const inp = $<HTMLInputElement>(id);
    inp.value = state[key];
    inp.oninput = () => { state[key] = inp.value; save(true); renderStage(); };
  }

  // ----- videos around yours -----
  const topic = $<HTMLInputElement>("#t-topic");
  async function search(term: string, typed = false) {
    const id = ++searching;
    state.topic = term;
    if (typed) state.recentTopics = remember(state.recentTopics, term, (x) => x === term, 8);
    renderRecent();
    topic.value = term;
    live.set(`Searching YouTube for "${term}"`);
    $<HTMLButtonElement>("#t-search").disabled = true;
    try {
      await binariesReady;
      const j = await invoke<any>("tool_json", { bin: "yt-dlp.exe", args: ["-J", "--no-warnings", "--encoding", "utf-8", "--flat-playlist", `ytsearch30:${term}`], id: live.stream() });
      if (id !== searching) return;
      const videos: Video[] = (j.entries ?? []).filter((e: any) => e.id && e.duration && e.thumbnails?.length).slice(0, 24).map((e: any) => ({
        id: e.id, title: e.title ?? "", channel: e.channel ?? e.uploader ?? "", channelUrl: e.channel_url ?? e.uploader_url ?? "",
        views: e.view_count ?? 0, duration: e.duration, desc: e.description ?? "", thumb: e.thumbnails.at(-1).url, verified: !!e.channel_is_verified,
      }));
      Object.assign(state, { videos, order: videos.map((_, i) => i) });
      if (videos.length) live.done(); else live.fail("No videos found, try another search.");
      save(); renderStage(); fetchAvatars(); fetchDates();
    } catch (err) {
      if (id === searching) live.fail(`Search failed: ${err}`);
    } finally {
      if (id === searching) $<HTMLButtonElement>("#t-search").disabled = false;
    }
  }
  const randomTopic = () => search(shuffled(TOPICS.filter((t) => t !== state.topic))[0]);
  $<HTMLFormElement>("#t-topic-form").onsubmit = (e) => { e.preventDefault(); if (topic.value.trim()) search(topic.value.trim(), true); else randomTopic(); };
  $("#t-similar").onclick = () => {
    const title = state.mine.find((m) => m.on && m.title.trim())?.title.trim();
    if (title) search(title, true);
  };
  $("#t-dice").onclick = randomTopic;

  /** Real channel avatars for the feed, fetched progressively and remembered. */
  function fetchAvatars() {
    const missing = [...new Set(state.videos.map((v) => v.channelUrl))].filter((u) => u && !(u in state.avatars));
    for (const u of missing) {
      avatarQueue = avatarQueue.then(async () => {
        if (u in state.avatars) return;
        try {
          const j = await invoke<any>("tool_json", { bin: "yt-dlp.exe", args: ["-J", "--no-warnings", "--flat-playlist", "--playlist-items", "0", u] });
          const av = (j.thumbnails ?? []).find((t: any) => t.id === "avatar_uncropped")?.url;
          state.avatars[u] = av ? avatarSize(av) : "";
          if (j.channel_follower_count) state.subs[u] = j.channel_follower_count;
        } catch { state.avatars[u] = ""; }
        save(true);
        if (state.outliers) renderStage();
        document.querySelectorAll<HTMLImageElement>(`.yt-av[data-ch="${CSS.escape(u)}"]`).forEach((img) => { if (state.avatars[u]) img.src = state.avatars[u]; });
      });
    }
  }

  /** Real upload dates, 10 videos per yt-dlp call, in the background; remembered per video. */
  function fetchDates() {
    const missing = state.videos.map((v) => v.id).filter((id) => !(id in state.dates));
    for (let i = 0; i < missing.length; i += 10) {
      const ids = missing.slice(i, i + 10);
      datesQueue = datesQueue.then(async () => {
        if (!ids.some((x) => state.videos.some((v) => v.id === x))) return; // that feed was replaced meanwhile
        const lines: string[] = [];
        const sid = `dates-${ids[0]}`;
        const off = await listenLines(sid, (l) => lines.push(l));
        await invoke("tool_stream", { id: sid, bin: "yt-dlp.exe", args: ["--skip-download", "--no-warnings", "--ignore-errors", "--print", "%(id)s\t%(timestamp)s\t%(upload_date)s",
          ...ids.map((x) => `https://www.youtube.com/watch?v=${x}`)] }).catch(() => {});
        off();
        for (const l of lines) {
          const [vid, ts, day] = l.split("\t");
          if (!ids.includes(vid)) continue;
          state.dates[vid] = Number(ts) > 0 ? Number(ts) * 1000 : /^\d{8}$/.test(day ?? "") ? Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) : 0;
        }
        for (const x of ids) state.dates[x] ??= 0; // unavailable: keep the estimate, don't ask again
        save(true);
        renderStage();
      });
    }
  }

  // ----- toolbar -----
  function renderBar() {
    page.querySelectorAll<HTMLElement>("#t-mode [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.viewMode));
    page.querySelectorAll<HTMLElement>("#t-device [data-device]").forEach((b) => b.classList.toggle("on", b.dataset.device === state.device));
    $("#t-device").hidden = state.viewMode !== "youtube";
    page.querySelectorAll<HTMLElement>("#t-checks [data-check]").forEach((b) => b.classList.toggle("on", !!(state as any)[b.dataset.check!]));
  }
  page.querySelector(".th-bar")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.mode) state.viewMode = b.dataset.mode as any;
    else if (b.dataset.device) state.device = b.dataset.device as Device;
    else if (b.dataset.check) (state as any)[b.dataset.check] = !(state as any)[b.dataset.check];
    else if (b.id === "t-shuffle") {
      state.order = shuffled(state.videos.map((_, i) => i));
      const n = state.videos.length + state.mine.length;
      state.slots = shuffled([...Array(Math.max(n, 4)).keys()]).slice(0, 4).sort((a, z) => a - z);
    } else if (b.id === "t-reset") Object.assign(state, { order: state.videos.map((_, i) => i), slots: [1, 6, 10, 15] });
    else return;
    save(); renderBar(); renderStage();
  });

  // ----- the feed -----
  type Card = { mine: boolean; thumb: string; title: string; channel: string; chUrl: string; avatar: string; meta: string; views: string; age: string; dur: string; desc: string; verified: boolean; watched: number; score?: number };
  function cards(): Card[] {
    const c = state.channel;
    const others: Card[] = state.order.map((i) => state.videos[i]).filter(Boolean).map((v) => ({
      mine: false, thumb: v.thumb, title: v.title, channel: v.channel, chUrl: v.channelUrl, avatar: state.avatars[v.channelUrl] ?? "",
      meta: "", views: `${compact(v.views)} views`, age: state.dates[v.id] ? since(state.dates[v.id]) : ageOf(v.id), dur: clock(v.duration), desc: v.desc, verified: v.verified,
      watched: state.watched && hash(v.id) % 4 === 0 ? 20 + (hash(v.id) % 70) : 0,
      score: state.subs[v.channelUrl] ? v.views / state.subs[v.channelUrl] : undefined,
    }));
    const mine: Card[] = state.mine.filter((m) => m.on).map((m) => ({
      mine: true, thumb: convertFileSrc(m.path), title: m.title || "Your video title", channel: c.name, chUrl: "", avatar: c.avatar,
      meta: "", views: `${state.views || "0"} views`, age: state.age, dur: m.duration, desc: state.desc, verified: false, watched: 0,
    }));
    const out = [...others];
    mine.forEach((m, i) => out.splice(Math.min(state.slots[i % state.slots.length] + Math.floor(i / state.slots.length) * 4, out.length), 0, m));
    return out;
  }
  function cardEl(c: Card, kind: Device): HTMLElement {
    const scored = state.outliers && !c.mine && c.score !== undefined;
    const hot = scored && c.score! >= OUTLIER;
    const el = h(`<div class="yt-card ${c.mine ? "mine" : ""} ${state.outliers && !c.mine && !hot ? "dim" : ""}">
      <div class="yt-thumb"><img alt="" loading="lazy" referrerpolicy="no-referrer"><span class="yt-dur"></span>${scored ? `<span class="yt-score ${hot ? "hot" : ""}">×${c.score! >= 10 ? Math.round(c.score!) : c.score!.toFixed(1)}</span>` : ""}${c.watched ? `<i class="yt-watched" style="width:${c.watched}%"></i>` : ""}</div>
      <div class="yt-info">${kind === "search" ? "" : `<img class="yt-av" alt="" referrerpolicy="no-referrer">`}
        <div class="yt-text"><div class="yt-title"></div>
          ${kind === "search" ? `<div class="yt-meta"></div><div class="yt-chrow"><img class="yt-av" alt="" referrerpolicy="no-referrer"><span class="yt-ch"></span></div><div class="yt-desc"></div>`
            : `<div class="yt-ch"></div><div class="yt-meta"></div>`}</div></div></div>`);
    el.querySelector<HTMLImageElement>(".yt-thumb img")!.src = c.thumb;
    el.querySelector(".yt-dur")!.textContent = c.dur;
    el.querySelector(".yt-title")!.textContent = c.title;
    el.querySelector(".yt-ch")!.textContent = c.channel;
    if (c.verified) el.querySelector(".yt-ch")!.insertAdjacentHTML("beforeend", `<svg class="yt-check" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.7 14.3-4-4 1.4-1.4 2.6 2.6 6-6 1.4 1.4Z"/></svg>`);
    el.querySelector(".yt-meta")!.textContent = kind === "mobile" ? `${c.channel} · ${c.views} · ${c.age}` : `${c.views} • ${c.age}`;
    if (kind === "mobile") el.querySelector(".yt-ch")!.remove();
    if (kind === "sidebar") el.querySelector(".yt-av")?.remove();
    const desc = el.querySelector(".yt-desc");
    if (desc) desc.textContent = c.desc;
    const av = el.querySelector<HTMLImageElement>(".yt-av");
    if (av) {
      av.dataset.ch = c.chUrl;
      av.src = c.avatar || BLANK;
    }
    return el;
  }
  function renderStage() {
    stage.className = `th-stage ${state.dark ? "yt-dark" : "yt-light"} ${state.gray ? "gray" : ""} ${state.blur ? "blur" : ""} ${state.highlight ? "hl" : ""}`;
    if (state.viewMode === "size") return renderSizes();
    const list = cards();
    if (!list.length) {
      stage.replaceChildren(h(`<div class="th-empty">${icon("monitorPlay")}<div>Add your thumbnails above, then search your niche or roll the dice for videos to compare against.</div></div>`));
      return;
    }
    const d = state.device;
    const limit = { home: 16, search: 8, sidebar: 12, mobile: 8 }[d];
    const feed = h(`<div class="yt-feed yt-${d}"></div>`);
    feed.append(...list.slice(0, limit).map((c) => cardEl(c, d)));
    stage.replaceChildren(d === "mobile" ? (() => { const phone = h(`<div class="yt-phone"></div>`); phone.append(feed); return phone; })() : feed);
  }
  function renderSizes() {
    const mine = state.mine.filter((m) => m.on);
    if (!mine.length) {
      stage.replaceChildren(h(`<div class="th-empty">${icon("ruler")}<div>Add a thumbnail to see it at every size YouTube shows it.</div></div>`));
      return;
    }
    stage.replaceChildren(...mine.map((m) => {
      const row = h(`<div class="th-sizes"><div class="th-sizes-title"></div><div class="th-sizes-row"></div></div>`);
      row.querySelector(".th-sizes-title")!.textContent = m.title || "Untitled";
      row.querySelector(".th-sizes-row")!.append(...SIZES.map(([w, label]) => {
        const s = h(`<div class="th-size"><div class="yt-thumb" style="width:${w}px"><img alt=""><span class="yt-dur"></span></div><div class="sub"><b>${w}×${Math.round((w * 9) / 16)}</b> ${label}</div></div>`);
        s.querySelector("img")!.src = convertFileSrc(m.path);
        s.querySelector(".yt-dur")!.textContent = m.duration;
        return s;
      }));
      return row;
    }));
  }
  // a missing or broken avatar becomes a plain grey circle
  stage.addEventListener("error", (e) => { const t = e.target as HTMLElement; if (t instanceof HTMLImageElement && t.classList.contains("yt-av") && t.src !== BLANK) t.src = BLANK; }, true);

  ch.value = state.channel.url;
  topic.value = state.topic;
  renderMine(); renderChannel(); renderRecent(); renderBar(); renderStage();
  view.append(page);
  // example videos right away: your last search, or a random topic the first time
  if (!state.videos.length) { if (state.topic) search(state.topic); else randomTopic(); }
  else { fetchAvatars(); fetchDates(); }
}
