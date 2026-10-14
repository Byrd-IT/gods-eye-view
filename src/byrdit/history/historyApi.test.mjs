import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryApi, historyApiEnabled } from './historyApi.js';
import {
  HISTORY_INDICES,
  HistoryUnavailableError,
  createHistoryEsClient,
  esConfigFromEnv,
} from './historyEs.js';
import { MAX_ROWS } from './historyParams.js';
import { historyPlugins } from './index.js';

/**
 * B9 route safeguards (DESIGN 4.3): abuse -> 4xx without touching ES, store
 * errors -> 503 without leaking, reader key only, PIT + search_after paging,
 * two-source aircraft merge and military poll selection end to end against
 * an in-memory fake Elasticsearch.
 */

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const ENV = {
  GEV_HISTORY_ES_URL: 'https://es.example.test',
  GEV_HISTORY_ES_API_KEY: 'reader-key-value',
};
const SECRET_ERROR = 'index [gev-history-military] blew up at node s1 /var/lib';

// ---------------------------------------------------------------- fake ES
function dateOf(v) {
  return typeof v === 'number' ? v : Date.parse(v);
}
function get(doc, field) {
  return field.split('.').reduce((o, k) => o?.[k], doc);
}
function matches(doc, q) {
  if (!q || q.match_all) return true;
  if (q.bool) {
    return (
      (q.bool.filter ?? []).every((f) => matches(doc, f)) &&
      !(q.bool.must_not ?? []).some((f) => matches(doc, f))
    );
  }
  if (q.term) {
    const [[f, v]] = Object.entries(q.term);
    return get(doc, f) === v;
  }
  if (q.terms) {
    const [[f, v]] = Object.entries(q.terms);
    return v.includes(get(doc, f));
  }
  if (q.range) {
    const [[f, r]] = Object.entries(q.range);
    let v = get(doc, f);
    if (v === undefined) return false;
    if (r.format) v = dateOf(v);
    return (
      (r.gte === undefined || v >= r.gte) && (r.lte === undefined || v <= r.lte)
    );
  }
  if (q.geo_bounding_box) {
    const [[f, b]] = Object.entries(q.geo_bounding_box);
    const p = get(doc, f);
    return (
      p &&
      p.lat <= b.top_left.lat &&
      p.lat >= b.bottom_right.lat &&
      p.lon >= b.top_left.lon &&
      p.lon <= b.bottom_right.lon
    );
  }
  if (q.geo_shape) return true;
  throw new Error('fake ES: unsupported query ' + JSON.stringify(q));
}

function createFakeEs(data, { keyName = 'gev-history-reader', fail } = {}) {
  const calls = [];
  const pits = new Map();
  let pitSeq = 0;
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const docsFor = (indexExpr) =>
    indexExpr.split(',').flatMap((name) =>
      Object.entries(data)
        .filter(([k]) =>
          name.endsWith('*') ? k.startsWith(name.slice(0, -1)) : k === name,
        )
        .flatMap(([k, docs]) =>
          docs.map((d, i) => ({ _index: k, _id: `${k}#${i}`, _source: d })),
        ),
    );
  function run(all, body) {
    let hits = all.filter((h) => matches(h._source, body.query));
    for (const s of [...(body.sort ?? [])].reverse()) {
      const [[f, dir]] = Object.entries(s);
      if (f === '_shard_doc') continue;
      hits = [...hits].sort((x, y) => {
        const a = dateOf(get(x._source, f)) ?? 0;
        const b = dateOf(get(y._source, f)) ?? 0;
        return dir === 'desc' ? b - a : a - b;
      });
    }
    return hits.map((h, i) => ({ ...h, sort: [i] }));
  }
  async function fetchImpl(url, init) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init.method,
      path: u.pathname,
      body,
      auth: init.headers.Authorization,
    });
    if (fail) return fail(u, init);
    if (u.pathname === '/_security/_authenticate')
      return reply(200, {
        authentication_type: 'api_key',
        api_key: { name: keyName },
      });
    if (u.pathname.endsWith('/_pit') && init.method === 'POST') {
      const id = `pit-${++pitSeq}`;
      pits.set(id, decodeURIComponent(u.pathname.slice(1, -5)));
      return reply(200, { id });
    }
    if (u.pathname === '/_pit' && init.method === 'DELETE') {
      pits.delete(body.id);
      return reply(200, { succeeded: true });
    }
    if (u.pathname === '/_search') {
      const index = pits.get(body.pit.id);
      const hits = run(docsFor(index), body);
      const from = body.search_after ? body.search_after[0] + 1 : 0;
      return reply(200, {
        pit_id: body.pit.id,
        _shards: { failed: 0 },
        hits: {
          total: { value: hits.length },
          hits: hits.slice(from, from + body.size),
        },
      });
    }
    if (u.pathname.endsWith('/_search')) {
      const index = decodeURIComponent(u.pathname.slice(1, -8));
      const hits = run(docsFor(index), body);
      const out = {
        _shards: { failed: 0 },
        hits: { total: { value: hits.length }, hits: hits.slice(0, body.size) },
      };
      if (body.aggs) out.aggregations = {};
      if (body.aggs?.last)
        out.aggregations.last = {
          value: Math.max(...hits.map((h) => h._source.snap)),
        };
      if (body.aggs?.d) out.aggregations.d = { buckets: [] };
      if (body.aggs?.b) out.aggregations.b = { buckets: [] };
      return reply(200, out);
    }
    return reply(404, { error: 'fake: no route' });
  }
  return { fetchImpl, calls, pits };
}

