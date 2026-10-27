// T8-T11 test: hidden tools, everything remembered across restarts, window state, Audible sign-in
// plumbing, AI runtime install, Demucs and faster-whisper. Downloads ~3 GB on first run.
// Usage: node scripts/t8-11-test.mjs   (ONLY=memory,audible,ai to pick sections)
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t8-11");
const only = (s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
const settingsFile = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
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
async function restart(app) {
  await app.page.click("#wc-close").catch(() => {});
  await new Promise((r) => app.proc.once("exit", r));
  await sleep(800);
  return launch(EXE);
}
const seen = new Set();
async function nextJobDone(page, module, ms = 1800000) {
  const id = await until(async () => (await jobs(page)).find((j) => j.module === module && !seen.has(j.id))?.id, `${module} job queued`, 30000);
  seen.add(id);
  const j = await until(async () => { const x = (await jobs(page)).find((y) => y.id === id); return ["done", "failed"].includes(x.state) ? x : null; }, `${module} job`, ms);
  check(j.state === "done", `${module} job "${j.title}" done${j.error ? ": " + j.error : ""}`);
  return j;
}

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({
  lastModule: "settings", autoUpdateYtdlp: false, cookies: { youtube: "none" }, window: { x: 120, y: 90, width: 1100, height: 720, maximized: false },
  demucs: { folder: W }, whisper: { folder: W, model: "base", formats: ["srt", "txt"] },
}));
let app = await launch(EXE);
let page = app.page;

