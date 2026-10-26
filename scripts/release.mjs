// Usage: node scripts/release.mjs 0.2.0
// Bumps the version, commits, tags vX.Y.Z and pushes; GitHub Actions builds and publishes the release.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) throw new Error("usage: node scripts/release.mjs X.Y.Z");
if (execSync("git status --porcelain").toString().trim()) throw new Error("working tree not clean");

for (const f of ["src-tauri/tauri.conf.json", "package.json"]) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.version = v;
  writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
const run = (c) => execSync(c, { stdio: "inherit" });
run(`git commit -am "Release v${v}"`);
run(`git tag -a v${v} -m "Hermes v${v}"`); // annotated, so --follow-tags pushes it
run("git push --follow-tags");
