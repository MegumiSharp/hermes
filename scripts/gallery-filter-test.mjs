// Checks src/modules/gallery-filter.ts against the real gallery-dl (simulate mode, local fixture gallery).
// Usage: node scripts/gallery-filter-test.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { filterExpr } from "../src/modules/gallery-filter.ts";
import { serveGallery } from "./gallery-fixture.mjs";
import { check, OUT } from "./smoke.mjs";

const BIN = resolve("release/hermes-data/bin");
const W = join(OUT, "gallery-filter");
mkdirSync(W, { recursive: true });
const gallery = await serveGallery(join(W, "src"), join(BIN, "ffmpeg.exe"));
const base = { types: { image: true, video: true, gif: true }, extOff: [], minW: 0, minH: 0, sizeMin: 0, sizeMax: 0, dateFrom: "", dateTo: "", limit: 200, skipDownloaded: false, titleHas: "", titleNot: "" };

/** File names gallery-dl would download with these filters. */
async function files(patch, offKeys = []) {
  const cfg = join(W, "cfg.json");
  writeFileSync(cfg, JSON.stringify({ extractor: { "image-filter": filterExpr({ ...base, ...patch }, offKeys) } }));
  // async: the fixture server runs in this process and must keep answering
  const { stdout: out } = await promisify(execFile)(join(BIN, "gallery-dl.exe"), ["--config", cfg, "-s", gallery.url], { encoding: "utf8" });
  return out.split(/\r?\n/).map((l) => l.replace(/^# /, "").trim()).filter((l) => /\.(png|jpg)$/.test(l)).map((l) => l.split(/[\\/]/).pop()).sort();
}
const eq = (got, want, what) => check(JSON.stringify(got) === JSON.stringify([...want].sort()), `${what}: ${got.join(", ") || "none"}`);
const ALL = ["sunset-red.png", "sunset-orange.png", "city-night.jpg", "forest-green.jpg", "promo-banner.png"];

eq(await files({}), ALL, "no filters: everything");
check(filterExpr(base) === "True", "no filters: expression is True");
eq(await files({ extOff: ["png"] }), ["city-night.jpg", "forest-green.jpg"], "extension png off");
eq(await files({ types: { image: false, video: true, gif: true } }), [], "images off");
eq(await files({ titleHas: "sunset" }), ["sunset-red.png", "sunset-orange.png"], "title contains 'sunset' (file name)");
eq(await files({ titleHas: "Hermes test" }), ALL, "title contains a word of the page title");
eq(await files({ titleNot: "promo, ,city" }), ["sunset-red.png", "sunset-orange.png", "forest-green.jpg"], "title excludes 'promo' and 'city' (empty word ignored)");
eq(await files({ minW: 5000, minH: 5000 }), ALL, "unknown size passes the minimum resolution");
eq(await files({ dateFrom: "2030-01-01", dateTo: "2030-12-31" }), ALL, "unknown date passes the date range");
eq(await files({}, ["city-night.jpg", "promo-banner.png"]), ["sunset-red.png", "sunset-orange.png", "forest-green.jpg"], "manually deselected files are skipped");
eq(await files({ titleHas: "it's \"quoted\"" }), [], "quotes in a word are escaped");
gallery.close();
console.log("GALLERY FILTER TEST PASSED");
