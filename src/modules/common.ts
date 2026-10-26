// Controls shared by tool modules: output folder, Eagle toggle, file drop zone, before/after slider.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h } from "../core";
import { icon } from "../icons";
import { Job, watchJobs } from "../queue";

export type Paths = { data: string; bin: string; results: string };
export const paths: Promise<Paths> = invoke("module_paths");

/** "Save to" field; fills `prefs.folder` with Downloads\Hermes on first use. */
export function folderField(prefs: { folder: string }, save: () => void, id: string): HTMLElement {
  const el = h(`<div class="opt"><span class="field-label">Save to</span>
    <button class="field folder" id="${id}">${icon("folder")}<span class="v mono"></span></button></div>`);
  const label = el.querySelector(".v")!;
  (async () => {
    if (!prefs.folder) {
      prefs.folder = await join(await downloadDir(), "Hermes");
      save();
    }
    label.textContent = prefs.folder;
  })();
  el.querySelector("button")!.onclick = async () => {
    const dir = await openDialog({ directory: true, defaultPath: prefs.folder });
    if (typeof dir === "string") {
      prefs.folder = dir;
      label.textContent = dir;
      save();
    }
  };
  return el;
}

/** "Send to Eagle" checkbox + live connection chip (polls every 5 s while on screen). */
export function eagleControls(prefs: { eagle: boolean }, save: () => void, id: string): HTMLElement[] {
  const box = h(`<label class="check"><input type="checkbox" id="${id}"><span class="box">${icon("check")}</span>Send to Eagle<span class="s">Uncategorized</span></label>`);
  const input = box.querySelector("input")!;
  input.checked = prefs.eagle;
  input.onchange = () => { prefs.eagle = input.checked; save(); };
  const chip = h(`<span class="chip" id="${id}-state"><span class="dot"></span><span></span></span>`);
  const poll = async () => {
    if (!chip.isConnected && started) return clearInterval(timer);
    started = true;
    const on = await invoke<boolean>("eagle_status");
    chip.classList.toggle("bad", !on);
    chip.lastElementChild!.textContent = on ? "Eagle connected" : "Eagle closed";
  };
  let started = false;
  const timer = setInterval(poll, 5000);
  poll();
  return [box, chip];
}

const lower = (p: string) => p.toLowerCase();

/** Drop zone + Browse button. Dropped files arrive as bytes (webview), so they are saved to
 *  hermes-data/uploads first; browsed files keep their real path. Calls `onFiles(paths)`. */
export function dropZone(o: { id: string; label: string; exts: string[]; multiple?: boolean }, onFiles: (paths: string[]) => void): HTMLElement {
  const el = h(`<div class="drop big" id="${o.id}" tabindex="0">${icon("download")}<span></span>
    <button class="btn sm" type="button">${icon("folder")}Browse</button></div>`);
  el.querySelector("span")!.textContent = o.label;
  const ok = (name: string) => o.exts.some((e) => lower(name).endsWith(`.${e}`));
  el.ondragover = (e) => { e.preventDefault(); el.classList.add("over"); };
  el.ondragleave = () => el.classList.remove("over");
  el.ondrop = async (e) => {
    e.preventDefault();
    el.classList.remove("over");
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => ok(f.name)).slice(0, o.multiple ? undefined : 1);
    const saved = await Promise.all(files.map(async (f) =>
      invoke<string>("save_upload", new Uint8Array(await f.arrayBuffer()), { headers: { "x-name": encodeURIComponent(f.name) } })));
    if (saved.length) onFiles(saved);
  };
  el.querySelector("button")!.onclick = async () => {
    const picked = await openDialog({ multiple: !!o.multiple, filters: [{ name: "Supported files", extensions: o.exts }] });
    const list = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(ok);
    if (list.length) onFiles(list);
  };
  return el;
}

/** Before/after comparison: drag anywhere (or use arrow keys) to move the divider. */
export function beforeAfter(before: string, after: string, labels = ["Before", "After"]): HTMLElement {
  const el = h(`<div class="ba" tabindex="0" role="slider" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
    <img class="ba-after" alt=""><div class="ba-before"><img alt=""></div>
    <div class="ba-line"><span>${icon("chevronRight")}</span></div>
    <span class="ba-tag l">${labels[0]}</span><span class="ba-tag r">${labels[1]}</span></div>`);
  el.querySelector<HTMLImageElement>(".ba-after")!.src = convertFileSrc(after);
  el.querySelector<HTMLImageElement>(".ba-before img")!.src = convertFileSrc(before);
  const set = (pct: number) => {
    pct = Math.max(0, Math.min(100, pct));
    el.style.setProperty("--pos", `${pct}%`);
    el.setAttribute("aria-valuenow", String(Math.round(pct)));
  };
  const fromEvent = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 100);
  };
  el.onpointerdown = (e) => { el.setPointerCapture(e.pointerId); fromEvent(e); };
  el.onpointermove = (e) => { if (el.hasPointerCapture(e.pointerId)) fromEvent(e); };
  el.onkeydown = (e) => {
    const now = Number(el.getAttribute("aria-valuenow"));
    if (e.key === "ArrowLeft") set(now - 5);
    if (e.key === "ArrowRight") set(now + 5);
  };
  set(50);
  return el;
}

const IMAGE = /\.(png|jpe?g|webp|bmp)$/i;

/** Finished image jobs of a module: thumbnails + a before/after slider of the selected one. */
export function resultsPanel(module: string): HTMLElement {
  const el = h(`<div class="results" hidden><div class="qhead"><h4>Results</h4><span class="count"></span></div>
    <div class="r-view"></div><div class="r-strip"></div></div>`);
  let current = "";
  const view = el.querySelector(".r-view")!;
  const strip = el.querySelector(".r-strip")!;
  const show = (j: Job) => {
    current = j.id;
    view.replaceChildren(beforeAfter(j.source, j.outputs.at(-1)!, ["Original", "Result"]));
    strip.querySelectorAll(".r-thumb").forEach((t) => t.classList.toggle("on", (t as HTMLElement).dataset.id === j.id));
  };
  let mounting = true; // first call runs before the panel is in the page
  watchJobs((all) => {
    const done = all.filter((j) => j.module === module && j.state === "done" && j.source && IMAGE.test(j.outputs.at(-1) ?? "")).reverse().slice(0, 24);
    el.hidden = !done.length;
    el.querySelector(".count")!.textContent = done.length ? `${done.length} recent` : "";
    strip.replaceChildren(...done.map((j) => {
      const t = h(`<button type="button" class="r-thumb" data-id="${j.id}"><img alt=""></button>`);
      t.title = j.title;
      const img = t.querySelector("img")!;
      img.src = convertFileSrc(j.outputs.at(-1)!);
      img.onerror = () => t.remove(); // result was moved or deleted
      t.onclick = () => show(j);
      return t;
    }));
    const pick = done.find((j) => j.id === current) ?? done[0];
    if (pick && pick.id !== current) show(pick);
  }, () => mounting || el.isConnected);
  mounting = false;
  return el;
}

/** File name for display; drops the timestamp prefix `save_upload` adds to dropped files. */
export const fileName = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/^\d{13}-/, "");
export const stem = (p: string) => fileName(p).replace(/\.[^.]+$/, "");
