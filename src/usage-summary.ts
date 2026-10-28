// Pure parts of the usage statistics (usage.ts), imported by tests under plain node.

export type UsageEvent = { type: string; t: number; [k: string]: unknown };

/** Error text without URLs, paths or quoted names (titles end up in quotes). A path runs to the ": "
 *  of the message, a quote or the end, so file names with spaces don't leak. */
export const scrub = (e: string) =>
  e.replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z]:\\[^"'<>|\n]*?(?=: |["'<>|\n]|$)/g, "<path>")
    .replace(/"[^"]{0,300}"/g, '"…"').slice(0, 160);

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const groupBy = <T,>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, T[]>>((o, x) => ((o[key(x)] ??= []).push(x), o), {});
const top = (xs: string[], n = 5) => Object.entries(groupBy(xs, (x) => x)).map(([k, v]) => ({ text: k, count: v.length })).sort((a, b) => b.count - a.count).slice(0, n);

/** What an export starts with, so it can be read without scrolling through events. */
export function summarize(events: UsageEvent[]) {
  const of = (type: string) => events.filter((e) => e.type === type);
  const launches = of("launch");
  const jobs = of("job") as (UsageEvent & { module: string; state: string; ms: number; error?: string; group: boolean })[];
  const waits = of("wait") as (UsageEvent & { kind: string; ms: number; ok: boolean })[];
  const opens = of("open") as (UsageEvent & { tool: string })[];
  return {
    from: events[0] ? new Date(events[0].t).toISOString() : null,
    to: events.at(-1) ? new Date(events.at(-1)!.t).toISOString() : null,
    launches: launches.length,
    startupMs: { median: pct(launches.map((l) => Number(l.startupMs)), 50), p90: pct(launches.map((l) => Number(l.startupMs)), 90) },
    toolsOpened: Object.fromEntries(Object.entries(groupBy(opens, (o) => o.tool)).map(([k, v]) => [k, v.length]).sort((a, b) => Number(b[1]) - Number(a[1]))),
    jobs: Object.fromEntries(Object.entries(groupBy(jobs.filter((j) => !j.group), (j) => j.module)).map(([m, js]) => [m, {
      done: js.filter((j) => j.state === "done").length, failed: js.filter((j) => j.state === "failed").length,
      medianMs: pct(js.map((j) => j.ms), 50), p90Ms: pct(js.map((j) => j.ms), 90),
      topErrors: top(js.filter((j) => j.error).map((j) => j.error!)),
    }])),
    waits: Object.fromEntries(Object.entries(groupBy(waits, (w) => w.kind)).map(([k, ws]) => [k, {
      count: ws.length, failed: ws.filter((w) => !w.ok).length, medianMs: pct(ws.map((w) => w.ms), 50), p90Ms: pct(ws.map((w) => w.ms), 90),
    }])),
  };
}

