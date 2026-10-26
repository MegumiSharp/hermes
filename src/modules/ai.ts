// Shared AI runtime (Python + PyTorch CUDA) for Demucs and faster-whisper. Backend: python.rs.
// Nothing installs without the user's confirmation of components and sizes.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTask, taskRunning } from "../activity";
import { banner, h, modal } from "../core";
import { icon } from "../icons";

export type Feature = "demucs" | "whisper";
const NAMES: Record<Feature, string> = { demucs: "Demucs", whisper: "faster-whisper" };
const SIZES: Record<Feature, string> = { demucs: "about 60 MB", whisper: "about 150 MB" };

type Status = { installed: Record<string, boolean> };

export async function runtimeReady(f: Feature): Promise<boolean> {
  const s = await invoke<Status>("python_status");
  return !!(s.installed.torch && s.installed[f]);
}

function confirm(title: string, body: HTMLElement, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false;
    modal({ title, body, onClose: () => resolve(yes), actions: [{ label: "Cancel" }, { label: ok, primary: true, run: () => { yes = true; } }] });
  });
}

/** Asks, then installs the runtime pieces `f` needs. Resolves true when ready. */
export async function installRuntime(f: Feature): Promise<boolean> {
  const s = await invoke<Status>("python_status");
  const items = [
    ...(s.installed.torch ? [] : [["Python 3.12 (portable)", "11 MB"], ["PyTorch with CUDA, shared by Demucs and faster-whisper", "about 2.5 GB download, 4.5 GB on disk"]]),
    [NAMES[f], SIZES[f]],
  ];
  const body = h(`<div><p>Hermes will download and install into <span class="mono">hermes-data\\python</span>:</p><ul class="steps"></ul>
    <p class="sub">Takes a few minutes. AI models are downloaded separately, on first use, after another confirmation.</p></div>`);
  body.querySelector("ul")!.append(...items.map(([n, size]) => { const li = document.createElement("li"); li.textContent = `${n} · ${size}`; return li; }));
  if (!(await confirm(`Install ${NAMES[f]}?`, body, "Install"))) return false;

  // Runs in the background: progress is in the sidebar, every tool stays usable meanwhile.
  const task = startTask(`runtime-${f}`, `Installing ${NAMES[f]}`, f);
  const un = await listen<{ stage: string; detail: string; pct: number | null }>("python-progress", ({ payload: p }) => {
    task.update(p.pct, p.detail ? `${p.stage} · ${p.detail.slice(0, 120)}` : p.stage);
  });
  banner({ id: "ai-runtime", icon: "info", text: `Installing ${NAMES[f]} in the background. You can keep working; progress is in the sidebar.` });
  try {
    await invoke("python_install", { features: [f] });
    banner({ id: "ai-runtime", icon: "check", text: `${NAMES[f]} installed.` });
    window.dispatchEvent(new Event("hermes:runtime"));
    return true;
  } catch (e) {
    banner({ id: "ai-runtime", tone: "warn", icon: "alert", text: `Installation failed: ${e}` });
    return false;
  } finally {
    un();
    task.end();
  }
}

/** Notice shown by a module while its runtime is missing; calls `onReady` after installing. */
export function runtimeNotice(f: Feature, onReady: () => void): HTMLElement {
  const el = h(`<div class="notice" hidden>${icon("info")}<span>${NAMES[f]} needs the AI runtime (Python + PyTorch). Nothing is installed until you confirm.</span>
    <button class="btn sm primary">Install</button></div>`);
  const btn = el.querySelector("button")!;
  const refresh = async () => {
    if (!el.isConnected && started) return window.removeEventListener("hermes:runtime", refresh);
    started = true;
    const ok = await runtimeReady(f);
    el.hidden = ok;
    btn.disabled = taskRunning(`runtime-${f}`);
    btn.textContent = btn.disabled ? "Installing" : "Install";
    if (ok) onReady();
  };
  let started = false;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Installing";
    await installRuntime(f);
    refresh();
  };
  window.addEventListener("hermes:runtime", refresh);
  refresh();
  return el;
}

/** Confirmation before a model downloads on first use. */
export function confirmModelDownload(what: string, size: string): Promise<boolean> {
  const body = h(`<p></p>`);
  body.textContent = `The ${what} model (${size}) will be downloaded on first use and kept in hermes-data\\models.`;
  return confirm("Download model?", body, "Download and continue");
}
