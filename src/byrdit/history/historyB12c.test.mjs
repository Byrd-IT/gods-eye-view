import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Server as TlsServer } from 'node:tls';
import { createHistoryApi, historyApiPlugin } from './historyApi.js';
import { HISTORY_INDICES } from './historyEs.js';
import { SLICE_FEEDS } from './historyParams.js';
import {
  GP_CSV_COLUMNS,
  GP_UNRECORDED_COLUMNS,
  PIXELS_BASIS,
  QUAKE_ARCHIVE_PREFIX,
  WIND_MAX_CYCLE_AGE_MS,
  collapseNumeric,
  gpCsvRow,
  pickNearestEpoch,
  pixelAvailability,
  windGridId,
} from './historySlicesB12c.js';
import { parseGP } from '../gpCsv.js';
import { normalizeEarthquakeSnapshot } from '../../layers/earthquakes/records.js';
import { validateWeatherSnapshot } from '../../layers/weather/source.js';
import { createWindSource } from '../../layers/wind/source.js';
import {
  GFS_ATMOS_FROM_MS,
  WIND_DEGRADED_HOLD_MS,
  createWindHistoryReader,
  windRetention,
  windStep,
} from '../../../server/byrdit/historyWind.js';
import {
  createWeatherServingState,
  loopbackBase,
} from '../../../server/byrdit/historyImageryTimes.js';
import { weatherProxy } from '../../../server/providers/weather.js';
import { createWeatherImagery } from './weatherImagery.js';
import { createCollectorBridge } from './collectorBridge.js';

const { json2satrec, propagate } = createRequire(import.meta.url)(
  'satellite.js',
);

/**
 * B12c (card t_de253a39; gev-history DESIGN 1.3 #8-#10, #14, 4.3, 4.5):
 * /api/history/slice feeds gp, quakes, wind and imagery. Fixtures are REAL
 * reader-key hits from the live cluster (2026-10-14) plus the live USGS
 * all_day.geojson captured at the same moment, so the shape tests compare
 * the history answer with what the live route really served, through GEV's
 * own parsers.
 */

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const NOW = Date.UTC(2026, 9, 14, 18, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const ENV = {
  GEV_HISTORY_ES_URL: 'https://es.example.test',
  GEV_HISTORY_ES_API_KEY: 'reader-key-value',
};

// ---------------------------------------------------------------- fake ES
const get = (doc, field) => field.split('.').reduce((o, k) => o?.[k], doc);
const asMs = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : v;

function matches(doc, q) {
  if (!q || q.match_all) return true;
  if (q.bool) {
    const should = q.bool.should ?? [];
    return (
      (q.bool.filter ?? []).every((f) => matches(doc, f)) &&
      !(q.bool.must_not ?? []).some((f) => matches(doc, f)) &&
      (should.length === 0 || should.some((f) => matches(doc, f)))
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
    v = asMs(v);
    return (
      (r.gte === undefined || v >= r.gte) &&
      (r.gt === undefined || v > r.gt) &&
      (r.lte === undefined || v <= r.lte) &&
      (r.lt === undefined || v < r.lt)
    );
  }
  throw new Error('fake ES: unsupported query ' + JSON.stringify(q));
}

/** data: { indexName: [doc | {_index, _source}] } */
function createFakeEs(data, { maxWindow = 10_000 } = {}) {
  const calls = [];
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
          docs.map((d, i) => ({
            _index: d._source ? (d._index ?? k) : k,
            _id: `${k}#${i}`,
            _source: d._source ?? d,
          })),
        ),
    );
  function search(all, body) {
    let hits = all.filter((h) => matches(h._source, body.query));
    for (const s of [...(body.sort ?? [])].reverse()) {
      const [[f, dir]] = Object.entries(s);
      hits = [...hits].sort((x, y) => {
        const a = asMs(get(x._source, f));
        const b = asMs(get(y._source, f));
        const c = a < b ? -1 : a > b ? 1 : 0;
        return dir === 'desc' ? -c : c;
      });
    }
    if (body.collapse) {
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
    return hits.map((h) => ({
      ...h,
      _source: keep
        ? Object.fromEntries(
            Object.entries(h._source).filter(([k]) => keep.includes(k)),
          )
        : h._source,
    }));
  }
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ host: u.host, path: decodeURIComponent(u.pathname), body });
    if (u.pathname === '/_security/_authenticate')
      return reply(200, {
        authentication_type: 'api_key',
        api_key: { name: 'gev-history-reader' },
      });
    if (u.pathname.endsWith('/_search')) {
      try {
        const index = decodeURIComponent(u.pathname.slice(1, -8));
        const all = docsFor(index);
        const hits = search(all, body);
        const out = {
          _shards: { failed: 0 },
          hits: { hits: hits.slice(0, body.size) },
        };
        if (body.aggs) {
          out.aggregations = {};
          for (const [name, spec] of Object.entries(body.aggs)) {
            const values = all
              .filter((h) => matches(h._source, body.query))
              .map((h) => asMs(get(h._source, spec.min.field)))
              .filter((v) => v !== undefined);
            out.aggregations[name] = {
              value: values.length ? Math.min(...values) : null,
            };
          }
        }
        return reply(200, out);
      } catch (error) {
        return reply(400, { error: { reason: error.message } });
      }
    }
    return reply(404, {});
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
  api(
    {
      url: path,
      method,
      headers: { host: 'localhost', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    },
    res,
    () => res.resolve(),
  );
  await done;
  const text = typeof res.body === 'string' ? res.body : null;
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    json:
      text && /json/.test(res.headers['content-type'] ?? '')
        ? JSON.parse(text)
        : null,
  };
}

function makeApi(data = {}, opts = {}) {
  const fake = createFakeEs(data, opts.fake);
  const api = createHistoryApi({
    env: ENV,
    fetchImpl: fake.fetchImpl,
    now: opts.clock ?? (() => opts.now ?? NOW),
    log: () => {},
    allow: () => true,
    windReader: opts.windReader ?? null,
    weatherTimes: opts.weatherTimes ?? null,
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
  });
  return { api, fake };
}
const esSearches = (fake) =>
  fake.calls.filter((c) => c.path.endsWith('_search'));
const slice = (q) => `/api/history/slice?${q}`;

// ------------------------------------------------------------------ wiring
test('B12c feeds are served by the slice route and read only allowlisted indices', () => {
  for (const feed of ['gp', 'quakes', 'wind', 'imagery'])
    assert.ok(SLICE_FEEDS[feed], feed);
  assert.equal(HISTORY_INDICES.gp, 'gev-history-gp');
  assert.equal(
    HISTORY_INDICES.quakes,
    'gev-history-quakes,gev-history-quakes-hist-*',
  );
  assert.equal(HISTORY_INDICES.cycles, 'gev-history-cycles');
  assert.equal(HISTORY_INDICES.imagery, 'gev-history-imagery');
});

// ------------------------------------------------------------------- abuse
const ABUSE = [
  ['gp without group', 'feed=gp&t=2026-10-14T12:00:00Z', 400],
  ['gp group syntax', 'feed=gp&t=2026-10-14T12:00:00Z&group=ACTIVE', 400],
  [
    'gp group too long',
    `feed=gp&t=2026-10-14T12:00:00Z&group=${'a'.repeat(41)}`,
    400,
  ],
  ['gp bbox', 'feed=gp&t=2026-10-14T12:00:00Z&group=active&bbox=0,0,1,1', 400],
  [
    'gp product',
    'feed=gp&t=2026-10-14T12:00:00Z&group=active&product=radar',
    400,
  ],
  [
    'gp maxRows huge',
    'feed=gp&t=2026-10-14T12:00:00Z&group=active&maxRows=99999',
    413,
  ],
  [
    'gp maxRows zero',
    'feed=gp&t=2026-10-14T12:00:00Z&group=active&maxRows=0',
    400,
  ],
  ['quakes bad t', 'feed=quakes&t=yesterday', 400],
  ['quakes date-only t', 'feed=quakes&t=2026-10-14', 400],
  ['quakes t before retention', 'feed=quakes&t=2020-01-01T00:00:00Z', 400],
  ['quakes t in the future', 'feed=quakes&t=2026-10-15T00:00:00Z', 400],
  ['quakes window', 'feed=quakes&t=2026-10-14T12:00:00Z&window=30d', 400],
  ['quakes group', 'feed=quakes&t=2026-10-14T12:00:00Z&group=active', 400],
  [
    'quakes bbox reversed',
    'feed=quakes&t=2026-10-14T12:00:00Z&bbox=10,0,-10,5',
    400,
  ],
  [
    'quakes bbox out of range',
    'feed=quakes&t=2026-10-14T12:00:00Z&bbox=-200,0,10,5',
    400,
  ],
  ['wind model', 'feed=wind&t=2026-10-14T12:00:00Z&model=ecmwf', 400],
  ['wind overlay', 'feed=wind&t=2026-10-14T12:00:00Z&overlay=rain', 400],
  ['wind part', 'feed=wind&t=2026-10-14T12:00:00Z&part=tiles', 400],
  ['wind bbox', 'feed=wind&t=2026-10-14T12:00:00Z&bbox=0,0,1,1', 400],
  [
    'wind repeated model',
    'feed=wind&t=2026-10-14T12:00:00Z&model=gfs&model=ifs',
    400,
  ],
  ['imagery without product', 'feed=imagery&t=2026-10-14T12:00:00Z', 400],
  ['imagery product', 'feed=imagery&t=2026-10-14T12:00:00Z&product=snow', 400],
  [
    'imagery model',
    'feed=imagery&t=2026-10-14T12:00:00Z&product=radar&model=gfs',
    400,
  ],
  [
    'aircraft does not take B12c params',
    'feed=aircraft&t=2026-10-14T12:00:00Z&part=grid',
    400,
  ],
  ['unknown param', 'feed=quakes&t=2026-10-14T12:00:00Z&eventid=x', 400],
  [
    'query too long',
    `feed=quakes&t=2026-10-14T12:00:00Z&group=${'a'.repeat(600)}`,
    400,
  ],
  ['unknown feed', 'feed=tle&t=2026-10-14T12:00:00Z', 404],
];
for (const [name, q, status] of ABUSE) {
  test(`B12c abuse -> ${status}: ${name} (no ES request)`, async () => {
    const { api, fake } = makeApi({});
    const r = await call(api, slice(q));
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.equal(esSearches(fake).length, 0);
  });
}

