import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  EMPTY_REASONS,
  FIELD_ADAPTERS,
  HISTORY_EMPTY_PREFIX,
  HISTORY_EMPTY_STATE,
  HISTORY_NOTE_STATE,
  QUAKES_ADAPTER,
  QUAKES_REVISED_LATER,
  USGS_HOST,
  WIND_ADAPTER,
  WIND_EMPTY_ROW,
  WIND_GRID_CHANGED,
  windGridIdOf,
} from './historyFieldAdapters.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';
import { adapterForPath, adapterForUrl } from './historyAdapters.js';
import { createHistoryRouter } from './historyRouter.js';
import { createRefreshDriver, RELEASE_DEBOUNCE_MS } from './historyRefresh.js';
import { createLayerChips, LIVE_CHIP } from './layerChips.js';
import { createFeedChips } from './feedChips.js';
import { fakeClock, fakeWindow, flush, jsonResponse } from './fakeDom.mjs';
import { createSliceServer } from './b12dSliceServer.mjs';
import { createUsgsEarthquakeSource } from '../../layers/earthquakes/source.js';
import { normalizeEarthquakeSnapshot } from '../../layers/earthquakes/records.js';
import { createWindSource } from '../../layers/wind/source.js';
import { createSatelliteSource } from '../../layers/satellites/source.js';
import { CATALOG_GROUPS } from '../../layers/satellites/policy.js';
import { windStep } from '../../../server/byrdit/historyWind.js';
import { QUAKE_ARCHIVE_PREFIX, gpCsv } from '../history/historySlicesB12c.js';
import { parseGP } from '../gpCsv.js';

const { json2satrec, propagate, gstime, eciToGeodetic } = createRequire(
  import.meta.url,
)('satellite.js');

