#!/usr/bin/env node
/**
 * History layer swap B12d browser QA (card t_215e62e1): quakes and wind at
 * t, satellites and the weather imagery LIVE. Headless Chromium against a
 * running GEV dev server:
 *
 *   node scripts/qa-history-b12d.mjs --url http://127.0.0.1:4398 --out <dir>
 *
 * Fixture mode only (CDP Fetch on /api/* and the USGS feed; a blanket
 * interception renders the globe white): the LIVE USGS all_day feed has 5
 * events 'live-*', the history quakes slice 3 events 'hist-*' (all near
 * Austin, M4.5+ so the discs are visible); the LIVE wind manifest is the
 * 2026-10-17 12Z cycle (southerly field), the history wind slice the
 * recorded cycle at t (westerly field); /api/celestrak/<group> the
 * 200-object reference GP CSV. A second t before the recording start
 * answers the B12c 'nothing recorded' shapes (quakes: empty
 * FeatureCollection + X-History-Empty-Reason; wind: 404 not_recorded).
 *
 * Checks:
 *   live       earthquakes = the 5 live events, wind = the live cycle,
 *              satellites drawn, no LIVE chip (not in history)
 *   history t  earthquakes = the 3 recorded events, wind = the recorded
 *              cycle (Issued / Valid of t), NO live USGS / wind request
 *              after entering, no LIVE chip on earthquakes / wind, a LIVE
 *              chip on satellites and weather radar (D5), the satellites
 *              layer still asks /api/celestrak live (never a gp slice)
 *   before     nothing drawn: earthquakes 0, wind field cleared (the
 *              layer's unavailable state), and a chip naming the reason and
 *              the recording start for each (D3)
 *   LIVE       live events and the live cycle back, chips gone (D4)
 * plus no console / page error. Screenshots after Page.bringToFront.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {
  coverageFixture,
  fixtureWorld,
  snapshotsFixture,
} from '../src/byrdit/historyUi/fixtures/b11Coverage.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4398');
const OUT = path.resolve(arg('--out', 'qa-history-b12d'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
const LAT = 30.2672;
const LON = -97.7431;
const USGS =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const HOUR = 3_600_000;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...parts) => {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  log.push(line);
  console.log(line);
};
const failures = [];
const check = (ok, what) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failures.push(what);
};

const world = fixtureWorld(Date.now());
const iso = (ms) => new Date(ms).toISOString();
/** The history time shown, and a time before every recording start. */
const T = Date.now() - 2 * 86_400_000;
const T_BEFORE = Date.now() - 400 * 86_400_000;
const START = Date.now() - 300 * 86_400_000;
const GP_CSV = readFileSync(
  new URL('../src/byrdit/skyView/reference/satFixture200.csv', import.meta.url),
  'utf8',
);
const calls = { usgs: 0, windLive: 0, celestrak: 0, slices: [] };

function quakes(prefix, n, atMs) {
  return {
    type: 'FeatureCollection',
    metadata: {
      generated: atMs,
      url: USGS,
      title: 'USGS All Earthquakes, Past Day',
      status: 200,
      api: '2.7.0',
      count: n,
    },
    features: Array.from({ length: n }, (_, i) => ({
      type: 'Feature',
      properties: {
        mag: 4.5 + i * 0.5,
        place: `${prefix} quake ${i + 1}`,
        time: atMs - (i + 1) * HOUR,
        updated: atMs - (i + 1) * HOUR + 600_000,
        magType: 'mb',
      },
      geometry: {
        type: 'Point',
        coordinates: [
          LON + 3 * Math.cos(i + (prefix === 'live' ? 0 : 2)),
          LAT + 3 * Math.sin(i + (prefix === 'live' ? 0 : 2)),
          10,
        ],
      },
      id: `${prefix}-${i + 1}`,
    })),
  };
}