test('B12c abuse: HEAD -> 405, never an ES request', async () => {
  const { api, fake } = makeApi({});
  const r = await call(
    api,
    slice('feed=gp&t=2026-10-14T12:00:00Z&group=active'),
    { method: 'HEAD' },
  );
  assert.equal(r.status, 405);
  assert.equal(fake.calls.length, 0);
});

test('gp: a group that was never recorded -> 404 not_recorded + reason, no ES request', async () => {
  const { api, fake } = makeApi({});
  for (const group of ['stations', 'starlink', 'gps-ops']) {
    const r = await call(
      api,
      slice(`feed=gp&t=2026-10-14T12:00:00Z&group=${group}`),
    );
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, {
      error: 'not_recorded',
      reason: 'group_not_recorded',
    });
    assert.equal(r.headers['x-history-empty-reason'], 'group_not_recorded');
    assert.equal(r.headers['x-history-recorded-groups'], 'active');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal(esSearches(fake).length, 0);
});

// --------------------------------------------------------- nearest epoch
test('pickNearestEpoch: nearest epoch wins; a tie or a missing side keeps epoch <= t', () => {
  const t = Date.UTC(2026, 9, 13, 12);
  const at = (h) => ({ epoch: iso(t + h * HOUR) });
  assert.equal(pickNearestEpoch(t, null, null), null);
  assert.deepEqual(pickNearestEpoch(t, at(-30), null), {
    doc: at(-30),
    side: 'before',
  });
  assert.deepEqual(pickNearestEpoch(t, null, at(50)), {
    doc: at(50),
    side: 'after',
  });
  assert.equal(pickNearestEpoch(t, at(-3), at(5)).side, 'before');
  assert.equal(pickNearestEpoch(t, at(-5), at(3)).side, 'after');
  assert.equal(pickNearestEpoch(t, at(-4), at(4)).side, 'before'); // tie
  assert.equal(pickNearestEpoch(t, at(0), at(0.001)).side, 'before'); // epoch == t
});

/** A synthetic recorded elset (collector gpDoc fields). */
function elset(norad, epochMs, snap, extra = {}) {
  return {
    '@timestamp': iso(epochMs),
    snap,
    source: 'celestrak',
    norad_cat_id: norad,
    epoch: iso(epochMs),
    group: 'active',
    object_name: `OBJ ${norad}`,
    object_id: '2020-001A',
    mean_motion: 15.5,
    eccentricity: 0.0005,
    inclination: 51.6,
    ra_of_asc_node: 10,
    arg_of_pericenter: 20,
    mean_anomaly: 30,
    bstar: 0.0001,
    element_set_no: 999,
    rev_at_epoch: 100,
    ...extra,
  };
}

test('gp slice: nearest epoch per object, membership as recorded by t, header says which side', async () => {
  const P1 = Date.UTC(2026, 9, 12, 18); // first poll
  const P2 = P1 + 6 * HOUR;
  const P3 = P2 + 6 * HOUR;
  const t = P2 + 2 * HOUR;
  const docs = [
    // 1: epochs t-26h and t-2h (both <= t): newest <= t wins
    elset(1, t - 26 * HOUR, P1),
    elset(1, t - 2 * HOUR, P2),
    // 2: t-20h before, t+1h after (published later): the nearer one wins
    elset(2, t - 20 * HOUR, P1),
    elset(2, t + 1 * HOUR, P3),
    // 3: future epoch only (CelesTrak predicted elset), seen at P1
    elset(3, t + 40 * HOUR, P1),
    // 4: first seen at P3 (after t): not a member at t, even with an old epoch
    elset(4, t - 5 * HOUR, P3),
    // 5: an incomplete elset is never sent
    elset(5, t - HOUR, P1, { mean_motion: undefined }),
    // other group docs never leak in
    elset(6, t - HOUR, P1, { group: 'other' }),
  ];
  const { api } = makeApi({ 'gev-history-gp': docs });
  const r = await call(api, slice(`feed=gp&t=${iso(t)}&group=active`));
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/plain/);
  assert.equal(r.headers['x-history-recording-start'], iso(P1));
  assert.equal(
    r.headers['x-history-gp-rule'],
    'nearest-epoch-prefer-at-or-before',
  );
  assert.equal(
    r.headers['x-history-gp-unrecorded-columns'],
    GP_UNRECORDED_COLUMNS.join(','),
  );
  const rows = parseGP(r.body);
  assert.deepEqual(
    rows.map((e) => [e.gp.NORAD_CAT_ID, e.gp.EPOCH]),
    [
      ['1', iso(t - 2 * HOUR).replace('Z', '')],
      ['2', iso(t + HOUR).replace('Z', '')],
      ['3', iso(t + 40 * HOUR).replace('Z', '')],
    ],
  );
  assert.equal(r.headers['x-history-rows'], '3');
  assert.equal(r.headers['x-history-gp-epoch-before'], '1');
  assert.equal(r.headers['x-history-gp-epoch-after'], '2');
  assert.equal(r.headers['x-history-truncated'], undefined);
});

test('gp slice: before the first recorded poll -> the CSV header only + before_recording_start (D3)', async () => {
  const P1 = Date.UTC(2026, 9, 12, 17, 25);
  const { api } = makeApi({ 'gev-history-gp': [elset(1, P1 - DAY, P1)] });
  const r = await call(
    api,
    slice(`feed=gp&t=${iso(P1 - 60_000)}&group=active`),
  );
  assert.equal(r.status, 200);
  assert.equal(r.body, GP_CSV_COLUMNS.join(',') + '\r\n');
  assert.deepEqual(parseGP(r.body), []);
  assert.equal(r.headers['x-history-empty-reason'], 'before_recording_start');
  assert.equal(r.headers['x-history-recording-start'], iso(P1));
  // nothing recorded at all -> the same empty answer
  const none = makeApi({ 'gev-history-gp': [] });
  const e = await call(none.api, slice(`feed=gp&t=${iso(P1)}&group=active`));
  assert.equal(e.headers['x-history-empty-reason'], 'before_recording_start');
});

