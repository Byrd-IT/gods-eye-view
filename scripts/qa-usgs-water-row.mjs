#!/usr/bin/env node
/** Browser proof of the combined USGS Water layer-panel row. Writes screenshots to qa-artifacts-usgs/. */
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console:' + m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(
  `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
  { waitUntil: 'domcontentloaded' },
);
await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
  timeout: 150000,
});
await page.waitForSelector('#data-toggles [data-combined-row="usgs-water"]', {
  timeout: 60000,
});
const snap = () =>
  page.evaluate(() => {
    const c = document.querySelector('#data-toggles');
    const row = c.querySelector('[data-combined-row="usgs-water"]');
    const m = window.__godsEyeView.dataManager;
    return {
      combinedRows: c.querySelectorAll('[data-combined-row]').length,
      separateUsgsRows: [...c.querySelectorAll('[data-layer-id]')].filter((r) =>
        r.dataset.layerId.startsWith('local-usgs'),
      ).length,
      name: row.querySelector('.data-name').textContent,
      switchText: row.querySelector('.data-toggle-btn').textContent,
      chipsHidden: row.querySelector('.data-toggle-controls').hidden,
      chips: [...row.querySelectorAll('.data-toggle-chip')].map((b) => [
        b.textContent,
        b.classList.contains('active'),
      ]),
      enabled: [
        'local-usgs-water',
        'local-usgs-wells',
        'local-usgs-lakes',
        'local-usgs-springs',
      ].map((id) => m.isEnabled(id)),
      meta: row.querySelector('.data-toggle-meta').textContent,
    };
  });
const out = {};
out.initial = await snap();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (sel) =>
  page.evaluate((s) => document.querySelector(s).click(), sel);
await click('[data-combined-row="usgs-water"] .data-toggle-btn');
await wait(4000);
out.afterSwitchOn = await snap();
await click(
  '[data-combined-row="usgs-water"] [data-chip-id="local-usgs-wells"]',
);
await wait(2000);
out.afterWellsOff = await snap();
await page.evaluate(() =>
  document
    .querySelector('#data-toggles [data-combined-row]')
    .scrollIntoView({ block: 'center' }),
);
await page.mouse.click(196, 298);
await wait(1200);
const row = await page.$('#data-toggles [data-combined-row="usgs-water"]');
out.rowVisible = await row.evaluate((e) => {
  const r = e.getBoundingClientRect();
  return [r.width, r.height];
});
await page.evaluate(() =>
  document
    .querySelector('[data-combined-row]')
    .scrollIntoView({ block: 'center' }),
);
await wait(800);
const box = await row.boundingBox();
if (box && box.width)
  await page.screenshot({
    path: 'qa-artifacts-usgs/usgs-water-row-partial.png',
    clip: {
      x: Math.max(0, box.x - 30),
      y: Math.max(0, box.y - 120),
      width: box.width + 60,
      height: box.height + 240,
    },
  });
await click('[data-combined-row="usgs-water"] .data-toggle-btn');
await wait(2500);
out.afterSwitchOff = await snap();
await click('[data-combined-row="usgs-water"] .data-toggle-btn');
await wait(3000);
out.afterSwitchOnAgain = await snap();
await page.screenshot({ path: 'qa-artifacts-usgs/layer-panel-full.png' });
console.log(JSON.stringify(out, null, 1));
console.log('pageerrors', JSON.stringify(errors));
await browser.close();
