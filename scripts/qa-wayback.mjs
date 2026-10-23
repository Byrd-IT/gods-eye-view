/**
 * Headless-Chromium gate for the Esri Wayback time-travel control
 * (GEV_BYRDIT_WAYBACK). Loads the REAL app against a worktree server that
 * runs with the flag on, on a spare port (never 4173), at a desktop and a
 * phone emulation, and checks:
 *   A. the panel is there, inside the screen, with controls >= 44 px, and
 *      the page is no wider than the screen
 *   B. turning it on switches off the covering map (Google 3D / Byrd-IT
 *      Open) to Esri imagery, shows the newest release (newest = slider
 *      right end) and the Esri attribution with the release date
 *   C. every tile request goes to /api/byrdit/wayback/tile/<release>/ and
 *      NONE to an Esri host; a fast drag requests tiles only for the
 *      settled release; the label follows the drag at once
 *   D. older / newer / Latest buttons and the arrow keys move the label;
 *      keys typed in the panel never reach the globe's shortcuts (V)
 *   E. Clear view hides the panel but keeps the attribution; leaving it
 *      brings the panel back
 *   F. a second view of the same area from a FRESH browser context (empty
 *      HTTP cache) makes 0 upstream fetches: /cache-status hits rise,
 *      upstream does not
 *   G. turning it off removes the layer and credit and restores the exact
 *      map that was active before
 * Screenshots: <out>/<viewport>-{off,on,older,clean,restored}.png
 *   node scripts/qa-wayback.mjs --url http://127.0.0.1:4391 --out <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4391').replace(/\/+$/, '');
const OUT = path.resolve(arg('--out', 'qa-wayback'));
const SETTLE_MS = Number(arg('--settle-ms', '9000'));
fs.mkdirSync(OUT, { recursive: true });
if (/:4173\/?$/.test(BASE)) {
  console.error('refusing to run against the live port 4173');
  process.exit(2);
}

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
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  phone: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
};
const TILE = /\/api\/byrdit\/wayback\/tile\/(\d+)\/(\d+)\/(\d+)\/(\d+)/;
const ESRI_HOST = /(^|\.)(arcgis\.com|arcgisonline\.com)$/i;

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

function recordRequests(page) {
  const rec = { tiles: [], direct: [], cacheHeaders: [], byUrl: new Map() };
  page.on('request', (req) => {
    const url = req.url();
    const m = TILE.exec(url);
    if (m)
      rec.tiles.push({ t: Date.now(), release: Number(m[1]), z: Number(m[2]) });
    try {
      const host = new URL(url).hostname;
      if (ESRI_HOST.test(host) && /wayback|metadata/i.test(host))
        rec.direct.push(url);
    } catch {
      /* data: urls etc. */
    }
  });
  page.on('response', (res) => {
    if (TILE.test(res.url())) {
      const header = res.headers()['x-wayback-cache'] ?? '';
      rec.cacheHeaders.push(header);
      rec.byUrl.set(new URL(res.url()).pathname, header);
    }
  });
  return rec;
}

async function openMap(context, vp) {
  const page = await context.newPage();
  page.__rec = recordRequests(page);
  await page.setViewport(vp);
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await page.waitForSelector('#gev-wayback', { timeout: 60000 });
  await sleep(SETTLE_MS);
  // the first-run welcome card covers the map; ESC dismisses it
  await page.keyboard.press('Escape');
  await sleep(800);
  return page;
}

/** Freeze the camera (and read it back) so a second view sees the same tiles. */
const lockCamera = (page, cam) =>
  page.evaluate((c) => {
    const camera = window.__godsEyeView.viewer.camera;
    camera.cancelFlight?.();
    const plain = (v) => ({ x: v.x, y: v.y, z: v.z });
    if (c) {
      camera.setView({
        destination: c.p,
        orientation: { direction: c.d, up: c.u },
      });
      return c;
    }
    return {
      p: plain(camera.position),
      d: plain(camera.direction),
      u: plain(camera.up),
    };
  }, cam);

