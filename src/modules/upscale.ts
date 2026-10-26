// Upscale module (SPEC 8): Real-ESRGAN ncnn-vulkan for images; videos are split into frames,
// upscaled and re-encoded with NVENC, keeping the original audio.
import { invoke } from "@tauri-apps/api/core";
import { binariesReady, toolStatus } from "../binaries";
import { banner, h, saveSettings, settings } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";
import { eagleControls, fileName, fileTray, folderField, paths, resultsPanel, statsBar, stem, TrayItem } from "./common";

type Model = { id: string; name: string; scales: number[]; hint: string };
const MODELS: Model[] = [
  { id: "realesrgan-x4plus", name: "Photo", scales: [4], hint: "Real-ESRGAN x4plus: photos and realistic images" },
  { id: "realesrgan-x4plus-anime", name: "Illustration", scales: [4], hint: "x4plus-anime: anime, drawings, line art" },
  { id: "realesr-animevideov3", name: "Video / fast", scales: [2, 3, 4], hint: "animevideov3: fast, made for video frames" },
];
type Prefs = { folder: string; eagle: boolean; model: string; scale: number; files: string[]; tray: TrayItem[] };

const IMAGES = ["png", "jpg", "jpeg", "webp"];
const VIDEOS = ["mp4", "mkv", "mov", "webm", "avi", "m4v"];
const isVideo = (p: string) => VIDEOS.some((e) => p.toLowerCase().endsWith(`.${e}`));

/** ffprobe: frame rate (as "num/den" for exactness) and duration in seconds. */
async function probeVideo(path: string): Promise<{ fps: string; duration: number; height: number }> {
  const j = await invoke<any>("tool_json", {
    bin: "ffprobe.exe",
    args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,height:format=duration", "-of", "json", path],
  });
  return { fps: j.streams?.[0]?.r_frame_rate ?? "30/1", duration: Number(j.format?.duration) || 0, height: Number(j.streams?.[0]?.height) || 0 };
}

