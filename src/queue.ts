// Shared queue UI + API for modules (SPEC 4.2). Backend: src-tauri/src/queue.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { banner, h, modal } from "./core";
import { icon, IconName } from "./icons";

export type Step =
  | { type: "run"; label: string; bin: string; args: string[]; parser: "ytDlp" | "ffmpeg" | "plain" | "galleryDl" | "percent" | "spotDl"; outputs?: string[]; duration?: number; replace?: boolean }
  | { type: "eagle"; keep?: boolean }
  | { type: "delete"; paths: string[] }
  | { type: "rembg"; model: string; input: string; output: string; background?: string; crop?: boolean; gentle?: boolean }
  | { type: "audible"; asin: string; title: string; author: string; duration: number; folder: string }
  | { type: "lyrics"; prefer?: string[] };
export type EagleMeta = { website?: string; tags?: string[]; annotation?: string };
export type NewJob = {
  module: string; title: string; pill?: string; steps?: Step[]; eagle?: EagleMeta; children?: NewJob[];
  outputs?: string[]; source?: string;
};

type State = "queued" | "running" | "paused" | "waitingEagle" | "done" | "failed";
export type Job = {
  id: string; module: string; title: string; pill: string; parent: string | null; group: boolean;
  steps: Step[]; step: number; state: State; progress: number; detail: string; error: string;
  outputs: string[]; inEagle: boolean; source: string; note: string;
};
/** Console lines per job, fetched when a console opens and then appended live. */
const logs = new Map<string, string[]>();
type Queue = { jobs: Job[]; pausedUntil: number; backoffMin: number; pausedAll: boolean };

let queue: Queue = await invoke("queue_get");
const views = new Set<{ full: () => void; light: () => void }>();
const expanded = new Set<string>(); // groups and consoles the user opened

/** Calls `fn(jobs)` now and on every queue change (also on progress ticks if `ticks`);
 *  stops when `alive()` turns false. */
export function watchJobs(fn: (jobs: Job[]) => void, alive: () => boolean, ticks = false) {
  const v = {
    full: () => (alive() ? fn(queue.jobs) : views.delete(v)),
    light: () => { if (ticks) v.full(); },
  };
  views.add(v);
  fn(queue.jobs);
}

/** Module display names for the Downloads page (set by main.ts from the registry). */
let moduleName: (id: string) => string = (id) => id;
export const setModuleNames = (f: (id: string) => string) => (moduleName = f);

/** Full error text in a modal, selectable, with a copy button (for bug reports). */
export function showError(j: Pick<Job, "title" | "error">) {
  const body = h(`<div class="err-box"><pre class="mono"></pre></div>`);
  body.querySelector("pre")!.textContent = j.error;
  modal({
    title: `Error: ${j.title}`,
    body,
    actions: [
      { label: "Close" },
      {
        label: "Copy error", primary: true,
        run: async () => {
          await navigator.clipboard.writeText(`${j.title}\n${j.error}`);
          banner({ id: "copied", icon: "check", text: "Error copied to the clipboard." });
        },
      },
    ],
  });
}

listen<Queue>("queue", ({ payload }) => {
  queue = payload;
  views.forEach((v) => v.full());
});
listen<{ id: string; progress: number; detail: string }>("job", ({ payload: p }) => {
  const j = queue.jobs.find((j) => j.id === p.id);
  if (!j) return;
  Object.assign(j, { progress: p.progress, detail: p.detail });
  // Update bars/text in place: rebuilding the list on every tick would swallow clicks.
  for (const x of [j, queue.jobs.find((g) => g.id === j.parent)]) {
    if (!x) continue;
    document.querySelectorAll<HTMLElement>(`[data-job="${x.id}"]`).forEach((el) => {
      const bar = el.querySelector<HTMLElement>(":scope > .bar i");
      if (bar) bar.style.width = pct(jobProgress(x));
      el.querySelector(":scope > .top .st")!.textContent = statusText(x, x.group ? groupState(x.id) : x.state);
    });
  }
  views.forEach((v) => v.light());
});
// console lines, appended live to open consoles (auto-scroll unless the user scrolled up)
listen<{ id: string; line: string }>("job-log", ({ payload: p }) => {
  const lines = logs.get(p.id);
  if (!lines) return; // console never opened: nothing to keep in the UI
  lines.push(p.line);
  if (lines.length > 400) lines.shift();
  document.querySelectorAll<HTMLElement>(`[data-job="${p.id}"] > .console`).forEach((c) => {
    const atEnd = c.scrollTop + c.clientHeight >= c.scrollHeight - 8;
    c.append(logLine(p.line));
    if (c.childElementCount > 400) c.firstElementChild!.remove();
    if (atEnd) c.scrollTop = c.scrollHeight;
  });
});

/** One console line; errors red, warnings amber, finished files green. */
function logLine(line: string): HTMLElement {
  const lower = line.toLowerCase();
  const cls = /\berror\b|failed/.test(lower) ? "err" : /warning|429|403|retry/.test(lower) ? "warn" : /^[a-z]:\\|^\[file\]|^done/i.test(line) ? "ok" : line.startsWith(">") ? "cmd" : "";
  const el = h(`<div class="ln ${cls}"></div>`);
  el.textContent = line;
  return el;
}

