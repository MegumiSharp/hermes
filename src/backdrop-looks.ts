// Pure: turns a (transparent) image into a faint backdrop. `render(img, w, h, look)` → canvas.
// Styles: outline / sketch / glow (lines from the alpha edge + luminance edges), ghost (faded
// silhouette), bw, duotone, halftone, pixel, color (faded original colours).

export type Style = "outline" | "sketch" | "glow" | "ghost" | "bw" | "duotone" | "halftone" | "pixel" | "color";
export type Look = {
  file: string; // image path, "sample", or "" = no backdrop
  style: Style; opacity: number; size: number; detail: number; blur: number;
  pos: "left" | "center" | "right"; tint: "accent" | "white" | "original"; fade: boolean; flip: boolean;
};
export const DEFAULT_LOOK: Look = { file: "", style: "outline", opacity: 16, size: 92, detail: 45, blur: 0, pos: "right", tint: "accent", fade: true, flip: false };
export const STYLES: [Style, string][] = [["outline", "Outline"], ["sketch", "Sketch"], ["glow", "Glow"], ["ghost", "Ghost"], ["bw", "B&W"], ["duotone", "Duotone"], ["halftone", "Halftone"], ["pixel", "Pixel"], ["color", "Faded"]];

type Src = CanvasImageSource & { width: number; height: number };
const tintRgb = (l: Look): number[] => (l.tint === "white" ? [236, 236, 239] : [242, 163, 58]);
export const tintCss = (l: Look) => `rgb(${tintRgb(l).join(",")})`;
const lum = (d: Uint8ClampedArray, i: number) => (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  return [cv, cv.getContext("2d", { willReadFrequently: true })!];
}
function base(img: Src, w: number, h: number, l: Look): [HTMLCanvasElement, CanvasRenderingContext2D, ImageData] {
  const [cv, x] = canvas(w, h);
  if (l.flip) { x.translate(w, 0); x.scale(-1, 1); }
  x.drawImage(img, 0, 0, w, h);
  x.setTransform(1, 0, 0, 1, 0, 0);
  return [cv, x, x.getImageData(0, 0, w, h)];
}

/** Outer contour (alpha) + inner lines (luminance Sobel), dilated one pixel so they survive scaling. */
function lines(img: Src, w: number, h: number, l: Look): HTMLCanvasElement {
  const [cv, x, src] = base(img, w, h, l), d = src.data, out = x.createImageData(w, h), o = out.data;
  const A = (i: number) => d[i * 4 + 3] / 255;
  const L = (i: number) => (lum(d, i * 4) * d[i * 4 + 3]) / 255;
  const thr = 0.5 - l.detail / 250;
  const inner = l.style === "sketch" ? 0.8 : l.style === "glow" ? 0.5 : l.detail / 100;
  const mask = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let c = 1; c < w - 1; c++) {
    const i = y * w + c;
    const edgeA = Math.min(1, Math.hypot(A(i + 1) - A(i - 1), A(i + w) - A(i - w)) * 1.5);
    const gx = L(i - w + 1) + 2 * L(i + 1) + L(i + w + 1) - L(i - w - 1) - 2 * L(i - 1) - L(i + w - 1);
    const gy = L(i + w - 1) + 2 * L(i + w) + L(i + w + 1) - L(i - w - 1) - 2 * L(i - w) - L(i - w + 1);
    const edgeL = A(i) > 0.5 ? Math.max(0, Math.min(1, (Math.hypot(gx, gy) - thr) * 3)) : 0;
    mask[i] = l.style === "ghost" ? A(i) * 0.35 + edgeA : Math.max(edgeA, edgeL * inner);
  }
  const t = tintRgb(l);
  for (let i = 0; i < w * h; i++) {
    let m = mask[i];
    if (l.style !== "ghost") m = Math.max(m, mask[i - 1] || 0, mask[i + 1] || 0, mask[i - w] || 0, mask[i + w] || 0);
    const col = l.tint === "original" ? [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]].map((v) => Math.min(255, v + 90)) : t;
    o[i * 4] = col[0]; o[i * 4 + 1] = col[1]; o[i * 4 + 2] = col[2]; o[i * 4 + 3] = Math.min(255, m * 255);
  }
  x.putImageData(out, 0, 0);
  return cv;
}

