#!/usr/bin/env node
/**
 * N5 live-layer drawing B12f browser QA (card t_5dfbeced), headless
 * Chromium against a running GEV dev server:
 *
 *   node scripts/qa-history-b12f.mjs --url http://127.0.0.1:4398 --out <dir>
 *
 * Fixture mode only: /api/flights and /api/firms answer canned BRIDGE
 * answers whose X-Feed-* headers follow a phase the script sets:
 *   live     fresh (X-Feed-Last-OK = now - 4 s)
 *   stopped  the last good body again, X-Feed-Cache STALE, Stale-Since and
 *            a short Grey-Until (GREY_S from the switch), Age-Ms from the
 *            frozen Last-OK: grey first, cleared once the server clock
 *            (Last-OK + Age-Ms) passes Grey-Until
 *   live     resumed
 * and /api/history/* from the B11 fixture world.
 *
 * Checks, per layer (flights = motion feed, FIRMS = event feed):
 *   live     rows drawn in their own colours, chip LIVE
 *   grey     the same rows still drawn, every sprite grey (r = g = b,
 *            alpha <= 0.45), chip "No data since"
 *   cleared  reached WITHOUT a forced poll (the B11 chip timer, server
 *            clock): nothing drawn, chip only, refreshLayer exactly once
 *   resumed  rows back in their own colours, refreshLayer once more
 *   history  while cleared live, a history seek draws the RECORDED rows in
 *            their own colours (the swapped layer is untouched); LIVE
 *            empties it again (cleared live answer)
 * plus no console / page error. Screenshots after Page.bringToFront.
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
const OUT = path.resolve(arg('--out', 'qa-history-b12f'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
const GREY_S = Number(arg('--grey-s', '75'));
const LAT = 30.2672;
const LON = -97.7431;
const N = { flights: 5, firms: 4, hist: 2 };
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
// phase of the live bridge: {name, lastOk, staleSince, greyUntil}
let phase = { name: 'live' };
const calls = { flights: 0, firms: 0, emptiedSeen: 0 };

const iso = (ms) => new Date(ms).toISOString();
function aircraft(prefix, n, tSec, hexBase) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [
      (hexBase + i).toString(16).padStart(6, '0'),
      `${prefix}${i + 1}`,
      'United States',
      tSec - 3,
      tSec - 2,
      LON + 0.3 * Math.cos(a),
      LAT + 0.3 * Math.sin(a),
      9000 + i * 100,
      false,
      210,
      (i * 40) % 360,
      0,
      null,
      9100 + i * 100,
      '1200',
      false,
      0,
    ];
  });
}
function fires(n, atMs) {
  return Array.from({ length: n }, (_, i) => ({
    lat: LAT + 0.2 * Math.sin(i + 1),
    lon: LON + 0.2 * Math.cos(i + 1),
    frp: 8 + i * 4,
    confidence: 'n',
    brightness: 330 + i,
    brightnessTi5: 290,
    daynight: 'D',
    acqDate: iso(atMs).slice(0, 10),
    acqTime: iso(atMs).slice(11, 16).replace(':', ''),
    satellite: 'N21',
    instrument: 'VIIRS',
  }));
}

/** The bridge headers of the current phase, on the fixture's server clock. */
function bridgeHeaders() {
  const now = Date.now();
  if (phase.name === 'live')
    return {
      'content-type': 'application/json',
      'x-feed-source': 'collector',
      'x-feed-last-ok': String(now - 4_000),
      'x-feed-age-ms': '4000',
      'x-feed-cache': 'HIT',
    };
  return {
    'content-type': 'application/json',
    'x-feed-source': 'collector',
    'x-feed-last-ok': String(phase.lastOk),
    'x-feed-age-ms': String(now - phase.lastOk),
    'x-feed-cache': 'STALE',
    'x-feed-stale-since': String(phase.staleSince),
    'x-feed-grey-until': String(phase.greyUntil),
    'x-feed-reason': 'collector_down',
  };
}
const goodAt = () =>
  phase.name === 'live' ? Date.now() - 4_000 : phase.lastOk;

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
// only /api/* is intercepted (a blanket interception renders the globe white)
const fetchSession = await page.target().createCDPSession();
await fetchSession.send('Fetch.enable', {
  patterns: [{ urlPattern: `${new URL(BASE).origin}/api/*` }],
});
fetchSession.on('Fetch.requestPaused', (ev) => {
  const respond = (status, headers, body) =>
    fetchSession
      .send('Fetch.fulfillRequest', {
        requestId: ev.requestId,
        responseCode: status,
        responseHeaders: Object.entries(headers).map(([name, value]) => ({
          name,
          value: String(value),
        })),
        body: Buffer.from(body).toString('base64'),
      })
      .catch(() => {});
  const json = (body, headers = { 'content-type': 'application/json' }) =>
    respond(200, headers, JSON.stringify(body));
  const url = new URL(ev.request.url);
  const q = Object.fromEntries(url.searchParams);
  if (url.pathname === '/api/flights') {
    calls.flights++;
    const t = goodAt();
    return json(
      {
        time: Math.round(t / 1000),
        states: aircraft('LIVE', N.flights, Math.round(t / 1000), 0xa20000),
      },
      bridgeHeaders(),
    );
  }
  if (url.pathname === '/api/firms') {
    calls.firms++;
    const t = goodAt();
    const list = fires(N.firms, t - 3_600_000);
    return json(
      {
        fetchedAt: t,
        stale: false,
        ttlMs: 1_800_000,
        sources: [{ source: 'VIIRS_NOAA21_NRT', count: list.length, ok: true }],
        count: list.length,
        fires: list,
      },
      bridgeHeaders(),
    );
  }
  if (url.pathname === '/api/history/slice') {
    const t = Date.parse(q.t);
    const h = {
      'content-type': 'application/json',
      'x-history-rows': String(N.hist),
      'x-history-source': 'adsblol',
    };
    if (q.feed === 'aircraft')
      return json(
        {
          time: Math.round(t / 1000),
          states: aircraft('HIST', N.hist, Math.round(t / 1000), 0xa30000),
        },
        h,
      );
    if (q.feed === 'firms')
      return json(
        {
          fetchedAt: t,
          stale: false,
          ttlMs: 1_800_000,
          sources: [{ source: 'VIIRS_NOAA21_NRT', count: N.hist, ok: true }],
          count: N.hist,
          fires: fires(N.hist, t - 3_600_000),
        },
        h,
      );
    return json({}, { ...h, 'x-history-rows': '0', 'x-history-gap': '1' });
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
    return respond(404, { 'content-type': 'application/json' }, '{}');
  return fetchSession
    .send('Fetch.continueRequest', { requestId: ev.requestId })
    .catch(() => {});
});

async function shot(name) {
  await page.bringToFront();
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await sleep(600);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  say('screenshot', file);
}

/** Drawn state: counts, sprite colours, chips, gate stats. */
const state = () =>
  page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    const so = await import('/src/data/spriteOrder.js');
    const isGrey = (k) =>
      Boolean(k) &&
      Math.abs(k.red - k.green) < 1e-6 &&
      Math.abs(k.green - k.blue) < 1e-6 &&
      k.alpha <= 0.4501;
    /** Sprites of a layer + its 3D models (same ids, close-range handoff). */
    const sprites = (id, test = () => true) => {
      const c = so.spriteCollectionOf(id);
      const out = { shown: 0, grey: 0, colour: 0, models: 0 };
      const ids = new Set();
      for (let i = 0; i < (c?.length ?? 0); i++) {
        const b = c.get(i);
        ids.add(b.id);
        if (!b.show || !test(b)) continue;
        out.shown++;
        if (isGrey(b.color)) out.grey++;
        else out.colour++;
      }
      const prims = window.__godsEyeView.viewer.scene.primitives;
      for (let i = 0; i < prims.length; i++) {
        const p = prims.get(i);
        if (p === c || typeof p?.get !== 'function' || !p.length) continue;
        if (!ids.has(p.get(0)?.id) || p.get(0)?.colorBlendMode === undefined)
          continue;
        for (let j = 0; j < p.length; j++) {
          const m = p.get(j);
          if (!m.show) continue;
          out.shown++;
          out.models++;
          if (isGrey(m.color)) out.grey++;
          else out.colour++;
        }
      }
      return out;
    };
    const stats = (id) => dm.layers.get(id)?.module?.getStats?.() ?? {};
    const swap = window.__gevHistorySwap;
    const root = document.querySelector('[data-gev-history]');
    const chips = [...(root?.querySelectorAll('.gev-hist-chip') ?? [])].map(
      (el) => [el.getAttribute('data-feed'), el.textContent],
    );
    return {
      flights: stats('flights').count ?? null,
      firms: stats('local-firms').count ?? null,
      flightSprites: sprites('flights'),
      firmsSprites: sprites('firms', (b) =>
        /^firms-/.test(String(b.id?.id ?? b.id)),
      ),
      feeds: (swap.liveDraw?.getState?.() ?? {}).modes ?? {},
      gate: (swap.liveDraw?.getState?.() ?? {}).stats ?? {},
      chips,
      history: Boolean(swap.router.getState().active),
      painter: swap.painter ? { ...swap.painter.stats } : null,
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
const refreshes = [];
async function watchRefreshes() {
  await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    window.__qaRefreshes = [];
    const orig = dm.refreshLayer.bind(dm);
    dm.refreshLayer = (id, ...rest) => {
      window.__qaRefreshes.push(id);
      return orig(id, ...rest);
    };
  });
}
const refreshLog = () => page.evaluate(() => [...window.__qaRefreshes]);

