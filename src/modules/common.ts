// Controls shared by tool modules: output folder, Eagle toggle, file tray (drop / browse / paste +
// per-file status), system stats, zoomable before/after slider, result viewer.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { banner, h, modal, settings } from "../core";
import { icon, IconName } from "../icons";
import { Job, queueAction, showError, watchJobs } from "../queue";

export type Paths = { data: string; bin: string; results: string; python: string };
export const paths: Promise<Paths> = invoke("module_paths");

/** File name for display (drops the timestamp prefix older uploads had). */
export const fileName = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/^\d{13}-/, "");
export const stem = (p: string) => fileName(p).replace(/\.[^.]+$/, "");
const IMAGE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const VIDEO = /\.(mp4|mkv|mov|webm|avi|m4v)$/i;

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

/** "Send to Eagle" checkbox + connection chip. Polls every 5 s while on screen; only reports
 *  "closed" after two failed checks in a row, so a busy Eagle doesn't make it flicker. */
export function eagleControls(prefs: { eagle: boolean }, save: () => void, id: string): HTMLElement[] {
  const box = h(`<label class="check"><input type="checkbox" id="${id}"><span class="box">${icon("check")}</span>Send to Eagle<span class="s">Uncategorized</span></label>`);
  const input = box.querySelector("input")!;
  input.checked = prefs.eagle;
  input.onchange = () => { prefs.eagle = input.checked; save(); };
  const chip = h(`<span class="chip" id="${id}-state"><span class="dot"></span><span>Checking Eagle</span></span>`);
  let fails = 0;
  let started = false;
  const poll = async () => {
    if (started && !chip.isConnected) return clearInterval(timer);
    started = true;
    const on = await invoke<boolean>("eagle_status");
    fails = on ? 0 : fails + 1;
    if (on || fails >= 2) {
      chip.classList.toggle("bad", !on);
      chip.lastElementChild!.textContent = on ? "Eagle connected" : "Eagle closed";
    }
  };
  const timer = setInterval(poll, 5000);
  poll();
  return [box, chip];
}

const lower = (p: string) => p.toLowerCase();

/** Saves dropped/pasted bytes to hermes-data/uploads/<ms>/<name>; returns the path. */
const upload = async (f: File | Blob, name: string) =>
  invoke<string>("save_upload", new Uint8Array(await f.arrayBuffer()), { headers: { "x-name": encodeURIComponent(name) } });

/** Drop zone + Browse (+ optional Paste). Dropped/pasted files arrive as bytes and are saved to
 *  hermes-data/uploads; browsed files keep their real path. Calls `onFiles(paths)`. */
export function dropZone(
  o: { id: string; label: string; exts: string[]; multiple?: boolean; paste?: boolean },
  onFiles: (paths: string[]) => void,
): HTMLElement {
  const el = h(`<div class="drop big" id="${o.id}" tabindex="0">${icon("download")}<span></span>
    <button class="btn sm" type="button" data-browse>${icon("folder")}Browse</button>
    ${o.paste ? `<button class="btn sm" type="button" data-paste title="Paste an image or files (Ctrl+V)">${icon("clipboard")}Paste</button>` : ""}</div>`);
  el.querySelector("span")!.textContent = o.paste ? `${o.label} or press Ctrl+V` : o.label;
  const ok = (name: string) => o.exts.some((e) => lower(name).endsWith(`.${e}`));
  const take = async (files: { blob: Blob; name: string }[]) => {
    const list = files.filter((f) => ok(f.name)).slice(0, o.multiple ? undefined : 1);
    const saved = await Promise.all(list.map((f) => upload(f.blob, f.name)));
    if (saved.length) onFiles(saved);
    else if (files.length) banner({ id: "drop", tone: "warn", icon: "alert", text: `Unsupported file type. Use ${o.exts.join(", ")}.` });
  };
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  el.ondragover = (e) => { e.preventDefault(); el.classList.add("over"); };
  el.ondragleave = () => el.classList.remove("over");
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove("over");
    take([...(e.dataTransfer?.files ?? [])].map((f) => ({ blob: f, name: f.name })));
  };
  el.querySelector<HTMLButtonElement>("[data-browse]")!.onclick = async () => {
    const picked = await openDialog({ multiple: !!o.multiple, filters: [{ name: "Supported files", extensions: o.exts }] });
    const list = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(ok);
    if (list.length) onFiles(list);
  };
  if (o.paste) {
    // Ctrl+V anywhere on the page: copied files (Explorer) or a copied/screenshotted image
    const onPaste = (e: ClipboardEvent) => {
      if (!el.isConnected) return document.removeEventListener("paste", onPaste);
      if (!el.offsetParent) return; // a hidden tab's drop zone (e.g. Compare while on Batch)
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return; // pasting text
      const files = [...(e.clipboardData?.files ?? [])].map((f) => ({ blob: f as Blob, name: f.name === "image.png" ? `pasted-${stamp()}.png` : f.name }));
      if (files.length) { e.preventDefault(); take(files); }
    };
    document.addEventListener("paste", onPaste);
    el.querySelector<HTMLButtonElement>("[data-paste]")!.onclick = async () => {
      try {
        const items = await navigator.clipboard.read();
        const files: { blob: Blob; name: string }[] = [];
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith("image/"));
          if (type) files.push({ blob: await it.getType(type), name: `pasted-${stamp()}.${type.split("/")[1]}` });
        }
        if (files.length) take(files);
        else banner({ id: "drop", tone: "warn", icon: "alert", text: "The clipboard has no image. Copy an image (or files in Explorer and press Ctrl+V)." });
      } catch {
        banner({ id: "drop", tone: "warn", icon: "alert", text: "Clipboard access was blocked. Press Ctrl+V instead." });
      }
    };
  }
  return el;
}

