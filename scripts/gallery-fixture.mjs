// Local gallery for tests (instead of Wikimedia, which rate-limits after a few runs): an HTML page with
// images served on 127.0.0.1, read by gallery-dl through "generic:<url>". serveGallery(dir) → {url, close}.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export const FILES = [
  ["sunset-red.png", "640x480", "red"], ["sunset-orange.png", "800x600", "orange"], ["city-night.jpg", "1280x720", "navy"],
  ["forest-green.jpg", "320x240", "green"], ["promo-banner.png", "1200x300", "purple"],
];

export async function serveGallery(dir, ffmpeg) {
  mkdirSync(dir, { recursive: true });
  for (const [name, size, color] of FILES) execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", join(dir, name)]);
  const page = `<!doctype html><title>Hermes test gallery</title><body>${FILES.map(([n]) => `<img src="/${n}">`).join("")}</body>`;
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    if (!name || name === "index.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
    const f = FILES.find(([n]) => n === name);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": name.endsWith(".png") ? "image/png" : "image/jpeg" });
    res.end(readFileSync(join(dir, name)));
  });
  // gallery-dl's generic extractor drops any port from the URL: the page must be on port 80
  await new Promise((ok, no) => { server.once("error", no); server.listen(80, "127.0.0.1", ok); });
  return { url: "generic:http://127.0.0.1/index.html", close: () => server.close() };
}
