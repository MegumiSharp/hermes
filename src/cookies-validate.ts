// Netscape cookies.txt validation (pure: also run by scripts/t4-test.mjs under plain node).

/** `hosts`: other hosts of the same site; `mirror`: a domain the login cookies are copied to (ExHentai uses the E-Hentai account). */
export type Site = { name: string; domain: string; login: string[]; url: string; hosts?: string[]; mirror?: string };

/** Keys match yt-dlp's site and gallery-dl's extractor category. */
export const SITES: Record<string, Site> = {
  youtube: { name: "YouTube", domain: "youtube.com", login: ["SAPISID", "__Secure-3PSID", "LOGIN_INFO"], url: "https://www.youtube.com" },
  instagram: { name: "Instagram", domain: "instagram.com", login: ["sessionid"], url: "https://www.instagram.com" },
  twitter: { name: "X (Twitter)", domain: "x.com", login: ["auth_token"], url: "https://x.com" },
  pixiv: { name: "Pixiv", domain: "pixiv.net", login: ["PHPSESSID"], url: "https://www.pixiv.net" },
  reddit: { name: "Reddit", domain: "reddit.com", login: ["reddit_session", "token_v2"], url: "https://www.reddit.com" },
  exhentai: { name: "E-Hentai", domain: "e-hentai.org", hosts: ["exhentai.org"], mirror: "exhentai.org", login: ["ipb_member_id", "ipb_pass_hash"], url: "https://e-hentai.org" },
};

/** Site key whose domain the URL's host belongs to ("" if none). */
export function siteForUrl(url: string): string {
  let host = "";
  try { host = new URL(url).hostname; } catch { return ""; }
  const on = (d: string) => host === d || host.endsWith(`.${d}`);
  return Object.keys(SITES).find((k) => [SITES[k].domain, ...(SITES[k].hosts ?? [])].some(on)) ?? "";
}

/** The cookies.txt to store: the file as given, plus its rows copied to the site's `mirror` domain. */
export function withMirror(text: string, site: Site): string {
  if (!site.mirror) return text;
  const rows = text.split(/\r?\n/).filter((l) => {
    const d = l.replace(/^#HttpOnly_/, "").split("\t")[0]?.replace(/^\./, "");
    return d === site.domain || d?.endsWith(`.${site.domain}`);
  });
  return `${text.trimEnd()}\n${rows.map((l) => l.replace(/^(#HttpOnly_)?\.?[^\t]+/, `$1.${site.mirror}`)).join("\n")}\n`;
}

export type CookieCheck = { ok: boolean; count: number; signedIn: boolean; expires: number | null; error?: string };

/** Checks format, domain, presence of login cookies and expiry. `now` in ms. */
export function validateCookies(text: string, site: Site, now = Date.now()): CookieCheck {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#HttpOnly_/, "")) // HttpOnly cookies are written as comments
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split("\t"));
  if (!rows.length || rows.some((r) => r.length !== 7)) {
    return { ok: false, count: 0, signedIn: false, expires: null, error: "Not a Netscape cookies.txt file. Export with the “Netscape” format." };
  }
  const mine = rows.filter(([domain]) => domain.replace(/^\./, "") === site.domain || domain.endsWith(`.${site.domain}`));
  if (!mine.length) {
    return { ok: false, count: 0, signedIn: false, expires: null, error: `The file has no cookies for ${site.domain}. Export while ${site.name} is the open tab.` };
  }
  const login = mine.filter(([, , , , , name]) => site.login.includes(name));
  const live = login.filter(([, , , , exp]) => Number(exp) === 0 || Number(exp) * 1000 > now);
  const expiries = live.map(([, , , , exp]) => Number(exp) * 1000).filter((e) => e > 0);
  const expires = expiries.length ? Math.min(...expiries) : null;
  const base = { count: mine.length, expires };
  if (!login.length) return { ...base, ok: false, signedIn: false, error: `No login cookies found. Sign in to ${site.name}, then export again.` };
  if (!live.length) return { ...base, ok: false, signedIn: false, error: "The login cookies have expired. Sign in again and re-export." };
  return { ...base, ok: true, signedIn: true };
}
