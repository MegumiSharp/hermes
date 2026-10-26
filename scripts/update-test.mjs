// End-to-end self-update test against the real GitHub release.
// Usage: node scripts/update-test.mjs <dir containing an OLDER Hermes.exe> <expected new version>
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { check, connect, launch } from "./smoke.mjs";

const dir = resolve(process.argv[2]);
const want = process.argv[3];
const exe = join(dir, "Hermes.exe");

const app = await launch(exe);
const before = await app.page.textContent("#ver");
check(before !== want, `old build runs (${before})`);
await app.page.waitForSelector('[data-banner="app-update"]', { timeout: 15000 });
check((await app.page.textContent('[data-banner="app-update"]')).includes(want), `banner offers ${want}`);

const exited = new Promise((r) => app.proc.once("exit", r));
await app.page.click('[data-banner="app-update"] .btn.primary');
await app.page.waitForSelector(".nav-badge.busy", { timeout: 15000 });
check(true, "download shown as busy on the Downloads entry");
await exited;
check(true, "old process exited after swap");

const next = await connect(); // the updater relaunched the new exe with the same env (DevTools port)
const after = await next.page.textContent("#ver");
check(after === want, `relaunched app reports ${after}`);
await new Promise((r) => setTimeout(r, 3000));
check(!existsSync(join(dir, "Hermes.exe.old")), "Hermes.exe.old cleaned up");
check(!existsSync(join(dir, "Hermes.exe.new")), "no leftover Hermes.exe.new");
await next.page.waitForTimeout(2000);
check((await next.page.$('[data-banner="app-update"]')) === null, "no update banner on latest version");
check(next.errors.length === 0, "no console errors after update");
await next.browser.close();
execSync('taskkill /IM Hermes.exe /F', { stdio: "ignore" });
console.log("UPDATE TEST PASSED");