// ---------- file tray ----------

export type TrayItem = { path: string; job?: string };

/**
 * Inputs of a module as thumbnails with their live status. Items stay until they succeed
 * (failed ones keep their error, copyable, and run again with the module's button).
 * `items()`/`setItems()` read and persist the list.
 */
export function fileTray(
  o: { id: string; label: string; exts: string[]; multiple?: boolean; paste?: boolean },
  items: () => TrayItem[],
  setItems: (list: TrayItem[]) => void,
  onChange: () => void,
) {
  const el = h(`<div class="tray-wrap"><div class="tray-drop"></div>
    <div class="tray-bar" hidden><span class="sub tray-count"></span>
      <button class="btn sm ghost" data-clear-done>Clear finished</button><button class="btn sm ghost" data-clear-all>Clear all</button></div>
    <div class="tray"></div></div>`);
  let jobs: Job[] = [];
  const jobOf = (it: TrayItem) => (it.job ? jobs.find((j) => j.id === it.job) : undefined);
  const stateOf = (it: TrayItem) => jobOf(it)?.state ?? "ready";

  el.querySelector(".tray-drop")!.append(dropZone(o, (p) => {
    const have = new Set(items().map((i) => i.path));
    setItems(o.multiple ? [...items(), ...p.filter((x) => !have.has(x)).map((path) => ({ path }))] : [{ path: p[0] }]);
    render();
    onChange();
  }));
  el.querySelector<HTMLButtonElement>("[data-clear-done]")!.onclick = () => { setItems(items().filter((i) => stateOf(i) !== "done")); render(); onChange(); };
  el.querySelector<HTMLButtonElement>("[data-clear-all]")!.onclick = () => { setItems([]); render(); onChange(); };

  const label: Record<string, string> = {
    ready: "Ready", queued: "Queued", running: "Working", paused: "Paused", waitingEagle: "Waiting for Eagle", done: "Done", failed: "Failed",
  };
  function render() {
    const list = items();
    el.querySelector<HTMLElement>(".tray-bar")!.hidden = !list.length;
    const done = list.filter((i) => stateOf(i) === "done").length;
    const failed = list.filter((i) => stateOf(i) === "failed").length;
    el.querySelector(".tray-count")!.textContent = `${list.length} file${list.length === 1 ? "" : "s"}${done ? ` · ${done} done` : ""}${failed ? ` · ${failed} failed` : ""}`;
    el.querySelector(".tray")!.replaceChildren(...list.map((it) => {
      const j = jobOf(it);
      const st = stateOf(it);
      const card = h(`<div class="tcard ${st}" title="">
        <div class="tthumb">${IMAGE.test(it.path) ? `<img alt="" loading="lazy">` : icon(VIDEO.test(it.path) ? "film" : "music")}
          <span class="tbadge">${icon(st === "done" ? "check" : st === "failed" ? "alert" : st === "ready" ? "clock" : "download")}</span></div>
        <div class="tname"></div><div class="tstate"></div>
        ${st === "running" ? `<div class="bar"><i style="width:${Math.round((j!.step + j!.progress) / Math.max(j!.steps.length, 1) * 100)}%"></i></div>` : ""}
        <div class="tacts">
          ${st === "failed" ? `<button class="btn sm ghost" data-err title="Show and copy the error">${icon("copy")}</button><button class="btn sm ghost" data-retry title="Retry">${icon("retry")}</button>` : ""}
          <button class="btn sm ghost" data-rm title="Remove from list">${icon("x")}</button></div></div>`);
      card.title = it.path;
      card.querySelector(".tname")!.textContent = fileName(it.path);
      card.querySelector(".tstate")!.textContent = st === "running" ? j!.detail || "Working" : st === "done" && j?.note ? `Done · ${j.note}` : label[st];
      const img = card.querySelector("img");
      if (img) {
        img.src = convertFileSrc(it.path);
        img.onerror = () => img.replaceWith(h(icon("image")));
      }
      card.querySelector<HTMLButtonElement>("[data-rm]")!.onclick = () => { setItems(items().filter((x) => x !== it)); render(); onChange(); };
      card.querySelector<HTMLButtonElement>("[data-err]")?.addEventListener("click", () => showError(j!));
      card.querySelector<HTMLButtonElement>("[data-retry]")?.addEventListener("click", () => queueAction(j!.id, "retry"));
      return card;
    }));
  }
  let mounting = true;
  watchJobs((all) => { jobs = all; if (mounting || el.isConnected) render(); }, () => mounting || el.isConnected, true);
  mounting = false;
  return {
    el,
    /** Items to (re)process: never queued, removed from the queue, or failed. */
    pending: () => items().filter((i) => ["ready", "failed"].includes(stateOf(i))),
    /** Links new job ids to items (same order); failed old jobs are cleared from the queue. */
    assign(list: TrayItem[], ids: string[]) {
      list.forEach((it, i) => {
        if (it.job && stateOf(it) === "failed") queueAction(it.job, "remove");
        it.job = ids[i];
      });
      setItems([...items()]);
      render();
    },
    render,
  };
}

