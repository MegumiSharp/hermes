// Pure: is a YouTube video a trustworthy source for a Spotify track? spotDL's own pick can be a
// fan upload (osu! beatmaps, covers, nightcore...). Imported by tests under plain node.

export type Meta = { id: string; title: string; artist: string; channel: string; duration: number };
export type Track = { name: string; artist: string; artists?: string[]; album_name?: string; duration: number };

// versions that sound different from the record; fine only when the Spotify title says so too
const ALTERED = ["osu", "cover", "nightcore", "sped up", "speed up", "slowed", "8d", "karaoke", "reverb", "bass boosted",
  "remix", "live", "instrumental", "acoustic", "piano", "fan made", "fanmade", "reaction", "tutorial", "beatmap", "mashup",
  "extended", "1 hour", "hour loop", "loop", "lyrics", "lyric video", "edit", "mmd", "amv", "tiktok"];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const has = (text: string, word: string) => ` ${norm(text)} `.includes(` ${word} `);

/** null = trusted; otherwise why not (shown to the user). */
export function distrust(t: Track, m: Meta): string | null {
  if (m.duration && Math.abs(m.duration - t.duration) > 4) return `length differs (${Math.round(m.duration)} s vs ${t.duration} s)`;
  const spotify = `${t.name} ${t.album_name ?? ""}`;
  const word = ALTERED.find((w) => has(m.title, w) && !has(spotify, w));
  if (word) return `"${word}" version`;
  const artists = (t.artists?.length ? t.artists : [t.artist]).map(norm).filter(Boolean);
  // YouTube Music tracks carry an artist field; official uploads are on the artist's channel or "<artist> - Topic"
  const by = norm(`${m.artist} ${m.channel.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "")}`);
  if (!artists.some((a) => by.includes(a) || (a.length > 3 && norm(m.channel).includes(a.replace(/ /g, ""))))) return `uploaded by ${m.channel || "someone else"}`;
  return null;
}

/** Parses yt-dlp `--print "%(id)s\t%(title)s\t%(artist)s\t%(channel)s\t%(duration)s"` lines. */
export function parseMeta(lines: string[]): Map<string, Meta> {
  const out = new Map<string, Meta>();
  for (const l of lines) {
    const [id, title, artist, channel, duration] = l.split("\t");
    if (!id || duration === undefined || !/^[\w-]{11}$/.test(id)) continue;
    const na = (s: string) => (s === "NA" ? "" : s);
    out.set(id, { id, title: na(title), artist: na(artist), channel: na(channel), duration: Number(duration) || 0 });
  }
  return out;
}

export const META_PRINT = "%(id)s\t%(title)s\t%(artist)s\t%(channel)s\t%(duration)s";
export const videoId = (url: string) => url.match(/[?&]v=([\w-]{11})/)?.[1] ?? "";
