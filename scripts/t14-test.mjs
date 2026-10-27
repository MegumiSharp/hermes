// T14 test: sidebar busy/done/failed dots, startup verify cache, logs out of queue snapshots,
// cached thumbnails, Background Removal gentle mode, AI models check, Thumbnail Tester
// (feed from a YouTube search, your thumbnails, every device, size view, channel fetch, restart).
// Needs network. Usage: node scripts/t14-test.mjs   (ONLY=dots,perf,rembg,models,thumbs)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t14");
const only = (s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const jobs = async (page) => (await invoke(page, "queue_get")).jobs;
const ffmpeg = (...a) => execFileSync(join(BIN, "ffmpeg.exe"), ["-v", "error", "-y", ...a]);
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`FAIL: timed out waiting for ${what}`);
    await sleep(300);
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
const dot = (page, id) => page.$eval(`.nav[data-id="${id}"] .nav-dot`, (d) => d.className);
const open = (page, id) => page.click(`.nav[data-id="${id}"]`);

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
rmSync(join(DATA, "queue.json"), { force: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({
  lastModule: "thumbs", autoUpdateYtdlp: false, cookies: { youtube: "none" },
  rembg: { folder: join(W, "rembg"), eagle: false, model: "isnet-general-use" },
}));
const thumb = join(W, "my-thumb.png");
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1", thumb);
const small = join(W, "small.jpg");
ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", small);

const t0 = Date.now();
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector(".th-stage");

// ================= performance plumbing =================
if (only("perf")) {
  const verified = join(BIN, "verified.json");
  await invoke(page, "binaries_init"); // waits for the startup check (same lock), which writes the cache tool by tool
  check(Object.keys(JSON.parse(readFileSync(verified, "utf8"))).length >= 3, "startup verification is cached per tool");
  const s0 = Date.now();
  const st = await invoke(page, "binaries_init");
  check(st.every((s) => s.ok), "all tools working");
  check(Date.now() - s0 < 3000, `cached binaries_init is fast (${Date.now() - s0} ms, first launch ${Date.now() - t0} ms incl. startup)`);
  const t = await invoke(page, "thumbnail", { path: thumb });
  check(existsSync(t) && t.includes("thumbs"), "thumbnail command writes a cached preview");
  check((await invoke(page, "thumbnail", { path: thumb })) === t, "thumbnail is reused from the cache");
}

// ================= sidebar dots =================
if (only("dots")) {
  check((await page.$$(".nav[data-section] .nav-dot, .nav .nav-dot")).length >= 8, "every tool has a sidebar dot");
  const [slow] = await invoke(page, "queue_add", { jobs: [{ module: "converter", title: "slow job", steps: [{ type: "run", label: "Working", bin: "ffmpeg.exe", parser: "ffmpeg", duration: 12,
    args: ["-re", "-f", "lavfi", "-i", "testsrc=duration=12", "-f", "null", "-"] }] }] });
  await until(async () => (await dot(page, "converter")).includes("working"), "converter dot pulses while working", 15000);
  check((await page.$eval('.nav[data-id="converter"] .nav-dot', (d) => getComputedStyle(d).animationName)) === "dot-pulse", "working dot is animated");
  check(!(await queueHasLog(page)), "queue snapshots carry no console logs");
  check((await invoke(page, "queue_log", { id: slow })).length > 0, "queue_log returns the console on demand");
  await until(async () => (await dot(page, "converter")).includes("done"), "converter dot turns done", 60000);
  await invoke(page, "queue_add", { jobs: [{ module: "upscale", title: "broken job", steps: [{ type: "run", label: "Working", bin: "ffmpeg.exe", parser: "ffmpeg",
    args: ["-i", "C:\\does-not-exist.mp4", join(W, "x.mp4")] }] }] });
  await until(async () => (await dot(page, "upscale")).includes("failed"), "upscale dot turns failed", 30000);
  await page.screenshot({ path: join(OUT, "t14-dots.png") });
  await open(page, "converter");
  check(!/working|done|failed/.test(await dot(page, "converter")), "opening the tool clears its done dot");
  check((await dot(page, "upscale")).includes("failed"), "other tools keep their dot");
  await invoke(page, "queue_clear_module", { module: "upscale" });
  await invoke(page, "queue_clear_module", { module: "converter" });
}
async function queueHasLog(page) {
  return (await jobs(page)).some((j) => "log" in j);
}

// ================= Background Removal gentle mode =================
if (only("rembg") && existsSync(join(DATA, "models", "rembg", "isnet-general-use.onnx"))) {
  await open(page, "rembg");
  await page.waitForSelector("#r-perf");
  await page.selectOption("#r-perf", "gentle");
  await drop(page, "#r-drop", thumb);
  await until(() => page.$(".tcard"), "image in the rembg tray");
  await page.click("#r-go");
  const j = await until(async () => (await jobs(page)).find((x) => x.module === "rembg" && ["done", "failed"].includes(x.state)), "rembg job", 300000);
  check(j.state === "done", `gentle rembg job done${j.error ? ": " + j.error : ""}`);
  check(/gentle/i.test(j.note ?? ""), `gentle mode runs on CPU gently (note: ${j.note})`);
  check(JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).rembg.gentle === true, "performance choice remembered");
}

