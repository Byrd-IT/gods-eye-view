import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { historyPlugins } from './index.js';
import {
  BRIDGE_FEEDS,
  enabledBridgeFeeds,
  clampInt,
  vesselsCacheKey,
  AIS_MAX_ROWS,
} from './feeds.js';
import { createCollectorBridge } from './collectorBridge.js';
import { clampInt as gevClampInt } from '../../../server/providers/common/query.js';
import {
  ingestAisStreamEnvelope,
  aisStreamRows,
  newestAisPositionAt,
  readAisTrack,
  AISSTREAM_STALE_MS,
  AISSTREAM_CACHE_MAX,
} from '../../../server/providers/vessels/ais-store.js';

/**
 * B8 (gev-history t_c8cda898): /api/vessels and /api/vessels/track answered
 * by the collector, which holds the ONE AISStream socket the key allows.
 *
 * Contract fixtures (fixtures/b8-*): envelopes rebuilt from a real
 * /api/vessels capture (S4, 2026-10-12 15:28Z) and the bodies the COLLECTOR
 * rendered from them (gev-history scripts/b8-gen-gev-fixtures.mjs). GEV's
 * own ais-store.js + the ais-live.js body expression must produce exactly
 * those bytes from the same envelopes: if either side drifts, this fails.
 */
const fx = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ENV = JSON.parse(fx('b8-ais-envelopes.body'));
const BODY = fx('b8-collector-vessels.body');
const BODY7 = fx('b8-collector-vessels-7.body');
const TRACK = fx('b8-collector-vessels-track.body');

/** ais-live.js /api/vessels body expression (copied). */
function gevBody(rows, feed) {
  return JSON.stringify({
    rows,
    source: 'AISStream',
    status: feed.status,
    error: feed.error,
    refreshing: feed.status !== 'live',
    newestPositionAt: newestAisPositionAt(rows),
    lastMessageAt: feed.lastMessageAt,
    silentForMs: feed.silentForMs,
    reconnectAttempt: feed.reconnectAttempt,
    nextAttemptAt: feed.nextAttemptAt,
    staleAfterMs: feed.staleAfterMs,
    watchdog: feed.watchdog,
  });
}

test('contract: GEV ais-store + ais-live body from the fixture envelopes == collector /v1/latest/vessels bytes', (t) => {
  let now = ENV.T0;
  t.mock.method(Date, 'now', () => now);
  let accepted = 0;
  for (const { at, envelope } of ENV.envelopes) {
    now = ENV.T0 + at;
    if (ingestAisStreamEnvelope(envelope)) accepted += 1;
  }
  now = ENV.end;
  assert.equal(accepted, ENV.accepted);
  assert.equal(gevBody(aisStreamRows(50000), ENV.feed), BODY.toString('utf8'));
  assert.equal(gevBody(aisStreamRows(7), ENV.feed), BODY7.toString('utf8'));
  // ais-live.js /api/vessels/track body (copied)
  const track = JSON.stringify({
    mmsi: ENV.trackMmsi,
    samples: readAisTrack(ENV.trackMmsi),
    source: 'AISStream (accumulated since server start)',
    retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000),
  });
  assert.equal(track, TRACK.toString('utf8'));
  assert.equal(JSON.parse(BODY).rows.length, 300);
  assert.ok(JSON.parse(TRACK).samples.length >= 2);
});

test('registry: vessels + track share GEV_BRIDGE_VESSELS, terminal route, collector cadence 60 s', () => {
  const v = BRIDGE_FEEDS.vessels;
  const tr = BRIDGE_FEEDS.vesselsTrack;
  assert.equal(v.route, '/api/vessels');
  assert.equal(tr.route, '/api/vessels');
  assert.equal(v.path, '/');
  assert.equal(tr.path, '/track');
  assert.equal(v.collectorFeed, 'vessels');
  assert.equal(tr.collectorFeed, 'vessels-track');
  assert.equal(v.cadenceMs, 60_000);
  assert.equal(v.flag, 'GEV_BRIDGE_VESSELS');
  assert.equal(tr.flag, v.flag);
  assert.equal(v.terminal, true);
  assert.equal(tr.terminal, true);
  assert.deepEqual(v.forwardParams, ['maxRows']);
  assert.deepEqual(tr.forwardParams, ['mmsi']);
  assert.equal(tr.cache, false);
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_VESSELS: '1' }), [
    'vessels',
    'vesselsTrack',
  ]);
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_VESSELS: 'yes' }), []);
});

