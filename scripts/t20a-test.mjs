// T20a test: Image Converter through the UI. A transparent PNG into every format (JPG on white,
// 256 × 256 ICO with alpha, traced SVG), size cap that never enlarges, same format never overwrites
// the original, AVIF → SVG through FFmpeg, choices remembered. Usage: node scripts/t20a-test.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t20a");
const DEST = join(W, "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
const ffmpeg = (...a) => execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-y", ...a]);
const probe = (f) => JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt", "-of", "json", f]).toString()).streams[0];
const pixel = (f, x, y) => [...execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-i", f, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
async function drop(page, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([name, data]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    document.querySelector("#i-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [basename(file), b64]);
}
const seen = new Set();
/** Picks a format, drops `file`, converts, returns the finished job. */
async function convert(page, format, file, extra = async () => {}) {
  await page.selectOption("#i-format", format);
  await extra();
  await drop(page, file);
  await until(() => page.$eval("#i-go", (b) => !b.disabled), "file in the tray", 10000);
  await page.click("#i-go");
  const id = await until(async () => (await jobs(page)).find((j) => j.module === "imgconv" && !seen.has(j.id))?.id, "job queued", 10000);
  seen.add(id);
  const j = await until(async () => { const x = (await jobs(page)).find((y) => y.id === id); return ["done", "failed"].includes(x.state) ? x : null; }, `${format} job`, 120000);
  check(j.state === "done", `${format}: job done${j.error ? ": " + j.error : ""}`);
  await page.click("[data-clear-done]").catch(() => {});
  return j;
}

rmSync(W, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "imgconv", autoUpdateYtdlp: false, imgconv: { folder: DEST, eagle: false } }));
// 1280×720 transparent with an opaque blue logo in the middle
const logo = join(W, "logo.png");
ffmpeg("-f", "lavfi", "-i", "color=c=red@0.0:s=1280x720,format=rgba", "-f", "lavfi", "-i", "color=c=0x2050d0:s=400x300", "-filter_complex", "[0][1]overlay=440:210,format=rgba", "-frames:v", "1", logo);
const avif = join(W, "photo.avif");
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", "-cpu-used", "8", "-crf", "30", avif);

const app = await launch(EXE);
const { page } = app;
await page.waitForSelector("#i-format");
check((await page.$$eval("#i-format option", (o) => o.length)) === 9, "nine output formats");

await convert(page, "jpg", logo);
const jpg = join(DEST, "logo.jpg");
check(existsSync(jpg), "JPG saved");
check(pixel(jpg, 5, 5).every((v) => v > 245), `transparent area became white in JPG (${pixel(jpg, 5, 5)})`);
check(pixel(jpg, 640, 360)[2] > 150, "logo kept in JPG");

await convert(page, "webp", logo);
check(probe(join(DEST, "logo.webp")).codec_name === "webp", "WebP saved");
await convert(page, "avif", logo);
check(probe(join(DEST, "logo.avif")).codec_name === "av1", "AVIF saved");
await convert(page, "tiff", logo);
await convert(page, "bmp", logo);
await convert(page, "gif", logo);
check(["logo.tiff", "logo.bmp", "logo.gif"].every((f) => existsSync(join(DEST, f))), "TIFF, BMP, GIF saved");

await convert(page, "ico", logo);
const ico = probe(join(DEST, "logo.ico"));
check(ico.width === 256 && ico.height === 256 && ico.pix_fmt === "rgba", `square 256 × 256 icon with alpha (${ico.width}×${ico.height} ${ico.pix_fmt})`);

await convert(page, "png", logo, () => page.selectOption("#i-size", "256"));
const png = join(DEST, "logo (converted).png");
check(existsSync(png), "same format never overwrites: saved as (converted)");
check(probe(png).width === 256, `size cap applied (${probe(png).width} px wide)`);
await page.selectOption("#i-size", "3840");
await convert(page, "png", avif);
check(probe(join(DEST, "photo.png")).width === 640, "never enlarges (640 stays 640)");
await page.selectOption("#i-size", "0");

await convert(page, "svg", logo, async () => {
  check(await page.isVisible("#i-svg-detail") && !(await page.isVisible("#i-size")), "SVG shows colour/detail options, hides size");
});
const svg = readFileSync(join(DEST, "logo.svg"), "utf8");
check(svg.includes("<svg") && svg.includes("<path"), "logo traced into an SVG");
await convert(page, "svg", avif);
check(readFileSync(join(DEST, "photo.svg"), "utf8").includes("<path"), "AVIF traced through FFmpeg first");
check(!readdirSync(join(DATA, "temp")).some((f) => f.startsWith("imgconv-")), "temporary PNG removed");
await page.screenshot({ path: join(OUT, "t20a.png"), fullPage: true });

const saved = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).imgconv;
check(saved.format === "svg", "chosen format remembered");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T20a TEST PASSED");
