import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWaterSlices,
  recordedGaugeFeature,
  WATER_ES_MAX_QUEUED,
} from './history/historySlicesWater.js';
import { WATER_ADAPTER } from './historyUi/historyWaterAdapter.js';

/** t_7d3de14d (owner 2A): water slice from our own usgs-water-levels copy. */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 1, 18, 0, 0);
const FIRST = Date.UTC(2026, 8, 3, 5, 45, 0);
const T = NOW - 3 * DAY;
const box = { w: -100, s: 30, e: -96, n: 34 };
const doc = (code, value, at, unit) => ({
  parameter_code: code,
  value,
  unit,
  observed_time: new Date(at).toISOString(),
  site_name: 'Test Ck',
  location: { lat: 31.5, lon: -97.5 },
});

function fakeEs({ buckets = [], first = FIRST, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async search(index, body) {
      calls.push({ index, body });
      if (fail) throw new Error('es down');
      if (body.aggs?.first) return { aggregations: { first: { value: first } } };
      return { aggregations: { sites: { buckets } } };
    },
  };
}
const site = (id, ...docs) => ({
  key: id,
  p: {
    buckets: docs.map((d) => ({
      key: d.parameter_code,
      n: { hits: { hits: [{ _source: d }] } },
    })),
  },
});

const reader = () => {
  const calls = [];
  return {
    calls,
    earliestMs: (n) => n - 120 * DAY,
    async read(q) {
      calls.push(q);
      return { observations: [], truncated: false };
    },
  };
};

test('recorded time: answered from the copy, both readings, ES query bounded by time, box and stream parameters', async () => {
  const es = fakeEs({
    buckets: [
      site(
        'USGS-02',
        doc('00065', 3.2, T - 20 * 60_000, 'ft'),
        doc('00060', 90, T - 20 * 60_000, 'ft^3/s'),
      ),
      site('USGS-01', doc('00060', 5, T - 5 * 60_000, 'ft^3/s')),
    ],
  });
  const r = reader();
  const { sliceWater } = createWaterSlices({ reader: r, es, now: () => NOW });
  const out = await sliceWater({ t: T, bbox: box, maxRows: 100, windowMs: 2 * HOUR });
  assert.equal(r.calls.length, 0, 'NWIS is not asked for a recorded time');
  assert.equal(out.headers['X-History-Source'], 'recorded');
  assert.equal(out.headers['X-History-Rows'], '2');
  const f2 = out.body.features.find((f) => f.properties.usgs_site_id === 'USGS-02');
  assert.deepEqual(
    f2.properties.readings.map((x) => [x.parameter_code, x.value]),
    [['00065', 3.2], ['00060', 90]],
  );
  const q = es.calls.at(-1);
  assert.equal(q.index, 'usgs-water-levels');
  const filters = JSON.stringify(q.body.query.bool.filter);
  assert.match(filters, /"lte":\d+/);
  assert.match(filters, /geo_bounding_box/);
  assert.match(filters, /"site_type_code":"ST"/);
  assert.ok(!('delete' in q.body));
});

test('before our recording: the NWIS reader answers, start header names our first record', async () => {
  const es = fakeEs();
  const r = reader();
  const { sliceWater } = createWaterSlices({ reader: r, es, now: () => NOW });
  const out = await sliceWater({
    t: FIRST - 5 * DAY,
    bbox: box,
    maxRows: 10,
    windowMs: 2 * HOUR,
  });
  assert.equal(r.calls.length, 1);
  assert.equal(out.headers['X-History-Source'], 'usgs-nwis-iv');
  assert.equal(out.headers['X-History-Recording-Start'], new Date(FIRST).toISOString());
});

test('an unreadable copy degrades to NWIS; no reader and before the copy is explained', async () => {
  const r = reader();
  const down = createWaterSlices({ reader: r, es: fakeEs({ fail: true }), now: () => NOW });
  await down.sliceWater({ t: T, bbox: box, maxRows: 10, windowMs: HOUR });
  assert.equal(r.calls.length, 1);
  const noReader = createWaterSlices({ reader: null, es: fakeEs(), now: () => NOW });
  const out = await noReader.sliceWater({
    t: FIRST - DAY,
    bbox: box,
    maxRows: 10,
    windowMs: HOUR,
  });
  assert.equal(out.status, 404);
  assert.equal(out.headers['X-History-Empty-Reason'], 'before_recording_start');
});

test('maxRows truncates and says so; empty recorded tile is a gap; no box is refused', async () => {
  const many = ['1', '2', '3'].map((i) => site(`USGS-${i}`, doc('00065', 1, T, 'ft')));
  const { sliceWater } = createWaterSlices({
    reader: reader(),
    es: fakeEs({ buckets: many }),
    now: () => NOW,
  });
  const cut = await sliceWater({ t: T, bbox: box, maxRows: 2, windowMs: HOUR });
  assert.equal(cut.headers['X-History-Rows'], '2');
  assert.equal(cut.headers['X-History-Truncated'], '1');
  const empty = createWaterSlices({ reader: reader(), es: fakeEs(), now: () => NOW });
  const gap = await empty.sliceWater({ t: T, bbox: box, maxRows: 5, windowMs: HOUR });
  assert.equal(gap.headers['X-History-Gap'], '1');
  const nb = await empty.sliceWater({ t: T, bbox: null, maxRows: 5, windowMs: HOUR });
  assert.equal(nb.headers['X-History-Empty-Reason'], 'area_required');
});

test('recordedGaugeFeature skips a gauge with no value or position', () => {
  assert.equal(recordedGaugeFeature('a', new Map()), null);
  const noPos = { ...doc('00065', 1, T, 'ft'), location: null };
  assert.equal(recordedGaugeFeature('a', new Map([['00065', noPos]])), null);
});

test('at most WATER_ES_MAX_QUEUED questions wait for Elasticsearch', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const es = {
    async search(_i, body) {
      if (body.aggs?.first) return { aggregations: { first: { value: FIRST } } };
      await gate;
      return { aggregations: { sites: { buckets: [] } } };
    },
  };
  const { sliceWater } = createWaterSlices({ reader: reader(), es, now: () => NOW });
  const ask = () => sliceWater({ t: T, bbox: box, maxRows: 5, windowMs: HOUR });
  const held = Array.from({ length: 4 + WATER_ES_MAX_QUEUED }, ask);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(ask(), /too many questions/);
  release();
  await Promise.all(held);
});

test('adapter: the chip says recorded vs read-on-request by X-History-Source', () => {
  const url = '/byrdit/usgs_water/stream/20_30.geojsonl';
  const run = (src) =>
    WATER_ADAPTER.adapt(
      [{ status: 200, headers: { 'x-history-source': src }, body: { features: [] } }],
      { url },
    ).chip.text;
  assert.notEqual(run('recorded'), run('usgs-nwis-iv'));
  assert.match(run('recorded'), /own USGS recording/);
});
