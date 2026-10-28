// Document Converter: DOCX, ODT, RTF, DOC, PDF, Markdown, LaTeX, HTML, EPUB, TXT, PPTX, XLSX. Engines are
// optional components installed only after the user agrees (docconv-routes.ts picks them):
// Pandoc (text formats), Tectonic (LaTeX → PDF), Poppler (PDF → images/text), LibreOffice (faithful
// office ↔ PDF, office.rs). Results go to the chosen folder; originals are never touched.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTask } from "../activity";
import { binariesReady, installTool, toolStatus } from "../binaries";
import { banner, clearers, h, memory, modal } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, NewJob, Step } from "../queue";
import { Engine, INPUTS, route, TARGETS, whyNot } from "./docconv-routes";
import { eagleControls, fileName, fileTray, folderField, paths, stem, TrayItem } from "./common";

const ENGINES: Record<Engine, { name: string; size: string; does: string }> = {
  pandoc: { name: "Pandoc", size: "43 MB", does: "converts between text formats" },
  tectonic: { name: "Tectonic", size: "21 MB, plus about 100 MB of LaTeX packages the first time", does: "typesets PDFs from LaTeX and Markdown" },
  poppler: { name: "Poppler", size: "44 MB", does: "reads PDFs (pages to images, text)" },
  office: { name: "LibreOffice", size: "375 MB download, 1.5 GB on disk", does: "faithful Word, PowerPoint and Excel to PDF, and PDF to Word" },
};
const extOf = (p: string) => p.split(".").pop()!.toLowerCase();

async function installed(e: Engine): Promise<boolean> {
  if (e === "office") return (await invoke<{ installed: boolean }>("office_status")).installed;
  return !!(await toolStatus(e))?.version;
}

/** LibreOffice in the background, progress on the Downloads page. */
async function installOffice(): Promise<boolean> {
  const task = startTask("office-install", "Installing LibreOffice", "docconv");
  const off = await listen<[string, number, number]>("office-progress", ({ payload: [stage, done, total] }) =>
    task.update(total ? done / total : null, `${stage}${total ? ` ${Math.round(done / 1048576)} / ${Math.round(total / 1048576)} MB` : ""}`));
  try {
    await invoke("office_install");
    return true;
  } catch (e) {
    banner({ id: "office", tone: "warn", icon: "alert", text: `Installing LibreOffice failed: ${e}` });
    return false;
  } finally {
    off();
    task.end();
  }
}

/** Asks once for every missing engine, then installs them; false = cancelled or failed. */
async function ensure(engines: Engine[]): Promise<boolean> {
  const missing: Engine[] = [];
  for (const e of engines) if (!(await installed(e))) missing.push(e);
  if (!missing.length) return true;
  const yes = await new Promise<boolean>((done) => modal({
    title: "Download conversion components?",
    body: h(`<div class="m-text"><p>These conversions need components Hermes doesn't include by default:</p>
      <ul>${missing.map((e) => `<li><b>${ENGINES[e].name}</b> (${ENGINES[e].size}): ${ENGINES[e].does}</li>`).join("")}</ul>
      <p class="sub">Downloaded once from their official sources into hermes-data. Remove them any time from Binaries.</p></div>`),
    actions: [{ label: "Cancel", run: () => done(false) }, { label: "Download", primary: true, run: () => done(true) }],
    onClose: () => done(false),
  }));
  if (!yes) return false;
  for (const e of missing) if (!(await (e === "office" ? installOffice() : installTool(e)))) return false;
  return true;
}

/** Queue steps for one file; `out` = the result path (or folder, for page images). */
function steps(input: string, target: string, engines: Engine[], folder: string, data: string): { steps: Step[]; out: string } {
  const ext = extOf(input);
  const out = `${folder}\\${stem(input)}.${target}`;
  // keeps LibreOffice portable; it's a file URL: spaces and accents must be escaped or LibreOffice crashes
  const profile = `-env:UserInstallation=file:///${encodeURI(data.replace(/\\/g, "/"))}/libreoffice-profile`;
  const run = (label: string, bin: string, args: string[], outputs: string[]): Step => ({ type: "run", label, bin, args, parser: "plain", outputs });
  switch (engines[0]) {
    case "office": {
      const fmt = target === "docx" ? "docx:MS Word 2007 XML" : target;
      return { out, steps: [run("Converting with LibreOffice", "soffice.exe", [profile, "--headless", "--norestore",
        ...(ext === "pdf" ? ["--infilter=writer_pdf_import"] : []), "--convert-to", fmt, "--outdir", folder, input], [out])] };
    }
    case "poppler": {
      if (target === "txt") return { out, steps: [run("Extracting the text", "pdftotext.exe", ["-layout", "-enc", "UTF-8", input, out], [out])] };
      const dir = `${folder}\\${stem(input)} pages`;
      return { out: dir, steps: [run("Rendering the pages", "pdftoppm.exe", ["-r", "150", target === "png" ? "-png" : "-jpeg", input, `${dir}\\page`], [dir])] };
    }
    case "tectonic":
      return { out, steps: [run("Typesetting with LaTeX", "tectonic.exe", [input, "--outdir", folder], [out])] };
    default: {
      const args = [input, "-o", out, "--standalone"];
      if (ext === "txt") args.push("-f", "markdown");
      if (target === "txt") args.push("-t", "plain");
      if (target === "pdf") args.push("--pdf-engine=tectonic", "-V", "geometry:margin=2.5cm");
      if (["md", "html"].includes(target) && ["docx", "odt", "epub"].includes(ext)) args.push(`--extract-media=${folder}\\${stem(input)} media`);
      return { out, steps: [run(target === "pdf" ? "Converting and typesetting" : "Converting with Pandoc", "pandoc.exe", args, [out])] };
    }
  }
}

