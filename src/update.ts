// App self-update UI (SPEC 4.6). Backend: src-tauri/src/update.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { banner, h, modal } from "./core";

type Update = { version: string; url: string };

const SIX_HOURS = 6 * 60 * 60 * 1000;
const mb = (n: number) => (n / 1048576).toFixed(1);

/** Shows the update banner when a newer release exists. Throws on network/API errors. */
export async function checkForUpdate(): Promise<Update | null> {
  const u = await invoke<Update | null>("check_update");
  if (u) {
    banner({
      id: "app-update",
      icon: "refresh",
      text: `<b>Hermes ${u.version}</b> is available.`,
      actions: [{ label: "Later" }, { label: "Update", primary: true, run: () => install(u) }],
    });
  }
  return u;
}

/** Background checks: on launch and every 6 h. Offline errors are ignored. */
export function startUpdateChecks() {
  const quiet = () => checkForUpdate().catch(() => {});
  quiet();
  setInterval(quiet, SIX_HOURS);
}

async function install(u: Update) {
  const body = h(`<div class="progress"><div class="bar"><i></i></div><span class="mono">Starting download</span></div>`);
  const fill = body.querySelector("i")!;
  const label = body.querySelector("span")!;
  const close = modal({ title: `Updating to Hermes ${u.version}`, body, actions: [] });
  const unlisten = await listen<[number, number]>("update-progress", ({ payload: [done, total] }) => {
    if (total) fill.style.width = `${(done / total) * 100}%`;
    label.textContent = total ? `${mb(done)} / ${mb(total)} MB` : `${mb(done)} MB`;
  });
  try {
    await invoke("install_update", { url: u.url }); // on success the app restarts
  } catch (e) {
    close();
    banner({ id: "app-update", tone: "warn", icon: "alert", text: `Update failed: ${e}`, actions: [{ label: "Dismiss" }] });
  } finally {
    unlisten();
  }
}
