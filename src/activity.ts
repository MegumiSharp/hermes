// Background tasks that must never block the UI (model downloads, AI runtime install, tool/app
// updates, model compares). Listed on the Downloads page next to the queue; counted in the
// sidebar badge of "Downloads".
import { h, navigate } from "./core";
import { icon, IconName } from "./icons";
import { queueCounts, watchJobs } from "./queue";

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

/** Live list of background tasks (Downloads page). */
export function mountTasks(el: HTMLElement, meta: (module: string) => { name: string; icon: IconName } | undefined) {
  const render = () => {
    if (!el.isConnected && rendered) return listeners.delete(render);
    rendered = true;
    el.hidden = !tasks.size;
    el.replaceChildren(h(`<div class="qhead"><h4>Background tasks</h4></div>`), ...[...tasks.values()].map((t) => {
      const m = t.module ? meta(t.module) : undefined;
      const row = h(`<button class="item task" type="button"><div class="top">${icon(m?.icon ?? "download")}<span class="nm"></span>
        <span class="st"></span></div><div class="bar"><i class="${t.pct == null ? "indet" : ""}" style="width:${t.pct == null ? 30 : Math.round(t.pct * 100)}%"></i></div></button>`);
      row.querySelector(".nm")!.textContent = [m?.name, t.label].filter(Boolean).join(" · ");
      row.querySelector(".st")!.textContent = t.detail || (t.pct == null ? "Working" : `${Math.round(t.pct * 100)}%`);
      if (t.module) row.onclick = () => navigate(t.module!);
      return row;
    }));
  };
  let rendered = false;
  listeners.add(render);
  render();
}

/** Keeps the Downloads nav badge (running + queued + background tasks) current. */
export function mountBadge(badge: HTMLElement) {
  const render = () => {
    const { running, queued } = queueCounts();
    const busy = running + tasks.size;
    badge.textContent = busy ? String(busy) : queued ? String(queued) : "";
    badge.classList.toggle("busy", busy > 0);
    badge.title = `${running} running · ${queued} queued · ${tasks.size} background task${tasks.size === 1 ? "" : "s"}`;
  };
  listeners.add(render);
  watchJobs(render, () => true);
}
