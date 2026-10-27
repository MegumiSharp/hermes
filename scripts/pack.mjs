// Appends the bundled tools (src-tauri/binaries.json) to the built exe -> release/Hermes.exe.
// Layout read by src-tauri/src/binaries.rs:
//   [exe][file bytes...][manifest json][u64 LE manifest length]["HERMESPK"]
// Downloads are cached in vendor/<id>/ and refreshed when a newer release exists.
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";

// optional tools are installed on request inside Hermes, not bundled
const tools = JSON.parse(readFileSync("src-tauri/binaries.json", "utf8")).filter((t) => !t.optional);
const headers = { "User-Agent": "Hermes-build" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

// Same rules as glob()/natural() in binaries.rs: `*` matches text without '-'.
function glob(pat, name) {
  const re = new RegExp("^" + pat.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("([^-]*)") + "$");
  const m = name.match(re);
  return m ? (m[1] ?? "") : null;
}
const natural = (s) => (s.match(/\d+/g) ?? []).map(Number);
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); return 0; };

function find(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = find(p, name); if (f) return f; }
    else if (p.endsWith(sep + name.replaceAll("/", sep))) return p; // name may be "models/x.bin"
  }
}

async function fetchTool(t) {
  const dir = join("vendor", t.id);
  if (t.local) {
    // built alongside the app (DirectML.dll from the ort build): no release to fetch
    mkdirSync(dir, { recursive: true });
    copyFileSync(t.local, join(dir, t.files[0]));
    return { version: "bundled", date: statSync(t.local).mtime.toISOString() };
  }
  const cached = existsSync(join(dir, "version.json")) && JSON.parse(readFileSync(join(dir, "version.json"), "utf8"));
  const res = await fetch(t.api, { headers: t.api.includes("api.github.com") ? headers : { "User-Agent": "Hermes-build" } });
  if (!res.ok) {
    if (cached && t.files.every((f) => existsSync(join(dir, f)))) {
      console.warn(`${t.id}: release check failed (${res.status}), using cached ${cached.version}`);
      return cached;
    }
    throw new Error(`${t.id}: ${res.status} ${await res.text()}`);
  }
  const rel = await res.json();
  const [cap, asset] = rel.assets
    .map((a) => [glob(t.asset, a.name), a])
    .filter(([c]) => c !== null)
    .sort(([a], [b]) => cmp(natural(a), natural(b)))
    .at(-1) ?? [];
  if (!asset) throw new Error(`${t.id}: no asset matching ${t.asset}`);
  const ver = {
    version: rel.tag_name === "latest" ? `${cap} · ${rel.published_at.slice(0, 10)}` : rel.tag_name.replace(/^v/, ""),
    date: rel.published_at,
  };
  if (cached?.date === ver.date && t.files.every((f) => existsSync(join(dir, f)))) return ver;

  console.log(`downloading ${t.id} ${ver.version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset.name);
  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok) throw new Error(`${t.id}: download ${dl.status}`);
  writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
  if (asset.name.endsWith(".zip")) {
    const x = join(dir, "x");
    mkdirSync(x);
    execFileSync(join(process.env.SystemRoot, "System32", "tar.exe"), ["-xf", file, "-C", x]); // Windows bsdtar; Git's tar can't read zip
    for (const f of t.files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(find(x, f), join(dir, f));
    }
    rmSync(x, { recursive: true });
    rmSync(file);
  } else if (asset.name !== t.files[0]) {
    renameSync(file, join(dir, t.files[0])); // versioned asset name (spotdl-4.6.0-win32.exe) -> spotdl.exe
  }
  writeFileSync(join(dir, "version.json"), JSON.stringify(ver));
  return ver;
}

const exe = "src-tauri/target/release/Hermes.exe";
const out = "release/Hermes.exe";
mkdirSync("release", { recursive: true });
const manifest = { tools: {}, files: [] };
for (const t of tools) manifest.tools[t.id] = await fetchTool(t);
// one handle from start to end: reopening the freshly written exe races antivirus scans (EBUSY)
const fd = openSync(out, "w");
const base = readFileSync(exe);
writeSync(fd, base);
let offset = base.length;
for (const t of tools) {
  for (const f of t.files) {
    const data = readFileSync(join("vendor", t.id, f));
    writeSync(fd, data);
    manifest.files.push({ name: f, offset, size: data.length });
    offset += data.length;
  }
}
const json = Buffer.from(JSON.stringify(manifest));
const len = Buffer.alloc(8);
len.writeBigUInt64LE(BigInt(json.length));
writeSync(fd, Buffer.concat([json, len, Buffer.from("HERMESPK")]));
closeSync(fd);
console.log(`packed ${out} (${(statSync(out).size / 1048576).toFixed(0)} MB):`, Object.entries(manifest.tools).map(([k, v]) => `${k} ${v.version}`).join(", "));
