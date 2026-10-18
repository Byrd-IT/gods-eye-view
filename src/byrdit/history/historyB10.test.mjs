import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryApi } from './historyApi.js';
import { compareKeys, latestPerKey, splitAtKeys } from './historyCollapse.js';
import { createHistoryCache, bodyEtag, etagMatches } from './historyCache.js';
import { feedHealth } from './historyHealth.js';
import {
  mergeTrackPoints,
  sampleIntervalMs,
  thinTrack,
  TRACK_READ_MAX,
} from './historyTrack.js';
import { MAX_TRACK_POINTS } from './historyParams.js';
import { normalizeAircraftTrack } from '../../sources/live/aircraft.js';

/**
 * B10 (gev-history DESIGN 4.3, 4.4; card t_7d16a765): vessels / transit /
 * bike share slices, /track, the ETag + LRU cache, /health and the
 * collapse partitioning, against an in-memory Elasticsearch that enforces
 * the two real restrictions the design meets (measured on the live cluster):
 * a collapse page holds at most `maxWindow` groups, and collapse +
 * search_after is refused.
 */

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const ENV = {
  GEV_HISTORY_ES_URL: 'https://es.example.test',
  GEV_HISTORY_ES_API_KEY: 'reader-key-value',
  GEV_COLLECTOR_URLS: 'http://s4.test:4180,http://s5.test:4180',
};

// ---------------------------------------------------------------- fake ES
const get = (doc, field) => field.split('.').reduce((o, k) => o?.[k], doc);
const dateOf = (v) => (typeof v === 'number' ? v : Date.parse(v));

/** Lucene geo_point round trip (GeoEncodingUtils), as doc values return it. */
const LAT_DECODE = 180 / 2 ** 32;
const LON_DECODE = 360 / 2 ** 32;
const geoDv = (p) =>
  `${Math.floor(p.lat / LAT_DECODE) * LAT_DECODE}, ${Math.floor(p.lon / LON_DECODE) * LON_DECODE}`;

function docValuesOf(source, specs) {
  const out = {};
  for (const s of specs) {
    const field = typeof s === 'string' ? s : s.field;
    const format = typeof s === 'string' ? undefined : s.format;
    const v = get(source, field);
    if (v === undefined || v === null) continue;
    let dv;
    if (field === '@timestamp')
      dv =
        format === 'epoch_millis'
          ? String(dateOf(v))
          : new Date(dateOf(v)).toISOString();
    else if (typeof v === 'object' && 'lat' in v) dv = geoDv(v);
    else if (typeof v === 'number' && !Number.isInteger(v)) dv = Math.fround(v);
    else dv = v;
    out[field] = [dv];
  }
  return out;
}