const FIX = new URL('../history/fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const ORIGIN = 'https://gev.example';
const USGS_URL = `https://${USGS_HOST}/earthquakes/feed/v1.0/summary/all_day.geojson`;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

const LIVE_QUAKES = fixture('b12c-usgs-all-day.json');
/** The live capture moment of the all_day fixture (17:40Z, 2026-10-14). */
const T_QUAKES = LIVE_QUAKES.metadata.generated;
const NOW = Date.parse('2026-10-17T18:00:00Z');

/**
 * The recorded quake docs as the API reads them (stream name / archive),
 * plus the first B13 archive record (2025-07-12, real archive start) so the
 * recording start is the real one, not the fixture's oldest event.
 */
function quakeIndices() {
  const out = {
    [`${QUAKE_ARCHIVE_PREFIX}2025.07`]: [
      {
        '@timestamp': '2025-07-12T00:10:00.000Z',
        event_id: 'us7000first',
        updated: '2025-09-01T00:00:00.000Z',
        location: { lat: 0, lon: 0 },
        mag: 4,
        mag_type: 'mb',
        depth_km: 10,
        place: 'first archive record',
      },
    ],
  };
  for (const d of fixture('b12c-quakes-es-docs.json').docs) {
    const index = d._index.startsWith(QUAKE_ARCHIVE_PREFIX)
      ? d._index
      : 'gev-history-quakes';
    (out[index] ??= []).push(d._source);
  }
  return out;
}

const CYCLES = fixture('b12c-cycles-es-docs.json').docs;

/** The B12c test's wind reader double (answers like the real reader). */
function fakeWindReader({ status = 'ok', fromMs = 0, idSuffix = '' } = {}) {
  const reads = [];
  return {
    reads,
    idSuffix,
    retention: () => ({ fromMs }),
    async read({ model, overlay, runMs, validMs }) {
      reads.push({ model, overlay, runMs, validMs });
      if (status !== 'ok') return { status };
      const forecastHour = windStep(model, runMs, validMs);
      const d = new Date(runMs);
      const cycle = {
        date: d.toISOString().slice(0, 10).replaceAll('-', ''),
        hour: d.getUTCHours(),
      };
      const nx = 360;
      const ny = 181;
      const values = new Float32Array(nx * ny * 2).fill(1.5 + forecastHour);
      return {
        status: 'ok',
        bytes: Buffer.from(values.buffer),
        manifest: {
          schemaVersion: 1,
          model,
          cycle: {
            ...cycle,
            forecastHour,
            runIso: iso(runMs),
            validIso: iso(runMs + forecastHour * HOUR),
          },
          fetchedAt: NOW,
          level: '10 m above ground',
          units: 'm/s',
          grid: { nx, ny, lo1: 0, la1: 90, dx: 1, dy: 1 },
          stale: false,
          unavailable: false,
          reason: null,
          gridUrl: `/api/wind/grid/${model}-${cycle.date}-${cycle.hour}-f${forecastHour}-1${this.idSuffix}.bin?model=${model}`,
        },
      };
    },
  };
}

/** The live wind provider double (the current cycle; never asked in history). */
async function liveWind(url) {
  const reader = fakeWindReader();
  const value = await reader.read({
    model: 'gfs',
    overlay: 'none',
    runMs: Date.UTC(2026, 9, 17, 12),
    validMs: NOW,
  });
  if (url.pathname === '/api/wind/manifest')
    return jsonResponse(value.manifest);
  return new Response(value.bytes, {
    headers: { 'content-type': 'application/octet-stream' },
  });
}

/**
 * The whole chain: a window whose fetch serves the REAL history API for
 * /api/history/slice and live doubles for the rest, the router installed
 * on it, the chips and the driver.
 */
function setup({ data = {}, windReader = fakeWindReader(), enabled } = {}) {
  const clock = fakeClock(NOW);
  const srv = createSliceServer(data, { now: clock.now, windReader });
  const live = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    if (url.pathname === '/api/history/slice')
      return srv.handle(url.pathname + url.search);
    live.push(url.href);
    if (url.href === USGS_URL) return jsonResponse(LIVE_QUAKES);
    if (url.pathname.startsWith('/api/wind/')) return liveWind(url);
    if (url.pathname.startsWith('/api/celestrak/'))
      return new Response('OBJECT_NAME\r\n', {
        headers: { 'content-type': 'text/plain' },
      });
    return jsonResponse({});
  };
  const win = fakeWindow(`${ORIGIN}/`, fetch);
  const router = createHistoryRouter({
    target: win,
    now: clock.now,
    timers: clock.timers,
    monotonic: clock.monotonic,
  });
  const feedChips = createFeedChips({ target: win });
  feedChips.install();
  router.install();
  const layers = enabled ?? ['earthquakes', 'wind', 'satellites'];
  const refreshed = [];
  const dm = {
    layers: new Map(),
    getEnabledLayerIds: () => new Set(layers),
    getAll: () => layers.map((id) => ({ id, name: id })),
    subscribe: () => () => {},
    refreshLayer: async (id) => {
      refreshed.push(id);
      await dm.onRefresh?.(id);
    },
  };
  const chips = createLayerChips({
    feedChips,
    getRouter: () => router,
    getDataManager: () => dm,
  });
  const driver = createRefreshDriver({
    router,
    getDataManager: () => dm,
    timers: clock.timers,
    monotonic: clock.monotonic,
    now: clock.now,
  });
  const quakes = createUsgsEarthquakeSource({
    fetchImpl: (...a) => win.fetch(...a),
  });
  const wind = createWindSource({ fetchImpl: (...a) => win.fetch(...a) });
  return {
    clock,
    srv,
    live,
    win,
    router,
    chips,
    driver,
    dm,
    refreshed,
    quakes,
    wind,
  };
}

const enter = (env, t, extra = {}) =>
  env.driver.onHistory({ active: true, timeMs: t, playing: false, ...extra });
const chipOf = (env, id) => env.chips.states().filter((c) => c.layerId === id);

// ── registry ──────────────────────────────────────────────