const runOf = (ms) => Math.floor(ms / (6 * HOUR)) * 6 * HOUR;
function windManifest(runMs, validMs) {
  const d = new Date(runMs);
  const date = d.toISOString().slice(0, 10).replaceAll('-', '');
  const fh = Math.round((validMs - runMs) / HOUR);
  return {
    schemaVersion: 1,
    model: 'gfs',
    cycle: {
      date,
      hour: d.getUTCHours(),
      forecastHour: fh,
      runIso: iso(runMs),
      validIso: iso(runMs + fh * HOUR),
    },
    fetchedAt: Date.now(),
    level: '10 m above ground',
    units: 'm/s',
    grid: { nx: 360, ny: 181, lo1: 0, la1: 90, dx: 1, dy: 1 },
    stale: false,
    unavailable: false,
    reason: null,
    gridUrl: `/api/wind/grid/gfs-${date}-${d.getUTCHours()}-f${fh}-1.bin?model=gfs`,
  };
}
const windId = (m) => /grid\/([\w.-]+)\.bin/.exec(m.gridUrl)[1];
function windGrid(u, v) {
  const n = 360 * 181;
  const f = new Float32Array(n * 2);
  f.fill(u, 0, n);
  f.fill(v, n);
  return Buffer.from(f.buffer);
}
const LIVE_RUN = runOf(Date.now() - 6 * HOUR);
const liveWind = windManifest(LIVE_RUN, LIVE_RUN + 6 * HOUR);
const histWind = windManifest(runOf(T), T);

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--font-render-hinting=none',
    '--disable-accelerated-2d-canvas',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text().slice(0, 300)}`);
});
const fetchSession = await page.target().createCDPSession();
await fetchSession.send('Fetch.enable', {
  patterns: [
    { urlPattern: `${new URL(BASE).origin}/api/*` },
    { urlPattern: `${USGS}*` },
  ],
});
fetchSession.on('Fetch.requestPaused', (ev) => {
  const respond = (status, headers, body) =>
    fetchSession
      .send('Fetch.fulfillRequest', {
        requestId: ev.requestId,
        responseCode: status,
        responseHeaders: Object.entries({
          'access-control-allow-origin': '*',
          ...headers,
        }).map(([name, value]) => ({ name, value: String(value) })),
        body: Buffer.from(body).toString('base64'),
      })
      .catch(() => {});
  const json = (body, headers = {}, status = 200) =>
    respond(
      status,
      { 'content-type': 'application/json', ...headers },
      JSON.stringify(body),
    );
  const url = new URL(ev.request.url);
  const q = Object.fromEntries(url.searchParams);
  if (url.href.startsWith(USGS)) {
    calls.usgs++;
    return json(quakes('live', 5, Date.now()));
  }
  if (url.pathname === '/api/wind/manifest') {
    calls.windLive++;
    return json(liveWind);
  }
  if (url.pathname.startsWith('/api/wind/grid/')) {
    calls.windLive++;
    return respond(
      200,
      { 'content-type': 'application/octet-stream' },
      windGrid(0, 15),
    );
  }
  if (url.pathname.startsWith('/api/celestrak/')) {
    calls.celestrak++;
    return respond(200, { 'content-type': 'text/csv; charset=utf-8' }, GP_CSV);
  }
  if (url.pathname === '/api/history/slice') {
    const t = Date.parse(q.t);
    calls.slices.push(`${q.feed}${q.part ? `:${q.part}` : ''}`);
    const before = t < START;
    const startH = { 'x-history-recording-start': iso(START) };
    if (q.feed === 'quakes')
      return before
        ? json(quakes('hist', 0, t), {
            ...startH,
            'x-history-rows': '0',
            'x-history-empty-reason': 'before_recording_start',
          })
        : json(quakes('hist', 3, t), {
            ...startH,
            'x-history-rows': '3',
            'x-history-sources': 'usgs-fdsn',
          });
    if (q.feed === 'wind') {
      if (before)
        return json(
          { error: 'not_recorded', reason: 'before_recording_start' },
          { ...startH, 'x-history-empty-reason': 'before_recording_start' },
          404,
        );
      const m = windManifest(runOf(t), t);
      const h = {
        ...startH,
        'x-history-cycle-run': m.cycle.runIso,
        'x-history-valid-time': m.cycle.validIso,
        'x-history-wind-id': windId(m),
      };
      return q.part === 'grid'
        ? respond(
            200,
            { ...h, 'content-type': 'application/octet-stream' },
            windGrid(15, 0),
          )
        : json(m, h);
    }
    return json({}, { 'x-history-rows': '0', 'x-history-gap': '1' });
  }
  if (url.pathname === '/api/history/coverage')
    return json(
      coverageFixture(world, {
        feed: q.feed,
        from: Date.parse(q.from),
        to: Date.parse(q.to),
        bucket: q.bucket,
      }),
    );
  if (url.pathname === '/api/history/snapshots')
    return json(
      snapshotsFixture(world, {
        feed: q.feed,
        around: Date.parse(q.around),
        n: Number(q.n),
      }),
    );
  if (url.pathname.startsWith('/api/history/')) return json({}, {}, 404);
  return fetchSession
    .send('Fetch.continueRequest', { requestId: ev.requestId })
    .catch(() => {});
});

async function shot(name) {
  await page.bringToFront();
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await sleep(800);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  say('screenshot', file);
}

/** A screenshot from far out (satellites), then the camera is put back. */
async function farShot(name) {
  await page.evaluate(() => {
    const cam = window.__godsEyeView.viewer.camera;
    window.__qaCam = {
      destination: cam.positionWC.clone(),
      orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    };
    const C3 = cam.positionWC.constructor;
    cam.setView({ destination: C3.fromDegrees(-97.7, 30.3, 25_000_000) });
  });
  await sleep(1500);
  await shot(name);
  await page.evaluate(() =>
    window.__godsEyeView.viewer.camera.setView(window.__qaCam),
  );
  await sleep(1000);
}

