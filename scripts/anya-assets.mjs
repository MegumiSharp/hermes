// Builds Anya's poses from the Libbie "Individual" colour PNGs: scaled to 640 px tall and recoloured to
// Hermes' palette (every accent hue → amber, pale whites/mints → warm cream, darks kept), plus the face
// Usage: node scripts/anya-assets.mjs <folder with the PNGs> [out dir]
// The logo (app mark + icon) is the owner's own drawing, recoloured the same way: --logo <png> [out dir].
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [src, out = "src/assets/anya"] = process.argv.slice(2);
const FF = resolve("release/hermes-data/bin/ffmpeg.exe"), FP = resolve("release/hermes-data/bin/ffprobe.exe");
const SKIP = ["004_dark", "005_male", "011_math"]; // dark versions of her: not used
const H = 640;
if (src !== "--logo") mkdirSync(out, { recursive: true });

// RGB ↔ HSL (0..1)
function hsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h * 6) % 6];
  return [r + m, g + m, b + m];
}
const AMBER = 35 / 360, CREAM = 40 / 360;
function recolor(px, keepLight) {
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const [h, s, l] = hsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    let o;
    if (s > 0.28 && l > 0.12 && l < 0.92) o = rgb(AMBER, Math.min(1, 0.62 + s * 0.35), keepLight ? Math.min(0.72, Math.max(0.2, l * 1.08)) : Math.min(0.8, 0.36 + l * 0.5)); // accents → amber (the logo keeps its light/dark contrast)
    else if (l > 0.62) o = rgb(CREAM, 0.18 + 0.25 * s, Math.min(0.95, l * 0.97)); // whites, mints, pinks → cream
    else o = rgb(h, s * 0.2, l); // darks: neutral graphite
    px[i] = o[0] * 255; px[i + 1] = o[1] * 255; px[i + 2] = o[2] * 255;
  }
}
function bake(file, name, vf, dir = out, keepLight = false) {
  const tmp = join(dir, `_${name}.png`);
  execFileSync(FF, ["-v", "error", "-y", "-i", file, "-vf", vf, tmp]);
  const [w, h] = execFileSync(FP, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", tmp]).toString().trim().split(",").map(Number);
  const px = execFileSync(FF, ["-v", "error", "-i", tmp, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
  recolor(px, keepLight);
  execFileSync(FF, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-", join(dir, `${name}.png`)], { input: px });
  execFileSync(process.platform === "win32" ? "cmd" : "rm", process.platform === "win32" ? ["/c", "del", tmp.replace(/\//g, "\\")] : [tmp]);
  return [w, h];
}

// logo mode: node scripts/anya-assets.mjs --logo <png> → <out>/face.png (title-bar mark) + <out>/logo-1024.png (app icon source)
if (src === "--logo") {
  const [, file, dir = "src/assets/anya"] = process.argv.slice(2);
  mkdirSync(dir, { recursive: true });
  bake(file, "face", "scale=256:256:flags=lanczos", dir, true);
  bake(file, "logo-1024", "scale=1024:1024:flags=lanczos", dir, true);
  console.log(`logo recoloured into ${dir}`);
  process.exit(0);
}
const files = readdirSync(src).filter((f) => f.includes("_001_color_") && !SKIP.some((s) => f.includes(s)));
for (const f of files) {
  const name = f.replace(/^.*_001_color_\d+_/, "").replace(".png", ""); // front, draw, typing…
  const [w, h] = bake(join(src, f), name, `scale=-2:${H}:flags=lanczos`);
  console.log(`${name} ${w}x${h}`);
}
