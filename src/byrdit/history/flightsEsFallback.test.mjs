import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  FLIGHTS_ES_FALLBACK_LOOKBACK_MS,
  FLIGHTS_ES_FALLBACK_MAX_ROWS,
  FLIGHTS_ES_FALLBACK_CACHE_MAX_ENTRIES,
  FLIGHTS_ES_FALLBACK_NEGATIVE_CACHE_MS,
  FLIGHTS_ES_FALLBACK_MAX_QUERIES,
  flightsEsFallbackConfigFromEnv,
  flightsEsFallbackFromEnv,
  createFlightsEsFallback,
} from './flightsEsFallback.js';
import { COLLAPSE_MAX_QUERIES } from './historyCollapse.js';
import { feedDisplayState } from './staleness.js';
import { historyPlugins } from './index.js';

/**
 * Owner-approved Option 1 (flights ES-only fallback): when the collector AND
 * the bridge's per-view last-good copy are unavailable, /api/flights may be
 * served from a bounded read of the recorded OpenSky history index
 * (gev-history-aircraft-opensky): lookback <= 15 min, a valid viewport,
 * newest position per aircraft, an OpenSky-compatible {time, states}
 * envelope, STALE + grey headers, and an in-memory preference for a recent
 * answer. Failure keeps the bridge's no-fallthrough rule: the upstream
 * OpenSky / adsb.lol plugins are never reached.
 */

const VIEW = '-100,29,-95,33';
const VIEW_MS = Date.UTC(2026, 10, 8, 12, 0, 0);

function doc({
  icao24 = 'a1b2c3',
  ts = VIEW_MS - 10_000,
  lon = -97.5,
  lat = 30.2,
  callsign = 'TEST1   ',
} = {}) {
  return {
    icao24,
    callsign,
    origin_country: 'United States',
    '@timestamp': typeof ts === 'number' ? ts : Date.parse(ts),
    location: { lat, lon },
    baro_alt_m: 914.4,
    geo_alt_m: 944.88,
    on_ground: false,
    velocity_ms: 102.9,
    track_deg: 90,
    vert_rate_ms: 0,
    squawk: '1200',
    position_source: 0,
    category: 3,
    source: 'opensky',
  };
}

function esSearchHits(docs) {
  return {
    took: 1,
    timed_out: false,
    _shards: { failed: 0, successful: 1, total: 1 },
    hits: {
      hits: docs.map((d, i) => ({
        _id: `doc${i}`,
        fields: { icao24: [d.icao24] },
        _source: d,
      })),
    },
  };
}

function fakeEs(docs) {
  const calls = [];
  return {
    calls,
    async search(index, body) {
      calls.push({ index, body });
      return esSearchHits(docs);
    },
  };
}

test('config: flag + reader-key ES settings together, never otherwise', () => {
  assert.equal(flightsEsFallbackConfigFromEnv({}), null);
  assert.equal(
    flightsEsFallbackConfigFromEnv({
      GEV_BRIDGE_FLIGHTS_ES_FALLBACK: '1',
    }),
    null,
    'flag without ES settings',
  );
  assert.equal(
    flightsEsFallbackConfigFromEnv({
      GEV_HISTORY_ES_URL: 'http://127.0.0.1:9200',
      GEV_HISTORY_ES_API_KEY: 'k',
    }),
    null,
    'ES settings without the flag',
  );
  const config = flightsEsFallbackConfigFromEnv({
    GEV_BRIDGE_FLIGHTS_ES_FALLBACK: '1',
    GEV_HISTORY_ES_URL: 'http://127.0.0.1:9200',
    GEV_HISTORY_ES_API_KEY: 'k',
  });
  assert.ok(config);
  assert.equal(config.es.url, 'http://127.0.0.1:9200');
  assert.equal(config.es.apiKey, 'k');
  assert.equal(flightsEsFallbackFromEnv({}), null);
});

test('reader: without a valid view the fallback does not read ES', async () => {
  const es = fakeEs([doc()]);
  const reader = createFlightsEsFallback({ es, now: () => VIEW_MS });
  assert.equal(await reader.read(makeUrl('/api/flights?lat=30&lon=-97')), null);
  assert.equal(es.calls.length, 0);
});

