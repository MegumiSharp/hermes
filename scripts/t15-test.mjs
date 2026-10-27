// T15 test: Spotify official sources (a song spotDL matches to an osu! upload), live feedback while
// reading a link, gradual progress bar. Needs network. Usage: node scripts/t15-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const W = join(OUT, "t15");
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
/** Waits for the next top-level spotify job; returns it with every progress value seen while running. */
async function watchJob(page, seen, ms = 600000) {
  const id = await until(async () => (await jobs(page)).find((j) => j.module === "spotify" && !j.parent && !seen.has(j.id))?.id, "spotify job queued", 30000);
  seen.add(id);
  const progress = new Set();
  const j = await until(async () => {
    const x = (await jobs(page)).find((y) => y.id === id);
    if (x.state === "running") progress.add(Math.round(x.progress * 100));
    return ["done", "failed"].includes(x.state) ? x : null;
  }, "spotify job", ms);
  return { j, progress };
}
const BIRDBRAIN = "https://open.spotify.com/track/2DAZakhs7RRCoM6pvLpUEz"; // spotDL picks an osu! upload for it

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
const S = join(W, "spotify");
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "spotify", autoUpdateYtdlp: false, cookies: { youtube: "none" }, spotify: { folder: S, format: "opus" } }));
execFileSync("node", ["scripts/spotify-match-test.mjs"], { stdio: "inherit" });

const app = await launch(EXE);
const { page } = app;
const seen = new Set();
await page.waitForSelector("#s-url");

if (only("source")) {
  await page.fill("#s-url", BIRDBRAIN);
  await page.click("#s-fetch");
  await until(() => page.isVisible(".live"), "live feedback while reading", 5000);
  check((await page.textContent(".live .live-t")).length > 0, `says what it is doing: "${await page.textContent(".live .live-t")}"`);
  await until(async () => /\d+ s/.test(await page.textContent(".live .live-time")), "elapsed time shown", 5000);
  await page.click(".live-more");
  await until(async () => (await page.textContent(".live-log")).length > 0, "Details shows the tool's output", 60000);
  await page.screenshot({ path: join(OUT, "t15-reading.png") });
  await until(async () => (await page.textContent("#s-list").catch(() => "")).includes("BIRDBRAIN"), "song listed before the check ends", 120000);
  await until(() => page.$eval("#s-add", (b) => !b.disabled), "sources checked", 300000);
  check(!(await page.isVisible(".live")), "feedback gone when done");
  const song = settingsFile().spotify.songs[0];
  check(["ok", "fixed"].includes(song.src?.status), `reliable source found (${song.src?.status}: "${song.src?.title}" by ${song.src?.channel})`);
  check(!/osu|Yinchiko|VinCent/i.test(`${song.src.title} ${song.src.channel}`), "not a fan / osu! upload");
  check(/Jamie Paige/i.test(song.src.channel), "official artist source");
  await page.screenshot({ path: join(OUT, "t15-checked.png") });
  await page.click("#s-add");
  const { j, progress } = await watchJob(page, seen);
  check(j.state === "done", `download done${j.error ? ": " + j.error : ""}`);
  check([...progress].some((p) => p > 0 && p < 100), `progress moves before the song is finished (${[...progress].join(", ")}%)`);
  const log = await invoke(page, "queue_log", { id: j.id });
  check(!log.some((l) => l.includes("Searching for song")), "spotDL used the checked source (no search of its own)");
  check(readdirSync(S).some((f) => /BIRDBRAIN.*\.opus$/i.test(f)), `saved as Opus: ${readdirSync(S).join(", ")}`);
}

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T15 TEST PASSED");
