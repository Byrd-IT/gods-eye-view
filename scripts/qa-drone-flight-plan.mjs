#!/usr/bin/env node
/**
 * Rendered acceptance for DISPLAY > Drone Flight Plan: real clicks and a real
 * drag on the globe, the stats and warnings in the right-rail card, the
 * downloaded DJI Fly KMZ opened and parsed, Escape, the takeoff pick, and a
 * 375 px phone viewport.
 *
 *   QA_BASE_URL   app to test (default http://127.0.0.1:5231)
 *   QA_SHOT_DIR   screenshots and downloaded files (default qa-shots/drone-plan)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { readZip } from '../src/byrdit/dronePlan/zip.js';

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:5231';
const SHOT_DIR = path.resolve(process.env.QA_SHOT_DIR || 'qa-shots/drone-plan');
const DOWNLOADS = path.join(SHOT_DIR, 'downloads');
// A neutral public site (the Great Lawn in Zilker Park, Austin): open ground,
// plain imagery. QA_LON / QA_LAT point the run somewhere else.
const VIEW = {
  lon: Number(process.env.QA_LON ?? -97.7729),
  lat: Number(process.env.QA_LAT ?? 30.2663),
  height: 700,
  heading: 0,
  pitch: -90,
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
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`,
  );
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
    { timeout: 120_000 },
  );
  await page.evaluate((view) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.scene.tweens?.removeAll?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (view.lon * Math.PI) / 180,
        latitude: (view.lat * Math.PI) / 180,
        height: view.height,
      }),
      orientation: {
        heading: (view.heading * Math.PI) / 180,
        pitch: (view.pitch * Math.PI) / 180,
        roll: 0,
      },
    });
    viewer.scene.requestRender();
  }, VIEW);
  await wait(Number(process.env.QA_SETTLE_MS || 9000));
  return errors;
}

const stats = (page) =>
  page.evaluate(() => {
    const dts = [
      ...document.querySelectorAll('#drone-plan-panel .gev-dp-stats dt'),
    ];
    const out = {};
    for (const dt of dts)
      out[dt.textContent] = dt.nextElementSibling?.textContent;
    return out;
  });
const status = (page) =>
  page.evaluate(
    () =>
      document.querySelector('#drone-plan-panel .gev-dp-status')?.textContent,
  );

async function waitForPlan(page, timeout = 60_000) {
  await page.waitForFunction(
    () =>
      document.getElementById('drone-plan-panel')?.dataset.state === 'ready',
    { timeout },
  );
}

async function download(page, selector) {
  const before = new Set(fs.readdirSync(DOWNLOADS));
  await page.click(selector);
  for (let i = 0; i < 60; i += 1) {
    await wait(250);
    const fresh = fs
      .readdirSync(DOWNLOADS)
      .filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (fresh.length) return path.join(DOWNLOADS, fresh[0]);
  }
  return null;
}

const decode = (b) => new TextDecoder().decode(b);

/**
 * Cyan pixels in a clip of the globe (clear of the right rail): the plan's
 * paths and dashed box are the only strongly cyan marks on this scene, so the
 * count rising after the plan is built is the plan actually painting. Decoded
 * in the page because node has no image decoder here.
 */
