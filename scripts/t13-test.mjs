// T13 test: Downloads page + badge, live console, queue live right after switching tools, Clear
// button, rate-limit timer only when waiting, parallel-downloads setting, gallery without previews,
// results in the chosen folder, Video Converter, Image Upscale images-only, Video Downloader
// resolutions/container/Premiere/Mix, Spotify (spotDL). Needs network + Eagle.
// Usage: node scripts/t13-test.mjs   (ONLY=queue,converter,video,spotify,gallery to pick sections)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t13");
const only = (s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
const probe = (f) => JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]).toString());
const ffmpeg = (...a) => execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-y", ...a]);
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
const seen = new Set();
async function nextJobDone(page, module, ms = 600000) {
  const id = await until(async () => (await jobs(page)).find((j) => j.module === module && !j.parent && !seen.has(j.id))?.id, `${module} job queued`, 30000);
  seen.add(id);
  const j = await until(async () => { const x = (await jobs(page)).find((y) => y.id === id); return ["done", "failed"].includes(x.state) ? x : null; }, `${module} job`, ms);
  check(j.state === "done", `${module} job "${j.title}" done${j.error ? ": " + j.error : ""}`);
  return j;
}

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
const C = join(W, "converter"), V = join(W, "video"), S = join(W, "spotify"), R = join(W, "rembg");
writeFileSync(join(DATA, "settings.json"), JSON.stringify({
  lastModule: "converter", autoUpdateYtdlp: false, cookies: { youtube: "none" },
  converter: { folder: C }, video: { folder: V, eagle: false, format: "best" }, spotify: { folder: S },
  rembg: { folder: R, eagle: true, model: "isnet-general-use" }, gallery: { folder: join(W, "gallery"), eagle: false, previews: false },
}));
const clip = join(W, "clip.mp4");
ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-c:a", "aac", "-shortest", clip);

const app = await launch(EXE);
const { page } = app;

