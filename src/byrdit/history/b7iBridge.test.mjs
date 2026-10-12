import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historyPlugins } from './index.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import { MAX_PATTERN_SLOTS } from './collectorBridge.js';

/**
 * B7 on the live B15r bridge (integration card t_40ebce63). The B15 resolver
 * entries (transit, gbfs, weather: one collector snapshot per resolved
 * target, caches keyed by collector feed) and the B7 entries (launches, and
 * the celestrak pattern route: one snapshot per group, capped at
 * MAX_PATTERN_SLOTS) share one createCollectorBridge. These tests run both
 * families in one plugin list with every flag on, against a stand-in
 * collector; any request that is not a collector read fails the test.
 */

const fx = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const NOW = Date.parse('2026-10-12T15:18:30.000Z');
const ALL_ON = {
  GEV_BRIDGE_MILITARY: '1',
  GEV_BRIDGE_TRANSIT: '1',
  GEV_BRIDGE_GBFS: '1',
  GEV_BRIDGE_WEATHER: '1',
  GEV_BRIDGE_LAUNCHES: '1',
  GEV_BRIDGE_CELESTRAK: '1',
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
  const collector = { up: true, calls: [], bodies: new Map() };
  const fetchImpl = async (url) => {
    const feed = /\/v1\/latest\/([a-z0-9-]+)$/.exec(String(url))?.[1];
    collector.calls.push(feed);
    if (!collector.up) throw new TypeError('collector down');
    const body =
      collector.bodies.get(feed) ??
      (feed?.startsWith('celestrak-') ? `GP ${feed}\r\n` : null);
    if (body === null)
      return new Response('{"error":"no snapshot yet","noDataSince":null}', {
        status: 503,
        headers: { 'X-Feed-Reason': 'no_snapshot' },
      });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': feed.startsWith('celestrak-')
          ? 'text/plain'
          : 'application/json',
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
      now: () => NOW,
      log: (l) => lines.push(l),
    }),
  );
  return { call, collector, blocked, lines };
}

test('registry: B15 and B7 entries side by side, every flag maps to its own entry', () => {
  assert.deepEqual(enabledBridgeFeeds(ALL_ON), [
    'military',
    'transit',
    'gbfs',
    'weather',
    'launches',
    'celestrak',
  ]);
  assert.equal(typeof BRIDGE_FEEDS.transit.resolve, 'function');
  assert.equal(BRIDGE_FEEDS.celestrak.resolve, undefined);
  assert.equal(BRIDGE_FEEDS.celestrak.pathPattern, '^/([a-z0-9-]{1,40})$');
  assert.equal(BRIDGE_FEEDS.launches.terminal, true);
});

test('all flags on: B15 resolver routes and B7 launches/celestrak routes each read their own collector snapshot', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const r = rig(t);
  const transitBody = fx('b15-collector-transit-translink-seq.body');
  r.collector.bodies.set('transit-translink-seq', transitBody);
  r.collector.bodies.set('launches', '{"results":[]}');
  r.collector.bodies.set('military', '{"ac":[]}');

  const transit = await r.call('/api/transit/vehicles/translink-seq');
  assert.equal(transit.statusCode, 200);
  assert.equal(Buffer.compare(transit.body, transitBody), 0);
  assert.equal(transit.headers['x-gev-cache'], 'HIT', 'B15 decorate kept');

  const launches = await r.call('/api/launches');
  assert.equal(launches.statusCode, 200);
  assert.equal(launches.body.toString(), '{"results":[]}');
  assert.equal(launches.headers['x-feed-bridge'], 'collector');

  const gp = await r.call('/api/celestrak/stations');
  assert.equal(gp.statusCode, 200);
  assert.equal(gp.body.toString(), 'GP celestrak-stations\r\n');

  const mil = await r.call('/api/military');
  assert.equal(mil.statusCode, 200);

  assert.deepEqual(r.collector.calls, [
    'transit-translink-seq',
    'launches',
    'celestrak-stations',
    'military',
  ]);
  // terminal B7 routes still 404/405 odd paths; B15 unknown ids answered
  // offline (GEV's 404), nothing ever reaches an upstream
  assert.equal((await r.call('/api/celestrak/a/b')).statusCode, 404);
  assert.equal((await r.call('/api/launches/x')).statusCode, 404);
  assert.equal((await r.call('/api/celestrak/x', 'POST')).statusCode, 405);
  assert.equal((await r.call('/api/transit/vehicles/nyct')).statusCode, 404);
  assert.deepEqual(r.blocked, []);
  // transitions are labelled per collector snapshot
  assert.ok(
    r.lines.some((l) => l.includes('celestrak/celestrak-stations: start')),
  );
  assert.ok(
    r.lines.some((l) => l.includes('transit/transit-translink-seq: start')),
  );
});

test('celestrak cap: the first MAX_PATTERN_SLOTS groups keep a last-good copy; later groups are answered but not remembered; B15 caches are separate', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const r = rig(t);
  const transitBody = fx('b15-collector-transit-translink-seq.body');
  r.collector.bodies.set('transit-translink-seq', transitBody);
  const total = MAX_PATTERN_SLOTS + 4;
  for (let i = 0; i < total; i++) {
    const res = await r.call(`/api/celestrak/g${i}`);
    assert.equal(res.statusCode, 200, `g${i} live`);
  }
  assert.equal(
    (await r.call('/api/transit/vehicles/translink-seq')).statusCode,
    200,
  );
  r.collector.up = false;
  for (let i = 0; i < total; i++) {
    const res = await r.call(`/api/celestrak/g${i}`);
    if (i < MAX_PATTERN_SLOTS) {
      assert.equal(res.statusCode, 200, `g${i} from its own copy`);
      assert.equal(res.headers['x-feed-bridge'], 'cache');
      assert.equal(res.body.toString(), `GP celestrak-g${i}\r\n`);
    } else {
      assert.equal(res.statusCode, 503, `g${i} beyond the cap: no copy`);
    }
  }
  // the transit copy does not count against the CelesTrak cap
  const cached = await r.call('/api/transit/vehicles/translink-seq');
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.headers['x-feed-bridge'], 'cache');
  assert.equal(Buffer.compare(cached.body, transitBody), 0);
  assert.deepEqual(r.blocked, []);
});
