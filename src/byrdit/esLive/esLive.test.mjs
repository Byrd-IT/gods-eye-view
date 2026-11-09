import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FAIL_BACKOFF_MS,
  FRESH_LIMIT_MS,
  STALE_LIMIT_MS,
  STATION_WINDOW_MS,
  createEsLive,
  distanceNm,
  enabledEsLive,
  esLivePlugins,
  expandGnssCells,
} from './esLive.js';
import { expandGnssCells as historyExpand } from '../historyUi/historyAirGnssAdapters.js';
import { createHistoryService } from '../history/historyService.js';
import { createAdsbGnssSource } from '../../layers/gnss/source.js';
import { normalizeEarthquakeSnapshot } from '../../layers/earthquakes/records.js';
import {
  normalizeAqhiObservations,
  normalizeAqhiStations,
} from '../../layers/airQuality/model.js';

const NOW = Date.parse('2026-11-09T06:00:00Z');
const QUAKES = JSON.parse(
  readFileSync(
    new URL('../history/fixtures/b12c-usgs-all-day.json', import.meta.url),
    'utf8',
  ),
);

function aqhiFeature(id, name, lon, lat, minutesAgo = 30) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      location_id: id,
      location_name_en: name,
      aqhi: 1.78,
      observation_datetime: new Date(NOW - minutesAgo * 60_000).toISOString(),
      special_notes_en: null,
    },
  };
}
const AQHI_6H = {
  type: 'FeatureCollection',
  features: [aqhiFeature('AADCE', 'Burin', -55.175272, 47.082841)],
};
const AQHI_30D = {
  type: 'FeatureCollection',
  features: [
    aqhiFeature('AADCE', 'Burin', -55.175272, 47.082841),
    aqhiFeature('QUIET', 'Quiet Station', -100.5, 50.25, 60 * 24),
  ],
};

const GNSS_CELLS = [
  { cell: '103:653', lat: -38.25, lon: 146.75, total: 4, bad: 1 },
  { cell: '1:2', lat: 0.25, lon: 1.25, total: 3, bad: 0 },
  { cell: '9:9', lat: 30.25, lon: -95.25, total: 5, bad: 2 },
];

function fakeService(overrides = {}) {
  const calls = [];
  return {
    calls,
    async slice(params) {
      calls.push(params);
      if (overrides.fail) throw new Error('boom');
      if (params.feed === 'gnss')
        return (
          overrides.gnss ?? {
            body: { snap: NOW - 4 * 60_000, cells: GNSS_CELLS },
            headers: {},
          }
        );
      if (params.feed === 'quakes')
        return overrides.quakes ?? { body: QUAKES, headers: {} };
      if (params.feed === 'aqhi')
        return (
          overrides.aqhi ?? {
            body: params.windowMs > 24 * 3_600_000 ? AQHI_30D : AQHI_6H,
            headers: {},
          }
        );
      throw new Error('unexpected feed');
    },
  };
}

/** createEsLive with a fresh recording (newest snapshot 1 min old) unless told otherwise. */
function make(service, enabled, extra = {}) {
  return createEsLive({
    service,
    enabled,
    freshness: async () => (extra.now ?? (() => NOW))() - 60_000,
    now: () => NOW,
    log: () => {},
    ...extra,
  });
}

function call(mw, path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      destroyed: false,
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = String(v);
      },
      end(text) {
        resolve({ status: this.statusCode, headers: this.headers, text, passed: false });
      },
    };
    Promise.resolve(
      mw({ url: path, method }, res, () => resolve({ status: null, passed: true, headers: {} })),
    ).catch(reject);
  });
}
const json = (r) => JSON.parse(r.text);

// every test runs with the network closed: any outside fetch fails the test
function closeNetwork(t) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    throw new Error(`network call to ${url}`);
  };
  t.after(() => {
    globalThis.fetch = original;
    assert.deepEqual(seen, [], 'no outside call');
  });
}