test('gp slice: maxRows keeps the lowest NORAD ids deterministically and flags truncation', async () => {
  const P1 = Date.UTC(2026, 9, 12, 18);
  const docs = [];
  for (let id = 1; id <= 40; id += 1)
    docs.push(elset(id, P1 - id * 60_000, P1));
  const { api } = makeApi({ 'gev-history-gp': docs.reverse() });
  const r = await call(
    api,
    slice(`feed=gp&t=${iso(P1 + HOUR)}&group=active&maxRows=25`),
  );
  const ids = parseGP(r.body).map((e) => Number(e.gp.NORAD_CAT_ID));
  assert.deepEqual(
    ids,
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  assert.equal(r.headers['x-history-truncated'], '1');
});

test('collapseNumeric: exact newest per NUMERIC key across pages (numeric, not byte order: 9 < 10 < 100)', async () => {
  let s = 7;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const docs = [];
  const newest = new Map();
  for (let i = 0; i < 900; i += 1) {
    const id = [9, 10, 99, 100, 1000][i % 5] + Math.floor(rnd() * 70_000);
    const ep = Date.UTC(2026, 9, 1) + Math.floor(rnd() * 10 * DAY);
    docs.push({ norad_cat_id: id, epoch: iso(ep) });
    if (!newest.has(id) || newest.get(id) < ep) newest.set(id, ep);
  }
  const fake = createFakeEs({ 'gev-history-gp': docs }, { maxWindow: 7 });
  const calls = [];
  const es = {
    async search(index, body) {
      calls.push(body);
      const r = await fake.fetchImpl(
        `https://es.example.test/${index}/_search`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return r.json();
    },
  };
  const r = await collapseNumeric(es, 'gev-history-gp', {
    filter: [],
    field: 'norad_cat_id',
    sort: [{ epoch: 'desc' }],
    _source: ['epoch'],
    pageSize: 7,
    maxQueries: 10_000,
  });
  assert.equal(r.truncated, false);
  const got = new Map(
    r.hits.map((h) => [h._source.norad_cat_id, Date.parse(h._source.epoch)]),
  );
  assert.equal(got.size, newest.size);
  for (const [id, ep] of newest) assert.equal(got.get(id), ep, `id ${id}`);
  assert.equal(r.hits.length, newest.size, 'no key twice');
});

test('gp shape: the history CSV of the live CelesTrak elsets parses and propagates exactly like the live CSV', async () => {
  // live /api/celestrak/stations body (B7 fixture, CelesTrak CRLF CSV)
  const liveText = gunzipSync(
    readFileSync(new URL('b7-celestrak-stations.csv.gz', FIX)),
  ).toString();
  const live = parseGP(liveText);
  assert.ok(live.length > 10);
  // what the collector records for each row (gev-history celestrak.js gpDoc)
  const snap = Date.UTC(2026, 9, 11, 6);
  const num = (v) => (v === '' || v === undefined ? undefined : Number(v));
  const docs = live.map(({ gp }) => {
    const epochMs = Date.parse(`${gp.EPOCH.replace(/(\.\d{3})\d*$/, '$1')}Z`);
    return {
      '@timestamp': iso(epochMs),
      snap,
      source: 'celestrak',
      norad_cat_id: Number(gp.NORAD_CAT_ID),
      epoch: iso(epochMs),
      group: 'active',
      object_name: gp.OBJECT_NAME.trim(),
      object_id: gp.OBJECT_ID.trim(),
      mean_motion: num(gp.MEAN_MOTION),
      eccentricity: num(gp.ECCENTRICITY),
      inclination: num(gp.INCLINATION),
      ra_of_asc_node: num(gp.RA_OF_ASC_NODE),
      arg_of_pericenter: num(gp.ARG_OF_PERICENTER),
      mean_anomaly: num(gp.MEAN_ANOMALY),
      bstar: num(gp.BSTAR),
      element_set_no: num(gp.ELEMENT_SET_NO),
      rev_at_epoch: num(gp.REV_AT_EPOCH),
    };
  });
  const t = snap + HOUR;
  const { api } = makeApi({ 'gev-history-gp': docs }, { now: t + DAY });
  const r = await call(api, slice(`feed=gp&t=${iso(t)}&group=active`));
  assert.equal(r.status, 200);
  assert.equal(
    r.body.split('\r\n')[0],
    liveText.split(/\r?\n/)[0],
    'same header row',
  );
  assert.ok(r.body.endsWith('\r\n'));
  const hist = new Map(parseGP(r.body).map((e) => [e.gp.NORAD_CAT_ID, e]));
  const liveIds = new Set(live.map((e) => e.gp.NORAD_CAT_ID));
  assert.equal(hist.size, liveIds.size, 'one row per object');
  const when = new Date(t);
  for (const { name, gp } of live) {
    const h = hist.get(gp.NORAD_CAT_ID);
    assert.ok(h, gp.NORAD_CAT_ID);
    assert.equal(h.name, name.trim());
    for (const k of [
      'MEAN_MOTION',
      'ECCENTRICITY',
      'INCLINATION',
      'RA_OF_ASC_NODE',
      'ARG_OF_PERICENTER',
      'MEAN_ANOMALY',
      'BSTAR',
    ])
      assert.equal(Number(h.gp[k]), Number(gp[k]), `${gp.NORAD_CAT_ID} ${k}`);
    for (const k of GP_UNRECORDED_COLUMNS) assert.equal(h.gp[k], '', k);
    const a = propagate(json2satrec(gp), when).position;
    const b = propagate(json2satrec(h.gp), when).position;
    // only the sub-ms EPOCH digits differ: well under 10 m one hour out
    assert.ok(
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.01,
      gp.NORAD_CAT_ID,
    );
  }
});

test('gp: real recorded elsets (reader-key fixture) -> one row per object, epoch nearest t', async () => {
  const { docs } = fixture('b12c-gp-es-docs.json');
  const t = Date.UTC(2026, 9, 13, 12);
  const { api } = makeApi({ 'gev-history-gp': docs });
  const r = await call(api, slice(`feed=gp&t=${iso(t)}&group=active`));
  const rows = parseGP(r.body);
  const ids = [
    ...new Set(
      docs.filter((d) => d.snap <= t).map((d) => String(d.norad_cat_id)),
    ),
  ].sort((a, b) => a - b);
  assert.deepEqual(
    rows.map((e) => e.gp.NORAD_CAT_ID),
    ids,
  );
  for (const { gp } of rows) {
    const mine = docs.filter((d) => String(d.norad_cat_id) === gp.NORAD_CAT_ID);
    const best = Math.min(
      ...mine.map((d) => Math.abs(Date.parse(d.epoch) - t)),
    );
    assert.equal(
      Math.abs(Date.parse(`${gp.EPOCH}Z`) - t),
      best,
      gp.NORAD_CAT_ID,
    );
    assert.ok(
      propagate(json2satrec(gp), new Date(t)).position,
      gp.NORAD_CAT_ID,
    );
  }
  assert.ok(gpCsvRow(docs[0]));
});

// ----------------------------------------------------------------- quakes
test('quakes shape: history at the live capture time == the live all_day.geojson, through GEV normalizeEarthquakeSnapshot', async () => {
  const live = fixture('b12c-usgs-all-day.json');
  const { docs } = fixture('b12c-quakes-es-docs.json');
  const byIndex = {};
  for (const d of docs) {
    // data stream backing index -> its stream name (the API reads streams)
    const index = d._index.startsWith(QUAKE_ARCHIVE_PREFIX)
      ? d._index
      : 'gev-history-quakes';
    (byIndex[index] ??= []).push(d._source);
  }
  const t = live.metadata.generated;
  const { api } = makeApi(byIndex, { now: t + HOUR });
  const r = await call(api, slice(`feed=quakes&t=${iso(t)}`));
  assert.equal(r.status, 200);
  assert.equal(r.json.type, 'FeatureCollection');
  const h = normalizeEarthquakeSnapshot(r.json);
  const l = normalizeEarthquakeSnapshot(live);
  assert.ok(l.length >= 30);
  const order = (rows) =>
    [...rows].sort((a, b) => (a.usgsId < b.usgsId ? -1 : 1));
  assert.deepEqual(order(h), order(l));
  // every live feature (all magnitudes) is present with the same geometry
  const hist = new Map(r.json.features.map((f) => [f.id, f]));
  for (const f of live.features) {
    assert.deepEqual(hist.get(f.id)?.geometry, f.geometry, f.id);
    assert.equal(hist.get(f.id).properties.time, f.properties.time);
    assert.equal(hist.get(f.id).properties.mag, f.properties.mag);
  }
});

const quake = (id, originMs, updatedMs, extra = {}) => ({
  '@timestamp': iso(originMs),
  snap: updatedMs + 60_000,
  source: 'usgs-fdsn',
  event_id: id,
  updated: iso(updatedMs),
  location: { lat: 10, lon: 20 },
  mag: 3,
  mag_type: 'mb',
  depth_km: 10,
  place: `place ${id}`,
  ...extra,
});

test('quakes as of t: newest version with updated <= t; window and bbox judged on THAT version', async () => {
  const t = Date.UTC(2026, 9, 14, 12);
  const live = [
    // a: two versions known by t, a third after t (ignored)
    quake('a', t - HOUR, t - 50 * 60_000, { mag: 3.1 }),
    quake('a', t - HOUR, t - 10 * 60_000, { mag: 3.4 }),
    quake('a', t - HOUR, t + HOUR, { mag: 9.9 }),
    // b: first published after t -> not shown
    quake('b', t - 2 * HOUR, t + 60_000),
    // c: origin revised from inside the window to before it -> not shown
    quake('c', t - DAY + 60_000, t - 5 * HOUR),
    quake('c', t - DAY - 20 * 60_000, t - HOUR),
    // d: revised from just outside to inside -> shown at the new origin
    quake('d', t - DAY - 30 * 60_000, t - 6 * HOUR),
    quake('d', t - DAY + 30 * 60_000, t - 2 * HOUR),
    // e: moved out of the bbox in its newest version -> not in the bbox answer
    quake('e', t - 3 * HOUR, t - 3 * HOUR, { location: { lat: 1, lon: 1 } }),
    quake('e', t - 3 * HOUR, t - HOUR, { location: { lat: 50, lon: 50 } }),
    // f: origin after t (later event) -> not shown
    quake('f', t + 60_000, t - 60_000),
  ];
  const archive = [
    // g: archive copy of a version also recorded live: one feature
    quake('g', t - 4 * HOUR, t - 3 * HOUR, { source: 'usgs-fdsn' }),
  ];
  const { api } = makeApi({
    'gev-history-quakes': [...live, quake('g', t - 4 * HOUR, t - 3 * HOUR)],
    'gev-history-quakes-hist-2026.10.31': archive,
  });
  const r = await call(api, slice(`feed=quakes&t=${iso(t)}`));
  const got = Object.fromEntries(r.json.features.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(got).sort(), ['a', 'd', 'e', 'g']);
  assert.equal(got.a.properties.mag, 3.4);
  assert.equal(got.d.properties.time, t - DAY + 30 * 60_000);
  assert.equal(r.json.metadata.count, 4);
  assert.equal(r.headers['x-history-rows'], '4');
  // newest origin first (USGS summary order)
  const times = r.json.features.map((f) => f.properties.time);
  assert.deepEqual(
    times,
    [...times].sort((x, y) => y - x),
  );
  const box = await call(api, slice(`feed=quakes&t=${iso(t)}&bbox=0,0,30,30`));
  assert.deepEqual(box.json.features.map((f) => f.id).sort(), ['a', 'd', 'g']);
});

test('quakes: archive-only events are labelled; before the first record -> empty + reason; partial window flagged', async () => {
  const t = Date.UTC(2026, 3, 1, 12);
  const archive = [quake('h1', t - 2 * HOUR, t - HOUR)];
  const { api } = makeApi({ 'gev-history-quakes-hist-2026.04.30': archive });
  const r = await call(api, slice(`feed=quakes&t=${iso(t)}`));
  assert.equal(r.headers['x-history-sources'], 'usgs-archive');
  assert.ok(QUAKE_ARCHIVE_PREFIX.startsWith('gev-history-quakes-hist'));
  assert.equal(r.headers['x-history-partial-window'], '1');
  const before = await call(api, slice(`feed=quakes&t=${iso(t - 3 * HOUR)}`));
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.features, []);
  assert.equal(
    before.headers['x-history-empty-reason'],
    'before_recording_start',
  );
  assert.deepEqual(normalizeEarthquakeSnapshot(before.json), []);
});

test('quakes: maxRows keeps the newest origins, flags truncation', async () => {
  const t = Date.UTC(2026, 9, 14, 12);
  const docs = Array.from({ length: 30 }, (_, i) =>
    quake(`q${i}`, t - (i + 1) * 60_000, t - 30_000),
  );
  const { api } = makeApi({ 'gev-history-quakes': docs });
  const r = await call(api, slice(`feed=quakes&t=${iso(t)}&maxRows=10`));
  assert.deepEqual(
    r.json.features.map((f) => f.id),
    Array.from({ length: 10 }, (_, i) => `q${i}`),
  );
  assert.equal(r.headers['x-history-truncated'], '1');
});

// ------------------------------------------------------------------- wind
const CYCLES = fixture('b12c-cycles-es-docs.json').docs;
const RUN = (d, h) => Date.UTC(2026, 9, d, h);

/** A reader double: records requests; answers like the real one. */
function fakeWindReader({ fromMs = 0, status = 'ok' } = {}) {
  const reads = [];
  return {
    reads,
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
      const values = new Float32Array(nx * ny * 2).fill(1.5);
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
          gridUrl: `/api/wind/grid/${model}-${cycle.date}-${cycle.hour}-f${forecastHour}-1.bin?model=${model}`,
        },
      };
    },
  };
}

