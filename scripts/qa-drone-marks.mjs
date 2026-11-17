#!/usr/bin/env node
/**
 * Rendered check that each red/green mark in "Speed & photo timing" sits exactly on the
 * slider thumb position it describes (Mapping Grid, Timed shot).
 *
 * For every marked slider it reads the slider's real width and value, works out where the
 * thumb centre is (the thumb travels 5 px in from each end), and compares that with the
 * measured centre of the mark. Reports the gap in px per slider, on a phone and a desktop
 * viewport. Exits 1 if any gap exceeds QA_MAX_GAP_PX (default 1.5).
 *
 *   QA_BASE_URL   app to test (default http://127.0.0.1:5231)
 *   QA_MAX_GAP_PX largest allowed gap between a mark and its thumb position, px (default 1.5)
 *   QA_DIR        'rtl' forces dir=rtl on the page to check right-to-left (default: leave as is)
 */
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:5231';
const MAX_GAP = Number(process.env.QA_MAX_GAP_PX || 1.5);
const VIEW = { lon: -97.7729, lat: 30.2663, height: 900 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const rows = [];

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});

async function boot(page, viewport) {
  await page.setViewport(viewport);
  await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(
    () =>
      window.__gevDronePlan &&
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180_000 },
  );
  await page.evaluate((view) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (view.lon * Math.PI) / 180,
        latitude: (view.lat * Math.PI) / 180,
        height: view.height,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  }, VIEW);
  await wait(6000);
  if (process.env.QA_DIR === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
}

const measure = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const tick of document.querySelectorAll('#drone-plan-panel .gev-dp-redmark')) {
      if (tick.hidden) continue;
      const name = (tick.getAttribute('data-role') || '').replace('redmark-', '');
      const wrap = tick.parentElement;
      const slider = wrap.querySelector('input.gev-quantitative-slider');
      if (!slider) continue;
      const sr = slider.getBoundingClientRect();
      const tr = tick.getBoundingClientRect();
      if (sr.width === 0) continue;
      const min = Number(slider.min);
      const max = Number(slider.max);
      const frac = (Number(slider.value) - min) / (max - min);
      const thumbX = sr.left + 5 + (sr.width - 10) * frac;
      const wantFrac = Number(tick.getAttribute('data-fraction'));
      const rtl = getComputedStyle(slider).direction === 'rtl';
      const wantX = rtl ? sr.right - 5 - (sr.width - 10) * wantFrac : sr.left + 5 + (sr.width - 10) * wantFrac;
      out.push({
        name,
        sliderLeft: Math.round(sr.left * 10) / 10,
        sliderWidth: Math.round(sr.width * 10) / 10,
        tickCentre: Math.round((tr.left + tr.width / 2) * 10) / 10,
        // where the tick must be so it sits on the thumb when the value it names is set
        expectedCentre: Math.round(wantX * 10) / 10,
        gapPx: Math.round((tr.left + tr.width / 2 - wantX) * 10) / 10,
        matches: tick.getAttribute('data-matches'),
        thumbCentre: Math.round(thumbX * 10) / 10,
        thumbVsTickPx: Math.round((tr.left + tr.width / 2 - thumbX) * 10) / 10,
        fraction: wantFrac,
      });
    }
    return out;
  });

async function exercise(page, label) {
  await page.evaluate((view) => {
    window.__gevDronePlan.open({ draw: false });
    window.__gevDronePlan.setBox({
      west: view.lon - 0.001,
      south: view.lat - 0.0005,
      east: view.lon + 0.001,
      north: view.lat + 0.0005,
    });
  }, VIEW);
  await wait(2000);
  await page.waitForFunction(
    () => document.getElementById('drone-plan-panel')?.dataset.state === 'ready',
    { timeout: 90_000 },
  );
  await page.evaluate(() => {
    const t = document.querySelector('#drone-plan-panel [data-role="timing"]');
    for (let n = t; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  // several settings so the marks land at different places along the sliders
  const settings = [
    { captureMode: 'timed', speedMs: 4.2, frontOverlap: 80 },
    { captureMode: 'timed', speedMs: 6.7056, frontOverlap: 70 },
    { captureMode: 'timed', speedMs: 10, frontOverlap: 90 },
  ];
  for (const s of settings) {
    await page.evaluate((o) => window.__gevDronePlan.applyOptions(o), s);
    await wait(1500);
    const got = await measure(page);
    for (const g of got) {
      rows.push({ label, setting: JSON.stringify(s), ...g });
      const bad = Math.abs(g.gapPx) > MAX_GAP;
      console.log(
        `[${bad ? 'FAIL' : 'PASS'}] ${label} ${g.name}: tick ${g.tickCentre}px, should be ${g.expectedCentre}px, gap ${g.gapPx}px (slider ${g.sliderWidth}px wide, fraction ${g.fraction}) ${JSON.stringify(s)}`,
      );
      if (bad) failures.push(`${label} ${g.name} ${JSON.stringify(s)}`);
    }
    if (!got.length) {
      console.log(`[FAIL] ${label}: no marks visible for ${JSON.stringify(s)}`);
      failures.push(`${label}: no marks`);
    }
  }
}

for (const [label, vp] of [
  ['phone-375', { width: 375, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['desktop-1280', { width: 1280, height: 900 }],
]) {
  const page = await browser.newPage();
  try {
    await boot(page, vp);
    await exercise(page, label);
  } catch (e) {
    console.log(`[FAIL] ${label}: ${e.message}`);
    failures.push(`${label}: ${e.message}`);
  }
  await page.close();
}
await browser.close();
console.log(failures.length ? `FAILED ${failures.length}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
