// Binary manager UI (SPEC 4.1). Backend: src-tauri/src/binaries.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { banner, h, navigate, saveSettings, settings } from "./core";
import { icon } from "./icons";

type Status = { id: string; name: string; version?: string; date?: string; ok: boolean; error?: string; notify: boolean };
type Ver = { version: string; date: string };

let statuses: Status[] = [];
let latest: Record<string, Ver> = {};
let checking = false;
const updating = new Map<string, number>(); // id -> 0..1
let rerender = () => {};

const hasUpdate = (s: Status) => !!latest[s.id] && (!s.date || latest[s.id].date > s.date);
const names = (list: Status[]) => list.map((s) => s.name).join(", ");

listen<[string, number, number]>("binary-progress", ({ payload: [id, done, total] }) => {
  updating.set(id, total ? done / total : 0);
  const fill = document.querySelector<HTMLElement>(`[data-bin="${id}"] .bar i`);
  if (fill) fill.style.width = `${updating.get(id)! * 100}%`;
});

async function update(id: string): Promise<boolean> {
  updating.set(id, 0);
  rerender();
  try {
    const s = await invoke<Status>("binary_update", { id });
    statuses = statuses.map((x) => (x.id === id ? s : x));
    return s.ok;
  } catch (e) {
    banner({ id: `bin-${id}`, tone: "warn", icon: "alert", text: `Updating ${id} failed: ${e}` });
    return false;
  } finally {
    updating.delete(id);
    rerender();
  }
}

/** Fetches latest versions; returns the per-tool errors (offline, rate limit...). */
async function checkLatest(): Promise<string[]> {
  checking = true;
  rerender();
  const r = await invoke<{ versions: Record<string, Ver>; errors: string[] }>("binaries_latest");
  latest = r.versions;
  checking = false;
  rerender();
  return r.errors;
}

/** Resolves once every tool has been extracted/verified. Modules await this before running tools. */
export const binariesReady: Promise<void> = (async () => {
  statuses = await invoke("binaries_init");
  const broken = statuses.filter((s) => !s.ok);
  if (broken.length) {
    banner({
      id: "binaries-broken", tone: "warn", icon: "alert",
      text: `${names(broken)} ${broken.length > 1 ? "are" : "is"} not installed or not working.`,
      actions: [{ label: "Open Binaries", primary: true, run: () => navigate("binaries") }],
    });
  }
  rerender();
})();

/** Current status of one tool (after startup verification). */
export async function toolStatus(id: string): Promise<Status | undefined> {
  await binariesReady;
  return statuses.find((s) => s.id === id);
}

/** Startup: auto-update yt-dlp if enabled, then announce other updates. Network errors are silent. */
export async function startBinaryChecks() {
  await binariesReady;
  await checkLatest(); // errors are ignored on the silent startup check
  const yt = statuses.find((s) => s.id === "yt-dlp");
  if (yt && settings.autoUpdateYtdlp !== false && hasUpdate(yt) && (await update("yt-dlp"))) {
    banner({ id: "bin-yt-dlp", icon: "check", text: `yt-dlp updated to <b>${latest["yt-dlp"].version}</b>.` });
  }
  const pending = statuses.filter((s) => s.notify && hasUpdate(s));
  if (pending.length) {
    banner({
      id: "binaries-update", icon: "refresh", text: `Updates available: <b>${names(pending)}</b>.`,
      actions: [{ label: "Later" }, { label: "Open Binaries", primary: true, run: () => navigate("binaries") }],
    });
  }
}

export function renderBinaries(view: HTMLElement) {
  const el = h(`<div class="page">
    <div class="head"><div><h3>Binaries</h3><div class="sub">Bundled tools. Updates download from each project's official releases.</div></div>
      <div class="right"><button class="btn sm" id="bin-check">${icon("refresh")}Check for updates</button></div></div>
    <div class="card" id="bin-list"></div>
    <div class="card"><label class="row"><div><div class="v">Update yt-dlp automatically on launch</div>
      <div class="sub">Sites change often; an outdated yt-dlp is the most common cause of failed downloads.</div></div>
      <input type="checkbox" class="switch" id="bin-auto"></label></div>
  </div>`);
  const auto = el.querySelector<HTMLInputElement>("#bin-auto")!;
  auto.checked = settings.autoUpdateYtdlp !== false;
  auto.onchange = () => saveSettings({ autoUpdateYtdlp: auto.checked });
  const check = el.querySelector<HTMLButtonElement>("#bin-check")!;
  check.onclick = async () => {
    const errors = await checkLatest();
    if (errors.length) banner({ id: "bin-check", tone: "warn", icon: "alert", text: `Update check failed. ${errors.join("; ")}` });
  };

  const list = el.querySelector("#bin-list")!;
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-update]");
    if (b) update(b.dataset.update!);
  });

  rerender = () => { // re-rendering a page that was navigated away from is harmless
    check.disabled = checking;
    list.replaceChildren(...statuses.map((s) => {
      const l = latest[s.id];
      const busy = updating.has(s.id);
      const row = h(`<div class="row" data-bin="${s.id}">
        <div class="bin-name"><div class="v"><b></b></div><div class="mono sub"></div></div>
        <div class="bin-state"><span class="chip ${s.ok ? "" : "bad"}"><span class="dot"></span></span></div>
        <div class="bin-latest sub"></div>
        <div class="bin-act"></div></div>`);
      row.querySelector("b")!.textContent = s.name;
      row.querySelector(".bin-name .sub")!.textContent = s.version ?? "Not installed";
      row.querySelector(".chip")!.append(s.ok ? "Working" : "Broken");
      if (!s.ok) row.querySelector(".chip")!.setAttribute("title", s.error ?? "");
      row.querySelector(".bin-latest")!.textContent = checking ? "Checking" : l ? (hasUpdate(s) ? `Latest ${l.version}` : "Up to date") : "";
      const act = row.querySelector(".bin-act")!;
      if (busy) act.append(h(`<div class="bar"><i style="width:${(updating.get(s.id) ?? 0) * 100}%"></i></div>`));
      else if (hasUpdate(s) || !s.ok) act.append(h(`<button class="btn sm primary" data-update="${s.id}">${icon("download")}${s.version ? "Update" : "Install"}</button>`));
      return row;
    }));
  };
  view.append(el);
  rerender();
}
