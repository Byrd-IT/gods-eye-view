import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { historyPlugins } from './index.js';
import { feedDisplayState } from './staleness.js';
import {
  openSkyProxy,
  trackBackfillProxies,
} from '../../../server/providers/live.js';

/**
 * B20 item 4: /api/flights from the collector's OpenSky viewport tile cache.
 * The REAL upstream plugins (openSkyProxy with its OpenSky / adsb.lol
 * fallback, trackBackfillProxies) sit behind the history plugin exactly as
 * vite.config.js orders them; globalThis.fetch only lets the stand-in
 * collector through and records everything else.
 */

const VIEW = '-100,29,-95,33';
const STATES = {
  time: 1_791_901_109,
  states: [
    [
      'a1b2c3',
      'TEST1   ',
      'United States',
      1_791_901_108,
      1_791_901_109,
      -97.5,
      30.2,
      3000,
      false,
      200,
      90,
      0,
      null,
      3100,
      '1200',
      false,
      0,
      3,
    ],
  ],
};
const BODY = Buffer.from(JSON.stringify(STATES));

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
          handler({ url: rest, method }, res, () => dispatch(index + 1));
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

/** Stand-in collector: POST /v1/aircraft/view + GET /v1/latest/aircraft-opensky. */
async function startCollector(t, { lastOk, headers = {} }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body });
      const ok =
        (req.method === 'POST' && req.url === '/v1/aircraft/view') ||
        (req.method === 'GET' && req.url === '/v1/latest/aircraft-opensky');
      if (!ok) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Feed-Source': 'OpenSky Network',
        'X-Flight-Coverage': 'OpenSky viewport tiles (1)',
        'X-Collector-Role': 'active',
        'X-Feed-Cache': 'HIT',
        'X-Feed-Age-Ms': '1000',
        'X-Feed-Last-OK': String(lastOk),
        'X-View-Lease': 'refreshed',
        ...headers,
      });
      res.end(BODY);
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
  return { url: `http://127.0.0.1:${server.address().port}`, stop, seen };
}

function blockNetwork(t, allowedOrigin) {
  const real = globalThis.fetch;
  const blocked = [];
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === allowedOrigin) return real(input, init);
    blocked.push(url.href);
    return Promise.reject(new Error(`network blocked: ${url.origin}`));
  });
  return blocked;
}

function request(collectorUrl, now) {
  return chain([
    ...historyPlugins({
      env: {
        GEV_BRIDGE_FLIGHTS: '1',
        GEV_COLLECTOR_URLS: collectorUrl,
        GEV_COLLECTOR_TIMEOUT_MS: '500',
        // even with credentials in the env the upstream plugin is never reached
        OPENSKY_CLIENT_ID: 'x',
        OPENSKY_CLIENT_SECRET: 'y',
      },
      now,
      log: () => {},
    }),
    openSkyProxy(),
    trackBackfillProxies(),
  ]);
}

test('view request -> POST /v1/aircraft/view {sid, bbox}; body and headers relayed', async (t) => {
  const lastOk = 1_791_901_110_000;
  const collector = await startCollector(t, { lastOk });
  const blocked = blockNetwork(t, collector.url);
  const get = request(collector.url, () => lastOk + 1_000);
  const r = await get(
    `/api/flights?lat=30.0000&lon=-97.0000&view=${VIEW}&vsid=tab-dddddddd`,
  );
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.equals(BODY));
  assert.equal(r.headers['x-feed-bridge'], 'collector');
  assert.equal(r.headers['x-flight-coverage'], 'OpenSky viewport tiles (1)');
  assert.equal(r.headers['x-feed-source'], 'OpenSky Network');
  assert.equal(collector.seen.length, 1);
  assert.equal(collector.seen[0].method, 'POST');
  assert.deepEqual(JSON.parse(collector.seen[0].body), {
    sid: 'tab-dddddddd',
    bbox: VIEW,
  });
  // no view: GET of the cached tiles, no lease, lat/lon not forwarded
  const nv = await get('/api/flights?lat=30.0000&lon=-97.0000');
  assert.equal(nv.statusCode, 200);
  assert.equal(collector.seen[1].method, 'GET');
  assert.equal(collector.seen[1].url, '/v1/latest/aircraft-opensky');
  assert.deepEqual(blocked, []);
  // other methods never reach the upstream plugin
  const post = await get('/api/flights', 'POST');
  assert.equal(post.statusCode, 405);
});

