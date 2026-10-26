import "@fontsource-variable/inter";
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { icon, IconName } from "./icons";
import { h, settings, saveSettings } from "./core";
import { checkForUpdate, startUpdateChecks } from "./update";
import { renderBinaries, startBinaryChecks } from "./binaries";
import { renderVideo } from "./modules/video";
import { renderGallery } from "./modules/gallery";
import { renderRembg } from "./modules/rembg";
import { renderUpscale } from "./modules/upscale";

type Module = {
  id: string;
  name: string;
  icon: IconName;
  section: "tools" | "system";
  render(view: HTMLElement): void;
};

// Module registry: the only place that knows about every module.
const modules: Module[] = [
  { id: "video", name: "Video Downloader", icon: "download", section: "tools", render: renderVideo },
  { id: "gallery", name: "Gallery Downloader", icon: "image", section: "tools", render: renderGallery },
  { id: "rembg", name: "Background Removal", icon: "scissors", section: "tools", render: renderRembg },
  { id: "upscale", name: "Upscale", icon: "maximize", section: "tools", render: renderUpscale },
  { id: "binaries", name: "Binaries", icon: "layers", section: "system", render: renderBinaries },
  { id: "settings", name: "Settings", icon: "sliders", section: "system", render: renderSettings },
];

const version = await getVersion();

async function renderSettings(view: HTMLElement) {
  const path: string = await invoke("data_path");
  const el = h(`<div class="page">
    <div class="head"><h3>Settings</h3></div>
    <div class="card"><div class="row"><div><div class="k">Version</div><div class="v mono">Hermes ${version}</div></div></div>
    <div class="row"><div><div class="k">Data folder</div><div class="v mono" id="data-path"></div></div><button class="btn sm" id="open-data">${icon("folder")}Open</button></div>
    <div class="row"><div><div class="k">Updates</div><div class="v" id="update-status">Checked automatically on launch and every 6 hours</div></div><button class="btn sm" id="check-update">${icon("refresh")}Check now</button></div></div>
  </div>`);
  el.querySelector("#data-path")!.textContent = path;
  (el.querySelector("#open-data") as HTMLElement).onclick = () => revealItemInDir(path);
  const status = el.querySelector("#update-status")!;
  const btn = el.querySelector("#check-update") as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true;
    status.textContent = "Checking";
    try {
      const u = await checkForUpdate();
      status.textContent = u ? `Hermes ${u.version} is available` : "You are on the latest version";
    } catch (e) {
      status.textContent = `Check failed: ${e}`;
    }
    btn.disabled = false;
  };
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

window.addEventListener("hermes:open", (e) => open((e as CustomEvent<string>).detail));
open(settings.lastModule);
startUpdateChecks();
startBinaryChecks();
