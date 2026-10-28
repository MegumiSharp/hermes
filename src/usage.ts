// Local usage statistics (Settings > Usage statistics, backend usage.rs). Events never hold file
// names, URLs, titles or typed text: only which tool, how long, which tools ran and how it ended.
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { settings } from "./core";
import { Job, Step, watchJobs } from "./queue";
import { summarize, UsageEvent } from "./usage-summary";

export const usageOn = () => settings.usageStats !== false;

export function track(type: string, data: Record<string, unknown> = {}) {
  if (usageOn()) invoke("usage_log", { event: { type, ...data } }).catch(() => {});
}

export { scrub } from "./usage-summary";
import { scrub } from "./usage-summary";

const stepKind = (s: Step) => (s.type === "run" ? s.bin.replace(/\.exe$/, "") : s.type);

/** One `job` event per job that ran and finished during this session. */
export function startUsageTracking() {
  const started = new Map<string, number>();
  watchJobs((jobs: Job[]) => {
    for (const j of jobs) {
      if (j.state === "running" && !started.has(j.id)) started.set(j.id, Date.now());
      if ((j.state === "done" || j.state === "failed") && started.has(j.id)) {
        track("job", {
          module: j.module, pill: j.pill, steps: j.steps.map(stepKind), state: j.state, ms: Date.now() - started.get(j.id)!,
          child: !!j.parent, group: j.group, ...(j.error ? { error: scrub(j.error) } : {}), ...(j.note ? { note: scrub(j.note) } : {}),
        });
        started.delete(j.id);
      }
    }
  }, () => true);
}

/** Save dialog → one JSON file: system, summary, every event. Returns the path or null. */
export async function exportUsage(version: string): Promise<string | null> {
  const events = await invoke<UsageEvent[]>("usage_read");
  const path = await saveDialog({ defaultPath: `hermes-usage-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return null;
  const system = { hermes: version, os: navigator.userAgent.match(/Windows NT [\d.]+/)?.[0] ?? "", cores: navigator.hardwareConcurrency,
    ...(await invoke<Record<string, unknown>>("system_stats").catch(() => ({}))) };
  await invoke("usage_export", { path, text: JSON.stringify({ exported: new Date().toISOString(), system, summary: summarize(events), events }, null, 2) });
  return path;
}
