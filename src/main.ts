import "@fontsource-variable/inter";
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { icon, IconName } from "./icons";
import { h, settings, saveSettings } from "./core";

type Module = {
  id: string;
  name: string;
  icon: IconName;
  section: "tools" | "system";
  render(view: HTMLElement): void;
};

const soon = (title: string, tranche: string) => (view: HTMLElement) => {
  view.append(h(`<div class="empty">${icon("layers")}<h3>${title}</h3><p>Arrives in tranche ${tranche}.</p></div>`));
};

// Module registry: the only place that knows about every module.
const modules: Module[] = [
  { id: "video", name: "Video Downloader", icon: "download", section: "tools", render: soon("Video Downloader", "T4") },
  { id: "gallery", name: "Gallery Downloader", icon: "image", section: "tools", render: soon("Gallery Downloader", "T5") },
  { id: "rembg", name: "Background Removal", icon: "scissors", section: "tools", render: soon("Background Removal", "T6") },
  { id: "upscale", name: "Upscale", icon: "maximize", section: "tools", render: soon("Upscale", "T7") },
  { id: "binaries", name: "Binaries", icon: "layers", section: "system", render: soon("Binaries", "T3") },
  { id: "settings", name: "Settings", icon: "sliders", section: "system", render: renderSettings },
];

const version = await getVersion();

async function renderSettings(view: HTMLElement) {
  const path: string = await invoke("data_path");
  const el = h(`<div class="page">
    <div class="head"><h3>Settings</h3></div>
    <div class="card"><div class="row"><div><div class="k">Version</div><div class="v mono">Hermes ${version}</div></div></div>
    <div class="row"><div><div class="k">Data folder</div><div class="v mono"></div></div><button class="btn sm">${icon("folder")}Open</button></div></div>
  </div>`);
  el.querySelector(".row:nth-child(2) .v")!.textContent = path;
  el.querySelector("button")!.onclick = () => revealItemInDir(path);
  view.append(el);
}

function open(id: string) {
  const mod = modules.find((m) => m.id === id) ?? modules[0];
  document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("on", (n as HTMLElement).dataset.id === mod.id));
  const view = document.getElementById("view")!;
  view.replaceChildren();
  mod.render(view);
  if (settings.lastModule !== mod.id) saveSettings({ lastModule: mod.id });
}

// ---------- sidebar ----------
const side = document.getElementById("side")!;
for (const section of ["tools", "system"] as const) {
  if (section === "tools") side.append(h(`<div class="label">Tools</div>`));
  else side.append(h(`<div class="spacer"></div>`));
  for (const m of modules.filter((m) => m.section === section)) {
    const n = h(`<button class="nav" data-id="${m.id}">${icon(m.icon)}<span>${m.name}</span></button>`);
    n.onclick = () => open(m.id);
    side.append(n);
  }
}

// ---------- title bar ----------
const win = getCurrentWindow();
document.getElementById("mark")!.innerHTML = icon("feather");
document.getElementById("ver")!.textContent = version;
const wc = (id: string, ic: IconName, fn: () => void) => {
  const b = document.getElementById(id)!;
  b.innerHTML = icon(ic);
  b.onclick = fn;
};
wc("wc-min", "minus", () => win.minimize());
wc("wc-max", "square", () => win.toggleMaximize());
wc("wc-close", "x", () => win.close());

open(settings.lastModule);
