#!/usr/bin/env node
/**
 * Moves each marked slider with a real mouse drag (as a person does) and watches the mark.
 * For each of height / speed / overlap: drag the thumb across 5 positions; after each, read
 * the thumb centre and the mark centre, whether the page says "matches", and the label.
 * Then drag the thumb ONTO the mark: the gap between thumb and mark must be within one slider step.
 * Screenshots go to QA_SHOT_DIR. Usage: QA_BASE_URL=... node scripts/qa-drone-marks-drag.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:5231';
const SHOT_DIR = path.resolve(process.env.QA_SHOT_DIR || 'qa-shots/drone-marks-drag');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const VIEW = { lon: -97.7729, lat: 30.2663, height: 900 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 1000, deviceScaleFactor: 2 });
await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(
  () => window.__gevDronePlan && window.__godsEyeView && document.getElementById('loading-screen')?.classList.contains('hidden'),
  { timeout: 180_000 },
);
await page.evaluate((view) => {
  const viewer = window.__godsEyeView.viewer;
  viewer.camera.cancelFlight?.();
  viewer.camera.setView({
    destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
      longitude: (view.lon * Math.PI) / 180, latitude: (view.lat * Math.PI) / 180, height: view.height }),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  viewer.scene.requestRender();
}, VIEW);
await wait(6000);
await page.evaluate((view) => {
  window.__gevDronePlan.open({ draw: false });
  window.__gevDronePlan.setBox({ west: view.lon - 0.001, south: view.lat - 0.0005, east: view.lon + 0.001, north: view.lat + 0.0005 });
}, VIEW);
await wait(2000);
await page.waitForFunction(() => document.getElementById('drone-plan-panel')?.dataset.state === 'ready', { timeout: 90_000 });
await page.evaluate(() => {
  const t = document.querySelector('#drone-plan-panel [data-role="timing"]');
  for (let n = t; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
});
await page.evaluate(() => window.__gevDronePlan.applyOptions({ captureMode: 'timed', speedMs: 6.7056, frontOverlap: 80 }));
await wait(1500);

const read = (name) =>
  page.evaluate((nm) => {
    const tick = document.querySelector(`#drone-plan-panel [data-role="redmark-${nm}"]`);
    const label = document.querySelector(`#drone-plan-panel [data-role="redmark-${nm}-label"]`);
    const slider = tick.parentElement.querySelector('input.gev-quantitative-slider');
    const sr = slider.getBoundingClientRect(), tr = tick.getBoundingClientRect();
    const f = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    const thumb = sr.left + 5 + (sr.width - 10) * f;
    const step = Number(slider.step) / (Number(slider.max) - Number(slider.min)) * (sr.width - 10);
    return { value: slider.value, tick: tr.left + tr.width / 2, thumb, gap: tr.left + tr.width / 2 - thumb, stepPx: step,
      matches: tick.getAttribute('data-matches'), label: label.textContent, sl: sr.left, sw: sr.width, y: sr.top + sr.height / 2 };
  }, name);

let bad = 0;
for (const name of ['height', 'speed', 'overlap']) {
  await page.evaluate((nm) => document.querySelector(`#drone-plan-panel [data-role="redmark-${nm}"]`).scrollIntoView({ block: 'center' }), name);
  await wait(400);
  let r = await read(name);
  console.log(`--- ${name}: slider ${r.sw.toFixed(0)}px wide`);
  for (const frac of [0.1, 0.35, 0.6, 0.85]) {
    r = await read(name);
    await page.mouse.move(r.thumb, r.y); await page.mouse.down();
    await page.mouse.move(r.sl + 5 + (r.sw - 10) * frac, r.y, { steps: 8 }); await page.mouse.up();
    await wait(1200);
    const a = await read(name);
    console.log(`  dragged to ${Math.round(frac * 100)}%: thumb ${a.thumb.toFixed(1)} mark ${a.tick.toFixed(1)} matches=${a.matches} "${a.label}"`);
  }
  // now drag the thumb ONTO the mark and check they coincide
  let a = await read(name);
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(a.thumb, a.y); await page.mouse.down();
    await page.mouse.move(a.tick, a.y, { steps: 6 }); await page.mouse.up();
    await wait(1200); a = await read(name);
  }
  const ok = Math.abs(a.gap) <= Math.max(a.stepPx, 1.5);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] dragged onto the mark: thumb ${a.thumb.toFixed(1)} mark ${a.tick.toFixed(1)} gap ${a.gap.toFixed(1)}px (one step = ${a.stepPx.toFixed(1)}px) matches=${a.matches}`);
  if (!ok) bad++;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-on-mark.png`), clip: { x: 0, y: Math.max(0, a.y - 70), width: 420, height: 140 } });
}
await browser.close();
console.log(bad ? `FAILED ${bad}` : 'ALL PASS');
process.exit(bad ? 1 : 0);
