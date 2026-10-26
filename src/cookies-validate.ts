// Netscape cookies.txt validation (pure: also run by scripts/t4-test.mjs under plain node).

export type Site = { name: string; domain: string; login: string[]; url: string };

export const SITES: Record<string, Site> = {
  youtube: { name: "YouTube", domain: "youtube.com", login: ["SAPISID", "__Secure-3PSID", "LOGIN_INFO"], url: "https://www.youtube.com" },
};

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
