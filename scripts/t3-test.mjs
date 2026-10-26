// T3 feature test: binary manager, queue engine, Eagle import. Needs Eagle running.
// Usage: node scripts/t3-test.mjs   (uses release/Hermes.exe and a fresh release/hermes-data)
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const WORK = join(OUT, "t3");
const EAGLE = "http://localhost:41595/api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(250);
  }
}
const ffmpegRunning = () => execSync('tasklist /FI "IMAGENAME eq ffmpeg.exe" /NH').toString().includes("ffmpeg.exe");
const job = (title, seconds, { eagle = false, realtime = false, out } = {}) => ({
  module: "video", title, pill: "test",
  steps: [
    { type: "run", label: "Encoding", bin: "ffmpeg.exe", parser: "ffmpeg", duration: seconds, outputs: out ? [out] : [],
      args: [...(realtime ? ["-re"] : []), "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=640x360:rate=30`,
        "-c:v", "libx264", "-preset", "ultrafast", "-y", "-progress", "pipe:1", "-nostats", out ?? join(WORK, `${title}.mp4`)] },
    ...(eagle ? [{ type: "eagle" }] : []),
  ],
  eagle: { website: "https://example.com/hermes-test", tags: ["hermes-test", "Test Channel"] },
});

rmSync(DATA, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ autoUpdateYtdlp: false, lastModule: "binaries" }));

// ---------- 1. first run extracts the payload ----------
let app = await launch(EXE);
let { page } = app;
await until(async () => (await page.$$eval("#bin-list .chip", (c) => c.map((x) => x.textContent))).join() === "Working,Working,Working", "3 tools working", 90000);
check(true, "first run: yt-dlp, gallery-dl, FFmpeg extracted and working");
for (const f of ["yt-dlp.exe", "gallery-dl.exe", "ffmpeg.exe", "ffprobe.exe"]) check(existsSync(join(BIN, f)), `${f} in hermes-data/bin`);
const versions = JSON.parse(readFileSync(join(BIN, "versions.json"), "utf8"));
check(Object.keys(versions).length === 3, `versions.json records ${Object.keys(versions).join(", ")}`);
await page.screenshot({ path: join(OUT, "t3-binaries.png") });
await app.close();
await sleep(1000);

// ---------- 2a. packed exe repairs a missing binary and replaces an older one ----------
const old = { version: "2000.01.01", date: "2000-01-01T00:00:00Z" };
unlinkSync(join(BIN, "ffmpeg.exe"));
writeFileSync(join(BIN, "versions.json"), JSON.stringify({ ...versions, "yt-dlp": old }));
app = await launch(EXE);
({ page } = app);
await until(async () => (await page.$$eval("#bin-list .chip", (c) => c.map((x) => x.textContent))).join() === "Working,Working,Working", "tools working after repair", 60000);
check(existsSync(join(BIN, "ffmpeg.exe")), "deleted ffmpeg.exe re-extracted on launch");
check(JSON.parse(readFileSync(join(BIN, "versions.json"), "utf8"))["yt-dlp"].date === versions["yt-dlp"].date, "yt-dlp older than the bundled one is replaced by it");
await app.close();
await sleep(1000);

// ---------- 2b. exe without payload: in-app update from the official release ----------
const RAW = resolve("src-tauri/target/release/Hermes.exe");
const RAW_BIN = resolve("src-tauri/target/release/hermes-data/bin");
rmSync(resolve("src-tauri/target/release/hermes-data"), { recursive: true, force: true });
mkdirSync(RAW_BIN, { recursive: true });
for (const f of ["yt-dlp.exe", "gallery-dl.exe", "ffmpeg.exe", "ffprobe.exe"]) writeFileSync(join(RAW_BIN, f), readFileSync(join(BIN, f)));
writeFileSync(join(RAW_BIN, "versions.json"), JSON.stringify({ ...versions, "yt-dlp": old }));
writeFileSync(resolve("src-tauri/target/release/hermes-data/settings.json"), JSON.stringify({ autoUpdateYtdlp: false, lastModule: "binaries" }));
app = await launch(RAW);
({ page } = app);
await until(() => page.$('[data-update="yt-dlp"]'), "yt-dlp Update button");
check((await page.textContent('[data-bin="yt-dlp"] .bin-name .sub')) === "2000.01.01", "outdated yt-dlp shown as 2000.01.01");
check((await page.textContent('[data-bin="yt-dlp"] .bin-latest')).startsWith("Latest "), "latest version listed");
check(await page.isVisible('[data-banner="binaries-update"]'), "update banner announces yt-dlp");
await page.click('[data-update="yt-dlp"]');
await until(() => page.$('[data-bin="yt-dlp"] .bar'), "update progress bar", 5000);
check(true, "update shows a progress bar");
await until(async () => (await page.textContent('[data-bin="yt-dlp"] .bin-name .sub')) !== "2000.01.01", "yt-dlp updated", 120000);
check(/^\d{4}\.\d\d\.\d\d/.test(await page.textContent('[data-bin="yt-dlp"] .bin-name .sub')), `yt-dlp updated to ${await page.textContent('[data-bin="yt-dlp"] .bin-name .sub')}`);
check((await page.textContent('[data-bin="yt-dlp"] .chip')).includes("Working"), "updated yt-dlp verifies");
check((await page.$('[data-update="yt-dlp"]')) === null, "no Update button once current");
await app.close();
await sleep(1000);