test('B12d registry: quakes and wind are swapped; satellites, weather and recent imagery have no adapter (LIVE)', () => {
  assert.deepEqual(
    FIELD_ADAPTERS.map((a) => [a.id, a.layerId, a.sliceFeed]),
    [
      ['quakes', 'earthquakes', 'quakes'],
      ['wind', 'wind', 'wind'],
    ],
  );
  for (const a of FIELD_ADAPTERS) assert.ok(ALL_HISTORY_ADAPTERS.includes(a));
  const ids = ALL_HISTORY_ADAPTERS.map((a) => a.layerId);
  assert.equal(new Set(ALL_HISTORY_ADAPTERS.map((a) => a.id)).size, ids.length);
  for (const layer of [
    'satellites',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'recent-imagery',
  ])
    assert.ok(!ids.includes(layer), layer);
  const url = (u) => new URL(u, ORIGIN);
  for (const live of [
    ...CATALOG_GROUPS.map((g) => `/api/celestrak/${g.path}`),
    '/api/celestrak/starlink',
    '/api/celestrak/active',
    '/api/weather/manifest?product=radar',
    'https://cmr.earthdata.nasa.gov/search/granules.umm_json?collection_concept_id=x',
  ])
    assert.equal(adapterForUrl(url(live), ALL_HISTORY_ADAPTERS), null, live);
  // the USGS adapter matches only the USGS host
  assert.equal(
    adapterForUrl(url(USGS_URL), ALL_HISTORY_ADAPTERS),
    QUAKES_ADAPTER,
  );
  assert.equal(
    adapterForUrl(
      url('/earthquakes/feed/v1.0/summary/all_day.geojson'),
      ALL_HISTORY_ADAPTERS,
    ),
    null,
  );
  assert.equal(
    adapterForPath(
      '/earthquakes/feed/v1.0/summary/all_day.geojson',
      ALL_HISTORY_ADAPTERS,
    ),
    null,
  );
  for (const p of [
    '/api/wind/manifest',
    '/api/wind/grid/gfs-20261014-12-f5-1.bin',
  ])
    assert.equal(adapterForUrl(url(p), ALL_HISTORY_ADAPTERS), WIND_ADAPTER, p);
  assert.equal(
    windGridIdOf('/api/wind/grid/gfs-20261014-12-f5-1.bin'),
    'gfs-20261014-12-f5-1',
  );
});

// ── quakes ────────────────────────────────────────────────

test('quakes: the live USGS request is answered from the slice at t; the live parser gets the live shape (17:40Z == all_day)', async () => {
  const env = setup({ data: quakeIndices(), enabled: ['earthquakes'] });
  enter(env, T_QUAKES);
  const rows = await env.quakes.getSnapshot();
  assert.deepEqual(env.live, [], 'no live USGS request in history');
  assert.equal(env.srv.asked.at(-1).feed, 'quakes');
  assert.equal(env.srv.asked.at(-1).t, iso(T_QUAKES));
  // the live parser's input shape: identical rows to the live capture
  const liveRows = normalizeEarthquakeSnapshot(LIVE_QUAKES);
  const order = (list) =>
    [...list].sort((a, b) => (a.usgsId < b.usgsId ? -1 : 1));
  assert.ok(liveRows.length >= 30);
  assert.deepEqual(order(rows), order(liveRows));
  // the body keys are the live envelope's (type / metadata / features)
  const res = await env.win.fetch(USGS_URL);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['features', 'metadata', 'type']);
  assert.equal(body.metadata.generated, T_QUAKES); // not rebased (D2)
  for (const f of body.features)
    assert.deepEqual(Object.keys(f).sort(), [
      'geometry',
      'id',
      'properties',
      'type',
    ]);
  assert.equal(res.headers.get('x-history-t'), iso(T_QUAKES));
  // swapped: no LIVE chip on earthquakes, and no note at the live capture
  assert.deepEqual(chipOf(env, 'earthquakes'), []);
  assert.ok(env.router.isSwapped('quakes'));
});

