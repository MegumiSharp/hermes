// T26 test: local tools are never rate-limited and multi-pass tools show one bar. A fake "Demucs" (a .cmd)
// prints Hugging Face's "higher rate limits" hint, "a bag of 4 models" and four 0-100% bars, like the real
// htdemucs_ft: the job must finish without a cooldown, with progress that only goes up and ends at 100%.
// Usage: node scripts/t26-test.mjs
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch } from "./smoke.mjs";

const DATA = resolve("release/hermes-data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ ...s, lastModule: "downloads", anya: { on: false } }));
const app = await launch(resolve("release/Hermes.exe"));
const { page } = app;
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
await invoke("queue_resume_now").catch(() => {});
for (const j of (await invoke("queue_get")).jobs.filter((j) => j.title === "fake demucs")) await invoke("queue_action", { id: j.id, action: "remove" }); // leftovers of earlier runs

// Hermes only runs tools from hermes-data/bin: the fake Demucs is a .cmd there. 4 bars of 0 → 100 %, ~0.15 s per step
const FAKE = join(DATA, "bin", "fake-demucs.cmd");
const CRLF = "\r\n";
const bar = [0, 25, 50, 75, 100].map((p) => `echo ${String(p).padStart(3)}%%^|##########^| ${p}/100${CRLF}ping -n 1 -w 150 127.255.255.255 >nul`).join(CRLF);
writeFileSync(FAKE, ["@echo off",
  "echo Warning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN to enable higher rate limits and faster downloads. 1>&2",
  "echo Selected model is a bag of 4 models. You will see that many progress bars per track.",
  bar, bar, bar, bar, "exit /b 0", ""].join(CRLF)); // like Demucs: success at the end
await invoke("queue_add", { jobs: [{ module: "demucs", title: "fake demucs", steps: [{ type: "run", label: "Separating", bin: "fake-demucs.cmd", parser: "percent", args: [] }] }] });

const seen = [];
let job;
for (let i = 0; i < 300; i++) {
  const q = await invoke("queue_get");
  job = q.jobs.find((j) => j.title === "fake demucs");
  if (job) seen.push(job.progress ?? 0);
  if (job && ["done", "failed"].includes(job.state)) break;
  if (q.pausedUntil > Date.now()) break;
  await sleep(100);
}
const q = await invoke("queue_get");
check(!(q.pausedUntil > Date.now()), "no rate-limit cooldown from a local tool's 'rate limits' text");
check(job?.state === "done", `job done (${job?.state}${job?.error ? ": " + job.error : ""})`);
const drops = seen.filter((p, i) => i && p + 0.05 < seen[i - 1]).length;
check(drops === 0, `one bar: progress never goes back (${[...new Set(seen.map((p) => Math.round(p * 100)))].join(" → ")} %)`);
check(seen.some((p) => p > 0.3 && p < 0.95), "intermediate progress across the passes");
await invoke("queue_action", { id: job.id, action: "remove" }).catch(() => {});
rmSync(FAKE, { force: true });
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await app.close();
console.log("T26 TEST PASSED");
