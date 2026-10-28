// T16 test: Video Downloader audio. MP3 with square cover + official lyrics (subtitles uploaded by the
// channel) embedded, WAV 48 kHz for editing with the "Montaggio" pill, choices remembered. Needs network.
// Usage: node scripts/t16-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t16");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
const probe = (f, ...a) => JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", ...a, "-of", "json", f]).toString());
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
const seen = new Set();
async function nextJob(page) {
  const id = await until(async () => (await jobs(page)).find((j) => j.module === "video" && !seen.has(j.id))?.id, "job queued", 30000);
  seen.add(id);
  return until(async () => { const j = (await jobs(page)).find((x) => x.id === id); return ["done", "failed"].includes(j.state) ? j : null; }, "job", 300000);
}
const RICK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // has official English subtitles

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "video", autoUpdateYtdlp: false, cookies: { youtube: "none" }, video: { folder: W, eagle: false, format: "best" } }));

let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#v-url");
check(await page.$eval("#v-audio", (e) => e.hidden), "audio options hidden for video formats");
await page.click("#v-format");
await page.click('[data-format="mp3"]');
check(!(await page.$eval("#v-audio", (e) => e.hidden)), "audio options shown for Audio only");
check(await page.$eval("#v-premiere-box", (e) => e.hidden), "Premiere conversion hidden for audio");
await page.fill("#v-url", RICK);
await page.click("#v-fetch");
await until(async () => (await page.textContent("#v-container")).includes("lyrics (en"), "lyrics language announced", 60000);
check(true, `notice: "${await page.textContent("#v-container")}"`);
await page.screenshot({ path: join(OUT, "t16-audio.png") });

// MP3 with cover + lyrics
await page.click("#v-add");
const mp3Job = await nextJob(page);
check(mp3Job.state === "done", `MP3 job done${mp3Job.error ? ": " + mp3Job.error : ""}`);
check(mp3Job.note === "Lyrics: en", `job note says lyrics were added ("${mp3Job.note}")`);
const mp3 = readdirSync(W).find((f) => f.endsWith(".mp3"));
check(!!mp3, `MP3 saved: ${mp3}`);
const tags = probe(join(W, mp3), "-show_entries", "format_tags").format.tags;
const lyrics = Object.entries(tags).find(([k]) => k.toLowerCase().startsWith("lyrics"))?.[1] ?? "";
check(/strangers to love/i.test(lyrics), "official lyrics embedded");
check(lyrics.includes("\n") && !/-->|♪|\[/.test(lyrics), "lyrics are clean lines (no times, notes or [cues])");
check(!!tags.title && !!tags.artist, `tags kept with the lyrics (${tags.artist} - ${tags.title})`);
const cover = probe(join(W, mp3), "-select_streams", "v", "-show_entries", "stream=width,height").streams[0];
check(cover && cover.width === cover.height, `square cover embedded (${cover?.width}×${cover?.height})`);
check(!readdirSync(W).some((f) => /\.(srt|vtt)$/.test(f)), "subtitle files cleaned up");

// WAV for editing
await page.click("#v-wav-box");
check(await page.$eval("#v-cover-box", (e) => e.hidden) && await page.$eval("#v-lyrics-box", (e) => e.hidden), "cover/lyrics hidden for WAV");
check((await page.textContent("#v-container")).includes("WAV"), "notice says WAV");
await page.fill("#v-url", RICK);
await page.click("#v-fetch");
await until(() => page.$eval("#v-add", (b) => !b.disabled), "preview again", 60000);
await page.click("#v-add");
const wavJob = await nextJob(page);
check(wavJob.state === "done", `WAV job done${wavJob.error ? ": " + wavJob.error : ""}`);
check(wavJob.pill === "WAV · Montaggio", `pill "${wavJob.pill}"`);
const wav = readdirSync(W).find((f) => f.endsWith(".wav"));
const st = probe(join(W, wav), "-show_entries", "stream=codec_name,sample_rate").streams[0];
check(st.codec_name.startsWith("pcm") && st.sample_rate === "48000", `WAV 48 kHz PCM (${st.codec_name}, ${st.sample_rate})`);
await page.screenshot({ path: join(OUT, "t16-queue.png") });

// remembered after a restart
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector("#v-url");
const saved = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).video;
check(saved.format === "mp3" && saved.wav === true && saved.cover === true && saved.lyrics === true, "audio choices saved");
check(await page.$eval("#v-wav", (b) => b.checked), "WAV still ticked after restart");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T16 TEST PASSED");
