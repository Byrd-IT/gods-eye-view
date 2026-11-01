import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirGnssSlices } from './history/historySlicesAirGnss.js';
import { SLICE_FEEDS, parseSliceParams } from './history/historyParams.js';
import { HISTORY_INDICES } from './history/historyEs.js';
import {
  AQHI_ADAPTER,
  GNSS_ADAPTER,
  expandGnssCells,
} from './historyUi/historyAirGnssAdapters.js';
import {
  ALL_HISTORY_ADAPTERS,
  EVENT_ADAPTERS,
} from './historyUi/historyEventAdapters.js';
import { adapterForUrl } from './historyUi/historyAdapters.js';
import { ROUTER_ROWS } from './historyUi/clockRows.js';
import {
  normalizeAqhiObservations,
  normalizeAqhiStations,
} from '../layers/airQuality/model.js';
import {
  accumulateGnssObservations,
  binGnssCells,
  gnssIntegrityLevel,
} from '../layers/gnss/records.js';

/**
 * t_7d3de14d: AQHI and GNSS-integrity history. Docs below have the shape of
 * real gev-history-aqhi / gev-history-gnss-integrity hits (ES, 2026-11-01).
 */

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 15, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- fake ES
const get = (doc, f) => f.split('.').reduce((o, k) => o?.[k], doc);
const asMs = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : v;
function matches(doc, q) {
  if (!q) return true;
  if (q.bool) return (q.bool.filter ?? []).every((f) => matches(doc, f));
  if (q.term) {
    const [f, v] = Object.entries(q.term)[0];
    return get(doc, f) === v;
  }
  if (q.range) {
    const [f, r] = Object.entries(q.range)[0];
    const v = asMs(get(doc, f));
    return (
      (r.gte === undefined || v >= r.gte) && (r.lte === undefined || v <= r.lte)
    );
  }
  return true;
}
function fakeEs(docsByIndex) {
  const calls = [];
  return {
    calls,
    async search(index, body) {
      calls.push({ index, body });
      const docs = docsByIndex[index] ?? [];
      if (body.size === 0 && body.aggs?.first)
        {return {
          aggregations: {
            first: {
              value: Math.min(
                ...docs.map((d) => asMs(get(d, Object.values(body.aggs.first.min)[0]))),
              ),
            },
          },
        };}
      let hits = docs.filter((d) => matches(d, body.query));
      const [sf, sd] = Object.entries(body.sort?.[0] ?? {})[0] ?? [];
      if (sf)
        hits = [...hits].sort(
          (a, b) =>
            (asMs(get(a, sf)) - asMs(get(b, sf))) * (sd === 'asc' ? 1 : -1),
        );
      if (body.collapse) {
        const seen = new Set();
        hits = hits.filter((d) => {
          const k = get(d, body.collapse.field);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      return {
        hits: { hits: hits.slice(0, body.size).map((_source) => ({ _source })) },
      };
    },
    async searchAll(index, { query, maxRows }) {
      const hits = (docsByIndex[index] ?? []).filter((d) => matches(d, query));
      return {
        hits: hits.slice(0, maxRows).map((_source) => ({ _source })),
        truncated: hits.length > maxRows,
      };
    },
  };
}

const aq = (id, at, aqhi, extra = {}) => ({
  '@timestamp': iso(at),
  aqhi,
  aqhi_value: Math.max(1, Math.round(aqhi)),
  band: 'low',
  location: { lat: 47.5, lon: -52.7 },
  location_id: id,
  observation_type: 'original',
  snap: at + 5 * MIN,
  source: 'eccc-aqhi',
  station: `Station ${id}`,
  ...extra,
});
const gc = (cell, snap, total, bad) => ({
  '@timestamp': iso(snap),
  bad,
  bad_pct: (100 * Math.max(0, bad - 1)) / total,
  band: 'none',
  cell,
  location: { lat: 24.75, lon: 51.25 },
  snap,
  source: 'adsb.lol-mil',
  total,
});

// ---------------------------------------------------------------- server
test('AQHI slice: newest observation per station inside the window, change-only', async () => {
  const es = fakeEs({
    [HISTORY_INDICES.aqhi]: [
      aq('A', T0 - 3 * HOUR, 2.4),
      aq('A', T0 - HOUR, 5.6), // newer A
      aq('B', T0 - 7 * HOUR, 3.1), // older than the 6 h window
      aq('C', T0 + HOUR, 9.9), // after t
      aq('D', T0 - 30 * MIN, 1.2),
    ],
  });
  const { sliceAqhi } = createAirGnssSlices({ es, now: () => T0 + 5 * HOUR });
  const r = await sliceAqhi({ t: T0, bbox: null, maxRows: 100, windowMs: 6 * HOUR });
  const byId = Object.fromEntries(r.body.features.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(byId).sort(), ['A', 'D']);
  assert.equal(byId.A.properties.aqhi, 5.6);
  assert.equal(byId.A.properties.observation_datetime, iso(T0 - HOUR));
  assert.deepEqual(byId.A.geometry.coordinates, [-52.7, 47.5]);
});

test('AQHI slice: before the first recording is a 404 not_recorded with the start', async () => {
  const es = fakeEs({ [HISTORY_INDICES.aqhi]: [aq('A', T0, 2)] });
  const { sliceAqhi } = createAirGnssSlices({ es, now: () => T0 });
  const r = await sliceAqhi({ t: T0 - 24 * HOUR, bbox: null, maxRows: 10, windowMs: 6 * HOUR });
  assert.equal(r.status, 404);
  assert.equal(r.headers['X-History-Empty-Reason'], 'before_recording_start');
  assert.equal(r.headers['X-History-Recording-Start'], iso(T0));
});

test('GNSS slice: cells of the newest snapshot at or before t, nothing later', async () => {
  const s1 = T0 - 10 * MIN;
  const s2 = T0 - 5 * MIN;
  const s3 = T0 + 5 * MIN;
  const es = fakeEs({
    [HISTORY_INDICES.gnss]: [
      gc('1:1', s1, 3, 0),
      gc('2:2', s2, 4, 2),
      gc('3:3', s2, 1, 0),
      gc('9:9', s3, 5, 5),
    ],
  });
  const { sliceGnss } = createAirGnssSlices({ es, now: () => T0 + HOUR });
  const r = await sliceGnss({ t: T0, bbox: null, maxRows: 100 });
  assert.equal(r.body.snap, s2);
  assert.deepEqual(r.body.cells.map((c) => c.cell), ['2:2', '3:3']);
  assert.equal(r.headers['X-History-Gnss-Population'], 'military-aircraft');
  // a time with no snapshot in 15 min is a gap, not another time's data
  const gap = await sliceGnss({ t: T0 + 65 * MIN, bbox: null, maxRows: 100 });
  assert.deepEqual(gap.body.cells, []);
  assert.equal(gap.headers['X-History-Gap'], '1');
});

test('slice params: aqhi takes a window up to a day, gnss none', () => {
  assert.ok(SLICE_FEEDS.aqhi.window.max >= SLICE_FEEDS.aqhi.window.def);
  const now = T0 + HOUR;
  const p = parseSliceParams(
    new URLSearchParams({ feed: 'aqhi', t: iso(T0) }),
    '',
    now,
  );
  assert.equal(p.windowMs, SLICE_FEEDS.aqhi.window.def);
  assert.throws(() =>
    parseSliceParams(
      new URLSearchParams({ feed: 'gnss', t: iso(T0), window: '1h' }),
      '',
      now,
    ),
  );
});

// --------------------------------------------------------------- client
test('both adapters are in the active registry and the menu', () => {
  assert.ok(ALL_HISTORY_ADAPTERS.includes(AQHI_ADAPTER));
  assert.ok(ALL_HISTORY_ADAPTERS.includes(GNSS_ADAPTER));
  for (const id of ['aqhi', 'gnss'])
    assert.ok(ROUTER_ROWS.some((r) => r.adapterIds.includes(id)));
  assert.ok(!EVENT_ADAPTERS.includes(AQHI_ADAPTER)); // kept apart from B12b
});

test('AQHI adapter claims only the ECCC observations, not the station catalog', () => {
  const obs = new URL(
    'https://api.weather.gc.ca/collections/aqhi-observations-realtime/items?f=json&latest=true&limit=500',
  );
  const stn = new URL(
    'https://api.weather.gc.ca/collections/aqhi-stations/items?f=json&limit=500',
  );
  const other = new URL(
    'https://example.test/collections/aqhi-observations-realtime/items',
  );
  assert.equal(adapterForUrl(obs, ALL_HISTORY_ADAPTERS), AQHI_ADAPTER);
  assert.equal(adapterForUrl(stn, ALL_HISTORY_ADAPTERS), null);
  assert.equal(adapterForUrl(other, ALL_HISTORY_ADAPTERS), null);
});

test('AQHI adapter output passes the layer parser at a past time (ages stay true)', () => {
  const t = T0 - 40 * 24 * HOUR; // far in the past
  const nowMs = T0;
  const answer = {
    status: 200,
    headers: { 'x-history-rows': '1' },
    body: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'A',
          geometry: { type: 'Point', coordinates: [-52.7, 47.5] },
          properties: {
            location_id: 'A',
            aqhi: 5.6,
            observation_datetime: iso(t - 30 * MIN),
            special_notes_en: null,
          },
        },
      ],
    },
  };
  const out = AQHI_ADAPTER.adapt([answer], { t, nowMs });
  const stations = normalizeAqhiStations({
    features: [
      {
        geometry: { coordinates: [-52.7, 47.5] },
        properties: { location_id: 'A', location_name_en: 'A' },
      },
    ],
  });
  const readings = normalizeAqhiObservations(out.body, stations, nowMs);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].value, 6);
  // 30 min old at t -> 30 min old now
  assert.equal(nowMs - readings[0].observedMs, 30 * MIN);
  // the same frame without rebasing would have been dropped as >6 h old
  assert.equal(
    normalizeAqhiObservations(answer.body, stations, nowMs).length,
    0,
  );
});

