// T29 test: one Hermes at a time (a second launch focuses the open window and exits, so the queue never runs
// twice), and the update check survives GitHub's API limit for moved repos, "@" tags and pinned tags
// (live page fallback in net.rs). Usage: node scripts/t29-test.mjs
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { check, launch } from "./smoke.mjs";

const EXE = resolve("release/Hermes.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hermesCount = () => (execFileSync("tasklist", ["/FI", "IMAGENAME eq Hermes.exe", "/NH"]).toString().match(/Hermes\.exe/gi) ?? []).length;

const app = await launch(EXE);
const { page } = app;
await page.waitForSelector(".nav");
check(hermesCount() >= 1, "first Hermes running");
const before = hermesCount();
const second = spawn(EXE, [], { stdio: "ignore" });
const exited = await Promise.race([new Promise((r) => second.once("exit", () => r(true))), sleep(15000).then(() => false)]);
check(exited, "a second launch exits by itself");
await sleep(500);
check(hermesCount() === before, `still one Hermes (${hermesCount()} process${hermesCount() > 1 ? "es" : ""})`);
check(await page.evaluate(() => document.querySelectorAll(".nav").length > 0), "the first window keeps working");
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();

// update check when GitHub's API says no: the release pages must give tag, date and the right file
execFileSync("cargo", ["test", "--release", "pages", "--", "--ignored"], { cwd: resolve("src-tauri"), stdio: "inherit", env: { ...process.env, PATH: `${process.env.USERPROFILE}\\.cargo\\bin;${process.env.PATH}` } });
check(true, "release pages fallback: yt-dlp, moved FFmpeg repo, Tectonic '@' tag, pinned Real-ESRGAN tag");
console.log("T29 TEST PASSED");
