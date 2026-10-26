// Shared queue UI + API for modules (SPEC 4.2). Backend: src-tauri/src/queue.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { banner, h } from "./core";
import { icon, IconName } from "./icons";

export type Step =
  | { type: "run"; label: string; bin: string; args: string[]; parser: "ytDlp" | "ffmpeg" | "plain"; outputs?: string[]; duration?: number }
  | { type: "eagle" };
export type EagleMeta = { website?: string; tags?: string[]; annotation?: string };
export type NewJob = { module: string; title: string; pill?: string; steps?: Step[]; eagle?: EagleMeta; children?: NewJob[] };

type State = "queued" | "running" | "paused" | "waitingEagle" | "done" | "failed";
type Job = {
  id: string; module: string; title: string; pill: string; parent: string | null; group: boolean;
  steps: Step[]; step: number; state: State; progress: number; detail: string; error: string;
  outputs: string[]; inEagle: boolean;
};
type Queue = { jobs: Job[]; pausedUntil: number; backoffMin: number; pausedAll: boolean };

let queue: Queue = await invoke("queue_get");
const views = new Set<{ full: () => void; light: () => void }>();
const expanded = new Set<string>();

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
    case "done": return j.inEagle ? "In Eagle" : "Done";
  }
}

const btn = (act: string, id: string, ic: IconName, title: string) =>
  `<button class="btn sm ghost" data-act="${act}" data-id="${id}" title="${title}" aria-label="${title}">${icon(ic)}</button>`;

function actions(j: Job, state: State): string {
  const a: string[] = [];
  if (state === "running" || state === "queued") a.push(btn("pause", j.id, "pause", "Pause"));
  if (state === "paused") a.push(btn("resume", j.id, "play", "Resume"));
  if (state === "failed" || state === "waitingEagle") a.push(btn("retry", j.id, "retry", "Retry"));
  if (state === "waitingEagle") a.push(btn("keep", j.id, "folder", "Keep in folder, skip Eagle"));
  if (state === "done" && !j.inEagle && !j.group && j.outputs.length) a.push(btn("reveal", j.id, "folder", "Show in folder"));
  a.push(btn("remove", j.id, "trash", "Remove"));
  return a.join("");
}

function item(j: Job): HTMLElement {
  const state = j.group ? groupState(j.id) : j.state;
  const open = expanded.has(j.id);
  const el = h(`<div class="item ${state}" data-job="${j.id}">
    <div class="top">
      ${j.group ? `<button class="btn sm ghost exp" data-act="expand" data-id="${j.id}" aria-label="Expand">${icon(open ? "chevronDown" : "chevronRight")}</button>` : ""}
      <span class="ic">${icon(j.group ? "list" : stateIcon[state])}</span>
      <span class="nm"></span>${j.pill ? `<span class="pill"></span>` : ""}
      <span class="st"></span><span class="acts">${actions(j, state)}</span>
    </div>
    ${state === "done" ? "" : `<div class="bar"><i style="width:${pct(jobProgress(j))}"></i></div>`}
  </div>`);
  el.querySelector(".nm")!.textContent = j.title;
  el.querySelector(".nm")!.setAttribute("title", j.title);
  if (j.pill) el.querySelector(".pill")!.textContent = j.pill;
  const st = el.querySelector(".st")!;
  st.textContent = statusText(j, state);
  st.setAttribute("title", st.textContent);
  if (j.group && open) {
    const kids = h(`<div class="kids"></div>`);
    kids.append(...children(j.id).map(item));
    el.append(kids);
  }
  return el;
}

function countdown(until: number) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Resuming at ${at} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

setInterval(() => {
  document.querySelectorAll<HTMLElement>("[data-until]").forEach((el) => (el.textContent = countdown(Number(el.dataset.until))));
}, 1000);

/** Renders the queue (optionally only one module's jobs) into `el` and keeps it live. */
export function mountQueue(el: HTMLElement, module?: string) {
  const root = h(`<div class="queue">
    <div class="qhead"><h4>Queue</h4><span class="count"></span>
      <div class="right"><span class="q-pause"></span>${btn("clear", "", "broom", "Clear finished")}</div></div>
    <div class="overall"><div class="bar thick"><i></i></div><span class="pct mono"></span></div>
    <div class="cool"></div>
    <div class="list"></div>
  </div>`);
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b) return;
    const { act, id } = b.dataset as { act: string; id: string };
    if (act === "expand") { expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
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
  function render() {
    if (!root.isConnected) { views.delete(view); return; } // module was switched away
    light();
    root.querySelector(".q-pause")!.innerHTML = queue.pausedAll ? btn("pauseAll", "", "play", "Resume all") : btn("pauseAll", "", "pause", "Pause all");
    const cool = root.querySelector(".cool")!;
    cool.innerHTML = queue.pausedUntil > Date.now()
      ? `<div class="banner warn">${icon("clock")}<span><b>Rate limited by the site.</b> <span data-until="${queue.pausedUntil}">${countdown(queue.pausedUntil)}</span></span>
         <div class="acts"><button class="btn sm ghost" data-act="resumeNow">Resume now</button></div></div>`
      : "";
    const list = root.querySelector(".list")!;
    const top = mine().filter((j) => !j.parent);
    list.replaceChildren(...(top.length ? top.map(item) : [h(`<div class="q-empty">Nothing in the queue</div>`)]));
  }
  const view = { full: render, light: () => root.isConnected && light() };
  el.append(root);
  render();
  views.add(view);
}