// ── setup + live ─────────────────────────────────────────
await page.goto(
  `${BASE}/?welcome=0#v=2&lat=${LAT}&lon=${LON}&alt=150000&heading=360&pitch=-90&roll=0&map=esri-imagery`,
  { waitUntil: 'domcontentloaded', timeout: 120000 },
);
await page.waitForFunction(
  () => window.__godsEyeView?.dataManager && window.__gevHistorySwap?.liveDraw,
  { timeout: 180000 },
);
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');
await page.evaluate(async () => {
  const dm = window.__godsEyeView.dataManager;
  for (const id of ['flights', 'local-firms']) await dm.setEnabled(id, true);
});
let st = await waitFor(
  (s) =>
    s.flights === N.flights &&
    s.firms === N.firms &&
    s.flightSprites.colour >= N.flights,
  'live',
);
check(
  st.flights === N.flights && st.firms === N.firms,
  `live: rows drawn flights=${st.flights} firms=${st.firms}`,
);
check(
  st.flightSprites.grey === 0 && st.firmsSprites.grey === 0,
  `live: own colours ${JSON.stringify([st.flightSprites, st.firmsSprites])}`,
);
await shot('01-live');
await watchRefreshes();

// ── stopped -> grey ──────────────────────────────────────
{
  const now = Date.now();
  const lastOk = now - 100_000;
  phase = {
    name: 'stopped',
    lastOk,
    staleSince: lastOk + 90_000,
    greyUntil: now + GREY_S * 1000,
  };
}
// the next poll of each layer (FIRMS polls every 30 min)
await page.evaluate(async () => {
  const dm = window.__godsEyeView.dataManager;
  await dm.refreshLayer('flights');
  await dm.refreshLayer('local-firms');
});
const forced = (await refreshLog()).length;
st = await waitFor(
  (s) =>
    s.feeds.flights === 'grey' &&
    s.feeds.firms === 'grey' &&
    s.flightSprites.grey >= N.flights &&
    s.firmsSprites.grey >= 1,
  'grey',
);
check(
  st.feeds.flights === 'grey' && st.feeds.firms === 'grey',
  `grey: feed modes ${JSON.stringify(st.feeds)}`,
);
check(
  st.flights === N.flights && st.firms === N.firms,
  `grey: last good rows still drawn flights=${st.flights} firms=${st.firms}`,
);
check(
  st.flightSprites.colour === 0 &&
    st.flightSprites.grey === st.flightSprites.shown &&
    st.flightSprites.shown >= N.flights,
  `grey: every flight sprite grey ${JSON.stringify(st.flightSprites)}`,
);
check(
  st.firmsSprites.colour === 0 && st.firmsSprites.grey >= N.firms,
  `grey: every FIRMS sprite grey ${JSON.stringify(st.firmsSprites)}`,
);
check(
  st.chips.some(([, t]) => /No data since/.test(t)),
  `grey: chip ${JSON.stringify(st.chips)}`,
);
await shot('02-grey');

