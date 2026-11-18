// T33 test: real pawchive (kemono mirror) post with a MediaFire link → post image + the MediaFire .rar with its real
// name (spaces, not "+"); files a kemono mirror hasn't imported yet are counted in the job note. Needs network.
// Usage: node scripts/t33-test.mjs
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const DATA = resolve("release/hermes-data");
const BIN = join(DATA, "bin");
const DEST = join(OUT, "t33");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function finished(invoke, title) {
  for (let i = 0; i < 600; i++) {
    const j = (await invoke("queue_get")).jobs.find((x) => x.module === "gallery" && (!title || x.title === title));
    if (j && ["done", "failed"].includes(j.state)) return j;
    await sleep(1000);
  }
  throw new Error("FAIL: job never finished");
}
rmSync(DEST, { recursive: true, force: true });
rmSync(join(DATA, "queue.json"), { force: true });
const s0 = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s0, lastModule: "gallery", anya: { on: false }, cookies: { ...s0.cookies, "pawchive.pw": "none" },
  gallery: { folder: DEST, eagle: false, filters: { limit: 50, skipDownloaded: false } } }));
const app = await launch(EXE);
const { page } = app;
const invoke = (c, a = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [c, a]);
await page.waitForSelector("#g-url");
await page.fill("#g-url", "https://pawchive.pw/patreon/user/5163822/post/175647534");
await page.click("#g-add");
const j = await finished(invoke);
check(j.state === "done" && /1 from MediaFire/.test(j.note), `pawchive post done: "${j.note}"`);
const rar = join(DEST, "MediaFire", "Peach Reindeer 0.rar");
check(existsSync(rar) && statSync(rar).size > 40e6, `MediaFire pack saved with its real name (${existsSync(rar) ? (statSync(rar).size / 1e6).toFixed(1) : 0} MB)`);
check(j.outputs.some((o) => o.endsWith(".jpg")), "the post image too");

// a mirror that hasn't imported a file yet: counted in the note, not an error
const FAKE = join(BIN, "fake-gdl.cmd");
writeFileSync(FAKE, ["@echo off", "echo [pawchive][warning] 54519579: Incomplete/Missing file import ('pending') 1>&2", "echo [pawchive][warning] 54519580: Incomplete/Missing file import ('pending') 1>&2", "exit /b 0", ""].join("\r\n"));
await invoke("queue_add", { jobs: [{ module: "gallery", title: "pending", steps: [{ type: "run", label: "Downloading", bin: "fake-gdl.cmd", parser: "galleryDl", duration: -10, args: [] }] }] });
const p = await finished(invoke, "pending");
check(p.state === "done" && p.note === "2 not on the site yet (try again later)", `note: "${p.note}"`);
rmSync(FAKE, { force: true });
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T33 TEST PASSED");
