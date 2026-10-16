#!/usr/bin/env node
/**
 * History layer swap (card B12a) browser QA, headless Chromium against a
 * running GEV dev server:
 *
 *   node scripts/qa-history-b12a.mjs --url http://127.0.0.1:4366 --out <dir>
 *        [--settle-ms 20000]
 *
 * Fixture mode only: every /api/history/* request is answered in the
 * browser (coverage/snapshots from the B11 known-gap world; slices made
 * here), and /api/flights, /api/military, /api/vessels from canned LIVE
 * answers. The history and live aircraft/ships carry different callsigns
 * and counts, so what a layer shows tells which source it drew.
 *
 * Checks: flights, military and vessels show the recorded slice at t (count
 * + "History: ..." source label) and NOT the live rows; the chip strip shows
 * a LIVE chip for the other enabled layer (earthquakes) and none for the
 * three swapped ones; a recorded gap draws no aircraft; 60x playback asks
 * minute frames and prefetches (<= 2 in flight); LIVE restores the live
 * rows and removes the LIVE chips; a failing slice API passes the layers
 * through to live with "LIVE (history unavailable)" chips; no console/page
 * error after the first history interaction. Screenshots after
 * Page.bringToFront. Exit 1 on failure.
 *
 * Round 3 (review R1/R3, owner option A): the history aircraft sit at a
 * place that depends on t (histShift), so the SAME hex moves between
 * frames: after a seek back in time the drawn position is that frame's
 * (not the previous one's); paused, dead reckoning is frozen; a TRACKED
 * aircraft absent from a frame (recorded gap) is released at once; and a
 * live track route is refused while history is shown.
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
const BASE = arg('--url', 'http://127.0.0.1:4366');
const OUT = path.resolve(arg('--out', 'qa-history-b12a'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
const LAT = 30.2672;
const LON = -97.7431;
const HASH = `#v=2&lat=${LAT}&lon=${LON}&alt=60000&heading=360&pitch=-90&roll=0&map=esri-imagery`;
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
const HIST = { aircraft: 12, military: 4, vessels: 5 };
const LIVE = { aircraft: 8, military: 2, vessels: 3 };
say(
  'fixture gap',
  new Date(world.gap.from).toISOString(),
  new Date(world.gap.to).toISOString(),
);

// ── fixtures ────────────────────────────────────────────
const ring = (i, n, r) => {
  const a = (2 * Math.PI * i) / n;
  return [LAT + r * Math.sin(a), LON + r * Math.cos(a)];
};
/** History aircraft move with t: 0.3 deg of longitude per hour (mod 5 h). */
const histShift = (tMs) => ((tMs / 3_600_000) % 5) * 0.3;
function aircraftStates(prefix, n, tSec, hexBase, source, shift = 0) {
  return Array.from({ length: n }, (_, i) => {
    const [la, lo0] = ring(i, n, 0.12);
    const lo = lo0 + shift;
    const hex = (hexBase + i).toString(16).padStart(6, '0');
    return [
      hex,
      `${prefix}${String(i + 1).padStart(2, '0')}`,
      'United States',
      tSec - 3,
      tSec - 2,
      lo,
      la,
      9000 + i * 100,
      false,
      210,
      (i * 30) % 360,
      0,
      null,
      9100 + i * 100,
      '1200',
      false,
      0,
      3,
      ...(source ? [source] : []),
    ];
  });
}
function militaryRows(prefix, n, hexBase, source) {
  return Array.from({ length: n }, (_, i) => {
    const [la, lo] = ring(i, n, 0.2);
    return {
      hex: (hexBase + i).toString(16).padStart(6, '0'),
      flight: `${prefix}${i + 1}`,
      t: 'C17',
      r: `MIL-${i}`,
      dbFlags: 1,
      alt_baro: 22000,
      alt_geom: 22300,
      gs: 380,
      track: (i * 70) % 360,
      baro_rate: 0,
      lat: la,
      lon: lo,
      seen: 1,
      seen_pos: 2,
      ...(source ? { source } : {}),
    };
  });
}
function vesselRows(prefix, n, isoTime, source) {
  return Array.from({ length: n }, (_, i) => {
    const [la, lo] = ring(i, n, 0.05);
    return {
      lat: la,
      lon: lo,
      name: `${prefix} ${i + 1}`,
      mmsi: String(366999000 + i + (prefix === 'LIVE SHIP' ? 100 : 0)),
      imo: '',
      type: '70',
      destination: 'AUSTIN',
      speed: 8,
      course: 90,
      heading: 90,
      last_position_UTC: isoTime,
      last_position_epoch: Math.floor(Date.parse(isoTime) / 1000),
      ...(source ? { source } : {}),
    };
  });
}
const inGap = (t) => t >= world.gap.from && t < world.gap.to;