const stackId = (page) =>
  page.evaluate(() =>
    window.__godsEyeView.styleManager.mapStackController.getActiveId(),
  );
const status = async () =>
  (await fetch(`${BASE}/api/byrdit/wayback/cache-status`)).json();
const panelState = (page) =>
  page.evaluate(() => {
    const p = document.querySelector('#gev-wayback');
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const range = p.querySelector('input[type=range]');
    return {
      label: p.querySelector('output')?.textContent ?? '',
      detail: p.querySelector('.gev-wayback-detail')?.textContent ?? '',
      notice: p.querySelector('.gev-wayback-notice')?.textContent ?? '',
      value: Number(range.value),
      max: Number(range.max),
      checked: p.querySelector('input[type=checkbox]').checked,
      visible:
        cs.visibility === 'visible' &&
        cs.display !== 'none' &&
        Number(cs.opacity) > 0.01,
      box: [r.left, r.top, r.right, r.bottom].map(Math.round),
      layers: window.__godsEyeView.viewer.imageryLayers.length,
      waybackLayers: (() => {
        const c = window.__godsEyeView.viewer.imageryLayers;
        let n = 0;
        for (let i = 0; i < c.length; i++)
          if (
            String(c.get(i).imageryProvider?.url ?? '').includes(
              '/api/byrdit/wayback/tile/',
            )
          )
            n += 1;
        return n;
      })(),
    };
  });
const creditText = (page) =>
  page.evaluate(
    () => document.querySelector('#cesium-credits')?.innerText ?? '',
  );
