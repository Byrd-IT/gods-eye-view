import test from 'node:test';
import assert from 'node:assert/strict';
import { historyPlugins } from './index.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import {
  BRIDGE_CACHE_MAX_BYTES,
  MAX_PATTERN_SLOTS,
} from './collectorBridge.js';

/**
 * B8 on the live B7i bridge (integration card t_2011b916). The B8 vessels
 * entries (terminal /api/vessels namespace, forwardParams, per-query
 * last-good copies, track never cached, relayed 400) now run inside the
 * B15/B7 per-snapshot structure: last-good copies are kept per collector
 * snapshot AND per feed.cacheKey(url). These tests run every family in one
 * plugin list with every flag on, against a stand-in collector; any request
 * that is not a collector read fails the test.
 */

const NOW = Date.parse('2026-10-12T19:00:00.000Z');
const ALL_ON = {
  GEV_BRIDGE_MILITARY: '1',
  GEV_BRIDGE_TRANSIT: '1',
  GEV_BRIDGE_GBFS: '1',
  GEV_BRIDGE_WEATHER: '1',
  GEV_BRIDGE_LAUNCHES: '1',
  GEV_BRIDGE_CELESTRAK: '1',
  GEV_BRIDGE_VESSELS: '1',
  GEV_COLLECTOR_URLS: 'http://collector.test',
};

/** Connect-compatible dispatcher over Vite plugin configureServer hooks. */
function chain(plugins) {
  const stack = [];
  const server = {
    middlewares: { use: (route, handler) => stack.push({ route, handler }) },
  };
  for (const plugin of plugins) plugin.configureServer?.(server);
  return async (path, method = 'GET') => {
    let done;
    const finished = new Promise((resolve) => (done = resolve));
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      destroyed: false,
      once() {},
      removeListener() {},
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
          Promise.resolve(
            handler({ url: rest, method, headers: {}, socket: {} }, res, () =>
              dispatch(index + 1),
            ),
          ).catch(() => {});
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

function rig(t) {
  const blocked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    blocked.push(String(url));
    throw new TypeError('network blocked in test');
  });
  const collector = { up: true, calls: [] };
  let now = NOW;
  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    const feed = /^\/v1\/latest\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
    collector.calls.push(`${feed}${url.search}`);
    if (!collector.up) throw new TypeError('collector down');
    if (
      feed === 'vessels-track' &&
      !/^\d{5,10}$/.test(url.searchParams.get('mmsi') ?? '')
    )
      return new Response(
        '{"error":"mmsi query param required","samples":[]}',
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    const body =
      feed === 'vessels'
        ? JSON.stringify({ rows: url.searchParams.get('maxRows') ?? 'full' })
        : feed === 'vessels-track'
          ? JSON.stringify({ mmsi: url.searchParams.get('mmsi') })
          : `${feed}`;
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Feed-Source': 'test',
        'X-Collector-Role': 'active',
        'X-Feed-Cache': 'HIT',
        'X-Feed-Age-Ms': '1000',
        'X-Feed-Last-OK': String(NOW - 1000),
      },
    });
  };
  const lines = [];
  const call = chain(
    historyPlugins({
      env: ALL_ON,
      fetchImpl,
      liveFetchImpl: async (url) => {
        blocked.push(String(url));
        throw new TypeError('live fetch blocked in test');
      },
      now: () => now,
      log: (l) => lines.push(l),
    }),
  );
  return { call, collector, blocked, lines, at: (ms) => (now = NOW + ms) };
}

test('registry: B15, B7 and B8 entries side by side, every flag maps to its own entry', () => {
  assert.deepEqual(enabledBridgeFeeds(ALL_ON), [
    'military',
    'transit',
    'gbfs',
    'weather',
    'launches',
    'celestrak',
    'vessels',
    'vesselsTrack',
  ]);
  assert.equal(BRIDGE_FEEDS.vessels.terminal, true);
  assert.equal(BRIDGE_FEEDS.vesselsTrack.cache, false);
  assert.equal(BRIDGE_FEEDS.celestrak.cacheKey, undefined);
  assert.equal(MAX_PATTERN_SLOTS, 32);
  assert.equal(BRIDGE_CACHE_MAX_BYTES, 64 * 1024 * 1024);
});