// ------------------------------------------------------------- harness
async function call(
  api,
  path,
  { method = 'GET', host = 'localhost', ip = '127.0.0.1' } = {},
) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = String(v);
    },
    end(b) {
      this.body = b ?? '';
      this.resolve();
    },
  };
  const done = new Promise((r) => (res.resolve = r));
  let nexted = false;
  api(
    { url: path, method, headers: { host }, socket: { remoteAddress: ip } },
    res,
    () => {
      nexted = true;
      res.resolve();
    },
  );
  await done;
  return {
    status: nexted ? 'next' : res.statusCode,
    headers: res.headers,
    body: res.body,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

function makeApi(data = {}, opts = {}) {
  const fake = createFakeEs(data, opts.fake);
  const api = createHistoryApi({
    env: opts.env ?? ENV,
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    log: () => {},
    allow: opts.allow ?? (() => true),
    ...(opts.isAllowedHost ? { isAllowedHost: opts.isAllowedHost } : {}),
  });
  return { api, fake };
}

// ------------------------------------------------------------- abuse
const T = iso(NOW - 3_600_000);
const ABUSE = [
  [
    'huge bbox (out of range)',
    `/api/history/slice?feed=aircraft&t=${T}&bbox=-1000,-90,1000,90`,
    400,
  ],
  [
    'bbox lat > 90',
    `/api/history/slice?feed=aircraft&t=${T}&bbox=-10,-95,10,95`,
    400,
  ],
  [
    'bbox inverted',
    `/api/history/slice?feed=aircraft&t=${T}&bbox=10,0,-10,5`,
    400,
  ],
  ['bbox 3 parts', `/api/history/slice?feed=aircraft&t=${T}&bbox=1,2,3`, 400],
  [
    'bbox exponent',
    `/api/history/slice?feed=aircraft&t=${T}&bbox=1e2,0,2,1`,
    400,
  ],
  [
    'maxRows above cap',
    `/api/history/slice?feed=aircraft&t=${T}&maxRows=${MAX_ROWS + 1}`,
    413,
  ],
  [
    'maxRows huge',
    `/api/history/slice?feed=aircraft&t=${T}&maxRows=99999999999`,
    400,
  ],
  ['maxRows zero', `/api/history/slice?feed=aircraft&t=${T}&maxRows=0`, 400],
  [
    'maxRows negative',
    `/api/history/slice?feed=aircraft&t=${T}&maxRows=-5`,
    400,
  ],
  [
    't outside retention',
    `/api/history/slice?feed=aircraft&t=2023-01-01T00:00:00Z`,
    400,
  ],
  [
    't in the future',
    `/api/history/slice?feed=aircraft&t=${iso(NOW + 3_600_000)}`,
    400,
  ],
  ['t natural language', `/api/history/slice?feed=aircraft&t=yesterday`, 400],
  ['t date only', `/api/history/slice?feed=aircraft&t=2026-10-13`, 400],
  ['t missing', `/api/history/slice?feed=aircraft`, 400],
  [
    'window on aircraft',
    `/api/history/slice?feed=aircraft&t=${T}&window=1d`,
    400,
  ],
  [
    'window above cap',
    `/api/history/slice?feed=launches&t=${T}&window=365d`,
    413,
  ],
  [
    'window malformed',
    `/api/history/slice?feed=cyclones&t=${T}&window=1y`,
    400,
  ],
  ['unknown feed', `/api/history/slice?feed=satellites&t=${T}`, 404],
  [
    'injected feed',
    `/api/history/slice?feed=military%22%7D%2C%22size%22%3A1e9&t=${T}`,
    404,
  ],
  [
    'bad icao-style id param',
    `/api/history/slice?feed=aircraft&t=${T}&icao24=*`,
    400,
  ],
  [
    'ES query passthrough',
    `/api/history/slice?feed=aircraft&t=${T}&q=*:*`,
    400,
  ],
  [
    'source passthrough',
    `/api/history/slice?feed=aircraft&t=${T}&source={"query":1}`,
    400,
  ],
  [
    'repeated param',
    `/api/history/slice?feed=aircraft&feed=military&t=${T}`,
    400,
  ],
  [
    'over-long query',
    `/api/history/slice?feed=aircraft&t=${T}&bbox=${'1'.repeat(600)}`,
    400,
  ],
  [
    'coverage range too fine',
    `/api/history/coverage?feed=military&from=${iso(NOW - 700 * 86400000)}&to=${iso(NOW)}&bucket=1m`,
    413,
  ],
  [
    'coverage reversed',
    `/api/history/coverage?feed=military&from=${iso(NOW)}&to=${iso(NOW - 1000)}`,
    400,
  ],
  [
    'coverage bad bucket',
    `/api/history/coverage?feed=military&from=${T}&to=${iso(NOW)}&bucket=7s`,
    400,
  ],
  [
    'snapshots n above cap',
    `/api/history/snapshots?feed=military&around=${T}&n=51`,
    413,
  ],
  [
    'snapshots bad n',
    `/api/history/snapshots?feed=military&around=${T}&n=ten`,
    400,
  ],
  ['unknown route', `/api/history/_search`, 404],
  ['path traversal', `/api/history/../../_cat/indices`, 404],
];

for (const [name, path, status] of ABUSE) {
  test(`abuse -> ${status}: ${name} (no ES request)`, async () => {
    const { api, fake } = makeApi();
    const r = await call(api, path);
    assert.equal(r.status, status, r.body);
    assert.ok(r.status >= 400 && r.status < 500);
    assert.equal(fake.calls.length, 0);
    assert.equal(r.headers['cache-control'], 'no-store');
  });
}

test('abuse: non-GET methods -> 405 with Allow', async () => {
  const { api, fake } = makeApi();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await call(api, `/api/history/slice?feed=military&t=${T}`, {
      method,
    });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD');
  }
  assert.equal(fake.calls.length, 0);
});