test('flags: only an exact "1" turns a feed on', () => {
  assert.deepEqual(enabledEsLive({}), []);
  assert.deepEqual(
    enabledEsLive({ GEV_ES_LIVE_GNSS: '1', GEV_ES_LIVE_QUAKES: 'true', GEV_ES_LIVE_AQHI: ' 1 ' }),
    ['gnss', 'aqhi'],
  );
});

test('flags off: no plugin at all (plugin list unchanged)', () => {
  assert.deepEqual(esLivePlugins({ env: {} }), []);
  assert.deepEqual(esLivePlugins({ env: { GEV_ES_LIVE_GNSS: '0' } }), []);
});

test('plugin: /api/es-live/config names exactly the enabled feeds; ES not configured answers 503, never upstream', async (t) => {
  closeNetwork(t);
  const [plugin] = esLivePlugins({
    env: { GEV_ES_LIVE_QUAKES: '1', GEV_ES_LIVE_AQHI: '1' },
    log: () => {},
  });
  assert.equal(plugin.transformIndexHtml, undefined, 'no build-time HTML change');
  const stack = [];
  plugin.configureServer({ middlewares: { use: (fn) => stack.push(fn) } });
  plugin.configurePreviewServer({ middlewares: { use: (fn) => stack.push(fn) } });
  assert.equal(stack.length, 2, 'dev and preview both serve it');
  const cfg = await call(stack[1], '/api/es-live/config');
  assert.equal(cfg.status, 200);
  assert.deepEqual(json(cfg), { feeds: ['aqhi', 'quakes'] });
  assert.equal((await call(stack[1], '/api/es-live/config', { method: 'POST' })).status, 405);
  const r = await call(stack[0], '/api/es-live/earthquakes');
  assert.equal(r.status, 503);
  assert.deepEqual(json(r), { error: 'es_live_unavailable' });
});

test('plugin: the default freshness reads the newest snap of each stream through the reader-key client', async (t) => {
  closeNetwork(t);
  const asked = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    asked.push(`${init.method} ${path}`);
    const reply = (body) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body) });
    if (path === '/_security/_authenticate')
      return reply({ authentication_type: 'api_key', api_key: { name: 'gev-history-reader' } });
    return reply({ aggregations: { newest: { value: NOW - 90_000 } }, hits: { hits: [] } });
  };
  const [plugin] = esLivePlugins({
    env: {
      GEV_ES_LIVE_QUAKES: '1',
      GEV_HISTORY_ES_URL: 'https://es.example.test',
      GEV_HISTORY_ES_API_KEY: 'fake-key',
    },
    fetchImpl,
    now: () => NOW,
    log: () => {},
  });
  const stack = [];
  plugin.configureServer({ middlewares: { use: (fn) => stack.push(fn) } });
  // the history service answers "nothing recorded" from this fake: 503, but the
  // freshness question must have been asked of the quakes stream only
  const r = await call(stack[0], '/api/es-live/earthquakes');
  assert.equal(r.status, 503);
  assert.ok(asked.some((a) => a === 'POST /gev-history-quakes/_search'), asked.join(','));
  assert.ok(!asked.some((a) => a.includes('adsb')));
});

test('gnss: cells become the rows the live layer reads, no adsb.lol call', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['gnss']);
  const r = await call(mw, '/api/gnss-integrity?lat=30&lon=-95');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-feed-source'], 'elasticsearch');
  assert.equal(r.headers['x-gnss-population'], 'military-aircraft');
  const body = json(r);
  // only the cell inside the 250 nm circle around (30, -95)
  assert.equal(body.rows.length, 5);
  assert.equal(body.rows.filter((x) => x.degraded).length, 2);
  assert.equal(body.population, 'military-aircraft');
  assert.deepEqual(body.anchor, { lat: 30, lon: -95 });
  assert.equal(body.radiusNm, 250);
  assert.equal(body.ageMs, 4 * 60_000);
  assert.equal(body.fetchedAt, NOW - 4 * 60_000);
  assert.equal(body.stale, undefined);
  // the unchanged client source accepts the body
  const source = createAdsbGnssSource({
    fetchImpl: async () => new Response(r.text, { status: 200 }),
    now: () => NOW,
  });
  const snap = await source.getSnapshot({ latitude: 30, longitude: -95 }, {});
  assert.equal(snap.rows.length, 5);
  assert.equal(snap.ageMs, 4 * 60_000);
  assert.equal(snap.stale, false);
});

