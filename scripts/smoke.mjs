// Drives the real Hermes.exe through WebView2's DevTools port.
// Usage: node scripts/smoke.mjs [path\to\Hermes.exe]
// Other test scripts import { launch } and reuse it.
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

export const OUT = resolve("test-output");
const DEFAULT_EXE = resolve("release/Hermes.exe");

/** Tests run on the second monitor (owner's request) so the main screen stays free. Only when the
 *  test hasn't set a window position itself; restarts keep the position the app saved. */
let second;
function onSecondScreen(dataDir) {
  second ??= (() => {
    try {
      const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1 | ForEach-Object { \"$($_.WorkingArea.X) $($_.WorkingArea.Y)\" }";
      const out = execFileSync("powershell", ["-NoProfile", "-Command", ps]).toString().trim().split(/\s+/).map(Number);
      return out.length === 2 && out.every(Number.isFinite) ? { x: out[0] + 80, y: out[1] + 60 } : null;
    } catch { return null; }
  })();
  if (!second) return;
  const file = join(dataDir, "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (settings.window && !settings.window.maximized) return; // a maximized window left by an earlier run would break the window tests
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, window: { ...second, width: 1180, height: 760, maximized: false } }));
}

/** Starts the exe with a DevTools port and returns { page, proc, errors, close }. */
export async function launch(exe = DEFAULT_EXE, port = 9333) {
  // a Hermes left running by an aborted test would own WebView2's profile and DevTools port
  try { execSync("taskkill /IM Hermes.exe /F", { stdio: "ignore" }); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  onSecondScreen(join(dirname(exe), "hermes-data"));
  const proc = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
  });
  const { browser, page, errors } = await connect(port);
  const close = async () => { await browser.close().catch(() => {}); proc.kill(); };
  return { page, proc, errors, close, dataDir: join(dirname(exe), "hermes-data") };
}

/** Attaches to an already running Hermes (e.g. one relaunched by the updater). */
export async function connect(port = 9333) {
  const endpoint = `http://127.0.0.1:${port}`;
  let browser;
  for (let i = 0; !browser; i++) {
    // retry the whole attach: a previous WebView2 may still hold the port while it shuts down
    try { await fetch(`${endpoint}/json/version`); browser = await chromium.connectOverCDP(endpoint); }
    catch { if (i > 80) throw new Error("DevTools port never opened"); await new Promise((r) => setTimeout(r, 250)); }
  }
  let page;
  while (!(page = browser.contexts()[0]?.pages()[0])) await new Promise((r) => setTimeout(r, 100));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("crash", () => console.log("!! WebView renderer crashed"));
  await page.waitForSelector(".nav");
  return { browser, page, errors };
}

export function check(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok  ${msg}`);
}

async function smoke() {
  mkdirSync(OUT, { recursive: true });
  const app = await launch(process.argv[2] && resolve(process.argv[2]));
  const { page } = app;
  try {
    check(/^\d+\.\d+\.\d+$/.test(await page.textContent("#ver")), "title bar shows version");
    for (const btn of await page.$$(".nav")) {
      const id = await btn.getAttribute("data-id");
      await btn.click();
      await page.waitForTimeout(150);
      check(await btn.evaluate((b) => b.classList.contains("on")), `nav ${id} activates`);
      check(await page.$eval("#view", (v) => v.childElementCount > 0), `module ${id} renders`);
      const saved = JSON.parse(readFileSync(join(app.dataDir, "settings.json"), "utf8"));
      check(saved.lastModule === id, `lastModule persisted as ${id}`);
      await page.screenshot({ path: join(OUT, `module-${id}.png`) });
    }
    check((await page.textContent("#data-path")).includes("hermes-data"), "settings shows data folder");
    await page.click("#check-update");
    await page.waitForFunction(() => !/^Checking/.test(document.querySelector("#update-status").textContent));
    const status = await page.textContent("#update-status");
    check(!status.startsWith("Check failed"), `update check works: "${status}"`);

    const w0 = await page.evaluate(() => window.outerWidth);
    await page.click("#wc-max");
    await page.waitForTimeout(400);
    const w1 = await page.evaluate(() => window.outerWidth);
    check(w1 > w0, `maximize grows window (${w0} -> ${w1})`);
    await page.click("#wc-max");
    await page.waitForTimeout(400);
    check((await page.evaluate(() => window.outerWidth)) === w0, "second click restores size");
    check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);

    const exited = new Promise((r) => app.proc.once("exit", r));
    await page.click("#wc-close").catch(() => {}); // the page dies mid-click
    check(await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]), "close button exits the app");
    console.log("SMOKE PASSED");
  } finally {
    await app.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  smoke().catch((e) => { console.error(e.message); process.exit(1); });
}