test('Host allowlist: a foreign Host header -> 403 before anything else', async () => {
  const { api, fake } = makeApi();
  const r = await call(api, `/api/history/slice?feed=military&t=${T}`, {
    host: 'evil.example',
  });
  assert.equal(r.status, 403);
  assert.equal(fake.calls.length, 0);
  const { api: api2 } = makeApi(
    {},
    { isAllowedHost: (h) => h === 'godseyeview.byrd-it.com' },
  );
  assert.equal(
    (await call(api2, '/api/history/x', { host: 'godseyeview.byrd-it.com' }))
      .status,
    404,
  );
  assert.equal(
    (await call(api2, '/api/history/x', { host: 'localhost' })).status,
    403,
  );
});

test('per-client rate limit -> 429 Retry-After', async () => {
  let n = 0;
  const { api } = makeApi({}, { allow: () => ++n <= 2 });
  const path = `/api/history/slice?feed=nope&t=${T}`;
  assert.equal((await call(api, path)).status, 404);
  assert.equal((await call(api, path)).status, 404);
  const r = await call(api, path);
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '60');
});

test('other paths pass through untouched', async () => {
  const { api } = makeApi();
  assert.equal((await call(api, '/api/military')).status, 'next');
  assert.equal((await call(api, '/api/historyx')).status, 'next');
});