test('wind cycle at t: the newest RECORDED cycle with run <= t, step nearest t (real cycle docs)', async () => {
  const reader = fakeWindReader();
  const { api } = makeApi(
    { 'gev-history-cycles': CYCLES },
    { windReader: reader },
  );
  const cases = [
    [RUN(13, 9) + 30 * 60_000, RUN(13, 6), 4], // 09:30 -> 06Z f004 (valid 10:00)
    [RUN(13, 6), RUN(13, 6), 0], // exactly the run time
    [RUN(13, 5) + 59 * 60_000, RUN(13, 0), 6],
    [RUN(12, 6), RUN(12, 6), 0], // first recorded cycle
  ];
  for (const [t, run, fh] of cases) {
    const r = await call(api, slice(`feed=wind&t=${iso(t)}`));
    assert.equal(r.status, 200, iso(t));
    assert.equal(r.headers['x-history-cycle-run'], iso(run));
    assert.equal(r.headers['x-history-forecast-hour'], String(fh));
    assert.equal(r.json.cycle.runIso, iso(run));
    assert.equal(r.headers['x-history-recording-start'], iso(RUN(12, 6)));
    assert.equal(reader.reads.at(-1).runMs, run);
    assert.equal(reader.reads.at(-1).validMs, t);
  }
});

test('wind: before the first recorded cycle, an unrecorded model, and a recording gap answer NOTHING (404 + reason)', async () => {
  const reader = fakeWindReader();
  const gap = CYCLES.filter(
    (d) => Date.parse(d.run) < RUN(13, 12) || Date.parse(d.run) > RUN(14, 0),
  );
  const { api } = makeApi(
    { 'gev-history-cycles': gap },
    { windReader: reader },
  );
  const before = await call(api, slice(`feed=wind&t=${iso(RUN(12, 5))}`));
  assert.equal(before.status, 404);
  assert.equal(
    before.headers['x-history-empty-reason'],
    'before_recording_start',
  );
  const ifs = await call(
    api,
    slice(`feed=wind&t=${iso(RUN(13, 9))}&model=ifs`),
  );
  assert.equal(ifs.status, 404);
  assert.equal(ifs.json.reason, 'model_not_recorded');
  // 12Z, 18Z, 00Z missing: at 23:00 the newest recorded run is 06Z (17 h old)
  const hole = await call(api, slice(`feed=wind&t=${iso(RUN(13, 23))}`));
  assert.equal(hole.status, 404);
  assert.equal(hole.json.reason, 'cycle_not_recorded');
  assert.equal(hole.headers['x-history-cycle-run'], iso(RUN(13, 6)));
  // ... while 12 h after the run is still that cycle (WIND_MAX_CYCLE_AGE_MS)
  const edge = await call(
    api,
    slice(`feed=wind&t=${iso(RUN(13, 6) + WIND_MAX_CYCLE_AGE_MS)}`),
  );
  assert.equal(edge.status, 200);
  assert.equal(
    reader.reads.length,
    1,
    'no upstream read for a not-recorded answer',
  );
});

test('wind retention edge: a cycle older than the upstream retention -> 404 outside_upstream_retention, never another cycle', async () => {
  const run = RUN(13, 6);
  const t = run + 2 * HOUR;
  const inside = fakeWindReader({ fromMs: run });
  const a = makeApi({ 'gev-history-cycles': CYCLES }, { windReader: inside });
  assert.equal((await call(a.api, slice(`feed=wind&t=${iso(t)}`))).status, 200);
  const outside = fakeWindReader({ fromMs: run + 1 });
  const b = makeApi({ 'gev-history-cycles': CYCLES }, { windReader: outside });
  const r = await call(b.api, slice(`feed=wind&t=${iso(t)}`));
  assert.equal(r.status, 404);
  assert.equal(r.json.reason, 'outside_upstream_retention');
  assert.equal(r.headers['x-history-upstream-retention-from'], iso(run + 1));
  assert.equal(outside.reads.length, 0);
  // the provider no longer serving the object -> upstream_missing
  const gone = fakeWindReader({ status: 'upstream_missing' });
  const c = makeApi({ 'gev-history-cycles': CYCLES }, { windReader: gone });
  const g = await call(c.api, slice(`feed=wind&t=${iso(t)}`));
  assert.equal(g.status, 404);
  assert.equal(g.json.reason, 'upstream_missing');
});

test('wind shape: GEV createWindSource accepts the history manifest + grid unchanged (router maps the gridUrl)', async () => {
  const reader = fakeWindReader();
  const { api } = makeApi(
    { 'gev-history-cycles': CYCLES },
    { windReader: reader, cache: null },
  );
  const t = RUN(13, 9) + 30 * 60_000;
  const manifest = await call(api, slice(`feed=wind&t=${iso(t)}`));
  const gridUrl = manifest.headers['x-history-grid'];
  assert.equal(
    gridUrl,
    `/api/history/slice?feed=wind&t=${encodeURIComponent(iso(t))}&model=gfs&overlay=none&part=grid`,
  );
  const fetchImpl = async (url) => {
    const r = url.startsWith('/api/wind/manifest')
      ? manifest
      : await call(api, gridUrl);
    const body =
      typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body;
    return new Response(body, {
      status: r.status,
      headers: { 'content-type': r.headers['content-type'] },
    });
  };
  const snap = await createWindSource({ fetchImpl }).getSnapshot({
    model: 'gfs',
  });
  assert.equal(snap.cycle.runIso, iso(RUN(13, 6)));
  assert.equal(snap.u.length, 360 * 181);
  const grid = await call(api, gridUrl);
  assert.equal(grid.headers['content-type'], 'application/octet-stream');
  assert.equal(grid.headers['cache-control'], 'no-store');
});

test('wind reader: step rules, retention, explicit cycle URL, 404 -> upstream_missing (no other cycle tried)', async () => {
  assert.equal(windStep('gfs', RUN(13, 6), RUN(13, 6) + 4.4 * HOUR), 4);
  assert.equal(windStep('gfs', RUN(13, 6), RUN(13, 6) + 130 * HOUR), 129);
  assert.equal(windStep('ifs', RUN(13, 6), RUN(13, 6) + 4.4 * HOUR), 3);
  assert.equal(windStep('ifs', RUN(13, 6), RUN(13, 6) + 400 * HOUR), 144);
  assert.equal(windRetention('gfs', NOW).fromMs, GFS_ATMOS_FROM_MS);
  assert.equal(windRetention('ifs', NOW).fromMs, Date.UTC(2026, 9, 11));
  const urls = [];
  const reader = createWindHistoryReader({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response('NoSuchKey', { status: 404 });
    },
  });
  const r = await reader.read({
    model: 'gfs',
    overlay: 'none',
    runMs: RUN(13, 6),
    validMs: RUN(13, 9),
  });
  assert.deepEqual(r, { status: 'upstream_missing' });
  assert.deepEqual(urls, [
    'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261013/06/atmos/gfs.t06z.pgrb2.0p25.f003.idx',
  ]);
  const ifs = createWindHistoryReader({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response('', { status: 404 });
    },
  });
  await ifs.read({
    model: 'ifs',
    overlay: 'none',
    runMs: RUN(13, 0),
    validMs: RUN(13, 7),
  });
  assert.equal(
    urls.at(-1),
    'https://data.ecmwf.int/forecasts/20261013/00z/ifs/0p25/oper/20261013000000-6h-oper-fc.index',
  );
  // a network failure is not 'missing': it surfaces as a store error (503)
  const down = createWindHistoryReader({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    down.read({
      model: 'gfs',
      overlay: 'none',
      runMs: RUN(13, 6),
      validMs: RUN(13, 6),
    }),
  );
});

