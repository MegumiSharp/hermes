// Shared services every module uses: settings, banners, modals.
import { invoke } from "@tauri-apps/api/core";
import { icon, IconName } from "./icons";

// ---------- settings (hermes-data/settings.json) ----------
export const settings: Record<string, any> = await invoke("load_settings");

let pending: ReturnType<typeof setTimeout> | undefined;

export function saveSettings(patch: Record<string, any>) {
  Object.assign(settings, patch);
  clearTimeout(pending);
  pending = undefined;
  return invoke("save_settings", { settings });
}

/** For keystroke-level changes (URL fields): coalesces writes, flushed on close by `flushSettings`. */
export function saveSettingsSoon(patch: Record<string, any>) {
  Object.assign(settings, patch);
  clearTimeout(pending);
  pending = setTimeout(() => saveSettings({}), 300);
}

export async function flushSettings() {
  if (pending) await saveSettings({});
}

/**
 * Module state that survives closing the app (SPEC: nothing typed or picked is ever lost).
 * Returns the stored object merged over `defaults`; call `save()` after changing it
 * (`save(true)` for typing, debounced).
 * Same object for the same key on every call: async work started on an earlier visit to a tool
 * (a probe, a download list) must not save a stale copy over what was changed since.
 */
const memories = new Map<string, { state: any; save: (soon?: boolean) => void }>();
export function memory<T extends object>(key: string, defaults: T): { state: T; save: (soon?: boolean) => void } {
  let m = memories.get(key);
  if (!m) {
    const state = { ...defaults, ...settings[key] } as T;
    memories.set(key, (m = { state, save: (soon) => (soon ? saveSettingsSoon : saveSettings)({ [key]: state }) }));
  }
  return m;
}

/** What each tool's "Clear" button resets besides its queue (trays, results, URLs). Tools register
 *  this when they render; main.ts calls it, then re-renders the tool. */
export const clearers = new Map<string, () => void>();

/** Switches the sidebar module (main.ts listens), usable from banners without importing main. */
export const navigate = (id: string) => window.dispatchEvent(new CustomEvent("hermes:open", { detail: id }));

// ---------- tiny DOM helper ----------
export function h(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

/** `run` may be async; returning `false` keeps the banner/modal open. */
type Action = { label: string; primary?: boolean; run?: () => unknown };

function buttons(actions: Action[], close: () => void) {
  return actions.map((a) => {
    const b = h(`<button class="btn sm ${a.primary ? "primary" : "ghost"}"></button>`) as HTMLButtonElement;
    b.textContent = a.label;
    b.onclick = async () => {
      b.disabled = true;
      const keep = (await a.run?.()) === false;
      b.disabled = false;
      if (!keep) close();
    };
    return b;
  });
}

// ---------- banners: one per id, replaced if shown again ----------
export function banner(o: { id: string; text: string; icon?: IconName; tone?: "accent" | "warn"; actions?: Action[] }) {
  document.querySelector(`[data-banner="${o.id}"]`)?.remove();
  const el = h(`<div class="banner ${o.tone ?? "accent"}" data-banner="${o.id}">${icon(o.icon ?? "info")}<span class="txt"></span><div class="acts"></div></div>`);
  el.querySelector(".txt")!.innerHTML = o.text;
  const close = () => el.remove();
  el.querySelector(".acts")!.append(...buttons(o.actions ?? [{ label: "Dismiss" }], close));
  document.getElementById("banners")!.append(el);
  return close;
}

// ---------- modals ----------
export function modal(o: { title: string; body: string | HTMLElement; actions?: Action[]; onClose?: () => void }) {
  const el = h(`<div class="overlay"><div class="modal" role="dialog" aria-modal="true">
    <div class="m-head"><h3></h3><button class="btn sm ghost" aria-label="Close">${icon("x")}</button></div>
    <div class="m-body"></div><div class="m-foot"></div></div></div>`);
  const close = () => {
    if (!el.isConnected) return;
    el.remove();
    document.removeEventListener("keydown", esc);
    o.onClose?.();
  };
  const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
  el.querySelector("h3")!.textContent = o.title;
  el.querySelector(".m-head button")!.addEventListener("click", close);
  // block body: an onclick that returns false cancels the click (checkboxes inside would never toggle)
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector(".m-body")!.append(o.body);
  el.querySelector(".m-foot")!.append(...buttons(o.actions ?? [{ label: "Close", primary: true }], close));
  document.addEventListener("keydown", esc);
  document.body.append(el);
  return close;
}
