// T22 test: Pixel Art. Core under node, then the app: live preview, built-in palette respected, palette
// from the image, dithering, Lospec import and pasted colours, grid, Small / Original / 4K export sizes,
// several images at once, everything remembered. Needs network (Lospec). Usage: node scripts/t22-test.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

execFileSync("node", ["scripts/pixel-core-test.mjs"], { stdio: "inherit" });
const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t22");
const DEST = join(W, "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefs = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).pixel ?? {};
const ffmpeg = (...a) => execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-y", ...a]);
const size = (f) => { const s = JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", f]).toString()).streams[0]; return `${s.width}x${s.height}`; };
const pixel = (f, x, y) => [...execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-i", f, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(250);
  }
}
async function drop(page, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([name, data]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    document.querySelector("#px-dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [basename(file), b64]);
}
/** Distinct colours on the preview canvas. */
const previewColours = (page) => page.$eval("#px-canvas", (c) => {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, set = new Set();
  for (let i = 0; i < d.length; i += 16) if (d[i + 3] > 0) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return [...set].map((v) => v.toString(16).padStart(6, "0"));
});
const canvasData = (page) => page.$eval("#px-canvas", (c) => c.toDataURL());
const setSlider = (page, sel, v) => page.$eval(sel, (i, v) => { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, String(v));

rmSync(W, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const a = join(W, "photo.png"), b = join(W, "second.jpg");
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1", a);
ffmpeg("-f", "lavfi", "-i", "mandelbrot=size=480x480", "-frames:v", "1", b);
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "pixel", autoUpdateYtdlp: false, pixel: { folder: DEST } }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#px-dropzone");
check(await page.isVisible("#px-empty"), "empty state before any image");
await drop(page, a);
await until(async () => (await page.textContent("#px-info")).includes("80 × 45"), "preview of a 640×360 image at pixel size 8");
check(true, `info: ${await page.textContent("#px-info")}`);
check((await previewColours(page)).length > 8, "preview keeps the image's colours by default");
// the preview keeps its size on screen whatever the pixel size
const shown = () => page.$eval("#px-canvas", (c) => Math.round(c.getBoundingClientRect().width));
const w8 = await shown(), sizes = [];
for (const v of [3, 13, 29, 8]) {
  await setSlider(page, '[data-key="size"]', v);
  await until(async () => (await page.textContent("#px-info")).includes(`${Math.round(640 / v)} ×`), `preview at pixel size ${v}`);
  sizes.push(await shown());
}
check(sizes.every((x) => Math.abs(x - w8) <= 2), `preview stays the same size (${w8} px; ${sizes.join(", ")})`);

await page.selectOption("#px-palette", "Game Boy");
const gb = ["0f380f", "306230", "8bac0f", "9bbc0f"];
await until(async () => (await previewColours(page)).every((c) => gb.includes(c)), "preview only in Game Boy colours");
check((await page.$$("#px-swatches i")).length === 4, "4 palette swatches shown");
let before = await canvasData(page);
await page.selectOption("#px-dither", "floyd");
await until(async () => (await canvasData(page)) !== before, "dithering changes the picture");
check((await previewColours(page)).every((c) => gb.includes(c)), "dithered picture still only uses the palette");
await page.selectOption("#px-palette", "image");
await setSlider(page, "#px-colors", 5);
await until(async () => (await page.$$("#px-swatches i")).length === 5, "palette of 5 colours from the image");
check((await previewColours(page)).length <= 5, "preview uses those 5 colours");

await page.fill("#px-lospec", "https://lospec.com/palette-list/sweetie-16");
await page.click("#px-import");
await until(async () => prefs().custom?.[0]?.name === "Sweetie 16" && prefs().custom[0].colors.length === 16, "Lospec palette imported", 20000);
check((await page.$eval("#px-palette", (s) => s.value)) === "Sweetie 16", "imported palette selected");
await page.fill("#px-hex", "#ff0000, #00ff00 and 0000ff");
await page.click("#px-add");
await until(async () => prefs().custom?.[0]?.colors?.join() === "ff0000,00ff00,0000ff", "pasted palette saved");
await until(async () => (await previewColours(page)).every((c) => ["ff0000", "00ff00", "0000ff"].includes(c)), "preview in the pasted colours");
check(true, "pasted colours become a palette");

// exports: original size with grid, then small and 4K; two images
await page.click("#px-grid-box");
await page.selectOption("#px-dither", "none");
await page.click("#px-go");
const orig = join(DEST, "photo (pixel 8).png");
await until(() => existsSync(orig), "original-size export");
check(size(orig) === "640x360", `original size kept (${size(orig)})`);
check(pixel(orig, 0, 0).join() === "0,0,0", "grid drawn in black");
await drop(page, b);
await until(async () => (await page.$$(".px-thumb")).length === 2, "second image added");
await page.selectOption("#px-out", "small");
await page.click("#px-go");
await until(() => existsSync(join(DEST, "second (pixel 8, small).png")) && existsSync(join(DEST, "photo (pixel 8, small).png")), "both images exported small");
check(size(join(DEST, "photo (pixel 8, small).png")) === "80x45", "small = one pixel per art pixel (80×45)");
await page.selectOption("#px-out", "3840");
await page.click("#px-go");
await until(async () => (await page.textContent('[data-banner="pixel"]').catch(() => "")).includes("Saved 2"), "4K export done", 30000);
check(size(orig) === "3840x2160", `4K export with crisp pixels (${size(orig)})`);
await page.screenshot({ path: join(OUT, "t22.png") });

// restart: all kept
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector("#px-dropzone");
await until(async () => (await page.$$(".px-thumb")).length === 2, "images kept after restart");
check((await page.$eval("#px-out", (s) => s.value)) === "3840" && (await page.$eval("#px-grid", (i) => i.checked)), "export size and grid kept");
check((await page.$$("#px-palette option")).length === 2 + 6 + 2, "custom palettes kept");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T22 TEST PASSED");
