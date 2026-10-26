// Image Upscale module (SPEC 8): Real-ESRGAN ncnn-vulkan on the GPU. Videos live in Video Converter.
import { invoke } from "@tauri-apps/api/core";
import { binariesReady, toolStatus } from "../binaries";
import { clearers, h, saveSettings, settings } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";
import { eagleControls, fileName, fileTray, folderField, paths, resultsPanel, statsBar, stem, TrayItem } from "./common";

type Model = { id: string; name: string; scales: number[]; hint: string };
const MODELS: Model[] = [
  { id: "realesrgan-x4plus", name: "Photo", scales: [4], hint: "Real-ESRGAN x4plus: photos and realistic images" },
  { id: "realesrgan-x4plus-anime", name: "Illustration", scales: [4], hint: "x4plus-anime: anime, drawings, line art" },
  { id: "realesr-animevideov3", name: "Fast", scales: [2, 3, 4], hint: "animevideov3: quickest, also allows 2× and 3×" },
];
type Prefs = { folder: string; eagle: boolean; model: string; scale: number; files?: string[]; tray: TrayItem[] };
const IMAGES = ["png", "jpg", "jpeg", "webp"];

export function renderUpscale(view: HTMLElement) {
  const prefs: Prefs = { folder: "", eagle: true, model: "realesrgan-x4plus", scale: 4, tray: [], ...settings.upscale };
  if (prefs.files?.length) { prefs.tray = prefs.files.map((path) => ({ path })); delete prefs.files; } // pre-T12 shape
  // videos used to be accepted here: they now belong to Video Converter
  prefs.tray = prefs.tray.filter((i) => IMAGES.some((e) => i.path.toLowerCase().endsWith(`.${e}`)));
  const save = () => saveSettings({ upscale: prefs });
  clearers.set("upscale", () => { prefs.tray = []; save(); });

  const page = h(`<div class="page upscale">
    <div class="head"><div><h3>Image Upscale</h3><div class="sub">Enlarge images with Real-ESRGAN on your GPU. For videos use Video Converter.</div></div>
      <div class="right"><span class="chip" id="u-tool"><span class="dot"></span>Real-ESRGAN</span></div></div>
    <div id="u-stats"></div>
    <div class="u-files"></div>
    <div class="opts three">
      <div class="opt"><span class="field-label">Model</span><select class="select" id="u-model">${MODELS.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select></div>
      <div class="opt"><span class="field-label">Scale</span><select class="select" id="u-scale"></select></div>
      <div class="opt u-hint sub" id="u-hint"></div>
    </div>
    <div class="opts one" id="u-dest"></div>
    <div class="row2"><button class="btn primary" id="u-go" disabled>${icon("maximize")}Upscale</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#u-dest").append(folderField(prefs, save, "u-folder"));
  $(".row2").prepend(...eagleControls(prefs, save, "u-eagle"));
  $("#u-stats").append(statsBar());
  const goBtn = $<HTMLButtonElement>("#u-go");

  toolStatus("realesrgan").then((s) => {
    $("#u-tool").lastChild!.textContent = s?.ok ? `Real-ESRGAN ${s.version}` : "Real-ESRGAN missing";
    $("#u-tool").classList.toggle("bad", !s?.ok);
  });

  const modelSel = $<HTMLSelectElement>("#u-model");
  const scaleSel = $<HTMLSelectElement>("#u-scale");
  function renderModel() {
    const m = MODELS.find((x) => x.id === prefs.model) ?? MODELS[0];
    modelSel.value = m.id;
    if (!m.scales.includes(prefs.scale)) prefs.scale = m.scales.at(-1)!;
    scaleSel.innerHTML = m.scales.map((s) => `<option value="${s}" ${s === prefs.scale ? "selected" : ""}>${s}×</option>`).join("");
    scaleSel.disabled = m.scales.length === 1;
    $("#u-hint").textContent = m.hint;
  }
  modelSel.onchange = () => { prefs.model = modelSel.value; renderModel(); save(); };
  scaleSel.onchange = () => { prefs.scale = Number(scaleSel.value); save(); };

  const tray = fileTray({ id: "u-drop", label: "Drop images here", exts: IMAGES, multiple: true, paste: true },
    () => prefs.tray, (l) => { prefs.tray = l; save(); }, () => update());
  $(".u-files").append(tray.el);
  function update() {
    const n = tray.pending().length;
    goBtn.disabled = !n;
    goBtn.lastChild!.textContent = n > 1 ? `Upscale ${n} images` : "Upscale";
  }

  function job(input: string, bin: string): NewJob {
    // results always land in the chosen folder; Eagle gets a copy (the file stays for the slider)
    const output = `${prefs.folder}\\${stem(input)}-x${prefs.scale}-${Date.now()}.png`;
    const steps: Step[] = [{
      type: "run", label: "Upscaling", bin: "realesrgan-ncnn-vulkan.exe", parser: "percent", outputs: [output],
      args: ["-i", input, "-o", output, "-n", prefs.model, "-s", String(prefs.scale), "-m", `${bin}\\models`, "-f", "png"],
    }];
    if (prefs.eagle) steps.push({ type: "eagle", keep: true });
    return { module: "upscale", title: fileName(input), pill: `${prefs.scale}× ${MODELS.find((m) => m.id === prefs.model)?.name}`, steps, source: input, eagle: { tags: [`Upscaled ${prefs.scale}x`] } };
  }

  goBtn.onclick = async () => {
    goBtn.disabled = true;
    await binariesReady;
    const { bin } = await paths;
    await invoke("make_dirs", { paths: [prefs.folder] });
    const todo = tray.pending();
    tray.assign(todo, await addJobs(todo.map((it) => job(it.path, bin))));
    update();
  };

  renderModel();
  update();
  page.append(resultsPanel("upscale"));
  mountQueue(page, "upscale");
  view.append(page);
}