test('wind reader: one byte-range read per cycle+step (decoded grid kept), manifest like the live provider', async () => {
  const idx = [
    '1:0:d=2026101306:UGRD:10 m above ground:3 hour fcst:',
    '2:100:d=2026101306:VGRD:10 m above ground:3 hour fcst:',
    '3:200:d=2026101306:TMP:2 m above ground:3 hour fcst:',
  ].join('\n');
  let gets = 0;
  const fetchImpl = async (url, init = {}) => {
    gets += 1;
    if (url.endsWith('.idx')) return new Response(idx, { status: 200 });
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(new Uint8Array(Number(b) - Number(a) + 1), {
      status: 206,
    });
  };
  // decoded message double: a 2 x 2 degree global field
  const decodeImpl = async () => ({
    ni: 180,
    nj: 91,
    lo1: 0,
    la1: 90,
    di: 2,
    dj: 2,
    units: 'm s-1',
    values: new Float32Array(180 * 91).fill(2),
  });
  const reader = createWindHistoryReader({
    fetchImpl,
    decodeImpl,
    now: () => NOW,
  });
  const req = {
    model: 'gfs',
    overlay: 'none',
    runMs: RUN(13, 6),
    validMs: RUN(13, 9),
  };
  const r = await reader.read(req);
  assert.equal(r.status, 'ok');
  assert.equal(r.manifest.cycle.forecastHour, 3);
  assert.equal(r.manifest.cycle.validIso, iso(RUN(13, 9)));
  assert.match(
    r.manifest.gridUrl,
    /^\/api\/wind\/grid\/gfs-[\w.-]+\.bin\?model=gfs$/,
  );
  assert.equal(
    r.manifest.gridUrl,
    '/api/wind/grid/gfs-20261013-6-f3-1.bin?model=gfs',
  );
  assert.equal(r.bytes.byteLength, r.manifest.grid.nx * r.manifest.grid.ny * 8);
  const before = gets;
  await reader.read(req);
  assert.equal(gets, before, 'served from the reader cache');
});

test('wind reader: a transient scalar failure is held briefly, then re-read; the recovered answer is kept (review R2)', async () => {
  const idx = [
    '1:0:d=2026101306:UGRD:10 m above ground:3 hour fcst:',
    '2:100:d=2026101306:VGRD:10 m above ground:3 hour fcst:',
    '3:200:d=2026101306:TMP:2 m above ground:3 hour fcst:',
    '4:300:d=2026101306:XXX:surface:3 hour fcst:',
  ].join('\n');
  let failTmp = true;
  let gets = 0;
  const fetchImpl = async (url, init = {}) => {
    gets += 1;
    if (url.endsWith('.idx')) return new Response(idx);
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    if (Number(a) === 200 && failTmp)
      return new Response('transient', { status: 503 });
    return new Response(
      new Uint8Array(Number(b) - Number(a) + 1).fill(Number(a) === 200 ? 3 : 1),
      { status: 206 },
    );
  };
  const decodeImpl = async (buf) => ({
    ni: 180,
    nj: 91,
    lo1: 0,
    la1: 90,
    di: 2,
    dj: 2,
    units: buf[0] === 3 ? 'K' : 'm s-1',
    values: new Float32Array(180 * 91).fill(buf[0] === 3 ? 280 : 2),
  });
  let clock = NOW;
  const reader = createWindHistoryReader({
    fetchImpl,
    decodeImpl,
    now: () => clock,
  });
  const req = {
    model: 'gfs',
    overlay: 'temperature',
    runMs: RUN(13, 6),
    validMs: RUN(13, 9),
  };
  const first = await reader.read(req);
  assert.equal(first.status, 'ok', 'the failing request still gets wind');
  assert.ok(first.manifest.scalarError);
  assert.match(first.manifest.gridUrl, /-temperature-wind-only\.bin/);
  assert.equal(first.bytes.length, 360 * 181 * 8);
  failTmp = false;
  // inside the hold: the same answer (manifest and grid stay one read)
  let n = gets;
  assert.equal(await reader.read(req), first);
  assert.equal(gets, n);
  // after the hold: read again -> the temperature field is back
  clock += WIND_DEGRADED_HOLD_MS;
  n = gets;
  const recovered = await reader.read(req);
  assert.ok(gets > n, 'the cycle was read again');
  assert.equal(recovered.manifest.scalarError, undefined);
  assert.equal(recovered.manifest.scalar.kind, 'temperature');
  assert.equal(recovered.bytes.length, 360 * 181 * 12);
  // a full answer is kept (control)
  clock += 10 * WIND_DEGRADED_HOLD_MS;
  n = gets;
  assert.equal(await reader.read(req), recovered);
  assert.equal(gets, n);
});

test('wind API: a degraded (wind-only) manifest is never cached; the recovered one is; X-History-Wind-Id ties grid to manifest', async () => {
  let degraded = true;
  const base = fakeWindReader();
  const reader = {
    ...base,
    async read(q) {
      const v = await base.read(q);
      if (!degraded) return v;
      const id = `${windGridId(v.manifest.gridUrl)}-temperature-wind-only`;
      return {
        ...v,
        manifest: {
          ...v.manifest,
          overlay: 'temperature',
          scalarError: 'Temperature field unavailable',
          gridUrl: `/api/wind/grid/${id}.bin?model=gfs&overlay=temperature`,
        },
      };
    },
  };
  const { api } = makeApi(
    { 'gev-history-cycles': CYCLES },
    { windReader: reader },
  );
  const path = slice(`feed=wind&t=${iso(RUN(13, 9))}&overlay=temperature`);
  const a = await call(api, path);
  assert.equal(a.status, 200);
  assert.equal(a.headers['x-history-degraded'], 'scalar_unavailable');
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.equal(a.headers.etag, undefined);
  assert.equal(a.headers['x-history-wind-id'], windGridId(a.json.gridUrl));
  assert.match(a.headers['x-history-wind-id'], /-wind-only$/);
  const grid = await call(api, a.headers['x-history-grid']);
  assert.equal(
    grid.headers['x-history-wind-id'],
    a.headers['x-history-wind-id'],
  );
  degraded = false;
  const b = await call(api, path);
  assert.equal(b.headers['x-history-degraded'], undefined);
  assert.equal(b.json.scalarError, undefined);
  assert.equal(b.headers['x-history-cache'], 'MISS');
  assert.doesNotMatch(b.headers['x-history-wind-id'], /wind-only/);
  const c = await call(api, path);
  assert.equal(c.headers['x-history-cache'], 'HIT');
  assert.equal(
    windGridId('/api/wind/grid/gfs-20261013-6-f3-1.bin?model=gfs'),
    'gfs-20261013-6-f3-1',
  );
  assert.equal(windGridId('/elsewhere/x.bin'), '');
});

// ---------------------------------------------------------------- imagery
const IMAGERY = fixture('b12c-imagery-es-docs.json').docs;
const LIVE_RADAR = JSON.parse(
  readFileSync(new URL('b15-collector-weather-radar.body', FIX), 'utf8'),
);

test('imagery shape: the recorded time list at t + the live static fields passes GEV validateWeatherSnapshot', async () => {
  const t = Date.UTC(2026, 9, 14, 12);
  const { api } = makeApi(
    { 'gev-history-imagery': IMAGERY },
    { now: t + 2 * HOUR },
  );
  const r = await call(api, slice(`feed=imagery&t=${iso(t)}&product=radar`));
  assert.equal(r.status, 200);
  const m = r.json;
  assert.equal(m.times.length, 13);
  assert.ok(m.times.every((x) => Date.parse(x) <= t));
  assert.equal(m.latest, m.times.at(-1));
  assert.equal(
    m.tileTemplate,
    `/api/weather/tile?product=radar&time=${encodeURIComponent(m.latest)}&z={z}&x={x}&y={y}`,
  );
  // the frames are exactly the 13 newest recorded (seen by t) in [t-24h, t]
  const expect = [
    ...new Set(
      IMAGERY.filter(
        (d) =>
          d.kind === 'nowcoast-time' &&
          d.product === 'radar' &&
          d.snap <= t &&
          Date.parse(d.time_available) <= t &&
          Date.parse(d.time_available) >= t - DAY,
      ).map((d) => iso(Date.parse(d.time_available))),
    ),
  ]
    .sort()
    .slice(-13);
  assert.deepEqual(m.times, expect);
  // the router merges the static product fields of the live manifest
  const {
    bounds,
    title,
    coverage,
    description,
    source,
    attribution,
    tileSize,
    maxLevel,
    tilingScheme,
    imageSize,
  } = LIVE_RADAR;
  const merged = {
    ...{
      bounds,
      title,
      coverage,
      description,
      source,
      attribution,
      tileSize,
      maxLevel,
      tilingScheme,
      imageSize,
    },
    ...m,
  };
  assert.equal(validateWeatherSnapshot(merged, 'radar'), merged);
  for (const k of [
    'times',
    'latest',
    'time',
    'observedAt',
    'fetchedAt',
    'stale',
    'unavailable',
    'reason',
    'tileTemplate',
    'imageUrl',
  ])
    assert.ok(Object.hasOwn(LIVE_RADAR, k), k);
  // no serving-path reader injected: availability is NOT claimed
  assert.equal(r.headers['x-history-pixels'], 'unknown');
  assert.equal(r.headers['x-history-pixels-basis'], 'unknown');
  assert.equal(r.headers['x-history-pixels-frames'], undefined);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers.etag, undefined);
});