test('quakes before the recording start: NOTHING (empty FeatureCollection) + a chip with the reason, never live', async () => {
  const env = setup({ data: quakeIndices(), enabled: ['earthquakes'] });
  // the live collector and the archive start long after this t
  // (inside the API's 731-day retention window, before the B13 archive)
  const t = Date.parse('2025-03-01T00:00:00Z');
  enter(env, t);
  const rows = await env.quakes.getSnapshot();
  assert.deepEqual(rows, []);
  assert.deepEqual(env.live, []);
  const chips = chipOf(env, 'earthquakes');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].state, HISTORY_EMPTY_STATE);
  assert.ok(chips[0].chip.startsWith(HISTORY_EMPTY_PREFIX), chips[0].chip);
  assert.ok(chips[0].chip.includes(EMPTY_REASONS.before_recording_start));
  assert.match(chips[0].chip, /recording starts 2025-\d\d-\d\d \d\d:\d\d UTC/);
  assert.equal(chips[0].draw, false);
  assert.ok(!chips.some((c) => c.chip === LIVE_CHIP));
  // a later t with data takes the chip away again
  enter(env, T_QUAKES);
  await env.quakes.getSnapshot();
  assert.deepEqual(chipOf(env, 'earthquakes'), []);
});

test('quakes: archive-only events revised after t are named on the chip (decision 2B), drawn with their real origin time', async () => {
  const origin = Date.parse('2026-03-01T06:00:00Z');
  const t = Date.parse('2026-03-01T12:00:00Z');
  const data = {
    'gev-history-quakes-hist-2026.03': [
      {
        '@timestamp': iso(origin),
        event_id: 'us7000arch',
        updated: iso(origin + 30 * 86_400_000),
        location: { lat: 10, lon: 20 },
        mag: 4.4,
        mag_type: 'mb',
        depth_km: 12,
        place: 'archive place',
      },
    ],
    'gev-history-quakes': [
      {
        '@timestamp': '2026-10-12T17:16:00.000Z',
        event_id: 'us7000live',
        updated: '2026-10-12T17:20:00.000Z',
        location: { lat: 1, lon: 2 },
        mag: 3,
        mag_type: 'mb',
        depth_km: 5,
        place: 'live place',
      },
    ],
  };
  const env = setup({ data, enabled: ['earthquakes'] });
  enter(env, t);
  const rows = await env.quakes.getSnapshot();
  assert.deepEqual(
    rows.map((r) => [r.usgsId, r.mag, r.time]),
    [['us7000arch', 4.4, origin]],
  );
  const [chip] = chipOf(env, 'earthquakes');
  assert.equal(chip.state, HISTORY_NOTE_STATE);
  assert.ok(chip.chip.startsWith(`1${QUAKES_REVISED_LATER}`), chip.chip);
  // the recording starts inside [t - 24 h, t]: said too, never silent
  assert.match(chip.chip, /Quakes recorded from 2026-03-01 06:00 UTC only/);
  assert.equal(chip.draw, true);
});

// ── wind ──────────────────────────────────────────────────

const T_WIND = Date.UTC(2026, 9, 13, 9, 30); // 06Z cycle, f004 (valid 10Z)

test('wind: manifest + grid are the cycle at t (real B12c slice), in the exact live shape the wind source parses', async () => {
  const reader = fakeWindReader();
  const env = setup({
    data: { 'gev-history-cycles': CYCLES },
    windReader: reader,
  });
  enter(env, T_WIND);
  const snap = await env.wind.getSnapshot({ model: 'gfs', overlay: 'none' });
  assert.deepEqual(env.live, [], 'no live wind request in history');
  assert.equal(snap.cycle.runIso, '2026-10-13T06:00:00.000Z');
  assert.equal(snap.cycle.validIso, '2026-10-13T10:00:00.000Z');
  assert.equal(snap.u.length, 360 * 181);
  assert.equal(snap.u[0], 1.5 + 4);
  // the same keys as the live manifest the layer reads
  const liveSnap = await createWindSource({
    fetchImpl: (u, i) => liveWind(new URL(u, ORIGIN), i),
  }).getSnapshot({ model: 'gfs', overlay: 'none' });
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(liveSnap).sort());
  // both halves asked the slice at t; the grid was asked for that manifest
  const asked = env.srv.asked.filter((q) => q.feed === 'wind');
  assert.deepEqual(
    asked.map((q) => [q.part, q.t]),
    [
      ['manifest', iso(T_WIND)],
      ['grid', iso(T_WIND)],
    ],
  );
  assert.deepEqual(chipOf(env, 'wind'), []);
});