const LOOKS: Partial<Record<Style, (img: Src, w: number, h: number, l: Look) => HTMLCanvasElement>> = {
  bw(img, w, h, l) { // grayscale; detail = contrast
    const [cv, x, im] = base(img, w, h, l), d = im.data, k = 1 + l.detail / 50;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, ((lum(d, i) - 0.5) * k + 0.5) * 255));
    x.putImageData(im, 0, 0);
    return cv;
  },
  duotone(img, w, h, l) { // shadows = page background, highlights = the colour
    const [cv, x, im] = base(img, w, h, l), d = im.data, hi = tintRgb(l), lo = [20, 20, 22];
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.pow(lum(d, i), 1.4 - l.detail / 100);
      for (let j = 0; j < 3; j++) d[i + j] = lo[j] + (hi[j] - lo[j]) * v;
    }
    x.putImageData(im, 0, 0);
    return cv;
  },
  color(img, w, h, l) { // original colours; detail = how much colour stays
    const [cv, x, im] = base(img, w, h, l), d = im.data, s = l.detail / 100;
    for (let i = 0; i < d.length; i += 4) { const v = lum(d, i) * 255; for (let j = 0; j < 3; j++) d[i + j] = v + (d[i + j] - v) * s; }
    x.putImageData(im, 0, 0);
    return cv;
  },
  halftone(img, w, h, l) { // dots sized by brightness; detail = denser dots
    const [, , im] = base(img, w, h, l), d = im.data, step = Math.max(3, Math.round(14 - l.detail / 10));
    const [cv, x] = canvas(w, h);
    x.fillStyle = tintCss(l);
    for (let y = step / 2; y < h; y += step) for (let c = step / 2; c < w; c += step) {
      const i = (Math.floor(y) * w + Math.floor(c)) * 4, a = d[i + 3] / 255;
      if (a < 0.1) continue;
      if (l.tint === "original") x.fillStyle = `rgb(${d[i]},${d[i + 1]},${d[i + 2]})`;
      x.beginPath(); x.arc(c, y, (step / 2) * Math.sqrt(0.15 + 0.85 * lum(d, i)) * a, 0, Math.PI * 2); x.fill();
    }
    return cv;
  },
  pixel(img, w, h, l) { // chunky pixels in shades of the colour; detail = smaller pixels
    const size = Math.max(2, Math.round(16 - l.detail / 8)), sw = Math.max(1, Math.round(w / size)), sh = Math.max(1, Math.round(h / size));
    const [small, sx, im] = base(img, sw, sh, l), d = im.data, t = tintRgb(l);
    if (l.tint !== "original") for (let i = 0; i < d.length; i += 4) { const v = Math.round(lum(d, i) * 4) / 4; for (let j = 0; j < 3; j++) d[i + j] = t[j] * (0.3 + 0.7 * v); }
    sx.putImageData(im, 0, 0);
    const [cv, x] = canvas(w, h);
    x.imageSmoothingEnabled = false;
    x.drawImage(small, 0, 0, w, h);
    return cv;
  },
};

export function render(img: Src, w: number, h: number, l: Look): HTMLCanvasElement {
  return (LOOKS[l.style] ?? lines)(img, w, h, l);
}

/** An original, fully dressed anime-style bust to try the looks with. */
export const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">
<g stroke="#000" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
<path fill="#3b2a4a" d="M300 70c-120 0-185 90-185 205 0 70 10 150-25 230 60-10 95-40 110-80l10-150h180l10 150c15 40 50 70 110 80-35-80-25-160-25-230 0-115-65-205-185-205z"/>
<path fill="#f3d9c8" d="M300 145c-75 0-120 55-120 130 0 85 55 150 120 150s120-65 120-150c0-75-45-130-120-130z"/>
<path fill="#f3d9c8" d="M265 410h70l8 60h-86z"/>
<path fill="#2b2f3f" d="M120 800c0-150 60-310 180-330 120 20 180 180 180 330z"/>
<path fill="#e9e6ef" d="M245 470l55 70 55-70 25 20-80 110-80-110z"/>
<path fill="none" d="M300 540v260M215 600l-30 200M385 600l30 200"/>
<path fill="#3b2a4a" d="M180 260c10-70 60-120 120-120s110 50 120 120c-40-10-70-40-85-75-20 40-60 65-115 70-15 0-30 3-40 5z"/>
<path fill="#fff" d="M235 290c0-15 12-25 28-25s28 10 28 25-12 30-28 30-28-15-28-30zM309 290c0-15 12-25 28-25s28 10 28 25-12 30-28 30-28-15-28-30z"/>
<path fill="#6b4a8f" d="M248 292c0-10 7-17 15-17s15 7 15 17-7 20-15 20-15-10-15-20zM322 292c0-10 7-17 15-17s15 7 15 17-7 20-15 20-15-10-15-20z"/>
<path fill="none" d="M228 262c15-12 35-14 50-8M322 254c15-6 35-4 50 8M288 365c8 6 16 6 24 0"/>
<path fill="#3b2a4a" d="M150 200c-30 60-40 140-20 220 20-70 40-120 60-150zM450 200c30 60 40 140 20 220-20-70-40-120-60-150z"/>
<path fill="#f2a33a" d="M395 150l40-30 10 45-40 15z"/>
</g></svg>`;