// ================= T8 =================
if (only("memory")) {
  const [x, y, w] = await page.evaluate(() => [window.screenX, window.screenY, Math.round(window.innerWidth * devicePixelRatio)]);
  check(Math.abs(x - 120) < 20 && Math.abs(y - 90) < 40 && Math.abs(w - 1100) < 20, `window restored at saved position/size (${x},${y} ${w}px)`);
  const navs = await page.$$eval(".nav", (n) => n.map((x) => x.dataset.id));
  check(navs.length === 13, `10 tools + Downloads + Binaries + Settings in the sidebar (${navs.join(", ")})`);
  await page.uncheck('[data-tool="upscale"]');
  check(!(await page.$('.nav[data-id="upscale"]')), "hiding Upscale removes it from the sidebar");
  check(settingsFile().hiddenTools.includes("upscale"), "hidden tools saved");

  await page.click('.nav[data-id="video"]');
  await page.fill("#v-url", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await page.click('.nav[data-id="gallery"]');
  await page.fill("#g-url", "https://example.com/some-gallery");
  await page.click('.nav[data-id="rembg"]');
  const img = join(W, "keep.png");
  execFileSync(join(DATA, "bin", "ffmpeg.exe"), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", img]);
  await drop(page, "#r-drop", img);
  await until(() => page.$("#r-batch .tcard"), "file listed");
  check((await page.textContent("#r-batch .tcard .tname")) === "keep.png", "dropped file keeps its original name");
  await page.click('.tab[data-mode="compare"]');

  app = await restart(app);
  page = app.page;
  check(await page.isVisible("#r-compare"), "reopens on the last tool with the Compare tab still selected");
  await page.click('.tab[data-mode="batch"]');
  check((await page.$$("#r-batch .tcard")).length === 1, "dropped image still listed after restart");
  check(!(await page.$('.nav[data-id="upscale"]')), "Upscale still hidden after restart");
  await page.click('.nav[data-id="video"]');
  check((await page.inputValue("#v-url")).includes("jNQXAC9IVRw"), "video URL remembered");
  await until(async () => (await page.textContent("#v-preview .t").catch(() => "")) === "Me at the zoo", "preview re-fetched on reopen", 60000);
  check(true, "preview re-fetched automatically");
  await page.click('.nav[data-id="gallery"]');
  check((await page.inputValue("#g-url")) === "https://example.com/some-gallery", "gallery URL remembered");
  await page.click('.nav[data-id="settings"]');
  await page.check('[data-tool="upscale"]');
  check(!!(await page.$('.nav[data-id="upscale"]')), "showing Upscale again");
}

// ================= T9 Audible (no account needed) =================
if (only("audible")) {
  await page.click('.nav[data-id="audible"]');
  await page.waitForSelector("#a-start");
  check(true, "Audible shows the sign-in card when not connected");
  const url = await invoke(page, "audible_login_start", { country: "it" });
  check(url.startsWith("https://www.amazon.it/ap/signin"), "audible-cli produces the amazon.it sign-in link");
  const bad = await invoke(page, "audible_login_finish", { url: "https://www.amazon.it/ap/maplanding?nothing" }).then(() => "ok", (e) => String(e));
  check(bad !== "ok", `a wrong address is rejected: ${bad.slice(0, 80)}`);
  check(!(await invoke(page, "audible_status")).loggedIn, "still signed out");
  check(existsSync(join(DATA, "bin", "audible.exe")), "audible-cli bundled");
}

// ================= T10/T11 AI runtime, Demucs, Whisper =================
if (only("ai")) {
  await page.click('.nav[data-id="demucs"]');
  if (!(await invoke(page, "python_status")).installed.demucs) {
    await until(() => page.isVisible("#d-notice .notice"), "runtime notice");
    await page.click("#d-notice .notice .btn");
    await page.waitForSelector(".modal h3:text('Install Demucs?')");
    check((await page.textContent(".modal")).includes("PyTorch"), "install asks first, listing PyTorch and sizes");
    await page.click(".modal .m-foot .btn.primary");
    await until(async () => (await invoke(page, "python_status")).installed.demucs, "runtime installed", 2400000);
    check(true, "Python + PyTorch + Demucs installed");
  }
  const song = join(W, "song.wav");
  execFileSync(join(DATA, "bin", "ffmpeg.exe"), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-f", "lavfi", "-i", "anoisesrc=d=8:a=0.05", "-filter_complex", "amix=inputs=2", song]);
  await drop(page, "#d-drop", song);
  await page.selectOption("#d-stems", "two");
  await page.selectOption("#d-format", "mp3");
  await page.click("#d-go");
  await page.waitForSelector(".modal h3:text('Download model?')").then(() => page.click(".modal .m-foot .btn.primary")).catch(() => {});
  let j = await nextJobDone(page, "demucs");
  check(j.outputs.length === 2 && j.outputs.every((o) => existsSync(o) && o.endsWith(".mp3")), `stems written: ${j.outputs.map((o) => basename(o)).join(", ")}`);

  await page.click('.nav[data-id="whisper"]');
  if (!(await invoke(page, "python_status")).installed.whisper) {
    await until(() => page.isVisible("#w-notice .notice"), "whisper notice");
    await page.click("#w-notice .notice .btn");
    await page.waitForSelector(".modal h3:text('Install faster-whisper?')");
    await page.click(".modal .m-foot .btn.primary");
    await until(async () => (await invoke(page, "python_status")).installed.whisper, "faster-whisper installed", 1200000);
    check(true, "faster-whisper installed (PyTorch reused)");
  }
  const speech = join(W, "speech.wav");
  execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${speech}'); $s.Speak('Hello, this is a test of the Hermes subtitles feature.'); $s.Dispose()"`);
  await drop(page, "#w-drop", speech);
  await page.selectOption("#w-lang", "en");
  await page.click("#w-go");
  await page.waitForSelector(".modal h3:text('Download model?')").then(() => page.click(".modal .m-foot .btn.primary")).catch(() => {});
  j = await nextJobDone(page, "whisper");
  const srt = j.outputs.find((o) => o.endsWith(".srt"));
  const text = readFileSync(srt, "utf8");
  check(/-->/.test(text) && /hermes/i.test(text) && /sub-?titles?/i.test(text), `SRT transcribed: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  check(j.outputs.some((o) => o.endsWith(".txt")), "TXT written too");
  await page.screenshot({ path: join(OUT, "t11-whisper.png") });
}

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T8-T11 TEST PASSED");