test('reader: lookback 15 min, valid viewport, OpenSky-compatible envelope', async () => {
  const docs = [
    doc({ ts: VIEW_MS - 10_000 }),
    doc({ icao24: 'def456', ts: VIEW_MS - 300_000, lon: -96.0, lat: 30.5 }),
  ];
  const es = fakeEs(docs);
  const reader = createFlightsEsFallback({ es, now: () => VIEW_MS });
  const answer = await reader.read(makeUrl(`/api/flights?view=${VIEW}`));
  assert.ok(answer);
  // the collapse reader probes the keys, then reads the docs of one part
  assert.deepEqual(
    es.calls.map((c) => c.index),
    ['gev-history-aircraft-opensky', 'gev-history-aircraft-opensky'],
  );
  const filter = es.calls[0].body.query.bool.filter;
  const timeRange = filter.find((c) => c.range?.['@timestamp']);
  assert.equal(timeRange.range['@timestamp'].gte, VIEW_MS - FLIGHTS_ES_FALLBACK_LOOKBACK_MS);
  assert.equal(timeRange.range['@timestamp'].lte, VIEW_MS);
  assert.equal(FLIGHTS_ES_FALLBACK_LOOKBACK_MS, 15 * 60_000);
  const box = filter.find((c) => c.geo_bounding_box?.location);
  const geo = box.geo_bounding_box.location;
  assert.equal(geo.top_left.lon, -100);
  assert.equal(geo.top_left.lat, 33);
  assert.equal(geo.bottom_right.lon, -95);
  assert.equal(geo.bottom_right.lat, 29);
  // envelope: {time} in seconds, states 18-19 wide, per aircraft
  const body = JSON.parse(answer.body);
  assert.equal(body.time, Math.round((VIEW_MS - 10_000) / 1000));
  assert.deepEqual(
    body.states.map((s) => [s[0], s[5], s[6], s[3]]),
    [
      ['a1b2c3', -97.5, 30.2, Math.round((VIEW_MS - 10_000) / 1000)],
      ['def456', -96, 30.5, Math.round((VIEW_MS - 300_000) / 1000)],
    ],
  );
  for (const state of body.states) {
    assert.ok(state.length === 18 || state.length === 19);
    assert.equal(state[8], false, 'on_ground read from the doc');
  }
  assert.equal(answer.lastOkAt, VIEW_MS - 10_000);
});

test('reader: no recent positions -> null (the bridge then serves 503)', async () => {
  const reader = createFlightsEsFallback({
    es: fakeEs([]),
    now: () => VIEW_MS,
  });
  assert.equal(await reader.read(makeUrl(`/api/flights?view=${VIEW}`)), null);
});

test('reader: a recent answer is reused from memory while fresh', async () => {
  const es = fakeEs([doc()]);
  const reader = createFlightsEsFallback({
    es,
    now: () => VIEW_MS,
    cacheMs: 30_000,
  });
  const first = await reader.read(makeUrl(`/api/flights?view=${VIEW}`));
  const callsAfterFirst = es.calls.length;
  const second = await reader.read(
    makeUrl(`/api/flights?vsid=tab-x&view=${VIEW}`),
  );
  assert.ok(first && second);
  assert.equal(second.body, first.body, 'the in-memory response is served');
  assert.equal(es.calls.length, callsAfterFirst, 'no second ES read');
  const third = await reader.read(makeUrl(`/api/flights?view=${VIEW}`));
  assert.ok(third);
  assert.equal(es.calls.length, callsAfterFirst, 'still fresh');
  // a different view is its own memory slot
  const other = await reader.read(makeUrl('/api/flights?view=0,45,10,55'));
  assert.ok(other);
  assert.equal(es.calls.length, callsAfterFirst + 2, 'separate view, new read');
});

test('reader: concurrent same-view reads share one ES read', async () => {
  const es = fakeEs([doc()]);
  const reader = createFlightsEsFallback({ es, now: () => VIEW_MS });
  const [a, b] = await Promise.all([
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
  ]);
  assert.ok(a && b);
  assert.equal(es.calls.length < 4, true, 'shared, not duplicated');
});

