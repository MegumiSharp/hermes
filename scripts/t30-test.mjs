// T30 test: Video Converter takes a whole folder (Folder button, subfolders too, other files ignored) and
// "Original audio" copies each video's audio track as it is (AAC → .m4a, Opus → .opus); a video without audio
// fails with a clear reason. Usage: node scripts/t30-test.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const FFMPEG = join(DATA, "bin", "ffmpeg.exe");
const W = join(OUT, "t30");
const SRC = join(W, "videos");
const DEST = join(W, "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
const ff = (...a) => execFileSync(FFMPEG, ["-v", "error", "-y", ...a]);
const codec = (f) => execFileSync(join(DATA, "bin", "ffprobe.exe"), ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", f]).toString().trim();

rmSync(W, { recursive: true, force: true });
mkdirSync(join(SRC, "sub"), { recursive: true });
mkdirSync(DEST, { recursive: true });
const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
const pic = ["-f", "lavfi", "-i", "color=c=blue:s=320x240:d=3"];
ff(...pic, ...tone, "-c:v", "libx264", "-c:a", "aac", "-shortest", join(SRC, "aac.mp4"));
ff(...pic, ...tone, "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", join(SRC, "sub", "opus.webm"));
ff(...pic, "-c:v", "libx264", join(SRC, "silent.mp4"));
writeFileSync(join(SRC, "notes.txt"), "not a video");

const s0 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "converter", anya: { on: false },
  converter: { folder: DEST, preset: "audio", height: 0, fps: 0, quality: "high", tray: [] } }));
rmSync(join(DATA, "queue.json"), { force: true });
const app = await launch(EXE);
const { page } = app;
await page.waitForSelector("#c-drop");
check((await page.inputValue("#c-preset")) === "audio", "Original audio is a Convert to choice (remembered)");
check(/as it is/.test(await page.textContent("#c-hint")), `hint: "${await page.textContent("#c-hint")}"`);

// the folder picker is a native dialog: the test answers it through window.__pickFolder
await page.evaluate((dir) => { window.__pickFolder = async () => dir; }, SRC);
await page.click("#c-drop [data-folder]");
await until(async () => (await page.$$(".tray .tcard")).length === 3, "3 videos in the tray", 10000);
check(true, "Folder adds the 3 videos (subfolder included, notes.txt ignored)");
const settingsFolder = DEST;
check((await page.textContent("#c-go")).includes("Convert 3 videos"), "button says Convert 3 videos");
await page.click("#c-go");
const jobs = await until(async () => {
  const j = (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("queue_get"))).jobs.filter((x) => x.module === "converter");
  return j.length === 2 && j.every((x) => ["done", "failed"].includes(x.state)) ? j : null;
}, "2 jobs finished", 60000);
check(jobs.every((j) => j.state === "done"), `both jobs done ${jobs.map((j) => j.error ?? "").join(" ")}`);
const m4a = join(settingsFolder, "aac (M4A).m4a");
const opus = join(settingsFolder, "opus (OPUS).opus");
check(existsSync(m4a) && codec(m4a) === "aac", "AAC audio copied to .m4a");
check(existsSync(opus) && codec(opus) === "opus", "Opus audio copied to .opus");
await until(async () => /no audio track/.test(await page.textContent(".banner").catch(() => "")), "no-audio banner", 5000);
check(true, "a video without audio is explained, not queued");
await page.screenshot({ path: join(OUT, "t30-converter.png") });
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T30 TEST PASSED");
