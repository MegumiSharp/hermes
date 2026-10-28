// T19 test: local usage statistics. Summary + scrubbing (pure, under node), then the real app:
// launch/open/job/wait events, nothing personal recorded, Settings card, off switch, export file, clear.
// Usage: node scripts/t19-test.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scrub, summarize } from "../src/usage-summary.ts";
import { check, launch, OUT } from "./smoke.mjs";

// ---- pure ----
check(scrub(String.raw`C:\Users\Megumi\Videos\My Song.mp4: Invalid data`) === "<path>: Invalid data", "paths with spaces scrubbed");
check(!scrub(String.raw`could not open 'C:\Temp\a b\x.wav' now`).includes("a b"), "quoted paths scrubbed");
check(!scrub(String.raw`Error opening input file C:\Users\Megumi\x y.mp4`).includes("Megumi"), "trailing paths scrubbed");
check(!scrub("ERROR: https://www.youtube.com/watch?v=abc unavailable").includes("youtube"), "URLs scrubbed");
check(!scrub('Downloaded "Rick Astley - Never Gonna Give You Up"').includes("Rick"), "quoted titles scrubbed");
const s = summarize([
  { type: "launch", t: 1, startupMs: 900 }, { type: "launch", t: 2, startupMs: 1100 },
  { type: "open", t: 3, tool: "video" }, { type: "open", t: 4, tool: "video" }, { type: "open", t: 5, tool: "rembg" },
  { type: "job", t: 6, module: "video", state: "done", ms: 4000, group: false }, { type: "job", t: 7, module: "video", state: "failed", ms: 100, group: false, error: "HTTP 429" },
  { type: "job", t: 8, module: "video", state: "done", ms: 9000, group: true },
  { type: "wait", t: 9, kind: "video-read", ms: 3000, ok: true }, { type: "wait", t: 10, kind: "video-read", ms: 5000, ok: false },
]);
check(s.launches === 2 && s.toolsOpened.video === 2, "summary counts launches and tool opens");
check(s.jobs.video.done === 1 && s.jobs.video.failed === 1, "playlist containers are not counted twice");
check(s.jobs.video.topErrors[0].text === "HTTP 429", "top errors listed");
check(s.waits["video-read"].count === 2 && s.waits["video-read"].failed === 1, "waits summarized");

// ---- app ----
const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t19");
const LOG = join(DATA, "usage.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const events = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(LOG, { force: true });
rmSync(join(DATA, "queue.json"), { force: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "video", autoUpdateYtdlp: false, cookies: { youtube: "none" } }));

let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#v-url");
await until(() => events().some((e) => e.type === "launch" && e.startupMs > 0), "launch event with startup time", 10000);
check(true, `launch recorded (startup ${events().find((e) => e.type === "launch").startupMs} ms)`);
await page.click('.nav[data-id="converter"]');
await until(() => events().some((e) => e.type === "open" && e.tool === "converter"), "tool open recorded", 5000);
check(true, "tool opens recorded");

// a job that works and one that fails with a path in its error
await invoke(page, "queue_add", { jobs: [{ module: "converter", title: "Secret Title", steps: [{ type: "run", label: "Working", bin: "ffmpeg.exe", parser: "ffmpeg", args: ["-f", "lavfi", "-i", "testsrc=duration=2", "-f", "null", "-"] }] }] });
await invoke(page, "queue_add", { jobs: [{ module: "upscale", title: "Private Name", steps: [{ type: "run", label: "Working", bin: "ffmpeg.exe", parser: "ffmpeg", args: ["-i", join(W, "missing file.mp4"), join(W, "out.mp4")] }] }] });
await until(() => events().filter((e) => e.type === "job").length >= 2, "job events", 60000);
const jobs = events().filter((e) => e.type === "job");
check(jobs.some((j) => j.module === "converter" && j.state === "done" && j.steps[0] === "ffmpeg" && j.ms > 0), "finished job recorded with tool and duration");
check(jobs.some((j) => j.module === "upscale" && j.state === "failed"), "failed job recorded");

// a wait
await page.click('.nav[data-id="gallery"]');
await page.fill("#g-url", "https://example.com/");
await page.click("#g-fetch");
await until(() => events().some((e) => e.type === "wait" && e.kind === "gallery-read"), "wait recorded", 60000);
check(true, "waits recorded with their kind");

// privacy: nothing personal anywhere
const raw = readFileSync(LOG, "utf8");
for (const bad of ["Secret Title", "Private Name", "missing file", "example.com", W.split("\\").slice(-2).join("\\"), "Megumi"]) check(!raw.includes(bad), `no "${bad}" in the statistics`);

// Settings card + export + off switch + clear
await page.click('.nav[data-id="settings"]');
await until(async () => /\d+ events since/.test(await page.textContent("#usage-count")), "Settings shows the count", 5000);
check(true, `Settings: ${await page.textContent("#usage-count")}`);
await page.screenshot({ path: join(OUT, "t19-settings.png"), fullPage: true });
const exportPath = join(W, "export.json");
await invoke(page, "usage_export", { path: exportPath, text: JSON.stringify({ events: await invoke(page, "usage_read") }) });
check(JSON.parse(readFileSync(exportPath, "utf8")).events.length === events().length, "export writes every event");
await page.click("#usage-on + .switch, label:has(#usage-on)");
await until(() => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).usageStats === false, "switch saved off", 5000);
const n = events().length;
await page.click('.nav[data-id="video"]');
await sleep(800);
check(events().length === n, "nothing recorded while switched off");
await page.click('.nav[data-id="settings"]');
await page.click("#usage-clear");
await until(async () => (await page.textContent("#usage-count")) === "Nothing yet", "cleared", 5000);
check(!existsSync(LOG), "Clear deletes the statistics file");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T19 TEST PASSED");