export function renderDocConv(view: HTMLElement) {
  const { state, save } = memory("docconv", { folder: "", target: "pdf", eagle: false, tray: [] as TrayItem[] });
  clearers.set("docconv", () => { state.tray = []; save(); });

  const page = h(`<div class="page docconv">
    <div class="head"><div><h3>Document Converter</h3><div class="sub">Word, PDF, Markdown, LaTeX, web pages, e-books and more, in every useful direction</div></div></div>
    <div class="d-files"></div>
    <div class="opts"><div class="opt"><span class="field-label">Convert to</span><select class="select" id="dc-target">
      ${Object.entries(TARGETS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
      <div id="dc-dest"></div></div>
    <div class="dc-uses" id="dc-uses"></div>
    <div class="row2"><button class="btn primary" id="dc-go" disabled>${icon("copy")}Convert</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  $("#dc-dest").append(folderField(state, save, "dc-folder"));
  $(".row2").prepend(...eagleControls(state, save, "dc-eagle"));
  const go = $<HTMLButtonElement>("#dc-go");
  const target = $<HTMLSelectElement>("#dc-target");
  target.value = state.target;
  target.onchange = () => { state.target = target.value; save(); update(); };

  const tray = fileTray({ id: "dc-drop", label: "Drop documents here", exts: INPUTS, multiple: true, paste: true },
    () => state.tray, (l) => { state.tray = l; save(); }, () => update());
  $(".d-files").append(tray.el);

  /** What will run, what needs downloading, which files can't become the chosen format. */
  async function update() {
    const files = tray.pending();
    const ok = files.filter((f) => route(extOf(f.path), state.target));
    const bad = files.filter((f) => !route(extOf(f.path), state.target));
    const engines = [...new Set(ok.flatMap((f) => route(extOf(f.path), state.target)!))];
    go.disabled = !ok.length;
    go.lastChild!.textContent = ok.length > 1 ? `Convert ${ok.length} files` : "Convert";
    const uses = $("#dc-uses");
    uses.replaceChildren();
    if (engines.length) {
      const chips = await Promise.all(engines.map(async (e) => {
        const has = await installed(e);
        const c = h(`<span class="chip ${has ? "" : "off"}" title="${ENGINES[e].does}"><span class="dot"></span></span>`);
        c.append(`${ENGINES[e].name}${has ? "" : ` · will download ${ENGINES[e].size.split(",")[0]}`}`);
        return c;
      }));
      uses.append(h(`<span class="sub">Uses</span>`), ...chips);
    }
    if (bad.length) {
      const b = h(`<div class="sub dc-bad"></div>`);
      b.textContent = `${bad.length} file${bad.length > 1 ? "s" : ""} can't become ${TARGETS[state.target]}: ${[...new Set(bad.map((f) => `${extOf(f.path).toUpperCase()} (${whyNot(extOf(f.path), state.target)})`))].join(", ")}.`;
      uses.append(b);
    }
  }

  go.onclick = async () => {
    const todo = tray.pending().filter((f) => route(extOf(f.path), state.target));
    const engines = [...new Set(todo.flatMap((f) => route(extOf(f.path), state.target)!))];
    go.disabled = true;
    await binariesReady;
    if (!(await ensure(engines))) return update();
    const { data } = await paths;
    await invoke("make_dirs", { paths: [state.folder, ...todo.filter(() => ["png", "jpg"].includes(state.target)).map((f) => `${state.folder}\\${stem(f.path)} pages`)] });
    const jobs: NewJob[] = todo.map((f) => {
      const r = route(extOf(f.path), state.target)!;
      const s = steps(f.path, state.target, r, state.folder, data);
      if (state.eagle) s.steps.push({ type: "eagle", keep: true });
      return { module: "docconv", title: fileName(f.path), pill: `${extOf(f.path).toUpperCase()} → ${state.target.toUpperCase()}`, source: f.path, steps: s.steps,
        ...(state.eagle ? { eagle: { tags: ["Hermes", state.target.toUpperCase()] } } : {}) };
    });
    try {
      tray.assign(todo, await addJobs(jobs));
    } catch (e) {
      banner({ id: "docconv", tone: "warn", icon: "alert", text: `Could not start the conversion: ${e}` });
    }
    update();
  };

  update();
  mountQueue(page, "docconv");
  view.append(page);
}
