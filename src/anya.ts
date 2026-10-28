// Anya, the companion: a pose PNG in the sidebar corner (or the window corner) that wobbles, squishes
// while she talks (voice.mp3), changes pose with the open page, goes idle "working" on something,
// reacts to finished/failed jobs and says tips or game quotes (cited, then her own comment).
// settings.anya = Prefs. `startAnya()` once, `anyaPage(id)` on every page switch, `anyaCard()` in Settings.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { h, navigate, settings, saveSettingsSoon } from "./core";
import { icon } from "./icons";
import * as T from "./anya-lines";
import voiceUrl from "./assets/anya/voice.mp3";

export type Prefs = {
  on: boolean; voice: boolean; volume: number; size: number;
  position: "sidebar" | "corner"; wobble: "off" | "gentle" | "lively"; chat: "quiet" | "normal" | "chatty";
};
export const DEFAULT_PREFS: Prefs = { on: true, voice: true, volume: 30, size: 100, position: "sidebar", wobble: "gentle", chat: "normal" };
const prefs = (): Prefs => ({ ...DEFAULT_PREFS, ...settings.anya });
const setPrefs = (patch: Partial<Prefs>) => { settings.anya = { ...prefs(), ...patch }; saveSettingsSoon({ anya: settings.anya }); apply(); };

