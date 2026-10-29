// T25 test: Gallery Downloader without preview. Filters as gallery-dl expressions (real gallery-dl, simulate),
// cookies for any site (E-Hentai mirrored to exhentai.org, unknown hosts accepted), then in the app: Download
// goes straight to the queue, the first download from a site asks for cookies once, a 75-file gallery
// downloads with filters, shows "n files", survives closing Hermes mid-download (resumes, no duplicates).
// Usage: node scripts/t25-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cookieSite, SITES, siteForUrl, siteInfo, validateCookies, withMirror } from "../src/cookies-validate.ts";
import { serveGallery } from "./gallery-fixture.mjs";
import { check, launch, OUT } from "./smoke.mjs";

execFileSync("node", ["scripts/gallery-filter-test.mjs"], { stdio: "inherit" });

// ---- cookies (pure) ----
const day = 86400;
const now = Math.floor(Date.now() / 1000);
const txt = ["# Netscape HTTP Cookie File", `.e-hentai.org\tTRUE\t/\tFALSE\t${now + 30 * day}\tipb_member_id\t123`, `.e-hentai.org\tTRUE\t/\tFALSE\t${now + 30 * day}\tipb_pass_hash\tabc`, `.e-hentai.org\tTRUE\t/\tFALSE\t0\tsk\tx`].join("\n");
check(siteForUrl("https://e-hentai.org/g/1/a/") === "exhentai" && siteForUrl("https://exhentai.org/g/1/a/") === "exhentai", "e-hentai.org and exhentai.org links use the E-Hentai cookies");
check(validateCookies(txt, SITES.exhentai).signedIn, "an E-Hentai cookies.txt with ipb_member_id + ipb_pass_hash is accepted");
const mirrored = withMirror(txt, SITES.exhentai).split("\n").filter((l) => l.startsWith(".exhentai.org"));
check(mirrored.length === 3 && mirrored.every((l) => l.split("\t").length === 7), "its rows are copied to .exhentai.org (same account)");
check(withMirror(txt, SITES.pixiv) === txt, "other sites' files are stored as given");
check(cookieSite("https://www.kemono.su/user/1") === "kemono.su" && cookieSite("https://x.com/a") === "twitter" && cookieSite("nope") === "" && cookieSite("generic:http://127.0.0.1/a.html") === "127.0.0.1", "every site has a cookie key: known sites by name, others by host (also behind generic:)");
check(validateCookies(".kemono.su\tTRUE\t/\tFALSE\t0\tsession\tabc", siteInfo("kemono.su")).ok, "an unknown site's cookies.txt is accepted when it has cookies for that host");

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
const saved = () => JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));

rmSync(W, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const gallery = await serveGallery(join(W, "src"), join(BIN, "ffmpeg.exe"), 70); // 5 + 70 = 75 files
for (const f of ["queue.json", "gallery-archive.sqlite3"]) rmSync(join(DATA, f), { force: true });
const s0 = saved();
delete s0.cookies?.["127.0.0.1"];
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "gallery", autoUpdateYtdlp: false, anya: { on: false },
  gallery: { folder: DEST, eagle: false, filters: { limit: 200, titleNot: "frame-07", extOff: ["jpg"] } } }));
let app = await launch(EXE);
let { page } = app;
await page.waitForSelector("#g-url");
check(!(await page.$("#g-grid")) && !(await page.$("#g-fetch")), "no preview: just the URL and Download");
check((await page.inputValue("[data-ext]")) === "jpg", "Skip extensions shows the saved filter");
await page.fill("#g-url", gallery.url);
check(await page.isVisible("#g-cookies"), "the cookie chip shows for the typed site");
await page.click("#g-add");
await page.waitForSelector(".modal .cookies", { timeout: 5000 });
check(/First download from 127\.0\.0\.1/.test(await page.textContent(".modal")), "first download from a site: Hermes asks for its cookies");
await page.click('.modal .m-foot button:has-text("Cancel")');
await until(() => galleryJob(page), "job queued", 10000);
check(saved().cookies?.["127.0.0.1"] === "none", "asked once: Cancel is remembered as no cookies");

// close Hermes mid-download, reopen: it resumes and finishes without duplicates
await until(async () => pngs().length >= 8, "download started", 120000);
await until(async () => /· \d+ files ·/.test((await galleryJob(page)).detail ?? ""), "progress shows n files", 20000);
check(true, `progress without a known total: "${(await galleryJob(page)).detail}"`);
await page.click("#wc-close").catch(() => {});
await sleep(2000);
check(pngs().length < 72, `closed mid-download (${pngs().length} of 72 on disk)`);
app = await launch(EXE);
page = app.page;
const done = await until(async () => { const j = await galleryJob(page); return j && ["done", "failed"].includes(j.state) ? j : null; }, "download finished after restart", 300000);
check(done.state === "done", `job done after restart${done.error ? ": " + done.error : ""}`);
const got = pngs();
const want = 75 - 2 /* jpgs */ - 1 /* frame-07 */;
check(got.length === want && new Set(got).size === got.length, `downloaded ${got.length} files, expected ${want}, no duplicates`);
check(!got.includes("frame-07.png") && got.includes("frame-70.png"), "filters applied to every file");

// same site again: no question
await page.waitForSelector("#g-url");
await page.fill("#g-url", gallery.url.replace("index.html", "index.html?again"));
await page.click("#g-add");
check(!(await page.waitForSelector(".modal .cookies", { timeout: 2000 }).catch(() => null)), "a site already asked about is not asked again");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
gallery.close();
console.log("T25 TEST PASSED");
