#!/usr/bin/env node
/**
 * Rendered acceptance for the "Speed & photo timing" section of DISPLAY >
 * Drone Flight Plan, on a 375 px phone and a desktop viewport. It plans a
 * Timed-shot survey, types an interval, reads the section as a person would,
 * downloads the KMZ and checks that every waypoint carries a speed and a
 * gimbal angle.
 *
 *   QA_BASE_URL   app to test (default http://127.0.0.1:5231)
 *   QA_SHOT_DIR   screenshots (default qa-shots/drone-timing)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { readZip } from '../src/byrdit/dronePlan/zip.js';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:5231';
const SHOT_DIR = path.resolve(process.env.QA_SHOT_DIR || 'qa-shots/drone-timing');
const DOWNLOADS = path.join(SHOT_DIR, 'downloads');
const VIEW = {
  lon: Number(process.env.QA_LON ?? -97.7729),
  lat: Number(process.env.QA_LAT ?? 30.2663),
  height: 700,
};
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(page, viewport) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.setViewport(viewport);
  await page.goto(`${BASE_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  });
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
  await wait(Number(process.env.QA_SETTLE_MS || 6000));
  return errors;
}

const waitForPlan = (page) =>
  page.waitForFunction(
    () => document.getElementById('drone-plan-panel')?.dataset.state === 'ready',
    { timeout: 90_000 },
  );

/** A plan that never becomes ready is a failure, not something to skip past. */
async function planReady(page, label) {
  try {
    await waitForPlan(page);
    check(`${label}: the plan is ready`, true);
  } catch {
    check(`${label}: the plan is ready`, false, 'timed out');
  }
}

/** Everything checked about the section, read from the rendered page. */
const readSection = (page) =>
  page.evaluate(() => {
    const q = (r) => document.querySelector(`#drone-plan-panel [data-role="${r}"]`);
    const visible = (n) => {
      if (!n) return false;
      const r = n.getBoundingClientRect();
      return !n.hidden && r.width > 0 && r.height > 0;
    };
    const section = q('timing');
    const body = document.getElementById('drone-plan-panel-body');
    const sr = section?.getBoundingClientRect();
    const rec = q('timing-recommended');
    const details = q('capture-details');
    return {
      sectionVisible: visible(section),
      title: section?.querySelector('h4')?.textContent,
      sectionHeight: sr ? Math.round(sr.height) : 0,
      recVisible: visible(rec),
      recText: q('timing-recommended-value')?.textContent,
      recSeconds: rec?.getAttribute('data-seconds'),
      recFontPx: rec
        ? parseFloat(getComputedStyle(q('timing-recommended-value')).fontSize)
        : 0,
      resultText: visible(q('timing-result')) ? q('timing-result').textContent : null,
      resultState: q('timing-result')?.getAttribute('data-state'),
      resultFront: q('timing-result')?.getAttribute('data-front'),
      fitVisible: visible(q('timing-fit')),
      underVisible: visible(q('timing-under-minimum')),
      detailsOpen: details?.open ?? null,
      detailsInSection: Boolean(section?.contains(details)),
      cautionsVisible: visible(q('capture-cautions')),
      overflowX: body ? body.scrollWidth > body.clientWidth + 1 : null,
      docOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 1,
      speedLabel: [...document.querySelectorAll('#drone-plan-panel label, #drone-plan-panel .gev-dp-field')]
        .map((n) => n.textContent)
        .find((t) => /Speed/.test(t) && /mph/.test(t)),
    };
  });

async function scrollTo(page, role) {
  await page.evaluate((r) => {
    const n = document.querySelector(`#drone-plan-panel [data-role="${r}"]`);
    n?.scrollIntoView({ block: 'start' });
  }, role);
  await wait(300);
}

