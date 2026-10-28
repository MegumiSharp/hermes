// Binary manager UI (SPEC 4.1). Backend: src-tauri/src/binaries.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTask } from "./activity";
import { banner, h, modal, navigate, saveSettings, settings } from "./core";
import { icon } from "./icons";
import { liveStatus } from "./modules/common";

type Status = { id: string; name: string; version?: string; date?: string; ok: boolean; error?: string; notify: boolean; optional: boolean };
type Ver = { version: string; date: string };

let statuses: Status[] = [];
let latest: Record<string, Ver> = {};
let checking = false;
const updating = new Map<string, number>(); // id -> 0..1
let rerender = () => {};

const hasUpdate = (s: Status) => !!s.version && !!latest[s.id] && (!s.date || latest[s.id].date > s.date);
const missingOptional = (s: Status) => s.optional && !s.version; // installed only when a tool asks for it
const names = (list: Status[]) => list.map((s) => s.name).join(", ");

listen<[string, number, number]>("binary-progress", ({ payload: [id, done, total] }) => {
  updating.set(id, total ? done / total : 0);
  const fill = document.querySelector<HTMLElement>(`[data-bin="${id}"] .bar i`);
  if (fill) fill.style.width = `${updating.get(id)! * 100}%`;
});

/** Installs or updates one tool in the background; true when it works afterwards. */
export async function installTool(id: string): Promise<boolean> {
  return update(id);
}