test('AQHI/GNSS adapters turn a 404 not_recorded into the live empty shape + chip', () => {
  const a = {
    status: 404,
    headers: {
      'x-history-empty-reason': 'before_recording_start',
      'x-history-recording-start': iso(T0),
    },
    body: { error: 'not_recorded' },
  };
  const q = AQHI_ADAPTER.adapt([a], { t: T0 - HOUR, nowMs: T0 });
  assert.deepEqual(q.body.features, []);
  assert.equal(q.chip.reason, 'before_recording_start');
  const g = GNSS_ADAPTER.adapt([a], { t: T0 - HOUR, nowMs: T0 });
  assert.deepEqual(g.body.rows, []);
  assert.equal(g.chip.reason, 'before_recording_start');
});

test('GNSS expansion reproduces the recorded cells through the layer rules', () => {
  const recorded = [
    { cell: '229:462', lat: 24.75, lon: 51.25, total: 6, bad: 3 },
    { cell: '230:462', lat: 25.25, lon: 51.25, total: 3, bad: 0 },
    { cell: '231:462', lat: 25.75, lon: 51.25, total: 2, bad: 2 }, // below 3
  ];
  const t = T0 - 3 * 24 * HOUR;
  const snap = t - 4 * MIN;
  const out = GNSS_ADAPTER.adapt(
    [{ status: 200, headers: {}, body: { snap, cells: recorded } }],
    { t, nowMs: T0 },
  );
  assert.equal(out.body.ageMs, 4 * MIN);
  assert.equal(out.body.rows.length, 11);
  const store = new Map();
  accumulateGnssObservations(store, out.body.rows, T0, {
    observedAt: T0 - out.body.ageMs,
  });
  const cells = binGnssCells(store);
  assert.deepEqual(
    cells.map((c) => [c.aircraft, c.degraded]),
    [
      [6, 3],
      [3, 0],
    ],
  );
  // the level is the layer's own rule applied to the recorded counts
  assert.equal(cells[0].level, gnssIntegrityLevel(6, 3).level);
  assert.equal(out.chip.state, 'history-note');
});

