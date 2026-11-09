import test from 'node:test';
import assert from 'node:assert/strict';
import { waterReaderFor } from './history.js';
import { createWaterSlices } from '../../src/byrdit/history/historySlicesWater.js';
import { historyPlugins } from '../../src/byrdit/history/index.js';
import {
  WATER_ADAPTER,
  WATER_BEFORE_RECORDING_CHIP,
  WATER_NOTE_CHIP,
  WATER_RECORDED_CHIP,
  WATER_RECORDED_ONLY_CHIP,
  WATER_TOO_OLD_CHIP,
} from '../../src/byrdit/historyUi/historyWaterAdapter.js';

/** t_a829441f: GEV_ES_LIVE_WATER=1 keeps USGS NWIS out of the history slider. */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 6, 0, 0);
const FIRST = Date.UTC(2026, 8, 3, 5, 45, 0);
const box = { w: -100, s: 30, e: -96, n: 34 };

function closeNetwork(t) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    throw new Error('network');
  };
  t.after(() => {
    globalThis.fetch = original;
    assert.deepEqual(seen, [], 'no outside call');
  });
}

test('flag off: the NWIS reader is built as before; flag on: none', () => {
  const env = { GEV_ES_LIVE_WATER: '0' };
  assert.equal(typeof waterReaderFor(env)?.read, 'function');
  assert.equal(typeof waterReaderFor({})?.read, 'function');
  assert.equal(waterReaderFor({ GEV_ES_LIVE_WATER: '1' }), null);
});

test('flag on: before our recording is an explained empty slice, USGS is not asked', async (t) => {
  closeNetwork(t);
  const es = {
    async search(_index, body) {
      if (body.aggs?.first) return { aggregations: { first: { value: FIRST } } };
      return { aggregations: { sites: { buckets: [] } } };
    },
  };
  const { sliceWater } = createWaterSlices({
    reader: waterReaderFor({ GEV_ES_LIVE_WATER: '1' }),
    es,
    now: () => NOW,
  });
  const out = await sliceWater({ t: FIRST - 5 * DAY, bbox: box, maxRows: 10, windowMs: 3_600_000 });
  assert.equal(out.status, 404);
  assert.equal(out.headers['X-History-Empty-Reason'], 'before_recording_start');
});

test('flag on: an unreadable copy is an error, never a USGS stand-in', async (t) => {
  closeNetwork(t);
  const es = {
    async search() {
      throw new Error('es down');
    },
  };
  const { sliceWater } = createWaterSlices({
    reader: waterReaderFor({ GEV_ES_LIVE_WATER: '1' }),
    es,
    now: () => NOW,
  });
  await assert.rejects(() =>
    sliceWater({ t: NOW - DAY, bbox: box, maxRows: 10, windowMs: 3_600_000 }),
  );
});

test('plugin list: flags off add nothing; a flag puts the ES-live plugin first', () => {
  const none = historyPlugins({ env: {} });
  assert.equal(none.some((p) => p.name === 'byrdit-es-live'), false);
  const env = { GEV_ES_LIVE_GNSS: '1', GEV_BRIDGE_MILITARY: '1', GEV_COLLECTOR_URLS: 'http://127.0.0.1:4180' };
  const plugins = historyPlugins({ env });
  assert.equal(plugins[0].name, 'byrdit-es-live');
  assert.ok(plugins.length > 1, 'the collector bridge still follows');
});

test('flag on: the slice says it is recorded-only, and the chips stop mentioning USGS on request', async (t) => {
  closeNetwork(t);
  const doc = {
    parameter_code: '00065',
    value: 3.2,
    unit: 'ft',
    observed_time: new Date(NOW - DAY).toISOString(),
    site_name: 'Test Ck',
    location: { lat: 31.5, lon: -97.5 },
  };
  const es = {
    async search(_index, body) {
      if (body.aggs?.first) return { aggregations: { first: { value: FIRST } } };
      return {
        aggregations: {
          sites: { buckets: [{ key: 'USGS-01', p: { buckets: [{ key: '00065', n: { hits: { hits: [{ _source: doc }] } } }] } }] },
        },
      };
    },
  };
  const only = createWaterSlices({ reader: null, es, now: () => NOW });
  const recorded = await only.sliceWater({ t: NOW - DAY, bbox: box, maxRows: 10, windowMs: 3_600_000 });
  assert.equal(recorded.headers['X-History-Recorded-Only'], '1');
  const early = await only.sliceWater({ t: FIRST - DAY, bbox: box, maxRows: 10, windowMs: 3_600_000 });
  assert.equal(early.headers['X-History-Recorded-Only'], '1');
  // with a reader (flag off) the marker is absent: behaviour and text unchanged
  const reader = { earliestMs: (n) => n - 120 * DAY, async read() { return { observations: [], truncated: false }; } };
  const both = createWaterSlices({ reader, es, now: () => NOW });
  const rec2 = await both.sliceWater({ t: NOW - DAY, bbox: box, maxRows: 10, windowMs: 3_600_000 });
  assert.equal(rec2.headers['X-History-Recorded-Only'], undefined);

  const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const url = '/byrdit/usgs_water/stream/20_30.geojsonl';
  const chipOf = (out) =>
    WATER_ADAPTER.adapt([{ status: out.status ?? 200, headers: lower(out.headers), body: out.body }], { url }).chip;
  assert.equal(chipOf(recorded).text, WATER_RECORDED_ONLY_CHIP);
  assert.equal(chipOf(early).text, WATER_BEFORE_RECORDING_CHIP);
  assert.equal(chipOf(rec2).text, WATER_RECORDED_CHIP);
  const nwisHeaders = { 'x-history-source': 'usgs-nwis-iv' };
  assert.equal(WATER_ADAPTER.adapt([{ status: 200, headers: nwisHeaders, body: { type: 'FeatureCollection', features: [] } }], { url }).chip.text, WATER_NOTE_CHIP);
  assert.equal(
    WATER_ADAPTER.adapt([{ status: 404, headers: { 'x-history-empty-reason': 'before_recording_start' }, body: {} }], { url }).chip.text,
    WATER_TOO_OLD_CHIP,
  );
  for (const text of [WATER_RECORDED_ONLY_CHIP, WATER_BEFORE_RECORDING_CHIP])
    assert.ok(!text.includes('120'), text);
});