async function update(id: string): Promise<boolean> {
  updating.set(id, 0);
  rerender();
  const task = startTask(`bin-${id}`, `Updating ${statuses.find((s) => s.id === id)?.name ?? id}`, "binaries");
  const tick = setInterval(() => task.update(updating.get(id) ?? null), 500);
  try {
    const s = await invoke<Status>("binary_update", { id });
    statuses = statuses.map((x) => (x.id === id ? s : x));
    return s.ok;
  } catch (e) {
    banner({ id: `bin-${id}`, tone: "warn", icon: "alert", text: `Updating ${id} failed: ${e}` });
    return false;
  } finally {
    clearInterval(tick);
    task.end();
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
  const broken = statuses.filter((s) => !s.ok && !missingOptional(s));
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
    <div id="bin-live"></div>
    <div class="card" id="bin-list"></div>
    <div class="card"><label class="row"><div><div class="v">Update yt-dlp automatically on launch</div>
      <div class="sub">Sites change often; an outdated yt-dlp is the most common cause of failed downloads.</div></div>
      <input type="checkbox" class="switch" id="bin-auto"></label></div>
  </div>`);
  const auto = el.querySelector<HTMLInputElement>("#bin-auto")!;
  auto.checked = settings.autoUpdateYtdlp !== false;
  auto.onchange = () => saveSettings({ autoUpdateYtdlp: auto.checked });
  const check = el.querySelector<HTMLButtonElement>("#bin-check")!;
  const live = liveStatus("binaries-check");
  el.querySelector("#bin-live")!.append(live.el);
  check.onclick = async () => {
    live.set("Checking each tool's latest release");
    const errors = await checkLatest().finally(() => live.done());
    if (errors.length) banner({ id: "bin-check", tone: "warn", icon: "alert", text: `Update check failed. ${errors.join("; ")}` });
  };

  const list = el.querySelector("#bin-list")!;
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-update], [data-remove]");
    if (b?.dataset.update) update(b.dataset.update);
    if (b?.dataset.remove) {
      const s = statuses.find((x) => x.id === b.dataset.remove)!;
      invoke("binary_remove", { id: s.id }).then(async () => {
        statuses = await invoke("binaries_init");
        rerender();
      }, (e) => banner({ id: `bin-${s.id}`, tone: "warn", icon: "alert", text: `Removing ${s.name} failed: ${e}` }));
    }
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
      const chip = row.querySelector(".chip")!;
      if (missingOptional(s)) { chip.classList.remove("bad"); chip.classList.add("off"); chip.append("Not installed"); }
      else chip.append(s.ok ? "Working" : "Broken");
      if (!s.ok && !missingOptional(s)) chip.setAttribute("title", s.error ?? "");
      row.querySelector(".bin-latest")!.textContent = checking ? "Checking" : l ? (hasUpdate(s) ? `Latest ${l.version}` : "Up to date") : "";
      const act = row.querySelector(".bin-act")!;
      if (busy) act.append(h(`<div class="bar"><i style="width:${(updating.get(s.id) ?? 0) * 100}%"></i></div>`));
      else {
        if (hasUpdate(s) || !s.ok) act.append(h(`<button class="btn sm primary" data-update="${s.id}">${icon("download")}${s.version ? "Update" : "Install"}</button>`));
        if (s.optional && s.version) act.append(h(`<button class="btn sm ghost" data-remove="${s.id}" title="Delete it from this PC; install it again any time">${icon("trash")}Remove</button>`));
      }
      return row;
    }));
  };
  el.append(officeCard(), aiModelsCard());
  view.append(el);
  rerender();
}

/** LibreOffice is not on GitHub (office.rs): its own row, installed by Document Converter or here. */
function officeCard(): HTMLElement {
  const card = h(`<div class="card" id="office-card"><div class="row"><div class="bin-name"><div class="v"><b>LibreOffice</b></div>
    <div class="mono sub" id="office-ver"></div></div><div class="sub">Optional: faithful Word / PowerPoint / Excel to PDF and PDF to Word in Document Converter. 375 MB download, 1.5 GB on disk.</div>
    <div class="right" id="office-act"></div></div></div>`);
  const render = async () => {
    const s = await invoke<{ installed: boolean; version: string }>("office_status");
    card.querySelector("#office-ver")!.textContent = s.installed ? s.version || "installed" : "Not installed";
    const act = card.querySelector<HTMLElement>("#office-act")!;
    act.replaceChildren();
    if (s.installed) {
      const b = h(`<button class="btn sm ghost">${icon("trash")}Remove</button>`) as HTMLButtonElement;
      b.onclick = async () => { b.disabled = true; await invoke("office_remove").catch((e) => banner({ id: "office", tone: "warn", icon: "alert", text: `Removing LibreOffice failed: ${e}` })); render(); };
      act.append(b);
    } else act.append(h(`<span class="sub">Installed when a conversion needs it</span>`));
  };
  render();
  return card;
}

type ModelStatus = { kind: string; id: string; name: string; installed: string; latest: string; outdated: boolean; note: string };

/** "AI models": are downloaded models / AI packages current? Update runs in the background. */
function aiModelsCard(): HTMLElement {
  const card = h(`<div class="card" id="ai-models"><div class="row"><div><div class="v"><b>AI models</b></div>
    <div class="sub">Background Removal models, Whisper models and the AI runtime packages. Checked on demand.</div></div>
    <button class="btn sm" id="ai-check">${icon("refresh")}Check models</button></div><div id="ai-rows"></div></div>`);
  const rows = card.querySelector<HTMLElement>("#ai-rows")!;
  const btn = card.querySelector<HTMLButtonElement>("#ai-check")!;
  const live = liveStatus("models-check");
  async function check() {
    btn.disabled = true;
    live.set("Comparing your models with GitHub, Hugging Face and PyPI");
    rows.replaceChildren(live.el);
    const list = await invoke<ModelStatus[]>("models_status");
    live.done();
    btn.disabled = false;
    if (!list.length) { rows.replaceChildren(h(`<div class="row"><div class="sub">No AI models downloaded yet.</div></div>`)); return; }
    rows.replaceChildren(...list.map((m) => {
      const r = h(`<div class="row" data-model="${m.kind}-${m.id}"><div class="bin-name"><div class="v"><b></b></div><div class="mono sub"></div></div>
        <div class="bin-state"><span class="chip ${m.outdated ? "bad" : ""}"><span class="dot"></span><span></span></span></div>
        <div class="bin-latest sub"></div><div class="bin-act"></div></div>`);
      r.querySelector("b")!.textContent = m.name;
      r.querySelector(".bin-name .sub")!.textContent = m.installed;
      r.querySelector(".chip span:last-child")!.textContent = m.outdated ? "Update available" : m.latest === "unknown" ? "Not checked" : "Up to date";
      r.querySelector(".bin-latest")!.textContent = m.note || (m.outdated ? `Latest ${m.latest}` : "");
      if (m.kind !== "python") { // packages go with the runtime row
        const d = h(`<button class="btn sm ghost" title="Delete it from this PC; the tool downloads it again when needed">${icon("trash")}Delete</button>`) as HTMLButtonElement;
        d.onclick = () => modal({
          title: `Delete ${m.name}?`, body: `Frees ${m.installed}. The tool that uses it will offer to download it again when needed.`,
          actions: [{ label: "Cancel" }, { label: "Delete", primary: true, run: async () => {
            try { await invoke("model_delete", { kind: m.kind, id: m.id }); } catch (e) { banner({ id: "ai-models", tone: "warn", icon: "alert", text: `Delete failed: ${e}` }); }
            check();
          } }],
        });
        r.querySelector(".bin-act")!.append(d);
      }
      if (m.outdated && m.kind !== "python") {
        const u = h(`<button class="btn sm primary">${icon("download")}Update</button>`) as HTMLButtonElement;
        u.onclick = async () => {
          u.disabled = true;
          const task = startTask(`model-update-${m.id}`, `Updating ${m.name}`, "binaries");
          try {
            await invoke("model_update", { kind: m.kind, id: m.id });
            banner({ id: "ai-models", icon: "check", text: `${m.name} updated.` });
          } catch (e) {
            banner({ id: "ai-models", tone: "warn", icon: "alert", text: `Update failed: ${e}` });
          } finally {
            task.end();
            check();
          }
        };
        r.querySelector(".bin-act")!.append(u);
      }
      return r;
    }));
  }
  btn.onclick = check;
  return card;
}
