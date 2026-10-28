// Pixel Art: images into pixel art (idea from pixelartvillage.com, written from scratch). The browser
// shrinks the picture to one value per art pixel (block average), pixel-core.ts adjusts it and maps
// it to a palette (optionally dithered), then it is scaled up nearest-neighbour with an optional grid.
// Live preview of the selected image; export processes every image with the same settings.
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs } from "../queue";
import { dropZone, eagleControls, fileName, folderField, stem, thumbSrc } from "./common";
import { adjust, artSize, Dither, hexToRgb, PALETTES, paletteFromImage, parseHexList, quantize, RGB, rgbToHex, scaleFor } from "./pixel-core";

type Custom = { name: string; colors: string[] };
const EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];
const OUTS: [string, string][] = [["small", "Small (1 px per art pixel)"], ["original", "Original size"], ["2160", "Up to 2160 px"], ["3840", "Up to 4K (3840 px)"]];
const ADJ = { size: 8, brightness: 0, contrast: 0, saturation: 0 };

const { state, save } = memory("pixel", {
  files: [] as string[], sel: 0, ...ADJ, palette: "none", colors: 16, dither: "none" as Dither, grid: false, gridColor: "#000000",
  out: "original", folder: "", eagle: false, custom: [] as Custom[],
});

/** Decoded images by path (read as bytes: asset URLs would taint the canvas). */
const decoded = new Map<string, Promise<ImageBitmap>>();
function bitmap(path: string): Promise<ImageBitmap> {
  if (!decoded.has(path)) decoded.set(path, invoke<ArrayBuffer>("read_file", { path }).then((b) => createImageBitmap(new Blob([b]))));
  return decoded.get(path)!;
}

/** Palette in use for an art image (null = keep the image's colours). */
function paletteOf(px: Uint8ClampedArray): RGB[] | null {
  if (state.palette === "none") return null;
  if (state.palette === "image") return paletteFromImage(px, state.colors);
  const custom = state.custom.find((c) => c.name === state.palette);
  return (custom?.colors ?? PALETTES[state.palette] ?? []).map(hexToRgb);
}

/** The small image: one pixel per art pixel, adjusted and on the palette. */
function art(img: ImageBitmap): ImageData {
  const [cw, ch] = artSize(img.width, img.height, state.size);
  // halve step by step: a single big drawImage skips pixels instead of averaging them
  let src: CanvasImageSource = img, w = img.width, hh = img.height;
  while (w / 2 > cw && hh / 2 > ch) {
    const c = document.createElement("canvas");
    c.width = Math.round(w / 2); c.height = Math.round(hh / 2);
    const x = c.getContext("2d")!;
    x.imageSmoothingQuality = "high";
    x.drawImage(src, 0, 0, c.width, c.height);
    src = c; w = c.width; hh = c.height;
  }
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, cw, ch);
  const d = x.getImageData(0, 0, cw, ch);
  adjust(d.data, state.brightness, state.contrast, state.saturation);
  const pal = paletteOf(d.data);
  if (pal) quantize(d.data, cw, ch, pal, state.dither);
  return d;
}

/** The art image scaled ×k with hard edges, grid lines between cells when asked. */
function upscale(small: ImageData, k: number, target?: HTMLCanvasElement): HTMLCanvasElement {
  const s = document.createElement("canvas");
  s.width = small.width; s.height = small.height;
  s.getContext("2d")!.putImageData(small, 0, 0);
  const c = target ?? document.createElement("canvas");
  c.width = small.width * k; c.height = small.height * k;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(s, 0, 0, c.width, c.height);
  if (state.grid && k >= 3) {
    x.fillStyle = state.gridColor;
    const t = Math.max(1, Math.round(k / 12));
    for (let i = 0; i <= small.width; i++) x.fillRect(i * k - (i ? t : 0), 0, t, c.height);
    for (let j = 0; j <= small.height; j++) x.fillRect(0, j * k - (j ? t : 0), c.width, t);
  }
  return c;
}

