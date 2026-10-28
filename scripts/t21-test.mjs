// T21 test: Pattern Generator. Core under node, then the app: live preview reacts to sliders and
// format, Random, presets, PNG export at the chosen size (transparent without background), SVG export,
// everything remembered after a restart. Usage: node scripts/t21-test.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

execFileSync("node", ["scripts/pattern-core-test.mjs"], { stdio: "inherit" });
const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const DEST = join(OUT, "t21");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefs = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).pattern;
const probe = (f) => JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", f]).toString()).streams[0];
const alphaAt = (f, x, y) => [...execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-i", f, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"])][3];
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(200);
  }
}
const canvasData = (page) => page.$eval("#pt-canvas", (c) => c.toDataURL());
const setSlider = (page, key, value) => page.$eval(`[data-key="${key}"]`, (i, v) => { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, String(value));

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "pattern", autoUpdateYtdlp: false, pattern: { folder: DEST, long: 1080 } }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#pt-canvas");
// a fresh canvas is already 300 px wide: wait for the dots themselves
const litShare = () => page.$eval("#pt-canvas", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200) n++; return n / (d.length / 4); });
const lit = await until(async () => { const v = await litShare(); return v > 0 ? v : 0; }, "preview drawn");
check(lit > 0.01 && lit < 0.6, `preview shows white dots (${(lit * 100).toFixed(1)}% of pixels)`);
let before = await canvasData(page);
await setSlider(page, "amplitude", 120);
await until(async () => (await canvasData(page)) !== before, "slider redraws the preview");
await until(async () => prefs().params?.amplitude === 120, "slider value saved");
await page.click('[data-aspect="16:9"]');
await until(async () => { const [w, h] = await page.$eval("#pt-canvas", (c) => [c.width, c.height]); return Math.abs(w / h - 16 / 9) < 0.02; }, "16:9 preview");
check(true, "format changes the canvas to 16:9");
const seed = prefs().params?.seed;
before = await canvasData(page);
await page.click("#pt-dice");
await until(async () => prefs().params?.seed !== seed && (await canvasData(page)) !== before, "Random gives a new pattern");
check(true, "Random makes a new pattern");
await page.fill("#pt-name", "Test look");
await page.click("#pt-save");
await until(() => page.isVisible('.pt-preset:has-text("Test look")'), "preset chip");
const look = prefs().presets?.[0]?.params;
await page.click("#pt-reset");
await until(async () => prefs().params?.grid === 64 && prefs().params?.amplitude === 60, "reset");
await page.click('.pt-preset .pt-use:has-text("Test look")');
await until(async () => JSON.stringify(prefs().params) === JSON.stringify(look), "preset applied");
check(await page.$eval('[data-key="grid"]', (i, g) => Number(i.value) === g, look.grid), "preset moves the sliders too");

// PNG with background at 1080p (16:9 → 1080×608), then without background
await page.click("#pt-png");
const png = join(DEST, `pattern-${look.seed}-1080x608.png`);
await until(() => existsSync(png), "PNG written");
check(probe(png).width === 1080 && probe(png).height === 608, `PNG 1080 × 608 (${probe(png).width}×${probe(png).height})`);
check(alphaAt(png, 1, 1) === 255, "background is opaque");
await page.click("#pt-bg-box");
await until(async () => prefs()?.bg === false, "background off");
await page.selectOption("#pt-long", "3840");
rmSync(png, { force: true });
await page.click("#pt-png");
const png4k = join(DEST, `pattern-${look.seed}-3840x2160.png`);
await until(() => existsSync(png4k), "4K PNG written", 30000);
check(probe(png4k).width === 3840 && alphaAt(png4k, 1, 1) === 0, "4K PNG with transparent background");
await page.click("#pt-svg");
const svgFile = join(DEST, `pattern-${look.seed}-3840x2160.svg`);
await until(() => existsSync(svgFile), "SVG written");
const svg = readFileSync(svgFile, "utf8");
check(svg.startsWith("<svg") && (svg.match(/<circle/g) ?? []).length > 1000 && !svg.includes("<rect"), "SVG with every dot, no background");
await until(() => page.isVisible('[data-banner="pattern"]'), "saved banner", 5000);
check((await page.textContent('[data-banner="pattern"]')).includes("Show in folder"), "banner offers Show in folder");
await page.screenshot({ path: join(OUT, "t21.png") });

// restart: everything kept
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector("#pt-canvas");
check(await page.$eval('[data-aspect="16:9"]', (b) => b.classList.contains("on")), "format kept after restart");
check(await page.isVisible('.pt-preset:has-text("Test look")'), "presets kept after restart");
check(!(await page.$eval("#pt-bg", (b) => b.checked)) && (await page.$eval("#pt-long", (s) => s.value)) === "3840", "background off and export size kept");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T21 TEST PASSED");
