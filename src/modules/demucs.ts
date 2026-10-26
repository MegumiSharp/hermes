// Stem separation module (SPEC 12): Demucs on the portable AI runtime.
import { clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";
import { confirmModelDownload, runtimeNotice, runtimeReady } from "./ai";
import { eagleControls, fileName, fileTray, folderField, statsBar, stem, TrayItem } from "./common";

const MODELS = [
  { id: "htdemucs", name: "Standard", hint: "Fast, very good quality", size: "about 80 MB" },
  { id: "htdemucs_ft", name: "Fine-tuned", hint: "Best quality, about 4× slower", size: "about 320 MB" },
  { id: "htdemucs_6s", name: "6 stems", hint: "Adds guitar and piano (lower quality on those)", size: "about 55 MB" },
];
const FORMATS = { wav: "WAV", flac: "FLAC", mp3: "MP3 320" } as const;
type Format = keyof typeof FORMATS;
const EXTS = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "mp4", "mkv", "mov", "webm"];

export function renderDemucs(view: HTMLElement) {
  const { state, save } = memory("demucs", {
    folder: "", eagle: false, model: "htdemucs", twoStems: false, format: "wav" as Format, files: [] as string[], tray: [] as TrayItem[], usedModels: [] as string[],
  });
  if (state.files.length) { state.tray = state.files.map((path) => ({ path })); state.files = []; } // pre-T12 shape
  clearers.set("demucs", () => { state.tray = []; save(); });

  const page = h(`<div class="page demucs">
    <div class="head"><div><h3>Stem Separation</h3><div class="sub">Split songs into vocals, drums, bass and more with Demucs</div></div></div>
    <div id="d-notice"></div>
    <div id="d-stats"></div>
    <div class="d-files"></div>
    <div class="opts three">
      <div class="opt"><span class="field-label">Model</span><select class="select" id="d-model">${MODELS.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select></div>
      <div class="opt"><span class="field-label">Stems</span><select class="select" id="d-stems"><option value="all">All stems</option><option value="two">Vocals + instrumental</option></select></div>
      <div class="opt"><span class="field-label">Format</span><select class="select" id="d-format">${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    </div>
    <div class="sub" id="d-hint"></div>
    <div class="opts one" id="d-dest"></div>
    <div class="row2"><button class="btn primary" id="d-go" disabled>${icon("waveform")}Separate</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const go = $<HTMLButtonElement>("#d-go");
  $("#d-notice").append(runtimeNotice("demucs", () => update()));
  $("#d-stats").append(statsBar());
  $("#d-dest").append(folderField(state, save, "d-folder"));
  $(".row2").prepend(...eagleControls(state, save, "d-eagle"));

  const model = $<HTMLSelectElement>("#d-model"), stems = $<HTMLSelectElement>("#d-stems"), format = $<HTMLSelectElement>("#d-format");
  model.value = state.model;
  stems.value = state.twoStems ? "two" : "all";
  format.value = state.format;
  const hint = () => ($("#d-hint").textContent = MODELS.find((m) => m.id === state.model)!.hint);
  model.onchange = () => { state.model = model.value; hint(); save(); };
  stems.onchange = () => { state.twoStems = stems.value === "two"; save(); };
  format.onchange = () => { state.format = format.value as Format; save(); };
  hint();

  const tray = fileTray({ id: "d-drop", label: "Drop songs or videos here", exts: EXTS, multiple: true, paste: true },
    () => state.tray, (l) => { state.tray = l; save(); }, () => update());
  $(".d-files").append(tray.el);
  function update() {
    const n = tray.pending().length;
    go.disabled = !n;
    go.lastChild!.textContent = n > 1 ? `Separate ${n} files` : "Separate";
  }

  function job(input: string): NewJob {
    const names = state.twoStems ? ["vocals", "no_vocals"] : state.model === "htdemucs_6s" ? ["vocals", "drums", "bass", "other", "guitar", "piano"] : ["vocals", "drums", "bass", "other"];
    const ext = state.format;
    const outDir = `${state.folder}\\Stems`;
    const fmt = ext === "mp3" ? ["--mp3", "--mp3-bitrate", "320"] : ext === "flac" ? ["--flac"] : [];
    const steps: Step[] = [{
      type: "run", label: "Separating", bin: "python.exe", parser: "percent",
      outputs: names.map((n) => `${outDir}\\${state.model}\\${stem(input)} - ${n}.${ext}`),
      args: ["-m", "demucs", "-n", state.model, ...(state.twoStems ? ["--two-stems", "vocals"] : []), ...fmt,
        "-o", outDir, "--filename", "{track} - {stem}.{ext}", input],
    }];
    if (state.eagle) steps.push({ type: "eagle" });
    return { module: "demucs", title: fileName(input), pill: state.twoStems ? "2 stems" : `${names.length} stems`, steps, source: input, eagle: { tags: ["Stems", stem(input)] } };
  }

  go.onclick = async () => {
    if (!(await runtimeReady("demucs"))) return;
    const m = MODELS.find((x) => x.id === state.model)!;
    if (!state.usedModels.includes(m.id)) {
      if (!(await confirmModelDownload(`Demucs ${m.name}`, m.size))) return;
      state.usedModels.push(m.id);
    }
    const todo = tray.pending();
    tray.assign(todo, await addJobs(todo.map((it) => job(it.path))));
    save();
    update();
  };

  update();
  mountQueue(page, "demucs");
  view.append(page);
}