// ------------------------------------------------------- 503 / key
test('store errors -> 503 history_unavailable, ES text never leaks', async () => {
  for (const fail of [
    () => {
      throw new TypeError('fetch failed ECONNREFUSED 10.10.99.106:9200');
    },
    () => new Response(SECRET_ERROR, { status: 500 }),
    () => new Response('{not json', { status: 200 }),
  ]) {
    const { api } = makeApi({}, { fake: { fail } });
    const r = await call(api, `/api/history/slice?feed=military&t=${T}`);
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: 'history_unavailable' });
    assert.ok(!r.body.includes('gev-history') && !r.body.includes('10.10'));
  }
});

test('reader key only: any other API key (e.g. the collector key) -> 503, no search', async () => {
  const { api, fake } = makeApi(
    {},
    { fake: { keyName: 'gev-history-collector' } },
  );
  const r = await call(api, `/api/history/slice?feed=military&t=${T}`);
  assert.equal(r.status, 503);
  assert.deepEqual(
    fake.calls.map((c) => c.path),
    ['/_security/_authenticate'],
  );
});

test('not configured: GEV_HISTORY_API on but no reader key -> 503 (params still validated)', async () => {
  const { api, fake } = makeApi({}, { env: {} });
  assert.equal(
    (await call(api, `/api/history/slice?feed=military&t=${T}`)).status,
    503,
  );
  assert.equal(
    (await call(api, `/api/history/slice?feed=military&t=nope`)).status,
    400,
  );
  assert.equal(fake.calls.length, 0);
});

test('env config: only plain http(s) URLs; key never part of the URL', () => {
  assert.equal(esConfigFromEnv({}), null);
  assert.equal(
    esConfigFromEnv({
      GEV_HISTORY_ES_URL: 'https://u:p@es',
      GEV_HISTORY_ES_API_KEY: 'k',
    }),
    null,
  );
  assert.equal(
    esConfigFromEnv({
      GEV_HISTORY_ES_URL: 'file:///etc',
      GEV_HISTORY_ES_API_KEY: 'k',
    }),
    null,
  );
  const c = esConfigFromEnv({
    ...ENV,
    GEV_HISTORY_ES_URL: 'https://es.example.test/',
  });
  assert.equal(c.url, 'https://es.example.test');
  assert.equal(c.readerKeyName, 'gev-history-reader');
  assert.ok(historyApiEnabled({ GEV_HISTORY_API: '1' }));
  assert.ok(!historyApiEnabled({ GEV_HISTORY_API: 'true' }));
});

