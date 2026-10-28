// Pure: the Pattern Generator's dots (pattern.ts draws them). A grid of dots pushed around by a smooth
// noise field: the noise picks each dot's direction (× waves), amplitude how far it moves. Imported by
// tests under plain node.

export type Params = {
  grid: number; // dots across the long side (16-152)
  spread: number; // share of the canvas the grid covers (0.1-1)
  dot: number; // dot radius in px at 1080 px on the long side (0.5-8)
  amplitude: number; // how far dots move (× MOVE px at 1080, -150..150)
  waves: number; // turns of direction across the noise (-10..10)
  frequency: number; // noise scale (0-0.005 per px at 1080)
  seed: number;
  aspect: "1:1" | "16:9" | "9:16" | "4:5";
};
export type Dot = { x: number; y: number; r: number };

export const ASPECTS: Record<Params["aspect"], [number, number]> = { "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "4:5": [4, 5] };
const REF = 1080; // parameters are defined at this long-side size, then scaled
// Durves' scale (matched by eye on the same settings): the same numbers give the same look
const NOISE = 2; // noise input per px × frequency
const MOVE = 0.26; // px moved per amplitude unit

/** Canvas size for a long side of `long` px. */
export function sizeFor(aspect: Params["aspect"], long: number): [number, number] {
  const [a, b] = ASPECTS[aspect];
  return a >= b ? [long, Math.round((long * b) / a)] : [Math.round((long * a) / b), long];
}

// ---- 2D simplex noise (Gustavson), seeded permutation ----
const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
function permutation(seed: number): Uint8Array {
  const p = new Uint8Array(512);
  const base = [...Array(256).keys()];
  let s = (seed >>> 0) || 1;
  for (let i = 255; i > 0; i--) { // xorshift shuffle
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
}
export function noise2(perm: Uint8Array, x: number, y: number): number {
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
  const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  const corner = (gx: number, gy: number, g: number) => {
    const t2 = 0.5 - gx * gx - gy * gy;
    if (t2 < 0) return 0;
    const [a, b] = G[g % 8];
    return t2 ** 4 * (a * gx + b * gy);
  };
  return 70 * (corner(x0, y0, perm[ii + perm[jj]]) + corner(x1, y1, perm[ii + i1 + perm[jj + j1]]) + corner(x2, y2, perm[ii + 1 + perm[jj + 1]]));
}

/** Every dot for a canvas of `w`×`h` px. */
export function dots(p: Params, w: number, h: number): Dot[] {
  const k = Math.max(w, h) / REF; // parameters scale with the output size
  const perm = permutation(p.seed);
  const cols = w >= h ? p.grid : Math.max(2, Math.round((p.grid * w) / h));
  const rows = w >= h ? Math.max(2, Math.round((p.grid * h) / w)) : p.grid;
  const gw = w * p.spread, gh = h * p.spread;
  const ox = (w - gw) / 2, oy = (h - gh) / 2;
  const out: Dot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = ox + (cols === 1 ? gw / 2 : (c / (cols - 1)) * gw);
      const y0 = oy + (rows === 1 ? gh / 2 : (r / (rows - 1)) * gh);
      const n = noise2(perm, (x0 / k) * p.frequency * NOISE, (y0 / k) * p.frequency * NOISE); // -1..1, smooth
      // every dot moves the full amplitude; the noise only turns its direction, so neighbours move
      // together (smooth sheets) and fold where the direction turns (the creases)
      const a = n * p.waves * Math.PI, m = p.amplitude * MOVE * k;
      out.push({ x: x0 + Math.cos(a) * m, y: y0 + Math.sin(a) * m, r: p.dot * k });
    }
  }
  return out;
}

/** Vector export: one circle per dot (coordinates rounded to 0.01 px). */
export function svg(p: Params, w: number, h: number, color: string, background: string | null): string {
  const f = (n: number) => +n.toFixed(2);
  const body = dots(p, w, h).map((d) => `<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ""}<g fill="${color}">${body}</g></svg>`;
}

/** A random but tasteful pattern (the dice). */
export function randomParams(base: Params, rnd = Math.random): Params {
  const pick = (a: number, b: number) => a + rnd() * (b - a);
  return {
    ...base, seed: Math.floor(rnd() * 1e9), grid: 16 + 8 * Math.floor(pick(4, 15)), dot: +pick(1.5, 5).toFixed(1),
    amplitude: Math.round(pick(-120, 120)), waves: +pick(-6, 6).toFixed(1), frequency: +pick(0.0004, 0.003).toFixed(4),
  };
}