function liveHeaders(extra = {}) {
  const now = Date.now();
  return {
    'content-type': 'application/json',
    'x-feed-source': 'collector',
    'x-feed-last-ok': String(now - 4_000),
    'x-feed-age-ms': '4000',
    'x-feed-cache': 'HIT',
    ...extra,
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
const sliceCalls = [];
let sliceDown = false;
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
    sliceCalls.push({
      feed: q.feed,
      t: q.t,
      bbox: q.bbox ?? null,
      at: Date.now(),
    });
    if (sliceDown)
      return json({ error: 'history_unavailable' }, undefined, 503);
    const t = Date.parse(q.t);
    const h = (rows, src) => ({
      'content-type': 'application/json',
      'x-history-source': rows ? src : 'none',
      'x-history-rows': String(rows),
      ...(rows ? {} : { 'x-history-gap': '1' }),
    });
    if (q.feed === 'aircraft') {
      const states = inGap(t)
        ? []
        : aircraftStates(
            'HIST',
            HIST.aircraft,
            Math.round(t / 1000),
            0xa10000,
            'adsblol',
            histShift(t),
          );
      return json(
        { time: Math.round(t / 1000), states },
        h(states.length, 'adsblol,opensky'),
      );
    }
    if (q.feed === 'military') {
      const ac = militaryRows('HMIL', HIST.military, 0xae1000, 'adsb.lol');
      return json(
        { ac, msg: 'No error', now: t, total: ac.length, ctime: t, ptime: 0 },
        h(ac.length, 'adsb.lol'),
      );
    }
    if (q.feed === 'vessels') {
      const rows = vesselRows(
        'HIST SHIP',
        HIST.vessels,
        new Date(t - 90_000).toISOString(),
        'aisstream',
      );
      return json(
        {
          rows,
          source: 'history',
          status: 'history',
          error: null,
          refreshing: false,
          newestPositionAt: rows[0].last_position_UTC,
          lastMessageAt: null,
        },
        h(rows.length, 'aisstream'),
      );
    }
    return json({ error: 'unknown_feed' }, undefined, 400);
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
  if (url.pathname === '/api/flights')
    return json(
      {
        time: Math.round(now / 1000),
        states: aircraftStates(
          'LIVE',
          LIVE.aircraft,
          Math.round(now / 1000),
          0xb20000,
        ),
      },
      liveHeaders(),
    );
  if (url.pathname === '/api/military')
    return json(
      {
        ac: militaryRows('LMIL', LIVE.military, 0xae2000),
        msg: 'No error',
        now,
        total: LIVE.military,
        ctime: now,
        ptime: 1,
      },
      liveHeaders(),
    );
  if (url.pathname === '/api/vessels') {
    const rows = vesselRows(
      'LIVE SHIP',
      LIVE.vessels,
      new Date(now - 30_000).toISOString(),
    );
    return json(
      {
        rows,
        source: 'AISStream',
        status: 'live',
        error: null,
        refreshing: false,
        newestPositionAt: rows[0].last_position_UTC,
        lastMessageAt: now - 1_000,
        silentForMs: 1000,
        reconnectAttempt: 0,
        nextAttemptAt: null,
        staleAfterMs: 120000,
        watchdog: 'armed',
      },
      liveHeaders(),
    );
  }
  return req.continue();
});