const state = () =>
  page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    const mod = (id) => dm.layers.get(id)?.module;
    const quakeIds = [];
    const ds = window.__godsEyeView.viewer.dataSources;
    for (let i = 0; i < ds.length; i++)
      for (const e of ds.get(i).entities.values)
        if (String(e.id).startsWith('earthquake:'))
          quakeIds.push(String(e.id).slice(11));
    const wind = mod('wind')?.getRowControls?.()?.summary ?? {};
    const root = document.querySelector('[data-gev-history]');
    return {
      mode: root?.getAttribute('data-mode'),
      quakes: mod('earthquakes')?.getStats?.().count ?? null,
      quakeIds: quakeIds.sort(),
      windRun: wind.issuedTime ?? null,
      windValid: wind.validTime ?? null,
      windStats: mod('wind')?.getStats?.() ?? null,
      sats: mod('satellites')?.getStats?.().count ?? null,
      chips: [...(root?.querySelectorAll('.gev-hist-chip') ?? [])].map((el) => [
        el.getAttribute('data-feed'),
        el.textContent,
      ]),
      swapped: window.__gevHistorySwap.router.getState().swapped,
    };
  });
async function waitFor(pred, what, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let st;
  for (;;) {
    st = await state();
    if (pred(st)) return st;
    if (Date.now() > end) {
      say('timeout waiting for', what, JSON.stringify(st).slice(0, 1500));
      return st;
    }
    await sleep(500);
  }
}
const chipText = (st, feed) => st.chips.find(([f]) => f === feed)?.[1] ?? null;

// ── live ─────────────────────────────────────────────────
await page.goto(
  `${BASE}/?welcome=0#v=2&lat=${LAT}&lon=${LON}&alt=3000000&heading=360&pitch=-90&roll=0&map=esri-imagery`,
  { waitUntil: 'domcontentloaded', timeout: 120000 },
);
await page.waitForFunction(
  () => window.__godsEyeView?.dataManager && window.__gevHistorySwap?.router,
  { timeout: 180000 },
);
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');
await page.evaluate(async () => {
  const dm = window.__godsEyeView.dataManager;
  for (const id of ['earthquakes', 'wind', 'satellites', 'weather-radar'])
    await dm.setEnabled(id, true);
});
let st = await waitFor(
  (s) => s.quakes === 5 && s.windRun === liveWind.cycle.runIso && s.sats > 0,
  'live',
);
check(
  st.quakes === 5 && st.quakeIds.every((id) => id.startsWith('live-')),
  `live: earthquakes = the live feed ${JSON.stringify(st.quakeIds)}`,
);
check(
  st.windRun === liveWind.cycle.runIso,
  `live: wind = the live cycle ${st.windRun}`,
);
check(st.sats > 0, `live: satellites drawn n=${st.sats}`);
check(
  !st.chips.some(([f]) => /^layer:/.test(f)),
  `live: no LIVE chips ${JSON.stringify(st.chips)}`,
);
await shot('01-live');