/** Connect-compatible dispatcher over Vite plugin configureServer hooks. */
function chain(stackPlugins) {
  const stack = [];
  const server = {
    middlewares: { use: (route, handler) => stack.push({ route, handler }) },
  };
  for (const plugin of stackPlugins) plugin.configureServer?.(server);
  return async (path, method = 'GET') => {
    let done;
    const finished = new Promise((resolve) => (done = resolve));
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      },
      end(body) {
        this.body = body === undefined ? undefined : Buffer.from(body);
        done();
      },
    };
    const dispatch = (i) => {
      for (; i < stack.length; i++) {
        const { route, handler } = stack[i];
        if (
          path === route ||
          path.startsWith(`${route}/`) ||
          path.startsWith(`${route}?`)
        ) {
          let rest = path.slice(route.length) || '/';
          if (rest.startsWith('?')) rest = `/${rest}`;
          const index = i;
          handler({ url: rest, method, headers: {}, socket: {} }, res, () =>
            dispatch(index + 1),
          );
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

/**
 * Stand-in for GEV's aisLiveProxy at the same mount: ANY request reaching it
 * would (re)open GEV's own AISStream socket (upstream demand), i.e. a second
 * connection on the key. It must see zero requests.
 */
function aisSentinel() {
  const hits = [];
  return {
    hits,
    plugin: {
      name: 'ais-live-proxy-sentinel',
      configureServer(server) {
        server.middlewares.use('/api/vessels', (req, res) => {
          hits.push(`${req.method} ${req.url}`);
          res.writeHead(599, {});
          res.end('reached aisLiveProxy');
        });
      },
    },
  };
}

async function startCollector(t, { lastOk }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url, 'http://x');
    const base = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Feed-Source': 'AISStream',
      'X-Collector-Role': 'active',
    };
    if (u.pathname === '/v1/latest/vessels') {
      res.writeHead(200, {
        ...base,
        'X-Feed-Cache': 'HIT',
        'X-Feed-Age-Ms': '1000',
        'X-Feed-Last-OK': String(lastOk),
      });
      // GEV semantics: maxRows normalised by clampInt (7, '7.9', '07' -> 7)
      res.end(vesselsCacheKey(u) === '7' ? BODY7 : BODY);
      return;
    }
    if (u.pathname === '/v1/latest/vessels-track') {
      const mmsi = u.searchParams.get('mmsi') ?? '';
      if (!/^\d{5,10}$/.test(mmsi)) {
        res.writeHead(400, base);
        res.end(
          JSON.stringify({ error: 'mmsi query param required', samples: [] }),
        );
        return;
      }
      res.writeHead(200, base);
      res.end(TRACK);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  t.after(() => (server.listening ? stop() : undefined));
  return { url: `http://127.0.0.1:${server.address().port}`, stop, seen };
}

test('network-blocked: /api/vessels namespace never reaches aisLiveProxy; bytes relayed; STALE last-good; track never cached', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const lastOk = ENV.end;
  let now = lastOk + 1_000;
  const collector = await startCollector(t, { lastOk });
  const real = globalThis.fetch;
  const blocked = [];
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === collector.url) return real(input, init);
    blocked.push(url.origin);
    return Promise.reject(new Error(`network blocked: ${url.origin}`));
  });
  const sentinel = aisSentinel();
  const request = chain([
    ...historyPlugins({
      env: {
        GEV_BRIDGE_VESSELS: '1',
        GEV_COLLECTOR_URLS: collector.url,
        GEV_COLLECTOR_TIMEOUT_MS: '500',
      },
      now: () => now,
    }),
    sentinel.plugin,
  ]);

  // the client's real query: maxRows + area (area is dropped, as GEV ignores it)
  const live = await request(
    '/api/vessels?maxRows=7&lat=29.76040&lon=-95.36980&radius_km=250.0',
  );
  assert.equal(live.statusCode, 200);
  assert.ok(live.body.equals(BODY7));
  assert.equal(live.headers['x-feed-bridge'], 'collector');
  assert.equal(live.headers['x-feed-source'], 'AISStream');
  assert.equal(live.headers['content-type'], 'application/json; charset=utf-8');
  const full = await request('/api/vessels');
  assert.ok(full.body.equals(BODY));
  const tr = await request(`/api/vessels/track?mmsi=${ENV.trackMmsi}`);
  assert.equal(tr.statusCode, 200);
  assert.ok(tr.body.equals(TRACK));
  const bad = await request('/api/vessels/track?mmsi=abc');
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(JSON.parse(bad.body), {
    error: 'mmsi query param required',
    samples: [],
  });
  assert.deepEqual(collector.seen, [
    '/v1/latest/vessels?maxRows=7',
    '/v1/latest/vessels',
    `/v1/latest/vessels-track?mmsi=${ENV.trackMmsi}`,
    '/v1/latest/vessels-track?mmsi=abc',
  ]);

  // every other sub-path / method is answered by the bridge itself
  for (const [path, method, status] of [
    ['/api/vessels/x', 'GET', 404],
    ['/api/vessels/track/', 'GET', 404],
    ['/api/vessels//', 'GET', 404],
    ['/api/vessels', 'POST', 405],
    ['/api/vessels/track', 'DELETE', 405],
    ['/api/vessels/x', 'POST', 404],
  ]) {
    const r = await request(path, method);
    assert.equal(r.statusCode, status, `${method} ${path}`);
  }

  // collector gone: vessels -> last good STALE (N5 grey) of the SAME query,
  // track -> 503
  await collector.stop();
  now = lastOk + 4 * 60_000;
  const stale = await request('/api/vessels?maxRows=7');
  assert.equal(stale.statusCode, 200);
  assert.ok(stale.body.equals(BODY7), 'last good copy of maxRows=7');
  const staleFull = await request('/api/vessels');
  assert.ok(staleFull.body.equals(BODY), 'full list never gets the 7 rows');
  assert.equal(stale.headers['x-feed-cache'], 'STALE');
  assert.equal(stale.headers['x-feed-bridge'], 'cache');
  assert.equal(stale.headers['x-feed-stale-since'], String(lastOk + 180_000));
  assert.equal(
    stale.headers['x-feed-grey-until'],
    String(lastOk + 180_000 + 3_600_000),
  );
  const noTrack = await request(`/api/vessels/track?mmsi=${ENV.trackMmsi}`);
  assert.equal(noTrack.statusCode, 503);
  assert.equal(noTrack.headers['x-feed-bridge'], 'none');

  assert.deepEqual(sentinel.hits, [], 'aisLiveProxy was never reached');
  assert.deepEqual(blocked, []);
});

