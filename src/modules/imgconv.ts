// Image Converter: PNG, JPG, WebP, AVIF, TIFF, BMP, GIF, ICO with FFmpeg (bundled), and raster →
// SVG with vtracer in process (vector.rs). Never enlarges; transparency is flattened on white only
// for formats without it. Results stay in the chosen folder (a copy goes to Eagle when ticked).
import { invoke } from "@tauri-apps/api/core";
import { binariesReady } from "../binaries";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";
import { eagleControls, fileName, fileTray, folderField, paths, stem, TrayItem } from "./common";

type Quality = "high" | "balanced" | "small";
type Format = { label: string; ext: string; quality?: Record<Quality, string[]>; alpha: boolean; args?: string[] };
const FORMATS: Record<string, Format> = {
  png: { label: "PNG · lossless, transparency", ext: "png", alpha: true, args: ["-c:v", "png", "-compression_level", "6"] },
  jpg: { label: "JPG · photos, small", ext: "jpg", alpha: false,
    quality: { high: ["-q:v", "2"], balanced: ["-q:v", "4"], small: ["-q:v", "8"] } },
  webp: { label: "WebP · web, transparency", ext: "webp", alpha: true,
    quality: { high: ["-c:v", "libwebp", "-lossless", "1"], balanced: ["-c:v", "libwebp", "-quality", "85"], small: ["-c:v", "libwebp", "-quality", "65"] } },
  avif: { label: "AVIF · smallest, transparency", ext: "avif", alpha: true,
    quality: Object.fromEntries((["high", "balanced", "small"] as Quality[]).map((q, i) => [q, ["-c:v", "libaom-av1", "-still-picture", "1", "-cpu-used", "6", "-crf", ["18", "28", "38"][i]]])) as Record<Quality, string[]> },
  tiff: { label: "TIFF · print, lossless", ext: "tiff", alpha: true, args: ["-c:v", "tiff", "-compression_algo", "deflate"] },
  bmp: { label: "BMP · uncompressed", ext: "bmp", alpha: false },
  gif: { label: "GIF · 256 colours", ext: "gif", alpha: true },
  ico: { label: "ICO · Windows icon 256 px", ext: "ico", alpha: true },
  svg: { label: "SVG · vector, for logos", ext: "svg", alpha: true },
};
const SIZES = [0, 3840, 2560, 1920, 1280, 1080, 720, 512, 256];
const EXTS = ["png", "jpg", "jpeg", "jfif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "gif", "ico"];
// what the in-process tracer can read directly; the rest goes through FFmpeg to PNG first
const TRACEABLE = /\.(png|jpe?g|jfif|webp|bmp|tiff?|gif)$/i;

/** -vf / -filter_complex for one conversion: size cap (never enlarges), white under transparency for formats without it. */
function filters(f: Format, size: number): string[] {
  const fit = size ? `scale='min(iw,${size})':'min(ih,${size})':force_original_aspect_ratio=decrease` : "";
  if (f.ext === "ico") return ["-vf", "scale=256:256:force_original_aspect_ratio=decrease,format=rgba,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=black@0", "-c:v", "png"];
  if (f.ext === "gif") return ["-vf", `${fit ? `${fit},` : ""}split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`];
  if (!f.alpha) return ["-filter_complex", `[0:v]${fit ? `${fit},` : ""}format=rgba[f];color=white,format=rgba[b];[b][f]scale2ref[b][f];[b][f]overlay=shortest=1${f.ext === "jpg" ? ",format=yuvj444p" : ",format=rgb24"}`];
  return fit ? ["-vf", fit] : [];
}

export function renderImgConv(view: HTMLElement) {
  const { state, save } = memory("imgconv", {
    folder: "", format: "png", quality: "high" as Quality, size: 0, svgMode: "color", svgDetail: "balanced", eagle: false, tray: [] as TrayItem[],
  });
  clearers.set("imgconv", () => { state.tray = []; save(); });

  const page = h(`<div class="page imgconv">
    <div class="head"><div><h3>Image Converter</h3><div class="sub">Change an image's format or size, or trace it into an SVG</div></div></div>
    <div class="i-files"></div>
    <div class="opts three"><div class="opt"><span class="field-label">Convert to</span><select class="select" id="i-format">
      ${Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join("")}</select></div>
      <div class="opt" id="i-quality-box"><span class="field-label">Quality</span><select class="select" id="i-quality">
        <option value="high">High</option><option value="balanced">Balanced</option><option value="small">Small file</option></select></div>
      <div class="opt" id="i-size-box"><span class="field-label">Size</span><select class="select" id="i-size">
        ${SIZES.map((s) => `<option value="${s}">${s ? `Up to ${s} px` : "Keep original"}</option>`).join("")}</select></div>
      <div class="opt" id="i-svg-mode-box"><span class="field-label">Colours</span><select class="select" id="i-svg-mode">
        <option value="color">Full colour</option><option value="bw">Black and white</option></select></div>
      <div class="opt" id="i-svg-detail-box"><span class="field-label">Detail</span><select class="select" id="i-svg-detail">
        <option value="high">High (faithful, bigger file)</option><option value="balanced">Balanced</option><option value="simple">Simple (flat shapes)</option></select></div>
    </div>
    <div class="sub" id="i-hint"></div>
    <div class="opts one" id="i-dest"></div>
    <div class="row2"><button class="btn primary" id="i-go" disabled>${icon("image")}Convert</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#i-dest").append(folderField(state, save, "i-folder"));
  $(".row2").prepend(...eagleControls(state, save, "i-eagle"));
  const go = $<HTMLButtonElement>("#i-go");

  for (const [id, key, num] of [["#i-format", "format"], ["#i-quality", "quality"], ["#i-size", "size", true], ["#i-svg-mode", "svgMode"], ["#i-svg-detail", "svgDetail"]] as const) {
    const s = $<HTMLSelectElement>(id);
    s.value = String(state[key]);
    s.onchange = () => { (state as any)[key] = num ? Number(s.value) : s.value; save(); hint(); };
  }
  function hint() {
    const f = FORMATS[state.format];
    const svg = f.ext === "svg";
    $("#i-quality-box").hidden = !f.quality;
    $("#i-size-box").hidden = svg || f.ext === "ico";
    $("#i-svg-mode-box").hidden = $("#i-svg-detail-box").hidden = !svg;
    $("#i-hint").textContent = svg ? "Traces shapes into paths: great for logos, icons, drawings and flat art; photos become poster-like."
      : f.ext === "ico" ? "Square 256 × 256 icon with transparency, the image centered."
      : !f.alpha ? `${f.ext.toUpperCase()} has no transparency: transparent areas become white.`
      : f.ext === "webp" && state.quality === "high" ? "High = lossless WebP." : "";
  }

  const tray = fileTray({ id: "i-drop", label: "Drop images here", exts: EXTS, multiple: true, paste: true },
    () => state.tray, (l) => { state.tray = l; save(); }, () => update());
  $(".i-files").append(tray.el);
  function update() {
    const n = tray.pending().length;
    go.disabled = !n;
    go.lastChild!.textContent = n > 1 ? `Convert ${n} images` : "Convert";
  }

  function job(input: string, i: number, data: string): NewJob {
    const f = FORMATS[state.format];
    const same = input.toLowerCase().endsWith(`.${f.ext}`) || (f.ext === "jpg" && /\.jpe?g$/i.test(input)) || (f.ext === "tiff" && /\.tif$/i.test(input));
    const output = `${state.folder}\\${stem(input)}${same ? " (converted)" : ""}.${f.ext}`; // never overwrite the original
    const steps: Step[] = [];
    if (f.ext === "svg") {
      let src = input;
      if (!TRACEABLE.test(input)) { // AVIF, HEIC, ICO: decode with FFmpeg first
        src = `${data}\\temp\\imgconv-${Date.now()}-${i}.png`;
        steps.push({ type: "run", label: "Reading the image", bin: "ffmpeg.exe", parser: "plain", args: ["-y", "-v", "error", "-i", input, "-frames:v", "1", src] });
      }
      steps.push({ type: "vectorize", input: src, output, mode: state.svgMode, detail: state.svgDetail });
      if (src !== input) steps.push({ type: "delete", paths: [src] });
    } else {
      steps.push({ type: "run", label: "Converting", bin: "ffmpeg.exe", parser: "plain", outputs: [output],
        args: ["-y", "-v", "error", "-i", input, ...filters(f, state.size), ...(f.quality?.[state.quality] ?? f.args ?? []), "-frames:v", "1", "-update", "1", output] });
    }
    if (state.eagle) steps.push({ type: "eagle", keep: true });
    return { module: "imgconv", title: fileName(input), pill: f.ext === "svg" ? "SVG" : `${f.ext.toUpperCase()}${state.size ? ` ${state.size}` : ""}`, source: input, steps,
      ...(state.eagle ? { eagle: { tags: ["Hermes", f.ext.toUpperCase()] } } : {}) };
  }

  go.onclick = async () => {
    go.disabled = true;
    await binariesReady;
    const { data } = await paths;
    await invoke("make_dirs", { paths: [state.folder, `${data}\\temp`] });
    const todo = tray.pending();
    try {
      tray.assign(todo, await addJobs(todo.map((it, i) => job(it.path, i, data))));
    } catch (e) {
      banner({ id: "imgconv", tone: "warn", icon: "alert", text: `Could not start the conversion: ${e}` });
    }
    update();
  };

  hint();
  update();
  mountQueue(page, "imgconv");
  view.append(page);
}