test('GNSS expansion never exceeds its cap and ignores bad cells', () => {
  const rows = expandGnssCells(
    [
      { cell: 'x', lat: 1, lon: 1, total: 5, bad: 9 }, // bad clamped to total
      { cell: 'y', lat: NaN, lon: 1, total: 5, bad: 0 },
      { cell: 'z', lat: 1, lon: 1, total: 0, bad: 0 },
    ],
    3,
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.degraded));
});

test('GNSS adapter flags a capped expansion as truncated (nothing silently dropped)', () => {
  const cells = Array.from({ length: 30 }, (_, i) => ({
    cell: `c${i}`,
    lat: 1,
    lon: 1,
    total: 3000,
    bad: 0,
  }));
  const out = GNSS_ADAPTER.adapt(
    [{ status: 200, headers: {}, body: { snap: T0, cells } }],
    { t: T0, nowMs: T0 },
  );
  assert.equal(out.body.rows.length, 60_000);
  assert.equal(out.headers['X-History-Truncated'], '1');
});

test('AQHI slice honours maxRows (truncated flag) and the bbox', async () => {
  const docs = ['A', 'B', 'C'].map((id, i) => ({
    ...aq(id, T0 - 10 * MIN, 3),
    location: { lat: 10 + i, lon: 20 },
  }));
  const es = fakeEs({ [HISTORY_INDICES.aqhi]: docs });
  const { sliceAqhi } = createAirGnssSlices({ es, now: () => T0 + HOUR });
  const r = await sliceAqhi({ t: T0, bbox: null, maxRows: 2, windowMs: 6 * HOUR });
  assert.equal(r.body.features.length, 2);
  assert.equal(r.headers['X-History-Truncated'], '1');
  const b = await sliceAqhi({
    t: T0,
    bbox: { n: 11.5, s: 9, w: 19, e: 21 },
    maxRows: 10,
    windowMs: 6 * HOUR,
  });
  assert.ok(es.calls.at(-1).body.query.bool.filter.some((f) => f.geo_bounding_box));
  assert.ok(b.body.features.length >= 0);
});
