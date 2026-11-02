// T27 test: Gallery re-run shows "already downloaded", e-hentai limits become a timed pause with the reason,
// gallery jobs ask gallery-dl to stop (not downgrade) without GP; every drop zone shows at once that it is
// reading; Thumbnail Tester skeletons, 60-video feed, Discover (100 videos, yours at a random place); BG Removal.
// Needs network (YouTube search). Usage: node scripts/t27-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { serveGallery } from "./gallery-fixture.mjs";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t27");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(200);
  }
}
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
const last = async (page, module) => (await jobs(page)).filter((j) => j.module === module).at(-1);
const finished = (page, module) => until(async () => { const j = await last(page, module); return j && ["done", "failed"].includes(j.state) ? j : null; }, `${module} job finished`, 120000);
async function drop(page, sel, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([sel, name, data]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    document.querySelector(sel).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [sel, basename(file), b64]);
}

rmSync(W, { recursive: true, force: true });
mkdirSync(join(W, "out"), { recursive: true });
const gallery = await serveGallery(join(W, "src"), join(BIN, "ffmpeg.exe"));
for (const f of ["queue.json", "gallery-archive.sqlite3"]) rmSync(join(DATA, f), { force: true });
const s0 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "gallery", autoUpdateYtdlp: false, anya: { on: false },
  cookies: { ...s0.cookies, "127.0.0.1": "none" }, gallery: { folder: join(W, "out"), eagle: false, filters: { limit: 100 } } }));
let app = await launch(EXE);
let { page } = app;

// ---- BG Removal ----
check((await page.textContent('.nav[data-id="rembg"]')).trim() === "BG Removal", "Background Removal is now BG Removal");

// ---- Gallery: second run says what it skipped ----
await page.waitForSelector("#g-url");
await page.fill("#g-url", gallery.url);
await page.click("#g-add");
let j = await finished(page, "gallery");
check(j.state === "done" && !j.note, `first run downloads (${j.outputs.length} files)`);
const config = j.steps[0].args[j.steps[0].args.indexOf("--config") + 1];
check(JSON.parse(readFileSync(config, "utf8")).extractor.exhentai?.gp === "stop", "gallery jobs tell gallery-dl to stop, not to switch to resized images, when GP run out");
await page.fill("#g-url", gallery.url);
await page.click("#g-add");
await until(async () => (await jobs(page)).filter((x) => x.module === "gallery").length === 2, "second job");
j = await finished(page, "gallery");
check(j.note === "5 already downloaded", `second run: "${j.note}"`);
await until(async () => /already downloaded/.test(await page.textContent(`[data-job="${j.id}"]`)), "the queue item says it", 5000);
check(true, `queue item: "${(await page.textContent(`[data-job="${j.id}"] .st`).catch(() => "")).trim()}"`);

// ---- e-hentai limits: a timed pause with the reason, then it resumes by itself ----
const FAKE = join(BIN, "fake-gdl.cmd");
writeFileSync(FAKE, ["@echo off", "echo [exhentai][error] Image limit exceeded! 1>&2", "exit /b 1", ""].join("\r\n"));
await invoke(page, "queue_add", { jobs: [{ module: "gallery", title: "limited", steps: [{ type: "run", label: "Downloading", bin: "fake-gdl.cmd", parser: "galleryDl", duration: -10, args: [] }] }] });
const q = await until(async () => { const q = await invoke(page, "queue_get"); return q.pausedUntil > Date.now() ? q : null; }, "queue paused by the limit", 20000);
check(/E-Hentai image limit/.test(q.pauseReason), `pause reason: "${q.pauseReason}"`);
check(q.jobs.find((x) => x.title === "limited").state === "queued", "the job waits in the queue (not failed)");
await until(async () => /E-Hentai image limit reached.*resumes by itself/.test(await page.textContent(".cool")), "banner with the reason", 5000);
check(true, `banner: "${(await page.textContent(".cool")).trim().slice(0, 110)}"`);
await page.screenshot({ path: join(OUT, "t27-limit.png") });
for (const x of (await jobs(page)).filter((x) => x.title === "limited")) await invoke(page, "queue_action", { id: x.id, action: "remove" });
await invoke(page, "queue_resume_now");
rmSync(FAKE, { force: true });

// ---- drop zones: feedback at once ----
await page.click('.nav[data-id="docconv"]');
await page.waitForSelector("#dc-drop");
const big = join(W, "big.txt");
writeFileSync(big, "x".repeat(12 * 1024 * 1024)); // 12 MB: takes a moment to copy (bigger strings choke the test bridge)
// measured inside the page: the state must be there the moment the drop event has been handled
const b64 = readFileSync(big).toString("base64");
const atOnce = await page.evaluate(([name, data]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
  const z = document.querySelector("#dc-drop");
  z.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return z.classList.contains("busy") && z.textContent.includes("Reading big.txt");
}, [basename(big), b64]);
check(atOnce, 'the drop zone says "Reading big.txt…" the moment the file is dropped');
await until(() => page.$eval("#dc-drop", (d) => !d.classList.contains("busy")), "busy state ends", 30000);
check(true, "the busy state ends once the file is in");

// ---- Thumbnail Tester ----
await page.click('.nav[data-id="thumbs"]');
await page.waitForSelector("#t-drop");
const thumb = join(W, "mine.png");
execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=1280x720", "-frames:v", "1", thumb]);
await drop(page, "#t-drop", thumb);
await until(async () => (await page.$$(".th-item")).length >= 1, "my thumbnail listed");
await page.fill("#t-topic", "minecraft builds");
await page.click("#t-search");
await until(() => page.$("#t-stage .th-skeleton"), "skeleton feed while searching", 3000);
check(true, "skeleton cards while the search runs");
await until(async () => (await page.$$("#t-stage .yt-card")).length > 20 && !(await page.$("#t-stage .th-skeleton")), "feed", 90000);
const n = (await page.$$("#t-stage .yt-card")).length;
check(n > 30, `home feed shows many more videos (${n}, was 16)`);
await page.click("#t-discover");
await page.waitForSelector(".th-discover");
const pos = await until(async () => { const t = await page.textContent("#t-disc-pos"); return /#\d+/.test(t) ? t : null; }, "Discover feed", 120000);
const cards = (await page.$$(".th-disc-feed .yt-card")).length;
const at = Number(pos.match(/#(\d+)/)[1]);
check(cards >= 90 && at >= 1 && at <= cards, `Discover: ${cards} videos, ${pos}`);
check(await page.$eval(".th-disc-feed", (f) => f.children[Number(f.closest(".th-discover").querySelector("#t-disc-pos").textContent.match(/#(\d+)/)[1]) - 1].classList.contains("mine")), "your thumbnail is really at that position");
await page.screenshot({ path: join(OUT, "t27-discover.png") });
let moved = false;
for (let i = 0; i < 5 && !moved; i++) { await page.click("#t-disc-shuffle"); moved = (await page.textContent("#t-disc-pos")) !== pos; }
check(moved, "Shuffle puts it somewhere else");
await page.keyboard.press("Escape");
check(!(await page.$(".th-discover")), "Esc closes Discover");

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
gallery.close();
console.log("T27 TEST PASSED");
