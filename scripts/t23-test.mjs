// T23 test: per-tool backdrops. Editor opens from the tool header, Sample and a dropped transparent PNG
// are drawn behind the page, every style draws something different, sliders/position/colour apply,
// the panel closes on tool switch, other tools stay plain, Apply to all, None, kept after restart.
// Usage: node scripts/t23-test.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t23");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const looks = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).backdrops ?? {};
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(200);
  }
}
async function drop(page, sel, file) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(([sel, name, data]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    document.querySelector(sel).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [sel, basename(file), b64]);
}
/** The drawn backdrop: hidden?, size, a fingerprint of its pixels, lit pixel count. */
const art = (page) => page.evaluate(() => {
  const c = document.querySelector(".backdrop canvas");
  if (!c || c.hidden) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let lit = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 20) { lit++; sum = (sum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + i) % 1e9; }
  const r = c.getBoundingClientRect(), v = document.querySelector(".content").getBoundingClientRect();
  return { w: c.width, h: c.height, lit, sum, opacity: c.style.opacity, filter: c.style.filter, left: Math.round(r.left - v.left), right: Math.round(v.right - r.right) };
});
const setSlider = (page, key, v) => page.$eval(`#bd-panel [data-key="${key}"]`, (i, v) => { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, String(v));

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
const png = join(W, "figure.png"); // orange disc on transparency
execFileSync(join(DATA, "bin", "ffmpeg.exe"), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=300x400", "-frames:v", "1",
  "-vf", "format=rgba,geq=r='255':g='120+X/3':b='Y/4':a='if(lt(hypot(X-150,Y-200),120),255,0)'", png]);
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "video", autoUpdateYtdlp: false }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector('.page .head [data-backdrop]');
check((await art(page)) === null, "no backdrop by default");

await page.click("[data-backdrop]");
await page.waitForSelector("#bd-panel");
check(await page.$eval("#bd-panel", (p) => p.classList.contains("empty")), "editor opens beside the page, empty");
await page.click("#bd-sample");
const s0 = await until(() => art(page), "sample drawn");
check(s0.lit > 500 && s0.right <= 1, `sample drawn on the right (${s0.w}×${s0.h}, ${s0.lit} lit px)`);
check(await page.$eval(".content", (c) => c.classList.contains("has-backdrop")), "page knows it has a backdrop (see-through cards)");
check(await page.$eval("#view", (v) => getComputedStyle(v).zIndex === "1"), "page content stays above the backdrop");
await page.screenshot({ path: join(OUT, "t23-editor.png") });

// every style draws something different
const prints = new Map();
for (const st of ["outline", "sketch", "glow", "ghost", "bw", "duotone", "halftone", "pixel", "color"]) {
  const before = (await art(page)).sum;
  await page.click(`[data-style="${st}"]`);
  if (st !== "outline") await until(async () => (await art(page)).sum !== before, `style ${st} redrawn`);
  prints.set(st, (await art(page)).sum);
  await page.screenshot({ path: join(W, `style-${st}.png`) });
}
check(new Set(prints.values()).size === 9, "9 styles, 9 different drawings");
check((await art(page)).filter === "", "no filter by default");
await page.click('[data-style="glow"]');
await until(async () => (await art(page)).filter.includes("drop-shadow"), "glow halo");
check(true, "Glow adds a soft halo");

// sliders, position, colour, checkboxes
await setSlider(page, "opacity", 40);
await until(async () => (await art(page)).opacity === "0.4", "visibility applied");
check(true, "Visibility slider sets the opacity");
const big = (await art(page)).h;
await setSlider(page, "size", 60);
await until(async () => (await art(page)).h < big, "size applied");
check(true, `Size slider shrinks the image (${big} → ${(await art(page)).h} px)`);
await setSlider(page, "blur", 6);
await until(async () => (await art(page)).filter.includes("blur(6px)"), "softness applied");
check(true, "Softness blurs it");
await page.click('[data-pos="left"]');
await until(async () => (await art(page)).left === 0, "moved left");
check(true, "Position: left");
const amber = (await art(page)).sum;
await page.click('[data-tint="white"]');
await until(async () => (await art(page)).sum !== amber, "colour changed");
check(true, "Colour: white redraws");
const unflipped = (await art(page)).sum;
await page.check("#bd-flip").catch(() => page.click("#bd-flip + .box"));
await until(async () => (await art(page)).sum !== unflipped, "mirrored");
check(true, "Mirror flips it");

// own transparent PNG
await drop(page, "#bd-drop", png);
await until(async () => (looks().video?.file ?? "").includes("backdrops"), "image copied to hermes-data/backdrops", 10000);
const file = looks().video.file;
check(existsSync(file) && file.startsWith(join(DATA, "backdrops")), `dropped PNG copied to ${file}`);
await page.click('[data-style="outline"]');
const ring = await until(async () => { const a = await art(page); return a && a.w === Math.round(a.h * 300 / 400) ? a : null; }, "own image drawn at its aspect ratio");
check(ring.lit > 100, `own PNG drawn as an outline (${ring.w}×${ring.h}, ${ring.lit} lit px)`);

// switching tools: panel closes, other tools stay plain until "Apply to all"
await page.click('.nav[data-id="pixel"]');
await page.waitForSelector("#px-dropzone");
check(!(await page.$("#bd-panel")), "editor closes when switching tools");
check((await art(page)) === null, "another tool has no backdrop");
await page.click('.nav[data-id="video"]');
await until(() => art(page), "video backdrop back");
await page.click("[data-backdrop]");
await page.click("#bd-all");
await page.click('.nav[data-id="pixel"]');
await until(() => art(page), "Apply to all: pixel tool has it too");
check(true, "Apply to all tools copies image and look");
await page.click("[data-backdrop]");
await page.click("#bd-none");
await until(async () => (await art(page)) === null, "None removes it");
check(true, "None removes the backdrop");
await page.click("#bd-close");
check(!(await page.$("#bd-panel")), "Close button closes the editor");

// restart: kept
await page.click('.nav[data-id="video"]');
await sleep(800);
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector('.page .head [data-backdrop]');
const back = await until(() => art(page), "backdrop after restart");
check(back.left === 0 && back.opacity === "0.4" && back.filter.includes("blur(6px)"), "backdrop and its look kept after restart");
await page.screenshot({ path: join(OUT, "t23.png") });
await page.click('.nav[data-id="pixel"]');
await sleep(500);
check((await art(page)) === null, "pixel tool still without backdrop after restart");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T23 TEST PASSED");
