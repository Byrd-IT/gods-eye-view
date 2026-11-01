import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWaterSlices,
  gaugeFeature,
} from './history/historySlicesWater.js';
import { SLICE_FEEDS, parseSliceParams } from './history/historyParams.js';
import {
  WATER_ADAPTER,
  WATER_TILE_RE,
  waterTileBox,
} from './historyUi/historyWaterAdapter.js';
import { ALL_HISTORY_ADAPTERS } from './historyUi/historyEventAdapters.js';
import { adapterForUrl, sliceUrl } from './historyUi/historyAdapters.js';
import { ROUTER_ROWS } from './historyUi/clockRows.js';
import { parseJsonl, selectStreamTiles } from './usgsWater.js';

/** t_7a4c6a57: USGS river-gauge history (slice, adapter, row, layer seam). */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 1, 18, 0, 0);
const T = NOW - 3 * DAY;
const iso = (ms) => new Date(ms).toISOString();

const obs = (key, t, lat, lon, data) => ({ t, key, lat, lon, data });

function fakeReader(rows = [], { fail = null, truncated = false } = {}) {
  const calls = [];
  return {
    calls,
    earliestMs: (nowMs) => nowMs - 120 * DAY,
    async read(q) {
      calls.push(q);
      if (fail) throw fail;
      return { observations: rows, truncated };
    },
  };
}

test('gaugeFeature: schema-2 exporter shape, both readings, honest time', () => {
  const f = gaugeFeature(
    obs('01646305', T - 10 * MIN, 38.9, -77.1, {
      name: 'POTOMAC',
      dischargeCfs: 13.5,
      gageHeightFt: 2.25,
    }),
  );
  assert.deepEqual(f.geometry.coordinates, [-77.1, 38.9]);
  assert.equal(f.properties.usgs_site_id, 'USGS-01646305');
  assert.equal(f.properties.observed_time, iso(T - 10 * MIN));
  assert.deepEqual(
    f.properties.readings.map((r) => [r.parameter_code, r.value, r.unit]),
    [
      ['00065', 2.25, 'ft'],
      ['00060', 13.5, 'ft^3/s'],
    ],
  );
  assert.equal(f.properties.value, 2.25); // top-level = first reading
});

test('gaugeFeature: no usable reading or position is skipped', () => {
  assert.equal(gaugeFeature(obs('a', T, 1, 1, { name: 'x' })), null);
  assert.equal(gaugeFeature(obs('a', T, NaN, 1, { gageHeightFt: 1 })), null);
  assert.equal(gaugeFeature(obs('', T, 1, 1, { gageHeightFt: 1 })), null);
});

test('slice: needs a box; refuses an old time with the start; passes the box', async () => {
  const reader = fakeReader([
    obs('B', T, 30.5, -97.5, { name: 'B', gageHeightFt: 1 }),
    obs('A', T, 30.2, -97.2, { name: 'A', dischargeCfs: 5 }),
  ]);
  const { sliceWater } = createWaterSlices({ reader, now: () => NOW });
  const box = { w: -100, s: 30, e: -96, n: 34 };
  const none = await sliceWater({
    t: T,
    bbox: null,
    maxRows: 10,
    windowMs: 6 * HOUR,
  });
  assert.equal(none.status, 404);
  assert.equal(none.headers['X-History-Empty-Reason'], 'area_required');
  assert.equal(reader.calls.length, 0);

  const old = await sliceWater({
    t: NOW - 121 * DAY,
    bbox: box,
    maxRows: 10,
    windowMs: 6 * HOUR,
  });
  assert.equal(old.status, 404);
  assert.equal(old.headers['X-History-Empty-Reason'], 'before_recording_start');
  assert.equal(old.headers['X-History-Recording-Start'], iso(NOW - 120 * DAY));
  assert.equal(reader.calls.length, 0);

  const ok = await sliceWater({
    t: T,
    bbox: box,
    maxRows: 10,
    windowMs: 6 * HOUR,
  });
  assert.deepEqual(reader.calls[0].bbox, {
    west: -100,
    south: 30,
    east: -96,
    north: 34,
  });
  assert.equal(reader.calls[0].t, T);
  assert.equal(reader.calls[0].windowMs, 6 * HOUR);
  assert.deepEqual(
    ok.body.features.map((f) => f.properties.usgs_site_id),
    ['USGS-A', 'USGS-B'],
  );
  assert.equal(ok.headers['X-History-Rows'], '2');
  assert.equal(ok.headers['X-History-Gap'], undefined);
});

