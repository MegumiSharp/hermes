// T5-T7 feature test: Gallery Downloader, Background Removal, Upscale. Needs network + Eagle.
// Usage: node scripts/t5-7-test.mjs  (release/Hermes.exe; downloads two small rembg models once)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";
import { serveGallery } from "./gallery-fixture.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t5-7");
const EAGLE = "http://localhost:41595/api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const probe = (f) => JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]).toString());
const ffmpeg = (...a) => execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-y", ...a]);
const seen = new Set();
/** Waits for the next new job of `module` (adding is async) and for it to finish. */
async function lastJobDone(page, module, ms = 900000) { // long: a site's 429 cooldown pauses the queue
  const id = await until(async () => (await jobs(page)).find((j) => j.module === module && !j.parent && !seen.has(j.id))?.id, `${module} job queued`, 30000);
  seen.add(id);
  const j = await until(async () => {
    const x = (await jobs(page)).find((y) => y.id === id);
    return ["done", "failed"].includes(x.state) ? x : null;
  }, `${module} job`, ms);
  check(j.state === "done", `${module} job "${j.title}" done${j.error ? ": " + j.error : ""}`);
  return j;
}
/** Simulates dropping a real file onto a drop zone (HTML5 drop with bytes, like Explorer). */
async function drop(page, selector, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([sel, name, data]) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name));
    document.querySelector(sel).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [selector, basename(file), b64]);
}

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
for (const f of ["queue.json", "settings.json", "gallery-archive.sqlite3"]) rmSync(join(DATA, f), { force: true });
const G = join(W, "gallery"), R = join(W, "rembg"), U = join(W, "upscale");
writeFileSync(join(DATA, "settings.json"), JSON.stringify({
  lastModule: "gallery", autoUpdateYtdlp: false,
  gallery: { folder: G, eagle: false, previews: true, filters: { limit: 12 } }, rembg: { folder: R, eagle: false }, upscale: { folder: U, eagle: false },
}));
const app = await launch(EXE);
const { page } = app;
await until(async () => (await invoke(page, "binaries_init")).every((s) => s.ok || s.optional), "all binaries working", 120000);
check(true, "all bundled tools (incl. Real-ESRGAN, DirectML) verify");