test('gnss: the answer is the 250 nm circle around the anchor, like the proxy it replaces', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['gnss']);
  const aus = json(await call(mw, '/api/gnss-integrity?lat=-38&lon=147'));
  assert.equal(aus.rows.length, 4);
  const none = json(await call(mw, '/api/gnss-integrity?lat=60&lon=60'));
  assert.deepEqual(none.rows, []);
  // 250 nm = 4.1667 degrees of latitude
  assert.ok(Math.abs(distanceNm(0, 0, 4.1667, 0) - 250) < 0.5);
  assert.equal(service.calls.length, 1, 'one ES read serves every anchor');
});

test('gnss: bad anchor 400, POST 405, flag off passes to the next middleware', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['gnss']);
  for (const q of ['', '?lat=99&lon=0', '?lat=1&lon=x', '?lat=&lon=', '?lat=1e1&lon=2'])
    assert.equal((await call(mw, `/api/gnss-integrity${q}`)).status, 400, q);
  assert.equal((await call(mw, '/api/gnss-integrity?lat=1&lon=2', { method: 'POST' })).status, 405);
  assert.equal(service.calls.length, 0);
  const off = make(service, ['quakes']);
  const r = await call(off, '/api/gnss-integrity?lat=1&lon=2');
  assert.equal(r.passed, true, 'flag off: the old adsb.lol proxy is reached');
  assert.equal(service.calls.length, 0);
});

test('gnss: every spelling connect would route to the old proxy is ours while the flag is on', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['gnss']);
  for (const p of [
    '/api/gnss-integrity/?lat=1&lon=1',
    '/API/GNSS-INTEGRITY?lat=1&lon=1',
    '/Api/Gnss-Integrity/?lat=1&lon=1',
  ]) {
    const r = await call(mw, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.passed, false);
  }
  for (const p of ['/api/gnss-integrity/x?lat=1&lon=1', '/api/gnss-integrity.json?lat=1&lon=1'])
    assert.equal((await call(mw, p)).status, 404, p);
  // and with the flag off every one of them is left to the old proxy
  const off = make(service, ['quakes']);
  for (const p of ['/api/gnss-integrity/?lat=1&lon=1', '/API/GNSS-INTEGRITY?lat=1&lon=1'])
    assert.equal((await call(off, p)).passed, true, p);
});

test('a request target that does not parse goes to the next middleware, no unhandled rejection', async (t) => {
  closeNetwork(t);
  const mw = make(fakeService(), ['gnss', 'quakes', 'aqhi']);
  for (const url of ['//', 'http://[bad', '///x']) {
    const r = await call(mw, url);
    assert.equal(r.passed, true, url);
  }
});

test('gnss: one ES read serves every tab inside the TTL, a new read after it', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  let now = NOW;
  const mw = make(service, ['gnss'], { now: () => now });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => call(mw, `/api/gnss-integrity?lat=${i}&lon=${i}`)),
  );
  assert.equal(service.calls.length, 1);
  const again = await call(mw, '/api/gnss-integrity?lat=3&lon=3');
  assert.equal(service.calls.length, 1);
  now += 31_000;
  const later = await call(mw, '/api/gnss-integrity?lat=3&lon=3');
  assert.equal(service.calls.length, 2);
  assert.equal(json(later).ageMs, 4 * 60_000 + 31_000);
  assert.equal(json(again).ageMs, 4 * 60_000);
});