// ---- imagery pixels vs GEV's REAL pixel route (review R1)
/** Real nowCOAST GetCapabilities captured 2026-10-14 17:35Z (all 3 services). */
const CAPS_AT = Date.parse('2026-10-14T17:35:00Z');
const CAPS = Object.fromEntries(
  ['weather_radar', 'satellite', 'lightning_detection'].map((s) => [
    s,
    readFileSync(new URL(`b12c-caps-${s}.xml`, FIX), 'utf8'),
  ]),
);
const PRODUCT_LAYER = {
  radar: ['weather_radar', 'conus_base_reflectivity_mosaic'],
  clouds: ['satellite', 'global_longwave_imagery_mosaic'],
  'clouds-regional': ['satellite', 'goes_longwave_imagery'],
  lightning: ['lightning_detection', 'ldn_lightning_strike_density'],
};
/** Every time a capabilities document lists for one layer. */
function capsTimes(xml, layer) {
  const at = xml.indexOf(`<Name>${layer}</Name>`);
  const dim = /<Dimension\b[^>]*name="time"[^>]*>([^<]*)</.exec(xml.slice(at));
  return dim[1].split(',').map((x) => iso(Date.parse(x.trim())));
}
/** The collector records each listed time once (snap = 1 min later). */
function recordedFrames(capsByService) {
  return Object.entries(PRODUCT_LAYER).flatMap(([product, [service, layer]]) =>
    capsTimes(capsByService[service], layer).map((time) => ({
      kind: 'nowcoast-time',
      product,
      layer,
      time_available: time,
      snap: Date.parse(time) + 60_000,
    })),
  );
}
/** A PNG header weather.js validatePng accepts (signature + IHDR size). */
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
/** A NOAA double: GetCapabilities from `capsOf()`, GetMap -> a valid PNG. */
function noaa(capsOf) {
  const seen = { caps: 0, map: 0 };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const service = /observations\/([a-z_]+)\/ows$/.exec(u.pathname)[1];
    const request = [...u.searchParams]
      .find(([k]) => k.toLowerCase() === 'request')[1]
      .toLowerCase();
    if (request === 'getcapabilities') {
      seen.caps += 1;
      const xml = capsOf()[service];
      return xml === undefined
        ? new Response('', { status: 503 })
        : new Response(xml, { headers: { 'content-type': 'text/xml' } });
    }
    seen.map += 1;
    return new Response(
      png(
        Number(u.searchParams.get('width')),
        Number(u.searchParams.get('height')),
      ),
      { headers: { 'content-type': 'image/png' } },
    );
  };
  return { fetchImpl, seen };
}
const tileOf = (product, time) =>
  `/tile?product=${product}&time=${encodeURIComponent(time)}&z=0&x=0&y=0`;

// ---- B12c review R1b: availability from the serving route's OWN state
/**
 * GEV's unchanged weatherProxy mounted at /api/weather on a REAL listening
 * socket (as server/providers/local.js mounts it), so the history reader's
 * loopback and the tile requests go through the same route instance.
 */
async function liveWeatherServer(fetchImpl, now) {
  let handler;
  weatherProxy({ fetchImpl, now }).configureServer({
    middlewares: { use: (_route, h) => (handler = h) },
  });
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/api/weather/')) {
      res.writeHead(404);
      return res.end();
    }
    req.url = req.url.slice('/api/weather'.length);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    async tile(product, time) {
      const r = await fetch(`${base}/api/weather${tileOf(product, time)}`);
      const body = Buffer.from(await r.arrayBuffer());
      let error = null;
      try {
        error = JSON.parse(body.toString('utf8')).error;
      } catch {
        /* png */
      }
      return { status: r.status, error };
    },
    async manifest(product) {
      const r = await fetch(`${base}/api/weather/manifest?product=${product}`);
      return r.json();
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
/** A loopback reader attached to `server` (the unbridged production wiring). */
function loopbackState(server, now) {
  const s = createWeatherServingState({ now });
  s.attachServer(server);
  return s;
}
const claimedOf = (r) =>
  (r.headers['x-history-pixels-frames'] ?? '').split(',').filter(Boolean);

test('imagery pixels: claimed frames are exactly the route manifest frames and every one renders (real caps, real weatherProxy, real loopback socket)', async () => {
  const now = () => CAPS_AT;
  const upstream = noaa(() => CAPS);
  const live = await liveWeatherServer(upstream.fetchImpl, now);
  try {
    const { api } = makeApi(
      { 'gev-history-imagery': recordedFrames(CAPS) },
      { now: CAPS_AT, weatherTimes: loopbackState(live.server, now) },
    );
    const states = {};
    for (const product of Object.keys(PRODUCT_LAYER))
      for (const ageH of [0.25, 0.5, 1, 1.5, 3, 6]) {
        const t = CAPS_AT - ageH * HOUR;
        const r = await call(
          api,
          slice(`feed=imagery&t=${iso(t)}&product=${product}`),
        );
        assert.equal(r.status, 200);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(r.headers.etag, undefined);
        assert.equal(r.headers['x-history-pixels-basis'], PIXELS_BASIS);
        assert.equal(r.headers['x-history-pixels-checked-at'], iso(CAPS_AT));
        assert.equal(r.headers['x-history-pixels-route-read-at'], iso(CAPS_AT));
        const claimed = claimedOf(r);
        const frames = r.json.times;
        assert.ok(frames.length > 0, `${product} ${ageH}h`);
        // the route's own list (newest 13 of its allowedTimes)
        const listed = (await live.manifest(product)).times;
        assert.deepEqual(
          claimed,
          frames.filter((x) => listed.includes(x)),
        );
        const older = frames.filter(
          (x) => listed.length === 13 && x < listed[0],
        );
        assert.equal(
          Number(r.headers['x-history-pixels-undetermined'] ?? 0),
          older.length,
        );
        for (const time of frames) {
          const tile = await live.tile(product, time);
          if (claimed.includes(time))
            // a claimed frame ALWAYS renders through the real route
            assert.equal(tile.status, 200, `${product} ${time}`);
          else if (!older.includes(time)) {
            // a frame called not renderable is refused by the real route
            assert.equal(tile.status, 400, `${product} ${time}`);
            assert.equal(tile.error, 'unknown_weather_time');
          } else if (tile.status !== 200) {
            // undetermined (older than the route's published list)
            assert.equal(tile.status, 400);
            assert.equal(tile.error, 'unknown_weather_time');
          }
        }
        assert.equal(
          r.headers['x-history-pixels'],
          claimed.length === frames.length
            ? 'available'
            : claimed.length
              ? 'partial'
              : older.length
                ? 'unknown'
                : 'unavailable',
        );
        if (!claimed.length && older.length)
          assert.equal(
            r.headers['x-history-pixels-reason'],
            'frames_older_than_route_list',
          );
        states[`${product}@${ageH}`] = r.headers['x-history-pixels'];
      }
    // the review's cases: radar / GOES regional 3 h back are NOT claimed
    // renderable (older than the route's list: unknown, never 'available')
    assert.equal(states['radar@3'], 'unknown');
    assert.equal(states['clouds-regional@3'], 'unknown');
    assert.equal(states['radar@0.25'], 'partial');
    // only the route's own reads (one per product, its TTL not run out),
    // never a second NOAA capabilities reader
    assert.equal(upstream.seen.caps, 4);
  } finally {
    await live.close();
  }
});

test('imagery pixels R1b: route on its 1 h stale fallback while upstream has moved on -> unknown, nothing claimed; recovery claims only what the route accepts', async () => {
  // the reviewer's case: the route read caps at 17:35Z; 30 min later its
  // refresh fails (it keeps the 17:35Z read, stale:true) while NOAA, for any
  // other reader, already lists seven newer 4-min frames
  const oldXml = CAPS.weather_radar;
  const listed = capsTimes(oldXml, PRODUCT_LAYER.radar[1]);
  const added = Array.from({ length: 7 }, (_, i) =>
    iso(Date.parse(listed.at(-1)) + (i + 1) * 4 * 60_000),
  );
  const newerXml = oldXml.replace(
    /(<Dimension\b[^>]*name="time"[^>]*>)([^<]*)(<\/Dimension>)/g,
    (_all, start, list, end) =>
      start + [...list.trim().split(','), ...added].join(',') + end,
  );
  let clock = CAPS_AT;
  let routeCaps = 'old'; // 'old' | 'fail' | 'new'
  const upstream = noaa(() =>
    routeCaps === 'fail'
      ? {}
      : { weather_radar: routeCaps === 'old' ? oldXml : newerXml },
  );
  const live = await liveWeatherServer(upstream.fetchImpl, () => clock);
  try {
    const all = [...listed, ...added];
    const { api } = makeApi(
      {
        'gev-history-imagery': all.map((time) => ({
          kind: 'nowcoast-time',
          product: 'radar',
          layer: PRODUCT_LAYER.radar[1],
          time_available: time,
          snap: Date.parse(time) + 60_000,
        })),
      },
      {
        clock: () => clock,
        weatherTimes: loopbackState(live.server, () => clock),
      },
    );
    const path = () => slice(`feed=imagery&t=${iso(clock)}&product=radar`);
    // prime the route at 17:35Z (fresh)
    const first = await call(api, path());
    assert.equal(first.headers['x-history-pixels'], 'partial');
    // +30 min: the route's refresh fails -> stale (its 1 h fallback)
    clock += 30 * 60_000;
    routeCaps = 'fail';
    const r = await call(api, path());
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-history-pixels'], 'unknown');
    assert.equal(
      r.headers['x-history-pixels-reason'],
      'serving_metadata_stale',
    );
    assert.equal(r.headers['x-history-pixels-basis'], 'unknown');
    assert.equal(r.headers['x-history-pixels-route-read-at'], iso(CAPS_AT));
    assert.equal(r.headers['x-history-pixels-frames'], undefined);
    // the recorded list itself still shows the newer frames (D3: the record)
    assert.ok(added.every((x) => r.json.times.includes(x)));
    // NOAA now has newer caps, but the route is still on its stale hold
    // (one attempt per 30 s): still unknown, never the newer list
    routeCaps = 'new';
    clock += 10_000;
    const held = await call(api, path());
    assert.equal(held.headers['x-history-pixels'], 'unknown');
    for (const time of held.json.times) {
      const tile = await live.tile('radar', time);
      assert.notEqual(tile.status, 200, `stale route never renders ${time}`);
    }
    // the route recovers (after its 30 s hold): claimed = what it accepts
    clock += 30_000;
    const ok = await call(api, path());
    assert.equal(ok.headers['x-history-pixels-route-read-at'], iso(clock));
    const claimed = claimedOf(ok);
    assert.ok(claimed.length > 0);
    assert.ok(added.every((x) => claimed.includes(x)));
    for (const time of claimed)
      assert.equal((await live.tile('radar', time)).status, 200, time);
    // the review's six frames are claimed only if the route accepts them
    for (const time of [
      '2026-10-14T17:32:00.000Z',
      '2026-10-14T17:36:00.000Z',
      '2026-10-14T17:40:00.000Z',
      '2026-10-14T17:44:00.000Z',
      '2026-10-14T17:48:00.000Z',
      '2026-10-14T17:52:00.000Z',
    ])
      if (claimed.includes(time))
        assert.equal((await live.tile('radar', time)).status, 200, time);
  } finally {
    await live.close();
  }
});

test('imagery pixels R1b: upstream moves on while the route still holds its cached read -> claims follow the ROUTE, not upstream', async () => {
  const oldXml = CAPS.weather_radar;
  const listed = capsTimes(oldXml, PRODUCT_LAYER.radar[1]);
  const added = [iso(Date.parse(listed.at(-1)) + 4 * 60_000)];
  const newerXml = oldXml.replace(
    /(<Dimension\b[^>]*name="time"[^>]*>)([^<]*)(<\/Dimension>)/g,
    (_all, start, list, end) =>
      start + [...list.trim().split(','), ...added].join(',') + end,
  );
  let clock = CAPS_AT;
  let xml = oldXml;
  const upstream = noaa(() => ({ weather_radar: xml }));
  const live = await liveWeatherServer(upstream.fetchImpl, () => clock);
  try {
    const { api } = makeApi(
      {
        'gev-history-imagery': [...listed, ...added].map((time) => ({
          kind: 'nowcoast-time',
          product: 'radar',
          layer: PRODUCT_LAYER.radar[1],
          time_available: time,
          snap: Date.parse(time) + 60_000,
        })),
      },
      {
        clock: () => clock,
        weatherTimes: loopbackState(live.server, () => clock),
      },
    );
    await call(api, slice(`feed=imagery&t=${iso(clock)}&product=radar`));
    xml = newerXml; // upstream moved on; the route's 2 min TTL still runs
    clock += 60_000;
    const r = await call(
      api,
      slice(`feed=imagery&t=${iso(clock)}&product=radar`),
    );
    assert.ok(r.json.times.includes(added[0]), 'recorded');
    assert.ok(!claimedOf(r).includes(added[0]), 'route does not list it yet');
    assert.equal((await live.tile('radar', added[0])).status, 400);
    for (const time of claimedOf(r))
      assert.equal((await live.tile('radar', time)).status, 200, time);
  } finally {
    await live.close();
  }
});

test('imagery pixels: no route state -> unknown with a reason (unattached, closed socket, unavailable route, bad answer, bridged without a route, TLS)', async () => {
  const t = CAPS_AT - 30 * 60_000;
  const q = slice(`feed=imagery&t=${iso(t)}&product=radar`);
  const data = { 'gev-history-imagery': recordedFrames(CAPS) };
  const expectUnknown = async (weatherTimes, reason) => {
    const { api } = makeApi(data, { now: CAPS_AT, weatherTimes });
    const r = await call(api, q);
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-history-pixels'], 'unknown', reason);
    assert.equal(r.headers['x-history-pixels-reason'], reason);
    assert.equal(r.headers['x-history-pixels-basis'], 'unknown');
    assert.equal(r.headers['x-history-pixels-frames'], undefined);
    return r;
  };
  await expectUnknown(null, 'serving_route_unreachable');
  await expectUnknown(
    createWeatherServingState({ now: () => CAPS_AT }),
    'serving_route_unreachable',
  );
  // the route itself cannot read caps: unavailable, and it 503s the tiles
  const down = noaa(() => ({}));
  const dead = await liveWeatherServer(down.fetchImpl, () => CAPS_AT);
  const r = await expectUnknown(
    loopbackState(dead.server, () => CAPS_AT),
    'serving_metadata_unavailable',
  );
  assert.equal((await dead.tile('radar', r.json.times[0])).status, 503);
  await dead.close();
  // the socket is gone
  await expectUnknown(
    loopbackState(dead.server, () => CAPS_AT),
    'serving_route_unreachable',
  );
  // something else answers /api/weather/manifest
  const bogus = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ product: 'radar', times: ['yesterday'] }));
  });
  await new Promise((done) => bogus.listen(0, '127.0.0.1', done));
  await expectUnknown(
    loopbackState(bogus, () => CAPS_AT),
    'serving_route_bad_answer',
  );
  await new Promise((done) => bogus.close(done));
  // bridged: the loopback would reach the COLLECTOR manifest, never used
  const calls = [];
  const bridged = createWeatherServingState({
    bridged: true,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('{}');
    },
  });
  bridged.attachServer({ listening: true, address: () => ({ port: 1 }) });
  await expectUnknown(bridged, 'serving_route_unreachable');
  assert.deepEqual(calls, []);
  // a TLS server is not called over plain http
  assert.equal(loopbackBase(new TlsServer()), null);
  assert.equal(
    loopbackBase({
      listening: true,
      address: () => ({ address: '::', port: 8080 }),
    }),
    'http://127.0.0.1:8080',
  );
  assert.equal(
    loopbackBase({
      listening: true,
      address: () => ({ address: '::1', port: 8080 }),
    }),
    'http://[::1]:8080',
  );
});

