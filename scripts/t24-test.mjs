// T24 test: Anya. Her face is the app mark; she sits in the sidebar corner without covering the list,
// says hello, answers clicks with typed lines, cites game quotes then comments, changes pose with the
// tool, cheers when a job ends, and every setting (size, position, wobble, voice, volume, chattiness,
// on/off) applies at once and survives a restart. Usage: node scripts/t24-test.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t24");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saved = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).anya ?? {};
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(150);
  }
}
const pose = (page) => page.$eval(".anya img.pose", (i) => i.dataset.pose);
const bubble = (page) => page.$eval(".anya-bubble", (b) => ({ show: b.classList.contains("show"), text: b.querySelector(".text").textContent, quote: !!b.querySelector(".quote"), src: b.querySelector(".src")?.textContent ?? "", said: b.querySelector(".said")?.textContent ?? "" }));
const box = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; });
/** Waits for her to finish typing (no caret) and returns the bubble. */
const spoken = (page, what) => until(async () => { const b = await bubble(page); return b.show && !(await page.$(".anya-bubble .caret")) && b.text ? b : null; }, what);

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "video", autoUpdateYtdlp: false }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector(".anya .stage");

check(/face/.test(await page.$eval("#mark img", (i) => i.src)), "app mark is Anya's face");
check(await page.isVisible(".anya"), "Anya is on by default");
const hello = await spoken(page, "hello");
check(hello.text.length > 10, `she says hello: "${hello.text}"`);
check(await page.$eval(".anya", (a) => !a.classList.contains("talking")), "she stops squishing when the line is done");
check((await pose(page)) === "34view", "Video Downloader pose");

// in the sidebar corner, nothing of the list under her
const a = await box(page, ".anya"), list = await box(page, ".side-list"), side = await box(page, "#side");
check(a.x >= side.x && a.r <= side.r + 1 && Math.abs(a.b - side.b) < 2, "she sits at the bottom of the sidebar");
check(list.b <= a.y + 2, "the tool list ends above her (it scrolls instead of hiding under her)");
await page.screenshot({ path: join(OUT, "t24.png") });

// click: talks (typing + squish), then a line
await page.click(".anya-bubble"); // dismiss hello
await page.click(".anya .stage");
await until(() => page.$eval(".anya", (x) => x.classList.contains("talking")), "squish while talking", 3000);
check(true, "clicking her makes her talk (squish animation on)");
const said = await spoken(page, "answer to a click");
check(said.text.length > 5, `answer: "${said.text}"`);

// game quote from her menu: cited, source, then her own comment
await page.click(".anya .stage", { button: "right" });
await page.waitForSelector(".anya-menu");
check((await page.$$eval(".anya-menu button", (b) => b.map((x) => x.textContent))).join("|") === "Say something|Game quote|Hush for an hour|Mute her voice|Anya settings|Hide Anya", "right-click menu");
await page.click('.anya-menu button:has-text("Game quote")');
const q = await spoken(page, "game quote");
check(q.quote && q.src.length > 3 && q.said.length > 5, `quote, then her comment: ${q.text}`);
await page.screenshot({ path: join(OUT, "t24-quote.png") });

// poses follow the tool
for (const [tool, p] of [["upscale", "base"], ["pixel", "typing"], ["docconv", "impress"], ["imgconv", "draw"], ["settings", "front"]]) {
  await page.click(`.nav[data-id="${tool}"]`);
  await until(async () => (await pose(page)) === p, `${tool} pose`);
}
check(true, "pose changes with the tool (Pixel Art typing, Documents impress, Images draw, Settings front)");

// a job ends: she cheers with the donation pose
const out = join(W, "clip.mp4").replace(/\//g, "\\");
await page.click(".anya-bubble").catch(() => {});
await invoke(page, "queue_add", { jobs: [{ module: "converter", title: "anya test", steps: [{ type: "run", label: "x", bin: "ffmpeg.exe", parser: "ffmpeg", args: ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64", out] }] }] });
await until(async () => (await pose(page)) === "donation", "cheer pose when the job is done", 30000);
const cheer = await spoken(page, "job done line");
check(cheer.text.length > 5, `job done: "${cheer.text}"`);

// settings card
await page.waitForSelector("#anya-card");
await page.screenshot({ path: join(OUT, "t24-settings.png") });
const setRange = (sel, v) => page.$eval(sel, (i, v) => { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }, String(v));
const w100 = (await box(page, ".anya")).w;
await setRange("#anya-size", 150);
await until(async () => (await box(page, ".anya")).w > w100 * 1.4, "bigger");
check(true, `Size 150%: ${w100} → ${(await box(page, ".anya")).w} px`);
await setRange("#anya-vol", 55);
await page.click('#anya-pos [data-v="corner"]');
await until(async () => { const b = await box(page, ".anya"); return b.r > 900; }, "moved to the window corner");
check(true, "Position: window corner (bottom right)");
check(await page.$eval(".side .anya-corner", (c) => c.getBoundingClientRect().height === 0), "the sidebar gives its corner back");
// the page gets room at the end: scrolled down, the last card sits above her
await page.$eval(".content", (c) => c.scrollTo(0, c.scrollHeight));
await sleep(200);
const card = await box(page, "#anya-card"), her = await box(page, ".anya");
check(card.b <= her.y + 2, `corner: the end of the page scrolls above her (${Math.round(card.b)} <= ${Math.round(her.y)})`);
await page.click('#anya-wobble [data-v="off"]');
check(await page.$eval(".anya .wobble", (w) => getComputedStyle(w).animationName === "none"), "Wobble off: she stands still");
await page.click('#anya-wobble [data-v="lively"]');
check(await page.$eval(".anya .wobble", (w) => getComputedStyle(w).animationName === "anya-wobble"), "Wobble lively");
await page.click('#anya-chat [data-v="quiet"]');
await page.uncheck("#anya-voice");
await sleep(800);
const s = saved();
check(s.size === 150 && s.volume === 55 && s.position === "corner" && s.wobble === "lively" && s.chat === "quiet" && s.voice === false, `saved: ${JSON.stringify(s)}`);
await page.click("#anya-test");
await spoken(page, "Talk button");
check(true, "Talk button makes her speak");
await page.screenshot({ path: join(OUT, "t24-corner.png") });
await page.uncheck("#anya-on");
await until(async () => !(await page.isVisible(".anya")), "hidden");
check(!(await page.isVisible(".anya-bubble.show")), "off: she and her bubble are gone");
await page.check("#anya-on");
await until(() => page.isVisible(".anya"), "back on");

// restart: everything kept
await sleep(800);
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector(".anya .stage");
const b2 = await box(page, ".anya");
check(b2.r > 900 && b2.w > w100 * 1.4, "position and size kept after restart");
check(await page.$eval(".anya", (x) => x.dataset.wobble === "lively"), "wobble kept after restart");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T24 TEST PASSED");