// ONLY=rembg,upscale skips sections (e.g. when a site is rate limiting this IP)
const only = (s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
let j; // last finished job
const photo = resolve("test-output/fixtures/photo.jpg"); // a real photo: the gallery fixture images are flat colours

// ================= T5 Gallery =================
if (only("gallery")) {
const gallery = await serveGallery(join(W, "gallery-src"), resolve("release/hermes-data/bin/ffmpeg.exe")); // local page, no rate limits
const GALLERY = gallery.url;
await page.waitForSelector("#g-url");
await page.fill("#g-url", GALLERY);
await page.click("#g-fetch");
// leaving the tool while it reads and coming back still shows the list
await page.click('.nav[data-id="rembg"]');
await page.click('.nav[data-id="gallery"]');
await until(async () => (await page.$$("#g-grid .tile")).length >= 3, "gallery tiles", 90000);
const total = (await page.$$("#g-grid .tile")).length;
check(total === 5, `list read while away is shown on return (${total} files)`);
check(/of \d+ selected/.test(await page.textContent("#g-summary")), `summary: ${await page.textContent("#g-summary")}`);
await page.screenshot({ path: join(OUT, "t5-grid.png") });
const exts = await page.$$eval(".f-ext", (b) => b.map((x) => x.dataset.ext));
check(exts.length >= 1, `extension filters: ${exts.join(", ")}`);
if (exts.length > 1) {
  await page.click(`.f-ext[data-ext="${exts.at(-1)}"]`);
  const after = (await page.$$("#g-grid .tile")).length;
  check(after < total, `turning off .${exts.at(-1)} hides files (${total} -> ${after})`);
  await page.click(`.f-ext[data-ext="${exts.at(-1)}"]`);
}
await page.click("#g-none");
check((await page.textContent("#g-summary")).startsWith("0 of"), "select none");
check(await page.$eval("#g-add", (b) => b.disabled), "Add disabled with nothing selected");
await page.click("#g-all");
const tiles = await page.$$("#g-grid .tile");
await tiles[0].click();
check((await page.$$("#g-grid .tile.off")).length === 1, "clicking a tile deselects it");
const want = total - 1;
await page.click("#g-add");
j = await lastJobDone(page, "gallery");
const got = walk(G).filter((f) => /\.(jpe?g|png|gif|webp|svg|tiff?)$/i.test(f));
check(got.length === want, `downloaded exactly the ${want} selected files (${got.length})`);
check(j.outputs.length === want, "job lists every downloaded file");
const mtimes = got.map((f) => statSync(f).mtimeMs).join();
await page.click("#g-add");
j = await lastJobDone(page, "gallery");
check(got.map((f) => statSync(f).mtimeMs).join() === mtimes, "second run skips already downloaded files (archive, nothing rewritten)");

// one file to Eagle
await page.click("#g-none");
await (await page.$$("#g-grid .tile"))[1].click();
await page.click("#g-eagle + .box");
await page.check('[data-bool="skipDownloaded"]').catch(() => {});
await page.uncheck('[data-bool="skipDownloaded"]');
await page.click("#g-add");
j = await lastJobDone(page, "gallery");
check(j.inEagle && j.outputs.length === 1 && !existsSync(j.outputs[0]), "selected file imported into Eagle and removed from folder");
const name = basename(j.outputs[0]).replace(/\.[^.]+$/, "");
const items = await until(async () => {
  const d = (await (await fetch(`${EAGLE}/item/list?keyword=${encodeURIComponent(name)}&limit=5`)).json()).data;
  return d.length ? d : null;
}, "gallery item in Eagle", 20000);
check(items[0].url === GALLERY, "Eagle item keeps the gallery URL");
await fetch(`${EAGLE}/item/moveToTrash`, { method: "POST", body: JSON.stringify({ itemIds: items.map((i) => i.id) }) });
await page.click("#g-eagle + .box");
gallery.close();
}

// ================= T6 Background Removal =================
if (only("rembg")) {
await page.click('.nav[data-id="rembg"]');
await page.waitForSelector("#r-go");
let models = await invoke(page, "rembg_models");
if (!models.some((m) => m.installed)) check(await page.isVisible("#r-none"), "no-model notice shown");
await page.click("#r-models");
await page.waitForSelector(".m-row"); // the modal opens after an async model listing
for (const id of ["isnet-general-use", "u2net"]) {
  if (!models.find((m) => m.id === id).installed) await page.check(`.m-row input[data-id="${id}"]`);
}
if (!models.filter((m) => ["isnet-general-use", "u2net"].includes(m.id)).every((m) => m.installed)) {
  check((await page.textContent(".m-total")).includes("to download"), `size shown before download: ${await page.textContent(".m-total")}`);
  await page.click(".m-foot .btn.primary");
  await page.waitForSelector(".modal h3:text('Download models?')");
  check(true, "confirmation asked before downloading");
  await page.click(".modal:has(h3:text('Download models?')) .m-foot .btn.primary");
  await until(async () => (await invoke(page, "rembg_models")).filter((m) => m.installed).length >= 2, "models downloaded", 900000);
  check(true, "models downloaded after confirmation");
}
while (await page.$(".overlay")) { await page.keyboard.press("Escape"); await sleep(200); } // models modal if still open
await sleep(500);
check(await page.isHidden("#r-none"), "notice gone once a model is installed");
await page.selectOption("#r-model", "isnet-general-use");
await drop(page, "#r-drop", photo);
await until(() => page.$("#r-batch .tcard.ready"), "dropped file listed");
await page.click("#r-go");
j = await lastJobDone(page, "rembg");
const cut = j.outputs.at(-1);
check(existsSync(cut) && probe(cut).streams[0].pix_fmt === "rgba", `transparent PNG written: ${basename(cut)}`);
await until(() => page.$(".results .ba"), "before/after slider", 10000);
await page.$eval(".results .ba", (e) => e.scrollIntoView({ block: "center" }));
const box = await page.$(".results .ba").then((e) => e.boundingBox());
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
check((await page.$eval(".results .ba", (e) => Number(e.getAttribute("aria-valuenow")))) < 30, "slider follows the pointer");
await page.screenshot({ path: join(OUT, "t6-slider.png") });

await page.selectOption("#r-bgmode", "color");
await page.check("#r-crop").catch(() => page.click("#r-crop + .box"));
await drop(page, "#r-drop", photo);
await until(() => page.$("#r-batch .tcard.ready"), "file listed again");
await page.click("#r-go");
j = await lastJobDone(page, "rembg");
const p1 = probe(cut).streams[0], p2 = probe(j.outputs.at(-1)).streams[0];
check(p2.width * p2.height < p1.width * p1.height, `crop to subject shrinks the image (${p1.width}x${p1.height} -> ${p2.width}x${p2.height})`);
await page.selectOption("#r-bgmode", "");
await page.uncheck("#r-crop").catch(() => page.click("#r-crop + .box"));

await page.click('.tab[data-mode="compare"]');
await drop(page, "#r-drop-compare", photo);
await page.check('#r-pick input[data-id="isnet-general-use"]');
await page.check('#r-pick input[data-id="u2net"]');
await page.click("#r-go");
await until(async () => (await page.$$("#r-grid .r-cell img")).length === 2, "compare results", 180000);
const times = await page.$$eval("#r-grid .r-cell .mono", (e) => e.map((x) => x.textContent));
check(times.every((t) => /\d+\.\d s/.test(t)), `compare shows timings: ${times.join(", ")}`);
await page.screenshot({ path: join(OUT, "t6-compare.png") });
await page.click("#r-grid .r-cell");
await page.waitForSelector(".modal .ba");
await page.click(".modal .m-foot .btn.primary");
await until(() => walk(R).some((f) => /-(isnet-general-use|u2net)\.png$/.test(f)), "kept compare result in folder", 10000);
check(true, "Keep saves the chosen model's result");
check(await page.isVisible(".modal .ba"), "viewer stays open after Keep (to keep more than one)");
await page.click(".modal .m-foot .btn.ghost");
}

// ================= T7 Upscale =================
if (only("upscale")) {
mkdirSync(U, { recursive: true });
const small = join(W, "small.png");
const clip = join(W, "clip.mp4");
ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:duration=1", "-frames:v", "1", small);
ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", clip);
await page.click('.nav[data-id="upscale"]');
await page.waitForSelector("#u-go");
await until(async () => (await page.textContent("#u-tool")).includes("0.2.5"), "Real-ESRGAN chip");
await page.selectOption("#u-model", "realesrgan-x4plus");
check(await page.$eval("#u-scale", (s) => s.disabled && s.value === "4"), "x4plus is fixed at 4x");
await drop(page, "#u-drop", small);
await until(() => page.$(".u-files .tcard"), "image listed");
await page.click("#u-go");
j = await lastJobDone(page, "upscale");
const up = probe(j.outputs.at(-1)).streams[0];
check(up.width === 256 && up.height === 256, `image upscaled 64 -> ${up.width}x${up.height}`);
await until(() => page.$(".results .ba"), "upscale slider", 10000);

await page.screenshot({ path: join(OUT, "t7-upscale.png") });
}

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T5-T7 TEST PASSED");
