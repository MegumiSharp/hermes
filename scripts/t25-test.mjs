// T25 test: faster Gallery Downloader. Filters as gallery-dl expressions (real gallery-dl, simulate), E-Hentai
// cookies (validation, mirrored to exhentai.org), then in the app: a 75-file gallery is previewed (first 60 +
// total), downloads in one pass with filters and a manual pick applied to every file, shows n / total,
// survives closing Hermes mid-download (resumes, no duplicates). Usage: node scripts/t25-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SITES, siteForUrl, validateCookies, withMirror } from "../src/cookies-validate.ts";
import { serveGallery } from "./gallery-fixture.mjs";
import { check, launch, OUT } from "./smoke.mjs";

execFileSync("node", ["scripts/gallery-filter-test.mjs"], { stdio: "inherit" });

// ---- E-Hentai cookies (pure) ----
const day = 86400;
const now = Math.floor(Date.now() / 1000);
const txt = ["# Netscape HTTP Cookie File", `.e-hentai.org\tTRUE\t/\tFALSE\t${now + 30 * day}\tipb_member_id\t123`, `.e-hentai.org\tTRUE\t/\tFALSE\t${now + 30 * day}\tipb_pass_hash\tabc`, `.e-hentai.org\tTRUE\t/\tFALSE\t0\tsk\tx`].join("\n");
check(siteForUrl("https://e-hentai.org/g/1/a/") === "exhentai" && siteForUrl("https://exhentai.org/g/1/a/") === "exhentai", "e-hentai.org and exhentai.org links use the E-Hentai cookies");
check(validateCookies(txt, SITES.exhentai).signedIn, "an E-Hentai cookies.txt with ipb_member_id + ipb_pass_hash is accepted");
const mirrored = withMirror(txt, SITES.exhentai).split("\n").filter((l) => l.startsWith(".exhentai.org"));
check(mirrored.length === 3 && mirrored.every((l) => l.split("\t").length === 7), "its rows are copied to .exhentai.org (same account)");
check(withMirror(txt, SITES.pixiv) === txt, "other sites' files are stored as given");

// ---- the app ----
const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const W = join(OUT, "t25");
const DEST = join(W, "out");
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
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const galleryJob = async (page) => (await invoke(page, "queue_get")).jobs.filter((j) => j.module === "gallery").at(-1);
const pngs = () => { const out = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".png") && out.push(e.name); }; try { walk(DEST); } catch {} return out; };

rmSync(W, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const gallery = await serveGallery(join(W, "src"), join(BIN, "ffmpeg.exe"), 70); // 5 + 70 = 75 files
for (const f of ["queue.json", "gallery-archive.sqlite3"]) rmSync(join(DATA, f), { force: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ lastModule: "gallery", autoUpdateYtdlp: false, anya: { on: false },
  gallery: { folder: DEST, eagle: false, previews: true, filters: { limit: 200, titleNot: "frame-07", extOff: ["jpg"] } } }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#g-url");
await page.fill("#g-url", gallery.url);
const t0 = Date.now();
await page.click("#g-fetch");
await until(async () => /selected/.test(await page.textContent("#g-summary")), "preview read");
const summary = await page.textContent("#g-summary");
check(/preview of the first 60 of 75/.test(summary), `only a preview is read, with the total: "${summary}"`);
check((await page.$$("#g-grid .tile")).length <= 60, `preview tiles: ${(await page.$$("#g-grid .tile")).length}`);
await page.click('#g-grid .tile[data-key="frame-01.png"]'); // manual pick: skip this one
check((await page.$$("#g-grid .tile.off")).length === 1, "a file turned off in the preview");
await page.click("#g-add");
const queued = await until(() => galleryJob(page), "job queued");
check(/up to 75 files/.test(queued.title), `job title: "${queued.title}"`);
console.log(`(read ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// close Hermes mid-download, reopen: it resumes and finishes without duplicates
await until(async () => pngs().length >= 8, "download started", 120000);
const before = pngs().length;
await until(async () => / \/ 75 /.test((await galleryJob(page)).detail ?? ""), "progress shows n / 75", 20000);
check(true, `progress n / 75 while downloading (${(await galleryJob(page)).detail})`);
await page.click("#wc-close").catch(() => {});
await sleep(2000);
check(pngs().length < 72, `closed mid-download (${before}+ of 72 on disk)`);
app = await launch(EXE);
page = app.page;
const done = await until(async () => { const j = await galleryJob(page); return j && ["done", "failed"].includes(j.state) ? j : null; }, "download finished after restart", 300000);
check(done.state === "done", `job done after restart${done.error ? ": " + done.error : ""}`);
const got = pngs();
const want = 75 - 2 /* jpgs */ - 1 /* frame-07 */ - 1 /* frame-01 */;
check(got.length === want && new Set(got).size === got.length, `downloaded ${got.length} files, expected ${want}, no duplicates`);
check(!got.includes("frame-01.png") && !got.includes("frame-07.png") && got.includes("frame-70.png"), "manual pick and title filter applied beyond the preview (frame-70 is past the first 60)");
// browser cookies that can't be decrypted (Edge/Chrome DPAPI on this PC): Hermes says so instead of going on silently
await app.close();
const s2 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s2, cookies: { ...s2.cookies, exhentai: "edge" }, gallery: { ...s2.gallery, filters: { ...s2.gallery.filters, limit: 200 } } })); // full 60-file preview: minutes on e-hentai
app = await launch(EXE);
page = app.page;
await page.waitForSelector("#g-url");
await page.fill("#g-url", "https://e-hentai.org/g/3316769/e41fd7e0fc/");
const tc = Date.now();
await page.click("#g-fetch");
await until(() => page.$(".modal .cookies"), "cookie window after the cookie warning", 30000);
check(!/selected/.test(await page.textContent("#g-summary")), `the cookie window opens while the preview is still being read (${((Date.now() - tc) / 1000).toFixed(1)} s)`);
check(/could not read your browser/i.test(await page.textContent(".modal")), `the cookie window says why: ${(await page.textContent(".modal .banner")).trim().slice(0, 140)}`);
await page.keyboard.press("Escape");
await until(async () => /unavailable/i.test(await page.textContent("#g-cookies")), "chip says cookies unavailable");
check(true, `chip: "${await page.textContent("#g-cookies")}"`);
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
gallery.close();
console.log("T25 TEST PASSED");