export function renderPixel(view: HTMLElement) {
  clearers.set("pixel", () => { Object.assign(state, { files: [], sel: 0 }); save(); });

  const page = h(`<div class="page pixel">
    <div class="head"><div><h3>Pixel Art</h3><div class="sub">Turn pictures into pixel art: pixel size, palettes, dithering, grid</div></div></div>
    <div id="px-drop"></div>
    <div class="px-strip" id="px-strip"></div>
    <div class="pt-body">
      <div class="card pt-side">
        <div class="pt-sliders" id="px-sliders"></div>
        <button class="btn sm ghost" id="px-reset" type="button">${icon("retry")}Reset sliders</button>
        <div class="pt-row"><span class="field-label">Palette</span><select class="select" id="px-palette"></select></div>
        <div class="pt-slider" id="px-colors-box"><div class="pt-slider-top"><span>Colours from the image</span><span class="mono pt-val" id="px-colors-val"></span></div>
          <input type="range" class="range" id="px-colors" min="1" max="64" step="1"></div>
        <div class="px-swatches" id="px-swatches"></div>
        <div class="pt-row"><span class="field-label">Dithering</span><select class="select" id="px-dither">
          <option value="none">None (flat colours)</option><option value="floyd">Floyd–Steinberg (smooth)</option><option value="ordered">Ordered (retro pattern)</option></select></div>
        <div class="pt-row pt-colors"><label class="check" id="px-grid-box"><input type="checkbox" id="px-grid"><span class="box">${icon("check")}</span>Grid</label>
          <label class="pt-color" title="Grid colour"><input type="color" id="px-gridcolor"></label></div>
        <div class="pt-row"><span class="field-label">Import palette</span>
          <form class="url" id="px-import-form"><label class="field"><input id="px-lospec" placeholder="Lospec link, e.g. lospec.com/palette-list/sweetie-16" spellcheck="false"></label><button class="btn sm" type="submit" id="px-import">Import</button></form>
          <form class="url" id="px-custom-form"><label class="field"><input id="px-hex" placeholder="Or paste colours: #1a1c2c #5d275d …" spellcheck="false"></label><button class="btn sm" type="submit" id="px-add">Add</button></form>
          <div class="th-recent" id="px-custom"></div></div>
      </div>
      <div class="pt-stage" id="px-stage"><canvas id="px-canvas"></canvas><div class="th-empty" id="px-empty">${icon("image")}<div>Drop images above to see them as pixel art.</div></div></div>
    </div>
    <div class="opts"><div class="opt"><span class="field-label">Export size</span><select class="select" id="px-out">
      ${OUTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div><div id="px-dest"></div></div>
    <div class="sub" id="px-info"></div>
    <div class="row2"><button class="btn primary" id="px-go" disabled>${icon("download")}Export</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#px-dest").append(folderField(state, save, "px-folder"));
  $(".row2").prepend(...eagleControls(state, save, "px-eagle"));
  const canvas = $<HTMLCanvasElement>("#px-canvas");
  const stage = $("#px-stage");

  // ----- images -----
  $("#px-drop").append(dropZone({ id: "px-dropzone", label: "Drop images here", exts: EXTS, multiple: true, paste: true }, (paths) => {
    state.files = [...state.files, ...paths.filter((p) => !state.files.includes(p))];
    state.sel = state.files.length - 1;
    save(); renderStrip(); preview();
  }));
  function renderStrip() {
    $("#px-strip").replaceChildren(...state.files.map((p, i) => {
      const t = h(`<div class="px-thumb ${i === state.sel ? "on" : ""}" title=""><img alt=""><button class="px-x" type="button" title="Remove">${icon("x")}</button></div>`);
      t.title = fileName(p);
      thumbSrc(p).then((src) => { t.querySelector("img")!.src = src; });
      t.onclick = (e) => {
        if ((e.target as Element).closest(".px-x")) { state.files.splice(i, 1); decoded.delete(p); state.sel = Math.min(state.sel, state.files.length - 1); }
        else state.sel = i;
        save(); renderStrip(); preview();
      };
      return t;
    }));
    const n = state.files.length;
    $<HTMLButtonElement>("#px-go").disabled = !n;
    $("#px-go").lastChild!.textContent = n > 1 ? `Export ${n} images` : "Export";
  }

  // ----- controls -----
  const SL: [keyof typeof ADJ, string, number, number][] = [["size", "Pixel size", 1, 64], ["brightness", "Brightness", -100, 200], ["contrast", "Contrast", -100, 200], ["saturation", "Saturation", -100, 200]];
  const sliders = $("#px-sliders");
  for (const [key, label, min, max] of SL) {
    const row = h(`<div class="pt-slider"><div class="pt-slider-top"><span>${label}</span><span class="mono pt-val"></span></div>
      <input type="range" class="range" data-key="${key}" min="${min}" max="${max}" step="1"></div>`);
    const input = row.querySelector<HTMLInputElement>("input")!;
    const val = row.querySelector<HTMLElement>(".pt-val")!;
    input.value = String(state[key]);
    val.textContent = String(state[key]);
    input.oninput = () => { state[key] = Number(input.value); val.textContent = input.value; preview(); save(true); };
    sliders.append(row);
  }
  $("#px-reset").onclick = () => {
    Object.assign(state, ADJ);
    sliders.querySelectorAll<HTMLInputElement>("input").forEach((i) => { i.value = String(state[i.dataset.key as keyof typeof ADJ]); i.closest(".pt-slider")!.querySelector(".pt-val")!.textContent = i.value; });
    save(); preview();
  };
  const palSel = $<HTMLSelectElement>("#px-palette");
  function renderPalettes() {
    // Option() sets text and value as plain strings: imported palette names never become HTML
    palSel.replaceChildren(new Option("Keep the image's colours", "none"), new Option("From the image (pick a number of colours)", "image"),
      ...Object.keys(PALETTES).map((n) => new Option(`${n} · ${PALETTES[n].length} colours`, n)),
      ...state.custom.map((c) => new Option(`${c.name} · ${c.colors.length} colours`, c.name)));
    palSel.value = state.palette;
    if (palSel.value !== state.palette) { state.palette = "none"; palSel.value = "none"; }
    $("#px-colors-box").hidden = state.palette !== "image";
    $("#px-dither").closest<HTMLElement>(".pt-row")!.hidden = state.palette === "none";
    $("#px-custom").replaceChildren(...state.custom.map((c, i) => {
      const b = h(`<span class="chip pt-preset"><button class="pt-use" type="button"></button><button class="pt-del" type="button" title="Delete palette">${icon("x")}</button></span>`);
      b.querySelector(".pt-use")!.textContent = c.name;
      (b.querySelector(".pt-use") as HTMLElement).onclick = () => { state.palette = c.name; save(); renderPalettes(); preview(); };
      (b.querySelector(".pt-del") as HTMLElement).onclick = () => { state.custom.splice(i, 1); if (state.palette === c.name) state.palette = "none"; save(); renderPalettes(); preview(); };
      return b;
    }));
  }
  palSel.onchange = () => { state.palette = palSel.value; save(); renderPalettes(); preview(); };
  const colors = $<HTMLInputElement>("#px-colors");
  colors.value = String(state.colors);
  $("#px-colors-val").textContent = String(state.colors);
  colors.oninput = () => { state.colors = Number(colors.value); $("#px-colors-val").textContent = colors.value; preview(); save(true); };
  const dither = $<HTMLSelectElement>("#px-dither");
  dither.value = state.dither;
  dither.onchange = () => { state.dither = dither.value as Dither; save(); preview(); };
  const grid = $<HTMLInputElement>("#px-grid"), gridColor = $<HTMLInputElement>("#px-gridcolor");
  grid.checked = state.grid; gridColor.value = state.gridColor;
  grid.onchange = () => { state.grid = grid.checked; save(); preview(); };
  gridColor.oninput = () => { state.gridColor = gridColor.value; save(true); preview(); };
  const addCustom = (name: string, list: string[]) => {
    state.custom = [{ name, colors: list }, ...state.custom.filter((c) => c.name !== name)].slice(0, 20);
    state.palette = name;
    save(); renderPalettes(); preview();
  };
  $<HTMLFormElement>("#px-import-form").onsubmit = async (e) => {
    e.preventDefault();
    const raw = $<HTMLInputElement>("#px-lospec").value.trim();
    const slug = raw.match(/palette-list\/([a-z0-9-]+)/i)?.[1] ?? (/^[a-z0-9-]+$/i.test(raw) ? raw : "");
    if (!slug) return banner({ id: "pixel", tone: "warn", icon: "alert", text: "Paste a Lospec palette link, e.g. https://lospec.com/palette-list/sweetie-16" });
    const b = $<HTMLButtonElement>("#px-import");
    b.disabled = true;
    try {
      const j = await (await fetch(`https://lospec.com/palette-list/${slug.toLowerCase()}.json`)).json();
      const list = parseHexList((j.colors ?? []).join(" "));
      if (!list.length) throw new Error("no colours in that palette");
      addCustom(String(j.name || slug).slice(0, 40), list);
      $<HTMLInputElement>("#px-lospec").value = "";
    } catch (er) {
      banner({ id: "pixel", tone: "warn", icon: "alert", text: `Could not import the palette: ${er}` });
    }
    b.disabled = false;
  };
  $<HTMLFormElement>("#px-custom-form").onsubmit = (e) => {
    e.preventDefault();
    const list = parseHexList($<HTMLInputElement>("#px-hex").value);
    if (!list.length) return;
    addCustom(`My palette ${state.custom.length + 1}`, list);
    $<HTMLInputElement>("#px-hex").value = "";
  };

  // ----- preview -----
  let ticket = 0;
  async function preview() {
    const id = ++ticket;
    const path = state.files[state.sel];
    $("#px-empty").hidden = !!path;
    canvas.hidden = !path;
    if (!path) { $("#px-swatches").replaceChildren(); $("#px-info").textContent = ""; return; }
    let img: ImageBitmap;
    try { img = await bitmap(path); } catch { if (id === ticket) $("#px-info").textContent = "This image can't be read."; return; }
    if (id !== ticket) return;
    const small = art(img);
    const box = stage.getBoundingClientRect();
    const k = Math.max(1, Math.floor(Math.min((box.width - 24) / small.width, (box.height - 24) / small.height)));
    upscale(small, k, canvas);
    const fit = Math.min((box.width - 24) / canvas.width, (box.height - 24) / canvas.height, 1);
    canvas.style.width = `${Math.floor(canvas.width * fit)}px`;
    canvas.style.height = `${Math.floor(canvas.height * fit)}px`;
    const pal = paletteOf(small.data);
    $("#px-swatches").replaceChildren(...(pal ?? []).slice(0, 64).map((c) => { const s = h(`<i title="#${rgbToHex(c)}"></i>`); s.style.background = `#${rgbToHex(c)}`; return s; }));
    const out = state.out === "small" ? 1 : scaleFor(small.width, small.height, state.out === "original" ? "original" : Number(state.out), state.size);
    $("#px-info").textContent = `${small.width} × ${small.height} art pixels → exported at ${small.width * out} × ${small.height * out} px.`;
  }
  new ResizeObserver(() => preview()).observe(stage);
  const out = $<HTMLSelectElement>("#px-out");
  out.value = state.out;
  out.onchange = () => { state.out = out.value; save(); preview(); };

  // ----- export: every image with the same settings -----
  $<HTMLButtonElement>("#px-go").onclick = async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    const done: string[] = [];
    try {
      for (const [i, path] of state.files.entries()) {
        b.lastChild!.textContent = `Exporting ${i + 1} / ${state.files.length}`;
        const small = art(await bitmap(path));
        const k = state.out === "small" ? 1 : scaleFor(small.width, small.height, state.out === "original" ? "original" : Number(state.out), state.size);
        const c = k === 1 && !state.grid ? (() => { const x = document.createElement("canvas"); x.width = small.width; x.height = small.height; x.getContext("2d")!.putImageData(small, 0, 0); return x; })() : upscale(small, k);
        const blob = await new Promise<Blob>((ok, no) => c.toBlob((x) => (x ? ok(x) : no("could not encode PNG")), "image/png"));
        const dest = `${state.folder}\\${stem(path)} (pixel ${state.size}${state.out === "small" ? ", small" : ""}).png`;
        done.push(await invoke<string>("write_file", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(dest) } }));
      }
      if (state.eagle) await addJobs(done.map((p) => ({ module: "pixel", title: fileName(p), pill: "PNG", outputs: [p], steps: [{ type: "eagle" as const, keep: true }], eagle: { tags: ["Hermes", "Pixel art"] } })));
      banner({ id: "pixel", icon: "check", text: `Saved ${done.length} pixel art image${done.length > 1 ? "s" : ""}${state.eagle ? " (and sent to Eagle)" : ""}.`,
        actions: [{ label: "Show in folder", run: () => { revealItemInDir(done[0]); } }] });
    } catch (er) {
      banner({ id: "pixel", tone: "warn", icon: "alert", text: `Export failed: ${er}` });
    }
    renderStrip();
  };

  renderStrip(); renderPalettes();
  view.append(page);
  preview();
}