test('reader: bounded row count and an antimeridian view pass through', async () => {
  const docs = Array.from({ length: FLIGHTS_ES_FALLBACK_MAX_ROWS + 5 }, (_, i) =>
    doc({ icao24: String(i).padStart(6, '0'), ts: VIEW_MS - 10_000 - i }),
  );
  // review: the fake honours each collapse request's partition range, so
  // the collected hits are the real newest-per-icao24 set, not duplicates
  const es = rangedFakeEs(docs);
  const reader = createFlightsEsFallback({ es, now: () => VIEW_MS });
  const answer = await reader.read(makeUrl('/api/flights?view=178,10,-178,20'));
  const body = JSON.parse(answer.body);
  assert.equal(FLIGHTS_ES_FALLBACK_MAX_ROWS, 5_000);
  assert.ok(body.states.length <= FLIGHTS_ES_FALLBACK_MAX_ROWS);
  assert.ok(answer.truncated, 'over-cap read is marked truncated');
  // distinct aircraft only: no partition returned another's docs
  const ids = new Set(body.states.map((s) => s[0]));
  assert.equal(ids.size, body.states.length, 'no duplicate aircraft');
  const geo = es.calls[0].body.query.bool.filter.find(
    (c) => c.geo_bounding_box?.location,
  ).geo_bounding_box.location;
  assert.equal(geo.top_left.lon, 178);
  assert.equal(geo.bottom_right.lon, -178);
});

test('reader: all-invalid docs -> null', async () => {
  const bad = doc();
  delete bad.icao24;
  const reader = createFlightsEsFallback({
    es: fakeEs([bad]),
    now: () => VIEW_MS,
  });
  assert.equal(await reader.read(makeUrl(`/api/flights?view=${VIEW}`)), null);
});

// ---- plugin wiring (real collectorBridgePlugin through historyPlugins) ----

function makeUrl(rest) {
  return new URL(`http://localhost${rest}`);
}

/** A broken collector: every route dies so the bridge's fallback decides. */
async function deadPort() {
  return 'http://127.0.0.1:9';
}

/** Small ES stand-in answering the two endpoints the client may call. */
async function startEs(t, docs) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method, url: req.url, body });
      if (req.url === '/_security/_authenticate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authentication_type: 'api_key',
            api_key: { name: 'gev-history-reader' },
          }),
        );
        return;
      }
      if (/^\/gev-history-aircraft-opensky\/_search/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(esSearchHits(docs)));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  t.after(() => (server.listening ? stop() : undefined));
  return { url: `http://127.0.0.1:${server.address().port}`, stop, calls };
}