test('gnss: ES failure serves the last good copy marked stale, then 503 past the limit', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  let now = NOW;
  const mw = make(service, ['gnss'], { now: () => now });
  assert.equal((await call(mw, '/api/gnss-integrity?lat=1&lon=1')).status, 200);
  service.slice = async () => {
    throw new Error('es down');
  };
  now += 60_000;
  const stale = await call(mw, '/api/gnss-integrity?lat=1&lon=1');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-data-stale'], 'true');
  assert.equal(json(stale).stale, true);
  now += STALE_LIMIT_MS;
  const gone = await call(mw, '/api/gnss-integrity?lat=1&lon=1');
  assert.equal(gone.status, 503);
  assert.equal(gone.headers['retry-after'], '30');
});

test('gnss: a stand-in copy is never older than 15 min counted from its snapshot, not from the read', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  let now = NOW; // the snapshot is already 4 min old when read
  const mw = make(service, ['gnss'], { now: () => now });
  assert.equal((await call(mw, '/api/gnss-integrity?lat=1&lon=1')).status, 200);
  service.slice = async () => {
    throw new Error('es down');
  };
  now += 10 * 60_000; // read 10 min ago (< 15) but snapshot 14 min old: still ok
  assert.equal((await call(mw, '/api/gnss-integrity?lat=1&lon=1')).headers['x-data-stale'], 'true');
  now += 2 * 60_000; // read 12 min ago, snapshot 16 min old: past the limit
  assert.equal((await call(mw, '/api/gnss-integrity?lat=1&lon=1')).status, 503);
});

test('gnss: no snapshot in the last 15 min is "unavailable", not an empty sky', async (t) => {
  closeNetwork(t);
  const service = fakeService({ gnss: { body: { snap: null, cells: [] }, headers: {} } });
  assert.equal((await call(make(service, ['gnss']), '/api/gnss-integrity?lat=1&lon=1')).status, 503);
});

test('quakes: the USGS summary body, parsed by the unchanged layer normalizer', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['quakes']);
  const r = await call(mw, '/api/es-live/earthquakes');
  assert.equal(r.status, 200);
  const rows = normalizeEarthquakeSnapshot(json(r));
  assert.ok(Array.isArray(rows) && rows.length > 0);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].feed, 'quakes');
  assert.equal(service.calls[0].t, NOW);
});

test('aqhi: observations (6 h) and stations (30 days) parse with the unchanged ECCC normalizers', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['aqhi']);
  const stationsRes = await call(mw, '/api/es-live/aqhi-stations');
  const obsRes = await call(mw, '/api/es-live/aqhi');
  assert.equal(stationsRes.status, 200);
  assert.equal(obsRes.status, 200);
  assert.equal(service.calls.length, 2);
  assert.deepEqual(service.calls.map((c) => c.windowMs).sort((a, b) => a - b), [6 * 3_600_000, STATION_WINDOW_MS]);
  const stations = normalizeAqhiStations(json(stationsRes));
  assert.equal(stations.get('AADCE').name, 'Burin');
  // a station that has not reported for a day is still in the catalog, so it
  // is placed the moment it reports again (the browser keeps a catalog 12 h)
  assert.equal(stations.get('QUIET').name, 'Quiet Station');
  const readings = normalizeAqhiObservations(json(obsRes), stations, NOW);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].stationId, 'AADCE');
  assert.equal(readings[0].value, 2);
});

test('es-live routes: unknown or disabled routes are 404 in any spelling, never a fall-through', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  const mw = make(service, ['quakes']);
  for (const p of ['/api/es-live/nope', '/api/es-live/aqhi', '/API/ES-LIVE/AQHI-stations', '/api/es-live'])
    assert.equal((await call(mw, p)).status, 404, p);
  assert.equal((await call(mw, '/API/ES-LIVE/Earthquakes/')).status, 200);
  assert.equal((await call(mw, '/api/es-live/earthquakes', { method: 'POST' })).status, 405);
  assert.equal((await call(mw, '/api/other')).passed, true);
});

