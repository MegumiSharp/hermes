// Background Removal module (SPEC 7). Backend: src-tauri/src/rembg.rs (ONNX Runtime + DirectML).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { banner, h, modal, saveSettings, settings } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, Step } from "../queue";
import { beforeAfter, dropZone, eagleControls, fileName, folderField, paths, resultsPanel, stem } from "./common";

type Model = { id: string; name: string; mb: number; speed: string; useCase: string; installed: boolean };
type Prefs = { folder: string; eagle: boolean; model: string; background: string; crop: boolean; compare: string[] };
type CompareResult = { model: string; output: string; ms: number; error: string | null };

const EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** Model manager: nothing downloads until the user confirms names and total size. Resolves when closed. */
export function modelsModal(): Promise<void> {
  return new Promise(async (resolve) => {
    let models = await invoke<Model[]>("rembg_models");
    const body = h(`<div class="models"><p class="sub">Models run on your GPU through DirectML and are stored in <span class="mono">hermes-data\\models</span>. Tick the ones to download.</p><div class="m-list"></div><div class="m-total sub"></div></div>`);
    const list = body.querySelector(".m-list")!;
    const total = body.querySelector(".m-total")!;
    const picked = new Set<string>();
    const render = () => {
      list.replaceChildren(...models.map((m) => {
        const row = h(`<label class="m-row ${m.installed ? "installed" : ""}">
          <input type="checkbox" ${m.installed ? "disabled checked" : picked.has(m.id) ? "checked" : ""} data-id="${m.id}">
          <div class="m-info"><div><b></b> <span class="chip">${m.speed}</span></div><div class="sub"></div></div>
          <span class="mono sub">${gb(m.mb)}</span>
          ${m.installed ? `<button type="button" class="btn sm ghost" data-delete="${m.id}" title="Delete model" aria-label="Delete model">${icon("trash")}</button>` : `<span class="m-pad"></span>`}</label>`);
        row.querySelector("b")!.textContent = m.name;
        row.querySelector(".m-info .sub")!.textContent = m.installed ? `${m.useCase} · installed` : m.useCase;
        return row;
      }));
      const mb = models.filter((m) => picked.has(m.id)).reduce((a, m) => a + m.mb, 0);
      total.textContent = picked.size ? `${picked.size} selected · ${gb(mb)} to download` : "";
    };
    list.addEventListener("change", (e) => {
      const c = e.target as HTMLInputElement;
      c.checked ? picked.add(c.dataset.id!) : picked.delete(c.dataset.id!);
      render();
    });
    list.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-delete]");
      if (!b) return;
      e.preventDefault();
      await invoke("rembg_delete", { id: b.dataset.delete });
      models = await invoke("rembg_models");
      render();
    });
    render();
    modal({
      title: "Background removal models",
      body,
      onClose: resolve,
      actions: [
        { label: "Close" },
        {
          label: "Download selected", primary: true,
          run: async () => {
            const chosen = models.filter((m) => picked.has(m.id));
            if (!chosen.length) return false;
            if (!(await confirmDownload(chosen))) return false;
            await downloadModels(chosen);
          },
        },
      ],
    });
  });
}

function confirmDownload(chosen: Model[]): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const mb = chosen.reduce((a, m) => a + m.mb, 0);
    const body = h(`<div><p>Hermes will download <b>${chosen.length}</b> model${chosen.length > 1 ? "s" : ""} (<b>${gb(mb)}</b>) from the rembg project on GitHub:</p><ul class="steps"></ul></div>`);
    body.querySelector("ul")!.append(...chosen.map((m) => { const li = document.createElement("li"); li.textContent = `${m.name} · ${gb(m.mb)}`; return li; }));
    modal({ title: "Download models?", body, onClose: () => resolve(ok), actions: [{ label: "Cancel" }, { label: "Download", primary: true, run: () => { ok = true; } }] });
  });
}

async function downloadModels(chosen: Model[]) {
  const body = h(`<div class="m-progress"></div>`);
  for (const m of chosen) {
    const row = h(`<div class="progress" data-model="${m.id}"><div class="v"><b></b> <span class="mono sub">waiting</span></div><div class="bar"><i></i></div></div>`);
    row.querySelector("b")!.textContent = m.name;
    body.append(row);
  }
  const close = modal({ title: "Downloading models", body, actions: [] });
  const un = await listen<[string, number, number]>("model-progress", ({ payload: [id, done, total] }) => {
    const row = body.querySelector(`[data-model="${id}"]`);
    if (!row) return;
    row.querySelector<HTMLElement>(".bar i")!.style.width = `${total ? (done / total) * 100 : 0}%`;
    row.querySelector(".sub")!.textContent = `${Math.round(done / 1048576)} / ${Math.round(total / 1048576)} MB`;
  });
  try {
    await invoke("rembg_download", { ids: chosen.map((m) => m.id) });
    banner({ id: "rembg-models", icon: "check", text: `Downloaded ${chosen.map((m) => m.name).join(", ")}.` });
  } catch (e) {
    banner({ id: "rembg-models", tone: "warn", icon: "alert", text: `Model download failed: ${e}` });
  } finally {
    un();
    close();
  }
}

