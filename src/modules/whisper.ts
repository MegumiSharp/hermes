// Subtitles module (SPEC 13): faster-whisper on the portable AI runtime.
import { invoke } from "@tauri-apps/api/core";
import { clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob } from "../queue";
import { confirmModelDownload, runtimeNotice, runtimeReady } from "./ai";
import { fileName, fileTray, folderField, paths, statsBar, TrayItem } from "./common";

const MODELS = [
  { id: "large-v3-turbo", name: "Large v3 Turbo", size: "1.6 GB", hint: "Best speed/quality balance (recommended)" },
  { id: "large-v3", name: "Large v3", size: "3.1 GB", hint: "Most accurate, slower" },
  { id: "medium", name: "Medium", size: "1.5 GB", hint: "Good accuracy" },
  { id: "small", name: "Small", size: "480 MB", hint: "Fast, decent accuracy" },
  { id: "base", name: "Base", size: "145 MB", hint: "Very fast, rough" },
];
const LANGS: Record<string, string> = {
  "": "Detect automatically", it: "Italian", en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian", tr: "Turkish", ar: "Arabic", hi: "Hindi", ja: "Japanese", ko: "Korean", zh: "Chinese",
};
const EXTS = ["mp4", "mkv", "mov", "webm", "avi", "mp3", "wav", "m4a", "flac", "ogg", "opus", "aac"];

export function renderWhisper(view: HTMLElement) {
  const { state, save } = memory("whisper", {
    folder: "", model: "large-v3-turbo", language: "", translate: false, formats: ["srt"] as string[], files: [] as string[], tray: [] as TrayItem[],
  });
  if (state.files.length) { state.tray = state.files.map((path) => ({ path })); state.files = []; } // pre-T12 shape
  clearers.set("whisper", () => { state.tray = []; save(); });

  const page = h(`<div class="page whisper">
    <div class="head"><div><h3>Subtitles</h3><div class="sub">Transcribe or translate speech to SRT, VTT or text with faster-whisper</div></div></div>
    <div id="w-notice"></div>
    <div id="w-stats"></div>
    <div class="w-files"></div>
    <div class="opts three">
      <div class="opt"><span class="field-label">Model</span><select class="select" id="w-model"></select></div>
      <div class="opt"><span class="field-label">Spoken language</span><select class="select" id="w-lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
      <div class="opt"><span class="field-label">Output</span><select class="select" id="w-task"><option value="transcribe">Same language</option><option value="translate">Translate to English</option></select></div>
    </div>
    <div class="w-formats"><span class="field-label">Formats</span>
      ${["srt", "vtt", "txt"].map((f) => `<label class="f-check"><input type="checkbox" data-fmt="${f}">${f.toUpperCase()}</label>`).join("")}</div>
    <div class="sub" id="w-hint"></div>
    <div class="opts one" id="w-dest"></div>
    <div class="row2"><button class="btn primary" id="w-go" disabled>${icon("captions")}Create subtitles</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const go = $<HTMLButtonElement>("#w-go");
  $("#w-notice").append(runtimeNotice("whisper", () => renderModels()));
  $("#w-dest").append(folderField(state, save, "w-folder"));
  $("#w-stats").append(statsBar());

  const model = $<HTMLSelectElement>("#w-model"), lang = $<HTMLSelectElement>("#w-lang"), task = $<HTMLSelectElement>("#w-task");
  let downloaded: string[] = [];
  async function renderModels() {
    downloaded = await invoke<string[]>("whisper_models");
    model.innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.name} · ${downloaded.includes(m.id) ? "downloaded" : m.size}</option>`).join("");
    model.value = state.model;
    $("#w-hint").textContent = MODELS.find((m) => m.id === state.model)!.hint;
  }
  model.onchange = () => { state.model = model.value; save(); renderModels(); };
  lang.value = state.language;
  lang.onchange = () => { state.language = lang.value; save(); };
  task.value = state.translate ? "translate" : "transcribe";
  task.onchange = () => { state.translate = task.value === "translate"; save(); };
  page.querySelectorAll<HTMLInputElement>("[data-fmt]").forEach((c) => {
    c.checked = state.formats.includes(c.dataset.fmt!);
    c.onchange = () => {
      state.formats = [...page.querySelectorAll<HTMLInputElement>("[data-fmt]")].filter((x) => x.checked).map((x) => x.dataset.fmt!);
      save();
      update();
    };
  });

  const tray = fileTray({ id: "w-drop", label: "Drop videos or audio here", exts: EXTS, multiple: true, paste: true },
    () => state.tray, (l) => { state.tray = l; save(); }, () => update());
  $(".w-files").append(tray.el);
  function update() {
    const n = tray.pending().length;
    go.disabled = !n || !state.formats.length;
    go.lastChild!.textContent = n > 1 ? `Create subtitles for ${n} files` : "Create subtitles";
  }

  function job(input: string, p: { python: string; data: string }): NewJob {
    return {
      module: "whisper", title: fileName(input), pill: state.translate ? "to English" : LANGS[state.language] || "auto", source: input,
      steps: [{
        type: "run", label: "Transcribing", bin: "python.exe", parser: "percent",
        args: [`${p.python}\\hermes\\hermes_whisper.py`, input, "--model", state.model, "--language", state.language,
          "--task", state.translate ? "translate" : "transcribe", "--formats", state.formats.join(","),
          "--output-dir", state.folder, "--models-dir", `${p.data}\\models\\whisper`],
      }],
    };
  }

  go.onclick = async () => {
    if (!(await runtimeReady("whisper"))) return;
    const m = MODELS.find((x) => x.id === state.model)!;
    if (!downloaded.includes(m.id) && !(await confirmModelDownload(`Whisper ${m.name}`, m.size))) return;
    const p = await paths;
    const todo = tray.pending();
    tray.assign(todo, await addJobs(todo.map((it) => job(it.path, p))));
    save();
    update();
  };

  renderModels();
  update();
  mountQueue(page, "whisper");
  view.append(page);
}