test('concurrent identical view requests share one collector read', async (t) => {
  const lastOk = 1_791_901_110_000;
  const collector = await startCollector(t, { lastOk });
  blockNetwork(t, collector.url);
  const get = request(collector.url, () => lastOk + 1_000);
  const path = `/api/flights?view=${VIEW}&vsid=tab-eeeeeeee`;
  const rs = await Promise.all([get(path), get(path), get(path)]);
  for (const r of rs) assert.equal(r.statusCode, 200);
  assert.equal(collector.seen.length, 1);
});

test('budget paused: headers relayed, grey-until added, chip "OpenSky paused until 00:00 UTC"', async (t) => {
  const lastOk = 1_791_901_110_000;
  const collector = await startCollector(t, {
    lastOk,
    headers: {
      'X-Feed-Cache': 'STALE',
      'X-Feed-Stale-Since': String(lastOk + 5_000),
      'X-Feed-Reason': 'opensky_paused_until=00:00',
    },
  });
  blockNetwork(t, collector.url);
  const get = request(collector.url, () => lastOk + 10_000);
  const r = await get(`/api/flights?view=${VIEW}&vsid=tab-ffffffff`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['x-feed-reason'], 'opensky_paused_until=00:00');
  assert.equal(
    r.headers['x-feed-grey-until'],
    String(lastOk + 5_000 + 3_600_000),
  );
  const d = feedDisplayState({ status: r.statusCode, headers: r.headers });
  assert.equal(d.state, 'grey');
  assert.equal(d.chip, 'OpenSky paused until 00:00 UTC');
});

test('NETWORK-BLOCKED: collector gone -> per-view last-good STALE, other views 503, ZERO requests to OpenSky or adsb.lol', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const lastOk = 1_791_901_110_000;
  let now = lastOk + 1_000;
  const collector = await startCollector(t, { lastOk });
  const blocked = blockNetwork(t, collector.url);
  const get = request(collector.url, () => now);
  const live = await get(`/api/flights?view=${VIEW}&vsid=tab-gggggggg`);
  assert.equal(live.statusCode, 200);
  await collector.stop();
  now = lastOk + 600_000;
  const stale = await get(`/api/flights?view=${VIEW}&vsid=tab-gggggggg`);
  assert.equal(stale.statusCode, 200);
  assert.ok(stale.body.equals(BODY), 'last good copy of THIS view');
  assert.equal(stale.headers['x-feed-cache'], 'STALE');
  assert.equal(stale.headers['x-feed-bridge'], 'cache');
  assert.equal(stale.headers['x-feed-stale-since'], String(lastOk + 135_000));
  assert.equal(stale.headers['x-feed-reason'], 'collector_down');
  const other = await get('/api/flights?view=0,45,10,55&vsid=tab-gggggggg');
  assert.equal(other.statusCode, 503, 'never another view’s copy');
  const plain = await get('/api/flights?lat=30&lon=-97');
  assert.equal(plain.statusCode, 503);
  for (const url of blocked) {
    assert.ok(!url.includes('opensky-network.org'), `OpenSky called: ${url}`);
    assert.ok(!url.includes('adsb.lol'), `adsb.lol fallback called: ${url}`);
  }
  assert.deepEqual(blocked, [], 'GEV made no upstream request at all');
});

test('CONTROL: without the bridge the same harness DOES see GEV call OpenSky', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const blocked = blockNetwork(t, 'http://127.0.0.1:9');
  const get = chain([openSkyProxy(), trackBackfillProxies()]);
  await get('/api/flights?lat=30&lon=-97');
  assert.ok(
    blocked.some(
      (u) => u.includes('opensky-network.org') || u.includes('adsb.lol'),
    ),
    `the upstream plugin reached the network: ${blocked.join(' ')}`,
  );
});

test('flag off: /api/flights is untouched (no bridge middleware)', () => {
  assert.deepEqual(historyPlugins({ env: {} }), []);
  assert.equal(historyPlugins({ env: { GEV_BRIDGE_FLIGHTS: '1' } }).length, 1);
});
