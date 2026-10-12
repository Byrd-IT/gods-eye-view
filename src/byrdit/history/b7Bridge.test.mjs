import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { historyPlugins } from './index.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import { MAX_PATTERN_SLOTS } from './collectorBridge.js';
import {
  celestrakProxy,
  rocketLaunchesProxy,
} from '../../../server/providers/space.js';

/**
 * B7 (gev-history t_fa373645): bridge entries for /api/launches and
 * /api/celestrak/<group>.
 *
 * Contract fixtures (fixtures/b7-*): the raw upstream answers captured on
 * 2026-10-12 from S4's own GEV caches (.gev-cache/launch-library-2-v2.3.json
 * trimmed to 6 launches, celestrak-stations.json, celestrak-active.json
 * trimmed to 300 rows; celestrak.org itself was not contacted) and the bodies
 * the COLLECTOR rendered from them (b7-collector-*, gev-history
 * scripts/b7-gen-collector-bodies.mjs). GEV's own proxies relay the upstream
 * bytes unchanged; the collector must serve exactly the same bytes. The
 * CelesTrak CSVs are CRLF and stored gzipped so `* text=auto eol=lf` can
 * never rewrite them.
 */

const fx = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const gz = (name) => gunzipSync(fx(name));
const LL2_UPSTREAM = fx('b7-ll2-launches.body');
const GP = {
  active: gz('b7-celestrak-active.csv.gz'),
  stations: gz('b7-celestrak-stations.csv.gz'),
};
const COLLECTOR = {
  launches: fx('b7-collector-launches.body'),
  'celestrak-active': gz('b7-collector-celestrak-active.body.gz'),
  'celestrak-stations': gz('b7-collector-celestrak-stations.body.gz'),
  // any other group: the stand-in collector answers the stations bytes
  'celestrak-starlink': gz('b7-collector-celestrak-stations.body.gz'),
};
const CONTENT_TYPE = {
  launches: 'application/json',
  'celestrak-active': 'text/plain',
  'celestrak-stations': 'text/plain',
  'celestrak-starlink': 'text/plain',
};
const T = 1_791_731_534_724;

/** Run the test in an empty cwd: GEV's proxies cache under ./.gev-cache. */
function freshCwd(t) {
  const before = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'gev-b7-'));
  process.chdir(dir);
  t.after(() => {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

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

/** A stand-in collector speaking the gev-history /v1/latest contract. */
async function startCollector(t, { lastOk }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const feed = /^\/v1\/latest\/([a-z0-9-]+)$/.exec(req.url)?.[1];
    seen.push(req.url);
    if (!COLLECTOR[feed]) {
      // what the real collector answers for a group it just discovered
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'X-Feed-Reason': 'no_snapshot',
        'X-Collector-Role': 'active',
      });
      res.end(JSON.stringify({ error: 'no snapshot yet', noDataSince: null }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPE[feed],
      'Cache-Control': 'no-store',
      'X-Feed-Source': feed === 'launches' ? 'Launch Library 2' : 'CelesTrak',
      'X-Collector-Role': 'active',
      'X-Feed-Cache': 'HIT',
      'X-Feed-Age-Ms': '1000',
      'X-Feed-Last-OK': String(lastOk),
    });
    res.end(COLLECTOR[feed]);
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

/**
 * Only `allowedOrigin` may be fetched. `upstream` (origin -> fn) answers
 * mocked upstreams for the contract tests; everything else is recorded and
 * refused.
 */
function blockNetwork(t, allowedOrigin, upstream = {}) {
  const real = globalThis.fetch;
  const blocked = [];
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(String(input?.url ?? input));
    if (url.origin === allowedOrigin) return real(input, init);
    blocked.push(url.origin);
    if (upstream[url.origin]) return upstream[url.origin](url, init);
    return Promise.reject(new Error(`network blocked: ${url.origin}`));
  });
  return blocked;
}

const ENV_ON = (url) => ({
  GEV_BRIDGE_LAUNCHES: '1',
  GEV_BRIDGE_CELESTRAK: '1',
  GEV_COLLECTOR_URLS: url,
  GEV_COLLECTOR_TIMEOUT_MS: '500',
});