test('ES client: PIT + search_after pages, PIT closed, only allowlisted indices', async () => {
  const docs = Array.from({ length: 7 }, (_, i) => ({ snap: 5, n: i }));
  const fake = createFakeEs({ 'gev-history-military': docs });
  const es = createHistoryEsClient({
    url: 'https://es',
    apiKey: 'k',
    fetchImpl: fake.fetchImpl,
  });
  const all = await es.searchAll(HISTORY_INDICES.military, {
    query: { term: { snap: 5 } },
    maxRows: 100,
    pageSize: 3,
  });
  assert.equal(all.hits.length, 7);
  assert.equal(all.pages, 3);
  assert.equal(all.truncated, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(fake.pits.size, 0, 'PIT closed');
  const pages = fake.calls.filter((c) => c.path === '/_search');
  assert.deepEqual(
    pages.map((p) => p.body.search_after ?? null),
    [null, [2], [5]],
  );
  assert.ok(pages.every((p) => p.body.sort.at(-1)._shard_doc === 'asc'));
  assert.ok(fake.calls.every((c) => c.auth === 'ApiKey k'));
  const capped = await es.searchAll(HISTORY_INDICES.military, {
    query: { match_all: {} },
    maxRows: 4,
    pageSize: 3,
  });
  assert.equal(capped.hits.length, 4);
  assert.equal(capped.truncated, true);
  await assert.rejects(es.search('gev-history-*', {}), HistoryUnavailableError);
  await assert.rejects(es.search('hermes-kb', {}), HistoryUnavailableError);
});

test('ES client: shard failures or timeouts are failures, not partial answers', async () => {
  const fake = createFakeEs(
    {},
    {
      fail: (u) =>
        u.pathname === '/_security/_authenticate'
          ? Response.json({
              authentication_type: 'api_key',
              api_key: { name: 'gev-history-reader' },
            })
          : Response.json({
              timed_out: false,
              _shards: { failed: 1 },
              hits: { hits: [] },
            }),
    },
  );
  const es = createHistoryEsClient({
    url: 'https://es',
    apiKey: 'k',
    fetchImpl: fake.fetchImpl,
  });
  await assert.rejects(
    es.search(HISTORY_INDICES.military, {}),
    (e) => e.reason === 'es_partial',
  );
});

test('busy: more than MAX_IN_FLIGHT concurrent store requests -> 429', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fake = createFakeEs({});
  const slow = async (url, init) => {
    await gate;
    return fake.fetchImpl(url, init);
  };
  const api = createHistoryApi({
    env: ENV,
    fetchImpl: slow,
    now: () => NOW,
    log: () => {},
    allow: () => true,
  });
  const path = `/api/history/snapshots?feed=military&around=${T}`;
  const pending = Array.from({ length: 4 }, () => call(api, path));
  await new Promise((r) => setImmediate(r));
  const fifth = await call(api, path);
  assert.equal(fifth.status, 429);
  assert.deepEqual(fifth.json, { error: 'busy' });
  release();
  for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
});

// ------------------------------------------------------- end to end
const S = NOW - 3_600_000; // military poll snap
const militaryData = {
  'gev-history-ingest-log': [
    {
      feed: 'military',
      kind: 'poll',
      ok: true,
      snap: S - 60_000,
      '@timestamp': iso(S - 60_000),
    },
    { feed: 'military', kind: 'poll', ok: true, snap: S, '@timestamp': iso(S) },
    {
      feed: 'military',
      kind: 'poll',
      ok: false,
      '@timestamp': iso(S + 60_000),
    },
  ],
  'gev-history-military': [
    {
      '@timestamp': iso(S - 2_000),
      snap: S,
      hex: 'ae0001',
      location: { lat: 30, lon: -97 },
      callsign: 'RCH1',
      db_flags: 1,
      baro_alt_m: 3048,
      source: 'adsb.lol',
    },
    {
      '@timestamp': iso(S - 100_000),
      snap: S - 60_000,
      hex: 'ae0002',
      location: { lat: 31, lon: -98 },
      on_ground: true,
      source: 'adsb.lol',
    },
    {
      '@timestamp': iso(S - 200_000),
      snap: S - 60_000,
      hex: 'ae0003',
      location: { lat: 31, lon: -98 },
      source: 'adsb.lol',
    },
    {
      '@timestamp': iso(S - 62_000),
      snap: S - 60_000,
      hex: 'ae0001',
      location: { lat: 29, lon: -96 },
      source: 'adsb.lol',
    },
  ],
};