const usesEagle = (j: NewJob): boolean => !!j.steps?.some((s) => s.type === "eagle") || !!j.children?.some(usesEagle);

/** Adds jobs; warns right away when Eagle import is requested but Eagle is closed. */
export async function addJobs(jobs: NewJob[]): Promise<string[]> {
  if (jobs.some(usesEagle) && !(await invoke<boolean>("eagle_status"))) {
    banner({
      id: "eagle-offline", tone: "warn", icon: "alert",
      text: "<b>Eagle is not running.</b> Finished items will wait and import automatically when Eagle opens.",
    });
  }
  return invoke("queue_add", { jobs });
}

export const queueAction = (id: string, action: "pause" | "resume" | "retry" | "remove" | "keep") => invoke("queue_action", { id, action });

/** Running + queued counts (sidebar badge). */
export function queueCounts(): { running: number; queued: number } {
  const units = queue.jobs.filter((j) => !j.group);
  return { running: units.filter((j) => j.state === "running").length, queued: units.filter((j) => j.state === "queued").length };
}

// ---------- rendering ----------

const children = (id: string) => queue.jobs.filter((j) => j.parent === id);
const jobProgress = (j: Job): number =>
  j.group ? avg(children(j.id).map(jobProgress)) : j.state === "done" ? 1 : (j.step + j.progress) / Math.max(j.steps.length, 1);
