// Per-tool backdrops: a transparent image drawn faintly behind the tool's page (backdrop-looks.ts).
// settings.backdrops[toolId] = Look; images are copied to hermes-data/backdrops. `showBackdrop(id)`
// on every tool switch, `backdropButton(id, name)` = the header button that opens the editor panel.
import { invoke } from "@tauri-apps/api/core";
import { h, settings, saveSettingsSoon } from "./core";
import { icon } from "./icons";
import { DEFAULT_LOOK, Look, render, SAMPLE, STYLES, tintCss } from "./backdrop-looks";
import { dropZone, paths } from "./modules/common";

type Img = CanvasImageSource & { width: number; height: number };
const looks = (): Record<string, Look> => (settings.backdrops ??= {});
const lookOf = (id: string): Look => ({ ...DEFAULT_LOOK, ...looks()[id] });
const images = new Map<string, Promise<Img>>();
function image(file: string): Promise<Img> {
  if (!images.has(file)) images.set(file, file === "sample"
    ? new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(SAMPLE); })
    : invoke<ArrayBuffer>("read_file", { path: file }).then((b) => createImageBitmap(new Blob([b])))); // read_file: asset URLs would taint the canvas
  return images.get(file)!;
}

let layer: HTMLElement | null = null;
let current = "";
let ticket = 0;

/** The layer lives in .content, behind #view; it follows the visible area, not the scroll. */
function mount(): HTMLElement {
  if (layer) return layer;
  const content = document.querySelector<HTMLElement>(".content")!;
  layer = h(`<div class="backdrop" aria-hidden="true"><canvas></canvas></div>`);
  content.prepend(layer);
  new ResizeObserver(() => draw()).observe(content);
  return layer;
}

async function draw() {
  const el = mount(), cv = el.querySelector("canvas")!, content = el.parentElement!;
  const l = lookOf(current), id = ++ticket;
  content.classList.toggle("has-backdrop", !!l.file);
  if (!l.file) { cv.hidden = true; return; }
  let img: Img;
  try { img = await image(l.file); } catch { if (id === ticket) cv.hidden = true; return; }
  if (id !== ticket) return;
  const r = content.getBoundingClientRect();
  Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const hh = Math.max(1, Math.round((r.height * l.size) / 100)), w = Math.max(1, Math.round((hh * img.width) / img.height));
  const out = render(img, w, hh, l);
  cv.width = w; cv.height = hh;
  cv.getContext("2d")!.drawImage(out, 0, 0);
  cv.hidden = false;
  cv.style.opacity = String(l.opacity / 100);
  cv.style.left = l.pos === "left" ? "0" : l.pos === "center" ? `${(r.width - w) / 2}px` : "";
  cv.style.right = l.pos === "right" ? "0" : "";
  const dir = l.pos === "left" ? "to right" : l.pos === "right" ? "to left" : "to top";
  cv.style.maskImage = l.fade ? `linear-gradient(${dir}, #000 35%, transparent 95%)` : "none";
  cv.style.filter = [l.blur ? `blur(${l.blur}px)` : "", l.style === "glow" ? `drop-shadow(0 0 6px ${tintCss(l)})` : ""].join(" ").trim();
}

export function showBackdrop(id: string) {
  current = id;
  draw();
}

function save(id: string, l: Look) {
  looks()[id] = l;
  saveSettingsSoon({ backdrops: looks() });
  if (id === current) draw();
}

// ---------- editor panel (beside the page, so the result is visible while editing) ----------
let panel: HTMLElement | null = null;
export function closeBackdropEditor() { panel?.remove(); panel = null; }