test('flag off: no vessels middleware (aisLiveProxy keeps the route)', async () => {
  assert.deepEqual(historyPlugins({ env: {} }), []);
  const sentinel = aisSentinel();
  const request = chain([
    ...historyPlugins({ env: { GEV_BRIDGE_MILITARY: '1' } }),
    sentinel.plugin,
  ]);
  const r = await request('/api/vessels?maxRows=5');
  assert.equal(r.statusCode, 599);
  assert.deepEqual(sentinel.hits, ['GET /?maxRows=5']);
});

test('R3 maxRows normalisation matches GEV ais-live.js (clampInt, AISSTREAM_CACHE_MAX)', () => {
  assert.equal(AIS_MAX_ROWS, AISSTREAM_CACHE_MAX);
  for (const v of [
    null,
    '',
    'abc',
    '0',
    '-5',
    '1',
    '7',
    '7.9',
    '07',
    '1e3',
    '500',
    '12000',
    '50000',
    '50001',
    '999999999',
  ])
    assert.equal(
      clampInt(v, 1, AIS_MAX_ROWS, AIS_MAX_ROWS),
      gevClampInt(v, 1, AISSTREAM_CACHE_MAX, AISSTREAM_CACHE_MAX),
      String(v),
    );
  const key = (q) => vesselsCacheKey(new URL(`http://x/${q}`));
  assert.equal(key(''), '50000');
  assert.equal(key('?maxRows=999999'), '50000');
  assert.equal(key('?maxRows=abc'), '50000');
  assert.equal(key('?maxRows=0'), '1');
  assert.equal(key('?maxRows=7.9'), '7');
  assert.equal(key('?maxRows=500&lat=1'), '500');
});