test('a null service (ES not configured) never reaches an upstream', async (t) => {
  closeNetwork(t);
  const mw = make(null, ['gnss', 'quakes', 'aqhi']);
  for (const p of ['/api/gnss-integrity?lat=1&lon=1', '/api/es-live/earthquakes', '/api/es-live/aqhi'])
    assert.equal((await call(mw, p)).status, 503);
});

test('a "not recorded" ES answer is unavailable, not an empty feed', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  service.slice = async () => ({ status: 404, body: { error: 'not_recorded' }, headers: {} });
  assert.equal((await call(make(service, ['quakes']), '/api/es-live/earthquakes')).status, 503);
});

test('an explained-empty or gap answer is no data, and never replaces the last good copy', async (t) => {
  closeNetwork(t);
  for (const marker of ['X-History-Empty-Reason', 'X-History-Gap']) {
    const empty = { body: { type: 'FeatureCollection', features: [] }, headers: { [marker]: '1' } };
    for (const [feed, path] of [['quakes', '/api/es-live/earthquakes'], ['aqhi', '/api/es-live/aqhi'], ['aqhi', '/api/es-live/aqhi-stations']]) {
      const service = fakeService({ [feed]: empty });
      assert.equal((await call(make(service, [feed]), path)).status, 503, `${marker} ${path}`);
    }
  }
  // after a good answer, a later empty-with-marker answer is served as the stale good copy
  const service = fakeService();
  let now = NOW;
  const mw = make(service, ['quakes'], { now: () => now });
  assert.equal((await call(mw, '/api/es-live/earthquakes')).status, 200);
  service.slice = async () => ({ body: { type: 'FeatureCollection', features: [] }, headers: { 'X-History-Empty-Reason': 'before_recording_start' } });
  now += 40_000;
  const r = await call(mw, '/api/es-live/earthquakes');
  assert.equal(r.headers['x-data-stale'], 'true');
  assert.ok(json(r).features.length > 0);
});

test('a genuinely quiet day (zero quakes, no marker, fresh recording) is a real empty answer', async (t) => {
  closeNetwork(t);
  const service = fakeService({ quakes: { body: { type: 'FeatureCollection', features: [] }, headers: {} } });
  const r = await call(make(service, ['quakes']), '/api/es-live/earthquakes');
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).features, []);
});

test('a stalled collector: quakes and AQHI older than their limit are unavailable, not "fresh"', async (t) => {
  closeNetwork(t);
  for (const [feed, path] of [['quakes', '/api/es-live/earthquakes'], ['aqhi', '/api/es-live/aqhi'], ['aqhi', '/api/es-live/aqhi-stations']]) {
    const old = make(fakeService(), [feed], { freshness: async () => NOW - FRESH_LIMIT_MS[feed] - 1 });
    assert.equal((await call(old, path)).status, 503, `${path} stalled`);
    const edge = make(fakeService(), [feed], { freshness: async () => NOW - FRESH_LIMIT_MS[feed] });
    assert.equal((await call(edge, path)).status, 200, `${path} at the limit`);
    const none = make(fakeService(), [feed], { freshness: async () => null });
    assert.equal((await call(none, path)).status, 503, `${path} no snapshot at all`);
  }
});

test('a stalled collector turns a cached good copy stale once its snapshot passes the limit', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  let now = NOW;
  const snap = NOW - 60_000;
  const mw = make(service, ['quakes'], { now: () => now, freshness: async () => snap });
  assert.equal((await call(mw, '/api/es-live/earthquakes')).status, 200);
  now = snap + FRESH_LIMIT_MS.quakes + 1; // cache TTL long gone, snapshot too old
  assert.equal((await call(mw, '/api/es-live/earthquakes')).status, 503);
});