// --------------------------------------------------------------- contract
test('contract: GEV rocketLaunchesProxy relays the LL2 bytes == collector /v1/latest/launches', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshCwd(t);
  const calls = blockNetwork(t, 'http://127.0.0.1:9', {
    'https://ll.thespacedevs.com': async () =>
      new Response(LL2_UPSTREAM, { status: 200 }),
  });
  const request = chain([rocketLaunchesProxy()]);
  const r = await request('/api/launches');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], CONTENT_TYPE.launches);
  assert.ok(r.body.equals(COLLECTOR.launches), 'byte-identical');
  assert.deepEqual(calls, ['https://ll.thespacedevs.com']);
});

test('contract: GEV celestrakProxy relays the GP CSV bytes == collector /v1/latest/celestrak-<group>', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  freshCwd(t);
  const groups = [];
  blockNetwork(t, 'http://127.0.0.1:9', {
    'https://celestrak.org': async (url) => {
      const g = url.searchParams.get('GROUP');
      groups.push(g);
      return new Response(GP[g], { status: 200 });
    },
  });
  const request = chain([celestrakProxy()]);
  for (const g of ['active', 'stations']) {
    const r = await request(`/api/celestrak/${g}`);
    assert.equal(r.statusCode, 200, g);
    assert.equal(r.headers['content-type'], 'text/plain', g);
    assert.ok(
      r.body.equals(COLLECTOR[`celestrak-${g}`]),
      `${g}: byte-identical (CRLF kept)`,
    );
  }
  assert.deepEqual(groups, ['active', 'stations']);
});

// --------------------------------------------------------------- registry
test('registry: B7 entries, cadences match the collector, both namespaces terminal, no group list', () => {
  const l = BRIDGE_FEEDS.launches;
  assert.equal(l.route, '/api/launches');
  assert.equal(l.collectorFeed, 'launches');
  assert.equal(l.cadenceMs, 900_000, 'gev-history launches.js 15 min');
  assert.equal(l.flag, 'GEV_BRIDGE_LAUNCHES');
  assert.equal(l.terminal, true);
  const c = BRIDGE_FEEDS.celestrak;
  assert.equal(c.route, '/api/celestrak');
  assert.equal(c.collectorFeedPrefix, 'celestrak-');
  assert.equal(c.cadenceMs, 21_600_000, 'gev-history celestrak.js 6 h');
  assert.equal(c.flag, 'GEV_BRIDGE_CELESTRAK');
  assert.equal(c.terminal, true);
  assert.equal(c.collectorFeed, undefined, 'groups are discovered, not listed');
  const re = new RegExp(c.pathPattern);
  for (const ok of ['/stations', '/glo-ops', '/gps-ops', '/active'])
    assert.ok(re.test(ok), ok);
  for (const bad of ['/', '//', '/a/b', '/STATIONS', '/%73tations', '/a.b'])
    assert.ok(!re.test(bad), bad);
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_LAUNCHES: '1' }), [
    'launches',
  ]);
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_CELESTRAK: '1' }), [
    'celestrak',
  ]);
});