// ── history at t ─────────────────────────────────────────
const before = { ...calls, slices: calls.slices.length };
await page.evaluate((t) => window.__gevHistorySwap.handle.seek(t), T);
st = await waitFor(
  (s) =>
    s.mode === 'history' &&
    s.quakes === 3 &&
    s.windRun === histWind.cycle.runIso,
  'history t',
);
check(
  st.quakes === 3 && st.quakeIds.every((id) => id.startsWith('hist-')),
  `history: earthquakes = the recorded slice at t ${JSON.stringify(st.quakeIds)}`,
);
check(
  st.windRun === histWind.cycle.runIso &&
    st.windValid === histWind.cycle.validIso,
  `history: wind = the recorded cycle at t issued ${st.windRun} valid ${st.windValid} (t ${iso(T)})`,
);
await sleep(2000);
check(
  calls.usgs === before.usgs && calls.windLive === before.windLive,
  `history: no live USGS / wind request ${JSON.stringify({ usgs: calls.usgs - before.usgs, wind: calls.windLive - before.windLive })}`,
);
const sliceFeeds = calls.slices.slice(before.slices);
check(
  sliceFeeds.includes('quakes') &&
    sliceFeeds.includes('wind:manifest') &&
    sliceFeeds.includes('wind:grid') &&
    !sliceFeeds.some((f) => f.startsWith('gp')),
  `history: slices asked ${JSON.stringify([...new Set(sliceFeeds)])}`,
);
check(
  st.swapped.includes('quakes') && st.swapped.includes('wind'),
  `history: quakes + wind swapped ${JSON.stringify(st.swapped)}`,
);
check(
  chipText(st, 'layer:satellites') === 'Satellites: LIVE' ||
    /LIVE$/.test(chipText(st, 'layer:satellites') ?? ''),
  `history: satellites LIVE chip ${chipText(st, 'layer:satellites')}`,
);
check(
  /LIVE$/.test(chipText(st, 'layer:weather-radar') ?? ''),
  `history: weather radar LIVE chip ${chipText(st, 'layer:weather-radar')}`,
);
check(
  !chipText(st, 'layer:earthquakes') && !chipText(st, 'layer:wind'),
  `history: no LIVE chip on earthquakes / wind ${JSON.stringify(st.chips)}`,
);
{
  const c0 = calls.celestrak;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.refreshLayer('satellites'),
  );
  await sleep(1500);
  check(
    calls.celestrak > c0,
    `history: the satellites layer still asks /api/celestrak live (${calls.celestrak - c0} requests), never a gp slice`,
  );
}
await shot('02-history-quakes-wind');
await farShot('02b-history-satellites-live');

// ── before the recording start ───────────────────────────
await page.evaluate((t) => window.__gevHistorySwap.handle.seek(t), T_BEFORE);
st = await waitFor(
  (s) =>
    s.quakes === 0 &&
    s.windStats?.error &&
    chipText(s, 'history-note:quakes') &&
    chipText(s, 'history-note:wind'),
  'before start',
);
check(
  st.quakes === 0 && st.quakeIds.length === 0,
  `before start: no earthquakes drawn ${JSON.stringify(st.quakeIds)}`,
);
check(
  st.windStats?.count === 0 &&
    /no wind field recorded/.test(st.windStats?.error ?? ''),
  `before start: wind field cleared ${JSON.stringify(st.windStats)}`,
);
const startText = new Date(START).toISOString().slice(0, 16).replace('T', ' ');
for (const f of ['quakes', 'wind'])
  check(
    /HISTORY none at this time: nothing recorded yet/.test(
      chipText(st, `history-note:${f}`) ?? '',
    ) && (chipText(st, `history-note:${f}`) ?? '').includes(startText),
    `before start: ${f} chip ${chipText(st, `history-note:${f}`)}`,
  );
await shot('03-before-recording-start');

// ── LIVE ─────────────────────────────────────────────────
await page.evaluate(() => window.__gevHistorySwap.handle.leave());
st = await waitFor(
  (s) =>
    s.mode !== 'history' &&
    s.quakes === 5 &&
    s.windRun === liveWind.cycle.runIso,
  'LIVE',
);
check(
  st.quakes === 5 && st.quakeIds.every((id) => id.startsWith('live-')),
  `LIVE: earthquakes back to live ${JSON.stringify(st.quakeIds)}`,
);
check(
  st.windRun === liveWind.cycle.runIso,
  `LIVE: wind live cycle ${st.windRun}`,
);
check(
  !st.chips.some(([f]) => /^(layer|history-note):/.test(f)),
  `LIVE: chips gone ${JSON.stringify(st.chips)}`,
);
await shot('04-live-again');

check(errors.length === 0, `no console/page errors ${JSON.stringify(errors)}`);
say('calls', { ...calls, slices: calls.slices.length });
say(failures.length ? `QA B12d FAIL (${failures.length})` : 'QA B12d PASS');
writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