// ── cleared on the server clock, no forced poll ──────────
const beforeClear = await refreshLog();
st = await waitFor(
  (s) =>
    s.feeds.flights === 'cleared' &&
    s.feeds.firms === 'cleared' &&
    s.flights === 0 &&
    s.firms === 0,
  'cleared',
  GREY_S * 1000 + 60_000,
);
const clearRefresh = (await refreshLog()).slice(beforeClear.length);
check(
  st.flights === 0 && st.firms === 0,
  `cleared: nothing drawn flights=${st.flights} firms=${st.firms}`,
);
check(
  st.flightSprites.shown === 0 && st.firmsSprites.shown === 0,
  `cleared: no sprites ${JSON.stringify([st.flightSprites, st.firmsSprites])}`,
);
check(
  clearRefresh.filter((x) => x === 'local-firms').length === 1,
  `cleared: FIRMS refreshLayer exactly once (${JSON.stringify(clearRefresh)})`,
);
check(
  clearRefresh.filter((x) => x === 'flights').length === 1,
  `cleared: flights refreshLayer exactly once by the gate`,
);
check(
  st.chips.some(([, t]) => /No data since/.test(t)),
  `cleared: chip only ${JSON.stringify(st.chips)}`,
);
check(
  st.gate.emptied > 0,
  `cleared: answers emptied ${JSON.stringify(st.gate)}`,
);
await shot('03-cleared');
// it stays cleared over more polls
await sleep(8_000);
st = await state();
check(
  st.flights === 0,
  `cleared: still nothing after more polls (${st.flights})`,
);

