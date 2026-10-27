// Background Removal module (SPEC 7). Backend: src-tauri/src/rembg.rs (ONNX Runtime + DirectML).
// State lives at module level (not per render): a compare keeps running and its results stay when
// you switch tools; everything is also persisted in settings.json.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTask, taskRunning } from "../activity";
import { banner, clearers, h, memory, modal } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, Step } from "../queue";
import { eagleControls, fileName, fileTray, folderField, resultsPanel, resultViewer, statsBar, stem, thumbSrc, TrayItem } from "./common";

type Model = { id: string; name: string; mb: number; speed: string; useCase: string; installed: boolean };
type CompareResult = { model: string; output: string; ms: number; device: string; error: string | null };

const EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

const { state, save } = memory("rembg", {
  folder: "", eagle: true, model: "birefnet-general", background: "", crop: false, gentle: false, compare: [] as string[],
  batch: [] as TrayItem[], compareFile: [] as TrayItem[], mode: "batch" as "batch" | "compare", results: [] as CompareResult[],
  files: undefined as string[] | undefined, // pre-T12 shape, migrated below
});
if (state.files) { state.batch = state.files.map((path) => ({ path })); state.files = undefined; }
if (typeof (state.compareFile as unknown) === "string") {
  const old = state.compareFile as unknown as string;
  state.compareFile = old ? [{ path: old }] : [];
}

/** Compare in progress (survives switching tools). */
let comparing: { input: string; models: string[] } | null = null;
let redraw = () => {}; // the mounted page, if any
listen<CompareResult>("rembg-compare", ({ payload }) => {
  if (!comparing) return;
  state.results = [...state.results.filter((r) => r.model !== payload.model), payload];
  save();
  redraw();
});
const modelsChanged = () => window.dispatchEvent(new Event("hermes:rembg-models"));

/** Model manager: nothing downloads until the user confirms names and total size. */
export async function modelsModal() {
  let models = await invoke<Model[]>("rembg_models");
  const body = h(`<div class="models"><p class="sub">Models run on your GPU through DirectML and are stored in <span class="mono">hermes-data\\models</span>. Tick the ones to download; downloads continue in the background.</p><div class="m-list"></div><div class="m-total sub"></div></div>`);
  const list = body.querySelector(".m-list")!;
  const total = body.querySelector(".m-total")!;
  const picked = new Set<string>();
  const renderTotal = () => {
    const mb = models.filter((m) => picked.has(m.id)).reduce((a, m) => a + m.mb, 0);
    total.textContent = picked.size ? `${picked.size} selected · ${gb(mb)} to download` : "";
  };
  const render = () => {
    list.replaceChildren(...models.map((m) => {
      const busy = taskRunning(`model-${m.id}`);
      const row = h(`<label class="m-row ${m.installed ? "installed" : ""}">
        <input type="checkbox" ${m.installed || busy ? "disabled" : ""} ${m.installed || picked.has(m.id) ? "checked" : ""} data-id="${m.id}">
        <div class="m-info"><div><b></b> <span class="chip">${m.speed}</span></div><div class="sub"></div></div>
        <span class="mono sub">${gb(m.mb)}</span>
        ${m.installed ? `<button type="button" class="btn sm ghost" data-delete="${m.id}" title="Delete model" aria-label="Delete model">${icon("trash")}</button>` : `<span class="m-pad"></span>`}</label>`);
      row.querySelector("b")!.textContent = m.name;
      row.querySelector(".m-info .sub")!.textContent = `${m.useCase}${m.installed ? " · installed" : busy ? " · downloading" : ""}`;
      return row;
    }));
    renderTotal();
  };
  list.addEventListener("change", (e) => {
    const c = e.target as HTMLInputElement;
    c.checked ? picked.add(c.dataset.id!) : picked.delete(c.dataset.id!);
    renderTotal(); // don't rebuild the list: keeps keyboard focus on the checkbox
  });
  list.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-delete]");
    if (!b) return;
    e.preventDefault();
    await invoke("rembg_delete", { id: b.dataset.delete });
    models = await invoke("rembg_models");
    render();
    modelsChanged();
  });
  render();
  modal({
    title: "Background removal models",
    body,
    actions: [
      { label: "Close" },
      {
        label: "Download selected", primary: true,
        run: async () => {
          const chosen = models.filter((m) => picked.has(m.id));
          if (!chosen.length) return false;
          if (!(await confirmDownload(chosen))) return false;
          downloadModels(chosen); // background: the modal closes, Hermes stays usable
        },
      },
    ],
  });
}