const URLS = import.meta.glob("./assets/anya/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const poseUrl = (p: string) => URLS[`./assets/anya/${p}.png`] ?? URLS["./assets/anya/front.png"];
export const faceUrl = poseUrl("face");

const IDLE_AFTER = 3 * 60_000;
const CHAT_EVERY = { quiet: Infinity, normal: 90_000, chatty: 35_000 };
let page = "", idle = false, hushedUntil = 0, lastAct = Date.now(), lastSaid = "";
const pick = <V>(a: V[]): V => { let x: V; do x = a[Math.floor(Math.random() * a.length)]; while (a.length > 1 && x === lastSaid); return x; };

let root: HTMLElement, img: HTMLImageElement, bubble: HTMLElement, voice: HTMLAudioElement;

function apply() {
  const p = prefs();
  root.hidden = !p.on;
  document.body.dataset.anya = p.on ? p.position : "off"; // sidebar: the sidebar keeps a corner free for her
  root.dataset.wobble = p.wobble;
  document.documentElement.style.setProperty("--anya-scale", String(p.size / 100));
  if (!p.on) bubble.classList.remove("show");
}

function setPose(p: string) {
  if (img.dataset.pose === p) return;
  img.dataset.pose = p;
  img.src = poseUrl(p);
  root.classList.remove("pop"); void root.offsetWidth; root.classList.add("pop");
}
const restPose = () => T.POSE[page] ?? "front";

// ---------- talking ----------
let timer = 0, hideTimer = 0;
type Part = { text: string; cls?: string };
/** Types the parts one after another (a quote, its source, then her comment), with the voice and the squish. */
function say(parts: Part[], tag = "") {
  if (!prefs().on) return;
  lastSaid = parts.map((p) => p.text).join(" ");
  clearTimeout(hideTimer); clearInterval(timer);
  wake();
  bubble.querySelector(".tag")!.textContent = tag;
  const box = bubble.querySelector<HTMLElement>(".text")!;
  box.replaceChildren();
  bubble.classList.add("show");
  root.classList.add("talking");
  const p = prefs();
  if (p.voice) { voice.volume = p.volume / 100; voice.currentTime = 0; voice.play().catch(() => {}); }
  const caret = h(`<span class="caret"></span>`);
  let i = 0, n = 0, wait = 0, el: HTMLElement | null = null;
  timer = window.setInterval(() => {
    if (wait > 0) return void wait--;
    const part = parts[i];
    if (!el) { el = h(`<span class="${part.cls ?? ""}"></span>`); box.append(el); }
    n += 1 + Number(Math.random() < 0.3);
    el.textContent = part.text.slice(0, n);
    el.after(caret);
    if (n < part.text.length) return;
    i++; n = 0; el = null;
    if (i < parts.length) { wait = parts[i].cls === "said" ? 18 : 4; return; } // a beat before her own comment
    clearInterval(timer);
    caret.remove();
    root.classList.remove("talking");
    voice.pause();
    hideTimer = window.setTimeout(() => bubble.classList.remove("show"), 3000 + lastSaid.length * 55);
  }, 28);
}
const plain = (text: string, tag = "") => say([{ text }], tag);
function quote(context?: string) {
  const q = pick(T.QUOTES);
  // her comment: the quote's own follow-up, or now and then a tip for the page you're on
  const tip = context && T.TOOL[context] && Math.random() < 0.25 ? pick(T.TOOL[context]) : pick(q.then);
  say([{ text: `"${q.q}"`, cls: "quote" }, { text: q.src, cls: "src" }, { text: tip, cls: "said" }], "quote");
}
function line(kind: "tool" | "done" | "failed" | "empty" | "random" | "hello") {
  const twist = T.TWISTS[kind === "tool" ? page : kind];
  if (twist && Math.random() < 0.2) return plain(pick(twist));
  const list = { tool: T.TOOL[page] ?? T.RANDOM, done: T.DONE, failed: T.FAILED, empty: T.EMPTY, random: T.RANDOM, hello: T.HELLO }[kind];
  plain(pick(list), kind === "tool" ? pageName() : "");
}
const pageName = () => document.querySelector(`.nav[data-id="${page}"] span`)?.textContent?.toLowerCase() ?? "";

// ---------- idle ----------
function wake() {
  lastAct = Date.now();
  if (!idle) return;
  idle = false;
  root.classList.remove("idle");
  setPose(restPose());
}
function goIdle() {
  if (idle || bubble.classList.contains("show")) return;
  const [p, what] = pick(T.IDLE);
  idle = true;
  setPose(p);
  root.querySelector(".busy")!.innerHTML = `${what}<b>...</b>`;
  root.classList.add("idle");
}

// ---------- menu ----------
function menu(x: number, y: number) {
  document.querySelector(".anya-menu")?.remove();
  const hushed = Date.now() < hushedUntil;
  const items: ([string, () => void] | null)[] = [
    ["Say something", () => line("tool")],
    ["Game quote", () => quote(page)],
    null,
    [hushed ? "Chat again" : "Hush for an hour", () => { hushedUntil = hushed ? 0 : Date.now() + 3600_000; plain(pick(hushed ? T.UNHUSH : T.HUSH)); }],
    [prefs().voice ? "Mute her voice" : "Unmute her voice", () => setPrefs({ voice: !prefs().voice })],
    ["Anya settings", () => navigate("settings")],
    ["Hide Anya", () => setPrefs({ on: false })],
  ];
  const m = h(`<div class="anya-menu" role="menu"></div>`);
  for (const it of items) {
    if (!it) { m.append(h(`<div class="sep"></div>`)); continue; }
    const b = h(`<button role="menuitem"></button>`) as HTMLButtonElement;
    b.textContent = it[0];
    b.onclick = () => { m.remove(); it[1](); };
    m.append(b);
  }
  document.body.append(m);
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
  setTimeout(() => addEventListener("pointerdown", (e) => { if (!m.contains(e.target as Node)) m.remove(); }, { once: true }));
}

// ---------- jobs: react when something finishes or fails ----------
type Job = { id: string; state: string; parent?: string | null };
async function watchJobs() {
  const seen = new Map<string, string>();
  const take = (jobs: Job[], react: boolean) => {
    let done = 0, failed = 0;
    for (const j of jobs) {
      if (j.parent) continue; // a playlist reacts once, as a group
      const before = seen.get(j.id);
      if (react && before && before !== j.state) { if (j.state === "done") done++; if (j.state === "failed") failed++; }
      seen.set(j.id, j.state);
    }
    if (failed) { setPose(restPose()); line("failed"); }
    else if (done) {
      setPose("donation");
      setTimeout(() => !idle && setPose(restPose()), 4000);
      const busy = jobs.some((j) => ["queued", "running", "waitingEagle"].includes(j.state));
      line(busy ? "done" : Math.random() < 0.5 ? "empty" : "done");
    }
  };
  take(((await invoke("queue_get")) as { jobs: Job[] }).jobs, false);
  listen<{ jobs: Job[] }>("queue", ({ payload }) => take(payload.jobs, true));
}

// ---------- public ----------
export function startAnya() {
  root = h(`<div class="anya" aria-label="Anya">
    <div class="stage" title="Anya: click to talk, right-click for options"><div class="shadow"></div>
      <div class="wobble"><div class="squish"><img class="pose" alt="" draggable="false"></div></div></div>
    <div class="busy"></div></div>`);
  bubble = h(`<div class="anya-bubble" role="status" aria-live="polite"><div class="who">ANYA<span class="tag"></span></div><div class="text"></div></div>`);
  img = root.querySelector("img")!;
  voice = new Audio(voiceUrl);
  document.body.append(root, bubble);
  Object.keys(T.POSE).concat(T.IDLE.map((i) => i[0]), ["front", "donation"]).forEach((p) => (new Image().src = poseUrl(p))); // no flash on switch
  const stage = root.querySelector<HTMLElement>(".stage")!;
  stage.onclick = () => {
    if (idle) { wake(); return Math.random() < 0.4 ? plain(pick(T.IDLE_BACK)) : line("tool"); }
    root.classList.remove("poke"); void root.offsetWidth; root.classList.add("poke");
    const r = Math.random();
    r < 0.25 ? plain(pick(T.POKE)) : r < 0.6 ? line("tool") : quote(page);
  };
  stage.oncontextmenu = (e) => { e.preventDefault(); menu(e.clientX, e.clientY); };
  bubble.onclick = () => bubble.classList.remove("show");
  addEventListener("pointerdown", () => (lastAct = Date.now()), true);
  addEventListener("keydown", () => (lastAct = Date.now()), true);
  setInterval(() => {
    const p = prefs();
    if (!p.on || document.hidden) return;
    const quiet = Date.now() - lastAct;
    if (!idle && quiet > IDLE_AFTER) return goIdle();
    // talks on her own only now and then, never while hushed, and only after a quiet stretch
    if (!idle && Date.now() > hushedUntil && quiet > CHAT_EVERY[p.chat] && !bubble.classList.contains("show") && Math.random() < 0.4) {
      Math.random() < 0.45 ? quote(page) : line(Math.random() < 0.5 ? "tool" : "random");
      lastAct = Date.now();
    }
  }, 5000);
  apply();
  setPose("front");
  watchJobs();
  setTimeout(() => line("hello"), 1200);
}

export function anyaPage(id: string) {
  const first = !page;
  page = id;
  wake();
  setPose(restPose());
  // now and then a tip for the tool you just opened (helpful, not clingy)
  if (!first && Math.random() < 0.3 && Date.now() > hushedUntil && !bubble.classList.contains("show")) setTimeout(() => line("tool"), 600);
}

/** Settings card: on/off, voice, volume, size, position, wobble, chattiness. */
export function anyaCard(): HTMLElement {
  const p = prefs();
  const seg = (id: string, cur: string, opts: [string, string][]) =>
    `<div class="seg" id="${id}">${opts.map(([v, t]) => `<button data-v="${v}" class="${v === cur ? "on" : ""}">${t}</button>`).join("")}</div>`;
  const el = h(`<div class="card" id="anya-card">
    <label class="row"><div><div class="k">Anya</div><div class="sub">A little companion in the corner: tips for the tool you're on, the odd game quote, a cheer when a job is done.</div></div>
      <input type="checkbox" class="switch" id="anya-on"></label>
    <label class="row"><div><div class="v">Voice</div><div class="sub">A short sound while she talks</div></div><input type="checkbox" class="switch" id="anya-voice"></label>
    <div class="row"><div><div class="v">Volume</div><div class="sub mono" id="anya-vol-v"></div></div><input type="range" class="range anya-range" id="anya-vol" min="0" max="100" step="5"></div>
    <div class="row"><div><div class="v">Size</div><div class="sub mono" id="anya-size-v"></div></div><input type="range" class="range anya-range" id="anya-size" min="60" max="160" step="5"></div>
    <div class="row"><div><div class="v">Position</div><div class="sub">Bottom of the sidebar, or the bottom-right corner of the window</div></div>${seg("anya-pos", p.position, [["sidebar", "Sidebar"], ["corner", "Window corner"]])}</div>
    <div class="row"><div><div class="v">Wobble</div><div class="sub">How much she sways while standing</div></div>${seg("anya-wobble", p.wobble, [["off", "Off"], ["gentle", "Gentle"], ["lively", "Lively"]])}</div>
    <div class="row"><div><div class="v">Talks on her own</div><div class="sub">She always answers when you click her or when a job ends</div></div>${seg("anya-chat", p.chat, [["quiet", "Never"], ["normal", "Sometimes"], ["chatty", "Often"]])}</div>
    <div class="row"><div><div class="v">Say hi</div><div class="sub">Right-click her for more</div></div><button class="btn sm" id="anya-test">${icon("play")}Talk</button></div>
  </div>`);
  const $ = <E extends HTMLElement>(s: string) => el.querySelector<E>(s)!;
  const on = $<HTMLInputElement>("#anya-on"), vo = $<HTMLInputElement>("#anya-voice"), vol = $<HTMLInputElement>("#anya-vol"), size = $<HTMLInputElement>("#anya-size");
  const sync = () => {
    const q = prefs();
    on.checked = q.on; vo.checked = q.voice; vol.value = String(q.volume); size.value = String(q.size);
    $("#anya-vol-v").textContent = `${q.volume}%`; $("#anya-size-v").textContent = `${q.size}%`;
    el.classList.toggle("off", !q.on);
  };
  on.onchange = () => { setPrefs({ on: on.checked }); if (on.checked) plain(pick(T.UNHUSH)); sync(); };
  vo.onchange = () => { setPrefs({ voice: vo.checked }); sync(); };
  vol.oninput = () => { setPrefs({ volume: Number(vol.value) }); sync(); };
  vol.onchange = () => { if (prefs().voice) { voice.volume = prefs().volume / 100; voice.currentTime = 0; voice.play().catch(() => {}); setTimeout(() => voice.pause(), 700); } };
  size.oninput = () => { setPrefs({ size: Number(size.value) }); sync(); };
  for (const [id, key] of [["#anya-pos", "position"], ["#anya-wobble", "wobble"], ["#anya-chat", "chat"]] as const) {
    $(id).onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-v]");
      if (!b) return;
      $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      setPrefs({ [key]: b.dataset.v });
    };
  }
  $("#anya-test").onclick = () => { if (!prefs().on) setPrefs({ on: true }); sync(); Math.random() < 0.5 ? quote(page) : line("tool"); };
  sync();
  return el;
}