/** Fake collector + request driver straight on the vessels handler. */
function vesselsHandler({ now } = {}) {
  const state = { up: true, seen: [] };
  const lastOk = 1_791_800_000_000;
  const body = (n) => new TextEncoder().encode(JSON.stringify({ rows: n }));
  const fetchImpl = async (u) => {
    const url = new URL(u);
    state.seen.push(url.pathname + url.search);
    if (!state.up) throw new Error('ECONNREFUSED');
    return new Response(body(vesselsCacheKey(url)), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-feed-source': 'AISStream',
        'x-feed-cache': 'HIT',
        'x-feed-age-ms': '0',
        'x-feed-last-ok': String(lastOk),
      },
    });
  };
  const handler = createCollectorBridge({
    name: 'vessels',
    urls: ['http://collector.test'],
    fetchImpl,
    now: now ?? (() => lastOk + 1_000),
    log: () => {},
  });
  const get = (q) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
          this.headersSent = true;
        },
        end(b) {
          resolve({
            status: this.status,
            headers: this.headers,
            rows: b ? JSON.parse(Buffer.from(b).toString()).rows : null,
          });
        },
      };
      handler({ url: `/${q}`, method: 'GET' }, res, () => resolve('next'));
    });
  return { state, get, lastOk };
}

for (const order of [
  ['', '?maxRows=7'],
  ['?maxRows=7', ''],
]) {
  test(`R3 last-good copies are per normalised maxRows (order ${order.map((q) => q || 'full').join(' -> ')}), through the outage and grey window`, async () => {
    let t = 1_791_800_000_000 + 1_000;
    const v = vesselsHandler({ now: () => t });
    for (const q of order) assert.equal((await v.get(q)).status, 200);
    v.state.up = false;
    for (const at of [10_000, 4 * 60_000, 30 * 60_000]) {
      t = v.lastOk + at;
      const full = await v.get('');
      assert.equal(full.status, 200);
      assert.equal(full.rows, '50000', 'full request never gets 7 rows');
      assert.equal(full.headers['X-Feed-Bridge'], 'cache');
      const seven = await v.get('?maxRows=7');
      assert.equal(seven.rows, '7');
      // same normalised value, other spelling: same copy
      assert.equal((await v.get('?maxRows=7.9&lat=1')).rows, '7');
      assert.equal((await v.get('?maxRows=999999')).rows, '50000');
      assert.equal((await v.get('?maxRows=abc')).rows, '50000');
      // a query never answered while up has no copy of its own: 503
      const other = await v.get('?maxRows=12');
      assert.equal(other.status, 503);
      assert.equal(other.headers['X-Feed-Bridge'], 'none');
    }
    // inside the stale window the copies are STALE + grey-until (N5)
    t = v.lastOk + 4 * 60_000;
    const g = await v.get('');
    assert.equal(g.headers['X-Feed-Cache'], 'STALE');
    assert.equal(
      g.headers['X-Feed-Grey-Until'],
      String(v.lastOk + 180_000 + 3_600_000),
    );
  });
}

test('R3 last-good copies are bounded: 4 most recently used maxRows values per feed', async () => {
  const v = vesselsHandler();
  for (const n of [1, 2, 3, 4, 5]) await v.get(`?maxRows=${n}`);
  await v.get('?maxRows=2'); // refresh: 2 is now most recently used
  await v.get('?maxRows=6'); // 5 copies -> evicts 3 (1 went at 5)
  v.state.up = false;
  const served = {};
  for (const n of [1, 2, 3, 4, 5, 6])
    served[n] = (await v.get(`?maxRows=${n}`)).status;
  assert.deepEqual(served, { 1: 503, 2: 200, 3: 503, 4: 200, 5: 200, 6: 200 });
});

test('R3 other bridged feeds keep one last-good slot whatever the query', () => {
  for (const [name, feed] of Object.entries(BRIDGE_FEEDS)) {
    // B20 flights keeps one copy per normalised view (b20Bridge.test.mjs)
    if (name === 'vessels' || name === 'flights') continue;
    assert.equal(feed.cacheKey, undefined, name);
    assert.equal(feed.cacheEntries, undefined, name);
  }
  assert.equal(BRIDGE_FEEDS.vessels.cacheKey, vesselsCacheKey);
  assert.equal(BRIDGE_FEEDS.vessels.cacheEntries, 4);
});