// ── history while cleared live: the swapped layer is untouched ─────
const T = Date.now() - 3 * 3_600_000;
await page.evaluate((t) => {
  const h = window.__gevHistorySwap.handle;
  h.expand(true);
  h.seek(t);
}, T);
st = await waitFor(
  (s) => s.history && s.flights === N.hist && s.flightSprites.colour >= N.hist,
  'history at t',
);
check(
  st.flights === N.hist && st.flightSprites.grey === 0,
  `history: recorded rows in their own colours ${JSON.stringify(st.flightSprites)} n=${st.flights}`,
);
await shot('04-history-while-cleared');
await page.evaluate(() => window.__gevHistorySwap.handle.leave());
st = await waitFor((s) => !s.history && s.flights === 0, 'LIVE again, cleared');
check(
  !st.history && st.flights === 0,
  `LIVE exit: cleared live feed shows nothing (${st.flights})`,
);

// ── resumed ──────────────────────────────────────────────
phase = { name: 'live' };
const beforeResume = await refreshLog();
await page.evaluate(() =>
  window.__godsEyeView.dataManager.refreshLayer('local-firms'),
);
st = await waitFor(
  (s) =>
    s.flights === N.flights &&
    s.firms === N.firms &&
    s.feeds.flights === 'live' &&
    s.feeds.firms === 'live' &&
    s.flightSprites.colour >= N.flights,
  'resumed',
  60_000,
);
const resumeRefresh = (await refreshLog()).slice(beforeResume.length);
check(
  st.flights === N.flights && st.firms === N.firms,
  `resumed: rows back flights=${st.flights} firms=${st.firms}`,
);
check(
  st.flightSprites.grey === 0 && st.firmsSprites.grey === 0,
  `resumed: own colours ${JSON.stringify([st.flightSprites, st.firmsSprites])}`,
);
check(
  resumeRefresh.filter((x) => x === 'flights').length === 1,
  `resumed: flights refreshLayer once by the gate (${JSON.stringify(resumeRefresh)})`,
);
check(
  resumeRefresh.filter((x) => x === 'local-firms').length === 2,
  `resumed: FIRMS = the forced next poll + ONE gate refresh`,
);
await shot('05-resumed');

check(errors.length === 0, `no console/page errors ${JSON.stringify(errors)}`);
say('forced polls', forced, 'calls', calls);
say(failures.length ? `QA B12f FAIL (${failures.length})` : 'QA B12f PASS');
writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