function confirmDownload(chosen: Model[]): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const mb = chosen.reduce((a, m) => a + m.mb, 0);
    const body = h(`<div><p>Hermes will download <b>${chosen.length}</b> model${chosen.length > 1 ? "s" : ""} (<b>${gb(mb)}</b>) from the rembg project on GitHub. You can keep using Hermes meanwhile; progress is in the sidebar.</p><ul class="steps"></ul></div>`);
    body.querySelector("ul")!.append(...chosen.map((m) => { const li = document.createElement("li"); li.textContent = `${m.name} · ${gb(m.mb)}`; return li; }));
    modal({ title: "Download models?", body, onClose: () => resolve(ok), actions: [{ label: "Cancel" }, { label: "Download", primary: true, run: () => { ok = true; } }] });
  });
}

async function downloadModels(chosen: Model[]) {
  const tasks = new Map(chosen.map((m) => [m.id, startTask(`model-${m.id}`, `${m.name} model`, "rembg")]));
  const un = await listen<[string, number, number]>("model-progress", ({ payload: [id, done, total] }) => {
    tasks.get(id)?.update(total ? done / total : null, `${Math.round(done / 1048576)} / ${Math.round(total / 1048576)} MB`);
  });
  try {
    await invoke("rembg_download", { ids: chosen.map((m) => m.id) });
    banner({ id: "rembg-models", icon: "check", text: `Downloaded ${chosen.map((m) => m.name).join(", ")}.` });
  } catch (e) {
    banner({ id: "rembg-models", tone: "warn", icon: "alert", text: `Model download failed: ${e}` });
  } finally {
    un();
    tasks.forEach((t) => t.end());
    modelsChanged();
  }
}