/** Select what is in the field (Ctrl+A) and type over it, as a person would. */
async function replaceValue(page, input, text) {
  await input.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(text);
}

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
  await planReady(page, `${label} box`);
  // Open the Shots step if it is collapsed, then pick Timed shot.
  await page.evaluate(() => {
    const t = document.querySelector('#drone-plan-panel [data-role="timing"]');
    for (let n = t; n; n = n.parentElement) {
      if (n.tagName === 'DETAILS') n.open = true;
    }
  });
  await page.evaluate(() => {
    window.__gevDronePlan.applyOptions({ captureMode: 'timed', speedMs: 6.7056 });
  });
  await wait(1500);
  await planReady(page, `${label} timed`);
  await scrollTo(page, 'timing');

  const before = await readSection(page);
  console.log(`${label} before:`, JSON.stringify(before));
  check(`${label}: the Speed & photo timing section is visible`, before.sectionVisible);
  check(
    `${label}: the speed reads in m/s or ft/s and in mph (15 mph = 6.7 m/s)`,
    /mph/.test(before.speedLabel ?? '') && /15\.0 mph/.test(before.speedLabel ?? ''),
    before.speedLabel,
  );
  check(
    `${label}: the recommended interval is the large headline number`,
    before.recVisible && /\d/.test(before.recText ?? '') && before.recFontPx >= 18,
    `${before.recText} @ ${before.recFontPx}px`,
  );
  check(
    `${label}: the long readout is folded into Details, closed`,
    before.detailsInSection && before.detailsOpen === false,
  );
  await page.screenshot({
    path: path.join(SHOT_DIR, `${label}-1-recommended.jpg`),
    type: 'jpeg',
    quality: 85,
  });

  // Type 7 s into the interval field the way a person does.
  const input = await page.$('#drone-plan-panel [data-role="timing-interval"]');
  await replaceValue(page, input, '7');
  await wait(500);
  const typed = await readSection(page);
  console.log(`${label} 7 s:`, JSON.stringify(typed));
  check(
    `${label}: 7 s shows the resulting front overlap at once`,
    /% front overlap/.test(typed.resultText ?? '') && typed.resultFront != null,
    typed.resultText,
  );
  await page.screenshot({
    path: path.join(SHOT_DIR, `${label}-2-seven-seconds.jpg`),
    type: 'jpeg',
    quality: 85,
  });

  // A too-long interval: the warning is visible and the speed is unchanged.
  await replaceValue(page, input, '15');
  await wait(500);
  const longer = await readSection(page);
  check(
    `${label}: a 15 s interval at this speed says the overlap falls short`,
    longer.resultState === 'short' || longer.resultState === 'gap',
    `${longer.resultState}: ${longer.resultText}`,
  );
  check(`${label}: the fit offer is visible`, longer.fitVisible);
  const speedAfter = await page.evaluate(
    () => window.__gevDronePlan.getState().options.speedMs,
  );
  check(
    `${label}: the speed was not changed by typing the interval`,
    Math.abs(speedAfter - 6.7056) < 1e-9,
    String(speedAfter),
  );
  await page.screenshot({
    path: path.join(SHOT_DIR, `${label}-3-too-long.jpg`),
    type: 'jpeg',
    quality: 85,
  });

  // Details opens to the full readout.
  await page.evaluate(() => {
    document.querySelector('#drone-plan-panel [data-role="capture-details"]').open = true;
  });
  await wait(300);
  await scrollTo(page, 'capture-details');
  await page.screenshot({
    path: path.join(SHOT_DIR, `${label}-4-details-open.jpg`),
    type: 'jpeg',
    quality: 85,
  });
  const opened = await readSection(page);
  check(`${label}: nothing overflows sideways`, !opened.overflowX && !opened.docOverflow);
  await page.evaluate(() => {
    document.querySelector('#drone-plan-panel [data-role="capture-details"]').open = false;
  });
  // Back to a sensible interval for the export check.
  await replaceValue(page, input, '5');
  await wait(1500);
  await planReady(page, `${label} 5 s`);
}

/** PLAN ALL rows as the page shows them. */
const readSuiteRows = (page) =>
  page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        '#drone-plan-panel [data-role="timing-suite-row"]',
      ),
    ];
    const stale = document.querySelector(
      '#drone-plan-panel [data-role="timing-suite-stale"]',
    );
    const rec = document.querySelector(
      '#drone-plan-panel [data-role="timing-recommended"]',
    );
    return {
      fronts: rows.map((r) => r.getAttribute('data-front')),
      texts: rows.map((r) => r.textContent),
      stale: stale ? stale.textContent : null,
      recHidden: rec ? rec.hidden : null,
      pattern: window.__gevDronePlan.getState().options.pattern,
      suitePlanned: Boolean(window.__gevDronePlan.getState().suite),
    };
  });

async function planAllReady(page, label) {
  await page.evaluate(() => {
    document
      .querySelector('#drone-plan-panel [data-action="plan-suite"]')
      .click();
  });
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#drone-plan-panel [data-role="timing-suite-row"]',
        ).length >= 3,
      { timeout: 120_000 },
    );
    check(`${label}: PLAN ALL gives a row for each survey pass`, true);
  } catch {
    check(`${label}: PLAN ALL gives a row for each survey pass`, false, 'timed out');
  }
}

/**
 * PLAN ALL timing rows: read with the interval each pass was planned with,
 * flagged when the field moves on, and still shown when the single pattern is
 * an orbit. Leaves the original single pattern planned again.
 */
