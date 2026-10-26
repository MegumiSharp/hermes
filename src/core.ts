// Shared services every module uses: settings, banners, modals.
import { invoke } from "@tauri-apps/api/core";
import { icon, IconName } from "./icons";

// ---------- settings (hermes-data/settings.json) ----------
export const settings: Record<string, any> = await invoke("load_settings");

export function saveSettings(patch: Record<string, any>) {
  Object.assign(settings, patch);
  return invoke("save_settings", { settings });
}

/** Switches the sidebar module (main.ts listens), usable from banners without importing main. */
export const navigate = (id: string) => window.dispatchEvent(new CustomEvent("hermes:open", { detail: id }));

// ---------- tiny DOM helper ----------
export function h(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

type Action = { label: string; primary?: boolean; run?: () => void };

function buttons(actions: Action[], close: () => void) {
  return actions.map((a) => {
    const b = h(`<button class="btn sm ${a.primary ? "primary" : "ghost"}"></button>`);
    b.textContent = a.label;
    b.onclick = () => { a.run?.(); close(); };
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
export function modal(o: { title: string; body: string | HTMLElement; actions?: Action[] }) {
  const el = h(`<div class="overlay"><div class="modal" role="dialog" aria-modal="true">
    <div class="m-head"><h3></h3><button class="btn sm ghost" aria-label="Close">${icon("x")}</button></div>
    <div class="m-body"></div><div class="m-foot"></div></div></div>`);
  const close = () => { el.remove(); document.removeEventListener("keydown", esc); };
  const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
  el.querySelector("h3")!.textContent = o.title;
  el.querySelector(".m-head button")!.addEventListener("click", close);
  el.onclick = (e) => e.target === el && close();
  el.querySelector(".m-body")!.append(o.body);
  el.querySelector(".m-foot")!.append(...buttons(o.actions ?? [{ label: "Close", primary: true }], close));
  document.addEventListener("keydown", esc);
  document.body.append(el);
  return close;
}
