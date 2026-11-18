#!/usr/bin/env node
/**
 * Rendered check of the grid Gimbal angle and the Recommended Gimbal line,
 * at phone (390x844, touch) and desktop (1280x900), with real input.
 *   QA_BASE_URL  app to test     QA_SHOT_DIR  screenshots (optional)
 *   QA_KMZ=1     also build each mission's waylines.wpml in the page (dev server only)
 */
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:5234';
const SHOTS = process.env.QA_SHOT_DIR || '';
const KMZ = process.env.QA_KMZ === '1';
const VIEW = { lon: -97.7729, lat: 30.2663, height: 900 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${msg}`);
  if (!ok) failures.push(msg);
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});

async function boot(page, viewport) {
  await page.setViewport(viewport);
  await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.waitForFunction(
    () =>
      window.__gevDronePlan &&
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 240_000 },
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
  }, VIEW);
  await wait(5000);
}

const ready = (page) =>
  page.waitForFunction(
    () => {
      const p = document.getElementById('drone-plan-panel');
      const s = window.__gevDronePlan.getState();
      return p?.dataset.state === 'ready' && !s.dirty;
    },
    { timeout: 120_000 },
  );

const read = (page, kmz) =>
  page.evaluate(async (kmz) => {
    const s = window.__gevDronePlan.getState();
    const r = window.__gevDronePlan.getResult?.() ?? s.result;
    const slider = (label) =>
      [...document.querySelectorAll('#drone-plan-panel input[type=range]')].find(
        (n) => n.getAttribute('aria-label') === label,
      );
    const g = slider('Gimbal angle');
    const tilt = slider('Camera tilt');
    const dts = [...document.querySelectorAll('#drone-plan-panel dt')];
    const gimbalDt = dts.find((d) => d.textContent === 'Gimbal');
    const pitches = [
      ...new Set(
        (r?.missions ?? []).flatMap((m) => m.legs.flatMap((l) => l.waypoints.map((w) => w.pitchDeg))),
      ),
    ];
    let kmzPitches = null;
    if (kmz && r?.missions?.length) {
      const wpml = await import('/src/byrdit/dronePlan/wpml.js');
      kmzPitches = [];
      for (const m of r.missions) {
        const { waylinesWpml } = wpml.buildMissionFiles(m, r.plan);
        for (const x of waylinesWpml.matchAll(/<wpml:(?:waypointGimbalPitchAngle|gimbalPitchRotateAngle)>([^<]+)</g))
          if (!kmzPitches.includes(x[1])) kmzPitches.push(x[1]);
      }
    }
    const note = document.querySelector('#drone-plan-panel [data-role=gimbal-note]');
    return {
      pattern: s.options.pattern,
      capture: s.options.captureMode,
      grid: s.options.gridPitchDeg,
      tilt: s.options.tiltPitchDeg,
      gValue: g?.value,
      gMax: g?.max,
      gVisible: g ? g.offsetParent !== null : null,
      tiltVisible: tilt ? tilt.offsetParent !== null : null,
      gimbalLine: gimbalDt?.nextElementSibling?.textContent ?? null,
      noteVisible: note ? note.offsetParent !== null : null,
      planGrid: r?.plan?.options?.gridPitchDeg,
      pitches,
      kmzPitches,
    };
  }, kmz);

const box = (page, label) =>
  page.evaluate((label) => {
    const el = [...document.querySelectorAll('#drone-plan-panel input[type=range]')].find(
      (n) => n.getAttribute('aria-label') === label,
    );
    for (let n = el; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left, y: r.top, w: r.width, h: r.height, hit: hit === el };
  }, label);

const select = (page, value) =>
  page.evaluate((value) => {
    const sel = [...document.querySelectorAll('#drone-plan-panel select')].find((s) =>
      [...s.options].some((o) => o.value === value),
    );
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);

async function exercise(page, label, touch) {
  await page.evaluate((view) => {
    window.__gevDronePlan.open({ draw: false });
    window.__gevDronePlan.setBox({
      west: view.lon - 0.001,
      south: view.lat - 0.0005,
      east: view.lon + 0.001,
      north: view.lat + 0.0005,
    });
  }, VIEW);
  await ready(page);
  await select(page, 'mapping-grid-timed');
  await wait(800);
  await page.evaluate(() =>
    [...document.querySelectorAll('#drone-plan-panel button')]
      .find((n) => /USE RECOMMENDED/i.test(n.textContent))
      ?.click(),
  );
  await wait(800);
  await ready(page);
  let r = await read(page, false);
  console.log(`${label}: start ${JSON.stringify(r)}`);
  check(r.pattern === 'grid' && r.capture === 'timed', `${label}: Timed grid`);
  check(r.gVisible === true && r.gMax === '-35', `${label}: Gimbal angle visible, -90..-35`);
  check(r.gimbalLine === '-90° straight down', `${label}: Gimbal line "${r.gimbalLine}"`);
  check(r.noteVisible === true, `${label}: DJI Fly check note visible`);

  // Real pointer drag to -60.
  let b = await box(page, 'Gimbal angle');
  check(b.hit, `${label}: nothing covers the Gimbal angle slider`);
  const xFor = (v) => b.x + 8 + (b.w - 16) * ((v + 90) / 55);
  const y = b.y + b.h / 2;
  if (touch) {
    await page.touchscreen.touchStart(xFor(-90), y);
    for (let i = 1; i <= 12; i++) {
      await page.touchscreen.touchMove(xFor(-90) + ((xFor(-60) - xFor(-90)) * i) / 12, y);
      await wait(30);
    }
    await page.touchscreen.touchEnd();
  } else {
    await page.mouse.move(xFor(-90), y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(xFor(-90) + ((xFor(-60) - xFor(-90)) * i) / 12, y);
      await wait(30);
    }
    await page.mouse.up();
  }
  await wait(600);
  await ready(page);
  r = await read(page, KMZ);
  console.log(`${label}: after drag ${JSON.stringify(r)}`);
  const dragged = r.grid;
  check(dragged > -90 && dragged <= -35 && r.gValue === String(dragged), `${label}: real drag moves the angle off -90 (got ${dragged})`);
  check(Math.abs(dragged + 60) <= 5, `${label}: the drag lands where the finger stops (aimed -60, got ${dragged})`);
  check(
    r.gimbalLine === `${dragged}° tilted forward on every line · recommended -90°`,
    `${label}: Gimbal line follows "${r.gimbalLine}"`,
  );
  check(r.planGrid === dragged && r.pitches.length === 1 && r.pitches[0] === dragged, `${label}: planned waypoints ${dragged} ${JSON.stringify(r.pitches)}`);
  if (KMZ) check(JSON.stringify(r.kmzPitches) === JSON.stringify([String(dragged)]), `${label}: KMZ pitches ${JSON.stringify(r.kmzPitches)}`);

  // Keyboard: two steps steeper; then another slider; value stays.
  const keyed = Math.max(-90, dragged - 10);
  await page.evaluate(() =>
    [...document.querySelectorAll('#drone-plan-panel input[type=range]')]
      .find((n) => n.getAttribute('aria-label') === 'Gimbal angle')
      .focus(),
  );
  await page.keyboard.press('ArrowLeft');
  await wait(150);
  await page.keyboard.press('ArrowLeft');
  await wait(600);
  await page.evaluate(() => window.__gevDronePlan.applyOptions({ frontOverlap: 75 }));
  await wait(600);
  await ready(page);
  r = await read(page, KMZ);
  console.log(`${label}: after keys + other slider ${JSON.stringify(r)}`);
  check(r.grid === keyed && r.gValue === String(keyed), `${label}: keyboard ${keyed} kept after another change (got ${r.grid})`);
  check(r.pitches.length === 1 && r.pitches[0] === keyed, `${label}: planned ${keyed} ${JSON.stringify(r.pitches)}`);
  if (KMZ) check(JSON.stringify(r.kmzPitches) === JSON.stringify([String(keyed)]), `${label}: KMZ ${keyed} ${JSON.stringify(r.kmzPitches)}`);
  // Keyboard to the shallow end: it stops at the aircraft limit.
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('ArrowRight');
    await wait(60);
  }
  await wait(600);
  await ready(page);
  r = await read(page, KMZ);
  check(r.grid === -35 && r.pitches[0] === -35, `${label}: keyboard stops at -35 (got ${r.grid})`);
  if (KMZ) check(JSON.stringify(r.kmzPitches) === '["-35"]', `${label}: KMZ -35 ${JSON.stringify(r.kmzPitches)}`);
  if (SHOTS) {
    await page.evaluate(() => {
      const dt = [...document.querySelectorAll('#drone-plan-panel dt')].find((d) => d.textContent === 'Gimbal');
      dt?.scrollIntoView({ block: 'start' });
    });
    await wait(400);
    await page.screenshot({ path: `${SHOTS}/gimbal-grid-${label}.png` });
  }

  // Double grid: Camera tilt drives the line.
  await select(page, 'double');
  await wait(600);
  b = await box(page, 'Camera tilt');
  const tx = (v) => b.x + 8 + (b.w - 16) * ((v + 80) / 35);
  await page.mouse.click(tx(-75), b.y + b.h / 2);
  await wait(600);
  await ready(page);
  r = await read(page, KMZ);
  console.log(`${label}: double ${JSON.stringify(r)}`);
  check(r.gVisible === false && r.tiltVisible === true, `${label}: double shows Camera tilt, hides Gimbal angle`);
  check(r.tilt === -75, `${label}: tilt -75 (got ${r.tilt})`);
  check(
    r.gimbalLine === '-75° on both crossing passes (no straight-down pass) · recommended -60°',
    `${label}: double Gimbal line "${r.gimbalLine}"`,
  );
  check(r.pitches.length === 1 && r.pitches[0] === -75, `${label}: double planned -75 ${JSON.stringify(r.pitches)}`);
  if (KMZ) check(JSON.stringify(r.kmzPitches) === '["-75"]', `${label}: double KMZ -75 ${JSON.stringify(r.kmzPitches)}`);
  if (SHOTS) {
    await page.evaluate(() => {
      const dt = [...document.querySelectorAll('#drone-plan-panel dt')].find((d) => d.textContent === 'Gimbal');
      dt?.scrollIntoView({ block: 'start' });
    });
    await wait(400);
    await page.screenshot({ path: `${SHOTS}/gimbal-double-${label}.png` });
  }
}

for (const [label, vp, touch] of [
  ['phone-390', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, true],
  ['desktop-1280', { width: 1280, height: 900 }, false],
]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`${label} pageerror: ${e.message}`));
  try {
    await page.evaluateOnNewDocument(() => localStorage.clear());
    await boot(page, vp);
    await exercise(page, label, touch);
  } catch (e) {
    console.log(`[FAIL] ${label}: ${e.message}`);
    failures.push(`${label}: ${e.message}`);
  }
  await page.close();
}
await browser.close();
console.log(failures.length ? `FAILED ${failures.length}: ${failures.join('; ')}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