const CLIP = { x: 340, y: 180, width: 540, height: 430 };
async function cyanPixels(page) {
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await wait(1200);
  const b64 = await page.screenshot({
    clip: CLIP,
    type: 'png',
    encoding: 'base64',
  });
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${data}`)).blob(),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (
        px[i + 2] > 200 &&
        px[i + 1] > 150 &&
        px[i] < 130 &&
        px[i + 2] - px[i] > 100
      )
        n += 1;
    }
    return n;
  }, b64);
}

try {
  // ------------------------------------------------------------ desktop --
  const page = await browser.newPage();
  const errors = await boot(page, { width: 1280, height: 860 });
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
  });

  await page.evaluate(() => {
    const rail = document.getElementById('pp-toggles');
    if (rail?.classList.contains('collapsed'))
      document
        .querySelector('.panel-collapse-btn[data-collapse-target="pp-toggles"]')
        ?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById('drone-plan-button')?.getBoundingClientRect()
        .width > 0,
    { timeout: 10_000 },
  );
  check(
    'the Drone Flight Plan entry is on the DISPLAY rail and starts off',
    await page.evaluate(() => {
      const b = document.getElementById('drone-plan-button');
      return (
        b.getAttribute('aria-pressed') === 'false' &&
        b.textContent.includes('Drone Flight Plan') &&
        document.getElementById('drone-plan-panel').hidden === true
      );
    }),
  );

  await page.click('#drone-plan-button');
  await wait(400);
  const opened = await page.evaluate(() => {
    const panel = document.getElementById('drone-plan-panel');
    const rect = panel.getBoundingClientRect();
    return {
      hidden: panel.hidden,
      collapsed: panel.classList.contains('collapsed'),
      width: rect.width,
      boxCursor: document.body.classList.contains('gev-drone-box'),
      pressed: document
        .getElementById('drone-plan-button')
        .getAttribute('aria-pressed'),
      drawArmed: document
        .querySelector('#drone-plan-panel .gev-dp-bar button')
        ?.getAttribute('aria-pressed'),
    };
  });
  check(
    'the card opens expanded on the right rail',
    !opened.hidden && !opened.collapsed && opened.width > 200,
    JSON.stringify(opened),
  );
  check(
    'the pointer is claimed for the box drag (crosshair cursor class)',
    opened.boxCursor && opened.drawArmed === 'true',
  );

  // Escape cancels the box session and gives the pointer back.
  await page.keyboard.press('Escape');
  await wait(250);
  check(
    'Escape cancels the box drag and releases the pointer',
    await page.evaluate(
      () => !document.body.classList.contains('gev-drone-box'),
    ),
  );
  await page.click('#drone-plan-panel .gev-dp-bar button');
  await wait(250);

  const cyanBefore = await cyanPixels(page);
  // Drag a box on the globe, clear of the panels.
  await page.mouse.move(420, 260);
  await page.mouse.down();
  await page.mouse.move(600, 360, { steps: 6 });
  await page.mouse.move(760, 520, { steps: 6 });
  await page.mouse.up();
  await waitForPlan(page);
  const s1 = await stats(page);
  console.log('stats:', JSON.stringify(s1));
  const result1 = await page.evaluate(() => {
    const r = window.__gevDronePlan.getResult();
    return {
      missions: r.missions.length,
      photos: r.totals.photoCount,
      gsd: r.totals.gsdCm,
      wps: r.missions.map((m) => m.waypointCount),
      known: r.ground.known,
      warnings: r.warnings.map((w) => w.code),
      takeoff: r.plan.takeoff,
      box: r.plan.box,
      maxAgl: Math.max(
        ...r.missions.flatMap((m) => m.waypoints.map((w) => w.aglM)),
      ),
    };
  });
  console.log('result:', JSON.stringify(result1));
  check(
    'dragging a box produces a plan with photos and ground detail',
    result1.photos > 0 && result1.gsd > 0,
  );
  check(
    'the stats list shows photos, ground detail, route, flight time, missions and waypoints',
    [
      'Photos',
      'Ground detail',
      'Route',
      'Flight time',
      'Missions',
      'Waypoints',
    ].every((k) => s1[k]),
    Object.keys(s1).join(', '),
  );
  check(
    'every mission has at most 200 waypoints',
    result1.wps.every((n) => n <= 200),
    result1.wps.join('/'),
  );
  check(
    'the height is capped at 120 m',
    result1.maxAgl <= 120,
    `${result1.maxAgl} m`,
  );
  check(
    'terrain heights were read (or the flat-ground warning is shown)',
    result1.known || result1.warnings.includes('terrain-unknown'),
    `known=${result1.known}`,
  );
  check(
    'the plan is drawn on the globe (path, waypoints, takeoff)',
    await page.evaluate(() => {
      const ds = window.__godsEyeView.viewer.dataSources;
      for (let i = 0; i < ds.length; i += 1) {
        const d = ds.get(i);
        if (d.name === 'gev-drone-plan') {
          const e = d.entities.values;
          return (
            e.some((x) => x.polyline && x.name) &&
            e.some((x) => x.name === 'Takeoff') &&
            e.filter((x) => x.point).length > 5
          );
        }
      }
      return false;
    }),
  );
  const cyanAfter = await cyanPixels(page);
  check(
    'the planned paths and waypoints actually paint on the globe',
    cyanAfter > cyanBefore + 200,
    `cyan pixels ${cyanBefore} -> ${cyanAfter}`,
  );
  check(
    'the "reading terrain" line is gone once the plan is ready',
    !/Reading terrain/.test((await status(page)) || ''),
    await status(page),
  );
  await page.screenshot({
    path: path.join(SHOT_DIR, 'drone-plan-desktop.jpg'),
    type: 'jpeg',
    quality: 85,
  });

  // Options change the plan.
  await page.select('#drone-plan-panel select[aria-label="Pattern"]', 'double');
  await wait(1200);
  await waitForPlan(page);
  const dbl = await page.evaluate(() => {
    const r = window.__gevDronePlan.getResult();
    return {
      pitches: [
        ...new Set(
          r.missions.flatMap((m) => m.waypoints.map((w) => w.pitchDeg)),
        ),
      ],
      passes: r.plan.passCount,
    };
  });
  check(
    'Double grid flies two tilted passes at -60 degrees',
    dbl.passes === 2 && dbl.pitches.join() === '-60',
    JSON.stringify(dbl),
  );
  await cyanPixels(page);
  await page.screenshot({
    path: path.join(SHOT_DIR, 'drone-plan-double-grid.jpg'),
    type: 'jpeg',
    quality: 80,
  });
  await page.select('#drone-plan-panel select[aria-label="Pattern"]', 'grid');
  await wait(600);
  await page.$eval(
    '#drone-plan-panel input[aria-label="Height above ground"]',
    (el) => {
      el.value = '120';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
  );
  await wait(900);
  await waitForPlan(page);
  const readout = await page.evaluate(() => {
    const row = [
      ...document.querySelectorAll('#drone-plan-panel .gev-dp-row'),
    ].find((r) => r.textContent.includes('Height above ground'));
    return row?.querySelector('output')?.textContent;
  });
  check(
    '120 m shows its feet value (394 ft)',
    /120 m/.test(readout) && /394 ft/.test(readout),
    readout,
  );

  // Takeoff pick.
  await page.click(
    '#drone-plan-panel button[title="Click the globe to place the takeoff point"]',
  );
  await wait(200);
  await page.mouse.click(430, 270);
  await wait(1500);
  await waitForPlan(page);
  const takeoff = await page.evaluate(() => ({
    custom: window.__gevDronePlan.getResult().plan.takeoff.custom,
    text: document.querySelector('#drone-plan-panel .gev-dp-coords')
      ?.textContent,
  }));
  check(
    'clicking the globe sets the takeoff point',
    takeoff.custom === true && !/centre/.test(takeoff.text),
    JSON.stringify(takeoff),
  );

  // Download one KMZ and parse it.
  const kmzPath = await download(
    page,
    '#drone-plan-panel button[data-mission="0"]',
  );
  check(
    'a KMZ downloads',
    Boolean(kmzPath) && kmzPath.endsWith('.kmz'),
    kmzPath ?? 'none',
  );
  if (kmzPath) {
    const files = readZip(new Uint8Array(fs.readFileSync(kmzPath)));
    const names = [...files.keys()];
    check(
      'the KMZ holds wpmz/template.kml and wpmz/waylines.wpml',
      names.join() === 'wpmz/template.kml,wpmz/waylines.wpml',
      names.join(),
    );
    const way = decode(files.get('wpmz/waylines.wpml'));
    const tpl = decode(files.get('wpmz/template.kml'));
    const marks = (way.match(/<Placemark>/g) || []).length;
    const expect = await page.evaluate(
      () => window.__gevDronePlan.getResult().missions[0].waypointCount,
    );
    check(
      'waylines.wpml has every waypoint',
      marks === expect && marks > 0,
      `${marks} vs ${expect}`,
    );
    check(
      'template.kml carries the same waypoints',
      (tpl.match(/<Placemark>/g) || []).length === marks,
    );
    check(
      'takePhoto and gimbalRotate actions are present',
      /takePhoto/.test(way) && /gimbalRotate/.test(way),
    );
    check(
      'the mission finishes by going home',
      /<wpml:finishAction>goHome</.test(way),
    );
    check(
      'heights are relative to the takeoff point',
      /<wpml:executeHeightMode>relativeToStartPoint</.test(way),
    );
    check(
      'the DJI WPML namespace is declared',
      /xmlns:wpml="http:\/\/www\.uav\.com\/wpmz\/1\.0\.2"/.test(way),
    );
    const idx = [...way.matchAll(/<wpml:index>(\d+)</g)].map((m) =>
      Number(m[1]),
    );
    check(
      'waypoint indexes run 0..n-1',
      idx.every((v, i) => v === i),
    );
    fs.copyFileSync(kmzPath, path.join(SHOT_DIR, 'live-sample-mission.kmz'));
  }
  const zipPath = await download(
    page,
    '#drone-plan-panel button[data-download="all"]',
  );
  check(
    'the ZIP of all missions downloads',
    Boolean(zipPath) && zipPath.endsWith('.zip'),
    zipPath ?? 'none',
  );
  if (zipPath) {
    const files = readZip(new Uint8Array(fs.readFileSync(zipPath)));
    const names = [...files.keys()];
    const missions = await page.evaluate(
      () => window.__gevDronePlan.getResult().missions.length,
    );
    check(
      'the ZIP has one KMZ per mission plus a README',
      names.filter((n) => n.endsWith('.kmz')).length === missions &&
        names.includes('README.txt'),
      names.join(', '),
    );
  }

  // Orbit.
  await page.select('#drone-plan-panel select[aria-label="Pattern"]', 'orbit');
  await wait(1500);
  await waitForPlan(page);
  const orbit = await page.evaluate(() => {
    const r = window.__gevDronePlan.getResult();
    return {
      legs: r.missions.flatMap((m) => m.legs).map((l) => l.kind),
      photos: r.totals.photoCount,
    };
  });
  check(
    'Orbit flies rings around the centre',
    orbit.legs.length >= 1 && orbit.legs.every((k) => k === 'orbit'),
    JSON.stringify(orbit),
  );
  await cyanPixels(page);
  await page.screenshot({
    path: path.join(SHOT_DIR, 'drone-plan-orbit.jpg'),
    type: 'jpeg',
    quality: 80,
  });

  // Polygon plus an overlapping rectangle: one flown area, a folder per job.
  await page.select('#drone-plan-panel select[aria-label="Pattern"]', 'grid');
  await page.click('#drone-plan-panel .gev-dp-bar button:nth-child(2)');
  await wait(300);
  await page.click('#drone-plan-button');
  await wait(300);
  await page.keyboard.press('Escape');
  await page.click(
    '#drone-plan-panel .gev-dp-bar button[data-action="draw-polygon"]',
  );
  await wait(200);
  for (const [x, y] of [
    [430, 280],
    [620, 280],
    [700, 430],
    [480, 500],
  ]) {
    await page.mouse.click(x, y);
    await wait(80);
  }
  await page.mouse.click(430, 280);
  await waitForPlan(page);
  await page.click('#drone-plan-panel .gev-dp-bar button');
  await wait(200);
  await page.mouse.move(500, 340);
  await page.mouse.down();
  await page.mouse.move(760, 520, { steps: 6 });
  await page.mouse.up();
  await waitForPlan(page);
  const merged = await page.evaluate(() => {
    const r = window.__gevDronePlan.getResult();
    const areas = window.__gevDronePlan.getState().areas;
    return {
      areas: areas.map((area) => area.kind),
      jobs: (r.jobs ?? []).map((job) => job.name),
      missions: r.missions.length,
      photos: r.totals.photoCount,
    };
  });
  console.log('merged:', JSON.stringify(merged));
  check(
    'a polygon and an overlapping rectangle are both on the plan',
    merged.areas.includes('polygon') && merged.areas.includes('rect'),
    JSON.stringify(merged),
  );
  check(
    'the plan has a processing job for each area',
    merged.jobs.length === 2,
    JSON.stringify(merged),
  );
  const jobZip = await download(
    page,
    '#drone-plan-panel button[data-download="all"]',
  );
  if (jobZip) {
    const jobFiles = readZip(new Uint8Array(fs.readFileSync(jobZip)));
    const jobNames = [...jobFiles.keys()];
    const folders = new Set(
      jobNames
        .filter((name) => name.includes('/'))
        .map((name) => name.split('/')[0]),
    );
    check(
      'the ZIP has a folder per processing job and a README',
      folders.size === merged.jobs.length && jobNames.includes('README.txt'),
      jobNames.join(', '),
    );
    const readme = new TextDecoder().decode(jobFiles.get('README.txt'));
    check(
      'the README says images from one job should be processed together',
      /processed together \(ODM\)/.test(readme) && /Job: /.test(readme),
      readme.slice(0, 400),
    );
  }
  await page.screenshot({
    path: path.join(SHOT_DIR, 'drone-plan-polygon.jpg'),
    type: 'jpeg',
    quality: 80,
  });

  // Close clears the globe and the pointer.
  await page.click('#drone-plan-panel .gev-dp-bar button:nth-child(2)');
  await wait(400);
  check(
    'CLOSE hides the card and clears the plan from the globe',
    await page.evaluate(() => {
      const ds = window.__godsEyeView.viewer.dataSources;
      let left = 0;
      for (let i = 0; i < ds.length; i += 1)
        if (ds.get(i).name === 'gev-drone-plan')
          left = ds.get(i).entities.values.length;
      return (
        document.getElementById('drone-plan-panel').hidden &&
        left === 0 &&
        !document.body.classList.contains('gev-drone-box')
      );
    }),
  );
  const fatal = errors.filter(
    (e) => !/WebGL|swiftshader|GPU|net::|Failed to load resource/i.test(e),
  );
  check('no page errors on desktop', fatal.length === 0, fatal.join(' | '));
  await page.close();

  // -------------------------------------------------------------- phone --
  const phone = await browser.newPage();
  const phoneErrors = await boot(phone, {
    width: 375,
    height: 812,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await phone.evaluate((view) => {
    window.__gevDronePlan.open({ draw: false });
    window.__gevDronePlan.setBox({
      west: view.lon - 0.001,
      south: view.lat - 0.0005,
      east: view.lon + 0.001,
      north: view.lat + 0.0005,
    });
  }, VIEW);
  await wait(2500);
  await waitForPlan(phone).catch(() => {});
  const mobile = await phone.evaluate(() => {
    const panel = document.getElementById('drone-plan-panel');
    const r = panel.getBoundingClientRect();
    const body = document.getElementById('drone-plan-panel-body');
    return {
      hidden: panel.hidden,
      shown: r.width > 0 && r.height > 0,
      left: r.left,
      right: r.right,
      vw: window.innerWidth,
      overflowX: body.scrollWidth > body.clientWidth + 1,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      shell: document.body.classList.contains('mobile-shell'),
      state: panel.dataset.state,
    };
  });
  console.log('mobile:', JSON.stringify(mobile));
  check(
    '375 px: the card is visible and inside the screen',
    !mobile.hidden &&
      mobile.shown &&
      mobile.left >= -1 &&
      mobile.right <= mobile.vw + 1,
    JSON.stringify(mobile),
  );
  check(
    '375 px: nothing overflows sideways',
    !mobile.overflowX && !mobile.docOverflow,
  );
  await phone.evaluate(() => {
    document
      .querySelectorAll(
        '#right-context-rail, #drone-plan-panel, .drone-plan-panel-inner',
      )
      .forEach((n) => {
        n.scrollTop = 0;
      });
  });
  await wait(400);
  await phone.screenshot({
    path: path.join(SHOT_DIR, 'drone-plan-375.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  const phoneFatal = phoneErrors.filter(
    (e) => !/WebGL|swiftshader|GPU|net::|Failed to load resource/i.test(e),
  );
  check(
    'no page errors on the phone',
    phoneFatal.length === 0,
    phoneFatal.join(' | '),
  );
} catch (error) {
  console.error(error);
  failures.push(`crash: ${error.message}`);
} finally {
  await browser.close();
}
console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join('; ')}`
    : '\nALL PASSED',
);
process.exit(failures.length ? 1 : 0);