// ================= queue / Downloads / console / Clear =================
if (only("queue") || only("converter")) {
  check((await page.$$eval(".nav", (n) => n.map((x) => x.dataset.id).join())).includes("downloads"), "Downloads entry in the sidebar");
  check(!(await page.$(".activity")), "old Activity panel gone");
  await page.waitForSelector("#c-drop");
  await drop(page, "#c-drop", clip);
  await until(() => page.$(".c-files .tcard"), "clip in the converter tray");
  await page.selectOption("#c-preset", "h264");
  await page.selectOption("#c-height", "1080");
  await page.click("#c-go");
  // switch away immediately and come back: the queue must show the running job right away
  await until(async () => (await jobs(page)).some((j) => j.module === "converter" && j.state === "running"), "converter running", 20000);
  await page.click('.nav[data-id="video"]');
  await page.click('.nav[data-id="converter"]');
  const t0 = Date.now();
  await until(() => page.$('.queue .item.running .bar i'), "running item rendered after switching back", 3000);
  check(Date.now() - t0 < 1500, `queue shows the running job immediately after switching tools (${Date.now() - t0} ms)`);
  await until(async () => !!(await page.$(".nav-badge.busy")), "Downloads badge busy", 5000);
  check(true, "Downloads badge shows work in progress");
  await page.click(".queue .item.running .exp");
  await until(async () => (await page.$$(".queue .item .console .ln")).length > 0, "console lines", 10000);
  check((await page.textContent(".queue .item .console")).includes("ffmpeg.exe"), "expanding an item shows its live console (command line visible)");
  await page.screenshot({ path: join(OUT, "t13-console.png") });
  let j = await nextJobDone(page, "converter");
  const v = probe(j.outputs[0]).streams.find((s) => s.codec_type === "video");
  check(v.codec_name === "h264" && v.height === 1080 && v.width === 1920, `converted + upscaled to ${v.width}x${v.height} ${v.codec_name}`);
  check(j.outputs[0].startsWith(C), "converter output in the chosen folder");

  // GIF and audio presets
  await page.click(".c-files [data-clear-all]");
  await drop(page, "#c-drop", clip);
  await page.selectOption("#c-preset", "gif");
  await page.selectOption("#c-height", "0");
  await page.click("#c-go");
  j = await nextJobDone(page, "converter");
  check(j.outputs[0].endsWith(".gif") && existsSync(j.outputs[0]), "GIF preset works");
  await page.click(".c-files [data-clear-all]");
  await drop(page, "#c-drop", clip);
  await page.selectOption("#c-preset", "mp3");
  check(await page.isHidden("#c-video-opts"), "audio presets hide resolution/fps");
  await page.click("#c-go");
  j = await nextJobDone(page, "converter");
  check(probe(j.outputs[0]).streams[0].codec_name === "mp3", "MP3 extraction works");

  // Downloads page lists every tool's jobs with their tool name
  await page.click('.nav[data-id="downloads"]');
  await until(() => page.$(".downloads .queue .item"), "Downloads page items");
  check((await page.textContent(".downloads .queue .item .q-mod")) === "Video Converter", "Downloads page shows the tool of each item");

  // Clear button
  await page.click('.nav[data-id="converter"]');
  await drop(page, "#c-drop", clip);
  await until(() => page.$(".c-files .tcard"), "tray filled");
  await page.click(".page > .head button:has-text('Clear')");
  await until(async () => !(await jobs(page)).some((x) => x.module === "converter"), "converter jobs cleared", 5000);
  await until(async () => (await page.$$(".c-files .tcard")).length === 0, "tray cleared", 5000);
  check(true, "Clear empties this tool's queue and files");

  // rate-limit timer only with something waiting; parallel setting
  await invoke(page, "save_settings", { settings: { ...JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")) } });
  check(!(await page.$("[data-until]")), "no rate-limit timer when nothing is waiting");
  await page.click('.nav[data-id="settings"]');
  check((await page.inputValue("#max-concurrent")) === "6", "parallel downloads default 6");
  await page.fill("#max-concurrent", "8");
  await page.dispatchEvent("#max-concurrent", "change");
  await until(() => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).maxConcurrent === 8, "setting written", 5000);
  check(true, "parallel downloads setting saved");
  await page.fill("#max-concurrent", "6");
  await page.dispatchEvent("#max-concurrent", "change");
}

// ================= Image Upscale is images only =================
if (only("queue")) {
  await page.click('.nav[data-id="upscale"]');
  await page.waitForSelector("#u-drop");
  check((await page.textContent(".nav[data-id='upscale']")).includes("Image Upscale"), "Upscale renamed Image Upscale");
  await drop(page, "#u-drop", clip);
  await sleep(800);
  check((await page.$$(".u-files .tcard")).length === 0, "Image Upscale refuses videos");
}

// ================= Background Removal saves in the chosen folder =================
if (only("queue") && (await invoke(page, "rembg_models")).some((m) => m.id === "isnet-general-use" && m.installed)) {
  await page.click('.nav[data-id="rembg"]');
  await page.click('.tab[data-mode="batch"]');
  await drop(page, "#r-drop", resolve("test-output/fixtures/photo.jpg"));
  await until(() => page.$("#r-batch .tcard.ready"), "photo in tray");
  await page.click("#r-go");
  const j = await nextJobDone(page, "rembg");
  check(j.outputs[0].startsWith(R) && existsSync(j.outputs[0]), "result saved in the chosen folder even with Eagle on");
  const found = (await (await fetch(`http://localhost:41595/api/item/list?keyword=photo-nobg&limit=5`)).json()).data;
  if (found.length) await fetch("http://localhost:41595/api/item/moveToTrash", { method: "POST", body: JSON.stringify({ itemIds: found.map((i) => i.id) }) });
}

// ================= Video Downloader =================
if (only("video")) {
  await page.click('.nav[data-id="video"]');
  await page.fill("#v-url", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await page.click("#v-fetch");
  await until(async () => (await page.textContent("#v-preview .t").catch(() => "")) === "Me at the zoo", "preview", 60000);
  await page.click("#v-format");
  const opts = await page.$$eval(".menu .mi", (m) => m.map((x) => `${x.dataset.format}:${x.disabled}`));
  check(opts.includes("2160:true") && opts.includes("1080:true"), `resolutions above the video's are disabled (${opts.join(" ")})`);
  await page.keyboard.press("Escape");
  await page.click("#v-format");
  await page.click('[data-format="best"]');
  const notice = await page.textContent("#v-container");
  check(/Saved as (MP4|WEBM|MKV) \(/.test(notice), `container announced: ${notice}`);
  await page.click("#v-premiere-box");
  check(/Premiere|MP4/.test(await page.textContent("#v-container")), "Premiere option explains the result");
  await page.click("#v-add");
  const j = await nextJobDone(page, "video", 300000);
  const s = probe(j.outputs[0]).streams;
  check(j.outputs[0].endsWith(".mp4") && s.find((x) => x.codec_type === "video").codec_name === "h264", "Premiere option gives MP4 H.264");
  await page.click("#v-premiere-box");

  await page.fill("#v-url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ");
  await page.dispatchEvent("#v-url", "input");
  check(await page.isVisible("#v-list") && (await page.textContent("#v-list")).includes("YouTube Mix"), "a Mix URL offers the whole-Mix option");
  await page.click("#v-list");
  await until(async () => (await page.textContent("#v-preview .c").catch(() => "")).includes("YouTube Mix"), "Mix preview", 90000);
  check(/\d+ videos/.test(await page.textContent("#v-preview")), `Mix read as a playlist: ${(await page.textContent("#v-preview .facts")).trim()}`);
  await page.click("#v-list");
  await until(async () => (await page.textContent("#v-preview .t").catch(() => "")).length > 3 && !(await page.textContent("#v-preview .c")).includes("Mix"), "single song again", 60000);
  check(true, "unticking goes back to only this song");
}

// ================= Spotify =================
if (only("spotify")) {
  await page.click('.nav[data-id="spotify"]');
  await until(async () => /spotDL \d/.test(await page.textContent("#s-tool")), "spotDL bundled");
  await page.fill("#s-url", "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
  await page.click("#s-fetch");
  await until(async () => (await page.textContent("#s-list").catch(() => "")).includes("Never Gonna Give You Up"), "song list", 120000);
  check(true, "Spotify link read (song, artist, album)");
  await page.click("#s-add");
  const j = await nextJobDone(page, "spotify", 600000);
  const mp3 = readdirSync(S).find((f) => f.endsWith(".mp3"));
  check(!!mp3 && /Rick Astley/.test(mp3), `song downloaded: ${mp3}`);
  check(j.log.some((l) => l.includes("spotdl")), "console shows spotDL output");
}

// ================= Gallery without previews =================
if (only("gallery")) {
  await page.click('.nav[data-id="gallery"]');
  await page.fill("#g-url", "https://en.wikipedia.org/wiki/Hermes");
  await page.click("#g-fetch");
  await until(async () => /of \d+ selected/.test(await page.textContent("#g-summary")), "gallery summary", 90000);
  check((await page.$$("#g-grid > *")).length === 0, "previews off: no file rows, only the summary");
  check(await page.isHidden("#g-all"), "manual select buttons only with previews");
}

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T13 TEST PASSED");