// ---------- system stats ----------

type Stats = { cpu: number; ramUsed: number; ramTotal: number; gpu: { name: string; util: number; vramUsed: number; vramTotal: number; temp: number } | null };
const gbs = (b: number) => (b / 1073741824).toFixed(1);

/** CPU / RAM / GPU / VRAM line for AI tools; hidden when Settings → "Show system stats" is off. */
export function statsBar(): HTMLElement {
  const el = h(`<div class="stats" aria-live="off"></div>`);
  if (settings.showStats === false) return el;
  let started = false;
  const tick = async () => {
    if (started && !el.isConnected) return clearInterval(timer);
    started = true;
    const s = await invoke<Stats>("system_stats");
    const chips: [IconName, string, string][] = [
      ["cpu", "CPU", `${Math.round(s.cpu)}%`],
      ["layers", "RAM", `${gbs(s.ramUsed)} / ${gbs(s.ramTotal)} GB`],
    ];
    if (s.gpu) {
      chips.push(["maximize", s.gpu.name.replace(/^NVIDIA (GeForce )?/, ""), `${Math.round(s.gpu.util)}%`]);
      chips.push(["layers", "VRAM", `${(s.gpu.vramUsed / 1024).toFixed(1)} / ${(s.gpu.vramTotal / 1024).toFixed(1)} GB`]);
      chips.push(["alert", "GPU temp", `${Math.round(s.gpu.temp)}°C`]);
    }
    el.replaceChildren(...chips.map(([, k, v]) => {
      const c = h(`<span class="stat"><span class="k"></span><span class="v mono"></span></span>`);
      c.querySelector(".k")!.textContent = k;
      c.querySelector(".v")!.textContent = v;
      return c;
    }));
  };
  const timer = setInterval(tick, 2000);
  tick();
  return el;
}

// ---------- before/after ----------

export type BeforeAfter = HTMLElement & { setImages(before: string, after: string, labels?: string[]): void };

/**
 * Before/after slider with zoom: wheel or +/- to zoom (around the pointer), drag to pan when
 * zoomed, drag the divider handle (or anywhere at 100%) to compare, double-click toggles 1×/4×.
 */
