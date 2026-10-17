#!/usr/bin/env node
/**
 * History layer swap B12b browser QA (card t_2551f0be), headless Chromium
 * against a running GEV dev server:
 *
 *   node scripts/qa-history-b12b.mjs --url http://127.0.0.1:4398 --out <dir>
 *        [--settle-ms 20000]
 *
 * Fixture mode only: /api/history/* is answered in the browser and the six
 * live routes (/api/firms, /api/fire-perimeters, /api/cyclones,
 * /api/launches, /api/transit/vehicles/*, /api/gbfs/*) from canned LIVE
 * answers. History and live rows carry different names and counts, so what
 * a layer shows tells which source it drew.
 *
 * t = now - 35 days: every recorded launch NET is older than 30 days before
 * the browser clock, so the launches row proves the as-of window ends at t.
 *
 * Checks: FIRMS / perimeters / cyclones / launches show the recorded slice
 * at t and not the live rows; FIRMS asks with the camera bbox and its
 * truncated answer is in the chip strip; perimeter rows carry the "not
 * recorded (unknown)" line and no invented values; cyclones draw positions
 * only (Track/cone unavailable); transit (capmetro-austin) and bike share
 * (austin-capmetro) show the recorded vehicles / stations at t, not the
 * live ones (owner decision option A: the frame seams), with no LIVE chip;
 * a recorded gap draws nothing for the six swapped layers; LIVE restores
 * every live count; no console/page error. One screenshot per layer at t, after Page.bringToFront. Exit 1 on
 * failure.
 *
 * What is DRAWN is checked, not only the layer counts (review R1): the world
 * overlay entries and painted cards per source, the FIRMS glow sprites, the
 * layer entities, and a pixel readback of the world-overlay canvas.
 *
 * Capture path: Chromium runs with --disable-accelerated-2d-canvas (a
 * software 2-D canvas; WebGL stays on SwiftShader). With the accelerated
 * SwiftShader 2-D canvas, the world-overlay canvas (getContext('2d',
 * {desynchronized: true}), src/overlays/worldOverlay.js, unchanged by B12)
 * re-presents an OLDER buffer every few frames: its getImageData flips
 * between 0 and the same earlier ink count while the host has 0 entries and
 * paints 0 cards. The same steps with a software 2-D canvas, or with
 * desynchronized:false, stay at 0 ink. --accel-2d-canvas reproduces the old
 * path. Not verified on a hardware GPU. A software 2-D canvas made
 * {desynchronized: true} is not composited into page screenshots, so
 * shot() lays the overlay canvas readback over it for the capture (see
 * shot()).
 *
 * Only /api/* is intercepted, so the globe imagery loads (a blanket
 * interception rendered the globe white). The screenshots certify the
 * fixture rendering of the swapped layers, not map fidelity.
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
const OUT = path.resolve(arg('--out', 'qa-history-b12b'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
const LAT = 30.2672;
const LON = -97.7431;
const DAY = 86_400_000;
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
const inGap = (t) => t >= world.gap.from && t < world.gap.to;
const HIST = {
  firms: 7,
  perimeters: 2,
  cyclones: 1,
  launches: 3,
  transit: 4,
  bikeshare: 5,
};
const LIVE = {
  firms: 3,
  perimeters: 1,
  cyclones: 1,
  launches: 2,
  transit: 2,
  bikeshare: 3,
};
const ALT = 30_000; // bike share loads below ~48 km

// ── fixtures ────────────────────────────────────────────
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
const hhmm = (ms) => iso(ms).slice(11, 16).replace(':', '');
function fires(n, atMs, spread) {
  return Array.from({ length: n }, (_, i) => ({
    lat: LAT + spread * Math.sin(i),
    lon: LON + spread * Math.cos(i),
    frp: 5 + i * 3,
    confidence: 'n',
    brightness: 320 + i,
    brightnessTi5: 290,
    daynight: 'D',
    acqDate: ymd(atMs - i * 3_600_000),
    acqTime: hhmm(atMs - i * 3_600_000),
    satellite: 'N21',
    instrument: 'VIIRS',
  }));
}
function square(lat, lon, d) {
  return [
    [
      [
        [lon - d, lat - d],
        [lon + d, lat - d],
        [lon + d, lat + d],
        [lon - d, lat + d],
        [lon - d, lat - d],
      ],
    ],
  ];
}
function perimeter(id, name, lat, lon, updated, history) {
  const unknown = history
    ? {
        category: null,
        discoveredTime: null,
        cause: null,
        behavior: null,
        personnel: null,
        costToDate: null,
        complexity: null,
        complexName: null,
      }
    : {
        category: 'WF',
        discoveredTime: updated - 2 * DAY,
        cause: 'Human',
        behavior: 'Minimal',
        personnel: 40,
        costToDate: 250000,
        complexity: 'Type 3 Incident',
        complexName: null,
      };
  return {
    stableId: id,
    name,
    acres: 1200,
    containedPct: 40,
    state: 'US-TX',
    ...unknown,
    updatedTime: updated,
    county: 'Travis',
    polygons: square(lat, lon, 0.06),
  };
}
const CYCLONE_ENV = {
  schemaVersion: 1,
  source: 'NOAA NHC / CPHC',
  attribution:
    'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
  coverage:
    'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
};
function storm(id, name, issuedMs, history) {
  return {
    id,
    name,
    classification: 'TS',
    basin: id.slice(0, 2).toUpperCase(),
    position: { longitude: LON + 2.2, latitude: LAT - 1.4 },
    positionAt: iso(issuedMs),
    advisoryNumber: '7',
    issuedAt: iso(issuedMs),
    windKt: 50,
    pressureHpa: 998,
    movement: { directionDegrees: 300, speedKt: 9 },
    advisoryUrl: null,
    outlookUrl: null,
    geometryStatus: 'unavailable',
    geometryAdvisoryNumber: null,
    forecastPoints: [],
    track: null,
    cone: null,
    ...(history
      ? {
          recordedTrack: {
            type: 'LineString',
            coordinates: [
              [LON + 2.2, LAT - 1.4],
              [LON + 1, LAT],
            ],
          },
          recordedCone: null,
          positionAtRecorded: false,
          source: 'noaa-nhc',
        }
      : {}),
  };
}
function launch(id, name, netMs, lat, lon) {
  return {
    id,
    name,
    status: { name: 'Launch Successful' },
    last_updated: iso(netMs + 3_600_000),
    net: iso(netMs),
    launch_service_provider: { name: 'QA Rockets' },
    mission: { name: name.split('|')[1]?.trim() ?? name },
    pad: { name: 'QA Pad', latitude: lat, longitude: lon },
  };
}

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
    // the reliable capture path (see the header); --accel-2d-canvas keeps
    // the accelerated 2-D canvas to reproduce the stale-buffer artefact
    ...(process.argv.includes('--accel-2d-canvas')
      ? []
      : ['--disable-accelerated-2d-canvas']),
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
const sliceCalls = [];
page.on('pageerror', (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text().slice(0, 300)}`);
});
/**
 * Only /api/* is intercepted (CDP Fetch with a URL pattern). Puppeteer's
 * blanket setRequestInterception also pauses every imagery tile, and the
 * globe then renders white (checked on this branch: the same page without
 * interception shows the Esri imagery), so the screenshots showed nothing to
 * read the layers against.
 */