// ---------------------------------------------------------- integration
test('network-blocked: launches + per-group CelesTrak relay collector bytes, then each group its own last-good STALE, zero upstream calls', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  const cwd = freshCwd(t);
  const lastOk = T;
  let now = lastOk + 1_000;
  const collector = await startCollector(t, { lastOk });
  const blocked = blockNetwork(t, collector.url);
  const request = chain([
    ...historyPlugins({ env: ENV_ON(collector.url), now: () => now }),
    rocketLaunchesProxy(),
    celestrakProxy(),
  ]);
  const routes = {
    '/api/launches': 'launches',
    '/api/celestrak/active': 'celestrak-active',
    '/api/celestrak/stations': 'celestrak-stations',
    '/api/celestrak/starlink': 'celestrak-starlink',
  };
  for (const [route, feed] of Object.entries(routes)) {
    const live = await request(route);
    assert.equal(live.statusCode, 200, route);
    assert.ok(live.body.equals(COLLECTOR[feed]), `${route}: bytes relayed`);
    assert.equal(live.headers['content-type'], CONTENT_TYPE[feed], route);
    assert.equal(live.headers['x-feed-bridge'], 'collector', route);
  }
  assert.deepEqual(
    collector.seen,
    Object.values(routes).map((f) => `/v1/latest/${f}`),
  );
  // a group the collector has just discovered (no snapshot yet): 503 here
  const fresh = await request('/api/celestrak/geo');
  assert.equal(fresh.statusCode, 503);
  assert.equal(fresh.headers['x-feed-reason'], 'no_snapshot');

  await collector.stop();
  now = lastOk + 20 * 3_600_000; // past 3 x 6 h for CelesTrak
  for (const [route, feed] of Object.entries(routes)) {
    const r = await request(route);
    assert.equal(r.statusCode, 200, route);
    assert.ok(r.body.equals(COLLECTOR[feed]), `${route}: its OWN last good`);
    assert.equal(r.headers['x-feed-cache'], 'STALE', route);
    assert.equal(r.headers['x-feed-bridge'], 'cache', route);
    const threshold = feed === 'launches' ? 3 * 900_000 : 3 * 21_600_000;
    assert.equal(
      r.headers['x-feed-stale-since'],
      String(lastOk + threshold),
      route,
    );
    assert.equal(
      r.headers['x-feed-grey-until'],
      String(lastOk + threshold + 3_600_000),
      route,
    );
    assert.equal(r.headers['x-feed-reason'], 'collector_down', route);
  }
  assert.deepEqual(blocked, [], 'no request ever left for an upstream');
  assert.ok(!existsSync(join(cwd, '.gev-cache', 'celestrak-HALT.json')));
});

test('terminal: odd sub-paths and methods never reach GEV launch / CelesTrak proxies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  const cwd = freshCwd(t);
  const blocked = blockNetwork(t, 'http://127.0.0.1:9', {
    'https://ll.thespacedevs.com': async () =>
      new Response(LL2_UPSTREAM, { status: 200 }),
    'https://celestrak.org': async () => new Response('x', { status: 500 }),
  });
  const request = chain([
    ...historyPlugins({ env: ENV_ON('http://127.0.0.1:9') }),
    rocketLaunchesProxy(),
    celestrakProxy(),
  ]);
  for (const [method, path, status] of [
    ['GET', '/api/launches/x', 404],
    ['GET', '/api/launches//', 404],
    ['POST', '/api/launches', 405],
    ['POST', '/api/launches/x', 404],
    ['GET', '/api/celestrak', 404],
    ['GET', '/api/celestrak/', 404],
    ['GET', '/api/celestrak/STATIONS', 404],
    ['GET', '/api/celestrak/%73tations', 404],
    ['GET', '/api/celestrak/stations/', 404],
    ['GET', '/api/celestrak/a/b', 404],
    ['GET', '/api/celestrak/glonass-operational?x=1', 503],
    ['POST', '/api/celestrak/stations', 405],
    ['PUT', '/api/celestrak/x', 405],
  ]) {
    const r = await request(path, method);
    assert.equal(r.statusCode, status, `${method} ${path}`);
  }
  assert.deepEqual(blocked, [], 'zero LL2 / CelesTrak attempts');
  assert.ok(
    !existsSync(join(cwd, '.gev-cache', 'celestrak-HALT.json')),
    "GEV's own CelesTrak latch never tripped",
  );
});

test('pattern route keeps at most MAX_PATTERN_SLOTS group copies, still answers the rest', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const blocked = blockNetwork(t, 'http://127.0.0.1:9');
  const lines = [];
  const request = chain([
    ...historyPlugins({
      env: ENV_ON('http://127.0.0.1:9'),
      log: (l) => lines.push(l),
    }),
  ]);
  for (let i = 0; i < MAX_PATTERN_SLOTS + 8; i++) {
    const r = await request(`/api/celestrak/g${i}`);
    assert.equal(r.statusCode, 503);
  }
  assert.ok(lines.length <= MAX_PATTERN_SLOTS + 8);
  assert.deepEqual(blocked, []);
});

test('all B7 flags off: historyPlugins installs nothing; GEV proxies untouched', () => {
  assert.deepEqual(
    historyPlugins({
      env: { GEV_BRIDGE_LAUNCHES: '0', GEV_BRIDGE_CELESTRAK: 'true' },
    }),
    [],
  );
});