export function beforeAfter(before: string, after: string, labels = ["Before", "After"]): BeforeAfter {
  const el = h(`<div class="ba" tabindex="0" role="slider" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
    <div class="ba-stage"><img class="ba-a" alt=""></div>
    <div class="ba-before"><div class="ba-stage"><img class="ba-b" alt=""></div></div>
    <div class="ba-line"><span>${icon("chevronRight")}</span></div>
    <span class="ba-tag l"></span><span class="ba-tag r"></span>
    <div class="ba-zoom"><button type="button" data-z="-" title="Zoom out">${icon("zoomOut")}</button><span class="mono">100%</span>
      <button type="button" data-z="+" title="Zoom in">${icon("zoomIn")}</button><button type="button" data-z="0" title="Fit">${icon("maximize")}</button></div></div>`) as BeforeAfter;
  let pos = 50, z = 1, tx = 0, ty = 0;
  const apply = () => {
    const r = el.getBoundingClientRect();
    const mx = ((z - 1) * r.width) / 2, my = ((z - 1) * r.height) / 2;
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
    el.style.setProperty("--pos", `${pos}%`);
    el.style.setProperty("--z", String(z));
    el.style.setProperty("--tx", `${tx}px`);
    el.style.setProperty("--ty", `${ty}px`);
    el.classList.toggle("zoomed", z > 1);
    el.classList.toggle("pixels", z >= 3); // show real pixels when judging detail
    el.setAttribute("aria-valuenow", String(Math.round(pos)));
    el.querySelector(".ba-zoom span")!.textContent = `${Math.round(z * 100)}%`;
  };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    const z2 = Math.max(1, Math.min(16, z * factor));
    tx = px - (px - tx) * (z2 / z);
    ty = py - (py - ty) * (z2 / z);
    z = z2;
    if (z === 1) tx = ty = 0;
    apply();
  };
  const center = () => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  el.onwheel = (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY); };
  el.ondblclick = (e) => { if (z > 1) { z = 1; tx = ty = 0; apply(); } else zoomAt(4, e.clientX, e.clientY); };
  el.querySelector(".ba-zoom")!.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.querySelector(".ba-zoom")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-z]");
    if (!b) return;
    const [cx, cy] = center();
    if (b.dataset.z === "0") { z = 1; tx = ty = 0; apply(); }
    else zoomAt(b.dataset.z === "+" ? 1.5 : 1 / 1.5, cx, cy);
  });
  let drag: { mode: "divider" | "pan"; x: number; y: number } | null = null;
  el.onpointerdown = (e) => {
    const r = el.getBoundingClientRect();
    const nearLine = Math.abs(e.clientX - (r.left + (r.width * pos) / 100)) < 18;
    drag = { mode: z === 1 || nearLine ? "divider" : "pan", x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
    if (drag.mode === "divider") { pos = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)); apply(); }
  };
  el.onpointermove = (e) => {
    if (!drag || !el.hasPointerCapture(e.pointerId)) return;
    const r = el.getBoundingClientRect();
    if (drag.mode === "divider") pos = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    else { tx += e.clientX - drag.x; ty += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; }
    apply();
  };
  el.onpointerup = () => (drag = null);
  el.onkeydown = (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.stopPropagation(); pos = Math.max(0, Math.min(100, pos + (e.key === "ArrowLeft" ? -5 : 5))); apply(); }
    const [cx, cy] = center();
    if (e.key === "+" || e.key === "=") zoomAt(1.5, cx, cy);
    if (e.key === "-") zoomAt(1 / 1.5, cx, cy);
  };
  el.setImages = (b, a, l = labels) => {
    el.querySelector<HTMLImageElement>(".ba-a")!.src = convertFileSrc(a);
    el.querySelector<HTMLImageElement>(".ba-b")!.src = convertFileSrc(b);
    el.querySelector(".ba-tag.l")!.textContent = l[0];
    el.querySelector(".ba-tag.r")!.textContent = l[1];
  };
  el.setImages(before, after, labels);
  requestAnimationFrame(apply);
  apply();
  return el;
}

export type ViewerItem = { before: string; after: string; label: string; sub?: string };

/**
 * Large result viewer: before/after with zoom, tabs to jump between items, ←/→ (or [ and ]) to
 * step through them. `keep` adds a button acting on the item on screen.
 */