function matches(doc, q, hit) {
  if (!q || q.match_all) return true;
  if (q.bool) {
    const should = q.bool.should ?? [];
    return (
      (q.bool.filter ?? []).every((f) => matches(doc, f, hit)) &&
      !(q.bool.must_not ?? []).some((f) => matches(doc, f, hit)) &&
      (should.length === 0 ||
        should.filter((f) => matches(doc, f, hit)).length >=
          (q.bool.minimum_should_match ?? 1))
    );
  }
  if (q.ids) return q.ids.values.includes(hit?._id);
  if (q.term) {
    const [[f, v]] = Object.entries(q.term);
    return get(doc, f) === v;
  }
  if (q.terms) {
    const [[f, v]] = Object.entries(q.terms);
    return v.includes(get(doc, f));
  }
  if (q.prefix) {
    const [[f, v]] = Object.entries(q.prefix);
    return String(get(doc, f) ?? '').startsWith(v);
  }
  if (q.range) {
    const [[f, r]] = Object.entries(q.range);
    let v = get(doc, f);
    if (v === undefined) return false;
    if (r.format) v = dateOf(v);
    return (
      (r.gte === undefined || v >= r.gte) &&
      (r.lte === undefined || v <= r.lte) &&
      (r.lt === undefined || v < r.lt)
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
  throw new Error('fake ES: unsupported query ' + JSON.stringify(q));
}

function createFakeEs(data, { maxWindow = 10_000, fail } = {}) {
  const calls = [];
  const pits = new Map();
  let pitSeq = 0;
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const docsFor = (expr) =>
    expr.split(',').flatMap((name) =>
      Object.entries(data)
        .filter(([k]) =>
          name.endsWith('*') ? k.startsWith(name.slice(0, -1)) : k === name,
        )
        .flatMap(([k, docs]) =>
          docs.map((d, i) => ({ _index: k, _id: `${k}#${i}`, _source: d })),
        ),
    );
  function sortHits(hits, sort) {
    for (const s of [...(sort ?? [])].reverse()) {
      const [[f, dir]] = Object.entries(s);
      if (f === '_shard_doc') continue;
      hits = [...hits].sort((x, y) => {
        const a = get(x._source, f);
        const b = get(y._source, f);
        const av = f === '@timestamp' ? dateOf(a) : a;
        const bv = f === '@timestamp' ? dateOf(b) : b;
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === 'desc' ? -c : c;
      });
    }
    return hits;
  }
  function search(all, body) {
    let hits = sortHits(
      all.filter((h) => matches(h._source, body.query, h)),
      body.sort,
    );
    if (body.collapse) {
      if (body.search_after) throw new Error('collapse + search_after');
      if (body.size > maxWindow) throw new Error('result window too large');
      const seen = new Set();
      hits = hits.filter((h) => {
        const k = get(h._source, body.collapse.field);
        if (k === undefined || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const keep = Array.isArray(body._source) ? body._source : null;
    // t_5dc0e0c3: stored_fields '_none_' drops _source; docvalue_fields
    // come back as ES formats them (arrays; geo "lat, lon" from the Lucene
    // encoding; non-integer numbers widened from float32; dates ISO or
    // epoch_millis strings)
    const noStored = body.stored_fields === '_none_';
    const dv = Array.isArray(body.docvalue_fields) ? body.docvalue_fields : null;
    return hits.map((h, i) => ({
      _index: h._index,
      _id: h._id,
      ...(noStored
        ? {}
        : {
            _source: keep
              ? Object.fromEntries(
                  Object.entries(h._source).filter(([k]) => keep.includes(k)),
                )
              : h._source,
          }),
      ...(dv ? { fields: docValuesOf(h._source, dv) } : {}),
      sort: [i],
    }));
  }
  function aggregate(aggs, hits) {
    const out = {};
    for (const [name, spec] of Object.entries(aggs)) {
      if (spec.terms) {
        const counts = new Map();
        for (const h of hits) {
          const k = get(h._source, spec.terms.field);
          if (k !== undefined) counts.set(k, [...(counts.get(k) ?? []), h]);
        }
        out[name] = {
          buckets: [...counts]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, spec.terms.size)
            .map(([key, hs]) => ({
              key,
              doc_count: hs.length,
              ...(spec.aggs ? aggregate(spec.aggs, hs) : {}),
            })),
        };
      } else if (spec.filter) {
        const hs = hits.filter((h) => matches(h._source, spec.filter, h));
        out[name] = {
          doc_count: hs.length,
          ...(spec.aggs ? aggregate(spec.aggs, hs) : {}),
        };
      } else if (spec.date_histogram) {
        // fixed_interval / offset in ms, min_doc_count >= 1 (what /track uses)
        const dh = spec.date_histogram;
        const msOf = (v) => Number(/^(\d+)ms$/.exec(v ?? '0ms')[1]);
        const iv = msOf(dh.fixed_interval);
        const off = msOf(dh.offset);
        const groups = new Map();
        for (const h of hits) {
          const t = dateOf(get(h._source, dh.field));
          const k = Math.floor((t - off) / iv) * iv + off;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(h);
        }
        if (groups.size > 65_536) throw new Error('too_many_buckets');
        out[name] = {
          buckets: [...groups]
            .sort((a, b) => a[0] - b[0])
            .filter(([, hs]) => hs.length >= (dh.min_doc_count ?? 0))
            .map(([key, hs]) => ({
              key,
              doc_count: hs.length,
              ...(spec.aggs ? aggregate(spec.aggs, hs) : {}),
            })),
        };
      } else if (spec.top_hits) {
        const keep = Array.isArray(spec.top_hits._source)
          ? spec.top_hits._source
          : null;
        out[name] = {
          hits: {
            hits: sortHits(hits, spec.top_hits.sort)
              .slice(0, spec.top_hits.size ?? 3)
              .map((h) => ({
                ...h,
                _source: keep
                  ? Object.fromEntries(
                      Object.entries(h._source).filter(([k]) =>
                        keep.includes(k),
                      ),
                    )
                  : h._source,
              })),
          },
        };
      } else if (spec.max) {
        const v = hits.map((h) => get(h._source, spec.max.field));
        out[name] = { value: v.length ? Math.max(...v) : null };
      } else if (spec.sum) {
        out[name] = {
          value: hits.reduce(
            (n, h) => n + (get(h._source, spec.sum.field) ?? 0),
            0,
          ),
        };
      }
    }
    return out;
  }
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init.method ?? 'GET',
      host: u.host,
      path: u.pathname,
      body,
    });
    if (fail) {
      const r = await fail(u, init);
      if (r) return r;
    }
    if (u.host !== 'es.example.test') return reply(404, {});
    if (u.pathname === '/_security/_authenticate')
      return reply(200, {
        authentication_type: 'api_key',
        api_key: { name: 'gev-history-reader' },
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
    try {
      if (u.pathname === '/_search') {
        const hits = search(docsFor(pits.get(body.pit.id)), body);
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
        const all = docsFor(decodeURIComponent(u.pathname.slice(1, -8)));
        const hits = search(all, body);
        const out = {
          _shards: { failed: 0 },
          hits: {
            total: { value: hits.length },
            hits: hits.slice(0, body.size),
          },
        };
        if (body.aggs)
          out.aggregations = aggregate(
            body.aggs,
            all.filter((h) => matches(h._source, body.query, h)),
          );
        return reply(200, out);
      }
    } catch (error) {
      return reply(400, { error: { reason: error.message } });
    }
    return reply(404, { error: 'fake: no route' });
  }
  return { fetchImpl, calls };
}

async function call(api, path, { method = 'GET', headers = {} } = {}) {
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
    {
      url: path,
      method,
      headers: { host: 'localhost', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    },
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
  let clock = opts.now ?? NOW;
  const api = createHistoryApi({
    env: opts.env ?? ENV,
    fetchImpl: fake.fetchImpl,
    now: () => clock,
    log: () => {},
    allow: () => true,
  });
  return { api, fake, setNow: (t) => (clock = t) };
}

const esSearches = (fake) =>
  fake.calls.filter(
    (c) => c.host === 'es.example.test' && c.path.endsWith('_search'),
  );

// ------------------------------------------------- collapse partitioning
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('splitAtKeys: contiguous sub-ranges cut at real keys cover the parent exactly', () => {
  const keys = [
    '211',
    '5',
    '244',
    '2',
    '366',
    '9',
    '211',
    'a',
    '~x',
    'é',
    '\u{1F600}',
  ];
  const parts = splitAtKeys({ lo: '1', hi: null }, keys, 4);
  assert.equal(parts[0].lo, '1');
  assert.equal(parts.at(-1).hi, null);
  for (let i = 1; i < parts.length; i += 1) {
    assert.equal(parts[i].lo, parts[i - 1].hi);
    assert.ok(compareKeys(parts[i - 1].hi, parts[i].hi ?? '\u{10FFFF}') < 0);
  }
  // every cut is a real key above the smallest one: each part misses a key
  const sorted = [...new Set(keys)].sort(compareKeys);
  for (const p of parts.slice(1)) assert.ok(compareKeys(p.lo, sorted[0]) > 0);
  assert.equal(splitAtKeys({ lo: null, hi: null }, ['only']), null);
  // UTF-8 byte order (ES keyword order), not UTF-16: U+FF5E < U+1F600
  assert.ok(compareKeys('\uFF5E', '\u{1F600}') < 0);
  assert.ok('\uFF5E' > '\u{1F600}', 'JS UTF-16 order differs');
});

test('latestPerKey: exact newest per key at any group count (page 7, random keys, any alphabet)', async () => {
  const rnd = seeded(42);
  const docs = [];
  const alphabet = '0123456789AZaz_-~é\u{1F600}';
  for (let i = 0; i < 900; i += 1) {
    const len = 1 + Math.floor(rnd() * 4);
    let key = '';
    const chars = [...alphabet];
    for (let j = 0; j < len; j += 1)
      key += chars[Math.floor(rnd() * chars.length)];
    docs.push({
      k: key,
      '@timestamp': NOW - Math.floor(rnd() * 3_600_000),
      n: i,
    });
  }
  const want = new Map();
  for (const d of docs) {
    const prev = want.get(d.k);
    if (!prev || dateOf(d['@timestamp']) > dateOf(prev['@timestamp']))
      want.set(d.k, d);
  }
  const fake = createFakeEs({ 'gev-history-vessels': docs }, { maxWindow: 7 });
  const { createHistoryEsClient } = await import('./historyEs.js');
  const es = createHistoryEsClient({
    url: 'https://es.example.test',
    apiKey: 'k',
    fetchImpl: fake.fetchImpl,
  });
  for (const [fanout, probe, filter] of [
    [2, false, []],
    [8, false, []],
    [8, true, []],
    // probe on a partition that fits one page: the docs are fetched again
    [8, true, [{ term: { k: docs[0].k } }]],
  ]) {
    const r = await latestPerKey(
      es,
      'gev-history-vessels,gev-history-vessels-noaa',
      {
        filter,
        field: 'k',
        pageSize: 7,
        fanout,
        probe,
        maxQueries: 10_000,
      },
    );
    if (filter.length) {
      assert.equal(r.hits.length, 1);
      assert.equal(r.hits[0]._source.n, want.get(docs[0].k).n);
      assert.ok('@timestamp' in r.hits[0]._source, 'full docs, not the probe');
      continue;
    }
    assert.equal(r.truncated, false);
    const got = new Map(r.hits.map((h) => [h._source.k, h._source]));
    assert.equal(got.size, want.size);
    assert.equal(r.hits.length, want.size, 'no key twice');
    for (const [k, d] of want) assert.equal(got.get(k)?.n, d.n, `key ${k}`);
  }
  // a query budget below what the data needs is flagged, never silent
  const capped = await latestPerKey(
    es,
    'gev-history-vessels,gev-history-vessels-noaa',
    {
      filter: [],
      field: 'k',
      pageSize: 7,
      maxQueries: 3,
    },
  );
  assert.equal(capped.truncated, true);
  // collapse requests never carry search_after and never exceed the window
  for (const c of fake.calls.filter((c) => c.body?.collapse)) {
    assert.equal(c.body.search_after, undefined);
    assert.ok(c.body.size <= 7);
    assert.deepEqual(c.body.sort, [{ '@timestamp': 'desc' }]);
  }
});

// ------------------------------------------------------------- vessels
const T = NOW - 3_600_000;
const vesselData = {
  'gev-history-vessels': [
    // 211000001: newest at T-2min (inside box), older at T-20min
    {
      '@timestamp': iso(T - 2 * MIN),
      mmsi: '211000001',
      location: { lat: 54, lon: 8 },
      sog_kn: 12.3,
      cog_deg: 90,
      heading_deg: 91,
      source: 'aisstream',
    },
    {
      '@timestamp': iso(T - 20 * MIN),
      mmsi: '211000001',
      location: { lat: 53.9, lon: 7.8 },
      sog_kn: 12,
      source: 'aisstream',
    },
    // 211000002: sailed OUT of the box 1 min ago (older position inside)
    {
      '@timestamp': iso(T - MIN),
      mmsi: '211000002',
      location: { lat: 60, lon: 20 },
      source: 'aisstream',
    },
    {
      '@timestamp': iso(T - 10 * MIN),
      mmsi: '211000002',
      location: { lat: 54.5, lon: 8.5 },
      source: 'aisstream',
    },
    // 211000003: last seen 40 min ago -> outside the 35 min window
    {
      '@timestamp': iso(T - 40 * MIN),
      mmsi: '211000003',
      location: { lat: 54, lon: 8 },
      source: 'aisstream',
    },
    // 211000004: a report AFTER t only
    {
      '@timestamp': iso(T + MIN),
      mmsi: '211000004',
      location: { lat: 54, lon: 8 },
      source: 'aisstream',
    },
    // AIS sentinels: 102.3 kn / 360 deg are "not available"
    {
      '@timestamp': iso(T - 5 * MIN),
      mmsi: '366000005',
      location: { lat: 30, lon: -90 },
      sog_kn: 102.3,
      cog_deg: 360,
      source: 'aisstream',
    },
  ],
  'gev-history-vessels-noaa': [
    {
      '@timestamp': T - 3 * MIN,
      snap: Math.floor(T / 1000),
      mmsi: '367000006',
      location: { lat: 29, lon: -94 },
      sog_kn: 4,
      cog_deg: 10,
      source: 'noaa-marinecadastre',
    },
  ],
  'gev-history-vessel-static': [
    {
      '@timestamp': iso(T - 3_600_000),
      mmsi: '211000001',
      name: 'OLD NAME',
      ship_type: '70',
    },
    {
      '@timestamp': iso(T - 600_000),
      mmsi: '211000001',
      name: 'NORDIC STAR',
      ship_type: '70',
      imo: '9123456',
      destination: 'HAMBURG',
    },
    {
      '@timestamp': iso(T + 60_000),
      mmsi: '211000001',
      name: 'RENAMED AFTER T',
      ship_type: '70',
    },
  ],
};

const LIVE_VESSEL_KEYS = [
  'lat',
  'lon',
  'name',
  'mmsi',
  'imo',
  'type',
  'destination',
  'speed',
  'course',
  'heading',
  'last_position_UTC',
  'last_position_epoch',
];

test('vessels slice: newest per mmsi within 35 min, live row shape, statics as of t', async () => {
  const { api } = makeApi(vesselData);
  const r = await call(api, `/api/history/slice?feed=vessels&t=${iso(T)}`);
  assert.equal(r.status, 200, r.body);
  const rows = r.json.rows;
  assert.deepEqual(
    rows.map((x) => x.mmsi),
    ['211000002', '211000001', '367000006', '366000005'],
    'newest first; 40-min-old and after-t vessels absent',
  );
  const a = rows.find((x) => x.mmsi === '211000001');
  assert.deepEqual(Object.keys(a), [...LIVE_VESSEL_KEYS, 'source']);
  assert.equal(a.name, 'NORDIC STAR', 'static as of t, not after');
  assert.equal(a.imo, '9123456');
  assert.equal(a.type, '70');
  assert.equal(a.destination, 'HAMBURG');
  assert.equal(a.speed, 12.3);
  assert.equal(a.lat, 54);
  assert.equal(a.last_position_UTC, iso(T - 2 * MIN));
  assert.equal(a.last_position_epoch, Math.floor((T - 2 * MIN) / 1000));
  const nostatic = rows.find((x) => x.mmsi === '366000005');
  assert.equal(nostatic.name, 'MMSI 366000005');
  assert.equal(nostatic.imo, '');
  assert.equal(nostatic.speed, null, '102.3 kn = not available');
  assert.equal(nostatic.course, null, '360 deg = not available');
  assert.equal(
    rows.find((x) => x.mmsi === '367000006').source,
    'noaa-marinecadastre',
  );
  // top-level keys: the live /api/vessels envelope
  for (const k of [
    'rows',
    'source',
    'status',
    'error',
    'refreshing',
    'newestPositionAt',
  ])
    assert.ok(Object.hasOwn(r.json, k), k);
  assert.equal(r.json.refreshing, false);
  assert.equal(r.headers['x-history-source'], 'aisstream,noaa-marinecadastre');
  assert.equal(r.headers['x-history-rows'], '4');
});

test('vessels slice: a vessel that left the bbox is not drawn at its old position', async () => {
  const { api } = makeApi(vesselData);
  const r = await call(
    api,
    `/api/history/slice?feed=vessels&t=${iso(T)}&bbox=5,50,10,56`,
  );
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(
    r.json.rows.map((x) => x.mmsi),
    ['211000001'],
  );
  assert.equal(r.json.rows[0].lat, 54);
});

test('vessels slice: maxRows keeps the newest, flags truncation', async () => {
  const { api } = makeApi(vesselData);
  const r = await call(
    api,
    `/api/history/slice?feed=vessels&t=${iso(T)}&maxRows=2`,
  );
  assert.deepEqual(
    r.json.rows.map((x) => x.mmsi),
    ['211000002', '211000001'],
  );
  assert.equal(r.headers['x-history-truncated'], '1');
});

// ------------------------------------------------------------- transit
const transitData = {
  'gev-history-transit': [
    {
      '@timestamp': iso(T - 30_000),
      snap: T - 20_000,
      source: 'gtfs-rt',
      feed_id: 'hsl-helsinki',
      vehicle_id: '12/2631',
      location: { lat: 60.2, lon: 24.7 },
      bearing_deg: 257,
      speed_ms: 4.7,
      route_id: '2533',
      direction_id: 1,
      stop_id: '3170224',
      status: 'IN_TRANSIT_TO',
    },
    {
      '@timestamp': iso(T - 90_000),
      snap: T - 80_000,
      source: 'gtfs-rt',
      feed_id: 'hsl-helsinki',
      vehicle_id: '12/2631',
      location: { lat: 60.1, lon: 24.6 },
    },
    // the SAME vehicle id in another feed is another vehicle
    {
      '@timestamp': iso(T - 60_000),
      snap: T - 50_000,
      source: 'gtfs-rt',
      feed_id: 'mbta',
      vehicle_id: '12/2631',
      location: { lat: 42.3, lon: -71 },
    },
    // older than 3 min: not in the slice
    {
      '@timestamp': iso(T - 4 * MIN),
      snap: T - 4 * MIN,
      source: 'gtfs-rt',
      feed_id: 'mbta',
      vehicle_id: 'y1',
      location: { lat: 42.3, lon: -71 },
    },
  ],
};

test('transit slice: newest per feedId + vehicleId within 3 min, live snapshot shape per feed', async () => {
  const { api } = makeApi(transitData);
  const r = await call(api, `/api/history/slice?feed=transit&t=${iso(T)}`);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(
    r.json.feeds.map((f) => f.feedId),
    ['hsl-helsinki', 'mbta'],
  );
  const hsl = r.json.feeds[0];
  assert.deepEqual(Object.keys(hsl), [
    'feedId',
    'name',
    'fetchedAt',
    'feedTimestamp',
    'version',
    'entityCount',
    'truncated',
    'count',
    'vehicles',
  ]);
  assert.equal(hsl.count, 1);
  assert.deepEqual(hsl.vehicles[0], {
    id: '12/2631',
    lat: 60.2,
    lon: 24.7,
    bearing: 257,
    speedMps: 4.7,
    timestamp: Math.floor((T - 30_000) / 1000),
    routeId: '2533',
    tripId: null,
    directionId: 1,
    label: null,
    stopId: '3170224',
    status: 'IN_TRANSIT_TO',
    occupancy: null,
    timestampSource: 'recorded',
  });
  assert.equal(r.json.feeds[1].vehicles.length, 1, 'mbta y1 is 4 min old');
  assert.equal(r.headers['x-history-rows'], '2');
});

// ------------------------------------------------------------- bike share
const bikeData = {
  'gev-history-bikeshare-stations': [
    {
      '@timestamp': iso(T - 2 * 86_400_000),
      system_id: 'madison-bcycle',
      station_id: 's1',
      name: 'Old Name',
      location: { lat: 43.07, lon: -89.4 },
      capacity: 10,
    },
    {
      '@timestamp': iso(T - 86_400_000),
      system_id: 'madison-bcycle',
      station_id: 's1',
      name: 'Capitol Square',
      location: { lat: 43.07, lon: -89.4 },
      capacity: 12,
    },
    {
      '@timestamp': iso(T - 86_400_000),
      system_id: 'madison-bcycle',
      station_id: 's2',
      name: 'Far Away',
      location: { lat: 10, lon: 10 },
    },
    {
      '@timestamp': iso(T - 86_400_000),
      system_id: 'nyc-citibike',
      station_id: 's1',
      name: 'Same id, other system',
      location: { lat: 40.7, lon: -74 },
    },
  ],
  'gev-history-bikeshare': [
    // change-only: s1 last changed 6 h before t (no doc in [t-15min, t])
    {
      '@timestamp': iso(T - 6 * 3_600_000),
      system_id: 'madison-bcycle',
      station_id: 's1',
      num_bikes_available: 4,
      num_docks_available: 8,
      is_installed: true,
      is_renting: true,
      is_returning: true,
      last_reported: iso(T - 6 * 3_600_000),
    },
    {
      '@timestamp': iso(T - 7 * 3_600_000),
      system_id: 'madison-bcycle',
      station_id: 's1',
      num_bikes_available: 9,
      num_docks_available: 3,
    },
    {
      '@timestamp': iso(T + 60_000),
      system_id: 'madison-bcycle',
      station_id: 's1',
      num_bikes_available: 0,
      num_docks_available: 12,
    },
    {
      '@timestamp': iso(T - MIN),
      system_id: 'nyc-citibike',
      station_id: 's1',
      num_bikes_available: 1,
      num_docks_available: 1,
    },
  ],
};

test('bikeshare slice: change-only station 6 h old still shown (24 h window), GBFS 2.x per system', async () => {
  const { api } = makeApi(bikeData);
  const r = await call(api, `/api/history/slice?feed=bikeshare&t=${iso(T)}`);
  assert.equal(r.status, 200, r.body);
  const mad = r.json.systems.find((s) => s.systemId === 'madison-bcycle');
  assert.deepEqual(Object.keys(mad.station_status), [
    'last_updated',
    'ttl',
    'version',
    'data',
  ]);
  assert.deepEqual(mad.station_information.data.stations[0], {
    station_id: 's1',
    name: 'Capitol Square',
    lat: 43.07,
    lon: -89.4,
    capacity: 12,
  });
  const s1 = mad.station_status.data.stations.find(
    (s) => s.station_id === 's1',
  );
  assert.equal(
    s1.num_bikes_available,
    4,
    'newest change <= t, not the one after t',
  );
  assert.equal(s1.last_reported, Math.floor((T - 6 * 3_600_000) / 1000));
  const nyc = r.json.systems.find((s) => s.systemId === 'nyc-citibike');
  assert.equal(
    nyc.station_status.data.stations[0].num_bikes_available,
    1,
    'systems never mix',
  );
  // 15 min window (the DESIGN's literal rule) would lose s1
  const short = await call(
    api,
    `/api/history/slice?feed=bikeshare&t=${iso(T)}&window=15m`,
  );
  const mad15 = short.json.systems.find((s) => s.systemId === 'madison-bcycle');
  assert.equal(mad15.station_status.data.stations.length, 0);
  // bbox through the as-of station location
  const box = await call(
    api,
    `/api/history/slice?feed=bikeshare&t=${iso(T)}&bbox=-90,43,-89,44`,
  );
  assert.deepEqual(
    box.json.systems.map((s) => s.systemId),
    ['madison-bcycle'],
  );
  assert.deepEqual(
    box.json.systems[0].station_information.data.stations.map(
      (s) => s.station_id,
    ),
    ['s1'],
  );
});

// ------------------------------------------------------------- tracks
const DAY0 = NOW - 86_400_000;
const trackData = {
  'gev-history-aircraft-adsblol': [
    {
      '@timestamp': DAY0 + 60_000,
      snap: (DAY0 + 60_000) / 1000,
      icao24: 'abc123',
      location: { lat: 30, lon: -97 },
      baro_alt_m: 1000,
      track_deg: 90,
      on_ground: false,
      source: 'adsblol',
    },
    {
      '@timestamp': DAY0 + 120_000,
      snap: (DAY0 + 120_000) / 1000,
      icao24: 'abc123',
      location: { lat: 30.1, lon: -97 },
      baro_alt_m: 1100,
      track_deg: 91,
      source: 'adsblol',
    },
    {
      '@timestamp': DAY0 + 180_000,
      snap: (DAY0 + 180_000) / 1000,
      icao24: 'abc123',
      location: { lat: 30.2, lon: -97 },
      baro_alt_m: 1200,
      source: 'adsblol',
    },
    {
      '@timestamp': DAY0 + 60_000,
      snap: (DAY0 + 60_000) / 1000,
      icao24: 'zzz999',
      location: { lat: 1, lon: 1 },
      source: 'adsblol',
    },
  ],
  'gev-history-aircraft-opensky': [
    // 3 s after the 120 s adsb.lol point -> collapses into this one
    {
      '@timestamp': iso(DAY0 + 123_000),
      snap: DAY0 + 123_000,
      icao24: 'abc123',
      location: { lat: 30.11, lon: -97 },
      baro_alt_m: 1110,
      track_deg: 92,
      on_ground: false,
      source: 'opensky',
    },
    // 10 s after the 180 s point -> both kept
    {
      '@timestamp': iso(DAY0 + 190_000),
      snap: DAY0 + 190_000,
      icao24: 'abc123',
      location: { lat: 30.21, lon: -97 },
      source: 'opensky',
    },
  ],
};

test('track: aircraft merges both sources by time, 5 s ties collapse to OpenSky, waypoint shape', async () => {
  const { api } = makeApi(trackData);
  const r = await call(
    api,
    `/api/history/track?feed=aircraft&id=ABC123&from=${iso(DAY0)}&to=${iso(DAY0 + 3_600_000)}`,
  );
  assert.equal(r.status, 200, r.body);
  const b = r.json;
  assert.equal(b.icao24, 'abc123');
  assert.deepEqual(
    b.path.map((p) => [p[0] - DAY0 / 1000, p[6]]),
    [
      [60, 'adsblol'],
      [123, 'opensky'],
      [180, 'adsblol'],
      [190, 'opensky'],
    ],
  );
  assert.deepEqual(b.path[1], [
    (DAY0 + 123_000) / 1000,
    30.11,
    -97,
    1110,
    92,
    false,
    'opensky',
  ]);
  assert.equal(b.startTime, (DAY0 + 60_000) / 1000);
  assert.equal(b.endTime, (DAY0 + 190_000) / 1000);
  assert.deepEqual(b.sources, ['adsblol', 'opensky']);
  assert.equal(r.headers['x-history-source'], 'adsblol,opensky');
  // GEV's own parser reads it unchanged (OpenSky /tracks semantics)
  const parsed = normalizeAircraftTrack(b.path);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[1].observedAtMs, DAY0 + 123_000);
  assert.equal(parsed[1].baroAltitudeM, 1110);
});

test('track: transit ids "<feedId>:<vehicleId>" with a slash, vessels by mmsi', async () => {
  const { api } = makeApi({ ...transitData, ...vesselData });
  const tr = await call(
    api,
    `/api/history/track?feed=transit&id=${encodeURIComponent('hsl-helsinki:12/2631')}&from=${iso(T - 3_600_000)}&to=${iso(T)}`,
  );
  assert.equal(tr.status, 200, tr.body);
  assert.equal(tr.json.path.length, 2);
  assert.equal(tr.json.icao24, null);
  assert.equal(tr.json.path[1][4], 257, 'bearing as trk');
  const ve = await call(
    api,
    `/api/history/track?feed=vessels&id=211000001&from=${iso(T - 3_600_000)}&to=${iso(T)}`,
  );
  assert.equal(ve.json.path.length, 2);
  assert.equal(ve.json.path[1][3], null, 'no altitude for vessels');
  assert.equal(ve.json.path[1][5], null, 'no onGround for vessels');
});

test('track thinning: minGapSec and the 5,000-point cap (first/last kept)', () => {
  const pts = Array.from({ length: 20_000 }, (_, i) => ({
    tMs: i * 1000,
    source: 'x',
  }));
  const capped = thinTrack(pts, 0);
  assert.equal(capped.length, MAX_TRACK_POINTS);
  assert.equal(capped[0].tMs, 0);
  assert.equal(capped.at(-1).tMs, 19_999_000);
  const gapped = thinTrack(pts, 60_000);
  assert.ok(
    gapped.every(
      (p, i) =>
        i === 0 ||
        i === gapped.length - 1 ||
        p.tMs - gapped[i - 1].tMs >= 60_000,
    ),
  );
  assert.equal(gapped.at(-1).tMs, 19_999_000);
  // every adsb.lol point within 5 s of the OpenSky point collapses into it
  // (B10 review R1: 0 and 2,000 are both within 5 s of 4,000, not only the
  // neighbour); a lone adsb.lol point far from OpenSky stays
  const m = mergeTrackPoints([
    { tMs: 0, source: 'adsblol' },
    { tMs: 2_000, source: 'adsblol' },
    { tMs: 4_000, source: 'opensky' },
    { tMs: 6_000, source: 'adsblol' },
    { tMs: 20_000, source: 'adsblol' },
  ]);
  assert.deepEqual(
    m.map((p) => [p.tMs, p.source]),
    [
      [4_000, 'opensky'],
      [20_000, 'adsblol'],
    ],
  );
});

// ------------------------------------------ B10 review R1-R3 regressions
test('R1 merge: adsb.lol clusters on BOTH sides of an OpenSky point collapse into it; 5 s boundary', () => {
  const a = (tMs) => ({ tMs, source: 'adsblol' });
  const o = (tMs) => ({ tMs, source: 'opensky' });
  // the review case: [adsblol@0, adsblol@1000, opensky@4000] -> opensky only
  assert.deepEqual(
    mergeTrackPoints([a(0), a(1_000), o(4_000)]).map((p) => [p.tMs, p.source]),
    [[4_000, 'opensky']],
  );
  const m = mergeTrackPoints([
    a(0), // 4 s before 4,000: dropped
    a(1_000), // dropped
    o(4_000),
    a(7_000), // 3 s after: dropped
    a(8_500), // 4.5 s after: dropped
    a(9_500), // 5.5 s after: kept
    a(20_000),
    a(21_000),
    a(24_999), // 5.001 s before 30,000: kept
    a(25_000), // exactly 5 s: collapses (tie window is inclusive)
    o(30_000),
    o(32_000), // same source as 30,000: never collapsed with it
    a(37_000), // 5 s after 32,000: dropped
    a(37_001), // kept
  ]);
  assert.deepEqual(
    m.map((p) => [p.tMs, p.source]),
    [
      [4_000, 'opensky'],
      [9_500, 'adsblol'],
      [20_000, 'adsblol'],
      [21_000, 'adsblol'],
      [24_999, 'adsblol'],
      [30_000, 'opensky'],
      [32_000, 'opensky'],
      [37_001, 'adsblol'],
    ],
  );
});

test('R1 merge: randomized, equals the brute-force rule (no cross-source pair within 5 s, every OpenSky point kept)', () => {
  const rnd = seeded(10);
  for (let round = 0; round < 50; round += 1) {
    const pts = Array.from({ length: 60 }, () => ({
      tMs: Math.floor(rnd() * 120) * 1_000,
      source: rnd() < 0.3 ? 'opensky' : 'adsblol',
    }));
    const os = pts.filter((p) => p.source === 'opensky');
    const expected = pts
      .filter(
        (p) =>
          p.source === 'opensky' ||
          !os.some((q) => Math.abs(q.tMs - p.tMs) <= 5_000),
      )
      .map((p) => `${p.tMs}:${p.source}`)
      .sort();
    const got = mergeTrackPoints(pts);
    assert.deepEqual(got.map((p) => `${p.tMs}:${p.source}`).sort(), expected);
    for (let i = 1; i < got.length; i += 1)
      assert.ok(got[i].tMs >= got[i - 1].tMs, 'time sorted');
  }
});

test('R1 track: API answer has no adsb.lol point within 5 s of an OpenSky point', async () => {
  const doc = (ms, source) => ({
    '@timestamp': ms,
    snap: Math.floor(ms / 1000),
    icao24: 'cafe01',
    location: { lat: 30 + ms / 1e9, lon: -97 },
    source,
  });
  const base = DAY0 + 600_000;
  const { api } = makeApi({
    'gev-history-aircraft-adsblol': [
      doc(base, 'adsblol'),
      doc(base + 1_000, 'adsblol'),
      doc(base + 8_000, 'adsblol'),
      doc(base + 60_000, 'adsblol'),
    ],
    'gev-history-aircraft-opensky': [doc(base + 4_000, 'opensky')],
  });
  const r = await call(
    api,
    `/api/history/track?feed=aircraft&id=cafe01&from=${iso(DAY0)}&to=${iso(DAY0 + 3_600_000)}`,
  );
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(
    r.json.path.map((p) => [p[0] - base / 1000, p[6]]),
    [
      [4, 'opensky'],
      [60, 'adsblol'],
    ],
  );
});

test('R2 aircraft slice: maxRows keeps the same newest rows whatever order the collapse partitions finish', async () => {
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0); // a 60 s bucket end, days old
  const snapS = T0 / 1000;
  // 10,500 aircraft in one bucket: more than one collapse page (10,000)
  const docs = Array.from({ length: 10_500 }, (_, i) => ({
    '@timestamp': T0 - 1_000 - (i % 50) * 1_000, // ties: 210 per instant
    snap: snapS,
    icao24: (0x100000 + i * 97).toString(16).padStart(6, '0'),
    location: { lat: 30, lon: -97 },
    source: 'adsblol',
  }));
  const expected = [...docs]
    .sort(
      (x, y) =>
        y['@timestamp'] - x['@timestamp'] ||
        (x.icao24 < y.icao24 ? -1 : x.icao24 > y.icao24 ? 1 : 0),
    )
    .slice(0, 50)
    .map((d) => d.icao24);
  const answers = [];
  for (const seed of [1, 2, 3, 4]) {
    const rnd = seeded(seed);
    const { api } = makeApi(
      { 'gev-history-aircraft-adsblol': docs },
      {
        fake: {
          // delay every collapse request by a seeded random amount
          fail: async (u, init) => {
            const body = init.body ? JSON.parse(init.body) : null;
            if (body?.collapse)
              await new Promise((r) => setTimeout(r, Math.floor(rnd() * 25)));
            return null;
          },
        },
      },
    );
    const r = await call(
      api,
      `/api/history/slice?feed=aircraft&t=${iso(T0)}&maxRows=50`,
    );
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['x-history-truncated'], '1');
    answers.push(r.json.states.map((s) => s[0]));
  }
  for (const ids of answers) assert.deepEqual(ids, expected);
});

test('R3 track: a dense range beyond the read cap is sampled end to end (first + last kept, <= 5,000 points, no prefix cut)', async () => {
  const N = 60_000; // > TRACK_READ_MAX (50,000)
  assert.ok(N > TRACK_READ_MAX);
  const STEP = 15_000;
  const from = Date.UTC(2026, 8, 20);
  const to = from + (N - 1) * STEP; // 10.4 days, inside the 31 d cap
  const docs = Array.from({ length: N }, (_, i) => ({
    '@timestamp': from + i * STEP,
    snap: Math.floor((from + i * STEP) / 1000),
    icao24: 'de05e1',
    location: { lat: 30 + i / 1e6, lon: -97 },
    source: 'adsblol',
  }));
  const { api, fake } = makeApi({ 'gev-history-aircraft-adsblol': docs });
  const r = await call(
    api,
    `/api/history/track?feed=aircraft&id=de05e1&from=${iso(from)}&to=${iso(to)}`,
  );
  assert.equal(r.status, 200, r.body);
  const path = r.json.path;
  assert.ok(path.length <= MAX_TRACK_POINTS, `${path.length} points`);
  assert.ok(path.length > 4_000, `${path.length} points`);
  assert.equal(r.json.startTime, from / 1000, 'first point of the range');
  assert.equal(r.json.endTime, to / 1000, 'last point of the range');
  assert.equal(path[0][0], from / 1000);
  assert.equal(path.at(-1)[0], to / 1000);
  // representative: no hole wider than two sampling intervals anywhere
  const ivS = sampleIntervalMs(from, to) / 1000;
  for (let i = 1; i < path.length; i += 1) {
    assert.ok(path[i][0] > path[i - 1][0], 'time ascending');
    assert.ok(
      path[i][0] - path[i - 1][0] <= 2 * ivS + STEP / 1000,
      `gap at ${i}`,
    );
  }
  // the second half of the range is as well covered as the first
  const mid = (from + to) / 2000;
  const late = path.filter((p) => p[0] > mid).length;
  assert.ok(late > path.length * 0.45, `late half ${late}/${path.length}`);
  assert.equal(r.headers['x-history-sampled'], '1');
  assert.equal(r.headers['x-history-truncated'], undefined);
  // bounded: the PIT read stops after its first page, one sampling request
  const dense = esSearches(fake).filter(
    (c) => c.body?.query && JSON.stringify(c.body.query).includes('de05e1'),
  );
  assert.ok(dense.some((c) => c.body.aggs?.t?.date_histogram));
  const pitPages = fake.calls.filter(
    (c) =>
      c.path === '/_search' && JSON.stringify(c.body?.query).includes('de05e1'),
  );
  assert.ok(pitPages.length <= 2, `${pitPages.length} PIT pages`); // adsb.lol + opensky
});

test('R3 track: sampling interval bounds the bucket count and honours minGapSec', () => {
  const day = 86_400_000;
  for (const range of [3_600_000, day, 31 * day]) {
    const iv = sampleIntervalMs(0, range);
    assert.ok(Math.floor(range / iv) + 1 <= MAX_TRACK_POINTS, String(range));
  }
  assert.equal(sampleIntervalMs(0, day, 600_000), 600_000);
});

// --------------------------------------------------------------- abuse
const B10_ABUSE = [
  [
    'track range > 31 d',
    `/api/history/track?feed=aircraft&id=abc123&from=${iso(NOW - 32 * 86_400_000)}&to=${iso(NOW)}`,
    413,
  ],
  [
    'track reversed',
    `/api/history/track?feed=aircraft&id=abc123&from=${iso(NOW)}&to=${iso(NOW - 1000)}`,
    400,
  ],
  [
    'track wildcard id',
    `/api/history/track?feed=aircraft&id=*&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track id too long',
    `/api/history/track?feed=aircraft&id=abc1234&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track mmsi letters',
    `/api/history/track?feed=vessels&id=12345abc&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track transit without feed',
    `/api/history/track?feed=transit&id=12&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track transit bad feed',
    `/api/history/track?feed=transit&id=${encodeURIComponent('A B:1')}&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track transit control char',
    `/api/history/track?feed=transit&id=mbta:%01&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track unknown feed',
    `/api/history/track?feed=firms&id=abc123&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    404,
  ],
  [
    'track minGapSec too big',
    `/api/history/track?feed=aircraft&id=abc123&from=${iso(NOW - 1000)}&to=${iso(NOW)}&minGapSec=86401`,
    413,
  ],
  [
    'track minGapSec negative',
    `/api/history/track?feed=aircraft&id=abc123&from=${iso(NOW - 1000)}&to=${iso(NOW)}&minGapSec=-1`,
    400,
  ],
  [
    'track id missing',
    `/api/history/track?feed=aircraft&from=${iso(NOW - 1000)}&to=${iso(NOW)}`,
    400,
  ],
  [
    'track extra param',
    `/api/history/track?feed=aircraft&id=abc123&from=${iso(NOW - 1000)}&to=${iso(NOW)}&size=1`,
    400,
  ],
  ['health with params', `/api/history/health?feed=military`, 400],
  [
    'vessels window',
    `/api/history/slice?feed=vessels&t=${iso(T)}&window=1d`,
    400,
  ],
  [
    'transit window',
    `/api/history/slice?feed=transit&t=${iso(T)}&window=1h`,
    400,
  ],
  [
    'bikeshare window above cap',
    `/api/history/slice?feed=bikeshare&t=${iso(T)}&window=8d`,
    413,
  ],
  [
    'vessels maxRows above cap',
    `/api/history/slice?feed=vessels&t=${iso(T)}&maxRows=15001`,
    413,
  ],
  [
    'vessels bbox inverted',
    `/api/history/slice?feed=vessels&t=${iso(T)}&bbox=10,0,-10,5`,
    400,
  ],
];

for (const [name, path, status] of B10_ABUSE) {
  test(`B10 abuse -> ${status}: ${name} (no ES / collector request)`, async () => {
    const { api, fake } = makeApi();
    const r = await call(api, path);
    assert.equal(r.status, status, r.body);
    assert.equal(fake.calls.length, 0);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers.etag, undefined);
  });
}

// -------------------------------------------------------------- cache
test('cache: ETag + private max-age=300; If-None-Match -> 304; repeat served from the LRU', async () => {
  const { api, fake } = makeApi(vesselData);
  const path = `/api/history/slice?feed=vessels&t=${iso(T)}`;
  const first = await call(api, path);
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'private, max-age=300');
  assert.match(first.headers.etag, /^"h[0-9a-f]{16}-[0-9a-z]+"$/);
  assert.equal(first.headers['x-history-cache'], 'MISS');
  assert.equal(first.headers.etag, bodyEtag(first.body));
  assert.equal(first.headers['x-history-rows'], '4', 'service headers kept');
  const before = esSearches(fake).length;
  const second = await call(api, path);
  assert.equal(second.headers['x-history-cache'], 'HIT');
  assert.equal(second.body, first.body);
  assert.equal(esSearches(fake).length, before, 'no ES request on a hit');
  // same moment spelled as epoch ms -> same entry
  const epoch = await call(api, `/api/history/slice?feed=vessels&t=${T}`);
  assert.equal(epoch.headers['x-history-cache'], 'HIT');
  const nm = await call(api, path, {
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(nm.status, 304);
  assert.equal(nm.body, '');
  assert.equal(nm.headers.etag, first.headers.etag);
  assert.equal(nm.headers['cache-control'], 'private, max-age=300');
  const other = await call(api, path, {
    headers: { 'if-none-match': '"nope"' },
  });
  assert.equal(other.status, 200);
  // tracks are cached too (their `to` is in the past)
  const tp = `/api/history/track?feed=vessels&id=211000001&from=${iso(T - 3_600_000)}&to=${iso(T)}`;
  const t1 = await call(api, tp);
  const t2 = await call(api, tp, {
    headers: { 'if-none-match': t1.headers.etag },
  });
  assert.equal(t2.status, 304);
});

test('cache: the live edge (t within 5 min of now) is never cached, no-store, no ETag', async () => {
  const { api, fake } = makeApi(vesselData, { now: T + 4 * MIN });
  const path = `/api/history/slice?feed=vessels&t=${iso(T)}`;
  const a = await call(api, path);
  assert.equal(a.status, 200);
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.equal(a.headers.etag, undefined);
  const n = esSearches(fake).length;
  await call(api, path);
  assert.ok(esSearches(fake).length > n, 'asked the store again');
  // snapshots are never cached (their "after" side grows)
  const s = await call(
    api,
    `/api/history/snapshots?feed=military&around=${iso(NOW - 86_400_000)}`,
  );
  assert.equal(s.headers['cache-control'], 'no-store');
});

test('cache: store errors are never cached', async () => {
  let failing = true;
  const { api } = makeApi(vesselData, {
    fake: {
      fail: (u) =>
        failing && u.pathname.endsWith('/_search')
          ? new Response('{"error":"secret node text"}', { status: 500 })
          : null,
    },
  });
  const path = `/api/history/slice?feed=vessels&t=${iso(T)}`;
  const bad = await call(api, path);
  assert.equal(bad.status, 503);
  assert.deepEqual(bad.json, { error: 'history_unavailable' });
  assert.equal(bad.headers['cache-control'], 'no-store');
  failing = false;
  const good = await call(api, path);
  assert.equal(good.status, 200);
  assert.equal(good.headers['x-history-cache'], 'MISS');
});

test('cache LRU: byte cap evicts least recently used; TTL expires entries', () => {
  let now = 0;
  const c = createHistoryCache({
    maxBytes: 3_000,
    maxEntryBytes: 3_000,
    ttlMs: 1_000,
    now: () => now,
  });
  const e = (n) => ({ text: 'x'.repeat(n), etag: '"e"', headers: {} });
  assert.equal(c.set('a', e(500)), true);
  assert.equal(c.set('b', e(500)), true);
  c.get('a'); // a is now the most recent
  c.set('c', e(500)); // over 3,000 bytes (UTF-16 + overhead): b goes
  assert.equal(c.get('b'), null);
  assert.ok(c.get('a'));
  assert.ok(c.stats().bytes <= 3_000);
  assert.equal(c.set('huge', e(10_000)), false, 'oversized entry refused');
  now = 2_000;
  assert.equal(c.get('a'), null, 'expired');
  assert.equal(etagMatches('W/"e", "f"', '"e"'), true);
  assert.equal(etagMatches('*', '"e"'), true);
  assert.equal(etagMatches(undefined, '"e"'), false);
});

// -------------------------------------------------------------- health
function collectorHealth(role, feeds, extra = {}) {
  return {
    instance: 'server5:1427098:1791920338',
    startedAt: NOW - 86_400_000,
    now: NOW,
    role,
    lease: { holder: 'server5:1427098:1791920338', peer: { up: true } },
    esWritable: true,
    spool: { files: 0, bytes: 0, droppedFiles: 0 },
    feeds,
    ...extra,
  };
}

function healthFail(answers) {
  return (u) => {
    if (u.pathname !== '/v1/health') return null;
    const a = answers[u.host];
    if (a === undefined || a === 'down')
      return Promise.reject(new TypeError('fetch failed'));
    return new Response(JSON.stringify(a), { status: 200 });
  };
}

test('health: first ACTIVE collector, N5 lastOK/staleSince/reason per feed, nothing internal leaks', async () => {
  const feeds = {
    military: {
      cadenceMs: 60_000,
      lastOkAt: NOW - 30_000,
      halted: null,
      lastReason: 'secret upstream text',
    },
    vessels: { cadenceMs: 60_000, lastOkAt: NOW - 10 * MIN, stream: true },
    'celestrak-geo': {
      cadenceMs: 21_600_000,
      lastOkAt: NOW - 30 * 3_600_000,
      halted: {
        feed: 'celestrak-glo-ops',
        at: NOW - 3_600_000,
        reason: 'network: TimeoutError',
      },
    },
    'aircraft-opensky': {
      demandDriven: true,
      cadenceMs: 22_737,
      lastOkAt: NOW - 20 * 3_600_000,
      paused: {
        why: 'day',
        until: Date.UTC(2026, 9, 15, 0, 0),
        since: NOW - 600_000,
      },
      halted: null,
    },
    'gbfs-new': { cadenceMs: 300_000, lastOkAt: null },
    'BAD NAME': { cadenceMs: 1 },
  };
  const { api, fake } = makeApi(
    {
      'gev-history-ingest-log': [
        {
          feed: 'military',
          kind: 'poll',
          ok: true,
          snap: NOW - 60_000,
          docs_written: 300,
          '@timestamp': iso(NOW - 60_000),
        },
        {
          feed: 'military',
          kind: 'poll',
          ok: false,
          snap: NOW - 120_000,
          docs_written: 0,
          '@timestamp': iso(NOW - 120_000),
        },
      ],
    },
    {
      fake: {
        fail: healthFail({
          's4.test:4180': collectorHealth('standby', {
            military: { cadenceMs: 60_000, lastOkAt: NOW - 86_400_000 },
          }),
          's5.test:4180': collectorHealth('active', feeds),
        }),
      },
    },
  );
  const r = await call(api, '/api/history/health');
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers.etag, undefined);
  const h = r.json;
  assert.equal(h.collector.state, 'active');
  assert.equal(h.collector.reachable, 2);
  assert.deepEqual(h.feeds.military, {
    cadenceMs: 60_000,
    lastOK: NOW - 30_000,
    staleSince: null,
    reason: null,
    state: 'live',
  });
  assert.deepEqual(h.feeds.vessels, {
    cadenceMs: 60_000,
    lastOK: NOW - 10 * MIN,
    staleSince: NOW - 10 * MIN + 180_000,
    reason: 'upstream_error',
    state: 'stale',
  });
  assert.equal(h.feeds['celestrak-geo'].reason, 'halted');
  assert.equal(
    h.feeds['celestrak-geo'].staleSince,
    NOW - 30 * 3_600_000 + 3 * 21_600_000,
  );
  assert.deepEqual(h.feeds['aircraft-opensky'], {
    cadenceMs: 22_737,
    lastOK: NOW - 20 * 3_600_000,
    staleSince: NOW - 600_000,
    reason: 'opensky_paused_until=00:00',
    state: 'stale',
  });
  assert.equal(h.feeds['gbfs-new'].state, 'none');
  assert.equal(h.feeds['BAD NAME'], undefined);
  assert.deepEqual(h.coverage.feeds.military, {
    polls: 2,
    pollsOk: 1,
    docs: 300,
    lastOkSnap: NOW - 60_000,
  });
  assert.equal(h.historyStore, 'ok');
  const text = r.body;
  for (const secret of [
    'server5',
    '1427098',
    'secret upstream text',
    'TimeoutError',
    'lease',
  ])
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.ok(fake.calls.some((c) => c.host === 's4.test:4180'));
});

test('health: no collector -> collector_down; store down -> 200 with coverage null', async () => {
  const { api } = makeApi(
    {},
    {
      fake: {
        fail: (u) => {
          if (u.pathname === '/v1/health')
            return Promise.reject(new TypeError('down'));
          if (u.pathname.endsWith('/_search'))
            return new Response('boom', { status: 500 });
          return null;
        },
      },
    },
  );
  const r = await call(api, '/api/history/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.collector.state, 'down');
  assert.equal(r.json.reason, 'collector_down');
  assert.deepEqual(r.json.feeds, {});
  assert.equal(r.json.coverage, null);
  assert.equal(r.json.historyStore, 'unavailable');
  assert.ok(!r.body.includes('boom'));
});

test('health: answers without a reader key (historyStore not_configured)', async () => {
  const { api } = makeApi(
    {},
    {
      env: { GEV_COLLECTOR_URLS: 'http://s5.test:4180' },
      fake: {
        fail: healthFail({ 's5.test:4180': collectorHealth('active', {}) }),
      },
    },
  );
  const r = await call(api, '/api/history/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.historyStore, 'not_configured');
  assert.equal(r.json.coverage, null);
  const s = await call(api, `/api/history/slice?feed=vessels&t=${iso(T)}`);
  assert.equal(s.status, 503);
});

test('feedHealth: stale threshold floor 90 s, demand-driven feeds never stale for lack of viewers', () => {
  assert.equal(
    feedHealth({ cadenceMs: 10_000, lastOkAt: NOW - 80_000 }, NOW).state,
    'live',
  );
  assert.equal(
    feedHealth({ cadenceMs: 10_000, lastOkAt: NOW - 91_000 }, NOW).staleSince,
    NOW - 1_000,
  );
  assert.equal(
    feedHealth(
      { demandDriven: true, cadenceMs: 20_000, lastOkAt: NOW - 86_400_000 },
      NOW,
    ).state,
    'live',
  );
  // an expired pause is not a pause
  assert.equal(
    feedHealth(
      {
        demandDriven: true,
        cadenceMs: 20_000,
        lastOkAt: NOW,
        paused: { why: 'day', until: NOW - 1 },
      },
      NOW,
    ).state,
    'live',
  );
  // a non-visible pause reason (e.g. backoff) is not shown
  assert.equal(
    feedHealth(
      {
        demandDriven: true,
        cadenceMs: 20_000,
        lastOkAt: NOW,
        paused: { why: 'idle', until: NOW + 1e6 },
      },
      NOW,
    ).reason,
    null,
  );
});

test('every B10 ES request targets an allowlisted index, auth or PIT endpoint', async () => {
  const { HISTORY_INDICES } = await import('./historyEs.js');
  const allowed = new Set(Object.values(HISTORY_INDICES).map((i) => '/' + i));
  const { api, fake } = makeApi({
    ...vesselData,
    ...transitData,
    ...bikeData,
    ...trackData,
  });
  for (const p of [
    `/api/history/slice?feed=vessels&t=${iso(T)}&bbox=5,50,10,56`,
    `/api/history/slice?feed=transit&t=${iso(T)}`,
    `/api/history/slice?feed=bikeshare&t=${iso(T)}`,
    `/api/history/track?feed=aircraft&id=abc123&from=${iso(DAY0)}&to=${iso(DAY0 + 3_600_000)}`,
    `/api/history/track?feed=military&id=abc123&from=${iso(DAY0)}&to=${iso(DAY0 + 3_600_000)}`,
  ])
    assert.equal((await call(api, p)).status, 200, p);
  for (const c of fake.calls.filter((c) => c.host === 'es.example.test')) {
    if (['/_security/_authenticate', '/_search', '/_pit'].includes(c.path))
      continue;
    const idx = c.path.replace(/\/(_search|_pit)$/, '');
    assert.ok(allowed.has(decodeURIComponent(idx)), c.path);
  }
});

// ------------------------------------- t_5dc0e0c3: doc values, probe, memo
test('t_5dc0e0c3 compareKeys is UTF-8 byte order without encoding (surrogates vs U+E000-U+FFFF)', () => {
  const enc = new TextEncoder();
  const ref = (a, b) => {
    const x = enc.encode(a);
    const y = enc.encode(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  const pool = ['a', 'Z', '0', '~', 'é', '\u07ff', '\u0800', '\ud7ff', '\ue000', '\uff5e', '\uffff', '\u{10000}', '\u{1f600}', '\u{10ffff}'];
  const rnd = seeded(7);
  const word = () => {
    let s = '';
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i += 1) s += pool[Math.floor(rnd() * pool.length)];
    return s;
  };
  for (let i = 0; i < 20_000; i += 1) {
    const a = word();
    const b = rnd() < 0.2 ? a + word() : word();
    assert.equal(Math.sign(compareKeys(a, b)), Math.sign(ref(a, b)), `${a} vs ${b}`);
  }
});

test('t_5dc0e0c3 fromDocValues gives back the indexed _source values (float32, Lucene geo, epoch_millis)', async () => {
  const { fromDocValues, shortestFloat32, geoCellValue, docValueFields } = await import('./historyCollapse.js');
  // live adsb.lol doc values (2026-10-18) vs the same doc's _source
  const doc = fromDocValues(
    {
      icao24: ['adc313'],
      '@timestamp': ['1792186918690'],
      location: ['31.10224798321724, -100.38872701115906'],
      geo_alt_m: [10622.2998046875],
      baro_alt_m: [10058.400390625],
      velocity_ms: [241.39999389648438],
      vert_rate_ms: [0.0],
      on_ground: [false],
      position_source: [0],
      snap: [1792186920],
      db_flags: [0],
      tags: ['a', 'b'],
    },
    {
      icao24: 'keyword',
      '@timestamp': 'date',
      location: 'geo_point',
      geo_alt_m: 'float',
      baro_alt_m: 'float',
      velocity_ms: 'float',
      vert_rate_ms: 'float',
      on_ground: 'boolean',
      position_source: 'byte',
      snap: 'long',
      db_flags: 'integer',
      tags: 'keyword',
      callsign: 'keyword', // no value: left out, as from _source
    },
  );
  assert.deepEqual(doc, {
    icao24: 'adc313',
    '@timestamp': 1792186918690,
    location: { lat: 31.102248, lon: -100.388727 },
    geo_alt_m: 10622.3,
    baro_alt_m: 10058.4,
    velocity_ms: 241.4,
    vert_rate_ms: 0,
    on_ground: false,
    position_source: 0,
    snap: 1792186920,
    db_flags: 0,
    tags: ['a', 'b'],
  });
  assert.deepEqual(docValueFields({ a: 'keyword', '@timestamp': 'date' }), [
    'a',
    { field: '@timestamp', format: 'epoch_millis' },
  ]);
  // exhaustive-ish round trips: <= 7-decimal coordinates, <= 7-digit floats
  const rnd = seeded(11);
  for (let i = 0; i < 50_000; i += 1) {
    const dec = Math.floor(rnd() * 8);
    const lat = Number((rnd() * 180 - 90).toFixed(dec)) + 0; // no -0
    const lon = Number((rnd() * 360 - 180).toFixed(dec)) + 0;
    const [dl, dn] = geoDv({ lat, lon }).split(', ').map(Number);
    assert.equal(geoCellValue(dl, LAT_DECODE), lat);
    assert.equal(geoCellValue(dn, LON_DECODE), lon);
    const f = Number((rnd() * 20_000 - 5_000).toFixed(Math.floor(rnd() * 3))) + 0;
    assert.equal(shortestFloat32(Math.fround(f)), f);
  }
  // a double that is not a float32 value is never touched
  assert.equal(shortestFloat32(0.1), 0.1);
});

function bucketDocs(n, snapS, prefix = '') {
  return Array.from({ length: n }, (_, i) => ({
    '@timestamp': snapS * 1000 - 1_000 - (i % 40) * 1_000,
    snap: snapS,
    icao24: prefix + (0x100000 + i * 7919).toString(16).padStart(6, '0'),
    location: {
      lat: Number((30.123457 + i / 1e6).toFixed(6)),
      lon: Number((-97.654321 - i / 1e6).toFixed(6)),
    },
    baro_alt_m: 10058.4,
    velocity_ms: 241.4,
    callsign: `CS${i}`,
    source: 'adsblol',
  }));
}

test('t_5dc0e0c3 latestPerKey docValues: same docs as _source, no stored fields read, keys-only probe split by its keys', async () => {
  const docs = bucketDocs(57, 1_791_000_000);
  // an older duplicate per key must lose to the newest
  for (const d of docs.slice(0, 10))
    docs.push({ ...d, '@timestamp': d['@timestamp'] - 30_000, callsign: 'OLD' });
  const fake = createFakeEs({ 'gev-history-aircraft-adsblol': docs }, { maxWindow: 10 });
  const { createHistoryEsClient } = await import('./historyEs.js');
  const es = createHistoryEsClient({ url: 'https://es.example.test', apiKey: 'k', fetchImpl: fake.fetchImpl });
  const IDXA = 'gev-history-aircraft-adsblol,gev-history-aircraft-adsblol-hist';
  const spec = { '@timestamp': 'date', location: 'geo_point', baro_alt_m: 'float', velocity_ms: 'float', callsign: 'keyword', source: 'keyword' };
  const common = { filter: [], field: 'icao24', pageSize: 10, maxQueries: 1_000 };
  const viaSource = await latestPerKey(es, IDXA, { ...common, _source: ['icao24', ...Object.keys(spec)] });
  const before = fake.calls.length;
  for (const [probe, partDocs] of [[false, 1_500], [true, 1_500], [true, 3]]) {
    const viaDv = await latestPerKey(es, IDXA, { ...common, docValues: spec, probe, partDocs });
    assert.equal(viaDv.truncated, false);
    const want = new Map(viaSource.hits.map((h) => [h._source.icao24, h._source]));
    assert.equal(viaDv.hits.length, want.size);
    for (const h of viaDv.hits)
      assert.deepEqual(h._source, want.get(h._source.icao24), h._source.icao24);
    assert.ok(viaDv.hits.every((h) => h._source.callsign !== 'OLD'));
  }
  const dvCalls = fake.calls.slice(before).filter((c) => c.body?.collapse);
  assert.ok(dvCalls.length > 0);
  for (const c of dvCalls) {
    assert.equal(c.body.stored_fields, '_none_', 'never the stored _source');
    assert.equal(c.body._source, undefined);
  }
  // probes ask for the key column only
  assert.ok(dvCalls.some((c) => c.body.docvalue_fields.length === 1 && c.body.docvalue_fields[0] === 'icao24'));
  // a probe that fits a page is cut at its own keys (partDocs 3): every
  // part is fetched once, none comes back full (no wasted page)
  const fake2 = createFakeEs({ 'gev-history-aircraft-adsblol': bucketDocs(9, 1_791_000_000) }, { maxWindow: 10 });
  const es2 = createHistoryEsClient({ url: 'https://es.example.test', apiKey: 'k', fetchImpl: fake2.fetchImpl });
  const r2 = await latestPerKey(es2, IDXA, { ...common, docValues: spec, probe: true, partDocs: 3 });
  assert.equal(r2.hits.length, 9);
  const c2 = fake2.calls.filter((c) => c.body?.collapse);
  assert.equal(c2.length, 1 + 3, 'one probe + three parts');
  assert.equal(r2.queries, 4);
});

test('t_5dc0e0c3 latestPerKey memo: later answers start from learned cuts (no probe); any cuts stay exact; small answers learn one request', async () => {
  const IDXA = 'gev-history-aircraft-adsblol,gev-history-aircraft-adsblol-hist';
  const { createHistoryEsClient } = await import('./historyEs.js');
  const { createCutMemo } = await import('./historyCollapse.js');
  const spec = { '@timestamp': 'date', location: 'geo_point' };
  const docs = bucketDocs(95, 1_791_000_000);
  const fake = createFakeEs({ 'gev-history-aircraft-adsblol': docs }, { maxWindow: 20 });
  const es = createHistoryEsClient({ url: 'https://es.example.test', apiKey: 'k', fetchImpl: fake.fetchImpl });
  const memo = createCutMemo(2);
  const opts = (lane) => ({ filter: [], field: 'icao24', pageSize: 20, maxQueries: 1_000, docValues: spec, probe: true, partDocs: 8, memo: memo.lane(lane) });
  const keysOf = (r) => r.hits.map((h) => h._source.icao24).sort();
  const want = [...new Set(docs.map((d) => d.icao24))].sort();
  const first = await latestPerKey(es, IDXA, opts('a'));
  assert.deepEqual(keysOf(first), want);
  const learned = memo.lane('a').cuts;
  assert.ok(Array.isArray(learned) && learned.length >= 1, 'cuts learned');
  let n = fake.calls.length;
  const second = await latestPerKey(es, IDXA, opts('a'));
  assert.deepEqual(keysOf(second), want);
  const secondCalls = fake.calls.slice(n).filter((c) => c.body?.collapse);
  assert.ok(secondCalls.every((c) => c.body.docvalue_fields.length > 1), 'no probe when cuts are known');
  assert.equal(secondCalls.length, learned.length + 1, 'one request per learned part');
  assert.equal(learned.length + 1, 8, '95 docs / 8 per part, capped at the fanout');
  // stale / skewed / foreign cuts: still the exact answer
  for (const cuts of [['zzzz'], ['0', '1', '100000'], ['\u{1f600}'], []]) {
    memo.lane('a').cuts = cuts;
    const r = await latestPerKey(es, IDXA, opts('a'));
    assert.deepEqual(keysOf(r), want, JSON.stringify(cuts));
    assert.equal(r.truncated, false);
  }
  // a small answer learns [] -> next answer is one request, no probe
  const small = createFakeEs({ 'gev-history-aircraft-adsblol': bucketDocs(4, 1_791_000_000) }, { maxWindow: 20 });
  const es3 = createHistoryEsClient({ url: 'https://es.example.test', apiKey: 'k', fetchImpl: small.fetchImpl });
  await latestPerKey(es3, IDXA, opts('b'));
  assert.deepEqual(memo.lane('b').cuts, []);
  n = small.calls.length;
  const again = await latestPerKey(es3, IDXA, opts('b'));
  assert.equal(again.hits.length, 4);
  assert.equal(small.calls.slice(n).filter((c) => c.body?.collapse).length, 1);
  // bounded LRU: a third lane evicts the least recent
  memo.lane('c');
  assert.equal(memo.size, 2);
});

test('t_5dc0e0c3 aircraft slice: rows read from doc values carry the _source values; second frame of a lane skips the probe', async () => {
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const snapS = T0 / 1000;
  const docs = bucketDocs(30, snapS);
  const { api, fake } = makeApi({ 'gev-history-aircraft-adsblol': docs });
  const r = await call(api, `/api/history/slice?feed=aircraft&t=${iso(T0)}`);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.states.length, 30);
  const byId = new Map(r.json.states.map((s) => [s[0], s]));
  for (const d of docs) {
    const s = byId.get(d.icao24);
    assert.equal(s[5], d.location.lon);
    assert.equal(s[6], d.location.lat);
    assert.equal(s[7], 10058.4);
    assert.equal(s[9], 241.4);
    assert.equal(s[1], d.callsign);
    assert.equal(s[3], Math.round(d['@timestamp'] / 1000));
  }
  const adsb = (c) => c.body?.collapse && c.path.includes('adsblol');
  const firstCalls = fake.calls.filter(adsb);
  assert.ok(firstCalls.every((c) => c.body.stored_fields === '_none_'));
  assert.equal(firstCalls[0].body.docvalue_fields.length, 1, 'first frame probes keys');
  const n = fake.calls.length;
  // next frame (a different, older moment: not cached), same lane
  const r2 = await call(api, `/api/history/slice?feed=aircraft&t=${iso(T0 + 60_000)}`);
  assert.equal(r2.status, 200, r2.body);
  const later = fake.calls.slice(n).filter(adsb);
  assert.ok(later.length >= 1);
  assert.ok(later.every((c) => c.body.docvalue_fields.length > 1), 'memo: no probe');
});

test('t_5dc0e0c3 vessels slice reads positions from doc values (no stored _source), same live row values', async () => {
  const t = NOW - 3_600_000;
  const docs = Array.from({ length: 12 }, (_, i) => ({
    '@timestamp': iso(t - (i + 1) * 30_000),
    mmsi: String(211_000_000 + i),
    location: {
      lat: Number((59.33168 + i / 1e5).toFixed(5)),
      lon: Number((18.07906 - i / 1e5).toFixed(5)),
    },
    sog_kn: Number((0.1 * i).toFixed(1)),
    cog_deg: 236.1,
    heading_deg: 34,
    source: 'aisstream',
  }));
  const { api, fake } = makeApi({ 'gev-history-vessels': docs });
  const r = await call(api, `/api/history/slice?feed=vessels&t=${iso(t)}`);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.rows.length, 12);
  const byMmsi = new Map(r.json.rows.map((row) => [row.mmsi, row]));
  for (const d of docs) {
    const row = byMmsi.get(d.mmsi);
    assert.equal(row.lat, d.location.lat);
    assert.equal(row.lon, d.location.lon);
    assert.equal(row.speed, d.sog_kn);
    assert.equal(row.course, 236.1);
    assert.equal(row.heading, 34);
    assert.equal(row.last_position_UTC, d['@timestamp']);
  }
  const vesselCalls = fake.calls.filter((c) => c.body?.collapse && c.path.includes('gev-history-vessels,'));
  assert.ok(vesselCalls.length >= 1);
  assert.ok(vesselCalls.every((c) => c.body.stored_fields === '_none_'));
});