// ================= AI models check =================
if (only("models")) {
  const list = await invoke(page, "models_status");
  check(Array.isArray(list), `models_status answers (${list.length} entries)`);
  for (const m of list) check(m.kind && m.name && "outdated" in m, `model row ${m.name}: ${m.installed} / ${m.latest}${m.note ? " · " + m.note : ""}`);
  await open(page, "binaries");
  await page.click("#ai-check");
  await until(async () => !(await page.$eval("#ai-check", (b) => b.disabled)), "AI models check finishes", 90000);
  check((await page.$$("#ai-rows [data-model]")).length === list.length || list.length === 0, "Binaries page lists the AI models");
  await page.screenshot({ path: join(OUT, "t14-models.png"), fullPage: true });
}

// ================= Thumbnail Tester =================
if (only("thumbs")) {
  await open(page, "thumbs");
  await until(async () => (await page.$$(".yt-card")).length >= 8, "example videos from a random YouTube search", 90000);
  check((await page.$eval(".yt-card .yt-thumb img", (i) => i.src)).includes("ytimg.com"), "feed uses real YouTube thumbnails");
  check((await page.$eval("#t-topic", (i) => i.value)).length > 0, "random topic shown in the search field");
  await drop(page, "#t-drop", thumb);
  await until(() => page.$(".th-item"), "thumbnail added");
  await page.fill('.th-item [data-f="title"]', "I Tested Every Thumbnail Trick So You Don't Have To (Results Shocked Me)");
  await until(async () => (await page.$$(".yt-card.mine")).length === 1, "your video in the feed");
  check((await page.textContent(".yt-card.mine .yt-title")).startsWith("I Tested Every"), "your title in the feed");
  check((await page.textContent(".th-item .th-len")).includes("may be cut"), "long title warning");
  await drop(page, "#t-drop", small);
  await until(async () => (await page.$$(".th-item")).length === 2, "second thumbnail");
  await until(async () => (await page.$$eval(".th-item .th-warn", (w) => w.map((x) => x.textContent).join())).includes("1280"), "low resolution warning");
  await until(async () => (await page.$$eval(".th-item .th-warn", (w) => w.map((x) => x.textContent).join())).includes("16:9"), "aspect ratio warning");
  await page.click(".th-item:nth-child(2) [data-toggle]");
  await until(async () => (await page.$$(".yt-card.mine")).length === 1, "hidden variant leaves the feed");

  await page.fill("#t-ch", "@GothamChess");
  await page.click("#t-ch-fetch");
  await until(async () => (await page.textContent("#t-ch-card b")) !== "Your channel", "channel name fetched", 60000);
  check((await page.$eval(".yt-card.mine .yt-av", (i) => i.src)).startsWith("https://"), "your channel avatar on your video");
  check((await page.textContent(".yt-card.mine .yt-ch")).includes("Gotham"), "your channel name on your video");

  for (const [d, sel] of [["home", ".yt-home .yt-card"], ["search", ".yt-search .yt-card .yt-desc"], ["sidebar", ".yt-sidebar .yt-card"], ["mobile", ".yt-phone .yt-mobile .yt-card"]]) {
    await page.click(`[data-device="${d}"]`);
    await page.waitForSelector(sel);
    check(!!(await page.$(".yt-card.mine")), `${d} layout renders with your video`);
    check(await page.$eval(".page.thumbs", (p) => p.parentElement.scrollWidth <= p.parentElement.clientWidth + 1 && p.scrollWidth <= p.clientWidth + 1), `${d} layout fits the window (no sideways scroll)`);
    await page.$eval("#t-stage", (s) => s.scrollIntoView());
    await sleep(800);
    await page.screenshot({ path: join(OUT, `t14-thumbs-${d}.png`), fullPage: true });
  }
  await page.click('[data-check="dark"]');
  check(await page.$eval("#t-stage", (s) => s.classList.contains("yt-light")), "light theme");
  await page.click('[data-check="gray"]');
  check((await page.$eval(".yt-card .yt-thumb img", (i) => getComputedStyle(i).filter)).includes("grayscale"), "B/W check");
  const before = await page.$$eval(".yt-card .yt-title", (t) => t.map((x) => x.textContent).join("|"));
  await page.click("#t-shuffle");
  check((await page.$$eval(".yt-card .yt-title", (t) => t.map((x) => x.textContent).join("|"))) !== before, "shuffle reorders the feed");
  await page.click('[data-mode="size"]');
  check((await page.$$(".th-size")).length === 5, "size view shows 5 YouTube sizes");
  check(await page.$eval("#t-device", (d) => d.hidden), "device switch hidden in size view");
  await page.screenshot({ path: join(OUT, "t14-thumbs-sizes.png"), fullPage: true });

  // restart: everything comes back
  await sleep(800);
  await app.page.click("#wc-close").catch(() => {});
  await sleep(1500);
  app = await launch(EXE);
  page = app.page;
  await page.waitForSelector(".th-stage");
  check((await page.$$(".th-item")).length === 2, "thumbnails survive a restart");
  check((await page.$eval('.th-item [data-f="title"]', (i) => i.value)).startsWith("I Tested"), "title survives a restart");
  const chUrl = await page.$eval("#t-ch", (i) => i.value);
  check(chUrl === "@GothamChess", `channel link survives a restart ("${chUrl}")`);
  check(await page.$eval('[data-mode="size"]', (b) => b.classList.contains("on")), "view mode survives a restart");
  await page.click('[data-mode="youtube"]');
  check((await page.$$(".yt-card")).length >= 8, "feed videos survive a restart (no new search)");
}

check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T14 TEST PASSED");