export function resultViewer(title: string, items: ViewerItem[], start: number, keep?: { label: string; run: (i: number) => unknown }) {
  let i = start;
  const body = h(`<div class="viewer"><div class="v-nav">
      <button class="btn sm ghost" data-prev title="Previous (←)">${icon("chevronLeft")}</button>
      <div class="v-tabs"></div>
      <button class="btn sm ghost" data-next title="Next (→)">${icon("chevronRight")}</button></div></div>`);
  const ba = beforeAfter(items[i].before, items[i].after, ["Original", items[i].label]);
  body.append(ba);
  const tabs = body.querySelector(".v-tabs")!;
  const show = (n: number) => {
    i = (n + items.length) % items.length;
    ba.setImages(items[i].before, items[i].after, ["Original", items[i].label]);
    tabs.replaceChildren(...items.map((it, k) => {
      const t = h(`<button type="button" class="v-tab ${k === i ? "on" : ""}"><b></b><span class="sub"></span></button>`);
      t.querySelector("b")!.textContent = it.label;
      t.querySelector(".sub")!.textContent = it.sub ?? "";
      t.onclick = () => show(k);
      return t;
    }));
  };
  body.querySelector<HTMLButtonElement>("[data-prev]")!.onclick = () => show(i - 1);
  body.querySelector<HTMLButtonElement>("[data-next]")!.onclick = () => show(i + 1);
  const keys = (e: KeyboardEvent) => {
    if (!body.isConnected) return document.removeEventListener("keydown", keys);
    if (e.key === "ArrowLeft" || e.key === "[") show(i - 1);
    if (e.key === "ArrowRight" || e.key === "]") show(i + 1);
  };
  document.addEventListener("keydown", keys);
  show(i);
  modal({
    title, body,
    actions: [{ label: "Close" }, ...(keep ? [{ label: keep.label, primary: true, run: () => keep.run(i) }] : [])],
  });
}

/** Finished image jobs of a module: thumbnails + slider; "Expand" opens the large viewer. */
export function resultsPanel(module: string): HTMLElement {
  const el = h(`<div class="results" hidden><div class="qhead"><h4>Results</h4><span class="count"></span>
    <div class="right"><button class="btn sm" data-expand>${icon("expand")}Expand</button></div></div>
    <div class="r-view"></div><div class="r-strip"></div></div>`);
  let current = "";
  let done: Job[] = [];
  const view = el.querySelector(".r-view")!;
  const strip = el.querySelector(".r-strip")!;
  let ba: BeforeAfter | null = null;
  const item = (j: Job): ViewerItem => ({ before: j.source, after: j.outputs.at(-1)!, label: j.pill || "Result", sub: fileName(j.source) });
  const show = (j: Job) => {
    current = j.id;
    if (!ba) { ba = beforeAfter(j.source, j.outputs.at(-1)!, ["Original", "Result"]); view.replaceChildren(ba); }
    else ba.setImages(j.source, j.outputs.at(-1)!, ["Original", "Result"]);
    strip.querySelectorAll(".r-thumb").forEach((t) => t.classList.toggle("on", (t as HTMLElement).dataset.id === j.id));
  };
  el.querySelector<HTMLButtonElement>("[data-expand]")!.onclick = () =>
    resultViewer("Results", done.map(item), Math.max(0, done.findIndex((j) => j.id === current)));
  let mounting = true;
  watchJobs((all) => {
    const next = all.filter((j) => j.module === module && j.state === "done" && j.source && IMAGE.test(j.outputs.at(-1) ?? "")).reverse().slice(0, 24);
    if (next.map((j) => j.id).join() === done.map((j) => j.id).join()) return; // nothing new: keep zoom/divider
    done = next;
    el.hidden = !done.length;
    el.querySelector(".count")!.textContent = done.length ? `${done.length} recent` : "";
    strip.replaceChildren(...done.map((j) => {
      const t = h(`<button type="button" class="r-thumb" data-id="${j.id}"><img alt=""></button>`);
      t.title = fileName(j.source);
      const img = t.querySelector("img")!;
      img.src = convertFileSrc(j.outputs.at(-1)!);
      img.onerror = () => t.remove(); // result was moved or deleted
      t.onclick = () => show(j);
      return t;
    }));
    const pick = done.find((j) => j.id === current) ?? done[0];
    if (pick) show(pick);
  }, () => mounting || el.isConnected);
  mounting = false;
  return el;
}
