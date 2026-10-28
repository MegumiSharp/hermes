// Unit check for src/modules/pattern-core.ts (no app). Usage: node scripts/pattern-core-test.mjs
import { dots, noise2, randomParams, sizeFor, svg } from "../src/modules/pattern-core.ts";
import { check } from "./smoke.mjs";

const base = { grid: 64, spread: 0.85, dot: 4, amplitude: 60, waves: 1.8, frequency: 0.0009, seed: 42, aspect: "1:1" };
check(JSON.stringify(sizeFor("16:9", 3840)) === "[3840,2160]" && JSON.stringify(sizeFor("9:16", 1920)) === "[1080,1920]", "canvas sizes per aspect");
const a = dots(base, 1080, 1080);
check(a.length === 64 * 64, `64 × 64 grid (${a.length} dots)`);
check(JSON.stringify(dots(base, 1080, 1080)) === JSON.stringify(a), "same seed = same pattern");
check(JSON.stringify(dots({ ...base, seed: 7 }, 1080, 1080)) !== JSON.stringify(a), "another seed = another pattern");
const flat = dots({ ...base, amplitude: 0 }, 1080, 1080);
check(Math.abs(flat[0].x - 1080 * 0.075) < 1e-6 && Math.abs(flat.at(-1).x - 1080 * 0.925) < 1e-6, "amplitude 0 = regular grid inside the spread");
const moved = a.reduce((m, d, i) => Math.max(m, Math.hypot(d.x - flat[i].x, d.y - flat[i].y)), 0);
check(moved > 5 && moved <= 60.01, `dots move at most the amplitude (${moved.toFixed(1)} px)`);
const big = dots(base, 2160, 2160);
check(Math.abs(big[100].x - a[100].x * 2) < 1e-6 && big[0].r === 8, "4K export is the same pattern scaled ×2");
const wide = dots({ ...base, aspect: "16:9" }, 1920, 1080);
check(wide.length === 64 * 36, `16:9 keeps square spacing (${wide.length} dots)`);
let lo = 1, hi = -1;
for (let i = 0; i < 2000; i++) { const n = noise2(new Uint8Array(512).map((_, k) => (k * 151) & 255), i * 0.37, i * 0.11); lo = Math.min(lo, n); hi = Math.max(hi, n); }
check(lo >= -1.01 && hi <= 1.01 && hi - lo > 0.5, `noise in -1..1 (${lo.toFixed(2)}..${hi.toFixed(2)})`);
const s = svg({ ...base, grid: 16 }, 1080, 1080, "#fff", "#101012");
check(s.startsWith("<svg") && (s.match(/<circle/g) ?? []).length === 256 && s.includes('fill="#101012"'), "SVG has one circle per dot and the background");
check(!svg({ ...base, grid: 16 }, 1080, 1080, "#fff", null).includes("<rect"), "transparent SVG has no background");
const r = randomParams(base, () => 0.5);
check(r.grid >= 16 && r.grid <= 152 && r.grid % 8 === 0, "dice stays in range");
console.log("PATTERN CORE TEST PASSED");