async function shot(name) {
  await page.bringToFront();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  say('screenshot', file);
}

const LAYERS = ['flights', 'military', 'ais-live-vessels'];
const layerState = () =>
  page.evaluate((ids) => {
    const dm = window.__godsEyeView.dataManager;
    const out = {};
    for (const id of [...ids, 'earthquakes']) {
      const entry = dm.layers.get(id);
      const stats = entry?.module?.getStats?.() ?? {};
      out[id] = {
        enabled: Boolean(entry?.enabled),
        count: stats.count ?? null,
        source: entry?.module?.source ?? null,
        error: stats.error ?? stats.lastError ?? null,
      };
    }
    const root = document.querySelector('[data-gev-history]');
    out.mode = root?.getAttribute('data-mode');
    out.time = root?.getAttribute('data-time');
    out.chips = [...(root?.querySelectorAll('.gev-hist-chip') ?? [])].map(
      (c) => [
        c.getAttribute('data-feed'),
        c.getAttribute('data-state'),
        c.textContent,
      ],
    );
    const swap = window.__gevHistorySwap?.router?.getState?.();
    out.router = swap
      ? {
          active: swap.active,
          swapped: swap.swapped,
          failed: swap.failed,
          stats: swap.stats,
          prefetchInFlight: swap.prefetchInFlight,
          servedFlightsT: swap.served?.flights?.t ?? null,
        }
      : null;
    return out;
  }, LAYERS);

async function waitFor(pred, what, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  let st;
  for (;;) {
    st = await layerState();
    if (pred(st)) return st;
    if (Date.now() > end) {
      say('timeout waiting for', what, st);
      return st;
    }
    await sleep(500);
  }
}

const counts = (st) => LAYERS.map((id) => st[id].count);
const aircraftAt = (hex) =>
  page.evaluate((h) => {
    const m = window.__godsEyeView.dataManager.layers.get('flights').module;
    const d = m.findByQuery(h);
    return d ? { lat: d.latitude, lon: d.longitude } : null;
  }, hex);
/** km between a drawn aircraft and a lat/lon (equirectangular is enough). */
const kmTo = (p, lat, lon) =>
  p
    ? Math.hypot(
        (p.lat - lat) * 111.32,
        (p.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180),
      )
    : Infinity;
const unswapped = (st) => st.chips.filter((c) => c[1] === 'unswapped');

// ── 1. live ──────────────────────────────────────────────
await page.goto(`${BASE}/?welcome=0${HASH}`, {
  waitUntil: 'domcontentloaded',
  timeout: 120000,
});
await page.waitForFunction(
  () => window.__godsEyeView?.dataManager && window.__gevHistorySwap,
  {
    timeout: 180000,
  },
);
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');
await page.evaluate(async () => {
  const dm = window.__godsEyeView.dataManager;
  for (const id of ['flights', 'military', 'ais-live-vessels', 'earthquakes'])
    await dm.setEnabled(id, true);
});
let st = await waitFor(
  (s) =>
    counts(s).join() === [LIVE.aircraft, LIVE.military, LIVE.vessels].join(),
  'live counts',
);
check(
  counts(st).join() === [LIVE.aircraft, LIVE.military, LIVE.vessels].join(),
  `live rows drawn ${JSON.stringify(counts(st))}`,
);
check(
  st.mode === 'live' && unswapped(st).length === 0,
  'no LIVE chips while live',
);
await shot('01-live');
const e0 = errors.length;
say(
  'errors before history interaction (app, not history):',
  errors.slice(0, 10),
);

