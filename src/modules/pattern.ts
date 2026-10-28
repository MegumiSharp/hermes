// Pattern Generator: a grid of dots bent by a smooth wave field (pattern-core.ts), live preview on a
// canvas, PNG (up to 4K) or SVG export to the chosen folder, optional copy to Eagle, presets.
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs } from "../queue";
import { eagleControls, folderField } from "./common";
import { dots, Params, randomParams, sizeFor, svg } from "./pattern-core";

type Look = { params: Params; color: string; bg: boolean; bgColor: string };
type Preset = Look & { name: string };
const DEFAULT: Look = {
  params: { grid: 64, spread: 0.85, dot: 4, amplitude: 60, waves: 1.8, frequency: 0.0009, seed: 1, aspect: "1:1" },
  color: "#ffffff", bg: true, bgColor: "#101012",
};
// [key, label, min, max, step, decimals]
const SLIDERS: [keyof Params, string, number, number, number, number][] = [
  ["grid", "Dots across", 16, 152, 8, 0], ["spread", "Size", 0.1, 1, 0.01, 2], ["dot", "Dot radius", 0.5, 8, 0.1, 1],
  ["amplitude", "Amplitude", -150, 150, 1, 0], ["waves", "Waves", -10, 10, 0.1, 1], ["frequency", "Frequency", 0, 0.005, 0.0001, 4],
];
const LONG = [1080, 2160, 3840];
/** Only the look (never presets, folder or export size): what presets store and apply. */
const clone = (l: Look): Look => JSON.parse(JSON.stringify({ params: l.params, color: l.color, bg: l.bg, bgColor: l.bgColor }));

const { state, save } = memory("pattern", { ...clone(DEFAULT), long: 2160, folder: "", eagle: false, presets: [] as Preset[] });

/** Paints the pattern on a canvas of `w`×`h` px (one path: fast enough for 23k dots live). */
function paint(ctx: CanvasRenderingContext2D, look: Look, w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  if (look.bg) { ctx.fillStyle = look.bgColor; ctx.fillRect(0, 0, w, h); }
  ctx.fillStyle = look.color;
  ctx.beginPath();
  for (const d of dots(look.params, w, h)) { ctx.moveTo(d.x + d.r, d.y); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); }
  ctx.fill();
}