test('slice: maxRows truncates and says so; an empty tile is a gap', async () => {
  const rows = [1, 2, 3].map((i) =>
    obs(`S${i}`, T, 30 + i / 10, -97, { gageHeightFt: i }),
  );
  const { sliceWater } = createWaterSlices({
    reader: fakeReader(rows),
    now: () => NOW,
  });
  const box = { w: -100, s: 30, e: -96, n: 34 };
  const cut = await sliceWater({ t: T, bbox: box, maxRows: 2, windowMs: HOUR });
  assert.equal(cut.body.features.length, 2);
  assert.equal(cut.headers['X-History-Truncated'], '1');
  const empty = createWaterSlices({ reader: fakeReader([]), now: () => NOW });
  const gap = await empty.sliceWater({
    t: T,
    bbox: box,
    maxRows: 2,
    windowMs: HOUR,
  });
  assert.equal(gap.headers['X-History-Gap'], '1');
});

test('slice: a refused box is an explained empty slice; a source failure is an error', async () => {
  const refused = Object.assign(new Error('area'), {
    code: 'INVALID_ARGUMENT',
  });
  const a = createWaterSlices({
    reader: fakeReader([], { fail: refused }),
    now: () => NOW,
  });
  const box = { w: -100, s: 30, e: -96, n: 34 };
  const r = await a.sliceWater({ t: T, bbox: box, maxRows: 5, windowMs: HOUR });
  assert.equal(r.headers['X-History-Empty-Reason'], 'area_too_large');
  const down = Object.assign(new Error('water history source: HTTP 503'), {
    code: 'BACKEND',
  });
  const b = createWaterSlices({
    reader: fakeReader([], { fail: down }),
    now: () => NOW,
  });
  await assert.rejects(
    b.sliceWater({ t: T, bbox: box, maxRows: 5, windowMs: HOUR }),
    /503/,
  );
});

test('slice params: water takes a 2 h default window, up to 6 h, and a box', () => {
  assert.equal(SLICE_FEEDS.water.window.max, 6 * HOUR);
  const p = parseSliceParams(
    new URLSearchParams({ feed: 'water', t: iso(T), bbox: '-100,30,-96,34' }),
    '',
    NOW,
  );
  assert.deepEqual(p.bbox, { w: -100, s: 30, e: -96, n: 34 });
  assert.equal(p.windowMs, 2 * HOUR);
  assert.throws(() =>
    parseSliceParams(
      new URLSearchParams({ feed: 'water', t: iso(T), window: '7h' }),
      '',
      NOW,
    ),
  );
});

// --------------------------------------------------------------- client
test('tile boxes agree with the exporter manifest and stay under 25 sq deg', () => {
  assert.deepEqual(waterTileBox(10, 37), { w: -140, s: 58, e: -136, n: 62 });
  assert.deepEqual(waterTileBox(13, 32), { w: -128, s: 38, e: -124, n: 42 });
  for (const [x, y] of [
    [0, 0],
    [89, 44],
    [20, 30],
  ]) {
    const b = waterTileBox(x, y);
    assert.ok((b.e - b.w) * (b.n - b.s) <= 25);
  }
  assert.equal(waterTileBox(90, 0), null);
  assert.equal(waterTileBox(0, 45), null);
});

test('adapter claims only the stream tiles, in the registry and the menu', () => {
  assert.ok(ALL_HISTORY_ADAPTERS.includes(WATER_ADAPTER));
  assert.ok(ROUTER_ROWS.some((r) => r.adapterIds.includes('water')));
  const at = (p) => new URL(p, 'http://localhost:4173');
  assert.equal(
    adapterForUrl(
      at('/byrdit/usgs_water/stream/13_32.geojsonl'),
      ALL_HISTORY_ADAPTERS,
    ),
    WATER_ADAPTER,
  );
  for (const p of [
    '/byrdit/usgs_water/manifest.json',
    '/byrdit/usgs_water/stream.geojsonl',
    '/byrdit/usgs_water/lake.geojsonl',
    '/byrdit/usgs_water/stream/13_32.geojsonl.map',
    '/byrdit/usgs_water/stream/../manifest.json',
  ])
    assert.equal(adapterForUrl(at(p), ALL_HISTORY_ADAPTERS), null, p);
  assert.ok(WATER_TILE_RE.test('/byrdit/usgs_water/stream/0_0.geojsonl'));
});

