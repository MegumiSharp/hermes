// T18 test: Thumbnail Tester recent channels/searches as quick picks, real upload dates, channel
// subscribers + Outliers, Find similar (search by your title), everything kept after a restart. Needs network.
// Usage: node scripts/t18-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t18");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thumbs = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).thumbs ?? {};
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(500);
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
const topicValue = (page) => page.$eval("#t-topic", (i) => i.value);
const feedReady = (page) => until(async () => (await page.$$(".yt-card")).length >= 8, "feed", 120000);

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "thumbs", autoUpdateYtdlp: false }));
const thumb = join(W, "mine.png");
execFileSync(join(DATA, "bin", "ffmpeg.exe"), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1", thumb]);

let app = await launch(EXE);
let { page } = app;
await feedReady(page);

// typed searches become quick picks
await page.fill("#t-topic", "chess openings");
await page.click("#t-search");
await until(async () => thumbs().recentTopics?.[0] === "chess openings", "typed search remembered", 90000);
await feedReady(page);
await page.click("#t-dice");
await until(async () => (await topicValue(page)) !== "chess openings", "dice picked another topic", 10000);
await until(() => page.isVisible('#t-topic-recent .chip:has-text("chess openings")'), "recent search chip", 90000);
check(!thumbs().recentTopics.includes(await topicValue(page)), "random dice topics are not remembered");
await page.click('#t-topic-recent .chip:has-text("chess openings")');
await until(async () => (await topicValue(page)) === "chess openings", "chip runs that search", 5000);
check(true, "recent search chip runs the search again");
await feedReady(page);

// recent channels
for (const c of ["@GothamChess", "@chessbrah"]) {
  await page.fill("#t-ch", c);
  await page.click("#t-ch-fetch");
  await until(async () => thumbs().recentChannels?.[0]?.url === c, `channel ${c} read`, 90000);
}
await until(() => page.isVisible('#t-ch-recent .chip:has-text("Gotham")'), "recent channel chip", 10000);
await page.click('#t-ch-recent .chip:has-text("Gotham")');
await until(async () => (await page.textContent("#t-ch-card b")).includes("Gotham"), "chip switches channel", 5000);
check((await page.inputValue("#t-ch")) === "@GothamChess", "recent channel chip switches back to it");

// Find similar = search by your title
check(await page.$eval("#t-similar", (b) => b.disabled), "Find similar off without a titled thumbnail");
await drop(page, "#t-drop", thumb);
await until(() => page.$(".th-item"), "thumbnail added", 10000);
await page.fill('.th-item [data-f="title"]', "Best chess opening for beginners");
check(!(await page.$eval("#t-similar", (b) => b.disabled)), "Find similar on with a title");
await page.click("#t-similar");
await until(async () => (await topicValue(page)) === "Best chess opening for beginners", "similar search", 5000);
await feedReady(page);
check(true, "Find similar searches YouTube with your title");

// real dates arrive in the background
await until(async () => { const t = thumbs(); return t.videos.filter((x) => t.dates?.[x.id] > 0).length >= 8; }, "real upload dates for the current feed", 240000);
const t = thumbs();
const v = t.videos.find((x) => t.dates[x.id] > 0);
check(!!v, `real date for "${v.title.slice(0, 40)}": ${new Date(t.dates[v.id]).toISOString().slice(0, 10)}`);
const metas = await page.$$eval(".yt-card:not(.mine) .yt-meta", (m) => m.map((x) => x.textContent));
check(metas.some((m) => /ago$/.test(m)), "cards show the upload age");

// outliers
await page.click('[data-check="outliers"]');
await until(async () => (await page.$$(".yt-card .yt-score")).length >= 3, "outlier scores (needs channel subscribers)", 300000);
const scores = await page.$$eval(".yt-score", (s) => s.map((x) => x.textContent));
check(scores.every((x) => /^×[\d.]+$/.test(x)), `scores shown: ${scores.slice(0, 6).join(" ")}`);
check((await page.$$(".yt-card.dim")).length + (await page.$$(".yt-score.hot")).length >= 3, "outliers highlighted, the rest dimmed");
await page.screenshot({ path: join(OUT, "t18-outliers.png"), fullPage: true });

// restart: same feed, picks kept, no new random search
const topicBefore = await topicValue(page);
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await feedReady(page);
check((await topicValue(page)) === topicBefore, "last search kept after a restart");
check(await page.isVisible('#t-ch-recent .chip, #t-topic-recent .chip'), "quick picks kept after a restart");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T18 TEST PASSED");
