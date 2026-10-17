#!/usr/bin/env node
/**
 * Selected-aircraft recorded track (card B12e) browser QA, headless
 * Chromium against a running GEV dev server:
 *
 *   node scripts/qa-history-b12e.mjs --url http://127.0.0.1:4398 --out <dir>
 *        [--settle-ms 20000]
 *
 * Fixture mode only: every /api/history/* request is answered in the
 * browser (coverage / snapshots from the B11 known-gap world, slices and
 * tracks made here); /api/flights and /api/military from canned LIVE
 * answers, /api/flights/track and /api/military/track from canned LIVE
 * tracks (they must never be asked in history).
 *
 * The recorded track of a10000 ends at its icon at t: it runs 0.3 deg of
 * longitude and 0.2 deg of latitude per hour toward the icon, every 2 min
 * over [t-6h, t], with a recorded GAP between t-175 min and t-150 min, the
 * oldest part from adsb.lol and the newest hour from OpenSky. a10001's
 * answer says X-History-Sampled: 1.
 *
 * Checks: selecting an aircraft at t asks /api/history/track for exactly
 * [t-6h, t] (and never the live track); the trail is drawn from the
 * recorded points (its oldest point is the track's, 6 h back); the chip
 * names the sources and the gap; moving t asks the new [t-6h, t] and the
 * trail follows; a sampled answer says SAMPLED; nothing is asked while
 * nothing is selected (no prefetch, no polling); deselect removes the chip;
 * LIVE removes it and the live track comes back. Review R1: a track answer
 * held back until after a deselect, or until after another aircraft was
 * selected, never publishes the chip. Track request latency is
 * measured from the browser's resource timing (FIXTURE timing: the answer
 * is made in the page, so this is the browser + router cost only). No
 * console/page error after the first history interaction. Screenshots after
 * Page.bringToFront. Exit 1 on failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
const OUT = path.resolve(arg('--out', 'qa-history-b12e'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
const LAT = 30.2672;
const LON = -97.7431;
const HASH = `#v=2&lat=${LAT}&lon=${LON}&alt=60000&heading=360&pitch=-90&roll=0&map=esri-imagery`;
const HOUR = 3_600_000;
const MIN = 60_000;
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
const HIST = 12;
const LIVE = 8;
const inGap = (t) => t >= world.gap.from && t < world.gap.to;

// ── fixtures ────────────────────────────────────────────
const ring = (i, n, r) => {
  const a = (2 * Math.PI * i) / n;
  return [LAT + r * Math.sin(a), LON + r * Math.cos(a)];
};
/** History aircraft move with t: 0.3 deg of longitude per hour (mod 5 h). */
const histShift = (tMs) => ((tMs / HOUR) % 5) * 0.3;
function aircraftStates(prefix, n, tSec, hexBase, shift = 0) {
  return Array.from({ length: n }, (_, i) => {
    const [la, lo0] = ring(i, n, 0.12);
    const hex = (hexBase + i).toString(16).padStart(6, '0');
    return [
      hex,
      `${prefix}${String(i + 1).padStart(2, '0')}`,
      'United States',
      tSec - 3,
      tSec - 2,
      lo0 + shift,
      la,
      9000 + i * 100,
      false,
      0, // no coasting: the icon sits on its fix
      90,
      0,
      null,
      9100 + i * 100,
      '1200',
      false,
      0,
      3,
    ];
  });
}
const GAP_FROM_MIN = 175;
const GAP_TO_MIN = 150;
/** The recorded track of hex `i` of the ring, ending at its icon at `to`. */
function trackBody(i, hex, to) {
  const [la0, lo0] = ring(i, HIST, 0.12);
  const endLon = lo0 + histShift(to);
  const path = [];
  for (let back = 360; back >= 1; back -= 2) {
    if (back < GAP_FROM_MIN && back > GAP_TO_MIN) continue; // recorded gap
    const tau = to - back * MIN;
    path.push([
      Math.round(tau / 1000),
      la0 - 0.2 * (back / 60),
      endLon - 0.3 * (back / 60),
      9000,
      60,
      false,
      back <= 60 ? 'opensky' : 'adsblol',
    ]);
  }
  return {
    feed: 'aircraft',
    id: hex,
    icao24: hex,
    callsign: null,
    startTime: path[0][0],
    endTime: path.at(-1)[0],
    path,
    sources: ['adsblol', 'opensky'],
  };
}

