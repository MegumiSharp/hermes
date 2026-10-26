// Background activity: long tasks that must never block the UI (model downloads, AI runtime
// install, tool/app updates) plus running queue jobs, shown in the sidebar "Activity" panel.
import { h, navigate } from "./core";
import { icon, IconName } from "./icons";
import { watchJobs } from "./queue";

type Task = { id: string; label: string; module?: string; pct: number | null; detail: string };
const tasks = new Map<string, Task>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Registers a background task; update it as it progresses and call `end()` when done or failed. */
export function startTask(id: string, label: string, module?: string) {
  tasks.set(id, { id, label, module, pct: null, detail: "" });
  changed();
  return {
    update(pct: number | null, detail = "") {
      const t = tasks.get(id);
      if (!t) return;
      Object.assign(t, { pct, detail });
      changed();
    },
    end() {
      tasks.delete(id);
      changed();
    },
  };
}

export const taskRunning = (id: string) => tasks.has(id);

/** Sidebar panel. `meta(module)` gives the tool's name and icon. */
export function mountActivity(el: HTMLElement, meta: (module: string) => { name: string; icon: IconName } | undefined) {
  let jobs: { id: string; title: string; module: string; pct: number; detail: string }[] = [];
  let queued = 0;
  const render = () => {
    const rows = [
      ...[...tasks.values()].map((t) => ({ key: t.id, title: t.label, module: t.module, pct: t.pct, detail: t.detail })),
      ...jobs.map((j) => ({ key: j.id, title: j.title, module: j.module, pct: j.pct, detail: j.detail })),
    ];
    el.hidden = !rows.length && !queued;
    el.replaceChildren(h(`<div class="label">Activity${queued ? ` <span class="act-q">${queued} queued</span>` : ""}</div>`));
    for (const r of rows.slice(0, 6)) {
      const m = r.module ? meta(r.module) : undefined;
      const row = h(`<button class="act" title="">${icon(m?.icon ?? "download")}<span class="act-body"><span class="act-t"></span>
        <span class="bar"><i style="width:${r.pct == null ? 100 : Math.round(r.pct * 100)}%" class="${r.pct == null ? "indet" : ""}"></i></span></span></button>`);
      row.querySelector(".act-t")!.textContent = r.title;
      row.title = [m?.name, r.title, r.detail].filter(Boolean).join(" · ");
      if (r.module) row.onclick = () => navigate(r.module!);
      el.append(row);
    }
    if (rows.length > 6) el.append(h(`<div class="act-more sub">+${rows.length - 6} more</div>`));
  };
  listeners.add(render);
  watchJobs((all) => {
    const units = all.filter((j) => !j.group);
    jobs = units.filter((j) => j.state === "running").map((j) => ({
      id: j.id, title: j.title, module: j.module, detail: j.detail,
      pct: Math.min(1, (j.step + j.progress) / Math.max(j.steps.length, 1)),
    }));
    queued = units.filter((j) => j.state === "queued").length;
    render();
  }, () => true, true);
  render();
}