// ── 2. history at t ──────────────────────────────────────
const T = Date.now() - 3 * 3_600_000;
const tAt = inGap(T) ? world.gap.from - 30 * 60_000 : T;
await page.evaluate((t) => {
  const h = window.__gevHistorySwap.handle;
  h.expand(true);
  h.seek(t, { snap: true });
}, tAt);
st = await waitFor(
  (s) =>
    counts(s).join() === [HIST.aircraft, HIST.military, HIST.vessels].join(),
  'history counts',
);
check(
  counts(st).join() === [HIST.aircraft, HIST.military, HIST.vessels].join(),
  `history rows at t drawn, live rows gone ${JSON.stringify(counts(st))}`,
);
check(
  LAYERS.every((id) => /^History/.test(st[id].source ?? '')),
  `source labels ${JSON.stringify(LAYERS.map((id) => st[id].source))}`,
);
check(
  JSON.stringify(st.router?.swapped) ===
    JSON.stringify(['flights', 'military', 'vessels']),
  `swapped ${JSON.stringify(st.router?.swapped)}`,
);
const un = unswapped(st).map((c) => c[0]);
check(
  un.includes('layer:earthquakes') &&
    !un.some((f) => /flights|military|vessels/.test(f)),
  `LIVE chip on earthquakes only ${JSON.stringify(unswapped(st))}`,
);
const tShown = Date.parse(st.time);
const asked = sliceCalls
  .filter((c) => Date.parse(c.t) === tShown)
  .map((c) => c.feed);
check(
  ['aircraft', 'military', 'vessels'].every((f) => asked.includes(f)),
  `slices asked at the shown t ${st.time}: ${JSON.stringify([...new Set(asked)])}`,
);
check(
  sliceCalls.some((c) => c.feed === 'aircraft' && c.bbox),
  'aircraft slice carries the view bbox',
);
await shot('02-history-at-t');

// ── 2b. round 3: same hex across seeks, paused freeze, live track refused ─
{
  const tShownMs = Date.parse(st.time);
  const here = await aircraftAt('a10000');
  const d0 = kmTo(here, LAT, LON + 0.12 + histShift(tShownMs));
  check(
    d0 < 10,
    `a10000 drawn at its slice position at t (${d0.toFixed(2)} km)`,
  );
  await sleep(3_000);
  const later = await aircraftAt('a10000');
  const frozenM = kmTo(later, here?.lat ?? 0, here?.lon ?? 0) * 1000;
  check(frozenM < 50, `paused: no coasting over 3 s (${frozenM.toFixed(1)} m)`);
  const tBack = tShownMs - 2 * 3_600_000;
  await page.evaluate(
    (t) => window.__gevHistorySwap.handle.seek(t, { snap: true }),
    tBack,
  );
  st = await waitFor(
    (s) =>
      Math.abs(Date.parse(s.time) - tBack) < 600_000 &&
      s.router?.servedFlightsT === Date.parse(s.time) &&
      s.flights.count === HIST.aircraft,
    'seek back 2 h (frame of the new t served)',
  );
  await sleep(500); // the layer applies the served frame
  const back = await aircraftAt('a10000');
  const want = LON + 0.12 + histShift(Date.parse(st.time));
  const d1 = kmTo(back, LAT, want);
  const dPrev = kmTo(back, LAT, LON + 0.12 + histShift(tShownMs));
  check(
    d1 < 10 && dPrev > 30,
    `seek back: same hex at THAT frame's place (${d1.toFixed(2)} km), not the previous frame's (${dPrev.toFixed(1)} km)`,
  );
  const track = await page.evaluate(async () => {
    const r = await fetch('/api/flights/track?icao24=a10000');
    return r.status;
  });
  check(track === 404, `live track refused in history (${track})`);
  // a TRACKED aircraft absent from a frame is released at once (R1)
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('flights')
      .module.trackById('a10000'),
  );
  const tracked = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('flights')
        .module.getTrackedInfo()?.icao24 ?? null,
  );
  check(tracked === 'a10000', `tracked a10000 (${tracked})`);
  await page.evaluate(
    (t) => window.__gevHistorySwap.handle.seek(t),
    Math.round((world.gap.from + world.gap.to) / 2),
  );
  st = await waitFor((s) => s.flights.count === 0, 'gap with a tracked hex');
  const after = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('flights')
        .module.getTrackedInfo()?.icao24 ?? null,
  );
  check(
    st.flights.count === 0 && after === null,
    `gap: tracked aircraft released and gone at once (count ${st.flights.count}, tracked ${after})`,
  );
  await page.evaluate(
    (t) => window.__gevHistorySwap.handle.seek(t, { snap: true }),
    tAt,
  );
  await waitFor((s) => s.flights.count === HIST.aircraft, 'back at t');
}