export function renderRembg(view: HTMLElement) {
  const page = h(`<div class="page rembg">
    <div class="head"><div><h3>Background Removal</h3><div class="sub">rembg models running on your GPU</div></div>
      <div class="right"><button class="btn sm" id="r-models">${icon("layers")}Models</button></div></div>
    <div id="r-stats"></div>
    <div class="notice" id="r-none" hidden>${icon("info")}<span>No model installed yet. Models are downloaded only after you confirm.</span>
      <button class="btn sm primary" id="r-get">Download models</button></div>
    <div class="tabs" role="tablist"><button class="tab" data-mode="batch" role="tab">Batch</button><button class="tab" data-mode="compare" role="tab">Compare models</button></div>
    <section class="stack" id="r-batch">
      <div id="r-batch-tray"></div>
      <div class="opts three">
        <div class="opt"><span class="field-label">Model</span><select class="select" id="r-model"></select></div>
        <div class="opt"><span class="field-label">Background</span><div class="r-bg">
          <select class="select" id="r-bgmode"><option value="">Transparent</option><option value="color">Solid color</option></select>
          <input type="color" id="r-color" value="#ffffff"></div></div>
        <div class="opt"><span class="field-label">Crop</span><label class="check"><input type="checkbox" id="r-crop"><span class="box">${icon("check")}</span>Crop to subject</label></div>
      </div>
    </section>
    <section class="stack" id="r-compare">
      <div id="r-compare-tray"></div>
      <div><div class="field-label">Models to compare</div><div class="r-pick" id="r-pick"></div></div>
      <div class="r-grid" id="r-grid"></div>
    </section>
    <div class="opts"><div class="opt"><span class="field-label">Performance</span><select class="select" id="r-perf">
      <option value="fast">Fast (GPU): quickest, the PC may feel slower while it works</option>
      <option value="gentle">Gentle (CPU, 2 cores): slower, the PC stays smooth</option></select></div>
      <div id="r-dest"></div></div>
    <div class="row2"><button class="btn primary" id="r-go" disabled>${icon("scissors")}Remove backgrounds</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#r-stats").append(statsBar());
  $("#r-dest").append(folderField(state, save, "r-folder"));
  $(".row2").prepend(...eagleControls(state, save, "r-eagle"));
  const goBtn = $<HTMLButtonElement>("#r-go");

  // ----- models -----
  let models: Model[] = [];
  async function loadModels() {
    models = await invoke<Model[]>("rembg_models");
    const installed = models.filter((m) => m.installed);
    $("#r-none").hidden = installed.length > 0;
    if (installed.length && !installed.some((m) => m.id === state.model)) state.model = installed[0].id;
    $("#r-model").innerHTML = installed.map((m) => `<option value="${m.id}" ${m.id === state.model ? "selected" : ""}>${m.name}</option>`).join("") || `<option value="">No model installed</option>`;
    state.compare = state.compare.filter((id) => installed.some((m) => m.id === id));
    $("#r-pick").innerHTML = installed.map((m) => `<label class="f-check"><input type="checkbox" data-id="${m.id}" ${state.compare.includes(m.id) ? "checked" : ""}>${m.name}<span class="sub">${m.speed}</span></label>`).join("") || `<span class="sub">Install at least two models to compare them.</span>`;
    update();
  }
  const onModels = () => (page.isConnected ? loadModels() : window.removeEventListener("hermes:rembg-models", onModels));
  window.addEventListener("hermes:rembg-models", onModels);
  $("#r-models").onclick = () => modelsModal();
  $("#r-get").onclick = () => modelsModal();
  $<HTMLSelectElement>("#r-model").onchange = (e) => { state.model = (e.target as HTMLSelectElement).value; save(); };
  $("#r-pick").onchange = (e) => {
    const c = e.target as HTMLInputElement;
    state.compare = c.checked ? [...state.compare, c.dataset.id!] : state.compare.filter((x) => x !== c.dataset.id);
    save();
    update();
  };

  // ----- options -----
  const bgMode = $<HTMLSelectElement>("#r-bgmode");
  const color = $<HTMLInputElement>("#r-color");
  bgMode.value = state.background ? "color" : "";
  color.value = state.background || "#ffffff";
  color.hidden = !state.background;
  const saveBg = () => { state.background = bgMode.value ? color.value : ""; color.hidden = !bgMode.value; save(); };
  bgMode.onchange = saveBg;
  color.oninput = saveBg;
  const crop = $<HTMLInputElement>("#r-crop");
  crop.checked = state.crop;
  crop.onchange = () => { state.crop = crop.checked; save(); };
  const perf = $<HTMLSelectElement>("#r-perf");
  perf.value = state.gentle ? "gentle" : "fast";
  perf.onchange = () => { state.gentle = perf.value === "gentle"; save(); };

  // ----- inputs -----
  const batch = fileTray({ id: "r-drop", label: "Drop images here", exts: EXTS, multiple: true, paste: true },
    () => state.batch, (l) => { state.batch = l; save(); }, () => update());
  $("#r-batch-tray").append(batch.el);
  const single = fileTray({ id: "r-drop-compare", label: "Drop one image to compare models on", exts: EXTS, paste: true },
    () => state.compareFile, (l) => {
      if (l[0]?.path !== state.compareFile[0]?.path) state.results = [];
      state.compareFile = l;
      save();
      drawResults();
    }, () => update());
  $("#r-compare-tray").append(single.el);

  // ----- tabs -----
  function setMode(m: typeof state.mode) {
    state.mode = m;
    page.querySelectorAll<HTMLElement>(".tab").forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
    $("#r-batch").hidden = m !== "batch";
    $("#r-compare").hidden = m !== "compare";
    update();
  }
  page.querySelector(".tabs")!.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]");
    if (t) { setMode(t.dataset.mode as typeof state.mode); save(); }
  });

  function update() {
    const installed = models.some((m) => m.installed);
    const pending = batch.pending().length;
    if (state.mode === "batch") {
      goBtn.disabled = !(installed && pending);
      goBtn.lastChild!.textContent = pending > 1 ? `Remove ${pending} backgrounds` : "Remove background";
    } else {
      goBtn.disabled = !!comparing || !(state.compareFile.length && state.compare.length);
      goBtn.lastChild!.textContent = comparing ? "Comparing" : `Compare ${state.compare.length} model${state.compare.length === 1 ? "" : "s"}`;
    }
  }

  const outputFor = (input: string, suffix: string) => `${state.folder}\\${stem(input)}-${suffix}-${Date.now()}.png`;

  // ----- run -----
  goBtn.onclick = async () => {
    if (state.mode === "batch") {
      const todo = batch.pending();
      const modelName = models.find((m) => m.id === state.model)?.name ?? state.model;
      const jobs = await Promise.all(todo.map(async (it) => {
        const steps: Step[] = [{ type: "rembg", model: state.model, input: it.path, output: outputFor(it.path, "nobg"), background: state.background, crop: state.crop, gentle: state.gentle }];
        if (state.eagle) steps.push({ type: "eagle", keep: true });
        return { module: "rembg", title: fileName(it.path), pill: modelName, steps, source: it.path, eagle: { tags: ["Background removed"] } };
      }));
      batch.assign(todo, await addJobs(jobs));
      update();
      return;
    }
    const input = state.compareFile[0].path;
    comparing = { input, models: [...state.compare] };
    state.results = [];
    save();
    redraw();
    const task = startTask("rembg-compare", `Comparing ${comparing.models.length} models`, "rembg");
    try {
      await invoke("rembg_compare", { input, models: comparing.models, gentle: state.gentle });
    } finally {
      comparing = null;
      task.end();
      redraw();
    }
  };

  // ----- compare results -----
  const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  function drawResults() {
    const grid = $("#r-grid");
    const waiting = comparing?.models.filter((id) => !state.results.some((r) => r.model === id)) ?? [];
    grid.replaceChildren(
      ...state.results.map((r, i) => {
        const cell = h(`<button type="button" class="r-cell"><div class="r-img"></div><div class="v"><b></b><span class="mono sub"></span></div></button>`) as HTMLButtonElement;
        cell.querySelector("b")!.textContent = nameOf(r.model);
        cell.querySelector(".mono")!.textContent = r.error ? "failed" : `${(r.ms / 1000).toFixed(1)} s · ${r.device}`;
        if (r.error) {
          const err = h(`<span class="r-err"></span>`);
          err.textContent = r.error;
          cell.querySelector(".r-img")!.append(err);
          cell.onclick = () => navigator.clipboard.writeText(`${nameOf(r.model)}: ${r.error}`).then(() => banner({ id: "copied", icon: "check", text: "Error copied to the clipboard." }));
          cell.title = "Click to copy the error";
        } else {
          const img = h(`<img alt="">`) as HTMLImageElement;
          thumbSrc(r.output).then((s) => (img.src = s), () => cell.remove()); // cleaned up (older than 7 days)
          cell.querySelector(".r-img")!.append(img);
          cell.onclick = () => openViewer(i);
        }
        return cell;
      }),
      ...waiting.map((id) => {
        const c = h(`<div class="r-cell loading"><div class="r-img"></div><div class="sub"></div></div>`);
        c.querySelector(".sub")!.textContent = `${nameOf(id)} · running`;
        return c;
      }),
    );
  }

  function openViewer(start: number) {
    const ok = state.results.filter((r) => !r.error);
    const input = state.compareFile[0]?.path ?? "";
    resultViewer(`Compare · ${fileName(input)}`,
      ok.map((r) => ({ before: input, after: r.output, label: nameOf(r.model), sub: `${(r.ms / 1000).toFixed(1)} s · ${r.device}` })),
      Math.max(0, ok.indexOf(state.results[start])),
      {
        label: state.eagle ? "Keep and send to Eagle" : "Keep",
        run: async (i) => {
          const r = ok[i];
          if (state.eagle) {
            await addJobs([{ module: "rembg", title: fileName(input), pill: nameOf(r.model), steps: [{ type: "eagle", keep: true }], outputs: [r.output], source: input, eagle: { tags: ["Background removed", nameOf(r.model)] } }]);
          } else {
            await invoke("copy_file", { from: r.output, to: `${state.folder}\\${stem(input)}-${r.model}.png` });
            banner({ id: "rembg-kept", icon: "check", text: "Saved to the output folder." });
          }
          return false; // stay open: keep more than one
        },
      });
  }

  redraw = () => { if (page.isConnected) { drawResults(); update(); } };
  clearers.set("rembg", () => {
    Object.assign(state, { batch: [], compareFile: [], results: [] });
    save();
  });
  setMode(state.mode);
  drawResults();
  loadModels();
  page.append(resultsPanel("rembg"));
  mountQueue(page, "rembg");
  view.append(page);
}
