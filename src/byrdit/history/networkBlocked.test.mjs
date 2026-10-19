import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { historyPlugins } from './index.js';
import {
  adsbLolProxy,
  trackBackfillProxies,
} from '../../../server/providers/live.js';

/**
 * Network-blocked integration: the REAL upstream plugins for /api/military
 * (adsbLolProxy, trackBackfillProxies) sit behind the history plugin in a
 * connect-style chain, exactly the order vite.config.js builds. globalThis.fetch
 * only lets the local collector through; anything else (api.adsb.lol) is
 * recorded and refused. DESIGN 6 B4 accept: collector stopped -> military
 * answers the last-good body STALE with X-Feed-Stale-Since, no upstream call.
 */

const FIXTURE = readFileSync(
  new URL('./fixtures/military-latest.json', import.meta.url),
);

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

/** A stand-in collector speaking the gev-history /v1/latest contract. */
async function startCollector(t, { lastOk }) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/latest/military') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': 'adsb.lol',
      'X-Collector-Role': 'active',
      'X-Feed-Cache': 'HIT',
      'X-Feed-Age-Ms': '1000',
      'X-Feed-Last-OK': String(lastOk),
    });
    res.end(FIXTURE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  t.after(() => (server.listening ? stop() : undefined));
  return { url: `http://127.0.0.1:${server.address().port}`, stop };
}

/** Only the collector origin may be fetched; record everything else. */
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

test('collector stopped: last-good body STALE with X-Feed-Stale-Since and ZERO upstream calls', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const lastOk = 1_791_814_776_089;
  let now = lastOk + 1_000;
  const collector = await startCollector(t, { lastOk });
  const blocked = blockNetwork(t, collector.url);
  const request = chain([
    ...historyPlugins({
      env: {
        GEV_BRIDGE_MILITARY: '1',
        GEV_COLLECTOR_URLS: collector.url,
        GEV_COLLECTOR_TIMEOUT_MS: '500',
      },
      now: () => now,
    }),
    adsbLolProxy(),
    trackBackfillProxies(),
  ]);

  const live = await request('/api/military');
  assert.equal(live.statusCode, 200);
  assert.ok(live.body.equals(FIXTURE), 'collector bytes relayed unchanged');
  assert.equal(live.headers['x-feed-bridge'], 'collector');

  await collector.stop();
  now = lastOk + 3_600_000;
  const stale = await request('/api/military');
  assert.equal(stale.statusCode, 200);
  assert.ok(stale.body.equals(FIXTURE), 'last-good body, not cleared');
  assert.equal(stale.headers['x-feed-cache'], 'STALE');
  // 3 x the 300 s military cadence (t_5ad2b9a4)
  assert.equal(stale.headers['x-feed-stale-since'], String(lastOk + 900_000));
  assert.equal(stale.headers['x-feed-reason'], 'collector_down');
  assert.equal(
    stale.headers['x-feed-grey-until'],
    String(lastOk + 900_000 + 3_600_000),
  );
  assert.deepEqual(blocked, [], 'GEV made no upstream request');
});

test('collector never answered: 503 chip-only, still ZERO upstream calls', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const collector = await startCollector(t, { lastOk: 1 });
  await collector.stop(); // port is now closed: connection refused
  const blocked = blockNetwork(t, collector.url);
  const request = chain([
    ...historyPlugins({
      env: { GEV_BRIDGE_MILITARY: '1', GEV_COLLECTOR_URLS: collector.url },
    }),
    adsbLolProxy(),
  ]);
  const res = await request('/api/military');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'no snapshot',
    noDataSince: null,
  });
  const post = await request('/api/military', 'POST');
  assert.equal(post.statusCode, 405);
  assert.deepEqual(blocked, []);
});

test('bridge OFF: the request reaches the upstream plugin exactly as without the history plugin', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const answers = [];
  for (const withHistory of [false, true]) {
    const seen = [];
    t.mock.method(globalThis, 'fetch', async (input) => {
      seen.push(String(input));
      return new Response(FIXTURE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const request = chain([
      ...(withHistory ? historyPlugins({ env: {} }) : []),
      adsbLolProxy(),
    ]);
    const res = await request('/api/military');
    answers.push({
      seen,
      status: res.statusCode,
      body: res.body,
      headers: res.headers,
    });
    globalThis.fetch.mock.restore();
  }
  const [without, withOff] = answers;
  assert.deepEqual(without.seen, ['https://api.adsb.lol/v2/mil']);
  assert.deepEqual(withOff.seen, without.seen);
  assert.equal(withOff.status, without.status);
  assert.ok(withOff.body.equals(without.body));
  assert.deepEqual(withOff.headers, without.headers);
});

test('bridge ON leaves /api/military/track to its live handler', async (t) => {
  const collector = await startCollector(t, { lastOk: Date.now() });
  const seen = [];
  const real = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const href = String(typeof input === 'string' ? input : input.url);
    if (href.startsWith(collector.url)) return real(input, init);
    seen.push(href);
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const request = chain([
    ...historyPlugins({
      env: { GEV_BRIDGE_MILITARY: '1', GEV_COLLECTOR_URLS: collector.url },
    }),
    adsbLolProxy(),
    trackBackfillProxies(),
  ]);
  await request('/api/military/track?hex=ae1234');
  assert.ok(
    seen.some((href) => href.includes('ae1234')),
    'the on-demand trace stays live in v1 (DESIGN 4.2 exception)',
  );
  assert.ok(!seen.includes('https://api.adsb.lol/v2/mil'));
});