// ── 3. recorded gap -> no aircraft ───────────────────────
const gapT = Math.round((world.gap.from + world.gap.to) / 2);
await page.evaluate((t) => window.__gevHistorySwap.handle.seek(t), gapT);
st = await waitFor((s) => s.flights.count === 0, 'gap: no aircraft');
check(st.flights.count === 0, `gap: no aircraft drawn (${st.flights.count})`);
check(
  st.military.count === HIST.military,
  'gap of the aircraft lanes leaves military drawn',
);
await shot('03-gap-no-aircraft');

// ── 4. playback 60x ──────────────────────────────────────
await page.evaluate((t) => {
  const h = window.__gevHistorySwap.handle;
  h.seek(t);
  h.setRate(60);
  h.play();
}, tAt);
const before = sliceCalls.length;
await sleep(12_000);
st = await layerState();
await page.evaluate(() => window.__gevHistorySwap.handle.pause());
const played = sliceCalls.slice(before);
const minuteAligned = played.filter(
  (c) => Date.parse(c.t) % 60_000 === 0,
).length;
say(
  'playback slices',
  played.length,
  'minute-aligned',
  minuteAligned,
  'router',
  st.router,
);
check(played.length >= 4, `playback asked frames (${played.length})`);
check(
  minuteAligned === played.length,
  'playback frames are recorded snapshot / minute times',
);
check(
  (st.router?.stats?.prefetches ?? 0) >= 2,
  `prefetched ${st.router?.stats?.prefetches}`,
);
check(
  (st.router?.stats?.maxInFlight ?? 9) <= 2,
  `prefetch in flight max ${st.router?.stats?.maxInFlight}`,
);
check(
  st.flights.count === HIST.aircraft,
  `playback keeps drawing the recording (${st.flights.count})`,
);
await shot('04-playback-60x');

// ── 5. LIVE restores live data ───────────────────────────
await page.click('.gev-hist-live');
st = await waitFor(
  (s) =>
    s.mode === 'live' &&
    counts(s).join() === [LIVE.aircraft, LIVE.military, LIVE.vessels].join(),
  'live restored',
  30_000,
);
check(
  counts(st).join() === [LIVE.aircraft, LIVE.military, LIVE.vessels].join(),
  `LIVE restores live rows ${JSON.stringify(counts(st))}`,
);
check(unswapped(st).length === 0, 'LIVE chips gone on LIVE');
check(
  LAYERS.every((id) => !/^History/.test(st[id].source ?? '')),
  'live source labels back',
);
await shot('05-live-restored');

// ── 6. slice API failing -> pass-through + LIVE chips ────
sliceDown = true;
await page.evaluate(
  (t) => window.__gevHistorySwap.handle.seek(t, { snap: true }),
  tAt,
);
st = await waitFor(
  (s) => s.mode === 'history' && (s.router?.failed?.length ?? 0) === 3,
  'failure pass-through',
);
check(
  counts(st).join() === [LIVE.aircraft, LIVE.military, LIVE.vessels].join(),
  `history API down: layers stay live ${JSON.stringify(counts(st))}`,
);
const unav = unswapped(st).filter((c) => /history unavailable/.test(c[2]));
check(
  unav.length === 3,
  `LIVE (history unavailable) chips ${JSON.stringify(unswapped(st))}`,
);
check(
  !st.chips.some((c) => c[1] === 'live'),
  `no duplicate green feed chips next to the LIVE chips ${JSON.stringify(st.chips)}`,
);
await shot('06-history-down-live-chips');
sliceDown = false;
await page.click('.gev-hist-live');
await sleep(1000);