const fetchSession = await page.target().createCDPSession();
await fetchSession.send('Fetch.enable', {
  patterns: [{ urlPattern: `${new URL(BASE).origin}/api/*` }],
});
fetchSession.on('Fetch.requestPaused', (ev) => {
  const req = {
    url: () => ev.request.url,
    respond: ({ status, headers = {}, body = '' }) =>
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
        .catch(() => {}),
    continue: () =>
      fetchSession
        .send('Fetch.continueRequest', { requestId: ev.requestId })
        .catch(() => {}),
  };
  onApiRequest(req);
});
function onApiRequest(req) {
  const url = new URL(req.url());
  const json = (
    body,
    headers = { 'content-type': 'application/json' },
    status = 200,
  ) => req.respond({ status, headers, body: JSON.stringify(body) });
  const q = Object.fromEntries(url.searchParams);
  const now = Date.now();
  if (url.pathname === '/api/history/slice') {
    sliceCalls.push({ feed: q.feed, t: q.t, bbox: q.bbox ?? null });
    const t = Date.parse(q.t);
    const gap = inGap(t);
    const h = (rows, extra = {}) => ({
      'content-type': 'application/json',
      'x-history-rows': String(rows),
      ...(rows ? {} : { 'x-history-gap': '1' }),
      ...extra,
    });
    if (q.feed === 'firms') {
      const list = gap ? [] : fires(HIST.firms, t - 3_600_000, 0.25);
      return json(
        {
          fetchedAt: t,
          stale: false,
          ttlMs: 1_800_000,
          sources: [
            { source: 'VIIRS_NOAA21_NRT', count: list.length, ok: true },
          ],
          count: list.length,
          fires: list,
        },
        h(list.length, list.length ? { 'x-history-truncated': '1' } : {}),
      );
    }
    if (q.feed === 'fire-perimeters') {
      const rows = gap
        ? []
        : [
            perimeter(
              '2026-TXQA-000001',
              'HIST Fire A',
              LAT + 0.2,
              LON - 0.3,
              t - DAY,
              true,
            ),
            perimeter(
              '2026-TXQA-000002',
              'HIST Fire B',
              LAT - 0.25,
              LON + 0.3,
              t - 2 * DAY,
              true,
            ),
          ];
      return json({ fetchedAt: t, rows }, h(rows.length));
    }
    if (q.feed === 'cyclones') {
      const storms = gap
        ? []
        : [storm('al072026', 'Histstorm', t - 3 * 3_600_000, true)];
      return json(
        {
          ...CYCLONE_ENV,
          fetchedAt: t,
          stale: false,
          unavailable: false,
          reason: null,
          storms,
          bestTrackStorms: [],
        },
        h(storms.length),
      );
    }
    if (q.feed === 'launches') {
      const results = gap
        ? []
        : [1, 2, 4].map((d, i) =>
            launch(
              `hist-${i}`,
              `QA Rocket | HIST Mission ${i + 1}`,
              t - d * DAY,
              LAT + 0.1 * i,
              LON - 0.4,
            ),
          );
      return json(
        { count: results.length, next: null, previous: null, results },
        h(results.length),
      );
    }
    if (q.feed === 'transit') {
      const vehicles = gap
        ? []
        : Array.from({ length: HIST.transit }, (_, i) => ({
            id: `hist-bus-${i}`,
            lat: LAT - 0.02 - 0.01 * i,
            lon: LON - 0.02,
            bearing: 180,
            speedMps: 4,
            timestamp: Math.floor((t - 20_000) / 1000),
            routeId: '801',
            tripId: `hist-trip-${i}`,
            directionId: 1,
            label: `H${i}`,
            stopId: null,
            status: 'IN_TRANSIT_TO',
            occupancy: null,
            timestampSource: 'recorded',
          }));
      return json(
        {
          fetchedAt: t,
          feeds: gap
            ? []
            : [
                {
                  feedId: 'capmetro-austin',
                  name: 'CapMetro',
                  fetchedAt: t,
                  feedTimestamp: Math.floor(t / 1000),
                  version: '2.0',
                  entityCount: vehicles.length,
                  truncated: false,
                  count: vehicles.length,
                  vehicles,
                },
              ],
        },
        h(vehicles.length),
      );
    }
    if (q.feed === 'bikeshare') {
      const ids = gap
        ? []
        : Array.from({ length: HIST.bikeshare }, (_, i) => `hist-${i}`);
      const env = (stations) => ({
        last_updated: Math.floor(t / 1000),
        ttl: 0,
        version: '2.3',
        data: { stations },
      });
      return json(
        {
          fetchedAt: t,
          systems: gap
            ? []
            : [
                {
                  systemId: 'austin-capmetro',
                  station_information: env(
                    ids.map((id, i) => ({
                      station_id: id,
                      name: `HIST Dock ${i}`,
                      lat: LAT - 0.004 * i,
                      lon: LON + 0.004 * i,
                      capacity: 15,
                    })),
                  ),
                  station_status: env(
                    ids.map((id) => ({
                      station_id: id,
                      num_bikes_available: 9,
                      num_docks_available: 6,
                      is_installed: true,
                      is_renting: true,
                      is_returning: true,
                      last_reported: Math.floor((t - 120_000) / 1000),
                    })),
                  ),
                },
              ],
        },
        h(ids.length),
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
  if (url.pathname === '/api/firms')
    return json(
      {
        fetchedAt: now - 60_000,
        stale: false,
        ttlMs: 1_800_000,
        sources: [{ source: 'VIIRS_NOAA21_NRT', count: LIVE.firms, ok: true }],
        count: LIVE.firms,
        fires: fires(LIVE.firms, now - 3_600_000, 0.1),
      },
      liveHeaders(),
    );
  if (url.pathname === '/api/fire-perimeters')
    return json(
      {
        fetchedAt: now - 60_000,
        rows: [
          perimeter(
            '2026-TXQA-LIVE01',
            'LIVE Fire',
            LAT,
            LON + 0.5,
            now - DAY,
            false,
          ),
        ],
      },
      liveHeaders(),
    );
  if (url.pathname === '/api/cyclones')
    return json(
      {
        ...CYCLONE_ENV,
        fetchedAt: now - 60_000,
        stale: false,
        unavailable: false,
        reason: null,
        storms: [storm('al092026', 'Livestorm', now - 2 * 3_600_000, false)],
      },
      liveHeaders(),
    );
  if (url.pathname === '/api/launches')
    return json(
      {
        count: LIVE.launches,
        next: null,
        previous: null,
        results: [1, 3].map((d, i) =>
          launch(
            `live-${i}`,
            `QA Rocket | LIVE Mission ${i + 1}`,
            now - d * DAY,
            LAT - 0.1 * i,
            LON + 0.4,
          ),
        ),
      },
      liveHeaders(),
    );
  if (url.pathname.startsWith('/api/transit/vehicles/')) {
    const feedId = decodeURIComponent(url.pathname.split('/').pop());
    return json(
      {
        feedId,
        name: feedId,
        fetchedAt: now - 5_000,
        feedTimestamp: Math.floor((now - 5_000) / 1000),
        version: '2.0',
        entityCount: 2,
        truncated: false,
        count: 2,
        vehicles: [0, 1].map((i) => ({
          id: `qa-bus-${i}`,
          lat: LAT + 0.01 * i,
          lon: LON + 0.01 * i,
          bearing: 90,
          speedMps: 5,
          timestamp: Math.floor((now - 10_000) / 1000),
          routeId: '801',
          tripId: `trip-${i}`,
          directionId: 0,
          label: `${i}`,
          stopId: null,
          status: 'IN_TRANSIT_TO',
          occupancy: null,
          timestampSource: 'vehicle',
        })),
      },
      liveHeaders(),
    );
  }
  if (url.pathname.startsWith('/api/gbfs/')) {
    const target = decodeURIComponent(url.pathname.slice('/api/gbfs/'.length));
    const stations = [0, 1, 2].map((i) => ({
      station_id: `qa-${i}`,
      name: `QA Dock ${i}`,
      lat: LAT + 0.004 * i,
      lon: LON - 0.004 * i,
      capacity: 12,
    }));
    const body = /station_status/.test(target)
      ? stations.map((s) => ({
          station_id: s.station_id,
          num_bikes_available: 4,
          num_docks_available: 8,
          is_installed: 1,
          is_renting: 1,
          is_returning: 1,
          last_reported: Math.floor(now / 1000),
        }))
      : stations;
    return json(
      {
        last_updated: Math.floor(now / 1000),
        ttl: 60,
        data: { stations: body },
      },
      liveHeaders(),
    );
  }
  return req.continue();
}

/**
 * Page screenshot with the world-overlay canvas included. Headless Chromium
 * with a software 2-D canvas does not composite a {desynchronized: true}
 * canvas into page screenshots (checked with a one-file page: the canvas
 * holds the pixels, the screenshot has none; a synchronized canvas shows).
 * So its backing store is read back (toDataURL), saved as <name>-overlay.png,
 * and laid over the canvas as an <img> at the same place in the DOM for the
 * capture, then removed. The pixels are exactly what the overlay host drew.
 */
async function shot(name) {
  await page.bringToFront();
  const overlay = await page.evaluate(async () => {
    const c = document.getElementById('world-overlay-canvas');
    if (!c?.width) return null;
    const url = c.toDataURL('image/png');
    const img = document.createElement('img');
    img.id = 'qa-overlay-readback';
    const cs = getComputedStyle(c);
    for (const k of [
      'position',
      'left',
      'top',
      'width',
      'height',
      'zIndex',
      'transform',
      'opacity',
      'mixBlendMode',
    ])
      img.style[k] = cs[k];
    img.style.pointerEvents = 'none';
    img.src = url;
    c.after(img);
    await img.decode();
    return url;
  });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  await page.evaluate(() =>
    document.getElementById('qa-overlay-readback')?.remove(),
  );
  if (overlay)
    writeFileSync(
      path.join(OUT, `${name}-overlay.png`),
      Buffer.from(overlay.split(',')[1], 'base64'),
    );
  say('screenshot', file, overlay ? '(+ overlay readback)' : '');
}

const IDS = {
  firms: 'local-firms',
  perimeters: 'fire-perimeters',
  cyclones: 'weather-cyclones',
  launches: 'rocket-launches',
  transit: 'transit',
  bikeshare: 'bikeshare',
};
const layerState = () =>
  page.evaluate((ids) => {
    const dm = window.__godsEyeView.dataManager;
    const out = {};
    for (const [key, id] of Object.entries(ids)) {
      const entry = dm.layers.get(id);
      const stats = entry?.module?.getStats?.() ?? {};
      out[key] = {
        enabled: Boolean(entry?.enabled),
        count: stats.count ?? null,
        error: stats.error ?? stats.lastError ?? null,
        lastUpdate: stats.lastUpdate ?? null,
      };
    }
    const tr = dm.layers.get(ids.transit)?.module;
    out.transitIds = [
      ...(tr?._transitStateForTest?.()._vehicles.values() ?? []),
    ].map((e) => e.record.id);
    const per = dm.layers.get(ids.perimeters)?.module;
    out.perimeterRows = per?.getAnalystRecords?.() ?? [];
    const cyc = dm.layers.get(ids.cyclones)?.module;
    out.cycloneRow = cyc?.getRowControls?.() ?? null;
    const lau = dm.layers.get(ids.launches)?.module;
    out.launchNames = (lau?.getAnalystRecords?.() ?? []).map((l) => l.name);
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
          served: swap.served,
        }
      : null;
    return out;
  }, IDS);

async function waitFor(pred, what, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  let st;
  for (;;) {
    st = await layerState();
    if (pred(st)) return st;
    if (Date.now() > end) {
      say('timeout waiting for', what, JSON.stringify(st).slice(0, 2000));
      return st;
    }
    await sleep(500);
  }
}
const SIX = [
  'firms',
  'perimeters',
  'cyclones',
  'launches',
  'transit',
  'bikeshare',
];
const six = (st) => SIX.map((k) => st[k].count);
const want = (o) => SIX.map((k) => o[k]).join();
const chipFeeds = (st, state) =>
  st.chips.filter((c) => c[1] === state).map((c) => c[0]);
async function view(lat, lon, alt) {
  await page.evaluate(
    ({ lat, lon, alt }) => {
      const v = window.__godsEyeView.viewer;
      const e = v.scene.globe.ellipsoid;
      const r = Math.PI / 180;
      const dest = e.cartographicToCartesian({
        longitude: lon * r,
        latitude: lat * r,
        height: alt,
      });
      v.camera.setView({
        destination: dest,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    },
    { lat, lon, alt },
  );
  await sleep(1_500);
}

/** The world-overlay sources of the six swapped layers. */
const OVERLAY_SOURCES = [
  'firms',
  'fire-perimeters',
  'weather-cyclones',
  'rocket-missions',
  'rocket-mission-selected',
  'transit-selected',
  'bikeshare-selected',
];
const LAYER_DATA_SOURCES = [
  'local-firms',
  'rocket-launches',
  'fire-perimeters',
  'weather-cyclones',
];

/**
 * What is DRAWN right now, beyond the counts: overlay entries and painted
 * cards per source, FIRMS glow sprites, entities of the layer data sources,
 * and the opaque pixels of the world-overlay canvas.
 */
const drawn = () =>
  page.evaluate(
    ({ sources, dataSources }) => {
      const v = window.__godsEyeView.viewer;
      const d = window.__gevWorldOverlay?.getDiagnostics?.() ?? {};
      const pick = (o) =>
        Object.fromEntries(sources.map((s) => [s, o?.[s] ?? 0]));
      let firmsSprites = 0;
      const walk = (col, depth) => {
        for (let i = 0; i < col.length; i++) {
          const p = col.get(i);
          if (!p || typeof p.length !== 'number' || !p.get) continue;
          if (/Billboard/.test(p.constructor?.name ?? '')) {
            for (let k = 0; k < p.length; k++) {
              const id = p.get(k).id;
              if (/^firms-/.test(String(id?.id ?? id))) firmsSprites++;
            }
          } else if (depth < 3) walk(p, depth + 1);
        }
      };
      walk(v.scene.primitives, 0);
      const entities = {};
      for (let i = 0; i < v.dataSources.length; i++) {
        const ds = v.dataSources.get(i);
        if (dataSources.includes(ds.name))
          entities[ds.name] = ds.show ? ds.entities.values.length : 0;
      }
      const c = document.getElementById('world-overlay-canvas');
      let ink = 0;
      if (c?.width) {
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < px.data.length; i += 4) if (px.data[i]) ink++;
      }
      return {
        entries: pick(d.entriesBySource),
        painted: pick(d.paintedBySource),
        firmsSprites,
        entities,
        ink,
      };
    },
    { sources: OVERLAY_SOURCES, dataSources: LAYER_DATA_SOURCES },
  );
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const render = () =>
  page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());

/** Poll drawn() (with a render each time) until pred holds. */
async function waitDrawn(pred, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let d;
  for (;;) {
    await render();
    await sleep(400);
    d = await drawn();
    if (pred(d)) return d;
    if (Date.now() > end) {
      say('timeout waiting for', what, JSON.stringify(d));
      return d;
    }
  }
}

// ── 1. live ──────────────────────────────────────────────
await page.goto(
  `${BASE}/?welcome=0#v=2&lat=${LAT}&lon=${LON}&alt=30000&heading=360&pitch=-90&roll=0&map=esri-imagery`,
  { waitUntil: 'domcontentloaded', timeout: 120000 },
);
await page.waitForFunction(
  () => window.__godsEyeView?.dataManager && window.__gevHistorySwap,
  { timeout: 180000 },
);
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');
await page.evaluate(async (ids) => {
  const dm = window.__godsEyeView.dataManager;
  for (const id of Object.values(ids)) await dm.setEnabled(id, true);
}, IDS);
let st = await waitFor(
  (s) => six(s).join() === want(LIVE),
  'live counts',
  90_000,
);
check(
  six(st).join() === want(LIVE),
  `live rows drawn ${JSON.stringify(six(st))}`,
);
check(
  st.mode === 'live' && chipFeeds(st, 'unswapped').length === 0,
  'no LIVE chips while live',
);
await shot('01-live');

// ── 2. history at t = now - 35 d ─────────────────────────
// a regional camera first: a whole-globe view correctly asks the world box
await view(LAT, LON, ALT);
const T = Date.now() - 35 * DAY;
await page.evaluate((t) => {
  const h = window.__gevHistorySwap.handle;
  h.expand(true);
  h.seek(t);
}, T);
st = await waitFor(
  (s) => s.mode === 'history' && six(s).join() === want(HIST),
  'history counts',
  60_000,
);
check(
  six(st).join() === want(HIST),
  `history rows at t drawn, live rows gone ${JSON.stringify(six(st))}`,
);
const tShown = Date.parse(st.time);
check(Math.abs(tShown - T) < 5 * 60_000, `history time ${st.time}`);
check(
  [
    'firms',
    'fire-perimeters',
    'cyclones',
    'launches',
    'transit',
    'bikeshare',
  ].every((f) => st.router?.swapped?.includes(f)),
  `swapped ${JSON.stringify(st.router?.swapped)}`,
);
const firmsAsk = sliceCalls.filter((c) => c.feed === 'firms').at(-1);
check(
  Boolean(firmsAsk?.bbox) &&
    firmsAsk.bbox !== '-180,-90,180,90' &&
    /^-?\d+,-?\d+,-?\d+,-?\d+$/.test(firmsAsk.bbox),
  `FIRMS slice carries the camera bbox (whole degrees) ${firmsAsk?.bbox}`,
);
const un = chipFeeds(st, 'unswapped');
check(
  !un.some((f) =>
    /firms|perimeters|cyclones|launches|transit|bikeshare/.test(f),
  ),
  `no LIVE chip on the six swapped layers ${JSON.stringify(un)}`,
);
check(
  st.transitIds.length === HIST.transit &&
    st.transitIds.every((id) => /^hist-bus-/.test(id)),
  `transit: the recorded buses at t, no live bus ${JSON.stringify(st.transitIds)}`,
);
check(
  !st.transit.error,
  `transit: the rebased frame is current, not stale (D2) ${st.transit.error}`,
);
const trunc = st.chips.find((c) => c[0] === 'history:firms');
check(
  Boolean(trunc) && /HISTORY truncated/.test(trunc[2]),
  `FIRMS truncated chip ${JSON.stringify(trunc)}`,
);
check(
  st.perimeterRows.length === HIST.perimeters &&
    st.perimeterRows.every(
      (r) =>
        /^HIST Fire/.test(r.name) &&
        r.personnel === null &&
        r.costToDate === null &&
        r.cause === null &&
        /^Not recorded \(unknown\): /.test(r.historyUnknown ?? ''),
    ),
  `perimeter rows are the recording with unknown fields named ${JSON.stringify(st.perimeterRows.map((r) => [r.name, r.historyUnknown]))}`,
);
const cycText = JSON.stringify(st.cycloneRow);
check(
  /Histstorm/.test(cycText) &&
    !/Livestorm/.test(cycText) &&
    /Track\/cone unavailable/.test(cycText),
  'cyclone row: the recorded storm, positions only (Track/cone unavailable)',
);
check(
  st.launchNames.length === HIST.launches &&
    st.launchNames.every((n) => /HIST Mission/.test(n)),
  `launches at t (NET 1-4 d before t, 36-39 d before now) ${JSON.stringify(st.launchNames)}`,
);
check(
  st.firms.lastUpdate === tShown,
  `FIRMS data time = t (event feed, not rebased) ${st.firms.lastUpdate} vs ${tShown}`,
);
// one screenshot per layer at t, each after its content is DRAWN
// FIRMS: the recorded detections (glow sprites + cards "… 35d · N21")
await view(LAT, LON, 120_000);
let dr = await waitDrawn(
  (d) => d.firmsSprites >= 5 && d.painted.firms >= 3 && d.ink > 0,
  'FIRMS drawn at t',
);
check(
  dr.firmsSprites >= 5 && dr.painted.firms >= 3 && dr.ink > 0,
  `FIRMS at t drawn: ${dr.firmsSprites} sprites, ${dr.painted.firms} cards painted, overlay ink ${dr.ink}`,
);
await shot('02-firms-at-t');
// perimeters: HIST Fire A selected (a click on its polygon), its card names
// the unrecorded fields as unknown
await view(LAT + 0.2, LON - 0.3, 40_000);
await page.mouse.click(720, 450);
dr = await waitDrawn(
  (d) => d.painted['fire-perimeters'] >= 1 && d.entities['fire-perimeters'] > 0,
  'perimeter card at t',
);
check(
  dr.painted['fire-perimeters'] >= 1 && dr.entities['fire-perimeters'] > 0,
  `perimeters at t drawn: ${dr.entities['fire-perimeters']} polygon entities, selected card painted ${dr.painted['fire-perimeters']}`,
);
await shot('03-perimeters-at-t');
await page.mouse.click(1300, 120); // empty space: deselect
await view(LAT - 0.7, LON + 1.1, 700_000);
await shot('04-cyclones-at-t');
await view(LAT, LON - 0.3, 300_000);
await shot('05-launches-at-t');
await view(LAT - 0.035, LON - 0.02, 9_000);
await shot('06-transit-at-t');
await view(LAT - 0.008, LON + 0.008, 6_000);
await shot('07-bikeshare-at-t');
st = await layerState();
check(
  st.transit.count === HIST.transit && st.bikeshare.count === HIST.bikeshare,
  `transit + bike share recorded at t on screen ${st.transit.count}/${st.bikeshare.count}`,
);
await view(LAT, LON, ALT);

// ── 3. camera move: FIRMS asks the new box ───────────────
const firmsBefore = sliceCalls.filter((c) => c.feed === 'firms').length;
await view(LAT + 3, LON - 4, 250_000);
await sleep(2_000);
const firmsAfter = sliceCalls.filter((c) => c.feed === 'firms');
check(
  firmsAfter.length > firmsBefore && firmsAfter.at(-1).bbox !== firmsAsk?.bbox,
  `camera move refreshes FIRMS with the new box ${firmsAfter.at(-1)?.bbox}`,
);
await view(LAT, LON, ALT);

// ── 4. recorded gap: nothing for the swapped layers ──────
const gapT = Math.round((world.gap.from + world.gap.to) / 2);
await page.evaluate((t) => window.__gevHistorySwap.handle.seek(t), gapT);
st = await waitFor(
  (s) => six(s).join() === '0,0,0,0,0,0',
  'gap -> nothing',
  45_000,
);
check(
  six(st).join() === '0,0,0,0,0,0',
  `gap: all six swapped layers draw nothing ${JSON.stringify(six(st))}`,
);
check(
  /No NHC advisory recorded/.test(JSON.stringify(st.cycloneRow)),
  'gap: cyclones say no advisory was recorded (not "no active storms")',
);
// review R1: what is DRAWN in the gap (the counts alone passed while sprites
// and cards of t were still drawn). Let the next frames render (SwiftShader
// draws a few frames a second), then it must STAY empty for ~4 s.
const empty = (d) =>
  sum(d.entries) === 0 &&
  sum(d.painted) === 0 &&
  d.firmsSprites === 0 &&
  sum(d.entities) === 0;
await waitDrawn((d) => empty(d) && d.ink === 0, 'gap drawn empty', 10_000);
const gapDrawn = [];
for (let i = 0; i < 10; i++) {
  await render();
  await sleep(400);
  gapDrawn.push(await drawn());
}
say(
  'gap drawn samples',
  gapDrawn.at(-1),
  gapDrawn.map((d) => d.ink),
);
check(
  gapDrawn.every(empty),
  'gap: no overlay entry or painted card of the six layers, no FIRMS sprite, no layer entity',
);
check(
  gapDrawn.every((d) => d.ink === 0),
  `gap: the world-overlay canvas holds no pixel in every sample ${JSON.stringify(gapDrawn.map((d) => d.ink))}`,
);
await shot('08-gap-nothing');

// ── 5. LIVE restores the live data ───────────────────────
await page.click('.gev-hist-live');
st = await waitFor(
  (s) => s.mode === 'live' && six(s).join() === want(LIVE),
  'LIVE restore',
  60_000,
);
check(
  six(st).join() === want(LIVE),
  `LIVE restores live rows ${JSON.stringify(six(st))}`,
);
check(chipFeeds(st, 'unswapped').length === 0, 'LIVE chips gone on LIVE');
check(
  !st.chips.some((c) => c[0] === 'history:firms'),
  'truncated chip gone on LIVE',
);
await shot('09-live-restored');

check(
  errors.length === 0,
  `no console/page errors ${JSON.stringify(errors.slice(0, 10))}`,
);
writeFileSync(path.join(OUT, 'qa-log.txt'), `${log.join('\n')}\n`);
writeFileSync(
  path.join(OUT, 'results.json'),
  JSON.stringify({ failures, errors, sliceCalls: sliceCalls.length }, null, 2),
);
await browser.close();
say(failures.length ? `FAIL ${failures.length}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
