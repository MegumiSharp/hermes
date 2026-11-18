// T32 test: Twitch tool. Pure link/time helpers under node, then in the app: installing twitch-dlp + Node.js after
// asking, Check reads a real VOD (title, qualities), From/To validation, a 1-minute part at 360p downloads as a
// Premiere-ready MP4 (H.264 + AAC) of about that length, fields survive a restart. Needs network.
// Usage: node scripts/t32-test.mjs   (KEEP=1 keeps the installed twitch-dlp instead of reinstalling it)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTime, sectionArg, sectionTag, twitchKind } from "../src/modules/twitch-core.ts";
import { check, launch, OUT } from "./smoke.mjs";

// ---- pure ----
check(twitchKind("https://www.twitch.tv/videos/2932469290") === "vod" && twitchKind("twitch.tv/zackrawrr") === "channel"
  && twitchKind("https://www.twitch.tv/zackrawrr/clip/Funny-Clip-abc_123") === "clip" && twitchKind("https://clips.twitch.tv/SomeSlug") === "clip"
  && twitchKind("https://twitchtracker.com/xqc/streams/51582913581") === "tracker" && twitchKind("https://www.twitch.tv/directory") === null
  && twitchKind("https://youtube.com/watch?v=x") === null && twitchKind("nope nope") === null, "link kinds: VOD, channel, clip, hidden VOD tracker, others refused");
check(parseTime("1:25:00") === 5100 && parseTime("85:00") === 5100 && parseTime("5100") === 5100 && parseTime("") === undefined && parseTime("1h25") === null, "times: h:mm:ss, mm:ss, seconds, empty, invalid");
check(sectionArg(600, 660) === "*0:10:00-0:11:00" && sectionArg(undefined, 60) === "*0:00:00-0:01:00" && sectionArg(5100) === "*1:25:00-inf", "--download-sections value");
check(sectionTag(600, 660) === " (0h10m00-0h11m00)" && sectionTag() === "", "file name tag for a part");

// ---- the app ----
const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t32");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
if (!process.env.KEEP) rmSync(join(BIN, "twitch"), { recursive: true, force: true });
rmSync(join(DATA, "queue.json"), { force: true });
const vod = execFileSync(join(BIN, "yt-dlp.exe"), ["--flat-playlist", "-I", "2", "--print", "url", "https://www.twitch.tv/zackrawrr/videos?filter=archives&sort=time"]).toString().trim();
check(/videos\/\d+/.test(vod), `test VOD: ${vod}`);
const s0 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "twitch", anya: { on: false }, twitch: { url: "", folder: W, quality: "best", from: "", to: "", unmute: "quality", wait: true } }));
let app = await launch(EXE);
let { page } = app;
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
await page.waitForSelector("#tw-url");
// metadata comes from the public GraphQL API (reads subscriber-only VODs too, which yt-dlp can't)
const meta = await invoke("twitch_meta", { url: vod });
check(meta.kind === "vod" && meta.title && meta.duration > 0 && meta.downloadable, `twitch_meta reads a VOD: "${meta.title?.slice(0, 40)}" (${meta.duration}s, downloadable ${meta.downloadable}, subOnly ${meta.subOnly})`);
const chMeta = await invoke("twitch_meta", { url: "https://www.twitch.tv/zackrawrr" });
check(chMeta.kind === "channel" && typeof chMeta.live === "boolean", "twitch_meta reads a channel (live state)");
check(await page.isDisabled("#tw-add"), "Download disabled without a Twitch link");
await page.fill("#tw-url", "https://www.youtube.com/watch?v=x");
check(await page.isDisabled("#tw-add"), "a YouTube link is refused");
await page.fill("#tw-url", "https://www.twitch.tv/zackrawrr");
check(await page.isVisible("#tw-wait-box"), "a channel link offers to wait for the live");
await page.fill("#tw-url", vod);
check(!(await page.isVisible("#tw-wait-box")), "a VOD link hides it");
await page.fill("#tw-from", "10:00");
await page.fill("#tw-to", "9:00");
check(await page.isDisabled("#tw-add") && /To must be after From/.test(await page.textContent("#tw-range")), "To before From is refused with a reason");
await page.fill("#tw-to", "11:00");
check(!(await page.isDisabled("#tw-add")) && /Only 0:10:00 to 0:11:00 \(0:01:00\)/.test(await page.textContent("#tw-range")), `range: "${await page.textContent("#tw-range")}"`);

// first download: asks, installs, reads the link (title, qualities), then queues
await page.selectOption("#tw-quality", "360p");
await page.click("#tw-add");
if (!process.env.KEEP) {
  await page.waitForSelector(".modal");
  check(/Node\.js/.test(await page.textContent(".modal")), "asks before installing twitch-dlp + Node.js");
  await page.click('.modal button:has-text("Install")');
}
const st = await until(async () => { const s = await invoke("twitch_status"); return s.installed ? s : null; }, "twitch-dlp installed", 300000);
check(existsSync(st.node) && existsSync(st.script) && /^\d/.test(st.version), `installed twitch-dlp ${st.version} with node.exe`);
await until(() => page.$("#tw-preview:not([hidden]) .t"), "preview", 60000);
const opts = await page.$$eval("#tw-quality option", (o) => o.map((x) => x.value));
check(opts.includes("360p") && opts[0] === "best" && (await page.inputValue("#tw-quality")) === "360p", `qualities from twitch-dlp, 360p kept: ${opts.join(", ")}`);
const title = (await page.textContent("#tw-preview .t")).trim();
const job = await until(async () => { const j = (await invoke("queue_get")).jobs.find((x) => x.module === "twitch"); return j && ["done", "failed"].includes(j.state) ? j : null; }, "download", 300000);
check(job.state === "done", `job done ${job.error ?? ""}`);
const out = job.outputs[0];
check(existsSync(out) && / \(0h10m00-0h11m00\)\.mp4$/.test(out) && !/videos \d/.test(out) && out.includes(title.replace(/[\\/:*?"<>|%]/g, "_").replace(/\s+/g, " ").trim().slice(0, 30)), `saved with the VOD title: ${out}`);
const probe = JSON.parse(execFileSync(join(BIN, "ffprobe.exe"), ["-v", "error", "-show_entries", "stream=codec_name,height:format=duration", "-of", "json", out]).toString());
const dur = Number(probe.format.duration);
check(dur > 50 && dur < 90, `about one minute long (${dur.toFixed(1)} s, cut at fragments)`);
check(probe.streams.some((s) => s.codec_name === "h264" && s.height === 360) && probe.streams.some((s) => s.codec_name === "aac"), "H.264 360p + AAC: Premiere-ready");
await page.screenshot({ path: join(OUT, "t32-twitch.png") });
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);

// fields survive a restart
await page.click("#wc-close").catch(() => {});
await sleep(1500);
app = await launch(EXE);
page = app.page;
await page.waitForSelector("#tw-url");
check((await page.inputValue("#tw-url")) === vod && (await page.inputValue("#tw-from")) === "10:00" && (await page.inputValue("#tw-to")) === "11:00" && (await page.inputValue("#tw-quality")) === "360p", "URL, From, To and quality remembered");
await app.close();
console.log("T32 TEST PASSED");