test('imagery pixels: a later check after the route moved on expires frames; never cached (no ETag, 304 or LRU)', async () => {
  const grid = Array.from({ length: 136 }, (_, i) =>
    iso(CAPS_AT - 6 * HOUR + i * 4 * 60_000),
  );
  const upTo = (ms) => grid.filter((x) => Date.parse(x) <= ms - 5 * 60_000);
  let clock = CAPS_AT;
  const upstream = noaa(() => ({ weather_radar: radarCaps(upTo(clock)) }));
  const live = await liveWeatherServer(upstream.fetchImpl, () => clock);
  try {
    const { api } = makeApi(
      {
        'gev-history-imagery': grid.map((time) => ({
          kind: 'nowcoast-time',
          product: 'radar',
          layer: PRODUCT_LAYER.radar[1],
          time_available: time,
          snap: Date.parse(time) + 60_000,
        })),
      },
      {
        clock: () => clock,
        weatherTimes: loopbackState(live.server, () => clock),
      },
    );
    const path = slice(
      `feed=imagery&t=${iso(CAPS_AT - 7 * 60_000)}&product=radar`,
    );
    const first = await call(api, path);
    assert.equal(first.headers['x-history-pixels'], 'available');
    assert.equal(first.headers['x-history-cache'], undefined);
    clock = CAPS_AT + 3 * HOUR;
    const second = await call(api, path, {
      headers: { 'if-none-match': '"anything"' },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body, first.body, 'the recorded list itself is fixed');
    // older than everything the route lists now: not claimed (unknown,
    // the route's unpublished allowedTimes tail could hold some)
    assert.equal(second.headers['x-history-pixels'], 'unknown');
    assert.equal(
      second.headers['x-history-pixels-reason'],
      'frames_older_than_route_list',
    );
    assert.equal(second.headers['x-history-pixels-frames'], undefined);
    assert.equal(second.headers['x-history-pixels-checked-at'], iso(clock));
    for (const time of second.json.times)
      assert.equal((await live.tile('radar', time)).status, 400);
  } finally {
    await live.close();
  }
});

/** A minimal radar GetCapabilities listing `times` (weather.js parses it). */
function radarCaps(times) {
  const box = [
    ['westBoundLongitude', -130],
    ['eastBoundLongitude', -60],
    ['southBoundLatitude', 20],
    ['northBoundLatitude', 55],
  ]
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return `<WMS_Capabilities><Capability><Layer><Title>radar</Title><Layer><Name>${PRODUCT_LAYER.radar[1]}</Name><EX_GeographicBoundingBox>${box}</EX_GeographicBoundingBox><Dimension name="time" default="${times.at(-1)}" units="ISO8601">${times.join(',')}</Dimension></Layer></Layer></Capability></WMS_Capabilities>`;
}

test('pixelAvailability: only frames the route lists are claimed; stale / unavailable / unread -> unknown', () => {
  const at = Date.UTC(2026, 9, 14, 12);
  const step = 4 * 60_000;
  const list = (n) =>
    Array.from({ length: n }, (_, i) => iso(at - (n - 1 - i) * step));
  const times = list(13);
  const state = (extra = {}) => ({
    times,
    fetchedAt: at,
    checkedAt: at,
    stale: false,
    unavailable: false,
    marginMs: 120_000,
    ...extra,
  });
  assert.deepEqual(pixelAvailability(times, state(), at).renderable, times);
  assert.equal(pixelAvailability(times, state(), at).state, 'available');
  const older = list(20).slice(0, 7);
  const mixed = pixelAvailability([...older, ...times], state(), at);
  assert.equal(mixed.state, 'partial');
  assert.deepEqual(mixed.renderable, times);
  // older than a FULL published list: may be in the route's unpublished
  // allowedTimes tail -> undetermined, never called unavailable
  assert.deepEqual(mixed.undetermined, older);
  const old = pixelAvailability(older, state(), at);
  assert.equal(old.state, 'unknown');
  assert.equal(old.reason, 'frames_older_than_route_list');
  // a short list is the whole allowedTimes: older frames do not render
  const short = state({ times: times.slice(-5) });
  assert.equal(pixelAvailability(older, short, at).state, 'unavailable');
  // within the list's span but not listed, or newer: does not render
  const gap = [iso(at - 2 * step - 60_000), iso(at + step)];
  const g = pixelAvailability(gap, state(), at + step);
  assert.equal(g.state, 'unavailable');
  assert.deepEqual(g.undetermined, []);
  // the 24 h limit: within the route TTL of it undetermined, past it refused
  const r = pixelAvailability(
    times,
    state(),
    Date.parse(times[2]) + DAY - 60_000,
  );
  assert.deepEqual(r.renderable, times.slice(3));
  assert.deepEqual(r.undetermined, times.slice(2, 3));
  const past = pixelAvailability(
    times.slice(0, 1),
    state(),
    Date.parse(times[0]) + DAY + 1,
  );
  assert.equal(past.state, 'unavailable');
  for (const [s, reason] of [
    [state({ stale: true }), 'serving_metadata_stale'],
    [state({ unavailable: true, times: [] }), 'serving_metadata_unavailable'],
    [{ error: 'serving_route_unreachable' }, 'serving_route_unreachable'],
    [null, 'serving_route_unreachable'],
    [{ fetchedAt: at }, 'serving_route_bad_answer'],
  ]) {
    const p = pixelAvailability(times, s, at);
    assert.equal(p.state, 'unknown', reason);
    assert.equal(p.reason, reason);
    assert.deepEqual(p.renderable, []);
  }
  assert.equal(pixelAvailability([], null, at).state, 'unavailable');
});

test('imagery pixels bridged: judged by the bridge PRIVATE weatherProxy instance (in-process manifest), never the loopback; collector STALE -> unknown', async () => {
  let clock = CAPS_AT;
  let collectorStale = false;
  const reads = [];
  const imagery = createWeatherImagery({
    readCollector: async (feed) => {
      reads.push(feed);
      return {
        ok: true,
        body: new TextEncoder().encode(CAPS.weather_radar),
        headers: collectorStale ? { 'X-Feed-Cache': 'STALE' } : {},
      };
    },
    liveFetch: noaa(() => CAPS).fetchImpl,
    now: () => clock,
    weatherProxy,
  });
  const loopbackCalls = [];
  const weatherTimes = createWeatherServingState({
    bridged: true,
    now: () => clock,
    fetchImpl: async (url) => {
      loopbackCalls.push(url);
      throw new Error('loopback must not be used when bridged');
    },
  });
  weatherTimes.attachRoute(imagery.manifest);
  const { api } = makeApi(
    { 'gev-history-imagery': recordedFrames(CAPS) },
    { clock: () => clock, weatherTimes },
  );
  const tile = async (time) => {
    const res = {
      statusCode: 0,
      writeHead(s) {
        this.statusCode = s;
      },
      once() {},
      removeListener() {},
      end() {
        this.resolve();
      },
    };
    const done = new Promise((r) => (res.resolve = r));
    imagery.handle({ method: 'GET', url: tileOf('radar', time) }, res);
    await done;
    return res.statusCode;
  };
  const r = await call(
    api,
    slice(`feed=imagery&t=${iso(clock - 20 * 60_000)}&product=radar`),
  );
  assert.equal(r.headers['x-history-pixels-basis'], PIXELS_BASIS);
  const claimed = claimedOf(r);
  assert.ok(claimed.length > 0);
  for (const time of claimed) assert.equal(await tile(time), 200, time);
  assert.ok(reads.every((f) => f === 'nowcoast-caps-weather-radar'));
  // the collector snapshot goes STALE: the private route keeps its read as
  // stale (1 h) -> unknown, nothing claimed
  clock += 3 * 60_000;
  collectorStale = true;
  const s = await call(
    api,
    slice(`feed=imagery&t=${iso(clock - 20 * 60_000)}&product=radar`),
  );
  assert.equal(s.headers['x-history-pixels'], 'unknown');
  assert.equal(s.headers['x-history-pixels-reason'], 'serving_metadata_stale');
  assert.deepEqual(loopbackCalls, []);
});

test('imagery pixels wiring: the bridge attaches its private route; the history API plugin attaches its own server', () => {
  const attached = [];
  createCollectorBridge({
    name: 'weather',
    urls: ['http://c1:4180'],
    weatherProxy,
    weatherServing: { attachRoute: (fn) => attached.push(['route', fn]) },
  });
  assert.equal(attached.length, 1);
  assert.equal(typeof attached[0][1], 'function');
  const httpServer = { listening: false };
  const plugin = historyApiPlugin({
    env: ENV,
    weatherTimes: { attachServer: (s) => attached.push(['server', s]) },
  });
  plugin.configurePreviewServer({
    config: { preview: {}, server: {} },
    httpServer,
    middlewares: { use() {} },
  });
  assert.deepEqual(attached[1], ['server', httpServer]);
});

test('imagery: before the first record -> an unavailable manifest (valid for the layer) + reason', async () => {
  const first = Math.min(
    ...IMAGERY.filter((d) => d.product === 'radar').map((d) => d.snap),
  );
  const { api } = makeApi({ 'gev-history-imagery': IMAGERY });
  const r = await call(
    api,
    slice(`feed=imagery&t=${iso(first - 60_000)}&product=radar`),
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.unavailable, true);
  assert.deepEqual(r.json.times, []);
  assert.equal(r.headers['x-history-empty-reason'], 'before_recording_start');
  assert.equal(validateWeatherSnapshot(r.json, 'radar'), r.json);
});

test('imagery daily: newest GIBS / CMR available day per layer as recorded by t', async () => {
  const t = Date.UTC(2026, 9, 13, 12);
  const { api } = makeApi({ 'gev-history-imagery': IMAGERY });
  const r = await call(api, slice(`feed=imagery&t=${iso(t)}&product=daily`));
  const daily = IMAGERY.filter(
    (d) => d.kind !== 'nowcoast-time' && d.snap <= t,
  );
  assert.ok(daily.length > 0);
  assert.equal(r.json.layers.length, new Set(daily.map((d) => d.layer)).size);
  for (const l of r.json.layers) {
    const mine = daily
      .filter((d) => d.layer === l.layer)
      .sort((a, b) => b.snap - a.snap)[0];
    assert.equal(l.latest, iso(Date.parse(mine.time_available)));
    assert.equal(l.recordedAt, iso(mine.snap));
  }
  const later = await call(
    api,
    slice(`feed=imagery&t=${iso(t + DAY)}&product=daily`),
  );
  const vi = later.json.layers.find((l) => l.product === 'VIIRS');
  assert.equal(vi.latest, '2026-10-13T00:00:00.000Z');
});

// ------------------------------------------------------------------ cache
test('cache: gp CSV is cached with its own Content-Type (ETag, 304); 404 not_recorded and wind grids are never cached', async () => {
  const P1 = Date.UTC(2026, 9, 12, 18);
  const { api, fake } = makeApi(
    {
      'gev-history-gp': [elset(1, P1 - HOUR, P1)],
      'gev-history-cycles': CYCLES,
    },
    { windReader: fakeWindReader() },
  );
  const path = slice(`feed=gp&t=${iso(P1 + HOUR)}&group=active`);
  const a = await call(api, path);
  assert.equal(a.headers['x-history-cache'], 'MISS');
  assert.match(a.headers['cache-control'], /private, max-age=300/);
  const n = esSearches(fake).length;
  const b = await call(api, path);
  assert.equal(b.headers['x-history-cache'], 'HIT');
  assert.match(b.headers['content-type'], /^text\/plain/);
  assert.equal(b.body, a.body);
  assert.equal(esSearches(fake).length, n);
  const c = await call(api, path, {
    headers: { 'if-none-match': a.headers.etag },
  });
  assert.equal(c.status, 304);
  const grid = slice(`feed=wind&t=${iso(RUN(13, 9))}&part=grid`);
  assert.equal((await call(api, grid)).headers['cache-control'], 'no-store');
  assert.equal((await call(api, grid)).headers['x-history-cache'], undefined);
});

test('every B12c ES request targets an allowlisted index or the auth endpoint', async () => {
  const P1 = Date.UTC(2026, 9, 12, 18);
  const { api, fake } = makeApi(
    {
      'gev-history-gp': [elset(1, P1 - HOUR, P1)],
      'gev-history-cycles': CYCLES,
      'gev-history-imagery': IMAGERY,
      'gev-history-quakes': [quake('x', P1, P1)],
    },
    { windReader: fakeWindReader() },
  );
  for (const q of [
    `feed=gp&t=${iso(P1 + HOUR)}&group=active`,
    `feed=quakes&t=${iso(P1 + HOUR)}`,
    `feed=wind&t=${iso(RUN(13, 9))}`,
    `feed=imagery&t=${iso(RUN(14, 12))}&product=radar`,
    `feed=imagery&t=${iso(RUN(14, 12))}&product=daily`,
  ])
    assert.equal((await call(api, slice(q))).status, 200, q);
  const allowed = new Set(Object.values(HISTORY_INDICES));
  for (const c of fake.calls) {
    if (c.path === '/_security/_authenticate') continue;
    assert.ok(allowed.has(c.path.slice(1, -8)), c.path);
  }
});
