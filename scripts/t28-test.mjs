// T28 test: "Pause all" is visible (banner + Resume all, the job says why it waits); Eagle is optional: asked on
// the first launch, "No" hides Send to Eagle everywhere and drops Eagle steps, the Settings switch brings it back.
// Usage: node scripts/t28-test.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saved = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(200);
  }
}

// first launch: not answered yet (null; the harness answers "yes" only when the key is missing) → the question
const s0 = saved();
delete s0.eagleEnabled;
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "video", anya: { on: false }, eagleEnabled: null }));
let app = await launch(EXE);
let { page } = app;
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
await page.waitForSelector(".modal");
check(/Do you use Eagle\?/.test(await page.textContent(".modal")), "first launch asks whether you use Eagle");
await page.click('.modal button:has-text("No, just folders")');
await until(() => saved().eagleEnabled === false, "answer saved");
check(true, "No is remembered");
await page.waitForSelector("#v-url");
check(!(await page.$("#v-eagle")) && !(await page.$("#v-eagle-state")), "Video Downloader: no Send to Eagle, no Eagle chip");
for (const tool of ["gallery", "rembg", "pixel"]) {
  await page.click(`.nav[data-id="${tool}"]`);
  await sleep(400);
  check(!(await page.$('[id$="-eagle"]')), `${tool}: no Send to Eagle`);
}

// "Pause all": banner + why the job waits
await page.click('.nav[data-id="downloads"]');
await invoke("queue_pause_all", { paused: true });
await invoke("queue_add", { jobs: [{ module: "converter", title: "waits", steps: [{ type: "run", label: "x", bin: "ffmpeg.exe", parser: "ffmpeg", args: ["-version"] }] }] });
await page.click('.nav[data-id="converter"]');
await until(async () => /The queue is paused/.test(await page.textContent(".cool").catch(() => "")), "paused banner");
check(true, "a paused queue says so, with Resume all");
const j = (await invoke("queue_get")).jobs.find((x) => x.title === "waits");
check(/queue paused/.test(await page.textContent(`[data-job="${j.id}"] .st`)), `the job says why it waits: "${await page.textContent(`[data-job="${j.id}"] .st`)}"`);
await page.click('.cool [data-act="pauseAll"]');
await until(async () => (await invoke("queue_get")).jobs.find((x) => x.id === j.id)?.state === "done", "job runs after Resume all");
check(!(await invoke("queue_get")).pausedAll, "Resume all in the banner restarts the queue");
await invoke("queue_action", { id: j.id, action: "remove" });

// Settings switch brings Eagle back, and no question on the next launch
await page.click('.nav[data-id="settings"]');
await page.check("#eagle-enabled");
await until(() => saved().eagleEnabled === true, "switch saved");
await page.click('.nav[data-id="video"]');
await page.waitForSelector("#v-eagle");
check(true, "Settings → Eagle on: Send to Eagle is back");
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector("#v-url");
await sleep(800);
check(!(await page.$(".modal")), "asked only once");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T28 TEST PASSED");
