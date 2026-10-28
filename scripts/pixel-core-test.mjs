// Unit check for src/modules/pixel-core.ts (no app). Usage: node scripts/pixel-core-test.mjs
import { adjust, artSize, hexToRgb, nearest, PALETTES, paletteFromImage, parseHexList, quantize, scaleFor } from "../src/modules/pixel-core.ts";
import { check } from "./smoke.mjs";

const img = (pixels) => Uint8ClampedArray.from(pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));
check(JSON.stringify(hexToRgb("#ff0044")) === "[255,0,68]" && JSON.stringify(hexToRgb("0f0")) === "[0,255,0]", "hex to RGB");
check(JSON.stringify(parseHexList("#FF0044, 00ff00; abc and junk zz")) === '["ff0044","00ff00","aabbcc"]', "hex list parsing (Lospec / pasted text)");
for (const [name, p] of Object.entries(PALETTES)) check(p.every((h) => /^[0-9a-f]{6}$/.test(h)), `${name}: ${p.length} valid colours`);
check(PALETTES["Pico-8"].length === 16 && PALETTES["Endesga 32"].length === 32 && PALETTES["Game Boy"].length === 4, "palette sizes");

const grey = img([[100, 100, 100]]);
adjust(grey, 50, 0, 0);
check(grey[0] === 164, `brightness +50 (${grey[0]})`);
const flat = img([[100, 150, 200]]);
adjust(flat, 0, 0, -100);
check(flat[0] === flat[1] && flat[1] === flat[2], "saturation -100 = grey");
const c = img([[200, 200, 200], [50, 50, 50]]);
adjust(c, 0, 100, 0);
check(c[0] === 255 && c[4] === 0, "contrast +100 pushes apart");

const gb = PALETTES["Game Boy"].map(hexToRgb);
check(JSON.stringify(nearest(10, 50, 10, gb)) === JSON.stringify(gb[0]), "nearest colour");
const px = img([[255, 0, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0, 0]]);
quantize(px, 4, 1, PALETTES["1-bit"].map(hexToRgb), "none");
check([px[0], px[4], px[8]].every((v) => v === 0 || v === 255) && px[15] === 0, "every opaque pixel on the palette, transparent kept");
// a mid grey ramp: dithering mixes black and white, no dithering gives one flat colour
const ramp = img(Array.from({ length: 64 }, () => [128, 128, 128]));
const fl = ramp.slice(); quantize(fl, 8, 8, PALETTES["1-bit"].map(hexToRgb), "floyd");
const blacks = [...Array(64).keys()].filter((i) => fl[i * 4] === 0).length;
check(blacks > 20 && blacks < 44, `Floyd–Steinberg mixes black and white for grey (${blacks}/64 black)`);
const od = ramp.slice(); quantize(od, 8, 8, PALETTES["1-bit"].map(hexToRgb), "ordered");
const ob = [...Array(64).keys()].filter((i) => od[i * 4] === 0).length;
check(ob > 10 && ob < 54, `ordered dithering patterns grey (${ob}/64 black)`);
const plain = ramp.slice(); quantize(plain, 8, 8, PALETTES["1-bit"].map(hexToRgb), "none");
check(new Set([...Array(64).keys()].map((i) => plain[i * 4])).size === 1, "no dithering = one colour");

const two = img([...Array(50).fill([250, 10, 10]), ...Array(50).fill([10, 10, 250])]);
const pal = paletteFromImage(two, 2);
check(pal.length === 2 && pal.some((p) => p[0] > 200) && pal.some((p) => p[2] > 200), `palette from image finds red and blue (${JSON.stringify(pal)})`);
check(paletteFromImage(two, 8).length <= 8, "never more colours than asked");

check(JSON.stringify(artSize(1920, 1080, 8)) === "[240,135]", "art size");
check(scaleFor(240, 135, "original", 8) === 8 && scaleFor(240, 135, 3840, 8) === 16, "large export scale is an integer (crisp pixels)");
console.log("PIXEL CORE TEST PASSED");