function liveHeaders() {
  const now = Date.now();
  return {
    'content-type': 'application/json',
    'x-feed-source': 'collector',
    'x-feed-last-ok': String(now - 4_000),
    'x-feed-age-ms': '4000',
    'x-feed-cache': 'HIT',
  };
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
    '--font-render-hinting=none',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
const trackCalls = [];
const liveTrackCalls = [];
// R1: track answers of these ids are held until released (id -> [respond])
const holdTrack = new Set();
const held = new Map();
const release = (id) => {
  for (const respond of held.get(id) ?? []) respond();
  held.delete(id);
};
page.on('pageerror', (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text().slice(0, 300)}`);
});
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = new URL(req.url());
  const json = (
    body,
    headers = { 'content-type': 'application/json' },
    status = 200,
  ) => req.respond({ status, headers, body: JSON.stringify(body) });
  const q = Object.fromEntries(url.searchParams);
  if (url.pathname === '/api/history/slice') {
    const t = Date.parse(q.t);
    if (q.feed === 'aircraft') {
      const states = inGap(t)
        ? []
        : aircraftStates(
            'HIST',
            HIST,
            Math.round(t / 1000),
            0xa10000,
            histShift(t),
          );
      return json(
        { time: Math.round(t / 1000), states },
        {
          'content-type': 'application/json',
          'x-history-source': states.length ? 'adsblol,opensky' : 'none',
          'x-history-rows': String(states.length),
          ...(states.length ? {} : { 'x-history-gap': '1' }),
        },
      );
    }
    return json(
      q.feed === 'military'
        ? { ac: [], msg: 'No error', now: t, total: 0, ctime: t, ptime: 0 }
        : { error: 'unknown_feed' },
      {
        'content-type': 'application/json',
        'x-history-source': 'none',
        'x-history-rows': '0',
        'x-history-gap': '1',
      },
    );
  }
  if (url.pathname === '/api/history/track') {
    trackCalls.push({ ...q, at: Date.now() });
    const i = parseInt(q.id, 16) - 0xa10000;
    if (!(i >= 0 && i < HIST))
      return json({ error: 'not_found' }, undefined, 404);
    const body = trackBody(i, q.id, Date.parse(q.to));
    const respond = () =>
      json(body, {
        'content-type': 'application/json',
        'x-history-source': 'adsblol,opensky',
        'x-history-rows': String(body.path.length),
        ...(q.id === 'a10001' ? { 'x-history-sampled': '1' } : {}),
      });
    if (holdTrack.has(q.id)) {
      held.set(q.id, [...(held.get(q.id) ?? []), respond]);
      return undefined;
    }
    return respond();
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
  if (url.pathname.startsWith('/api/history/'))
    return json({ error: 'not_found' }, undefined, 404);
  const now = Date.now();
  if (url.pathname === '/api/flights/track') {
    liveTrackCalls.push(url.pathname + url.search);
    const s = Math.round(now / 1000);
    return json({
      icao24: q.icao24,
      path: [
        [s - 600, LAT + 1, LON - 1, 5000, 0, false],
        [s - 300, LAT + 1.1, LON - 1, 5000, 0, false],
      ],
    });
  }
  if (url.pathname === '/api/flights')
    return json(
      {
        time: Math.round(now / 1000),
        states: aircraftStates('LIVE', LIVE, Math.round(now / 1000), 0xb20000),
      },
      liveHeaders(),
    );
  if (url.pathname === '/api/military')
    return json(
      { ac: [], msg: 'No error', now, total: 0, ctime: now, ptime: 1 },
      liveHeaders(),
    );
  return req.continue();
});

async function shot(name) {
  await page.bringToFront();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  say('screenshot', file);
}

const state = () =>
  page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    const m = dm.layers.get('flights')?.module;
    const v = window.__godsEyeView.viewer;
    const root = document.querySelector('[data-gev-history]');
    const toDeg = (c) => {
      const g = v.scene.globe.ellipsoid.cartesianToCartographic(c);
      return g
        ? [(g.latitude * 180) / Math.PI, (g.longitude * 180) / Math.PI]
        : null;
    };
    const trails = v.entities.values
      .filter(
        (e) =>
          typeof e.id === 'string' &&
          e.id.startsWith('gev-trail:') &&
          !e.id.includes('-head-') &&
          e.show !== false,
      )
      .map((e) => e.polyline?.positions?.getValue?.(v.clock.currentTime) ?? [])
      .filter((p) => p.length);
    const body = trails.sort((a, b) => b.length - a.length)[0] ?? [];
    const swap = window.__gevHistorySwap?.router?.getState?.();
    return {
      mode: root?.getAttribute('data-mode'),
      time: root?.getAttribute('data-time'),
      count: m?.getStats?.().count ?? null,
      tracked: m?.getTrackedInfo?.()?.icao24 ?? null,
      chips: [...(root?.querySelectorAll('.gev-hist-chip') ?? [])].map((c) => [
        c.getAttribute('data-feed'),
        c.getAttribute('data-state'),
        c.textContent,
      ]),
      trail: {
        n: body.length,
        first: body.length ? toDeg(body[0]) : null,
        last: body.length ? toDeg(body.at(-1)) : null,
      },
      track: swap?.track ?? null,
      stats: swap?.stats ?? null,
    };
  });

async function waitFor(pred, what, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  let st;
  for (;;) {
    st = await state();
    if (pred(st)) return st;
    if (Date.now() > end) {
      say('timeout waiting for', what, st);
      return st;
    }
    await sleep(400);
  }
}
const trackChip = (st) =>
  st.chips.find((c) => c[0] === 'history-track:flights') ?? null;
/** Look straight down at the track from high up (camera released). */
async function viewTrack(lat, lon, alt = 650_000) {
  await page.evaluate(
    ({ lat, lon, alt }) => {
      const v = window.__godsEyeView.viewer;
      v.trackedEntity = undefined;
      const r = Math.PI / 180;
      v.camera.setView({
        destination: v.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: lon * r,
          latitude: lat * r,
          height: alt,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    },
    { lat, lon, alt },
  );
  await sleep(2_000);
}
const select = (hex) =>
  page.evaluate(
    (h) =>
      window.__godsEyeView.dataManager.layers
        .get('flights')
        .module.trackById(h, { origin: 'user' }),
    hex,
  );
const near = (a, b, tol = 0.02) =>
  a && Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

// ── 1. live, then history at t ───────────────────────────
await page.goto(`${BASE}/?welcome=0${HASH}`, {
  waitUntil: 'domcontentloaded',
  timeout: 120000,
});
await page.waitForFunction(
  () => window.__godsEyeView?.dataManager && window.__gevHistorySwap,
  { timeout: 180000 },
);
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');
await page.evaluate(async () => {
  await window.__godsEyeView.dataManager.setEnabled('flights', true);
});
let st = await waitFor((s) => s.count === LIVE, 'live aircraft');
check(st.count === LIVE, `live aircraft drawn (${st.count})`);
const e0 = errors.length;
say('errors before history interaction (app, not history):', errors);

const T = Date.now() - 3 * HOUR;
const tAt = inGap(T) || inGap(T - 30 * MIN) ? world.gap.from - 2 * HOUR : T;
await page.evaluate((t) => {
  const h = window.__gevHistorySwap.handle;
  h.expand(true);
  h.seek(t, { snap: true });
}, tAt);
st = await waitFor(
  (s) => s.count === HIST && s.mode === 'history',
  'history aircraft',
);
check(st.count === HIST, `history aircraft at t (${st.count})`);
await sleep(4_000); // a few layer polls: nothing selected -> no track asked
check(
  trackCalls.length === 0,
  `no track request while nothing is selected (${trackCalls.length})`,
);

// ── 2. select a10000 at t: recorded track [t-6h, t] ──────
const t1 = Date.parse(st.time);
const ok = await select('a10000');
check(ok === true, 'a10000 selected');
st = await waitFor(
  (s) => s.tracked === 'a10000' && trackChip(s) && s.trail.n > 100,
  'track at t',
);
const c1 = trackCalls.at(-1);
check(
  c1?.feed === 'aircraft' &&
    c1?.id === 'a10000' &&
    Date.parse(c1.to) === t1 &&
    Date.parse(c1.from) === t1 - 6 * HOUR &&
    c1.minGapSec === '60',
  `track asked for [t-6h, t] of the shown t ${JSON.stringify(c1)} t=${st.time}`,
);
check(liveTrackCalls.length === 0, 'the live track route was never asked');
const want1 = trackBody(0, 'a10000', t1);
const oldest1 = [want1.path[0][1], want1.path[0][2]];
check(
  st.trail.n >= want1.path.length - 1 && near(st.trail.first, oldest1),
  `trail drawn from the recorded track: ${st.trail.n} points, oldest ${JSON.stringify(st.trail.first)} ~ ${JSON.stringify(oldest1)}`,
);
const chip1 = trackChip(st);
check(
  /TRACK A10000, last 6 h: \d+ points \(adsb\.lol \+ OpenSky\)/.test(
    chip1?.[2] ?? '',
  ) && /GAP \d\d:\d\dZ-\d\d:\d\dZ \(not recorded/.test(chip1?.[2] ?? ''),
  `track chip names sources and the recorded gap: ${chip1?.[2]}`,
);
check(
  st.track?.gaps?.length === 1 &&
    st.track.gaps[0].from === t1 - (GAP_FROM_MIN + 1) * MIN &&
    st.track.gaps[0].to === t1 - GAP_TO_MIN * MIN,
  `gap from the RECORDED times ${JSON.stringify(st.track?.gaps)}`,
);
// one camera for both shots (south-west of the track, clear of the control)
const CAM = [
  (want1.path[0][1] + want1.path.at(-1)[1]) / 2 - 0.9,
  (want1.path[0][2] + want1.path.at(-1)[2]) / 2 - 0.2,
];
await viewTrack(...CAM);
await shot('01-selected-track-at-t');

// ── 3. move t: the track follows ─────────────────────────
const nBefore = trackCalls.length;
const t2Want = t1 + 45 * MIN;
await page.evaluate(
  (t) => window.__gevHistorySwap.handle.seek(t, { snap: true }),
  t2Want,
);
st = await waitFor(
  (s) =>
    trackCalls.length > nBefore &&
    Date.parse(trackCalls.at(-1).to) === Date.parse(s.time) &&
    s.tracked === 'a10000' &&
    s.trail.n > 100 &&
    trackChip(s),
  'track follows t',
);
const t2 = Date.parse(st.time);
const c2 = trackCalls.at(-1);
check(
  t2 !== t1 &&
    Date.parse(c2.to) === t2 &&
    Date.parse(c2.from) === t2 - 6 * HOUR,
  `moved t: new track [t-6h, t] (${c2.from} .. ${c2.to})`,
);
const want2 = trackBody(0, 'a10000', t2);
check(
  near(st.trail.first, [want2.path[0][1], want2.path[0][2]]) &&
    !near(st.trail.first, oldest1, 0.05),
  `trail follows t: oldest ${JSON.stringify(st.trail.first)} (was ${JSON.stringify(oldest1)})`,
);
await viewTrack(...CAM);
await shot('02-track-follows-t');

// ── 4. a sampled answer says so ──────────────────────────
await select('a10001');
st = await waitFor(
  (s) => s.tracked === 'a10001' && /SAMPLED/.test(trackChip(s)?.[2] ?? ''),
  'sampled chip',
);
check(
  /TRACK A10001.*SAMPLED/.test(trackChip(st)?.[2] ?? '') &&
    trackChip(st)?.[1] === 'track-warn',
  `sampled track chip: ${trackChip(st)?.[2]}`,
);
await shot('03-sampled-chip');

// ── 5. deselect: chip gone, no more requests ─────────────
await page.keyboard.press('Escape');
st = await waitFor((s) => s.tracked === null && !trackChip(s), 'deselect');
check(!trackChip(st), 'deselect removes the track chip');
const nIdle = trackCalls.length;
await page.evaluate(() => window.__gevHistorySwap.driver.refreshTargets?.());
await sleep(4_000);
check(
  trackCalls.length === nIdle,
  `no track request after deselect (${trackCalls.length - nIdle})`,
);

// ── 6. latency (FIXTURE timing) ──────────────────────────
// 10 distinct selections at the same t: each is a new [t-6h, t] request,
// timed from the layer's track call (above the router) to the parsed
// answer (resource timing does not list intercepted requests). The FIRST
// call of each id is its network request; a re-served frame then hits the
// router cache. (Not the chip's ms: since review R1 only the newest request
// publishes the chip, which may be that cache hit.)
await page.evaluate(() => {
  window.__b12eTimings = {};
  const below = window.fetch;
  window.fetch = async function b12eTimedFetch(input, init) {
    const u = new URL(String(input?.url ?? input), location.href);
    if (u.pathname !== '/api/flights/track')
      return below.call(this, input, init);
    const id = u.searchParams.get('icao24');
    const first = !(id in window.__b12eTimings);
    if (first) window.__b12eTimings[id] = null;
    const t0 = performance.now();
    const res = await below.call(this, input, init);
    if (first && res.ok) {
      await res.clone().json();
      window.__b12eTimings[id] = Math.round(performance.now() - t0);
    }
    return res;
  };
});
for (let i = 2; i < 12; i++) {
  const hex = (0xa10000 + i).toString(16);
  await select(hex);
  await waitFor(
    (s) => s.tracked === hex && s.track?.id === hex,
    `track ${hex}`,
    15_000,
  );
}
const timings = await page.evaluate(() => window.__b12eTimings);
const sorted = Object.values(timings)
  .filter((x) => Number.isFinite(x))
  .sort((a, b) => a - b);
const p95 =
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
say(
  'FIXTURE track timing ms (layer track call -> parsed answer through the router; answer made by the headless request interception, no server, no hop):',
  {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95,
    max: sorted.at(-1),
  },
);
check(
  sorted.length === 10,
  `10 distinct track requests timed (${sorted.length})`,
);

// ── 6b. review R1: a late track answer never makes the chip ──
async function untilHeld(id, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!held.has(id) && Date.now() < end) await sleep(200);
  return held.has(id);
}
await page.keyboard.press('Escape');
await waitFor((s) => s.tracked === null && !trackChip(s), 'deselect (6b)');
// a fresh history time: no track of it is cached yet
let t3 = Date.parse(st.time) - 20 * MIN;
if (inGap(t3) || inGap(t3 - 30 * MIN)) t3 = Date.parse(st.time) + 20 * MIN;
await page.evaluate(
  (t) => window.__gevHistorySwap.handle.seek(t, { snap: true }),
  t3,
);
st = await waitFor(
  (s) => s.mode === 'history' && s.count === HIST && Date.parse(s.time) !== t2,
  'history at t3',
);
holdTrack.add('a10002');
holdTrack.add('a10003');
// deselect before the answer arrives
await select('a10002');
check(await untilHeld('a10002'), 'a10002 track asked and held');
await page.keyboard.press('Escape');
st = await waitFor((s) => s.tracked === null, 'deselect a10002');
release('a10002');
await sleep(2_500);
st = await state();
check(
  !trackChip(st) && st.track === null,
  `R1: a track answer after deselect publishes no chip (${trackChip(st)?.[2] ?? 'none'})`,
);
// another aircraft selected before the old answer arrives
await select('a10003');
check(await untilHeld('a10003'), 'a10003 track asked and held');
await select('a10004');
st = await waitFor(
  (s) =>
    s.tracked === 'a10004' &&
    s.track?.id === 'a10004' &&
    /TRACK A10004/.test(trackChip(s)?.[2] ?? ''),
  'a10004 chip',
);
release('a10003');
await sleep(2_500);
st = await state();
check(
  st.tracked === 'a10004' &&
    st.track?.id === 'a10004' &&
    /TRACK A10004/.test(trackChip(st)?.[2] ?? ''),
  `R1: old a10003 answering last keeps the a10004 chip (${trackChip(st)?.[2]})`,
);
await viewTrack(...CAM);
await shot('05-late-old-answer-keeps-new-chip');
holdTrack.clear();

// ── 7. LIVE: chip gone, live track back ──────────────────
await select('a10000');
await waitFor((s) => s.tracked === 'a10000' && trackChip(s), 'reselect');
await page.click('.gev-hist-live');
st = await waitFor(
  (s) => s.mode === 'live' && !trackChip(s) && s.count === LIVE,
  'LIVE',
);
check(
  st.mode === 'live' && !trackChip(st) && st.count === LIVE,
  `LIVE: history gone, no track chip (${st.count})`,
);
await sleep(1_000);
await shot('04-live-restored');

check(
  errors.length === e0,
  `no console/page error after the first history interaction (${JSON.stringify(errors.slice(e0))})`,
);
const results = {
  base: BASE,
  failures,
  log,
  trackCalls: trackCalls.length,
  liveTrackCalls,
  fixtureTiming: { n: sorted.length, p95, durations: sorted },
};
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
await browser.close();
say(failures.length ? `QA B12e FAIL (${failures.length})` : 'QA B12e PASS');
process.exit(failures.length ? 1 : 0);
