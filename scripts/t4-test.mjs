// T4 feature test: Video Downloader. Needs network (YouTube) and Eagle running.
// Usage: node scripts/t4-test.mjs   (uses release/Hermes.exe; keeps hermes-data/bin, resets the rest)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateCookies, SITES } from "../src/cookies-validate.ts";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const DL = join(OUT, "t4");
const EAGLE = "http://localhost:41595/api";
const VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo", 19 s
const PLAYLIST = "https://www.youtube.com/playlist?list=PL63F0C78739B09958"; // public, ~47 songs: only the first is downloaded
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
  }
}
const probe = (file) => JSON.parse(execFileSync(join(DATA, "bin", "ffprobe.exe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());

// ---------- cookie validation (pure) ----------
const yt = SITES.youtube;
const row = (d, name, exp) => [d, "TRUE", "/", "TRUE", String(exp), name, "x"].join("\t");
const future = Math.floor(Date.now() / 1000) + 86400 * 90;
const good = ["# Netscape HTTP Cookie File", row(".youtube.com", "PREF", future), "#HttpOnly_" + row(".youtube.com", "LOGIN_INFO", future), row(".youtube.com", "SAPISID", future)].join("\n");
check(validateCookies(good, yt).ok && validateCookies(good, yt).count === 3, "valid cookies.txt accepted (HttpOnly rows counted)");
check(validateCookies("hello world", yt).error?.includes("Netscape"), "non-Netscape file rejected");
check(validateCookies(row(".google.com", "SID", future), yt).error?.includes("no cookies for youtube.com"), "wrong domain rejected");
check(validateCookies(row(".youtube.com", "PREF", future), yt).error?.includes("No login cookies"), "signed-out export rejected");
check(validateCookies(row(".youtube.com", "SAPISID", 1000), yt).error?.includes("expired"), "expired login rejected");

// ---------- app ----------
for (const f of ["queue.json", "settings.json", "cookies"]) rmSync(join(DATA, f), { recursive: true, force: true });
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({
  lastModule: "video", autoUpdateYtdlp: false, cookies: { youtube: "none" }, video: { format: "best", folder: DL, eagle: false },
}));
const app = await launch(EXE);
const { page } = app;
await page.waitForSelector("#v-url");
check((await page.textContent("#v-folder .v")) === DL, "folder from settings shown");
await until(async () => /yt-dlp \d/.test(await page.textContent("#v-ytdlp")), "yt-dlp version chip");
check((await page.textContent("#v-cookies")).includes("No cookies"), "cookie chip shows source");

// cookies modal: invalid then valid file, then back to none
await page.click("#v-cookies");
await page.waitForSelector(".modal .drop");
await page.setInputFiles(".drop input", { name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("nope") });
await until(() => page.$(".ck-result.bad"), "invalid cookies message");
check(true, "modal rejects an invalid cookies.txt");
await page.click(".m-foot .btn.primary"); // Save with "none" still selected closes
await page.click("#v-cookies");
await page.setInputFiles(".drop input", { name: "cookies.txt", mimeType: "text/plain", buffer: Buffer.from(good) });
await until(() => page.$(".ck-result.ok"), "valid cookies message");
check((await page.$eval("#ck-mode", (s) => s.value)) === "file", "valid file switches source to cookies.txt");
await page.click(".m-foot .btn.primary");
await until(async () => (await page.textContent("#v-cookies")).includes("cookies.txt"), "chip shows cookies.txt");
check(existsSync(join(DATA, "cookies", "youtube.txt")), "cookies saved in hermes-data/cookies");
await page.click("#v-cookies");
await page.selectOption("#ck-mode", "none");
await page.click(".m-foot .btn.primary");
await until(async () => (await page.textContent("#v-cookies")).includes("No cookies"), "back to no cookies");

// format menu
await page.click("#v-format");
const opts = await page.$$eval(".menu .mi", (m) => m.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
check(opts.length === 5 && opts[0].startsWith("Best quality") && opts[4].includes("MP3"), `menu: ${opts.join(" | ")}`);
await page.screenshot({ path: join(OUT, "t4-menu.png") });
await page.click('[data-format="mp3"]');
check((await page.textContent("#v-format")).includes("Audio only"), "selecting a format updates the button");
check(await page.isHidden(".menu"), "menu closes after choosing");

// probe via paste
await page.fill("#v-url", VIDEO);
await page.dispatchEvent("#v-url", "paste");
await until(async () => (await page.textContent("#v-preview .t").catch(() => "")) === "Me at the zoo", "preview title", 60000);
check((await page.textContent("#v-preview .dur")) === "0:19", "duration shown");
check(!(await page.$eval("#v-add", (b) => b.disabled)), "Add to queue enabled after fetch");
await page.screenshot({ path: join(OUT, "t4-preview.png") });

// format: null keeps the current one; premiere: convert to H.264 + AAC MP4
async function addAndWait(format, label, premiere = false) {
  // after "Add to queue" the old preview is only hidden: fetch again unless it is visible
  if (!(await page.isVisible("#v-preview .t"))) {
    await page.fill("#v-url", VIDEO);
    await page.click("#v-fetch");
    await until(() => page.isVisible("#v-preview .t"), "preview", 60000);
  }
  if (format) {
    await page.click("#v-format");
    await page.click(`[data-format="${format}"]`);
  }
  if (format !== "mp3") await page.$eval("#v-premiere", (c, on) => { if (c.checked !== on) c.click(); }, premiere);
  const before = (await jobs(page)).length;
  await page.click("#v-add");
  await until(async () => (await jobs(page)).length > before, `${label} queued`);
  const j = (await jobs(page)).at(-1);
  await until(async () => ["done", "failed"].includes((await jobs(page)).find((x) => x.id === j.id).state), `${label} finished`, 240000);
  const done = (await jobs(page)).find((x) => x.id === j.id);
  check(done.state === "done", `${label} done${done.error ? ": " + done.error : ""}`);
  return done;
}

let j = await addAndWait(null, "MP3");
check(j.outputs[0].endsWith(".mp3") && existsSync(j.outputs[0]), `mp3 written: ${j.outputs[0]}`);
let p = probe(j.outputs[0]);
check(p.streams.some((s) => s.codec_name === "mp3") && Number(p.format.bit_rate) > 300000, `mp3 at ~320 kbps (${p.format.bit_rate})`);
check(p.streams.some((s) => s.disposition?.attached_pic), "cover art embedded");
check(p.format.tags?.title === "Me at the zoo", "title metadata embedded");
check((await page.inputValue("#v-url")) === "" &&(await page.isHidden("#v-preview")), "form resets after adding");

j = await addAndWait("best", "Best quality");
check(existsSync(j.outputs[0]), `best quality file: ${j.outputs[0]}`);

j = await addAndWait("best", "MP4 converted", true);
check(j.outputs.length === 1 && j.outputs[0].endsWith(".mp4"), `converted output only: ${j.outputs.join(", ")}`);
p = probe(j.outputs[0]);
check(p.streams.find((s) => s.codec_type === "video")?.codec_name === "h264", "video is H.264");
check(p.streams.find((s) => s.codec_type === "audio")?.codec_name === "aac", "audio is AAC");
check(!readdirSync(DL).some((f) => f.endsWith(".mkv")), "intermediate mkv deleted");

// Eagle
await page.click("#v-eagle + .box");
check(await page.$eval("#v-eagle", (c) => c.checked), "Send to Eagle ticked");
await until(async () => (await page.textContent("#v-eagle-state")).includes("Eagle connected"), "Eagle chip");
j = await addAndWait("best", "MP4 to Eagle", true);
check(j.inEagle && !existsSync(j.outputs[0]), "imported into Eagle and removed from folder");
const items = await until(async () => {
  const d = (await (await fetch(`${EAGLE}/item/list?keyword=${encodeURIComponent("Me at the zoo")}&limit=10`)).json()).data;
  return d.filter((i) => i.url === VIDEO).length ? d.filter((i) => i.url === VIDEO) : null;
}, "Eagle item", 20000);
check(items[0].tags.includes("jawed") && items[0].tags.includes(VIDEO), `Eagle tags: ${items[0].tags.join(", ")}`);
await fetch(`${EAGLE}/item/moveToTrash`, { method: "POST", body: JSON.stringify({ itemIds: items.map((i) => i.id) }) });
await page.click("#v-eagle + .box");

// playlist -> group
await page.click("#v-format");
await page.click('[data-format="mp3"]');
await page.fill("#v-url", PLAYLIST);
await page.click("#v-fetch");
await until(async () => (await page.textContent("#v-preview .c").catch(() => "")).startsWith("Playlist"), "playlist preview", 60000);
await page.click("#v-add");
const group = await until(async () => (await jobs(page)).find((x) => x.group), "group job");
const kids = (await jobs(page)).filter((x) => x.parent === group.id);
check(kids.length > 10, `playlist: one queue item per video (${kids.length})`);
const first = await until(async () => {
  const k = (await jobs(page)).find((x) => x.id === kids[0].id);
  return ["done", "failed"].includes(k.state) ? k : null;
}, "first playlist item finished", 240000);
check(first.state === "done", `first playlist item done${first.error ? ": " + first.error : ""}`);
await invoke(page, "queue_action", { id: group.id, action: "remove" });

// errors
await page.fill("#v-url", "https://www.youtube.com/watch?v=xxxxxxxxxxx");
await page.click("#v-fetch");
await until(() => page.$("#v-preview.error"), "error preview", 60000);
check((await page.textContent("#v-preview .c")).length > 5, `error shown: ${await page.textContent("#v-preview .c")}`);
await page.screenshot({ path: join(OUT, "t4-final.png") });

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T4 TEST PASSED");
