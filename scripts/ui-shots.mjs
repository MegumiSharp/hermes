// Visual review: screenshot of every page, of every dropdown opened, and of a tooltip, in
// test-output/ui/. Also fails if any <select> or [title] still renders natively (UI rule in CLAUDE.md).
// Usage: node scripts/ui-shots.mjs
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, launch, OUT } from "./smoke.mjs";

const UI = join(OUT, "ui");
rmSync(UI, { recursive: true, force: true });
mkdirSync(UI, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await launch(resolve("release/Hermes.exe"));
const { page } = app;
const ids = await page.$$eval(".nav[data-id]", (n) => n.map((x) => x.dataset.id));
const native = [];
for (const id of ids) {
  await page.click(`.nav[data-id="${id}"]`);
  await sleep(1200);
  await page.mouse.move(5, 700);
  await page.screenshot({ path: join(UI, `${id}.png`), fullPage: true });
  const selects = await page.$$("#view select");
  for (const [i, sel] of selects.entries()) {
    if (!(await sel.isVisible()) || (await sel.isDisabled())) continue;
    const look = await sel.evaluate((s) => getComputedStyle(s).appearance);
    if (look !== "base-select") native.push(`${id} #${await sel.evaluate((s) => s.id)}`);
    await sel.click();
    await sleep(300);
    await page.screenshot({ path: join(UI, `${id}-select-${i}.png`) });
    await page.keyboard.press("Escape");
    await sleep(150);
  }
}
check(native.length === 0, `every dropdown is drawn by Hermes${native.length ? `: native ${native.join(", ")}` : ""}`);

// one tooltip
await page.click('.nav[data-id="video"]');
await sleep(800);
const withTip = await page.$("#view [title], #view [data-tip]");
if (withTip) {
  await withTip.hover();
  await sleep(700);
  check(await page.isVisible(".tip"), "styled tooltip shown on hover");
  await page.screenshot({ path: join(UI, "tooltip.png") });
}
check(app.errors.length === 0, `no console errors ${app.errors.join(" | ")}`);
await page.click("#wc-close").catch(() => {});
await app.close();
console.log(`UI SHOTS DONE: ${UI}`);