test('wind with nothing recorded (IFS never recorded, before the first cycle, past retention): the live unavailable manifest + a chip', async () => {
  for (const [label, opts, model, reason] of [
    ['ifs', {}, 'ifs', 'model_not_recorded'],
    ['early', { t: Date.UTC(2026, 9, 1) }, 'gfs', 'before_recording_start'],
    [
      'retention',
      { reader: fakeWindReader({ fromMs: Date.UTC(2026, 9, 14) }) },
      'gfs',
      'outside_upstream_retention',
    ],
  ]) {
    const env = setup({
      data: { 'gev-history-cycles': CYCLES },
      windReader: opts.reader ?? fakeWindReader(),
    });
    enter(env, opts.t ?? T_WIND);
    const snap = await env.wind.getSnapshot({ model, overlay: 'none' });
    assert.equal(snap.unavailable, true, label);
    assert.equal(snap.reason, WIND_EMPTY_ROW, label);
    assert.equal(snap.model, model, label);
    assert.equal(snap.u, undefined, label);
    assert.deepEqual(env.live, [], label);
    const chips = chipOf(env, 'wind');
    assert.equal(chips.length, 1, label);
    assert.equal(chips[0].state, HISTORY_EMPTY_STATE, label);
    assert.equal(chips[0].reason, reason, label);
    assert.ok(chips[0].chip.includes(EMPTY_REASONS[reason]), label);
  }
});

test('wind: the grid is bound to the manifest time even if t moved in between; a grid of another read is refused, never combined', async () => {
  const reader = fakeWindReader();
  const env = setup({
    data: { 'gev-history-cycles': CYCLES },
    windReader: reader,
  });
  enter(env, T_WIND);
  const m = await (await env.win.fetch('/api/wind/manifest?model=gfs')).json();
  // a seek before the layer asks the grid of that manifest
  enter(env, T_WIND + 30 * HOUR);
  const g = await env.win.fetch(m.gridUrl);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('x-history-t'), iso(T_WIND));
  assert.equal((await g.arrayBuffer()).byteLength, 360 * 181 * 8);
  // the server now reads another field for the same t (degraded <-> full)
  enter(env, T_WIND);
  await env.clock.run(RELEASE_DEBOUNCE_MS + 1);
  await env.driver.settle();
  env.refreshed.length = 0;
  reader.idSuffix = '-wind-only';
  env.router.clearCache();
  const refused = await env.win.fetch(m.gridUrl);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, WIND_GRID_CHANGED);
  // the driver asks the layer once more (and only once for that frame)
  await env.clock.run(1);
  await env.driver.settle();
  assert.deepEqual(env.refreshed, ['wind']);
  const again = await env.win.fetch(m.gridUrl);
  assert.equal(again.status, 409);
  await env.clock.run(1);
  await env.driver.settle();
  assert.deepEqual(env.refreshed, ['wind']);
});

test('wind playback: the manifest and grid of the next frames are prefetched together; alternating halves never drop the cache', async () => {
  const env = setup({ data: { 'gev-history-cycles': CYCLES } });
  enter(env, T_WIND, { playing: true, rate: 60 });
  await env.wind.getSnapshot({ model: 'gfs', overlay: 'none' });
  const n = env.srv.asked.length;
  const urls = env.router.prefetch('wind', [T_WIND + HOUR]);
  assert.equal(urls.length, 2);
  assert.deepEqual(
    urls.map((u) => new URL(u, ORIGIN).searchParams.get('part')),
    ['manifest', 'grid'],
  );
  await env.clock.run(10);
  await flush();
  assert.equal(env.srv.asked.length, n + 2);
  assert.ok(urls.every((u) => env.router.hasCached(u)));
  // the next manifest and grid requests do not clear the prefetched frame
  await env.win.fetch('/api/wind/manifest?model=gfs');
  assert.ok(urls.every((u) => env.router.hasCached(u)));
});