export function renderUpscale(view: HTMLElement) {
  const prefs: Prefs = { folder: "", eagle: true, model: "realesrgan-x4plus", scale: 4, files: [], tray: [], ...settings.upscale };
  if (prefs.files.length) { prefs.tray = prefs.files.map((path) => ({ path })); prefs.files = []; } // pre-T12 shape
  const save = () => saveSettings({ upscale: prefs });

  const page = h(`<div class="page upscale">
    <div class="head"><div><h3>Upscale</h3><div class="sub">Real-ESRGAN on your GPU, for images and videos</div></div>
      <div class="right"><span class="chip" id="u-tool"><span class="dot"></span>Real-ESRGAN</span></div></div>
    <div id="u-stats"></div>
    <div class="u-files"></div>
    <div class="opts three">
      <div class="opt"><span class="field-label">Model</span><select class="select" id="u-model">${MODELS.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select></div>
      <div class="opt"><span class="field-label">Scale</span><select class="select" id="u-scale"></select></div>
      <div class="opt u-hint sub" id="u-hint"></div>
    </div>
    <div class="notice" id="u-video-note" hidden>${icon("info")}<span>Videos are upscaled frame by frame: expect several minutes per minute of video and a few GB of temporary space in hermes-data\\temp.</span></div>
    <div class="opts one" id="u-dest"></div>
    <div class="row2"><button class="btn primary" id="u-go" disabled>${icon("maximize")}Upscale</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#u-dest").append(folderField(prefs, save, "u-folder"));
  $(".row2").prepend(...eagleControls(prefs, save, "u-eagle"));
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

  $("#u-stats").append(statsBar());
  const tray = fileTray({ id: "u-drop", label: "Drop images or videos here", exts: [...IMAGES, ...VIDEOS], multiple: true, paste: true },
    () => prefs.tray, (l) => { prefs.tray = l; save(); }, () => update());
  $(".u-files").append(tray.el);
  function update() {
    const todo = tray.pending();
    $("#u-video-note").hidden = !todo.some((i) => isVideo(i.path));
    goBtn.disabled = !todo.length;
    goBtn.lastChild!.textContent = todo.length > 1 ? `Upscale ${todo.length} files` : "Upscale";
  }

  async function imageJob(input: string, p: { bin: string; results: string }): Promise<NewJob> {
    const dir = prefs.eagle ? p.results : prefs.folder;
    const output = `${dir}\\${stem(input)}-x${prefs.scale}-${Date.now()}.png`;
    await invoke("make_dirs", { paths: [dir] });
    const steps: Step[] = [{
      type: "run", label: "Upscaling", bin: "realesrgan-ncnn-vulkan.exe", parser: "percent", outputs: [output],
      args: ["-i", input, "-o", output, "-n", prefs.model, "-s", String(prefs.scale), "-m", `${p.bin}\\models`, "-f", "png"],
    }];
    if (prefs.eagle) steps.push({ type: "eagle", keep: true });
    return { module: "upscale", title: fileName(input), pill: `${prefs.scale}× ${MODELS.find((m) => m.id === prefs.model)?.name}`, steps, source: input, eagle: { tags: [`Upscaled ${prefs.scale}x`] } };
  }

  async function videoJob(input: string, p: { bin: string; data: string }): Promise<NewJob> {
    const v = await probeVideo(input);
    const tmp = `${p.data}\\temp\\upscale-${Date.now()}`;
    const output = `${prefs.folder}\\${stem(input)}-x${prefs.scale}.mp4`;
    await invoke("make_dirs", { paths: [`${tmp}\\in`, `${tmp}\\out`, prefs.folder] });
    // ponytail: whole video's frames on disk at once; process in chunks if temp space becomes a problem
    const steps: Step[] = [
      { type: "run", label: "Extracting frames", bin: "ffmpeg.exe", parser: "ffmpeg", duration: v.duration,
        args: ["-y", "-i", input, "-fps_mode", "passthrough", "-q:v", "2", "-progress", "pipe:1", "-nostats", `${tmp}\\in\\%08d.jpg`] },
      { type: "run", label: "Upscaling frames", bin: "realesrgan-ncnn-vulkan.exe", parser: "percent",
        args: ["-i", `${tmp}\\in`, "-o", `${tmp}\\out`, "-n", prefs.model, "-s", String(prefs.scale), "-m", `${p.bin}\\models`, "-f", "jpg"] },
      { type: "run", label: "Encoding (NVENC)", bin: "ffmpeg.exe", parser: "ffmpeg", duration: v.duration, outputs: [output],
        args: ["-y", "-framerate", v.fps, "-i", `${tmp}\\out\\%08d.jpg`, "-i", input, "-map", "0:v:0", "-map", "1:a:0?",
          "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p",
          "-c:a", "copy", "-shortest", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output] },
      { type: "delete", paths: [tmp] },
    ];
    if (prefs.eagle) steps.push({ type: "eagle" });
    return { module: "upscale", title: fileName(input), pill: `${prefs.scale}× video`, steps, source: input, eagle: { tags: [`Upscaled ${prefs.scale}x`] } };
  }

  goBtn.onclick = async () => {
    goBtn.disabled = true;
    await binariesReady;
    const p = await paths;
    const todo = tray.pending();
    try {
      const jobs = await Promise.all(todo.map((it) => (isVideo(it.path) ? videoJob(it.path, p) : imageJob(it.path, p))));
      tray.assign(todo, await addJobs(jobs));
    } catch (e) {
      banner({ id: "upscale-error", tone: "warn", icon: "alert", text: `Could not read the file: ${e}` });
    }
    update();
  };

  renderModel();
  update();
  page.append(resultsPanel("upscale"));
  mountQueue(page, "upscale");
  view.append(page);
}
