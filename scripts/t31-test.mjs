// T31 test: Gallery "Archives" type (filter expression vs real gallery-dl) and MediaFire links in posts: the job
// saves each post's metadata, a MediaFire step downloads the links into <folder>\MediaFire after Eagle; the step
// downloads a real public MediaFire file (network). Usage: node scripts/t31-test.mjs
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { filterExpr } from "../src/modules/gallery-filter.ts";
import { serveGallery } from "./gallery-fixture.mjs";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t31");
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

// ---- Archives type: what gallery-dl would download (simulate, direct links) ----
const base = { types: { image: true, video: true, gif: true, archive: true }, extOff: [], minW: 0, minH: 0, sizeMin: 0, sizeMax: 0, dateFrom: "", dateTo: "", limit: 200, skipDownloaded: false, mediafire: true, titleHas: "", titleNot: "" };
const URLS = ["a.png", "b.zip", "c.rar", "d.mp4", "e.gif"].map((f) => `http://127.0.0.1/x/${f}`);
async function files(types) {
  const cfg = join(W, "cfg.json");
  writeFileSync(cfg, JSON.stringify({ extractor: { "image-filter": filterExpr({ ...base, types: { ...base.types, ...types } }) } }));
  const { stdout } = await promisify(execFile)(join(BIN, "gallery-dl.exe"), ["--config", cfg, "-s", ...URLS], { encoding: "utf8" });
  return stdout.split(/\r?\n/).map((l) => l.replace(/^# /, "").trim().split("_").pop()).filter(Boolean).sort().join(",");
}
check((await files({})) === "a.png,b.zip,c.rar,d.mp4,e.gif", "everything by default");
check((await files({ archive: false })) === "a.png,d.mp4,e.gif", "Archives off: no zip/rar");
check((await files({ image: false, video: false, gif: false })) === "b.zip,c.rar", "only Archives: just zip/rar (archives no longer count as images)");

// ---- the app ----
const DEST = join(W, "out");
mkdirSync(DEST, { recursive: true });
const gallery = await serveGallery(join(W, "src"), join(BIN, "ffmpeg.exe"));
rmSync(join(DATA, "queue.json"), { force: true });
const s0 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "gallery", autoUpdateYtdlp: false, anya: { on: false }, eagleEnabled: true,
  cookies: { ...s0.cookies, "127.0.0.1": "none" }, gallery: { folder: DEST, eagle: false, filters: { limit: 50, skipDownloaded: false } } }));
const app = await launch(EXE);
const { page } = app;
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
await page.waitForSelector("#g-url");
await page.click("#g-filters").catch(() => {});
await page.waitForSelector('[data-type="archive"]', { state: "attached" });
check(await page.isChecked('[data-type="archive"]') && await page.isChecked('[data-bool="mediafire"]'), "Archives and MediaFire links are on by default (old saved filters too)");
await page.fill("#g-url", gallery.url);
await page.click("#g-add");
const job = await until(async () => { const j = (await invoke("queue_get")).jobs.find((x) => x.module === "gallery"); return j && ["done", "failed"].includes(j.state) ? j : null; }, "gallery job", 120000);
check(job.state === "done", `gallery job done ${job.error ?? ""}`);
check(job.steps.at(-1).type === "mediafire", "the MediaFire step runs last (after Eagle)");
const posts = job.steps.at(-1).posts;
check(existsSync(posts) && /"category": "generic"/.test(readFileSync(posts, "utf8")), "gallery-dl saved the post metadata for the scan");
check(!job.note, "no MediaFire links in this gallery: nothing extra, no note");

// the step on a post with a real MediaFire link (+ a dead one)
const fake = join(W, "posts.jsonl");
writeFileSync(fake, JSON.stringify({ content: '<p>Pack <a href="https://www.mediafire.com/file/k60ooi301s4vkfo/subdomains.txt/file">here</a>, old: https://www.mediafire.com/file/zzzzzzzzzzzzzzz/gone.rar/file</p>' }) + "\n");
await invoke("queue_add", { jobs: [{ module: "gallery", title: "mediafire", steps: [{ type: "mediafire", posts: fake, folder: DEST }] }] });
const mf = await until(async () => { const j = (await invoke("queue_get")).jobs.find((x) => x.title === "mediafire"); return j && ["done", "failed"].includes(j.state) ? j : null; }, "MediaFire job", 120000);
const got = join(DEST, "MediaFire", "subdomains.txt");
check(mf.state === "done" && existsSync(got) && statSync(got).size === 564, `MediaFire file downloaded into MediaFire\\ (${mf.error || mf.note})`);
check(/1 from MediaFire · 1 MediaFire failed/.test(mf.note), `note: "${mf.note}"`);
check(mf.outputs.includes(got), "the file is a job output (Show in folder)");
await page.screenshot({ path: join(OUT, "t31-gallery.png") });
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
gallery.close();
console.log("T31 TEST PASSED");
