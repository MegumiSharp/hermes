// T20b test: Document Converter. Routes (pure, under node), then the real app: each engine is asked
// for once and downloaded (Pandoc, Tectonic, Poppler, LibreOffice), conversions in every family,
// unsupported files explained, components and models removable from Binaries. Needs network.
// Usage: node scripts/t20b-test.mjs   (ONLY=routes,pandoc,tex,poppler,office,remove; office downloads 375 MB)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { route } from "../src/modules/docconv-routes.ts";
import { check, launch, OUT } from "./smoke.mjs";

const only = (s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
check(JSON.stringify(route("md", "pdf")) === '["pandoc","tectonic"]', "Markdown → PDF = Pandoc + Tectonic");
check(JSON.stringify(route("tex", "pdf")) === '["tectonic"]', "LaTeX → PDF = Tectonic");
check(JSON.stringify(route("docx", "pdf")) === '["office"]' && JSON.stringify(route("pdf", "docx")) === '["office"]', "Word ↔ PDF = LibreOffice");
check(JSON.stringify(route("pdf", "png")) === '["poppler"]' && JSON.stringify(route("pdf", "txt")) === '["poppler"]', "PDF → pages/text = Poppler");
check(route("doc", "md") === null && route("pptx", "docx") === null && route("md", "md") === null && route("md", "png") === null, "impossible routes refused");
check(JSON.stringify(route("docx", "md")) === '["pandoc"]', "Word → Markdown = Pandoc");
if (process.env.ONLY === "routes") { console.log("T20b ROUTES PASSED"); process.exit(0); }

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t20b");
const DEST = join(W, "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(500);
  }
}
async function drop(page, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([name, data]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    document.querySelector("#dc-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [basename(file), b64]);
}
const seen = new Set();
/** Target + file → (download prompt if `expect` lists engines) → finished job. */
async function convert(page, target, file, expect = [], ms = 300000) {
  await page.click("[data-clear-all]").catch(() => {});
  await page.selectOption("#dc-target", target);
  await drop(page, file);
  await until(() => page.$eval("#dc-go", (b) => !b.disabled), "file ready", 10000);
  await page.click("#dc-go");
  if (expect.length) {
    await until(() => page.isVisible(".modal"), "download prompt", 10000);
    const text = await page.textContent(".modal");
    check(expect.every((e) => text.includes(e)), `asks before downloading ${expect.join(" + ")}`);
    await page.click(".modal .btn.primary");
  }
  const id = await until(async () => (await jobs(page)).find((j) => j.module === "docconv" && !seen.has(j.id))?.id, `${target} job queued (components installed)`, ms);
  seen.add(id);
  const j = await until(async () => { const x = (await jobs(page)).find((y) => y.id === id); return ["done", "failed"].includes(x.state) ? x : null; }, `${basename(file)} → ${target}`, ms);
  check(j.state === "done", `${basename(file)} → ${target}: done${j.error ? ": " + j.error : ""}`);
  return j;
}
const magic = (f, s) => readFileSync(f).subarray(0, s.length).toString("latin1") === s;

if (only("pandoc") || only("tex") || only("poppler") || only("office") || only("remove")) {
  mkdirSync(DEST, { recursive: true });
  rmSync(join(DATA, "queue.json"), { force: true });
  writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "docconv", autoUpdateYtdlp: false, docconv: { folder: DEST } }));
  const md = join(W, "notes.md");
  if (!existsSync(md)) writeFileSync(md, "# Ciao Hermes\n\nUn documento di prova con accenti: perché, città.\n\n- uno\n- due\n\n**Grassetto** e *corsivo*.\n");
  writeFileSync(join(W, "old.doc"), "not really a doc");
  const app = await launch(EXE);
  const { page } = app;
  await page.waitForSelector("#dc-target");

  if (only("pandoc")) {
    for (const id of ["pandoc", "tectonic", "poppler"]) await invoke(page, "binary_remove", { id }).catch(() => {});
    await page.reload(); await page.waitForSelector("#dc-target");
    // hint for files that can't become the target
    await page.selectOption("#dc-target", "md");
    await drop(page, join(W, "old.doc"));
    await until(async () => (await page.textContent("#dc-uses")).includes("can't become"), "unsupported file explained", 10000);
    check((await page.textContent("#dc-uses")).includes("DOCX first"), `hint: "${await page.textContent(".dc-bad")}"`);
    check(await page.$eval("#dc-go", (b) => b.disabled), "nothing to convert = button off");
    await page.click("[data-clear-all]");
    await page.selectOption("#dc-target", "docx");
    await drop(page, md);
    await until(async () => (await page.textContent("#dc-uses")).includes("will download"), "shows what will be downloaded", 10000);
    await page.click("[data-clear-all]");
    await convert(page, "docx", md, ["Pandoc"]);
    check(magic(join(DEST, "notes.docx"), "PK"), "Markdown → Word file");
    await convert(page, "html", md);
    check(readFileSync(join(DEST, "notes.html"), "utf8").includes("Ciao Hermes"), "Markdown → HTML with the text");
    await convert(page, "md", join(DEST, "notes.docx"));
    check(readFileSync(join(DEST, "notes.md"), "utf8").includes("città"), "Word → Markdown keeps accents");
    await convert(page, "epub", md);
    check(magic(join(DEST, "notes.epub"), "PK"), "Markdown → EPUB");
  }
  if (only("tex")) {
    await invoke(page, "binary_remove", { id: "tectonic" }).catch(() => {}); // ask-before-download is tested every run
    await page.reload(); await page.waitForSelector("#dc-target");
    await convert(page, "pdf", md, ["Tectonic"], 600000); // first run downloads LaTeX packages
    check(magic(join(DEST, "notes.pdf"), "%PDF"), "Markdown → PDF typeset with LaTeX");
    const tex = join(W, "paper.tex");
    writeFileSync(tex, "\\documentclass{article}\\begin{document}Hello \\LaTeX{} from Hermes, $e=mc^2$.\\end{document}\n");
    await convert(page, "pdf", tex, [], 300000);
    check(magic(join(DEST, "paper.pdf"), "%PDF"), "LaTeX → PDF");
  }
  if (only("poppler")) {
    await invoke(page, "binary_remove", { id: "poppler" }).catch(() => {}); // ask-before-download is tested every run
    await page.reload(); await page.waitForSelector("#dc-target");
    const pdf = join(DEST, "notes.pdf");
    await convert(page, "png", pdf, ["Poppler"]);
    const pages = readdirSync(join(DEST, "notes pages"));
    check(pages.some((f) => /^page-0*1\.png$/.test(f)), `PDF → page images (${pages.join(", ")})`);
    await convert(page, "txt", pdf);
    check(readFileSync(join(DEST, "notes.txt"), "utf8").includes("Ciao Hermes"), "PDF → text");
  }
  if (only("office")) {
    const had = (await invoke(page, "office_status")).installed; // a previous run may have installed it (375 MB)
    await convert(page, "pdf", join(DEST, "notes.docx"), had ? [] : ["LibreOffice"], 1800000);
    check((await invoke(page, "office_status")).installed, "LibreOffice installed (silently, no installer window)");
    check(magic(join(DEST, "notes.pdf"), "%PDF"), "Word → PDF with LibreOffice");
    rmSync(join(DEST, "notes.docx"));
    await convert(page, "docx", join(DEST, "notes.pdf"));
    check(magic(join(DEST, "notes.docx"), "PK"), "PDF → editable Word");
  }
  if (only("remove")) {
    await page.click('.nav[data-id="binaries"]');
    await page.waitForSelector("#office-card");
    check(await page.isVisible('[data-bin="pandoc"] [data-remove]'), "Pandoc removable from Binaries");
    await page.click("#ai-check");
    await until(() => page.$eval("#ai-check", (b) => !b.disabled), "models listed", 120000);
    check((await page.$$("#ai-rows [data-model] .bin-act button")).length > 0, "models have Delete buttons");
    check(await invoke(page, "model_delete", { kind: "demucs", id: "..\\x" }).then(() => false, () => true), "model_delete refuses paths");
    await page.screenshot({ path: join(OUT, "t20b-binaries.png"), fullPage: true });
  }
  await page.click('.nav[data-id="docconv"]').catch(() => {});
  await page.screenshot({ path: join(OUT, "t20b.png"), fullPage: true });
  check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
  await app.close();
}
console.log("T20b TEST PASSED");
