// Pure: Pixel Art pixel maths on the small image (one value per art pixel, RGBA bytes). The module
// shrinks the picture with the browser (block average), runs these, then scales up nearest-neighbour.
// Imported by tests under plain node.

export type RGB = [number, number, number];
export type Dither = "none" | "floyd" | "ordered";

export const PALETTES: Record<string, string[]> = {
  "Pico-8": ["000000", "1d2b53", "7e2553", "008751", "ab5236", "5f574f", "c2c3c7", "fff1e8", "ff004d", "ffa300", "ffec27", "00e436", "29adff", "83769c", "ff77a8", "ffccaa"],
  "Game Boy": ["0f380f", "306230", "8bac0f", "9bbc0f"],
  "Sweetie 16": ["1a1c2c", "5d275d", "b13e53", "ef7d57", "ffcd75", "a7f070", "38b764", "257179", "29366f", "3b5dc9", "41a6f6", "73eff7", "f4f4f4", "94b0c2", "566c86", "333c57"],
  "Endesga 32": ["be4a2f", "d77643", "ead4aa", "e4a672", "b86f50", "733e39", "3e2731", "a22633", "e43b44", "f77622", "feae34", "fee761", "63c74d", "3e8948", "265c42", "193c3e",
    "124e89", "0099db", "2ce8f5", "ffffff", "c0cbdc", "8b9bb4", "5a6988", "3a4466", "262b44", "181425", "ff0044", "68386c", "b55088", "f6757a", "e8b796", "c28569"],
  "CGA": ["000000", "55ffff", "ff55ff", "ffffff"],
  "1-bit": ["000000", "ffffff"],
};

export const hexToRgb = (h: string): RGB => {
  const s = h.replace("#", "").trim();
  const full = s.length === 3 ? [...s].map((c) => c + c).join("") : s;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};
export const rgbToHex = ([r, g, b]: RGB) => [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Hex codes anywhere in a text ("#ff0044, 00ff00 …"), as 6-digit lower case. */
export const parseHexList = (text: string) => [...text.matchAll(/#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => rgbToHex(hexToRgb(m[1])));

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Brightness / contrast / saturation, each -100..200 (0 = unchanged), in place. */
export function adjust(px: Uint8ClampedArray, brightness: number, contrast: number, saturation: number) {
  const b = (brightness / 100) * 128, c = 1 + contrast / 100, s = 1 + saturation / 100;
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i], g = px[i + 1], bl = px[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * bl; // saturation around the pixel's own grey
    r = l + (r - l) * s; g = l + (g - l) * s; bl = l + (bl - l) * s;
    px[i] = clamp((r - 128) * c + 128 + b); px[i + 1] = clamp((g - 128) * c + 128 + b); px[i + 2] = clamp((bl - 128) * c + 128 + b);
  }
}

/** Colour distance weighted like the eye ("redmean"): closer to what looks nearest than plain RGB. */
function dist(r: number, g: number, b: number, p: RGB) {
  const rm = (r + p[0]) / 2, dr = r - p[0], dg = g - p[1], db = b - p[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}
export function nearest(r: number, g: number, b: number, pal: RGB[]): RGB {
  let best = pal[0], bd = Infinity;
  for (const p of pal) { const d = dist(r, g, b, p); if (d < bd) { bd = d; best = p; } }
  return best;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Maps every pixel to the palette, optionally dithered, in place. Transparent pixels stay as they are. */
export function quantize(px: Uint8ClampedArray, w: number, h: number, pal: RGB[], dither: Dither) {
  if (!pal.length) return;
  const err = dither === "floyd" ? new Float32Array(w * h * 3) : null;
  // ordered dithering spreads by about one palette step
  const spread = dither === "ordered" ? 255 / Math.max(2, Math.cbrt(pal.length) * 2) : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, e = (y * w + x) * 3;
      if (px[i + 3] < 128) continue;
      let r = px[i], g = px[i + 1], b = px[i + 2];
      if (err) { r += err[e]; g += err[e + 1]; b += err[e + 2]; }
      if (spread) { const t = (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * spread; r += t; g += t; b += t; }
      const p = nearest(clamp(r), clamp(g), clamp(b), pal);
      px[i] = p[0]; px[i + 1] = p[1]; px[i + 2] = p[2];
      if (err) { // Floyd–Steinberg: push the error to the right and the row below
        const er = r - p[0], eg = g - p[1], eb = b - p[2];
        const add = (dx: number, dy: number, k: number) => {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) return;
          const j = (yy * w + xx) * 3;
          err[j] += er * k; err[j + 1] += eg * k; err[j + 2] += eb * k;
        };
        add(1, 0, 7 / 16); add(-1, 1, 3 / 16); add(0, 1, 5 / 16); add(1, 1, 1 / 16);
      }
    }
  }
}

/** The image's own palette of up to `n` colours (median cut on the opaque pixels). */
export function paletteFromImage(px: Uint8ClampedArray, n: number): RGB[] {
  const all: RGB[] = [];
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] >= 128) all.push([px[i], px[i + 1], px[i + 2]]);
  if (!all.length) return [];
  let boxes: RGB[][] = [all];
  while (boxes.length < n) {
    // split the box with the widest channel range
    let bi = -1, bc = 0, br = 0;
    boxes.forEach((box, k) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        if (hi - lo > br) { br = hi - lo; bi = k; bc = c; }
      }
    });
    if (bi < 0 || br === 0) break;
    const box = boxes[bi].sort((a, b) => a[bc] - b[bc]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => box.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0] as RGB).map((v) => Math.round(v / box.length)) as RGB);
}

/** Art size for a picture of `w`×`h` with blocks of `size` px. */
export const artSize = (w: number, h: number, size: number): [number, number] => [Math.max(1, Math.round(w / size)), Math.max(1, Math.round(h / size))];

/** Integer scale for the large export: "original" ≈ the source size, or a long side (2160 / 3840). */
export function scaleFor(cw: number, ch: number, out: "original" | number, size: number): number {
  if (out === "original") return Math.max(1, size);
  return Math.max(1, Math.floor(out / Math.max(cw, ch)));
}