export function renderPattern(view: HTMLElement) {
  clearers.set("pattern", () => { Object.assign(state, clone(DEFAULT)); save(); });

  const page = h(`<div class="page pattern">
    <div class="head"><div><h3>Pattern Generator</h3><div class="sub">Wavy dot patterns for backgrounds, thumbnails and overlays</div></div></div>
    <div class="pt-body">
      <div class="card pt-side">
        <div class="pt-sliders"></div>
        <div class="pt-row"><span class="field-label">Format</span><div class="seg" id="pt-aspect">
          ${["1:1", "16:9", "9:16", "4:5"].map((a) => `<button data-aspect="${a}">${a}</button>`).join("")}</div></div>
        <div class="pt-row pt-colors">
          <label class="pt-color" title="Dot colour"><span class="field-label">Dots</span><input type="color" id="pt-color"></label>
          <label class="check" id="pt-bg-box"><input type="checkbox" id="pt-bg"><span class="box">${icon("check")}</span>Background</label>
          <label class="pt-color" title="Background colour"><input type="color" id="pt-bgcolor"></label>
        </div>
        <div class="pt-row pt-actions"><button class="btn sm" id="pt-dice" title="A random pattern">${icon("dice")}Random</button>
          <button class="btn sm ghost" id="pt-reset">${icon("retry")}Reset</button></div>
        <div class="pt-row"><span class="field-label">Presets</span>
          <form class="url" id="pt-save-form"><label class="field"><input id="pt-name" placeholder="Name this look" maxlength="40"></label><button class="btn sm" type="submit" id="pt-save">Save</button></form>
          <div class="th-recent" id="pt-presets"></div></div>
      </div>
      <div class="pt-stage"><canvas id="pt-canvas"></canvas></div>
    </div>
    <div class="opts"><div class="opt"><span class="field-label">Export size</span><select class="select" id="pt-long">
      ${LONG.map((l) => `<option value="${l}">${l === 3840 ? "4K" : `${l}p`} · long side ${l} px</option>`).join("")}</select></div><div id="pt-dest"></div></div>
    <div class="row2"><button class="btn" id="pt-svg">${icon("download")}Export SVG</button><button class="btn primary" id="pt-png">${icon("download")}Export PNG</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#pt-dest").append(folderField(state, save, "pt-folder"));
  $(".row2").prepend(...eagleControls(state, save, "pt-eagle"));
  const canvas = $<HTMLCanvasElement>("#pt-canvas");
  const stage = $(".pt-stage");

  // ----- controls -----
  const sliders = $(".pt-sliders");
  for (const [key, label, min, max, step, dec] of SLIDERS) {
    const row = h(`<div class="pt-slider"><div class="pt-slider-top"><span>${label}</span><span class="mono pt-val"></span></div>
      <input type="range" class="range" data-key="${key}" min="${min}" max="${max}" step="${step}"></div>`);
    const input = row.querySelector<HTMLInputElement>("input")!;
    const val = row.querySelector<HTMLElement>(".pt-val")!;
    const show = () => { val.textContent = Number(state.params[key]).toFixed(dec); };
    input.value = String(state.params[key]);
    show();
    input.oninput = () => { (state.params as any)[key] = Number(input.value); show(); draw(); save(true); };
    sliders.append(row);
  }
  const syncSliders = () => sliders.querySelectorAll<HTMLInputElement>("input").forEach((i) => { i.value = String((state.params as any)[i.dataset.key!]); i.dispatchEvent(new Event("sync")); });
  sliders.addEventListener("sync", (e) => {
    const i = e.target as HTMLInputElement;
    const s = SLIDERS.find((x) => x[0] === i.dataset.key)!;
    i.closest(".pt-slider")!.querySelector(".pt-val")!.textContent = Number(i.value).toFixed(s[5]);
  }, true);
  const renderAspect = () => page.querySelectorAll<HTMLElement>("#pt-aspect [data-aspect]").forEach((b) => b.classList.toggle("on", b.dataset.aspect === state.params.aspect));
  $("#pt-aspect").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-aspect]");
    if (!b) return;
    state.params.aspect = b.dataset.aspect as Params["aspect"];
    save(); renderAspect(); draw();
  };
  const color = $<HTMLInputElement>("#pt-color"), bg = $<HTMLInputElement>("#pt-bg"), bgColor = $<HTMLInputElement>("#pt-bgcolor");
  const syncColors = () => { color.value = state.color; bg.checked = state.bg; bgColor.value = state.bgColor; bgColor.disabled = !state.bg; };
  color.oninput = () => { state.color = color.value; draw(); save(true); };
  bg.onchange = () => { state.bg = bg.checked; syncColors(); draw(); save(); };
  bgColor.oninput = () => { state.bgColor = bgColor.value; draw(); save(true); };
  const apply = (l: Look) => { Object.assign(state, clone(l)); save(); syncSliders(); syncColors(); renderAspect(); draw(); };
  $("#pt-dice").onclick = () => apply({ ...state, params: randomParams(state.params) });
  $("#pt-reset").onclick = () => apply({ ...DEFAULT, params: { ...DEFAULT.params, aspect: state.params.aspect } });

  // ----- presets -----
  function renderPresets() {
    $("#pt-presets").replaceChildren(...state.presets.map((p, i) => {
      const b = h(`<span class="chip pt-preset"><button class="pt-use" type="button"></button><button class="pt-del" type="button" title="Delete preset">${icon("x")}</button></span>`);
      b.querySelector(".pt-use")!.textContent = p.name;
      (b.querySelector(".pt-use") as HTMLElement).onclick = () => apply(p);
      (b.querySelector(".pt-del") as HTMLElement).onclick = () => { state.presets.splice(i, 1); save(); renderPresets(); };
      return b;
    }));
  }
  $<HTMLFormElement>("#pt-save-form").onsubmit = (e) => {
    e.preventDefault();
    const name = $<HTMLInputElement>("#pt-name").value.trim();
    if (!name) return;
    state.presets = [{ name, ...clone(state) }, ...state.presets.filter((p) => p.name !== name)].slice(0, 12);
    $<HTMLInputElement>("#pt-name").value = "";
    save(); renderPresets();
  };

  // ----- preview: fits the stage, at most 1400 px for speed (exports render at full size) -----
  let frame = 0;
  function draw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const box = stage.getBoundingClientRect();
      if (!box.width) return;
      const [aw, ah] = sizeFor(state.params.aspect, 1000);
      const scale = Math.min(box.width / aw, (box.height || box.width) / ah);
      const cssW = Math.floor(aw * scale), cssH = Math.floor(ah * scale);
      const dpr = Math.min(devicePixelRatio || 1, 1400 / Math.max(cssW, cssH));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      paint(canvas.getContext("2d")!, state, canvas.width, canvas.height);
    });
  }
  new ResizeObserver(() => draw()).observe(stage);

  // ----- export -----
  const long = $<HTMLSelectElement>("#pt-long");
  long.value = String(state.long);
  long.onchange = () => { state.long = Number(long.value); save(); };
  async function saved(path: string, kind: string) {
    if (state.eagle) await addJobs([{ module: "pattern", title: path.split("\\").pop()!, pill: kind, outputs: [path], steps: [{ type: "eagle", keep: true }], eagle: { tags: ["Hermes", "Pattern"] } }]);
    banner({ id: "pattern", icon: "check", text: `Saved ${kind}: ${path.split("\\").pop()}${state.eagle ? " (and sent to Eagle)" : ""}.`,
      actions: [{ label: "Show in folder", run: () => { revealItemInDir(path); } }] });
  }
  const fileBase = () => { const [w, hh] = sizeFor(state.params.aspect, state.long); return [`${state.folder}\\pattern-${state.params.seed}-${w}x${hh}`, w, hh] as const; };
  $<HTMLButtonElement>("#pt-png").onclick = async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    try {
      const [base, w, hh] = fileBase();
      const c = document.createElement("canvas");
      c.width = w; c.height = hh;
      paint(c.getContext("2d")!, state, w, hh);
      const blob = await new Promise<Blob>((ok, no) => c.toBlob((x) => (x ? ok(x) : no("could not encode PNG")), "image/png"));
      const path = await invoke<string>("write_file", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(`${base}.png`) } });
      await saved(path, "PNG");
    } catch (er) {
      banner({ id: "pattern", tone: "warn", icon: "alert", text: `Export failed: ${er}` });
    }
    b.disabled = false;
  };
  $<HTMLButtonElement>("#pt-svg").onclick = async () => {
    try {
      const [base, w, hh] = fileBase();
      const text = svg(state.params, w, hh, state.color, state.bg ? state.bgColor : null);
      const path = await invoke<string>("write_file", new TextEncoder().encode(text), { headers: { "x-path": encodeURIComponent(`${base}.svg`) } });
      await saved(path, "SVG");
    } catch (er) {
      banner({ id: "pattern", tone: "warn", icon: "alert", text: `Export failed: ${er}` });
    }
  };

  syncColors(); renderAspect(); renderPresets();
  view.append(page);
  draw();
}