test('real slices: an empty quakes stream is unavailable, not an empty feed', async (t) => {
  closeNetwork(t);
  const es = {
    async search() {
      return { aggregations: { first: { value: null } }, hits: { hits: [] } };
    },
    async searchAll() {
      return { hits: [], truncated: false };
    },
  };
  const service = createHistoryService({ es, now: () => NOW });
  const r = await call(make(service, ['quakes']), '/api/es-live/earthquakes');
  assert.equal(r.status, 503);
});

test('an ES outage costs one read per backoff window, not one per tab poll', async (t) => {
  closeNetwork(t);
  const service = fakeService({ fail: true });
  let now = NOW;
  const mw = make(service, ['quakes'], { now: () => now });
  for (let i = 0; i < 20; i++)
    assert.equal((await call(mw, '/api/es-live/earthquakes')).status, 503);
  assert.equal(service.calls.length, 1);
  now += FAIL_BACKOFF_MS + 1;
  assert.equal((await call(mw, '/api/es-live/earthquakes')).status, 503);
  assert.equal(service.calls.length, 2);
});

test('after the outage the next read after the backoff serves fresh data again', async (t) => {
  closeNetwork(t);
  const service = fakeService();
  let now = NOW;
  const mw = make(service, ['quakes'], { now: () => now });
  assert.equal((await call(mw, '/api/es-live/earthquakes')).status, 200);
  const slice = service.slice.bind(service);
  service.slice = async () => {
    throw new Error('down');
  };
  now += 40_000;
  assert.equal((await call(mw, '/api/es-live/earthquakes')).headers['x-data-stale'], 'true');
  service.slice = slice;
  now += FAIL_BACKOFF_MS + 1;
  const ok = await call(mw, '/api/es-live/earthquakes');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-data-stale'], undefined);
});

test('failures are logged once a minute with a fixed reason, never the error text', async (t) => {
  closeNetwork(t);
  const lines = [];
  const SECRET = 'Bearer synthetic-secret-123456 https://user:pass@es.example.test/?api_key=abcdef';
  const service = fakeService();
  service.slice = async () => {
    throw new Error(SECRET);
  };
  let now = NOW;
  const mw = make(service, ['quakes', 'aqhi'], { now: () => now, log: (l) => lines.push(l) });
  await call(mw, '/api/es-live/earthquakes');
  await call(mw, '/api/es-live/earthquakes');
  await call(mw, '/api/es-live/aqhi');
  assert.equal(lines.length, 2, 'one line a minute per feed, a failing feed never hides another');
  assert.match(lines[0], /^\[es-live\] quakes unavailable: Error$/);
  assert.match(lines[1], /^\[es-live\] aqhi unavailable: Error$/);
  now += 61_000;
  await call(mw, '/api/es-live/aqhi');
  assert.equal(lines.length, 3);
  assert.ok(!lines.join('\n').includes('synthetic-secret'));
  assert.ok(!lines.join('\n').includes('pass@'));
  // a history-store error carries its own short reason
  service.slice = async () => {
    const e = new Error('history_unavailable');
    e.reason = 'es_timeout';
    throw e;
  };
  now += 61_000;
  await call(mw, '/api/es-live/earthquakes');
  assert.match(lines.at(-1), /quakes unavailable: es_timeout$/);
});

test('the cell expansion is the time-travel adapter expansion, row for row', () => {
  const cells = [
    { cell: '1:2', lat: 1.25, lon: 2.25, total: 5, bad: 2 },
    { cell: '', lat: 3, lon: 4, total: 3, bad: 9 },
    { cell: 'x', lat: 'a', lon: 4, total: 3, bad: 0 },
    { cell: 'y', lat: 1, lon: 1, total: 0, bad: 0 },
    null,
  ];
  assert.deepEqual(expandGnssCells(cells), historyExpand(cells));
  assert.deepEqual(expandGnssCells(cells, 4), historyExpand(cells, 4));
  assert.deepEqual(expandGnssCells(null), []);
});