async function suiteChecks(page, label) {
  const pattern = await page.evaluate(
    () => window.__gevDronePlan.getState().options.pattern,
  );
  await planAllReady(page, label);
  await scrollTo(page, 'timing-suite');
  const fresh = await readSuiteRows(page);
  console.log(`${label} PLAN ALL rows:`, JSON.stringify(fresh));
  check(`${label}: a fresh PLAN ALL is not marked old`, fresh.stale === null);
  // Change the interval in the field and read in the same tick, before the
  // waiting replan drops the suite.
  const changed = await page.evaluate(() => {
    const input = document.querySelector(
      '#drone-plan-panel [data-role="timing-interval"]',
    );
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [
      ...document.querySelectorAll(
        '#drone-plan-panel [data-role="timing-suite-row"]',
      ),
    ];
    const stale = document.querySelector(
      '#drone-plan-panel [data-role="timing-suite-stale"]',
    );
    return {
      fronts: rows.map((r) => r.getAttribute('data-front')),
      stale: stale ? stale.textContent : null,
    };
  });
  check(
    `${label}: after the interval changes the rows keep the planned figures`,
    JSON.stringify(changed.fronts) === JSON.stringify(fresh.fronts),
    `${fresh.fronts} -> ${changed.fronts}`,
  );
  check(
    `${label}: and a note says PLAN ALL must be pressed again`,
    /Press PLAN ALL RECOMMENDED PASSES again/.test(changed.stale ?? ''),
    changed.stale ?? 'no note',
  );
  await page.screenshot({
    path: path.join(SHOT_DIR, `${label}-5-plan-all-old.jpg`),
    type: 'jpeg',
    quality: 85,
  });
  await wait(2500);
  await planReady(page, `${label} 9 s`);
  // The single pattern is an orbit: the survey passes keep their rows.
  await page.evaluate(() => window.__gevDronePlan.applyOptions({ pattern: 'orbit' }));
  await wait(2500);
  await planReady(page, `${label} orbit`);
  await planAllReady(page, `${label} orbit`);
  await scrollTo(page, 'timing-suite');
  const orbit = await readSuiteRows(page);
  check(
    `${label}: with Orbit as the single pattern the PLAN ALL rows still show`,
    orbit.pattern === 'orbit' && orbit.fronts.length >= 3 && orbit.recHidden === true,
    `${orbit.fronts.length} rows, pattern ${orbit.pattern}`,
  );
  check(`${label}: and they are not marked old`, orbit.stale === null);
  await page.screenshot({
    path: path.join(SHOT_DIR, `${label}-6-plan-all-orbit.jpg`),
    type: 'jpeg',
    quality: 85,
  });
  await page.evaluate((p) => window.__gevDronePlan.applyOptions({ pattern: p }), pattern);
  await wait(2500);
  await planReady(page, `${label} back to ${pattern}`);
}

try {
  const desktop = await browser.newPage();
  const dErrors = await boot(desktop, { width: 1280, height: 860 });
  await exercise(desktop, 'desktop');
  await suiteChecks(desktop, 'desktop');
  // Export one mission and read every waypoint.
  const client = await desktop.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
  });
  await desktop.evaluate(() => window.__gevDronePlan.downloadMission(0));
  let kmz = null;
  for (let i = 0; i < 80 && !kmz; i += 1) {
    await wait(250);
    kmz = fs.readdirSync(DOWNLOADS).find((f) => f.endsWith('.kmz')) ?? null;
  }
  check('the KMZ downloaded', Boolean(kmz), kmz ?? '');
  if (kmz) {
    const files = readZip(new Uint8Array(fs.readFileSync(path.join(DOWNLOADS, kmz))));
    const name = [...files.keys()].find((n) => n.endsWith('waylines.wpml'));
    const wpml = new TextDecoder().decode(files.get(name));
    const marks = wpml.split('<Placemark>').slice(1);
    const withSpeed = marks.filter((m) => /<wpml:waypointSpeed>[\d.]+</.test(m)).length;
    const withGimbal = marks.filter((m) => m.includes('<wpml:actionActuatorFunc>gimbalRotate<')).length;
    check(
      `every waypoint in the file carries a speed (${withSpeed}/${marks.length}) and a gimbal angle (${withGimbal}/${marks.length})`,
      marks.length > 2 && withSpeed === marks.length && withGimbal === marks.length,
    );
    check(
      'the file takes no photos in Timed shot (no takePhoto action)',
      !wpml.includes('takePhoto'),
    );
  }
  const dFatal = dErrors.filter((e) => !/WebGL|swiftshader|GPU|net::|Failed to load resource/i.test(e));
  check('no page errors on desktop', dFatal.length === 0, dFatal.join(' | '));
  await desktop.close();

  const phone = await browser.newPage();
  const pErrors = await boot(phone, {
    width: 375,
    height: 812,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await exercise(phone, 'phone');
  await suiteChecks(phone, 'phone');
  const pFatal = pErrors.filter((e) => !/WebGL|swiftshader|GPU|net::|Failed to load resource/i.test(e));
  check('no page errors on the phone', pFatal.length === 0, pFatal.join(' | '));
} catch (error) {
  console.error(error);
  failures.push(`crash: ${error.message}`);
} finally {
  await browser.close();
}
console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nALL PASSED',
);
process.exit(failures.length ? 1 : 0);