// ---------- 2c. auto-update on launch ----------
writeFileSync(join(RAW_BIN, "versions.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(RAW_BIN, "versions.json"), "utf8")), "yt-dlp": old }));
writeFileSync(resolve("src-tauri/target/release/hermes-data/settings.json"), JSON.stringify({ lastModule: "binaries" }));
app = await launch(RAW);
({ page } = app);
await until(() => page.$('[data-banner="bin-yt-dlp"]'), "auto-update banner", 120000);
check((await page.textContent('[data-banner="bin-yt-dlp"]')).includes("yt-dlp updated to"), "yt-dlp auto-updated on launch");
check(!(await page.$('[data-banner="binaries-update"]')), "no pending-update banner after auto-update");
await app.close();
await sleep(1000);

app = await launch(EXE);
({ page } = app);

// ---------- 3. a job runs, imports to Eagle and deletes the file ----------
await page.click('.nav[data-id="video"]');
const stamp = Date.now();
const eagleOut = join(WORK, `hermes-t3-${stamp}.mp4`);
await invoke(page, "queue_add", { jobs: [job("eagle job", 4, { eagle: true, out: eagleOut })] });
await until(() => page.$(".item.running"), "job running in UI", 10000);
check(true, "job shows as running");
await until(async () => (await jobs(page)).find((j) => j.title === "eagle job")?.state === "done", "eagle job done", 60000);
const done = (await jobs(page)).find((j) => j.title === "eagle job");
check(done.inEagle, "job marked In Eagle");
check(!existsSync(eagleOut), "output file deleted after import");
const found = await until(async () => {
  const d = (await (await fetch(`${EAGLE}/item/list?keyword=hermes-t3-${stamp}&limit=5`)).json()).data;
  return d.length ? d : null;
}, "item searchable in Eagle", 15000);
check(found.length === 1 && found[0].tags.includes("Test Channel") && found[0].url === "https://example.com/hermes-test", "item in Eagle with channel tag and URL");
await fetch(`${EAGLE}/item/moveToTrash`, { method: "POST", body: JSON.stringify({ itemIds: found.map((i) => i.id) }) });
check((await page.textContent(".item.done .st")) === "In Eagle", "UI shows In Eagle");
await page.screenshot({ path: join(OUT, "t3-queue-done.png") });

// ---------- 4. pause / resume / remove kill the process ----------
await invoke(page, "queue_add", { jobs: [job("long job", 30, { realtime: true })] });
await until(async () => (await jobs(page)).find((j) => j.title === "long job")?.state === "running" && ffmpegRunning(), "long job running");
await sleep(1500);
const longId = (await jobs(page)).find((j) => j.title === "long job").id;
await page.click(`[data-job="${longId}"] [data-act="pause"]`);
await until(async () => (await jobs(page)).find((j) => j.id === longId).state === "paused", "paused");
await until(() => !ffmpegRunning(), "ffmpeg killed on pause", 5000);
check(true, "pause button pauses and kills ffmpeg");
await page.click(`[data-job="${longId}"] [data-act="resume"]`);
await until(() => ffmpegRunning(), "ffmpeg restarted on resume", 10000);
check(true, "resume restarts the job");
await page.click(`[data-job="${longId}"] [data-act="remove"]`);
await until(async () => !(await jobs(page)).some((j) => j.id === longId) && !ffmpegRunning(), "removed + killed", 5000);
check(true, "remove deletes the job and kills ffmpeg");

// ---------- 5. groups, spacing, concurrency limit ----------
await invoke(page, "save_settings", { settings: { autoUpdateYtdlp: false, lastModule: "video", maxConcurrent: 2 } });
await invoke(page, "queue_add", { jobs: [{ module: "video", title: "Test playlist", pill: "playlist", children: [1, 2, 3].map((n) => job(`track ${n}`, 6, { realtime: true })) }] });
const groupId = (await jobs(page)).find((j) => j.title === "Test playlist").id;
await page.click(`[data-job="${groupId}"] [data-act="expand"]`);
check((await page.$$(`[data-job="${groupId}"] .kids .item`)).length === 3, "group expands to 3 children");
let maxRunning = 0;
const starts = {};
await until(async () => {
  const kids = (await jobs(page)).filter((j) => j.parent === groupId);
  kids.filter((k) => k.state !== "queued").forEach((k) => (starts[k.id] ??= Date.now()));
  maxRunning = Math.max(maxRunning, kids.filter((k) => k.state === "running").length);
  return kids.every((k) => k.state === "done");
}, "playlist done", 90000);
check(maxRunning === 2, `concurrency limit respected (max ${maxRunning} running with maxConcurrent 2)`);
const t = Object.values(starts).sort();
check(t[1] - t[0] >= 1500, `playlist items spaced (${t[1] - t[0]} ms apart)`);
check((await page.textContent(`[data-job="${groupId}"] > .top .st`)) === "3 / 3", "group shows 3 / 3");

// ---------- 6. failure + retry ----------
await invoke(page, "queue_add", { jobs: [{ module: "video", title: "bad job", steps: [{ type: "run", label: "x", bin: "ffmpeg.exe", parser: "ffmpeg", args: ["-i", "does-not-exist.mp4", "out.mp4"] }] }] });
await until(async () => (await jobs(page)).find((j) => j.title === "bad job")?.state === "failed", "bad job failed");
const bad = (await jobs(page)).find((j) => j.title === "bad job");
check(/does-not-exist/.test(bad.error), `failure keeps the tool's error: "${bad.error}"`);
await page.click(`[data-job="${bad.id}"] [data-act="retry"]`);
await until(async () => (await jobs(page)).find((j) => j.id === bad.id).state === "failed", "retried and failed again");
check(true, "retry re-runs a failed job");
await page.click(`[data-job="${bad.id}"] [data-act="remove"]`);

// ---------- 7. rate limit -> cooldown with countdown ----------
const server = createServer((_, res) => { res.writeHead(429); res.end("slow down"); }).listen(0);
const url = `http://127.0.0.1:${server.address().port}/video`;
await invoke(page, "queue_add", { jobs: [{ module: "video", title: "limited", steps: [{ type: "run", label: "Downloading", bin: "yt-dlp.exe", parser: "ytDlp", args: ["--newline", url] }] }] });
await until(() => page.$("[data-until]"), "cooldown banner", 30000);
const q = await invoke(page, "queue_get");
const minutes = (q.pausedUntil - Date.now()) / 60000;
check(minutes > 4.5 && minutes <= 5, `first rate limit pauses ~5 min (${minutes.toFixed(2)})`);
check(q.jobs.find((j) => j.title === "limited").state === "queued", "rate-limited job goes back to queued");
check(/Resuming at \d\d:\d\d · \d:\d\d/.test(await page.textContent("[data-until]")), `countdown shown: "${await page.textContent("[data-until]")}"`);
await page.screenshot({ path: join(OUT, "t3-cooldown.png") });
await page.click('[data-act="resumeNow"]');
await until(async () => (await invoke(page, "queue_get")).backoffMin === 10, "second backoff 10 min", 30000);
check(true, "Resume now retries; second rate limit doubles backoff to 10 min");
server.close();
await page.click(`[data-job="${(await jobs(page)).find((j) => j.title === "limited").id}"] [data-act="remove"]`);

// ---------- 8. persistence across restart (cooldown + paused + interrupted) ----------
await invoke(page, "queue_add", { jobs: [job("survivor", 20, { realtime: true })] });
const pausedUntil = (await invoke(page, "queue_get")).pausedUntil;
await invoke(page, "queue_resume_now");
await until(async () => (await jobs(page)).find((j) => j.title === "survivor")?.state === "running", "survivor running");
await page.click("#wc-close").catch(() => {});
await new Promise((r) => app.proc.once("exit", r));
await sleep(1000);
check(!ffmpegRunning(), "closing the app kills running tools");
check(pausedUntil > 0, "cooldown timestamp was stored as absolute time");
app = await launch(EXE);
({ page } = app);
await until(async () => (await jobs(page)).find((j) => j.title === "survivor")?.state === "running", "survivor resumed after restart", 15000);
check(true, "interrupted job is resumed after restart");
check((await jobs(page)).some((j) => j.title === "Test playlist"), "finished items persisted");

// ---------- 9. clear finished, pause all ----------
await invoke(page, "queue_pause_all", { paused: true });
await until(async () => (await jobs(page)).find((j) => j.title === "survivor").state === "paused" && !ffmpegRunning(), "pause all");
check(true, "pause all pauses running jobs");
await page.click('[data-act="clear"]');
await until(async () => (await jobs(page)).every((j) => j.state !== "done" && !j.group), "clear finished");
check((await jobs(page)).length === 1, "clear finished keeps only unfinished jobs");
await invoke(page, "queue_pause_all", { paused: false });
await invoke(page, "queue_action", { id: (await jobs(page))[0].id, action: "remove" });

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T3 TEST PASSED");
