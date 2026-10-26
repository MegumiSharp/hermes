// Video Converter module: FFmpeg presets (format, resolution up/down, fps, quality), GPU encoding
// where it helps. Fast scaling only (Lanczos); AI upscaling is for images (Image Upscale).
import { invoke } from "@tauri-apps/api/core";
import { binariesReady } from "../binaries";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob } from "../queue";
import { fileName, fileTray, folderField, statsBar, stem, TrayItem } from "./common";

type Preset = { label: string; ext: string; audioOnly?: boolean; args: (q: Quality) => string[] };
type Quality = "high" | "balanced" | "small";
const CQ: Record<Quality, number> = { high: 19, balanced: 24, small: 30 };

const PRESETS: Record<string, Preset> = {
  h264: { label: "MP4 · H.264 (GPU) · for Premiere and sharing", ext: "mp4",
    args: (q) => ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(CQ[q]), "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"] },
  h265: { label: "MP4 · H.265 (GPU) · smaller files", ext: "mp4",
    args: (q) => ["-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(CQ[q] + 2), "-b:v", "0", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"] },
  prores: { label: "MOV · ProRes 422 · smooth editing, very large", ext: "mov",
    args: (q) => ["-c:v", "prores_ks", "-profile:v", q === "high" ? "3" : q === "balanced" ? "2" : "1", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"] },
  webm: { label: "WebM · VP9 · for the web", ext: "webm",
    args: (q) => ["-c:v", "libvpx-vp9", "-crf", String(CQ[q] + 12), "-b:v", "0", "-row-mt", "1", "-c:a", "libopus", "-b:a", "160k"] },
  gif: { label: "GIF · animated, no audio", ext: "gif",
    args: () => ["-vf", "fps=15,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-an"] },
  mp3: { label: "MP3 · audio only, 320 kbps", ext: "mp3", audioOnly: true, args: () => ["-vn", "-c:a", "libmp3lame", "-b:a", "320k"] },
  wav: { label: "WAV · audio only, lossless", ext: "wav", audioOnly: true, args: () => ["-vn", "-c:a", "pcm_s16le"] },
};
const HEIGHTS = [0, 720, 1080, 1440, 2160];
const FPS = [0, 24, 25, 30, 50, 60];
const EXTS = ["mp4", "mkv", "mov", "webm", "avi", "m4v", "flv", "wmv", "mts", "ts", "gif"];

async function probe(path: string): Promise<{ duration: number; height: number }> {
  const j = await invoke<any>("tool_json", {
    bin: "ffprobe.exe",
    args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height:format=duration", "-of", "json", path],
  });
  return { duration: Number(j.format?.duration) || 0, height: Number(j.streams?.[0]?.height) || 0 };
}

export function renderConverter(view: HTMLElement) {
  const { state, save } = memory("converter", { folder: "", preset: "h264", height: 0, fps: 0, quality: "high" as Quality, tray: [] as TrayItem[] });
  clearers.set("converter", () => { state.tray = []; save(); });

  const page = h(`<div class="page converter">
    <div class="head"><div><h3>Video Converter</h3><div class="sub">Convert, resize (up or down) and re-encode videos with FFmpeg</div></div></div>
    <div id="c-stats"></div>
    <div class="c-files"></div>
    <div class="opts"><div class="opt"><span class="field-label">Convert to</span><select class="select" id="c-preset">
      ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("")}</select></div>
      <div class="opt"><span class="field-label">Quality</span><select class="select" id="c-quality">
        <option value="high">High (visually lossless)</option><option value="balanced">Balanced</option><option value="small">Small file</option></select></div></div>
    <div class="opts" id="c-video-opts">
      <div class="opt"><span class="field-label">Resolution</span><select class="select" id="c-height">
        ${HEIGHTS.map((h) => `<option value="${h}">${h ? `${h}p` : "Keep original"}</option>`).join("")}</select></div>
      <div class="opt"><span class="field-label">Frame rate</span><select class="select" id="c-fps">
        ${FPS.map((f) => `<option value="${f}">${f ? `${f} fps` : "Keep original"}</option>`).join("")}</select></div></div>
    <div class="sub" id="c-hint"></div>
    <div class="opts one" id="c-dest"></div>
    <div class="row2"><button class="btn primary" id="c-go" disabled>${icon("film")}Convert</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#c-stats").append(statsBar());
  $("#c-dest").append(folderField(state, save, "c-folder"));
  const go = $<HTMLButtonElement>("#c-go");

  const sel = (id: string, key: "preset" | "height" | "fps" | "quality", num = false) => {
    const s = $<HTMLSelectElement>(id);
    s.value = String(state[key]);
    s.onchange = () => { (state as any)[key] = num ? Number(s.value) : s.value; save(); hint(); };
  };
  sel("#c-preset", "preset"); sel("#c-quality", "quality"); sel("#c-height", "height", true); sel("#c-fps", "fps", true);
  function hint() {
    const p = PRESETS[state.preset];
    $("#c-video-opts").hidden = !!p.audioOnly;
    $("#c-hint").textContent = p.audioOnly ? "Extracts the audio track." :
      state.height ? `Resized to ${state.height}p with Lanczos (aspect ratio kept). Enlarging adds no detail: for real detail use Image Upscale on stills.` : "";
  }

  const tray = fileTray({ id: "c-drop", label: "Drop videos here", exts: EXTS, multiple: true, paste: true },
    () => state.tray, (l) => { state.tray = l; save(); }, () => update());
  $(".c-files").append(tray.el);
  function update() {
    const n = tray.pending().length;
    go.disabled = !n;
    go.lastChild!.textContent = n > 1 ? `Convert ${n} videos` : "Convert";
  }

  async function job(input: string): Promise<NewJob> {
    const p = PRESETS[state.preset];
    const { duration } = await probe(input);
    const vf = [state.height && !p.audioOnly ? `scale=-2:${state.height}:flags=lanczos` : "", state.fps && !p.audioOnly ? `fps=${state.fps}` : ""].filter(Boolean);
    const args = p.args(state.quality);
    // GIF already has a -vf chain: prepend ours
    const gifVf = args.indexOf("-vf");
    if (gifVf >= 0 && vf.length) args[gifVf + 1] = `${vf.join(",")},${args[gifVf + 1]}`;
    const tag = [p.ext.toUpperCase(), state.height ? `${state.height}p` : ""].filter(Boolean).join(" ");
    const output = `${state.folder}\\${stem(input)} (${tag}).${p.ext}`;
    return {
      module: "converter", title: fileName(input), pill: tag, source: input,
      steps: [{
        type: "run", label: "Converting", bin: "ffmpeg.exe", parser: "ffmpeg", duration, outputs: [output],
        args: ["-y", "-i", input, ...(gifVf < 0 && vf.length ? ["-vf", vf.join(",")] : []), ...args, "-progress", "pipe:1", "-nostats", output],
      }],
    };
  }

  go.onclick = async () => {
    go.disabled = true;
    await binariesReady;
    await invoke("make_dirs", { paths: [state.folder] });
    const todo = tray.pending();
    try {
      tray.assign(todo, await addJobs(await Promise.all(todo.map((it) => job(it.path)))));
    } catch (e) {
      banner({ id: "converter", tone: "warn", icon: "alert", text: `Could not read the video: ${e}` });
    }
    update();
  };

  hint();
  update();
  mountQueue(page, "converter");
  view.append(page);
}
