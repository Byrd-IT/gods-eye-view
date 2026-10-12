/**
 * Headless-Chromium proof for Sky view P4 "Point at the sky" (t_c29cb4db).
 * Drives the REAL mounted app with Chrome's virtual sensors (CDP
 * Emulation.setSensorOverrideReadings, type absolute-orientation) on an
 * emulated phone (touch, 412x915, DPR 2.625), and records:
 *   A. the button is offered on a touch device; tap -> state on (source)
 *   B. phone pointed at the Moon's MAGNETIC azimuth -> view centre on the
 *      Moon's TRUE position (declination applied), screenshot with the
 *      centre circle on the drawn Moon
 *   C. landscape (screen angle 90) same pose -> same az/el, roll 0
 *   D. smoothing: a 90 deg turn settles within 1 s without overshoot
 *   E. battery: still phone -> no view changes; moving -> <= 30 per second
 *   F. a drag takes over (state off, roll 0, camera moves)
 *   G. sensors denied (Browser.setPermission) -> "denied" message, drag works
 *   H. insecure http host (not localhost) -> "insecure" message with https URL
 * This is the synthetic part only; real phones: src/byrdit/skyView/PHONE-TEST.md.
 *   node scripts/qa-sky-p4.mjs --url http://127.0.0.1:4338 --out <dir>
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { moonState } from '../src/byrdit/skyView/ephemeris.js';
import { declinationDeg } from '../src/byrdit/skyView/declination.js';
import { cameraBasis } from '../src/byrdit/skyView/skyMath.js';
import { quatFromAxes, wrap180 } from '../src/byrdit/skyView/orientationMath.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4338');
const OUT = path.resolve(arg('--out', 'qa-sky-p4'));
const SETTLE_MS = Number(arg('--settle-ms', '15000'));
// H needs a plain-http, non-loopback origin (not a secure context). Vite only
// accepts IP or localhost Host headers, so a short-lived TCP proxy on the
// host's LAN address forwards to the dev server for that one check.
const LAN_IP = arg('--lan-ip', '10.10.99.104');
const LAN_PORT = Number(arg('--lan-port', '4339'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...p) => {
  const line = p
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ');
  log.push(line);
  console.log(line);
};
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  say(ok ? 'PASS' : 'FAIL', name, detail ?? '');
};

// ── a time when the Moon is up over Houston (search from now) ──────────────
const OBS = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
let skyTime = null;
for (let h = 0; h < 24 * 20 && skyTime == null; h += 1) {
  const t = Math.floor(Date.now() / 3_600_000) * 3_600_000 + h * 3_600_000;
  const m = moonState(t, OBS, { refraction: true });
  if (m.elDeg > 25 && m.elDeg < 55) skyTime = t;
}
const moon = moonState(skyTime, OBS, { refraction: true });
const decl = declinationDeg(OBS.latDeg, OBS.lonDeg, Date.now());
say('sky time', new Date(skyTime).toISOString(), 'moon', {
  az: moon.azDeg,
  el: moon.elDeg,
}, 'declination', decl);

/** Virtual-sensor quaternion for the back of the phone at az/el (screen angle). */
function pose(azDeg, elDeg, screenAngle = 0, rollDeg = 0) {
  const { forward, right, up } = cameraBasis({ azDeg, elDeg, rollDeg, fovDeg: 60 });
  const t = (screenAngle * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // device axes from screen axes (inverse of orientationMath.screenBasis)
  const x = right.map((r, i) => c * r + s * up[i]);
  const y = right.map((r, i) => -s * r + c * up[i]);
  const z = forward.map((f) => -f);
  const [qx, qy, qz, qw] = quatFromAxes(x, y, z);
  return { x: qx, y: qy, z: qz, w: qw };
}

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const errors = [];
const PHONE = {
  width: 412,
  height: 915,
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

async function openSky(base, { sensors = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport(PHONE);
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  const cdp = await page.createCDPSession();
  if (sensors)
    await cdp.send('Emulation.setSensorOverrideEnabled', {
      enabled: true,
      type: 'absolute-orientation',
    });
  const iso = new Date(skyTime).toISOString().replace(/\.\d+Z$/, 'Z');
  await page.goto(
    `${base}/?sv=${OBS.latDeg},${OBS.lonDeg},180,30,70,${iso}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 },
  );
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape'); // the first-launch chooser
  await sleep(500);
  return { page, cdp };
}

const HANDLE = `(async () => {
  const m = await import('/src/byrdit/skyView/skyView.js');
  return m.skyViewFor(window.__godsEyeView.viewer) ||
    m.mountSkyView({ viewer: window.__godsEyeView.viewer });
})()`;
const handleEval = (page, fn, arg) =>
  page.evaluate(
    async (src, fnSrc, a) => {
      const h = await eval(src);
      return eval(fnSrc)(h, a);
    },
    HANDLE,
    fn.toString(),
    arg,
  );

async function ensureEntered(page) {
  for (let i = 0; i < 60; i += 1) {
    const s = await handleEval(page, (h) => ({
      active: h.active,
      mode: h.clock.mode,
    }));
    if (s.active) {
      // fold the satellite list so the sky (and the drag area) is clear
      await page.evaluate(() => {
        const fold = document.querySelector('[data-sky=sats-fold]');
        if (fold?.getAttribute('aria-expanded') !== 'false') fold?.click();
      });
      return s;
    }
    await handleEval(page, (h, o) => h.enterAt({ ...o, source: 'manual' }), {
      latDeg: OBS.latDeg,
      lonDeg: OBS.lonDeg,
      heightM: 15,
      heightKnown: true,
    });
    await sleep(2000);
  }
  throw new Error('sky never entered');
}

const readSensor = (cdp, q) =>
  cdp.send('Emulation.setSensorOverrideReadings', {
    type: 'absolute-orientation',
    reading: { quaternion: q },
  });

/** Sample h.view on every animation frame for ms (Cesium loop paused). */
async function sampleViews(page, ms, during) {
  await page.evaluate(async (src, ms) => {
    const h = await eval(src);
    window.__godsEyeView.viewer.useDefaultRenderLoop = false;
    window.__p4 = [];
    const t0 = performance.now();
    const step = () => {
      const v = h.view;
      window.__p4.push([v.azDeg, v.elDeg, v.rollDeg, performance.now() - t0]);
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, HANDLE, ms);
  if (during) await during();
  await sleep(ms + 300);
  return page.evaluate(() => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = true;
    return window.__p4;
  });
}

// ── A-F: sensors allowed ───────────────────────────────────────────────────
{
  const { page, cdp } = await openSky(BASE);
  await ensureEntered(page);
  const offered = await page.evaluate(() => {
    const b = document.querySelector('[data-sky=point]');
    return {
      hidden: b?.hidden,
      coarse: matchMedia('(any-pointer: coarse)').matches,
      secure: isSecureContext,
      aos: typeof AbsoluteOrientationSensor,
    };
  });
  check('A: button offered on a touch phone', offered.hidden === false, offered);

  const magAz = moon.azDeg - decl;
  await readSensor(cdp, pose(magAz, moon.elDeg));
  await page.tap('[data-sky=point]');
  await sleep(1500);
  const on = await handleEval(page, (h) => ({
    state: h.orientation.state,
    source: h.orientation.source,
    info: h.orientation.info,
    view: h.view,
    status: document.querySelector('[data-sky=orient-status]').textContent,
  }));
  say('pointing', on);
  check(
    'A: tap -> pointing on (virtual absolute-orientation sensor)',
    on.state === 'on',
    { state: on.state, source: on.source },
  );
  // B: centre on the Moon (true az = magnetic + declination)
  const missAz = wrap180(on.view.azDeg - moon.azDeg);
  const missEl = on.view.elDeg - moon.elDeg;
  check(
    'B: phone at the Moon\'s magnetic azimuth -> view centre on the true Moon (declination applied)',
    Math.abs(missAz) < 0.1 && Math.abs(missEl) < 0.1,
    { missAz, missEl, decl, status: on.status },
  );
  const drawn = await handleEval(page, (h) => {
    h.redraw();
    const c = document.querySelector('[data-sky=crosshair]');
    const r = c.getBoundingClientRect();
    return {
      crosshair: { x: r.left + r.width / 2, y: r.top + r.height / 2, hidden: c.hidden },
      bodies: h.content.lastStats?.bodyNames,
      canvas: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  check(
    'B: centre circle shown at the screen centre; Moon drawn',
    !drawn.crosshair.hidden &&
      Math.abs(drawn.crosshair.x - drawn.canvas.w / 2) < 2 &&
      drawn.bodies?.includes('Moon'),
    drawn,
  );
  await sleep(4000);
  await page.screenshot({ path: path.join(OUT, '01-pointing-moon-portrait.png') });

  // C: landscape, same pose of the phone's back
  await page.setViewport({ ...PHONE, width: 915, height: 412, isLandscape: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 915,
    height: 412,
    deviceScaleFactor: 2.625,
    mobile: true,
    screenOrientation: { type: 'landscapePrimary', angle: 90 },
  });
  await readSensor(cdp, pose(magAz, moon.elDeg, 90));
  await sleep(1500);
  const land = await handleEval(page, (h) => ({
    view: h.view,
    angle: screen.orientation?.angle,
  }));
  check(
    'C: landscape (angle 90) -> same az/el, roll 0',
    land.angle === 90 &&
      Math.abs(wrap180(land.view.azDeg - moon.azDeg)) < 0.1 &&
      Math.abs(land.view.elDeg - moon.elDeg) < 0.1 &&
      Math.abs(land.view.rollDeg) < 0.1,
    land,
  );
  await sleep(4000);
  await page.screenshot({ path: path.join(OUT, '02-pointing-moon-landscape.png') });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  await page.setViewport(PHONE);
  await readSensor(cdp, pose(90 - decl, 20));
  await sleep(1500);

  // D: 90 deg turn (true 90 -> 180)
  const turn = await sampleViews(page, 1500, () =>
    readSensor(cdp, pose(180 - decl, 20)),
  );
  const startIdx = turn.findIndex((s) => s[0] > 90.05);
  const t0 = startIdx >= 0 ? turn[startIdx][3] : NaN;
  const within = turn.find((s, i) => i >= startIdx && 180 - s[0] < 1);
  const overshoot = Math.max(...turn.map((s) => s[0])) - 180;
  check(
    'D: 90 deg turn settles within 1 s (to < 1 deg), no overshoot',
    within && within[3] - t0 < 1000 && overshoot < 0.05,
    {
      frames: turn.length,
      settleMs: within ? Math.round(within[3] - t0) : null,
      overshoot,
      last: turn.at(-1),
    },
  );

  // E: battery - still phone: no view changes; moving: <= 30 changes/s
  const still = await sampleViews(page, 2000);
  const changes = (samples) =>
    samples.filter(
      (s, i) => i > 0 && (s[0] !== samples[i - 1][0] || s[1] !== samples[i - 1][1]),
    ).length;
  const stillChanges = changes(still);
  let k = 0;
  const moving = await sampleViews(page, 2000, async () => {
    for (let i = 0; i < 40; i += 1) {
      k += 1;
      await readSensor(cdp, pose(180 - decl + k * 2, 20));
      await sleep(50);
    }
  });
  const movingPerSec = changes(moving) / 2;
  const rafPerSec = moving.length / 2;
  check(
    'E: still phone -> no view changes; moving -> <= 30 view changes per second',
    stillChanges === 0 && movingPerSec <= 31,
    { stillChanges, stillFrames: still.length, movingPerSec, rafPerSec },
  );

  // F: drag takes over
  const before = await handleEval(page, (h) => h.view);
  await page.touchscreen.touchStart(150, 600);
  await page.touchscreen.touchMove(200, 620);
  await page.touchscreen.touchMove(260, 640);
  await page.touchscreen.touchEnd();
  await sleep(500);
  const after = await handleEval(page, (h) => ({
    view: h.view,
    state: h.orientation.state,
    status: document.querySelector('[data-sky=orient-status]').textContent,
  }));
  await readSensor(cdp, pose(10, 10));
  await sleep(800);
  const later = await handleEval(page, (h) => h.view);
  check(
    'F: a drag takes over: pointing off, roll 0, camera moved, sensor ignored',
    after.state === 'off' &&
      after.view.rollDeg === 0 &&
      Math.abs(wrap180(after.view.azDeg - before.azDeg)) > 1 &&
      later.azDeg === after.view.azDeg &&
      /Drag took over/.test(after.status),
    { before, after, later },
  );
  await page.screenshot({ path: path.join(OUT, '03-drag-took-over.png') });
  await page.close();
}

// ── G: sensors denied ──────────────────────────────────────────────────────
{
  const origin = new URL(BASE).origin;
  const bcdp = await browser.target().createCDPSession();
  for (const name of ['accelerometer', 'gyroscope', 'magnetometer'])
    await bcdp.send('Browser.setPermission', {
      permission: { name },
      setting: 'denied',
      origin,
    });
  const { page } = await openSky(BASE);
  await ensureEntered(page);
  await page.tap('[data-sky=point]');
  await sleep(4500);
  const denied = await handleEval(page, (h) => ({
    state: h.orientation.state,
    status: document.querySelector('[data-sky=orient-status]').textContent,
    view: h.view,
  }));
  await page.touchscreen.touchStart(150, 600);
  await page.touchscreen.touchMove(190, 620);
  await page.touchscreen.touchMove(230, 640);
  await page.touchscreen.touchEnd();
  await sleep(500);
  const dragged = await handleEval(page, (h) => h.view);
  check(
    'G: sensors denied -> message, drag still works',
    (denied.state === 'denied' || denied.state === 'unsupported') &&
      denied.status.length > 20 &&
      Math.abs(wrap180(dragged.azDeg - denied.view.azDeg)) > 1,
    { denied, dragged },
  );
  await page.screenshot({ path: path.join(OUT, '04-denied.png') });
  await bcdp.send('Browser.resetPermissions', {});
  await page.close();
}

// ── H: insecure (plain http on a LAN-style host name) ──────────────────────
{
  const target = new URL(BASE);
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
  });
  await new Promise((resolve) => proxy.listen(LAN_PORT, LAN_IP, resolve));
  const lan = `http://${LAN_IP}:${LAN_PORT}`;
  const { page } = await openSky(lan, { sensors: false });
  await ensureEntered(page);
  const secure = await page.evaluate(() => isSecureContext);
  await page.tap('[data-sky=point]');
  await sleep(800);
  const insecure = await handleEval(page, (h) => ({
    state: h.orientation.state,
    status: document.querySelector('[data-sky=orient-status]').textContent,
  }));
  check(
    'H: http LAN address -> "insecure" message naming the https address',
    secure === false &&
      insecure.state === 'insecure' &&
      /https:\/\/godseyeview\.byrd-it\.com/.test(insecure.status),
    { secure, ...insecure },
  );
  await page.screenshot({ path: path.join(OUT, '05-insecure-lan.png') });
  await page.close();
  proxy.close();
}

await browser.close();
const relevant = errors.filter(
  (e) => !/tiles-key|tiles-token|api\/google/.test(e),
);
check('no page errors', relevant.length === 0, relevant.slice(0, 10));
const pass = checks.every((c) => c.ok);
fs.writeFileSync(
  path.join(OUT, 'qa-sky-p4.json'),
  JSON.stringify({ pass, skyTime, moon: { az: moon.azDeg, el: moon.elDeg }, decl, checks, errors }, null, 2),
);
fs.writeFileSync(path.join(OUT, 'qa-sky-p4.log'), log.join('\n') + '\n');
say(pass ? 'QA P4 PASS' : 'QA P4 FAIL', `${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(pass ? 0 : 1);