test('military slice: poll at t + stale union, readsb envelope, headers', async () => {
  const { api } = makeApi(militaryData);
  const r = await call(
    api,
    `/api/history/slice?feed=military&t=${iso(S + 30_000)}`,
  );
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers['x-history-snap'], String(S));
  assert.equal(r.headers['x-history-source'], 'adsb.lol');
  assert.equal(r.json.now, S);
  const hexes = r.json.ac.map((a) => a.hex).sort();
  assert.deepEqual(hexes, ['ae0001', 'ae0002']); // ae0003: position > 180 s old
  const ae1 = r.json.ac.find((a) => a.hex === 'ae0001');
  assert.equal(ae1.lat, 30); // the poll at S, not the older sample
  assert.equal(ae1.alt_baro, 10000);
  assert.equal(r.json.ac.find((a) => a.hex === 'ae0002').alt_baro, 'ground');
  // bbox filter applies to both queries
  const box = await call(
    api,
    `/api/history/slice?feed=military&t=${iso(S + 30_000)}&bbox=-97.5,29.5,-96.5,30.5`,
  );
  assert.deepEqual(
    box.json.ac.map((a) => a.hex),
    ['ae0001'],
  );
});

test('military slice: recording gap -> adsb.lol archive rows with dbFlags & 1', async () => {
  const t = Date.UTC(2025, 6, 15, 15, 0, 30);
  const bucket = Date.UTC(2025, 6, 15, 15, 0) / 1000;
  const { api } = makeApi({
    ...militaryData,
    'gev-history-aircraft-adsblol-hist': [
      {
        '@timestamp': bucket * 1000 - 5_000,
        snap: bucket,
        icao24: 'ae1234',
        db_flags: 1,
        location: { lat: 1, lon: 2 },
        source: 'adsblol',
      },
      {
        '@timestamp': bucket * 1000 - 5_000,
        snap: bucket,
        icao24: 'a00001',
        db_flags: 0,
        location: { lat: 1, lon: 2 },
        source: 'adsblol',
      },
      {
        '@timestamp': bucket * 1000 - 5_000,
        snap: bucket,
        icao24: 'ae9999',
        db_flags: 9,
        location: { lat: 1, lon: 2 },
        source: 'adsblol',
      },
    ],
  });
  const r = await call(api, `/api/history/slice?feed=military&t=${iso(t)}`);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers['x-history-fallback'], 'adsblol-dbflags');
  assert.equal(r.headers['x-history-source'], 'adsblol');
  assert.deepEqual(r.json.ac.map((a) => a.hex).sort(), ['ae1234', 'ae9999']);
  assert.ok(r.json.ac.every((a) => a.source === 'adsblol'));
});

test('aircraft slice: two sources merged per icao24, X-History-Source lists both', async () => {
  const t = Date.UTC(2026, 9, 13, 19, 46, 40);
  const bucket = Date.UTC(2026, 9, 13, 19, 46) / 1000;
  const poll = t - 8_000;
  const { api } = makeApi({
    'gev-history-ingest-log': [
      {
        feed: 'aircraft-opensky',
        kind: 'poll',
        ok: true,
        snap: poll,
        '@timestamp': iso(poll),
        message: JSON.stringify({
          tile_bbox: [-100, 20, -80, 35],
          cadence_ms: 68_211,
        }),
      },
      {
        feed: 'aircraft-opensky',
        kind: 'poll',
        ok: true,
        snap: poll,
        '@timestamp': iso(poll),
        message: JSON.stringify({
          tile_bbox: [100, -10, 130, 20],
          cadence_ms: 90_000,
        }),
      },
    ],
    'gev-history-aircraft-adsblol': [
      {
        '@timestamp': bucket * 1000 - 3_000,
        snap: bucket,
        icao24: 'a1',
        location: { lat: 30, lon: -97 },
        category: 'A3',
        source: 'adsblol',
      },
      {
        '@timestamp': bucket * 1000 - 3_000,
        snap: bucket,
        icao24: 'a2',
        location: { lat: 30, lon: -97 },
        source: 'adsblol',
      },
      {
        '@timestamp': bucket * 1000 - 1_000,
        snap: bucket,
        icao24: 'a3',
        location: { lat: 60, lon: 10 },
        source: 'adsblol',
      },
    ],
    'gev-history-aircraft-opensky': [
      // a1: opensky 2 s newer than adsb.lol -> opensky
      {
        '@timestamp': bucket * 1000 - 1_000,
        snap: poll,
        icao24: 'a1',
        location: { lat: 30.1, lon: -97 },
        category: '4',
        source: 'opensky',
      },
      // a2: opensky 60 s older -> adsb.lol wins
      {
        '@timestamp': bucket * 1000 - 63_000,
        snap: poll - 70_000,
        icao24: 'a2',
        location: { lat: 30, lon: -97.2 },
        source: 'opensky',
      },
      // a4: only opensky (unchanged position: stale union from an earlier poll)
      {
        '@timestamp': t - 100_000,
        snap: poll - 70_000,
        icao24: 'a4',
        location: { lat: 25, lon: -90 },
        source: 'opensky',
      },
      // after t: never shown
      {
        '@timestamp': t + 1_000,
        snap: t + 1_000,
        icao24: 'a5',
        location: { lat: 25, lon: -90 },
        source: 'opensky',
      },
    ],
  });
  const r = await call(
    api,
    `/api/history/slice?feed=aircraft&t=${iso(t)}&bbox=-100,20,-80,35`,
  );
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers['x-history-source'], 'adsblol,opensky');
  assert.equal(r.headers['x-history-opensky-tiles'], '1');
  assert.equal(r.json.time, Math.round(t / 1000));
  const by = Object.fromEntries(r.json.states.map((s) => [s[0], s]));
  assert.deepEqual(Object.keys(by).sort(), ['a1', 'a2', 'a4']);
  assert.equal(by.a1[18], 'opensky');
  assert.equal(by.a1[6], 30.1);
  assert.equal(by.a2[18], 'adsblol');
  assert.equal(by.a4[18], 'opensky');
  assert.equal(by.a1[17], 4);
  // no opensky poll near t -> adsb.lol only
  const later = await call(
    api,
    `/api/history/slice?feed=aircraft&t=${iso(t + 600_000)}`,
  );
  assert.equal(later.headers['x-history-opensky-tiles'], '0');
});