const avg = (n: number[]) => (n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function groupState(id: string): State {
  const s = children(id).map((c) => c.state);
  if (s.includes("running")) return "running";
  if (s.includes("failed")) return "failed";
  if (s.includes("waitingEagle")) return "waitingEagle";
  if (s.every((x) => x === "done")) return "done";
  if (s.every((x) => x === "paused" || x === "done")) return "paused";
  return "queued";
}

const stateIcon: Record<State, IconName> = {
  queued: "clock", running: "download", paused: "pause", waitingEagle: "alert", done: "check", failed: "alert",
};

function statusText(j: Job, state: State): string {
  if (j.group) {
    const c = children(j.id);
    return `${c.filter((x) => x.state === "done").length} / ${c.length}`;
  }
  switch (state) {
    case "running": return j.detail || "Starting";
    case "queued": return "Queued";
    case "paused": return "Paused";
    case "waitingEagle": return "Eagle is closed";
    case "failed": return j.error || "Failed";
    case "done": return [j.inEagle ? "In Eagle" : "Done", j.note].filter(Boolean).join(" · ");
  }
}

const btn = (act: string, id: string, ic: IconName, title: string) =>
  `<button class="btn sm ghost" data-act="${act}" data-id="${id}" title="${title}" aria-label="${title}">${icon(ic)}</button>`;

function actions(j: Job, state: State): string {
  const a: string[] = [];
  if (state === "running" || state === "queued") a.push(btn("pause", j.id, "pause", "Pause"));
  if (state === "paused") a.push(btn("resume", j.id, "play", "Resume"));
  if (state === "failed" && !j.group) a.push(btn("error", j.id, "copy", "Show and copy the error"));
  if (state === "failed" || state === "waitingEagle") a.push(btn("retry", j.id, "retry", "Retry"));
  if (state === "waitingEagle") a.push(btn("keep", j.id, "folder", "Keep in folder, skip Eagle"));
  if (state === "done" && !j.inEagle && !j.group && j.outputs.length) a.push(btn("reveal", j.id, "folder", "Show in folder"));
  a.push(btn("remove", j.id, "trash", "Remove"));
  return a.join("");
}

function item(j: Job, showModule: boolean): HTMLElement {
  const state = j.group ? groupState(j.id) : j.state;
  const open = expanded.has(j.id);
  const el = h(`<div class="item ${state}" data-job="${j.id}">
    <div class="top">
      <button class="btn sm ghost exp" data-act="expand" data-id="${j.id}" aria-label="${j.group ? "Show items" : "Show console"}" title="${j.group ? "Show items" : "Show what's happening"}">${icon(open ? "chevronDown" : "chevronRight")}</button>
      <span class="ic">${icon(j.group ? "list" : stateIcon[state])}</span>
      ${showModule ? `<span class="q-mod"></span>` : ""}
      <span class="nm"></span>${j.pill ? `<span class="pill"></span>` : ""}
      <span class="st"></span><span class="acts">${actions(j, state)}</span>
    </div>
    ${state === "done" ? "" : `<div class="bar"><i style="width:${pct(jobProgress(j))}"></i></div>`}
  </div>`);
  if (state === "failed") el.querySelector(".st")!.classList.add("clickable");
  el.querySelector(".nm")!.textContent = j.title;
  el.querySelector(".nm")!.setAttribute("title", j.title);
  if (j.pill) el.querySelector(".pill")!.textContent = j.pill;
  if (showModule) el.querySelector(".q-mod")!.textContent = moduleName(j.module);
  const st = el.querySelector(".st")!;
  st.textContent = statusText(j, state);
  st.setAttribute("title", st.textContent);
  if (open && j.group) {
    const kids = h(`<div class="kids"></div>`);
    kids.append(...children(j.id).map((c) => item(c, false)));
    el.append(kids);
  } else if (open) {
    // terminal-like view of the tool's output: what it is downloading, warnings, server errors
    const c = h(`<div class="console mono" tabindex="0"></div>`);
    const fill = (lines: string[]) => {
      c.replaceChildren(...(lines.length ? lines.map(logLine) : [logLine(state === "queued" ? "Waiting for a free slot…" : "No output yet")]));
      requestAnimationFrame(() => (c.scrollTop = c.scrollHeight));
    };
    const cached = logs.get(j.id);
    if (cached) fill(cached);
    else invoke<string[]>("queue_log", { id: j.id }).then((l) => { logs.set(j.id, l); fill(l); });
    el.append(c);
  }
  return el;
}

function countdown(until: number) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Resuming at ${at} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

setInterval(() => {
  document.querySelectorAll<HTMLElement>("[data-until]").forEach((el) => {
    el.textContent = countdown(Number(el.dataset.until));
    if (Number(el.dataset.until) <= Date.now()) el.closest(".banner")?.remove();
  });
}, 1000);

/** Renders the queue (one module's jobs, or all with module names) into `el` and keeps it live. */
export function mountQueue(el: HTMLElement, module?: string) {
  const root = h(`<div class="queue">
    <div class="qhead"><h4>Queue</h4><span class="count"></span>
      <div class="right"><span class="q-pause"></span>${btn("clear", "", "broom", "Clear finished")}</div></div>
    <div class="overall"><div class="bar thick"><i></i></div><span class="pct mono"></span></div>
    <div class="cool"></div>
    <div class="list"></div>
  </div>`);
  root.addEventListener("click", (e) => {
    const failedText = (e.target as HTMLElement).closest(".item.failed > .top .st");
    if (failedText) {
      const j = queue.jobs.find((x) => x.id === failedText.closest<HTMLElement>(".item")!.dataset.job);
      if (j) showError(j);
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b) return;
    const { act, id } = b.dataset as { act: string; id: string };
    if (act === "expand") { expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
    else if (act === "error") showError(queue.jobs.find((j) => j.id === id)!);
    else if (act === "clear") invoke("queue_clear_finished");
    else if (act === "pauseAll") invoke("queue_pause_all", { paused: !queue.pausedAll });
    else if (act === "resumeNow") invoke("queue_resume_now");
    else if (act === "reveal") revealItemInDir(queue.jobs.find((j) => j.id === id)!.outputs[0]);
    else queueAction(id, act as Parameters<typeof queueAction>[1]);
  });

  const mine = () => queue.jobs.filter((j) => !module || j.module === module);
  function light() {
    const units = mine().filter((j) => !j.group);
    const done = units.filter((j) => j.state === "done").length;
    root.querySelector(".count")!.innerHTML = `<b>${done}</b> / ${units.length} done`;
    const overall = avg(units.map(jobProgress));
    root.querySelector<HTMLElement>(".overall .bar i")!.style.width = pct(overall);
    root.querySelector(".overall .pct")!.textContent = pct(overall);
  }
  let mounting = true; // the first render happens before the page is attached: never skip it
  function render() {
    if (!mounting && !root.isConnected) { views.delete(view); return; } // tool was switched away
    light();
    root.querySelector(".q-pause")!.innerHTML = queue.pausedAll ? btn("pauseAll", "", "play", "Resume all") : btn("pauseAll", "", "pause", "Pause all");
    // the rate-limit timer only matters when something of this queue is actually waiting
    const waiting = mine().some((j) => j.state === "queued" && !j.group);
    root.querySelector(".cool")!.innerHTML = waiting && queue.pausedUntil > Date.now()
      ? `<div class="banner warn">${icon("clock")}<span><b>Rate limited by the site.</b> <span data-until="${queue.pausedUntil}">${countdown(queue.pausedUntil)}</span></span>
         <div class="acts"><button class="btn sm ghost" data-act="resumeNow">Resume now</button></div></div>`
      : "";
    const list = root.querySelector(".list")!;
    // keep open consoles scrolled where the user left them across re-renders
    const scroll = new Map([...list.querySelectorAll<HTMLElement>(".console")].map((c) => [c.closest<HTMLElement>(".item")!.dataset.job!, c.scrollTop]));
    const top = mine().filter((j) => !j.parent);
    list.replaceChildren(...(top.length ? top.map((j) => item(j, !module)) : [h(`<div class="q-empty">Nothing in the queue</div>`)]));
    scroll.forEach((s, id) => { const c = list.querySelector<HTMLElement>(`[data-job="${id}"] > .console`); if (c) requestAnimationFrame(() => (c.scrollTop = s)); });
  }
  const view = { full: render, light: () => root.isConnected && light() };
  el.append(root);
  render();
  mounting = false;
  views.add(view);
}
