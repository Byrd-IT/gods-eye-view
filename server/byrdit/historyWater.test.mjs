import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWaterHistoryReader,
  DEFAULT_WATER_PER_HOUR,
} from './historyWater.js';
import { createHistoryService } from '../../src/byrdit/history/historyService.js';

/** t_7a4c6a57: the injected USGS reader, and the service that uses it. */
const NOW = Date.UTC(2026, 10, 1, 18, 0, 0);
const HOUR = 3_600_000;

const series = (code, variable, points, lat, lon) => ({
  sourceInfo: {
    siteName: `Gauge ${code}`,
    siteCode: [{ value: code }],
    geoLocation: { geogLocation: { latitude: lat, longitude: lon } },
  },
  variable: { variableCode: [{ value: variable }] },
  values: [
    {
      value: points.map(([dateTime, value]) => ({
        dateTime,
        value: String(value),
      })),
    },
  ],
});

function fakeFetch(timeSeries, status = 200) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ value: { timeSeries } }), { status });
  };
  f.calls = calls;
  return f;
}
const BOX = { west: -100, south: 30, east: -96, north: 34 };

test('reader: asks USGS NWIS for the box and time, nothing else', async () => {
  const fetch = fakeFetch([
    series(
      '08158000',
      '00065',
      [['2026-10-29T17:45:00.000-00:00', 4.5]],
      30.2,
      -97.7,
    ),
  ]);
  const reader = createWaterHistoryReader({ env: {}, fetch, now: () => NOW });
  const t = NOW - 3 * 24 * HOUR;
  const r = await reader.read({ t, windowMs: 6 * HOUR, limit: 100, bbox: BOX });
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].key, '08158000');
  const url = new URL(fetch.calls[0].url);
  assert.equal(
    url.origin + url.pathname,
    'https://waterservices.usgs.gov/nwis/iv/',
  );
  assert.equal(
    url.searchParams.get('bBox'),
    '-100.000000,30.000000,-96.000000,34.000000',
  );
  assert.equal(fetch.calls[0].init.redirect, 'error');
  assert.equal(reader.earliestMs(NOW), NOW - 120 * 24 * HOUR);
});

test('reader: refuses a box over 25 square degrees without calling USGS', async () => {
  const fetch = fakeFetch([]);
  const reader = createWaterHistoryReader({ env: {}, fetch, now: () => NOW });
  await assert.rejects(
    reader.read({
      t: NOW,
      windowMs: HOUR,
      limit: 10,
      bbox: { west: -100, south: 30, east: -90, north: 40 },
    }),
    (e) => e.code === 'INVALID_ARGUMENT' && /25 square degrees/.test(e.message),
  );
  assert.equal(fetch.calls.length, 0);
});

test('reader: hourly budget is GEV_HISTORY_WATER_PER_HOUR (default 600) and fails closed', async () => {
  assert.equal(DEFAULT_WATER_PER_HOUR, 600);
  const fetch = fakeFetch([]);
  const reader = createWaterHistoryReader({
    env: { GEV_HISTORY_WATER_PER_HOUR: '2' },
    fetch,
    now: () => NOW,
  });
  const q = (i) => ({
    t: NOW - (i + 1) * 3_600_000,
    windowMs: HOUR,
    limit: 10,
    bbox: BOX,
  });
  await reader.read(q(0));
  await reader.read(q(1));
  await assert.rejects(
    reader.read(q(2)),
    (e) => e.code === 'BACKEND' && /budget/.test(e.message),
  );
  assert.equal(fetch.calls.length, 2);
  // a nonsense setting falls back to the default, never to unlimited
  const bad = createWaterHistoryReader({
    env: { GEV_HISTORY_WATER_PER_HOUR: '-5' },
    fetch: fakeFetch([]),
  });
  assert.ok(bad);
});

test('reader: a USGS failure names the feed, never the URL', async () => {
  const fetch = fakeFetch([], 503);
  const reader = createWaterHistoryReader({ env: {}, fetch, now: () => NOW });
  await assert.rejects(
    reader.read({ t: NOW, windowMs: HOUR, limit: 10, bbox: BOX }),
    (e) =>
      e.code === 'BACKEND' && !/waterservices|https?:\/\//i.test(e.message),
  );
});

test('service: feed=water goes through the injected reader (no ES needed)', async () => {
  const fetch = fakeFetch([
    series(
      '08158000',
      '00060',
      [['2026-10-29T17:45:00.000-00:00', 123]],
      30.2,
      -97.7,
    ),
  ]);
  const waterReader = createWaterHistoryReader({
    env: {},
    fetch,
    now: () => NOW,
  });
  const es = {
    search: async () => ({}),
    searchAll: async () => ({ hits: [] }),
  };
  const service = createHistoryService({ es, now: () => NOW, waterReader });
  const out = await service.slice({
    feed: 'water',
    t: NOW - 3 * 24 * HOUR,
    bbox: { w: -100, s: 30, e: -96, n: 34 },
    maxRows: 100,
    windowMs: 6 * HOUR,
  });
  assert.equal(out.body.features.length, 1);
  assert.equal(out.body.features[0].properties.readings[0].value, 123);
  assert.equal(out.headers['X-History-Rows'], '1');
});

test('reader: synthetic secrets in a failing fetch never reach the error', async () => {
  const secret = 'SYNTHtoken9f3kQ2ABC123';
  const msg = `Authorization: Bearer ${secret} https://u:${secret}@h.example/x?api_key=${secret}`;
  const fetches = [
    async () => {
      const e = new Error(msg);
      e.cause = new Error(msg);
      throw e;
    },
    async () =>
      new Response(msg, { status: 500, headers: { 'x-api-key': secret } }),
    async () => new Response(msg, { status: 200 }),
  ];
  for (const fetch of fetches) {
    const reader = createWaterHistoryReader({ env: {}, fetch, now: () => NOW });
    await assert.rejects(
      reader.read({ t: NOW - 24 * HOUR, windowMs: HOUR, limit: 5, bbox: BOX }),
      (e) => {
        const text = [
          e.message,
          e.stack,
          JSON.stringify(e),
          String(e.cause ?? ''),
        ].join('\n');
        for (const v of [
          secret,
          secret.slice(0, 8),
          secret.slice(-6),
          encodeURIComponent(secret),
          Buffer.from(secret).toString('base64'),
        ])
          assert.ok(!text.includes(v), 'leak');
        return e.code === 'BACKEND';
      },
    );
  }
});