function chain(env, now) {
  const stack = [];
  const server = {
    middlewares: { use: (route, handler) => stack.push({ route, handler }) },
  };
  for (const plugin of historyPlugins({ env, now, log: () => {} }))
    plugin.configureServer?.(server);
  return async (path, method = 'GET') => {
    let done;
    const finished = new Promise((resolve) => (done = resolve));
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
      },
      end(body) {
        this.body = body === undefined ? undefined : Buffer.from(body);
        done();
      },
    };
    const dispatch = (i) => {
      for (; i < stack.length; i++) {
        const { route, handler } = stack[i];
        if (path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`)) {
          let rest = path.slice(route.length) || '/';
          if (rest.startsWith('?')) rest = `/${rest}`;
          handler({ url: rest, method }, res, () => {});
          return;
        }
      }
      res.writeHead(404, {});
      res.end('no route');
    };
    dispatch(0);
    await finished;
    return res;
  };
}

function envFor(collectorUrl, esUrl, extra = {}) {
  return {
    GEV_BRIDGE_FLIGHTS: '1',
    GEV_COLLECTOR_URLS: collectorUrl,
    GEV_COLLECTOR_TIMEOUT_MS: '200',
    ...(esUrl
      ? {
          GEV_BRIDGE_FLIGHTS_ES_FALLBACK: '1',
          GEV_HISTORY_ES_URL: esUrl,
          GEV_HISTORY_ES_API_KEY: 'test-key',
        }
      : {}),
    ...extra,
  };
}

function blockUpstream(t, allowed) {
  const real = globalThis.fetch;
  const blocked = [];
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (allowed.includes(url.origin)) return real(input, init);
    blocked.push(url.href);
    return Promise.reject(new Error(`network blocked: ${url.origin}`));
  });
  return blocked;
}

test('PLUGIN: collector + cache gone -> ES fallback 200, grey STALE headers, chip, no upstream', async (t) => {
  const collector = await deadPort();
  const es = await startEs(t, [doc()]);
  const blocked = blockUpstream(t, [es.url]);
  let nowMs = VIEW_MS;
  const get = chain(envFor(collector, es.url), () => nowMs);
  const r = await get(`/api/flights?lat=30&lon=-97&view=${VIEW}&vsid=tab-aaaaaaa1`);
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body.toString());
  assert.equal(body.states.length, 1);
  assert.equal(body.states[0][0], 'a1b2c3');
  assert.equal(r.headers['x-feed-cache'], 'STALE');
  assert.equal(r.headers['x-feed-bridge'], 'es-fallback');
  assert.equal(r.headers['x-feed-reason'], 'es_fallback');
  assert.equal(r.headers['x-feed-last-ok'], String(VIEW_MS - 10_000));
  assert.equal(r.headers['x-feed-stale-since'], String(VIEW_MS - 10_000));
  assert.equal(
    r.headers['x-feed-grey-until'],
    String(VIEW_MS - 10_000 + 3_600_000),
  );
  assert.ok(/history/.test(r.headers['x-flight-coverage'] ?? ''), 'coverage names the fallback');
  const d = feedDisplayState({ status: r.statusCode, headers: r.headers });
  assert.equal(d.state, 'grey');
  assert.equal(d.draw, true, 'grey draws the recorded positions');
  assert.equal(d.chip, `No data since ${shortClock(VIEW_MS - 10_000)}`);
  for (const url of blocked) {
    assert.ok(!url.includes('opensky-network.org'), `OpenSky reached: ${url}`);
    assert.ok(!url.includes('adsb.lol'), `adsb.lol reached: ${url}`);
  }
  assert.ok(
    blocked.every((url) => url.startsWith(collector)),
    `only the collector was contacted: ${blocked.join(' ')}`,
  );
});

test('PLUGIN: a second request within the TTL reuses the in-memory ES answer', async (t) => {
  const collector = await deadPort();
  const es = await startEs(t, [doc()]);
  blockUpstream(t, [es.url]);
  let nowMs = VIEW_MS;
  const get = chain(envFor(collector, es.url), () => nowMs);
  const a = await get(`/api/flights?view=${VIEW}&vsid=tab-bbbbbbb1`);
  nowMs += 5_000;
  const b = await get(`/api/flights?view=${VIEW}&vsid=tab-bbbbbbb1`);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.ok(
    b.body.equals(a.body),
    'the same body, no second ES search',
  );
  const searches = es.calls.filter((c) => c.url.includes('_search')).length;
  assert.ok(searches <= 2, `one ES read (probe + docs), got ${es.calls.length} calls`);
});

test('PLUGIN: ES down -> 503 no snapshot, still no upstream fallthrough', async (t) => {
  const collector = await deadPort();
  const blocked = blockUpstream(t, []);
  const get = chain(envFor(collector, 'http://127.0.0.1:9'), () => VIEW_MS);
  const r = await get(`/api/flights?view=${VIEW}&vsid=tab-ccccccc1`);
  assert.equal(r.statusCode, 503);
  assert.equal(r.headers['x-feed-bridge'], 'none');
  assert.equal(r.headers['x-feed-reason'], 'collector_down');
  assert.ok(
    blocked.every((url) => !url.includes('opensky-network.org') && !url.includes('adsb.lol')),
    `no upstream contacted: ${blocked.join(' ')}`,
  );
});

test('PLUGIN: flag off -> unchanged 503 behaviour, ES never touched', async (t) => {
  const collector = await deadPort();
  const es = await startEs(t, [doc()]);
  blockUpstream(t, [es.url]);
  const get = chain(envFor(collector, es.url, { GEV_BRIDGE_FLIGHTS_ES_FALLBACK: '0' }), () => VIEW_MS);
  const r = await get(`/api/flights?view=${VIEW}&vsid=tab-ddddddd1`);
  assert.equal(r.statusCode, 503);
  assert.equal(es.calls.length, 0, 'no ES request');
});

test('PLUGIN: no view parameter -> 503, no ES read (viewless slot unchanged)', async (t) => {
  const collector = await deadPort();
  const es = await startEs(t, [doc()]);
  blockUpstream(t, [es.url]);
  const get = chain(envFor(collector, es.url), () => VIEW_MS);
  const r = await get('/api/flights?lat=30&lon=-97');
  assert.equal(r.statusCode, 503);
  assert.equal(es.calls.length, 0);
});

test('PLUGIN: ES has no recent positions -> 503 (chip "No data")', async (t) => {
  const collector = await deadPort();
  const es = await startEs(t, []);
  blockUpstream(t, [es.url]);
  const get = chain(envFor(collector, es.url), () => VIEW_MS);
  const r = await get(`/api/flights?view=${VIEW}&vsid=tab-eeeeeee1`);
  assert.equal(r.statusCode, 503);
});

function shortClock(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  }).formatToParts(new Date(epochMs));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

// ---- review: the per-view ES answer cache is a bounded LRU with expiry,
// and negative answers are cached briefly so a stalled request cannot
// hammer ES ----

test('reader: the per-view cache is a bounded LRU (the least recently used view is evicted)', async () => {
  const es = fakeEs([doc()]);
  let nowMs = VIEW_MS;
  const reader = createFlightsEsFallback({
    es,
    now: () => nowMs,
    cacheMs: 60_000,
    cacheMaxEntries: 2,
  });
  const read = async (view) => reader.read(makeUrl(`/api/flights?view=${view}`));
  // one fresh view costs exactly one probe + one part read for a one-doc view
  await read('0,45,10,55'); // V1: 2 calls
  assert.equal(es.calls.length, 2, 'V1 cost 2 calls');
  await read('1,46,11,56'); // V2: +2 calls
  assert.equal(es.calls.length, 4);
  await read('2,47,12,57'); // V3: +2, evicts V1
  assert.equal(es.calls.length, 6);
  await read('0,45,10,55'); // V1 was evicted: still 6, then re-read
  assert.ok(es.calls.length >= 7, 'the evicted view is re-read from ES');
  const afterV1 = es.calls.length;
  await read('2,47,12,57'); // V3: still cached (touched above, then re-read)
  assert.equal(es.calls.length, afterV1, 'V3 stays cached, no new ES read');
  await read('1,46,11,56'); // V2 was evicted by V1's re-insertion -> re-read
  assert.ok(es.calls.length > afterV1, 'LRU order, not FIFO-all');
});

test('reader: a read touches its slot, so touching beats newer entries in the LRU', async () => {
  const es = fakeEs([doc()]);
  let nowMs = VIEW_MS;
  const reader = createFlightsEsFallback({
    es,
    now: () => nowMs,
    cacheMs: 60_000,
    cacheMaxEntries: 2,
  });
  const read = async (view) => reader.read(makeUrl(`/api/flights?view=${view}`));
  await read('0,45,10,55'); // V1
  await read('1,46,11,56'); // V2
  await read('0,45,10,55'); // touch V1: now V2 is the oldest
  const after = es.calls.length;
  await read('2,47,12,57'); // V3 -> V2 evicted (not the touched V1)
  const afterV3 = es.calls.length;
  assert.ok(afterV3 > after, 'the newest view was read');
  await read('0,45,10,55'); // the touched V1 SURVIVED the eviction
  assert.equal(es.calls.length, afterV3, 'the touched V1 is still cached, no ES read');
  await read('1,46,11,56'); // V2 was evicted -> re-read
  assert.ok(es.calls.length > afterV3, 'the untouched older entry was evicted first');
});

test('reader: cached answers expire (a slot older than cacheMs is not served)', async () => {
  const es = fakeEs([doc()]);
  let nowMs = VIEW_MS;
  const reader = createFlightsEsFallback({
    es,
    now: () => nowMs,
    cacheMs: 30_000,
    cacheMaxEntries: 8,
  });
  await reader.read(makeUrl(`/api/flights?view=0,45,10,55`));
  const after = es.calls.length;
  nowMs += 31_000;
  await reader.read(makeUrl(`/api/flights?view=0,45,10,55`));
  assert.ok(es.calls.length > after, 'an expired answer is re-read, not served');
});

test('reader: a negative answer (no rows) is cached briefly, so a stalled request cannot hammer ES', async () => {
  const es = fakeEs([]);
  let nowMs = VIEW_MS;
  const reader = createFlightsEsFallback({
    es,
    now: () => nowMs,
    negativeMs: 10_000,
  });
  const view = '0,45,10,55';
  assert.equal(
    await reader.read(makeUrl(`/api/flights?view=${view}`)),
    null,
  );
  const after = es.calls.length;
  assert.equal(
    await reader.read(makeUrl(`/api/flights?view=${view}`)),
    null,
    'the negative answer is served from memory',
  );
  assert.equal(es.calls.length, after, 'no second ES read within the window');
  nowMs += 10_001;
  await reader.read(makeUrl(`/api/flights?view=${view}`));
  assert.ok(es.calls.length > after, 'the negative entry expires and is re-read');
});

test('reader: the bounded cache caps stay module-level defaults', () => {
  assert.equal(typeof FLIGHTS_ES_FALLBACK_CACHE_MAX_ENTRIES, 'number');
  assert.equal(FLIGHTS_ES_FALLBACK_CACHE_MAX_ENTRIES >= 16, true);
  assert.equal(typeof FLIGHTS_ES_FALLBACK_NEGATIVE_CACHE_MS, 'number');
  assert.equal(FLIGHTS_ES_FALLBACK_NEGATIVE_CACHE_MS >= 1_000, true);
});

// ---- review: an ES load bound, a whole-read deadline and a brief failure
// cache so an outage or a panning tab cannot hammer the cluster ----

test('reader: a fields-only page (doc values, no _source) is read like a _source page', async () => {
  // What filter_path actually returns for the collapse read: _id + fields
  // (doc values), never _source. location comes back "lat, lon", @timestamp
  // as an epoch_millis string, keywords as arrays.
  const fields = {
    icao24: ['a1b2c3'],
    '@timestamp': [String(VIEW_MS - 10_000)],
    location: ['30.2, -97.5'],
    callsign: ['TEST1   '],
    origin_country: ['United States'],
    baro_alt_m: [914.4],
    geo_alt_m: [944.88],
    on_ground: [false],
    velocity_ms: [102.9],
    track_deg: [90],
    vert_rate_ms: [0],
    squawk: ['1200'],
    position_source: [0],
    category: ['3'],
    source: ['opensky'],
  };
  const calls = [];
  const es = {
    async search(index, body) {
      calls.push({ index, body });
      return {
        took: 1,
        timed_out: false,
        _shards: { failed: 0, successful: 1, total: 1 },
        hits: { hits: [{ _id: 'doc0', fields }] },
      };
    },
  };
  const reader = createFlightsEsFallback({ es, now: () => VIEW_MS });
  const answer = await reader.read(makeUrl(`/api/flights?view=${VIEW}`));
  assert.ok(answer, 'the doc-value page is understood');
  const body = JSON.parse(answer.body);
  assert.deepEqual(
    body.states.map((s) => [s[0], s[5], s[6], s[3], s[4]]),
    [['a1b2c3', -97.5, 30.2, Math.round((VIEW_MS - 10_000) / 1000), Math.round((VIEW_MS - 10_000) / 1000)]],
  );
  assert.ok(body.states.every((s) => s.length === 18 || s.length === 19));
  assert.equal(body.states[0][8], false);
  assert.equal(answer.lastOkAt, VIEW_MS - 10_000);
});

test('reader: a global cap of concurrent ES reads fails closed across viewports, without blocking the collector path', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const started = [];
  const es = {
    async search(index, body) {
      started.push(body.query.bool.filter.find((c) => c.range?.icao24) ?? null);
      const mine = new Promise((r) => setTimeout(r, 5));
      if (started.length === 1) await gate;
      await mine;
      return esSearchHits([doc()]);
    },
  };
  const reader = createFlightsEsFallback({
    es,
    now: () => VIEW_MS,
    maxConcurrentReads: 1,
  });
  const first = reader.read(makeUrl(`/api/flights?view=0,45,10,55`));
  const second = reader.read(makeUrl(`/api/flights?view=1,46,11,56`));
  await assert.rejects(
    second,
    (error) =>
      error instanceof Error &&
      !/api key|password|Authorization/i.test(String(error.message)),
    'a second concurrent viewport read fails closed instead of queueing',
  );
  release();
  assert.ok(await first, 'the first read completes');
  assert.ok(
    await reader.read(makeUrl(`/api/flights?view=2,47,12,57`)),
    'the collector path is free to use the reader again afterwards',
  );
});

test('reader: the number of collapse queries per read is capped (fail safe, marked truncated)', async () => {
  // more distinct keys than one collapse page: the default partitioning
  // wants a probe plus eight parallel parts (9 requests)
  const docs = Array.from({ length: 10_100 }, (_, i) =>
    doc({ icao24: String(i).padStart(6, '0'), ts: VIEW_MS - 10_000 }),
  );
  const es = rangedFakeEs(docs);
  const reader = createFlightsEsFallback({
    es,
    now: () => VIEW_MS,
    maxQueries: 6,
  });
  await reader.read(makeUrl(`/api/flights?view=${VIEW}`));
  assert.ok(es.calls.length <= 6, `calls: ${es.calls.length}`);
  const answer = await reader.read(makeUrl(`/api/flights?view=${VIEW}`));
  assert.equal(es.calls.length <= 6, true);
  assert.ok(!answer || answer.truncated, 'a capped read says so');
});

test('flights ES fallback caps the queries per read well below the collapse default', () => {
  assert.equal(typeof FLIGHTS_ES_FALLBACK_MAX_QUERIES, 'number');
  assert.ok(
    FLIGHTS_ES_FALLBACK_MAX_QUERIES > 2 &&
      FLIGHTS_ES_FALLBACK_MAX_QUERIES < COLLAPSE_MAX_QUERIES,
    `FLIGHTS_ES_FALLBACK_MAX_QUERIES=${FLIGHTS_ES_FALLBACK_MAX_QUERIES}`,
  );
});

test('reader: a read has a finite deadline and fails closed when it overruns', async () => {
  let settled;
  const never = new Promise((r) => (settled = r));
  const es = {
    async search() {
      await never;
      return esSearchHits([]);
    },
  };
  const reader = createFlightsEsFallback({
    es,
    now: () => VIEW_MS,
    readDeadlineMs: 25,
  });
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
    /deadline|unavailable/,
    'the whole read is bounded',
  );
  settled();
  await new Promise((r) => setTimeout(r, 5)); // let the loser settle
});

test('reader: ES failures are cached briefly, then re-read (no retry storm)', async () => {
  let nowMs = VIEW_MS;
  let searches = 0;
  const es = {
    async search() {
      searches += 1;
      throw new Error('es down');
    },
  };
  const reader = createFlightsEsFallback({
    es,
    now: () => nowMs,
    failureMs: 10_000,
  });
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
    /es down|unavailable/,
  );
  assert.equal(searches, 1);
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
    /unavailable/,
    'the failure is served from memory',
  );
  assert.equal(searches, 1, 'no second ES read within the window');
  nowMs += 10_001;
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
    /es down|unavailable/,
    'the failure cache expires and ES is asked again',
  );
  assert.equal(searches, 2);
});

test('reader: ES failures are logged at most once a minute, without leaking details', async () => {
  let nowMs = VIEW_MS;
  const lines = [];
  const es = {
    async search() {
      const e = new Error('boom');
      e.esApiKey = 'secret-key-should-never-log';
      throw e;
    },
  };
  const reader = createFlightsEsFallback({
    es,
    now: () => nowMs,
    log: (line) => lines.push(line),
  });
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=${VIEW}`)),
    /unavailable/,
  );
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=1,46,11,56`)),
    /unavailable/,
    'a second failure is not logged right away',
  );
  nowMs += 61_000;
  await assert.rejects(
    reader.read(makeUrl(`/api/flights?view=2,47,12,57`)),
    /unavailable/,
  );
  assert.deepEqual(
    lines.map((l) => typeof l === 'string' && l.length > 0),
    [true, true],
    'one log line per minute, not one per failure',
  );
  for (const line of lines) {
    assert.ok(!line.includes('secret-key-should-never-log'), `leak: ${line}`);
    assert.ok(!line.includes('boom'), `error message leaked: ${line}`);
  }
});

/** A fake honouring the collapse request's time, bbox and keyword partition. */
function rangedFakeEs(docs) {
  const state = { calls: 0 };
  const calls = [];
  const search = async (index, body) => {
    state.calls += 1;
    calls.push({ index, body });
    let time = null;
    let part = null;
    for (const c of body.query.bool.filter) {
      if (c.range?.['@timestamp']) time = c.range['@timestamp'];
      if (c.range?.icao24) part = c.range.icao24;
    }
    const hits = docs
      .filter((d) => {
        const ts = typeof d['@timestamp'] === 'string' ? Date.parse(d['@timestamp']) : d['@timestamp'];
        if (time && (ts < time.gte || ts > time.lte)) return false;
        if (part && (d.icao24 < part.gte || d.icao24 >= part.lt)) return false;
        return true;
      })
      .sort((x, y) => y['@timestamp'] - x['@timestamp'])
      .slice(0, body.size)
      .map((d, i) => ({
        _id: `doc${i}`,
        fields: { icao24: [d.icao24] },
        _source: d,
      }));
    return {
      took: 1,
      timed_out: false,
      _shards: { failed: 0, successful: 1, total: 1 },
      hits: { hits },
    };
  };
  search.count = () => state.calls;
  return { search, calls, get length() { return state.calls; } };
}