function openEditor(id: string, name: string, tools: string[]) {
  closeBackdropEditor();
  panel = h(`<aside class="bd-panel" id="bd-panel">
    <div class="bd-top"><div><h4>Backdrop</h4><div class="sub"></div></div><button class="btn sm ghost" id="bd-close" title="Close">${icon("x")}</button></div>
    <div class="bd-drop"></div>
    <div class="bd-row"><button class="btn sm" id="bd-sample">Sample</button><button class="btn sm" id="bd-none">${icon("trash")}None</button><button class="btn sm" id="bd-all" title="Use this image and look on every tool">Apply to all tools</button></div>
    <div><div class="field-label">Style</div><div class="seg bd-styles">${STYLES.map(([v, t]) => `<button data-style="${v}">${t}</button>`).join("")}</div></div>
    <div class="pt-sliders">
      ${[["opacity", "Visibility", 4, 60, "%"], ["size", "Size", 40, 130, "%"], ["detail", "Detail", 0, 100, ""], ["blur", "Softness", 0, 12, " px"]].map(([k, t, a, b]) =>
        `<div class="pt-slider"><div class="pt-slider-top"><span>${t}</span><span class="mono pt-val" data-val="${k}"></span></div><input type="range" class="range" data-key="${k}" min="${a}" max="${b}" step="1"></div>`).join("")}
    </div>
    <div><div class="field-label">Position</div><div class="seg bd-seg" id="bd-pos"><button data-pos="left">Left</button><button data-pos="center">Center</button><button data-pos="right">Right</button></div></div>
    <div><div class="field-label">Colour</div><div class="seg bd-seg" id="bd-tint"><button data-tint="accent">Amber</button><button data-tint="white">White</button><button data-tint="original">Image colours</button></div></div>
    <label class="check"><input type="checkbox" id="bd-fade"><span class="box">${icon("check")}</span>Fade towards the content</label>
    <label class="check"><input type="checkbox" id="bd-flip"><span class="box">${icon("check")}</span>Mirror</label>
  </aside>`);
  panel.querySelector(".sub")!.textContent = `${name} · its own image, drawn faintly behind the page`;
  const units: Record<string, string> = { opacity: "%", size: "%", detail: "", blur: " px" };
  const sync = () => {
    const l = lookOf(id);
    panel!.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === l.style));
    panel!.querySelectorAll<HTMLButtonElement>("[data-pos]").forEach((b) => b.classList.toggle("on", b.dataset.pos === l.pos));
    panel!.querySelectorAll<HTMLButtonElement>("[data-tint]").forEach((b) => b.classList.toggle("on", b.dataset.tint === l.tint));
    panel!.querySelectorAll<HTMLInputElement>("[data-key]").forEach((i) => {
      const k = i.dataset.key as "opacity";
      i.value = String(l[k]);
      panel!.querySelector(`[data-val="${k}"]`)!.textContent = l[k] + units[k];
    });
    panel!.querySelector<HTMLInputElement>("#bd-fade")!.checked = l.fade;
    panel!.querySelector<HTMLInputElement>("#bd-flip")!.checked = l.flip;
    panel!.classList.toggle("empty", !l.file);
  };
  const set = (patch: Partial<Look>) => { save(id, { ...lookOf(id), ...patch }); sync(); };

  panel.querySelector(".bd-drop")!.append(dropZone({ id: "bd-drop", label: "Drop a transparent PNG", exts: ["png", "webp"], paste: true }, async ([path]) => {
    const { data } = await paths;
    const to = `${data}\\backdrops\\${id}-${Date.now()}.${path.split(".").pop()!.toLowerCase()}`; // ponytail: old images stay on disk (small); clean up if it matters
    await invoke("copy_file", { from: path, to });
    set({ file: to });
  }));
  panel.querySelector<HTMLElement>("#bd-close")!.onclick = closeBackdropEditor;
  panel.querySelector<HTMLElement>("#bd-sample")!.onclick = () => set({ file: "sample" });
  panel.querySelector<HTMLElement>("#bd-none")!.onclick = () => set({ file: "" });
  panel.querySelector<HTMLElement>("#bd-all")!.onclick = () => { const l = lookOf(id); for (const t of tools) looks()[t] = { ...l }; save(id, l); };
  panel.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-style],[data-pos],[data-tint]");
    if (!b) return;
    if (b.dataset.style) set({ style: b.dataset.style as Look["style"] });
    if (b.dataset.pos) set({ pos: b.dataset.pos as Look["pos"] });
    if (b.dataset.tint) set({ tint: b.dataset.tint as Look["tint"] });
  };
  let frame = 0;
  panel.querySelectorAll<HTMLInputElement>("[data-key]").forEach((i) => (i.oninput = () => {
    panel!.querySelector(`[data-val="${i.dataset.key}"]`)!.textContent = i.value + units[i.dataset.key!];
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => set({ [i.dataset.key!]: Number(i.value) }));
  }));
  panel.querySelector<HTMLInputElement>("#bd-fade")!.onchange = (e) => set({ fade: (e.target as HTMLInputElement).checked });
  panel.querySelector<HTMLInputElement>("#bd-flip")!.onchange = (e) => set({ flip: (e.target as HTMLInputElement).checked });
  sync();
  document.querySelector(".body")!.append(panel);
}

/** Header button of each tool: opens (or closes) the backdrop editor for it. */
export function backdropButton(id: string, name: string, tools: () => string[]): HTMLElement {
  const b = h(`<button class="btn sm ghost" data-backdrop title="Set a background image for this tool">${icon("image")}Backdrop</button>`);
  b.onclick = () => (panel ? closeBackdropEditor() : openEditor(id, name, tools()));
  return b;
}
