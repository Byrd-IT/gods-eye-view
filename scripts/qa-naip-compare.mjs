/**
 * Headless-Chromium gate for the Time travel imagery sliders and the Compare
 * divider (t_862ba336). A merge or rebase once dropped the divider's look
 * (its inline style ran before the store-rendered line existed), leaving
 * Compare with no handle to move; this script fails when that happens again.
 *
 *   A. the Aerial slider moves the basemap year: Home goes to the oldest year,
 *      the label follows, and historic tiles are requested for it (at a
 *      covered place); End returns to the newest year
 *   B. Compare: the divider line spans the screen, its handle is on screen and
 *      is the element under its own centre; dragging the handle and the
 *      arrow keys move it; the Compare slider moves the right-side year
 *   C. the same at a phone size (412 x 915, touch)
 * Page errors and failed requests are listed, not failed on.
 *   node scripts/qa-naip-compare.mjs --url http://127.0.0.1:4392 --out <dir>
 * It only reads and toggles UI state in a fresh browser context, so it is safe
 * against a live server too.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4392').replace(/\/+$/, '');
const OUT = path.resolve(arg('--out', 'qa-naip-compare'));
const SETTLE_MS = Number(arg('--settle-ms', '9000'));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const say = (...p) =>
  console.log(
    p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '),
  );
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  say(ok ? 'PASS' : 'FAIL', name, detail ?? '');
};

const VIEWPORTS = {
  desktop: { width: 1600, height: 900, deviceScaleFactor: 1 },
  phone: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};
// Big Sandy, TX: covered by the Upshur 1939 historic aerial and by NAIP 2024.
const PLACE = { lat: 32.5826, lon: -95.1075, height: 2500 };
const HIST_TILE = /\/basemap\/naip\/regional\/hist-upshur-[^/]+\/\d+\/\d+\/\d+/;

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
const pageErrors = [];
const failed = [];

async function openMap(vp, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.__hist = 0;
  await page.setViewport(vp);
  page.on('pageerror', (e) =>
    pageErrors.push(`${name}: ${String(e).slice(0, 300)}`),
  );
  page.on('requestfailed', (r) =>
    failed.push(`${name}: ${r.url().slice(0, 140)} ${r.failure()?.errorText}`),
  );
  page.on('request', (r) => {
    if (HIST_TILE.test(r.url())) page.__hist += 1;
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape');
  await sleep(800);
  await page.evaluate((p) => {
    const rad = Math.PI / 180;
    const a = 6378137;
    const e2 = 0.00669437999014;
    const lat = p.lat * rad;
    const lon = p.lon * rad;
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const x = (n + p.height) * Math.cos(lat) * Math.cos(lon);
    const y = (n + p.height) * Math.cos(lat) * Math.sin(lon);
    const z = (n * (1 - e2) + p.height) * Math.sin(lat);
    const cam = window.__godsEyeView.viewer.camera;
    cam.cancelFlight?.();
    const len = Math.hypot(x, y, z);
    cam.setView({
      destination: { x, y, z },
      orientation: {
        direction: { x: -x / len, y: -y / len, z: -z / len },
        up: { x: -Math.sin(lat) * Math.cos(lon) * 0, y: 0, z: 1 },
      },
    });
  }, PLACE);
  // the Time travel card hosts the Aerial section: a right-rail button on a
  // desktop, the bottom bar's Context tab on a phone (the rail is hidden)
  await page.evaluate(() => {
    document.querySelector('[data-rail-item="time-travel-panel"]')?.click();
  });
  const shown = () =>
    page
      .waitForSelector('#gev-naip-slider .gev-ts-scrub', {
        visible: true,
        timeout: 8000,
      })
      .then(() => true)
      .catch(() => false);
  if (!(await shown())) {
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('button')].find(
        (b) => /context\s*$/i.test(b.textContent.trim()) && b.getBoundingClientRect().y > innerHeight * 0.8,
      );
      tab?.click();
    });
  }
  await page.waitForSelector('#gev-naip-slider .gev-ts-scrub', {
    visible: true,
    timeout: 60000,
  });
  return { page, context };
}

const scrubs = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#gev-naip-slider .gev-ts-scrub')].map((s) => ({
      label: s.getAttribute('aria-label'),
      text: s.getAttribute('aria-valuetext'),
    })),
  );
const outputText = (page) =>
  page.evaluate(
    () => document.querySelector('#gev-naip-slider output')?.textContent ?? '',
  );
const keyOn = async (page, selector, key) => {
  await page.evaluate((s) => document.querySelectorAll(s)[0]?.focus(), selector);
  await page.keyboard.press(key);
};

async function run(name) {
  const vp = VIEWPORTS[name];
  const { page, context } = await openMap(vp, name);
  const aerial = '#gev-naip-slider .gev-ts-scrub';

  // A. Aerial slider
  const newest = (await scrubs(page))[0].text;
  await keyOn(page, aerial, 'Home');
  await sleep(SETTLE_MS);
  const oldest = (await scrubs(page))[0].text;
  check(`${name} A aerial slider Home goes to an older year`, Number(oldest) < Number(newest), { newest, oldest });
  check(`${name} A label follows the year`, (await outputText(page)).startsWith(`${oldest}:`), (await outputText(page)).slice(0, 60));
  check(`${name} A historic tiles requested for the old year`, page.__hist > 0, { hist: page.__hist });
  await page.screenshot({ path: path.join(OUT, `${name}-aerial-old.png`) });
  await keyOn(page, aerial, 'End');
  await sleep(1500);
  const end = (await scrubs(page))[0].text;
  check(`${name} A End goes to the newest year`, Number(end) >= Number(newest) && Number(end) > Number(oldest), { oldest, newest, end });

  // B. Compare
  await page.evaluate(() => {
    const boxes = document.querySelectorAll('#gev-naip-slider input[type=checkbox]');
    boxes[1]?.click();
  });
  await sleep(2500);
  const before = (await scrubs(page))[1]?.text;
  await page.evaluate(() => document.querySelectorAll('#gev-naip-slider .gev-ts-scrub')[1]?.focus());
  await page.keyboard.press('Home');
  await sleep(SETTLE_MS);
  const after = (await scrubs(page))[1]?.text;
  check(`${name} B Compare slider moves the compare year`, before && after && Number(after) < Number(before), { before, after });
  // on a phone the sheet's backdrop covers the map while it is open; a tap
  // closes the sheet, as a person would before grabbing the divider
  const closed = await page.evaluate(() => {
    const b = document.getElementById('mobile-sheet-backdrop');
    if (!b || !b.getBoundingClientRect().height) return false;
    b.click();
    return true;
  });
  if (closed) await sleep(1200);
  const geo = await page.evaluate(() => {
    const line = document.getElementById('gev-naip-split-line');
    const handle = document.querySelector('.gev-naip-split-handle');
    if (!line || !handle) return null;
    const l = line.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    const cx = h.x + h.width / 2;
    const cy = h.y + h.height / 2;
    return {
      line: { x: l.x, y: l.y, w: l.width, h: l.height, pos: getComputedStyle(line).position },
      handle: { x: h.x, y: h.y, w: h.width, h: h.height },
      hit: document.elementFromPoint(cx, cy) === handle,
      covered: (() => {
        const t = document.elementFromPoint(cx, cy);
        return t === handle ? null : `${t?.tagName}#${t?.id}.${String(t?.className).slice(0, 40)}`;
      })(),
      now: Number(handle.getAttribute('aria-valuenow')),
      vh: innerHeight,
      vw: innerWidth,
    };
  });
  check(`${name} B divider and handle exist`, geo);
  if (geo) {
    check(`${name} B divider line spans the screen`, geo.line.h >= geo.vh * 0.95 && geo.line.w >= 1 && geo.line.pos === 'fixed', geo.line);
    check(`${name} B handle is on screen, at least 32 px, and on top`, geo.handle.w >= 32 && geo.handle.h >= 32 && geo.handle.x >= 0 && geo.handle.x + geo.handle.w <= geo.vw && geo.hit, { handle: geo.handle, covered: geo.covered });
    const cx = geo.handle.x + geo.handle.w / 2;
    const cy = geo.handle.y + geo.handle.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - geo.vw * 0.3, cy, { steps: 8 });
    await page.mouse.up();
    await sleep(500);
    const moved = await page.evaluate(() => ({
      now: Number(document.querySelector('.gev-naip-split-handle')?.getAttribute('aria-valuenow')),
      x: document.getElementById('gev-naip-split-line')?.getBoundingClientRect().x,
    }));
    check(`${name} B dragging the handle moves the divider`, moved.now < geo.now - 10 && moved.x < geo.line.x - 20, { before: geo.now, after: moved.now, x: moved.x });
    await keyOn(page, '.gev-naip-split-handle', 'ArrowRight');
    await sleep(300);
    const key = await page.evaluate(() => Number(document.querySelector('.gev-naip-split-handle')?.getAttribute('aria-valuenow')));
    check(`${name} B arrow key moves the divider`, key > moved.now, { before: moved.now, after: key });
  }
  await page.screenshot({ path: path.join(OUT, `${name}-compare.png`) });
  await context.close();
}

try {
  for (const name of Object.keys(VIEWPORTS)) await run(name);
} finally {
  await browser.close();
}
say('page errors:', pageErrors.length ? pageErrors : 'none');
say('failed requests:', failed.length, failed.slice(0, 15));
const bad = checks.filter((c) => !c.ok);
say(`${checks.length - bad.length}/${checks.length} checks passed`);
process.exit(bad.length ? 1 : 0);