export function renderRembg(view: HTMLElement) {
  const prefs: Prefs = { folder: "", eagle: true, model: "birefnet-general", background: "", crop: false, compare: [], ...settings.rembg };
  const save = () => saveSettings({ rembg: prefs });
  let files: string[] = [];
  let compareFile = "";
  let mode: "batch" | "compare" = "batch";

  const page = h(`<div class="page rembg">
    <div class="head"><div><h3>Background Removal</h3><div class="sub">rembg models running on your GPU</div></div>
      <div class="right"><button class="btn sm" id="r-models">${icon("layers")}Models</button></div></div>
    <div class="notice" id="r-none" hidden>${icon("info")}<span>No model installed yet. Models are downloaded only after you confirm.</span>
      <button class="btn sm primary" id="r-get">Download models</button></div>
    <div class="tabs" role="tablist"><button class="tab on" data-mode="batch" role="tab">Batch</button><button class="tab" data-mode="compare" role="tab">Compare models</button></div>
    <div id="r-batch">
      <div class="r-files"></div>
      <div class="opts three">
        <div class="opt"><span class="field-label">Model</span><select class="select" id="r-model"></select></div>
        <div class="opt"><span class="field-label">Background</span><div class="r-bg">
          <select class="select" id="r-bgmode"><option value="">Transparent</option><option value="color">Solid color</option></select>
          <input type="color" id="r-color" value="#ffffff"></div></div>
        <div class="opt"><span class="field-label">&nbsp;</span><label class="check"><input type="checkbox" id="r-crop"><span class="box">${icon("check")}</span>Crop to subject</label></div>
      </div>
    </div>
    <div id="r-compare" hidden>
      <div class="r-files"></div>
      <div class="field-label">Models to compare</div><div class="r-pick" id="r-pick"></div>
      <div class="r-grid" id="r-grid"></div>
    </div>
    <div class="opts one" id="r-dest"></div>
    <div class="row2"><button class="btn primary" id="r-go" disabled>${icon("scissors")}Remove backgrounds</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#r-dest").append(folderField(prefs, save, "r-folder"));
  $(".row2").prepend(...eagleControls(prefs, save, "r-eagle"));
  const goBtn = $<HTMLButtonElement>("#r-go");

  // ----- models -----
  let models: Model[] = [];
  async function loadModels() {
    models = await invoke<Model[]>("rembg_models");
    const installed = models.filter((m) => m.installed);
    $("#r-none").hidden = installed.length > 0;
    if (installed.length && !installed.some((m) => m.id === prefs.model)) prefs.model = installed[0].id;
    $("#r-model").innerHTML = installed.map((m) => `<option value="${m.id}" ${m.id === prefs.model ? "selected" : ""}>${m.name}</option>`).join("") || `<option value="">No model installed</option>`;
    prefs.compare = prefs.compare.filter((id) => installed.some((m) => m.id === id));
    $("#r-pick").innerHTML = installed.map((m) => `<label class="f-check"><input type="checkbox" data-id="${m.id}" ${prefs.compare.includes(m.id) ? "checked" : ""}>${m.name}<span class="sub">${m.speed}</span></label>`).join("") || `<span class="sub">Install at least two models to compare them.</span>`;
    update();
  }
  const openModels = async () => { await modelsModal(); loadModels(); };
  $("#r-models").onclick = openModels;
  $("#r-get").onclick = openModels;
  $("#r-model").onchange = (e) => { prefs.model = (e.target as HTMLSelectElement).value; save(); };
  $("#r-pick").onchange = (e) => {
    const c = e.target as HTMLInputElement;
    prefs.compare = c.checked ? [...prefs.compare, c.dataset.id!] : prefs.compare.filter((x) => x !== c.dataset.id);
    save();
    update();
  };

  // ----- options -----
  const bgMode = $<HTMLSelectElement>("#r-bgmode");
  const color = $<HTMLInputElement>("#r-color");
  bgMode.value = prefs.background ? "color" : "";
  color.value = prefs.background || "#ffffff";
  color.hidden = !prefs.background;
  const saveBg = () => { prefs.background = bgMode.value ? color.value : ""; color.hidden = !bgMode.value; save(); };
  bgMode.onchange = saveBg;
  color.oninput = saveBg;
  const crop = $<HTMLInputElement>("#r-crop");
  crop.checked = prefs.crop;
  crop.onchange = () => { prefs.crop = crop.checked; save(); };

  // ----- tabs -----
  page.querySelector(".tabs")!.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]");
    if (!t) return;
    mode = t.dataset.mode as typeof mode;
    page.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
    $("#r-batch").hidden = mode !== "batch";
    $("#r-compare").hidden = mode !== "compare";
    update();
  });

  // ----- files -----
  const batchFiles = page.querySelector("#r-batch .r-files")!;
  const compareFiles = page.querySelector("#r-compare .r-files")!;
  function renderFiles() {
    batchFiles.replaceChildren(dropZone({ id: "r-drop", label: "Drop images here", exts: EXTS, multiple: true }, (p) => { files = [...new Set([...files, ...p])]; renderFiles(); }));
    if (files.length) {
      const chips = h(`<div class="file-chips"></div>`);
      chips.append(...files.map((f) => {
        const c = h(`<span class="chip file"><span></span><button type="button" aria-label="Remove">${icon("x")}</button></span>`);
        c.querySelector("span")!.textContent = stem(f);
        c.querySelector("button")!.onclick = () => { files = files.filter((x) => x !== f); renderFiles(); };
        return c;
      }));
      batchFiles.append(chips);
    }
    compareFiles.replaceChildren(dropZone({ id: "r-drop-compare", label: compareFile ? `Image: ${stem(compareFile)}` : "Drop one image to compare models on", exts: EXTS }, (p) => { compareFile = p[0]; renderFiles(); }));
    update();
  }
  function update() {
    const installed = models.some((m) => m.installed);
    goBtn.disabled = mode === "batch" ? !(installed && files.length) : !(compareFile && prefs.compare.length >= 1);
    goBtn.lastChild!.textContent = mode === "batch" ? (files.length > 1 ? `Remove ${files.length} backgrounds` : "Remove background") : `Compare ${prefs.compare.length} model${prefs.compare.length === 1 ? "" : "s"}`;
  }

  const outputFor = async (input: string, suffix: string) => {
    const dir = prefs.eagle ? (await paths).results : prefs.folder; // Eagle mode keeps a copy for the slider
    return `${dir}\\${stem(input)}-${suffix}-${Date.now()}.png`;
  };

  // ----- run -----
  goBtn.onclick = async () => {
    if (mode === "batch") {
      const jobs = await Promise.all(files.map(async (input) => {
        const steps: Step[] = [{ type: "rembg", model: prefs.model, input, output: await outputFor(input, "nobg"), background: prefs.background, crop: prefs.crop }];
        if (prefs.eagle) steps.push({ type: "eagle", keep: true });
        return { module: "rembg", title: fileName(input), pill: models.find((m) => m.id === prefs.model)?.name ?? prefs.model, steps, source: input, eagle: { tags: ["Background removed"] } };
      }));
      await addJobs(jobs);
      files = [];
      renderFiles();
      return;
    }
    goBtn.disabled = true;
    const grid = $("#r-grid");
    grid.innerHTML = prefs.compare.map((id) => `<div class="r-cell loading"><div class="r-img"></div><div class="sub">${models.find((m) => m.id === id)?.name} · running</div></div>`).join("");
    const results = await invoke<CompareResult[]>("rembg_compare", { input: compareFile, models: prefs.compare });
    grid.replaceChildren(...results.map((r) => {
      const name = models.find((m) => m.id === r.model)?.name ?? r.model;
      const cell = h(`<button type="button" class="r-cell"><div class="r-img"></div><div class="v"><b></b><span class="mono sub"></span></div></button>`) as HTMLButtonElement;
      cell.querySelector("b")!.textContent = name;
      cell.querySelector(".mono")!.textContent = r.error ? "failed" : `${(r.ms / 1000).toFixed(1)} s`;
      if (r.error) {
        cell.querySelector(".r-img")!.textContent = r.error;
        cell.disabled = true;
      } else {
        const img = h(`<img alt="">`) as HTMLImageElement;
        img.src = convertFileSrc(r.output);
        cell.querySelector(".r-img")!.append(img);
        cell.onclick = () => keepModal(r, name);
      }
      return cell;
    }));
    update();
  };

  function keepModal(r: CompareResult, name: string) {
    modal({
      title: name,
      body: beforeAfter(compareFile, r.output, ["Original", name]),
      actions: [
        { label: "Close" },
        {
          label: prefs.eagle ? "Keep and send to Eagle" : "Keep", primary: true,
          run: async () => {
            if (prefs.eagle) {
              await addJobs([{ module: "rembg", title: fileName(compareFile), pill: name, steps: [{ type: "eagle", keep: true }], outputs: [r.output], source: compareFile, eagle: { tags: ["Background removed", name] } }]);
            } else {
              const to = `${prefs.folder}\\${stem(compareFile)}-${r.model}.png`;
              await invoke("copy_file", { from: r.output, to });
              banner({ id: "rembg-kept", icon: "check", text: "Saved to the output folder." });
            }
          },
        },
      ],
    });
  }

  renderFiles();
  loadModels();
  page.append(resultsPanel("rembg"));
  mountQueue(page, "rembg");
  view.append(page);
}