test('all flags on: vessels per-query copies, track never cached, B7/B15 single-slot copies, nothing reaches an upstream', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const r = rig(t);
  const body = async (path) => {
    const res = await r.call(path);
    return { res, text: res.body?.toString() };
  };
  // live: each route reads its own collector snapshot; forwardParams only
  assert.equal(
    (await body('/api/vessels?maxRows=7&lat=29.7&lon=-95.3')).text,
    '{"rows":"7"}',
  );
  assert.equal((await body('/api/vessels')).text, '{"rows":"full"}');
  assert.equal(
    (await body('/api/vessels/track?mmsi=366999000')).text,
    '{"mmsi":"366999000"}',
  );
  assert.equal((await r.call('/api/vessels/track?mmsi=x')).statusCode, 400);
  assert.equal(
    (await body('/api/celestrak/stations')).text,
    'celestrak-stations',
  );
  assert.equal((await body('/api/launches')).text, 'launches');
  assert.equal((await body('/api/military')).text, 'military');
  assert.deepEqual(r.collector.calls, [
    'vessels?maxRows=7',
    'vessels',
    'vessels-track?mmsi=366999000',
    'vessels-track?mmsi=x',
    'celestrak-stations',
    'launches',
    'military',
  ]);
  // terminal namespaces answer odd paths/methods themselves
  assert.equal((await r.call('/api/vessels/x')).statusCode, 404);
  assert.equal((await r.call('/api/vessels', 'POST')).statusCode, 405);
  assert.equal((await r.call('/api/celestrak/a/b')).statusCode, 404);

  // collector gone, 4 min later: STALE copies of the SAME query only
  r.collector.up = false;
  r.at(4 * 60_000);
  const seven = await body('/api/vessels?maxRows=7.9');
  assert.equal(seven.text, '{"rows":"7"}');
  assert.equal(seven.res.headers['x-feed-bridge'], 'cache');
  assert.equal(seven.res.headers['x-feed-cache'], 'STALE');
  assert.equal((await body('/api/vessels')).text, '{"rows":"full"}');
  const twelve = await r.call('/api/vessels?maxRows=12');
  assert.equal(twelve.statusCode, 503, 'no copy of its own -> no-snapshot');
  assert.equal(twelve.headers['x-feed-bridge'], 'none');
  const track = await r.call('/api/vessels/track?mmsi=366999000');
  assert.equal(track.statusCode, 503, 'track is never cached');
  // single-slot feeds: any query spelling gets the one copy
  assert.equal(
    (await body('/api/celestrak/stations?FORMAT=json')).text,
    'celestrak-stations',
  );
  assert.equal((await body('/api/launches?x=1')).text, 'launches');
  assert.equal((await body('/api/military')).text, 'military');
  assert.deepEqual(r.blocked, []);
  // transitions: vessels keeps the feed label, celestrak the per-group label
  assert.ok(r.lines.some((l) => l.includes('vessels: collector -> cache')));
  assert.ok(r.lines.some((l) => l.includes('vesselsTrack: collector -> none')));
  assert.ok(
    r.lines.some((l) =>
      l.includes('celestrak/celestrak-stations: collector -> cache'),
    ),
  );
});

test('celestrak pattern cap still holds with per-query slots: past MAX_PATTERN_SLOTS groups are answered, not remembered', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const r = rig(t);
  for (let i = 0; i <= MAX_PATTERN_SLOTS; i++)
    assert.equal((await r.call(`/api/celestrak/g${i}`)).statusCode, 200);
  r.collector.up = false;
  assert.equal((await r.call('/api/celestrak/g0')).statusCode, 200, 'kept');
  const extra = await r.call(`/api/celestrak/g${MAX_PATTERN_SLOTS}`);
  assert.equal(extra.statusCode, 503, 'over the cap: not remembered');
  assert.deepEqual(r.blocked, []);
});