test('LIVE exit: quakes and wind go straight back to live and are refreshed once (D4)', async () => {
  const env = setup({
    data: { ...quakeIndices(), 'gev-history-cycles': CYCLES },
  });
  enter(env, T_QUAKES);
  await env.clock.run(RELEASE_DEBOUNCE_MS + 1);
  await env.driver.settle();
  await env.quakes.getSnapshot();
  await env.wind.getSnapshot({ model: 'gfs', overlay: 'none' });
  env.refreshed.length = 0;
  env.driver.onHistory({ active: false });
  await env.driver.settle();
  assert.deepEqual([...env.refreshed].sort(), ['earthquakes', 'wind']);
  env.live.length = 0;
  await env.quakes.getSnapshot();
  await env.wind.getSnapshot({ model: 'gfs', overlay: 'none' });
  assert.ok(env.live.includes(USGS_URL));
  assert.ok(env.live.some((u) => u.includes('/api/wind/manifest')));
  assert.deepEqual(chipOf(env, 'earthquakes'), []);
});

// ── satellites ────────────────────────────────────────────

test('satellites time of propagation: the layer propagates to the WALL clock, so it is not swapped and keeps a LIVE chip in history', async () => {
  // (1) an element set recorded for t (B12c gp CSV) propagated the way the
  // satellites layer does (src/layers/satellites/rendering.js
  // _propagateAll: propagatePosition(satrec, new Date())) lands at the
  // position of NOW, not of t: drawing it would show the wrong time.
  const { docs } = fixture('b12c-gp-es-docs.json');
  const iss = docs
    .map((d) => d._source ?? d)
    .find((d) => d.norad_cat_id === 25544);
  assert.ok(iss, 'ISS elset in the fixture');
  const [entry] = parseGP(gpCsv([iss]));
  const satrec = json2satrec(entry.gp);
  const t = Date.parse(iss.epoch);
  const at = (ms) => {
    const pv = propagate(satrec, new Date(ms));
    const geo = eciToGeodetic(pv.position, gstime(new Date(ms)));
    return [geo.latitude, geo.longitude];
  };
  const Cesium = await import('cesium');
  const { createOrbits } = await import('../../layers/satellites/orbits.js');
  const { createRendering } =
    await import('../../layers/satellites/rendering.js');
  const point = { position: null };
  const state = {
    _catalog: new Map([[25544, { name: 'ISS', satrec, group: 'stations' }]]),
    _points: new Map([[25544, point]]),
  };
  const parts = {};
  parts.orbits = createOrbits({ state, services: {}, parts, source: {} });
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts,
    source: {},
  });
  // the production fleet tick, with the wall clock 2 h after t
  mock.timers.enable({ apis: ['Date'], now: t + 2 * HOUR });
  try {
    assert.equal(rendering._propagateAll(), 1);
  } finally {
    mock.timers.reset();
  }
  const drawn = Cesium.Cartographic.fromCartesian(point.position);
  const [latT, lonT] = at(t);
  const [latNow, lonNow] = at(t + 2 * HOUR);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(
    near(drawn.latitude, latNow) && near(drawn.longitude, lonNow),
    'the layer draws the position at the wall clock',
  );
  const apart =
    Math.abs(drawn.latitude - latT) + Math.abs(drawn.longitude - lonT);
  assert.ok(apart > 0.1, 'the drawn ISS is not where it was at t');
  // (2) so the router never answers the satellites layer from history:
  // every group it asks passes through, and its layer shows LIVE (D5)
  const env = setup({ enabled: ['satellites'] });
  enter(env, t);
  const source = createSatelliteSource({
    fetchImpl: (...a) => env.win.fetch(...a),
  });
  for (const g of [...CATALOG_GROUPS.map((x) => x.path), 'starlink']) {
    const r = await source.readGroup(g);
    assert.equal(r.ok, true, g);
  }
  assert.equal(env.srv.asked.length, 0, 'no gp slice asked');
  assert.equal(env.live.filter((u) => u.includes('/api/celestrak/')).length, 7);
  const [chip] = chipOf(env, 'satellites');
  assert.equal(chip.chip, LIVE_CHIP);
});
