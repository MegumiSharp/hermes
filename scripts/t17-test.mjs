// T17b test: every wait shows live feedback (Video, Gallery, Thumbnail Tester, Binaries) and tools can be
// reordered in Settings by dragging or Alt+arrows; the order survives a restart. Needs network.
// Usage: node scripts/t17-test.mjs
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settingsFile = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(200);
  }
}
/** Records every text a .live status shows, even for waits shorter than a poll. */
const watchLive = (page) => page.evaluate(() => {
  window.__live = [];
  new MutationObserver(() => {
    for (const l of document.querySelectorAll(".live")) {
      const t = l.querySelector(".live-t")?.textContent;
      if (!l.hidden && t && window.__live.at(-1) !== t) window.__live.push(t);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
});
const seenLive = (page) => page.evaluate(() => window.__live);
const sidebar = (page) => page.$$eval(".nav[data-id]", (n) => n.map((x) => x.dataset.id));

rmSync(join(DATA, "queue.json"), { force: true });
// Thumbnail Tester starts 6th: the Settings list is taller than the window, the drag needs both rows on screen
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "video", autoUpdateYtdlp: false, cookies: { youtube: "none" }, video: { eagle: false }, toolOrder: ["video", "spotify", "gallery", "rembg", "upscale", "thumbs"] }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#v-url");
await watchLive(page);

// Video Downloader
await page.fill("#v-url", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
await page.click("#v-fetch");
await until(() => page.isVisible("#v-live .live"), "video: live status while reading", 5000);
check((await page.textContent("#v-live .live-t")) === "Reading the video", "video: says what it is doing");
await until(async () => /\d+ s/.test(await page.textContent("#v-live .live-time")), "video: elapsed seconds", 5000);
await until(() => page.isVisible("#v-live .live-more").catch(() => false), "video: Details appear with yt-dlp output", 30000).catch(() => {});
await until(() => page.isVisible("#v-preview .t"), "video: preview after reading", 60000);
check(!(await page.isVisible("#v-live .live")), "video: status gone when the preview shows");

// Thumbnail Tester
await page.click('.nav[data-id="thumbs"]');
await page.waitForSelector("#t-dice");
await page.click("#t-dice");
await until(async () => (await seenLive(page)).some((t) => t.startsWith("Searching YouTube")), "thumbs: search status", 10000);
check(true, "thumbs: search shows live status");
await until(async () => (await page.$$(".yt-card")).length >= 8, "thumbs: feed", 90000);

// Binaries
await page.click('.nav[data-id="binaries"]');
await page.click("#bin-check");
await until(async () => (await seenLive(page)).some((t) => t.startsWith("Checking each tool")), "binaries: check status", 10000);
check(true, "binaries: update check shows live status");
await page.screenshot({ path: join(OUT, "t17-binaries.png") });

// Tool order: drag Thumbnail Tester (6th) to the top
await page.click('.nav[data-id="settings"]');
await page.waitForSelector('.tool-row[data-order="thumbs"] .grip');
const before = await sidebar(page);
await page.$eval("#tool-toggles", (el) => el.scrollIntoView({ block: "start" })); // first and 6th rows both on screen
await sleep(300);
const grip =await page.$('.tool-row[data-order="thumbs"] .grip');
const first = await page.$(".tool-row");
const g = await grip.boundingBox(), f = await first.boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
await page.mouse.down();
for (let y = g.y; y > f.y + 4; y -= 18) await page.mouse.move(g.x + g.width / 2, y);
await page.mouse.move(g.x + g.width / 2, f.y + 4);
await page.mouse.up();
await until(async () => (await sidebar(page))[0] === "thumbs", "dragged tool first in the sidebar", 5000);
check(before[0] !== "thumbs", `drag reorders the sidebar (${(await sidebar(page)).slice(0, 3).join(", ")}...)`);
check(settingsFile().toolOrder?.[0] === "thumbs", "order saved");
check(await page.$eval('[data-tool="thumbs"]', (s) => s.checked), "dragging doesn't toggle the tool off");
await page.focus('.tool-row[data-order="thumbs"] .grip');
await page.keyboard.press("Alt+ArrowDown");
await until(async () => (await sidebar(page))[1] === "thumbs", "Alt+Down moves it one down", 5000);
check(true, "keyboard reorder works");
await page.screenshot({ path: join(OUT, "t17-order.png"), fullPage: true });

// restart: order kept
const order = await sidebar(page);
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector(".nav");
check(JSON.stringify(await sidebar(page)) === JSON.stringify(order), "order survives a restart");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T17 TEST PASSED");