test('adapter asks the tile box and one cache key for all tiles', () => {
  const url = new URL('http://x/byrdit/usgs_water/stream/13_32.geojsonl');
  assert.deepEqual(WATER_ADAPTER.sliceParams(url), [
    { bbox: '-128,38,-124,42' },
  ]);
  assert.equal(
    WATER_ADAPTER.paramsKey(url),
    WATER_ADAPTER.paramsKey(
      new URL('http://x/byrdit/usgs_water/stream/1_1.geojsonl'),
    ),
  );
  const u = sliceUrl(WATER_ADAPTER, WATER_ADAPTER.sliceParams(url)[0], T);
  assert.match(
    u,
    /^\/api\/history\/slice\?feed=water&t=.*&bbox=-128%2C38%2C-124%2C42$/,
  );
  assert.equal(WATER_ADAPTER.reloadOnFrame, true);
  assert.equal(WATER_ADAPTER.rebased, false);
});

test('adapter output is JSON Lines the water layer parses; edge gauges land in one tile', () => {
  const url = new URL('http://x/byrdit/usgs_water/stream/13_32.geojsonl');
  const feat = (id, lon, lat) =>
    gaugeFeature(obs(id, T, lat, lon, { name: id, gageHeightFt: 3 }));
  const body = {
    type: 'FeatureCollection',
    features: [
      feat('IN', -126, 40),
      feat('WESTEDGE', -128, 40), // belongs here (half-open box)
      feat('EASTEDGE', -124, 40), // belongs to the next tile east
      feat('NORTHEDGE', -126, 42), // belongs to the next tile north
    ],
  };
  const out = WATER_ADAPTER.adapt(
    [{ status: 200, headers: { 'x-history-rows': '4' }, body }],
    { t: T, nowMs: NOW, url },
  );
  const features = parseJsonl(out.raw);
  assert.deepEqual(
    features.map((f) => f.properties.usgs_site_id),
    ['USGS-IN', 'USGS-WESTEDGE'],
  );
  assert.equal(features[0].properties.readings[0].value, 3);
  assert.equal(out.headers['X-History-Rows'], '2');
  assert.equal(out.headers['X-History-Gap'], undefined);
  assert.equal(out.chip.state, 'history-note');
  assert.equal(out.raw.endsWith('\n'), true);
});

test('adapter: nothing at the time is an empty body; too old is an explained chip', () => {
  const url = new URL('http://x/byrdit/usgs_water/stream/13_32.geojsonl');
  const empty = WATER_ADAPTER.adapt(
    [
      {
        status: 200,
        headers: {},
        body: { type: 'FeatureCollection', features: [] },
      },
    ],
    { t: T, nowMs: NOW, url },
  );
  assert.equal(empty.raw, '');
  assert.deepEqual(parseJsonl(empty.raw), []);
  const old = WATER_ADAPTER.adapt(
    [
      {
        status: 404,
        headers: { 'x-history-empty-reason': 'before_recording_start' },
        body: { error: 'not_recorded' },
      },
    ],
    { t: NOW - 200 * DAY, nowMs: NOW, url },
  );
  assert.equal(old.raw, '');
  assert.equal(old.chip.state, 'history-empty');
  assert.equal(old.chip.reason, 'before_recording_start');
});

test('the live tile selection is unchanged (history reuses its requests)', () => {
  const tiles = {
    '13_32': {
      bounds: [-128, 38, -124, 42],
      file: 'stream/13_32.geojsonl',
      count: 1,
    },
  };
  const pick = selectStreamTiles(tiles, {
    west: -127,
    south: 39,
    east: -125,
    north: 41,
  });
  assert.equal(pick.status, 'ok');
  assert.ok(WATER_TILE_RE.test(`/byrdit/usgs_water/${pick.tiles[0].file}`));
});
