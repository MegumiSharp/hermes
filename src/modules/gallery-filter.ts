// Pure: the Gallery Downloader's filters as one gallery-dl "image-filter" Python expression, so the download
// runs in a single pass over the whole URL (Hermes only reads a preview). Missing metadata always passes:
// not every site reports sizes, dates or titles. Checked against real gallery-dl by scripts/gallery-filter-test.mjs.

export type Kind = "image" | "video" | "gif";
export type Filters = {
  types: Record<Kind, boolean>; extOff: string[]; minW: number; minH: number;
  sizeMin: number; sizeMax: number; dateFrom: string; dateTo: string; limit: number; skipDownloaded: boolean;
  titleHas: string; titleNot: string; // comma-separated words matched against title/description and the file name
};
export const VIDEO = ["mp4", "webm", "mov", "mkv", "m4v", "avi"];
export const TEXT_KEYS = ["title", "description", "content", "caption", "text", "summary"];
export const words = (s: string) => s.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
export const kindOf = (ext: string): Kind => (ext === "gif" ? "gif" : VIDEO.includes(ext) ? "video" : "image");

const py = (s: string) => JSON.stringify(s); // a JSON string is a valid Python string literal
const set = (xs: string[]) => `{${xs.map(py).join(", ")}}`;
const get = (k: string) => `locals().get(${py(k)})`;
const EXT = `str(${get("extension")} or '').lower()`;
// title-like fields + file name, lower case (written out: locals() inside a generator would be the generator's)
const TEXT = `(${[...TEXT_KEYS, "filename"].map((k) => `str(${get(k)} or '')`).join(" + ' ' + ")}).lower()`;
/** "YYYY-MM-DD" (+ days) → Python datetime(...) */
const day = (d: string, plus = 0) => {
  const t = new Date(Date.parse(d) + plus * 86400000);
  return `datetime(${t.getUTCFullYear()}, ${t.getUTCMonth() + 1}, ${t.getUTCDate()})`;
};

export function filterExpr(f: Filters, offKeys: string[] = []): string {
  const all: string[] = [];
  if (!f.types.image) all.push(`${EXT} in ${set([...VIDEO, "gif"])}`);
  if (!f.types.video) all.push(`${EXT} not in ${set(VIDEO)}`);
  if (!f.types.gif) all.push(`${EXT} != 'gif'`);
  if (f.extOff.length) all.push(`${EXT} not in ${set(f.extOff.map((e) => e.toLowerCase()))}`);
  if (f.minW) all.push(`(not ${get("width")} or int(${get("width")}) >= ${f.minW})`);
  if (f.minH) all.push(`(not ${get("height")} or int(${get("height")}) >= ${f.minH})`);
  const isDate = `isinstance(${get("date")}, datetime)`;
  if (f.dateFrom) all.push(`(not ${isDate} or date >= ${day(f.dateFrom)})`);
  if (f.dateTo) all.push(`(not ${isDate} or date < ${day(f.dateTo, 1)})`);
  const has = words(f.titleHas), not = words(f.titleNot);
  if (has.length) all.push(`(${has.map((w) => `${py(w)} in ${TEXT}`).join(" or ")})`);
  if (not.length) all.push(`not (${not.map((w) => `${py(w)} in ${TEXT}`).join(" or ")})`);
  if (offKeys.length) all.push(`(str(${get("filename")}) + '.' + ${EXT}) not in ${set(offKeys)}`);
  return all.join(" and ") || "True";
}