test('snapshots: nearest recorded polls around t from the ingest-log', async () => {
  const { api } = makeApi(militaryData);
  const r = await call(
    api,
    `/api/history/snapshots?feed=military&around=${iso(S - 10_000)}&n=2`,
  );
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(
    r.json.snaps.map((s) => s.epochMs),
    [S - 60_000, S],
  );
  assert.ok(r.json.snaps.every((s) => s.source === 'collector'));
});

test('every ES request targets an allowlisted index or the PIT/auth endpoints', async () => {
  const { api, fake } = makeApi(militaryData);
  await call(api, `/api/history/slice?feed=military&t=${iso(S)}`);
  await call(api, `/api/history/slice?feed=aircraft&t=${iso(S)}`);
  await call(api, `/api/history/slice?feed=firms&t=${iso(S)}`);
  await call(api, `/api/history/slice?feed=fire-perimeters&t=${iso(S)}`);
  await call(api, `/api/history/slice?feed=cyclones&t=${iso(S)}`);
  await call(api, `/api/history/slice?feed=launches&t=${iso(S)}`);
  await call(
    api,
    `/api/history/coverage?feed=aircraft&from=${iso(S - 86400000)}&to=${iso(S)}`,
  );
  await call(api, `/api/history/snapshots?feed=aircraft&around=${iso(S)}`);
  const allowed = new Set(Object.values(HISTORY_INDICES));
  for (const c of fake.calls) {
    const p = decodeURIComponent(c.path);
    if (['/_security/_authenticate', '/_search', '/_pit'].includes(p)) continue;
    const index = p.slice(1).replace(/\/(_search|_pit)$/, '');
    assert.ok(allowed.has(index), p);
  }
});

test('plugin: GEV_HISTORY_API=1 adds byrdit-history-api after the bridge; off = none', () => {
  assert.deepEqual(historyPlugins({ env: {} }), []);
  assert.deepEqual(
    historyPlugins({ env: { GEV_HISTORY_API: '1' } }).map((p) => p.name),
    ['byrdit-history-api'],
  );
  assert.deepEqual(
    historyPlugins({
      env: { GEV_HISTORY_API: '1', GEV_BRIDGE_MILITARY: '1' },
    }).map((p) => p.name),
    ['byrdit-history-bridge', 'byrdit-history-api'],
  );
});