// ── 7. round 4 (R6): a layer first enabled while history is paused ───
// is served history by its own enable poll, and LIVE must refresh it once
// (D4), well before its own interval would
const LATE = {
  flights: ['aircraft', LIVE.aircraft, HIST.aircraft],
  military: ['military', LIVE.military, HIST.military],
  'ais-live-vessels': ['vessels', LIVE.vessels, HIST.vessels],
};
for (const [id, [feed, liveN, histN]] of Object.entries(LATE)) {
  await page.evaluate(async (ids) => {
    const dm = window.__godsEyeView.dataManager;
    for (const l of ids) await dm.setEnabled(l, false);
  }, LAYERS);
  await waitFor((s) => s.mode === 'live', 'live before late enable', 10_000);
  await page.evaluate((t) => {
    const h = window.__gevHistorySwap.handle;
    h.expand(true);
    h.seek(t, { snap: true });
  }, tAt);
  await waitFor((s) => s.mode === 'history', 'history (late enable)', 10_000);
  await sleep(1500); // the release refresh has run with the layer disabled
  const asked0 = sliceCalls.filter((c) => c.feed === feed).length;
  await page.evaluate((l) => {
    window.__godsEyeView.dataManager.setEnabled(l, true);
  }, id);
  st = await waitFor(
    (s) => s[id].count === histN && /^History/.test(s[id].source ?? ''),
    `late-enabled ${id} drawn from history`,
    20_000,
  );
  check(
    st[id].count === histN &&
      sliceCalls.filter((c) => c.feed === feed).length > asked0,
    `R6 ${id} enabled while paused: history drawn (${st[id].count}, ${st[id].source})`,
  );
  const callsBefore = await page.evaluate(
    () => window.__gevHistorySwap.driver.calls.length,
  );
  await page.click('.gev-hist-live');
  // no interval of these layers fires within 4 s of the enable poll
  st = await waitFor(
    (s) =>
      s.mode === 'live' &&
      s[id].count === liveN &&
      !/^History/.test(s[id].source ?? ''),
    `late-enabled ${id} live after LIVE`,
    4_000,
  );
  const exitCalls = await page.evaluate(
    (n) => window.__gevHistorySwap.driver.calls.slice(n).map((c) => c.layerId),
    callsBefore,
  );
  check(
    st.mode === 'live' &&
      st[id].count === liveN &&
      !/^History/.test(st[id].source ?? ''),
    `R6 ${id}: LIVE restores live rows at once (${st[id].count}, ${st[id].source})`,
  );
  check(
    JSON.stringify(exitCalls) === JSON.stringify([id]),
    `R6 ${id}: LIVE refreshes exactly the late-enabled layer once ${JSON.stringify(exitCalls)}`,
  );
  if (id === 'military') await shot('07-late-enable-live-restored');
}
await page.evaluate(async (ids) => {
  const dm = window.__godsEyeView.dataManager;
  for (const l of ids) await dm.setEnabled(l, true);
}, LAYERS);
await sleep(1000);

check(
  errors.length === e0,
  `no console/page error after the first history interaction (${JSON.stringify(errors.slice(e0))})`,
);
say('slice calls', sliceCalls.length);
const results = { base: BASE, failures, log, sliceCalls: sliceCalls.length };
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
await browser.close();
say(failures.length ? `QA B12a FAIL (${failures.length})` : 'QA B12a PASS');
process.exit(failures.length ? 1 : 0);
