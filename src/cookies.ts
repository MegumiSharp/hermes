// Cookie source per site (SPEC 4.4) + fallback modal. Backend: src-tauri/src/cookies.rs.
import { invoke } from "@tauri-apps/api/core";
import { h, modal, saveSettings, settings } from "./core";
import { icon } from "./icons";
import { SITES, validateCookies, withMirror } from "./cookies-validate";

export type Mode = "auto" | "firefox" | "chrome" | "edge" | "brave" | "file" | "none";
const LABEL: Record<Mode, string> = {
  auto: "Automatic", firefox: "Firefox", chrome: "Chrome", edge: "Edge", brave: "Brave", file: "cookies.txt file", none: "No cookies",
};

const browsers: Promise<string[]> = invoke("detect_browsers");
/** Sites whose browser extraction failed this session: use no cookies until the user fixes it. */
const broken = new Set<string>();

const mode = (site: string): Mode => settings.cookies?.[site] ?? "auto";

async function resolved(site: string): Promise<Mode> {
  const m = mode(site);
  if (m === "auto") return ((await browsers)[0] as Mode) ?? "none";
  return m;
}

/** yt-dlp / gallery-dl arguments for the site's cookie source. */
export async function cookieArgs(site: string): Promise<string[]> {
  const m = await resolved(site);
  if (m === "none") return [];
  if (m === "file") {
    const p = await invoke<string | null>("cookies_path", { site });
    return p ? ["--cookies", p] : [];
  }
  return broken.has(site) ? [] : ["--cookies-from-browser", m];
}

/** Short label for the header chip, e.g. "Firefox cookies". */
export async function cookieLabel(site: string): Promise<string> {
  const m = await resolved(site);
  if (m === "none") return "No cookies";
  if (m === "file") return "cookies.txt";
  return broken.has(site) ? "Cookies unavailable" : `${LABEL[m]} cookies`;
}

/** Errors from yt-dlp that mean "could not read browser cookies". */
export const isCookieError = (e: string) => /cookie|DPAPI|decrypt/i.test(e);

export function markBroken(site: string) {
  broken.add(site);
}

/** Cookie settings + manual import. `reason` = why browser extraction failed. Resolves true if anything changed. */
let openModal: Promise<boolean> | null = null; // several probes failing at once share one modal

export function cookiesModal(site: string, reason?: string): Promise<boolean> {
  openModal ??= showCookiesModal(site, reason).finally(() => (openModal = null));
  return openModal;
}

function showCookiesModal(site: string, reason?: string): Promise<boolean> {
  const s = SITES[site];
  return new Promise(async (resolve) => {
    const found = await browsers;
    const body = h(`<div class="cookies">
      ${reason ? `<div class="banner warn">${icon("alert")}<span class="txt"></span></div>` : ""}
      <label class="field-label" for="ck-mode">Cookie source</label>
      <select id="ck-mode" class="select"></select>
      <div class="ck-title">Import a cookies.txt file</div>
      <ol class="steps">
        <li>Install the open-source browser extension <b>Get cookies.txt LOCALLY</b>.</li>
        <li>Open <span class="mono">${s.url.replace("https://", "")}</span> and make sure you are signed in.</li>
        <li>Click the extension and export in <b>Netscape</b> format.</li>
        <li>Drop the file below. It stays on this PC, in <span class="mono">hermes-data\\cookies</span>.</li>
      </ol>
      <label class="drop" tabindex="0">${icon("download")}<span>Drop cookies.txt here or <u>browse</u></span><input type="file" accept=".txt,text/plain" hidden></label>
      <div class="ck-result"></div>
    </div>`);
    if (reason) {
      body.querySelector(".banner .txt")!.textContent =
        `Hermes could not read your browser's ${s.name} cookies (${reason}). Chromium browsers on Windows encrypt cookies and must be fully closed; Firefox works best. Or import them manually below.`;
    }
    const select = body.querySelector<HTMLSelectElement>("#ck-mode")!;
    for (const m of Object.keys(LABEL) as Mode[]) {
      if (["firefox", "chrome", "edge", "brave"].includes(m) && !found.includes(m)) continue;
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m === "auto" ? `Automatic${found[0] ? ` (${LABEL[found[0] as Mode]})` : " (no browser found)"}` : LABEL[m];
      select.append(o);
    }
    select.value = mode(site);

    let validText: string | null = null;
    const result = body.querySelector(".ck-result")!;
    const drop = body.querySelector<HTMLElement>(".drop")!;
    const input = drop.querySelector("input")!;
    async function take(f: File | undefined) {
      if (!f) return;
      const check = validateCookies(await f.text(), s);
      validText = check.ok ? await f.text() : null;
      result.className = `ck-result ${check.ok ? "ok" : "bad"}`;
      result.textContent = check.ok
        ? `Valid: ${check.count} cookies for ${s.domain}, signed in${check.expires ? `, expires ${new Date(check.expires).toLocaleDateString()}` : ""}.`
        : check.error!;
      if (check.ok) select.value = "file";
    }
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer?.files[0]); };
    input.onchange = () => take(input.files?.[0]);

    let changed = false;
    modal({
      title: `${s.name} cookies`,
      body,
      onClose: () => resolve(changed),
      actions: [
        { label: "Cancel" },
        {
          label: "Save", primary: true,
          run: async () => {
            const m = select.value as Mode;
            if (m === "file" && validText) await invoke("cookies_write", { site, text: withMirror(validText, s) });
            if (m === "file" && !validText && !(await invoke("cookies_path", { site }))) {
              result.className = "ck-result bad";
              result.textContent = "Drop a valid cookies.txt first.";
              return false;
            }
            await saveSettings({ cookies: { ...settings.cookies, [site]: m } });
            broken.delete(site);
            changed = true;
          },
        },
      ],
    });
  });
}
