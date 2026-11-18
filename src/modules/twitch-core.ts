// Pure helpers for the Twitch module (checked under node by scripts/t32-test.mjs).

export type TwitchKind = "vod" | "clip" | "channel" | "tracker";

/** What a link points to, or null when twitch-dlp can't take it. */
export function twitchKind(url: string): TwitchKind | null {
  let u: URL;
  try { u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (["twitchtracker.com", "streamscharts.com", "sullygnome.com"].includes(host)) return /\/streams?\/\d+/.test(path) ? "tracker" : null;
  if (host === "clips.twitch.tv") return path.length > 1 ? "clip" : null;
  if (host !== "twitch.tv") return null;
  if (/^\/videos\/\d+$/.test(path)) return "vod";
  if (/^\/[^/]+\/clip\/[\w-]+$/.test(path)) return "clip";
  if (/^\/[\w]+$/.test(path) && !["directory", "videos", "settings", "search", "downloads"].includes(path.slice(1))) return "channel";
  return null;
}

/** "1:25:00", "85:00", "5100" → seconds; "" → undefined; anything else → null. */
export function parseTime(s: string): number | undefined | null {
  const t = s.trim();
  if (!t) return undefined;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);
}

const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/** twitch-dlp --download-sections value. */
export const sectionArg = (a?: number, b?: number) => `*${hms(a ?? 0)}-${b == null ? "inf" : hms(b)}`;

/** File name part for a section: " (1h25m00-1h40m00)"; empty for the whole video. */
export function sectionTag(a?: number, b?: number): string {
  if (a == null && b == null) return "";
  const f = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}`;
  return ` (${f(a ?? 0)}-${b == null ? "end" : f(b)})`;
}