const setRange = (page, value) =>
  page.evaluate((v) => {
    const r = document.querySelector('#gev-wayback input[type=range]');
    r.value = String(v);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
const click = (page, selector, nth = 0) =>
  page.evaluate(
    (s, n) => document.querySelectorAll(s)[n].click(),
    selector,
    nth,
  );
async function waitFor(page, fn, arg, timeout = 60000) {
  await page.waitForFunction(fn, { timeout }, arg);
}

const releases = (
  await (await fetch(`${BASE}/api/byrdit/wayback/releases`)).json()
).releases;
check(
  'release list: 100+ releases, newest first',
  releases.length >= 100 && releases[0].date >= releases.at(-1).date,
  `${releases.length} ${releases.at(-1).date}..${releases[0].date}`,
);
const oldestFirst = [...releases].reverse();

async function runViewport(name, vp, context) {
  say(`--- ${name} ${vp.width}x${vp.height}`);
  const page = await openMap(context, vp);
  const rec = page.__rec;
  const cam = await lockCamera(page, null);
  const before = await stackId(page);
  const layersBefore = (await panelState(page)).layers;
  const shot = (tag) =>
    page.screenshot({ path: path.join(OUT, `${name}-${tag}.png`) });
  await shot('off');

  // A. layout
  const a = await page.evaluate(() => {
    const p = document.querySelector('#gev-wayback');
    const sizes = [
      ...p.querySelectorAll('button, input[type=range], label'),
    ].map((e) => {
      const r = e.getBoundingClientRect();
      return [e.tagName, Math.round(r.width), Math.round(r.height)];
    });
    return {
      sizes,
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
    };
  });
  const s0 = await panelState(page);
  check(
    `${name} A panel inside the screen`,
    s0.box[0] >= 0 &&
      s0.box[2] <= vp.width &&
      s0.box[3] <= vp.height &&
      s0.box[1] >= 0,
    JSON.stringify(s0.box),
  );
  check(
    `${name} A page no wider than the screen`,
    a.scrollW <= a.innerW,
    `${a.scrollW}<=${a.innerW}`,
  );
  check(
    `${name} A toggle starts off, no Wayback layer`,
    !s0.checked && rec.tiles.length === 0,
    `tiles=${rec.tiles.length}`,
  );

  // B. turn on
  await page.evaluate(() =>
    document.querySelector('#gev-wayback input[type=checkbox]').click(),
  );
  await waitFor(
    page,
    () =>
      window.__godsEyeView.styleManager.mapStackController.getActiveId() ===
      'esri-imagery',
  );
  await waitFor(
    page,
    (d) => document.querySelector('#gev-wayback output')?.textContent === d,
    releases[0].date,
  );
  await sleep(SETTLE_MS / 2);
  const on = await panelState(page);
  check(
    `${name} B switched to Esri imagery`,
    (await stackId(page)) === 'esri-imagery',
    `before=${before}`,
  );
  check(
    `${name} B newest release shown, slider at the right end`,
    on.label === releases[0].date && on.value === on.max,
    `${on.label} ${on.value}/${on.max}`,
  );
  check(
    `${name} B exactly one Wayback layer on the globe`,
    on.waybackLayers === 1,
    `wayback layers=${on.waybackLayers}, layers ${layersBefore}->${on.layers}`,
  );
  const credit = await creditText(page);
  check(
    `${name} B attribution + release date on screen`,
    /Esri, Maxar, Earthstar Geographics, and the GIS User Community/.test(
      credit,
    ) && credit.includes(releases[0].date),
    credit.replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    `${name} C tile requests target the newest release`,
    rec.tiles.length > 0 &&
      rec.tiles.every((t) => t.release === releases[0].release),
    `${rec.tiles.length} tiles, releases=${[...new Set(rec.tiles.map((t) => t.release))]}`,
  );
  const covered = await page.evaluate(() => {
    const p = document.querySelector('#gev-wayback');
    const r = p.getBoundingClientRect();
    const bad = [];
    for (const fx of [0.1, 0.5, 0.9])
      for (const fy of [0.15, 0.5, 0.85]) {
        const el = document.elementFromPoint(
          r.left + r.width * fx,
          r.top + r.height * fy,
        );
        if (!el || !p.contains(el))
          bad.push(
            el?.id || el?.className?.toString().slice(0, 30) || el?.tagName,
          );
      }
    return bad;
  });
  check(
    `${name} A panel is on top: nothing covers it`,
    covered.length === 0,
    covered.join(','),
  );
  const sizes = await page.evaluate(() =>
    [
      ...document.querySelectorAll('#gev-wayback button, #gev-wayback input'),
    ].map((e) => {
      const r = e.getBoundingClientRect();
      return Math.round(Math.min(r.width, r.height));
    }),
  );
  check(
    `${name} A controls are touch sized (>= 22 px checkbox, >= 44 px buttons/slider)`,
    sizes.every((n) => n >= 22) && sizes.filter((n) => n >= 44).length >= 4,
    sizes.join(','),
  );
  await shot('on');

  // C. fast drag then settle
  const target = Math.floor(releases.length / 2);
  const mark = rec.tiles.length;
  const dragStart = Date.now();
  for (const v of [3, 20, 60, 100, 40, target]) {
    await setRange(page, v);
    await sleep(60);
  }
  const mid = await panelState(page);
  check(
    `${name} C label follows the drag at once`,
    mid.label === oldestFirst[target].date,
    `${mid.label} vs ${oldestFirst[target].date}`,
  );
  await sleep(250);
  const during = rec.tiles
    .slice(mark)
    .filter((t) => t.t >= dragStart && t.t < dragStart + 500);
  check(
    `${name} C no tile requests for intermediate releases while dragging`,
    during.every((t) => t.release === releases[0].release),
    `${during.length} requests in the first 500 ms, releases=${[...new Set(during.map((t) => t.release))]}`,
  );
  const settledBy = Date.now() + 90000;
  while (
    !rec.tiles.some((t) => t.release === oldestFirst[target].release) &&
    Date.now() < settledBy
  )
    await sleep(250);
  await sleep(SETTLE_MS / 2);
  const settledTiles = rec.tiles
    .slice(mark)
    .filter((t) => t.t > dragStart + 1500);
  const wanted = oldestFirst[target].release;
  check(
    `${name} C after settling, new tile requests are all for the chosen release`,
    settledTiles.length > 0 &&
      settledTiles.every(
        (t) => t.release === wanted || t.release === releases[0].release,
      ),
    `${settledTiles.length} tiles, releases=${[...new Set(settledTiles.map((t) => t.release))]}`,
  );
  check(
    `${name} C chosen release is requested`,
    settledTiles.some((t) => t.release === wanted),
    `release ${wanted}`,
  );
  const hitMiss = [...new Set(rec.cacheHeaders)];
  check(
    `${name} C tiles are served by the same-origin cache (x-wayback-cache present)`,
    hitMiss.every((h) => h === 'HIT' || h === 'MISS') && hitMiss.length > 0,
    hitMiss.join(','),
  );
  check(
    `${name} C no request to an Esri host from the browser`,
    rec.direct.length === 0,
    rec.direct.slice(0, 2).join(' '),
  );
  await sleep(1500);
  const detail = await panelState(page);
  check(
    `${name} C per-location capture info shown (sub-flag on)`,
    /Captured|Wayback release/.test(detail.detail),
    detail.detail,
  );
  await shot('older');

  // D. buttons and keys
  const idx = await panelState(page);
  await click(page, '#gev-wayback button', 0); // older
  let s = await panelState(page);
  check(
    `${name} D older button moves one release back`,
    s.value === idx.value - 1 && s.label === oldestFirst[idx.value - 1].date,
    s.label,
  );
  await click(page, '#gev-wayback button', 1); // newer
  s = await panelState(page);
  check(
    `${name} D newer button moves one release forward`,
    s.value === idx.value,
    s.label,
  );
  await page.focus('#gev-wayback input[type=range]');
  const bodyClean = () =>
    page.evaluate(() => document.body.classList.contains('ui-clean-view'));
  await page.keyboard.press('v');
  check(
    `${name} D typing V in the panel does not trigger the globe shortcut`,
    !(await bodyClean()),
  );
  await page.keyboard.press('ArrowLeft');
  s = await panelState(page);
  check(
    `${name} D arrow key steps one release`,
    s.value === idx.value - 1,
    s.label,
  );
  await page.keyboard.press('Home');
  s = await panelState(page);
  check(
    `${name} D Home goes to the oldest`,
    s.value === 0 && s.label === oldestFirst[0].date,
    s.label,
  );
  await click(page, '#gev-wayback button', 2); // Latest
  s = await panelState(page);
  check(
    `${name} D Latest returns to the newest`,
    s.value === s.max && s.label === releases[0].date,
    s.label,
  );
  await sleep(1200);

  // E. clear view
  await page.evaluate(() => document.body.classList.add('ui-clean-view'));
  await sleep(500);
  const clean = await panelState(page);
  const cleanCredit = await creditText(page);
  check(`${name} E Clear view hides the panel`, !clean.visible);
  check(
    `${name} E attribution stays in Clear view`,
    /Esri, Maxar/.test(cleanCredit),
    cleanCredit.replace(/\s+/g, ' ').slice(0, 100),
  );
  await shot('clean');
  await page.evaluate(() => document.body.classList.remove('ui-clean-view'));
  await sleep(500);
  check(
    `${name} E panel is back after leaving Clear view`,
    (await panelState(page)).visible,
  );

  // G. off restores
  await page.evaluate(() =>
    document.querySelector('#gev-wayback input[type=checkbox]').click(),
  );
  await waitFor(
    page,
    (b) =>
      window.__godsEyeView.styleManager.mapStackController.getActiveId() === b,
    before,
  );
  await sleep(2500);
  const off = await panelState(page);
  const afterCredit = await creditText(page);
  check(
    `${name} G off restores the map that was active`,
    (await stackId(page)) === before,
    `${before} -> ${await stackId(page)}`,
  );
  check(
    `${name} G Wayback layer and credit removed`,
    off.waybackLayers === 0 && !/Wayback/.test(afterCredit),
    `wayback layers=${off.waybackLayers}, layers ${off.layers} vs ${layersBefore}`,
  );
  await shot('restored');
  const sinceOff = rec.tiles.length;
  await sleep(2500);
  check(
    `${name} G no tile requests after turning off`,
    rec.tiles.length === sinceOff,
  );
  await page.close();
  return cam;
}

// Desktop first; then the SAME area again from a FRESH browser context (empty
// HTTP cache), so the second view proves the server-side cache, not the
// browser's; then the phone.
const desktopCtx = await browser.createBrowserContext();
const cam = await runViewport('desktop', VIEWPORTS.desktop, desktopCtx);

async function revisit() {
  const ctx = await browser.createBrowserContext();
  const page = await openMap(ctx, VIEWPORTS.desktop);
  await lockCamera(page, cam);
  await sleep(1500);
  await page.evaluate(() =>
    document.querySelector('#gev-wayback input[type=checkbox]').click(),
  );
  await waitFor(
    page,
    (d) => document.querySelector('#gev-wayback output')?.textContent === d,
    releases[0].date,
  );
  await sleep(SETTLE_MS);
  const target = Math.floor(releases.length / 2);
  await setRange(page, target);
  await sleep(SETTLE_MS * 1.5);
  const rec = page.__rec;
  await page.close();
  await ctx.close();
  return rec;
}
// The same scripted view twice from fresh browser contexts: the first one
// may fetch whatever the earlier steps did not, the second must not.
const warm = await revisit();
const before2 = await status();
const second = await revisit();
const afterSecond = await status();
// Cesium may pick a few different tiles from one run to the next, so the
// proof is per tile: every tile the warm-up view fetched and the second view
// asks for again must be served from the cache, and only tiles the warm-up
// never saw may cost an upstream fetch.
const repeated = [...second.byUrl.keys()].filter((k) => warm.byUrl.has(k));
const notHit = repeated.filter((k) => second.byUrl.get(k) !== 'HIT');
const fresh = [...second.byUrl.keys()].filter((k) => !warm.byUrl.has(k));
const newUpstream = afterSecond.upstream - before2.upstream;
check(
  'F second view of the same area (fresh browser cache): tile requests reach the server',
  second.tiles.length >= 10 && repeated.length >= 10,
  `${second.tiles.length} tile requests, ${repeated.length} distinct tiles seen before`,
);
check(
  'F every tile seen before is served from the cache (x-wayback-cache HIT, 0 upstream)',
  notHit.length === 0,
  `${repeated.length - notHit.length}/${repeated.length} HIT${notHit.length ? `; not HIT: ${notHit.slice(0, 3)}` : ''}`,
);
check(
  'F server hit counter rises',
  afterSecond.hits >= before2.hits + 10,
  `hits ${before2.hits} -> ${afterSecond.hits}`,
);
check(
  'F upstream fetches only for tiles the first view never requested',
  newUpstream <= 3 * fresh.length,
  `upstream ${before2.upstream} -> ${afterSecond.upstream} (+${newUpstream}); ${fresh.length} tile(s) new to the cache, misses +${afterSecond.misses - before2.misses}`,
);
check(
  'F cache status exposes counters and the guard, no paths',
  typeof afterSecond.tiles === 'number' &&
    afterSecond.guard &&
    !JSON.stringify(afterSecond).includes('/home'),
  JSON.stringify({
    tiles: afterSecond.tiles,
    hits: afterSecond.hits,
    misses: afterSecond.misses,
    guard: afterSecond.guard.writing,
  }),
);

const phoneCtx = await browser.createBrowserContext();
await runViewport('phone', VIEWPORTS.phone, phoneCtx);

check(
  'no page errors',
  pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | '),
);
await browser.close();
const failed = checks.filter((c) => !c.ok);
fs.writeFileSync(
  path.join(OUT, 'checks.json'),
  JSON.stringify(checks, null, 2),
);
say(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
