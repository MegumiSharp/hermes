// T12 test: owner feedback round (info buttons, sidebar activity, non-blocking work, tray with
// statuses + paste + copyable errors, compare that survives switching tools, viewer navigation,
// zoom, system stats + setting, steady Eagle chip, gallery list view + title filter).
// Usage: node scripts/t12-test.mjs  (needs Eagle open and the isnet/u2net rembg models from t5-7-test)
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t12");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
async function drop(page, selector, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([sel, name, data]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    document.querySelector(sel).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [selector, basename(file), b64]);
}

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
const photo = resolve("test-output/fixtures/photo.jpg");
writeFileSync(join(DATA, "settings.json"), JSON.stringify({
  lastModule: "video", autoUpdateYtdlp: false, rembg: { folder: W, eagle: false, model: "isnet-general-use", compare: ["isnet-general-use", "u2net"] },
}));
const app = await launch(EXE);
const { page } = app;

// 1. Info on every tool
for (const id of ["video", "gallery", "rembg", "upscale", "demucs", "whisper", "audible"]) {
  await page.click(`.nav[data-id="${id}"]`);
  await page.waitForSelector(".info-btn", { timeout: 10000 });
  await page.click(".info-btn");
  const text = await page.textContent(".modal");
  check(text.includes("Powered by") && (!["video", "gallery"].includes(id) || text.includes("Downloads from")), `${id}: Info explains the tool${["video", "gallery"].includes(id) ? " and its sites" : ""}`);
  await page.keyboard.press("Escape");
}

// 2. Stats + steady Eagle chip
await page.click('.nav[data-id="rembg"]');
await until(async () => (await page.$$(".stats .stat")).length >= 2, "system stats");
check((await page.textContent(".stats")).includes("CPU"), `stats shown: ${(await page.textContent(".stats")).replace(/\s+/g, " ")}`);
let closedSeen = false;
for (let i = 0; i < 12; i++) { // ~30 s
  if ((await page.textContent("#r-eagle-state")).includes("closed")) closedSeen = true;
  await sleep(2500);
}
check(!closedSeen, "Eagle chip stays 'connected' (no flicker)");

// 3. Paste an image with Ctrl+V
const b64 = readFileSync(photo).toString("base64");
await page.evaluate((data) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, b64);
await until(async () => (await page.$$("#r-batch .tcard")).length === 1, "pasted image in the tray");
check((await page.textContent("#r-batch .tcard .tname")).startsWith("pasted-"), "Ctrl+V adds the clipboard image");
check(!!(await page.$("#r-batch .tcard img")), "tray shows a thumbnail");

// 4. Failure keeps the image, error is copyable, removing a failed job keeps it ready
const bad = join(W, "broken.png");
writeFileSync(bad, "not an image");
await page.click("#r-batch [data-clear-all]");
await drop(page, "#r-drop", bad);
await until(() => page.$("#r-batch .tcard.ready"), "broken file listed");
await page.click("#r-go");
await until(() => page.$("#r-batch .tcard.failed"), "failed card", 60000);
check(true, "failed image stays in the batch with a failed badge");
await page.click("#r-batch .tcard.failed [data-err]");
await page.waitForSelector(".modal .err-box pre");
check((await page.textContent(".modal .err-box pre")).length > 5, `error shown in full: ${(await page.textContent(".modal .err-box pre")).slice(0, 80)}`);
check(!!(await page.$(".modal .m-foot .btn.primary:text('Copy error')")), "Copy error button");
await page.keyboard.press("Escape");
const failedId = (await invoke(page, "queue_get")).jobs.find((j) => j.state === "failed").id;
await invoke(page, "queue_action", { id: failedId, action: "remove" });
await until(() => page.$("#r-batch .tcard.ready"), "card back to ready after removing the job", 10000);
check(true, "removing the failed job from the queue keeps the image in the batch");
await page.click("#r-batch [data-clear-all]");

// 5. Compare survives switching tools; activity shows it; viewer navigation + zoom
await page.click('.tab[data-mode="compare"]');
await drop(page, "#r-drop-compare", photo);
await until(() => page.$("#r-compare .tcard"), "compare image");
await page.click("#r-go");
await until(() => page.$(".activity .act"), "compare listed in the sidebar activity", 10000);
check(true, "running compare appears in the sidebar");
await page.click('.nav[data-id="video"]');
await sleep(500);
check((await page.$$(".nav")).length > 0 && !(await page.$(".overlay")), "other tools usable while comparing");
await page.click('.nav[data-id="rembg"]');
await until(async () => (await page.$$("#r-grid .r-cell img")).length === 2, "compare results after coming back", 120000);
check(true, "compare results kept after switching tools");
check((await page.textContent("#r-grid")).match(/GPU|CPU/), `device shown: ${(await page.textContent("#r-grid")).replace(/\s+/g, " ").slice(0, 80)}`);
await page.click("#r-grid .r-cell");
await page.waitForSelector(".modal .viewer .v-tab.on");
const first = await page.textContent(".v-tab.on b");
await page.keyboard.press("ArrowRight");
check((await page.textContent(".v-tab.on b")) !== first, "→ switches to the next model in the viewer");
const ba = await page.$(".modal .ba");
const box = await ba.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -300);
await sleep(200);
check(parseInt(await page.textContent(".modal .ba-zoom span")) > 100, `wheel zooms in (${await page.textContent(".modal .ba-zoom span")})`);
await page.click('.modal .ba-zoom [data-z="0"]');
check((await page.textContent(".modal .ba-zoom span")) === "100%", "Fit resets the zoom");
await page.screenshot({ path: join(OUT, "t12-viewer.png") });
await page.keyboard.press("Escape");

// 6. Stats can be turned off
await page.click('.nav[data-id="settings"]');
await page.uncheck("#show-stats");
await page.click('.nav[data-id="rembg"]');
await sleep(2500);
check((await page.$$(".stats .stat")).length === 0, "stats hidden when turned off in Settings");
await page.click('.nav[data-id="settings"]');
await page.check("#show-stats");

// 7. Gallery: list view by default + title filter
await page.click('.nav[data-id="gallery"]');
await page.fill("#g-url", "https://en.wikipedia.org/wiki/Hermes");
await page.click("#g-fetch");
await until(async () => (await page.$$("#g-grid .g-row")).length >= 3, "gallery list rows", 90000);
check(await page.$eval("#g-grid", (g) => g.classList.contains("as-list")), "list view is the default (no remote thumbnails)");
const all = (await page.$$("#g-grid .g-row")).length;
const name = (await page.textContent("#g-grid .g-row b")).split(/[\s_.()-]+/).find((w) => w.length > 4);
await page.fill('[data-text="titleNot"]', name);
await sleep(300);
const fewer = (await page.$$("#g-grid .g-row")).length;
check(fewer < all, `"Title excludes ${name}" hides matching files (${all} -> ${fewer})`);
await page.fill('[data-text="titleNot"]', "");
await page.check("#g-previews");
check(!!(await page.$("#g-grid .tile img")), "Show previews switches to thumbnails");
await page.uncheck("#g-previews");

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T12 TEST PASSED");
