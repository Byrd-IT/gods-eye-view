import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { historyPlugins } from './index.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import { firmsProxy } from '../../../server/providers/firms.js';
import { firePerimetersProxy } from '../../../server/providers/firePerimeters.js';
import { cycloneProxy } from '../../../server/providers/cyclones.js';
import { parseFirmsCsv, filterTrailing24h } from '../../data/firmsCsv.js';
import { normalizeFirePerimeterSnapshot } from '../../layers/perimeters/records.js';
import {
  parseCycloneStatus,
  attachCycloneGeometry,
} from '../../../server/providers/cyclones.js';

/**
 * B6 (gev-history t_8ad36b42): bridge entries for /api/firms (+ /status),
 * /api/fire-perimeters and /api/cyclones.
 *
 * Contract fixtures (fixtures/b6-*): the raw upstream payloads captured on
 * 2026-10-12 (NIFC WFIGS, NHC CurrentStorms + GIS layers; FIRMS rows sampled
 * from GEV's own /api/firms answer, see the gev-history repo
 * test/fixtures/B6-FIXTURES.md) and the bodies the COLLECTOR rendered from
 * them (b6-collector-*.body, gev-history 36b6b16). GEV's own provider code
 * must produce exactly those bytes from the same payloads: if either side's
 * parser drifts, this file fails. Post-merge checklist item "history bridge
 * fixtures still match" covers this file too.
 */

const fx = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const FIRMS_NOW = 1_791_816_190_287;
const T = 1_791_816_615_731;
const SOURCES = [
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
  'MODIS_NRT',
];

test('contract: GEV firmsProxy payload from the fixture CSVs == collector /v1/latest/firms bytes', () => {
  // firmsProxy.refreshUpstream + buildPayload(entry, false), same `now`
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    const records = filterTrailing24h(
      parseFirmsCsv(fx(`b6-firms-area-${source}.csv`).toString('utf8')),
      FIRMS_NOW,
    );
    for (const r of records) fires.push(r);
    sources.push({ source, count: records.length, ok: true });
  }
  const kept = filterTrailing24h(fires, FIRMS_NOW);
  const gev = JSON.stringify({
    fetchedAt: FIRMS_NOW,
    stale: false,
    ttlMs: 30 * 60_000,
    sources,
    count: kept.length,
    fires: kept,
  });
  assert.equal(gev, fx('b6-collector-firms.body').toString('utf8'));
  assert.equal(kept.length, 60, '10 NOAA-20 rows are older than 24 h');
});

test('contract: GEV perimeters normalisation == collector /v1/latest/fire-perimeters bytes', () => {
  const raw = JSON.parse(fx('b6-wfigs-sample.geojson'));
  const rows = normalizeFirePerimeterSnapshot({ features: raw.features });
  assert.equal(
    JSON.stringify({ fetchedAt: T, rows }),
    fx('b6-collector-fire-perimeters.body').toString('utf8'),
  );
  assert.equal(rows.length, 8);
});

test('contract: GEV cyclone describe() == collector /v1/latest/cyclones bytes (pending and current geometry)', () => {
  const gis = [5, 6, 7].map((n) => JSON.parse(fx(`b6-nhc-gis-${n}.json`)));
  for (const [status, body, geometry] of [
    ['b6-nhc-CurrentStorms.json', 'b6-collector-cyclones.body', 'pending'],
    [
      'b6-nhc-CurrentStorms-020A.json',
      'b6-collector-cyclones-020A.body',
      'current',
    ],
  ]) {
    const storms = attachCycloneGeometry(
      parseCycloneStatus(JSON.parse(fx(status)), T),
      gis,
    );
    const gev = JSON.stringify({
      schemaVersion: 1,
      source: 'NOAA NHC / CPHC',
      attribution:
        'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
      coverage:
        'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
      fetchedAt: T,
      stale: false,
      unavailable: false,
      reason: null,
      storms,
    });
    assert.equal(gev, fx(body).toString('utf8'), body);
    assert.equal(storms[0].geometryStatus, geometry);
  }
});

test('registry: B6 entries, cadences match the collector, FIRMS status shares the FIRMS flag', () => {
  assert.deepEqual(Object.keys(BRIDGE_FEEDS), [
    'military',
    'firms',
    'firmsStatus',
    'firePerimeters',
    'cyclones',
    // B15 (t_112ad6e3) resolver entries follow the B6 ones
    'transit',
    'gbfs',
    'weather',
  ]);
  assert.equal(BRIDGE_FEEDS.firms.cadenceMs, 1_800_000);
  assert.equal(BRIDGE_FEEDS.firePerimeters.cadenceMs, 900_000);
  assert.equal(BRIDGE_FEEDS.cyclones.cadenceMs, 900_000);
  assert.equal(BRIDGE_FEEDS.firmsStatus.flag, BRIDGE_FEEDS.firms.flag);
  assert.equal(BRIDGE_FEEDS.firmsStatus.path, '/status');
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_FIRMS: '1' }), [
    'firms',
    'firmsStatus',
  ]);
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_CYCLONES: 'true' }), []);
});

// ------------------------------------------------------------ integration
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

const BODIES = {
  firms: fx('b6-collector-firms.body'),
  'fire-perimeters': fx('b6-collector-fire-perimeters.body'),
  cyclones: fx('b6-collector-cyclones-020A.body'),
  'firms-status': Buffer.from(
    JSON.stringify({
      hasKey: true,
      lastFetch: FIRMS_NOW,
      count: 60,
      stale: false,
      ttlMs: 1_800_000,
      transactions: { used: 288, limit: 5000 },
    }),
  ),
};
const SOURCE = {
  firms: 'NASA FIRMS',
  'firms-status': 'NASA FIRMS',
  'fire-perimeters': 'NIFC WFIGS',
  cyclones: 'NOAA NHC / CPHC',
};

/** A stand-in collector speaking the gev-history /v1/latest contract. */
async function startCollector(t, { lastOk }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const feed = /^\/v1\/latest\/([a-z-]+)$/.exec(req.url)?.[1];
    seen.push(req.url);
    if (!BODIES[feed]) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': SOURCE[feed],
      'X-Collector-Role': 'active',
      'X-Feed-Cache': 'HIT',
      'X-Feed-Age-Ms': '1000',
      'X-Feed-Last-OK': String(lastOk),
    });
    res.end(BODIES[feed]);
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

/** Only the collector origin may be fetched; record everything else. */
function blockNetwork(t, allowedOrigin) {
  const real = globalThis.fetch;
  const blocked = [];
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === allowedOrigin) return real(input, init);
    blocked.push(url.origin);
    return Promise.reject(new Error(`network blocked: ${url.origin}`));
  });
  return blocked;
}

function withFirmsKey(t) {
  // the GEV .env still carries FIRMS_MAP_KEY until the cutover removes it:
  // the bridge must win even while the upstream plugin COULD poll
  const before = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = 'b6-test-key-not-real-0000000000';
  t.after(() => {
    if (before === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = before;
  });
}

test('network-blocked: B6 routes relay collector bytes, then last-good STALE with zero upstream calls', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  withFirmsKey(t);
  const lastOk = T;
  let now = lastOk + 1_000;
  const collector = await startCollector(t, { lastOk });
  const blocked = blockNetwork(t, collector.url);
  const request = chain([
    ...historyPlugins({
      env: {
        GEV_BRIDGE_FIRMS: '1',
        GEV_BRIDGE_FIRE_PERIMETERS: '1',
        GEV_BRIDGE_CYCLONES: '1',
        GEV_COLLECTOR_URLS: collector.url,
        GEV_COLLECTOR_TIMEOUT_MS: '500',
      },
      now: () => now,
    }),
    firmsProxy(),
    firePerimetersProxy(),
    cycloneProxy(),
  ]);
  const routes = {
    '/api/firms': 'firms',
    '/api/firms/status': 'firms-status',
    '/api/fire-perimeters': 'fire-perimeters',
    '/api/cyclones': 'cyclones',
  };
  for (const [route, feed] of Object.entries(routes)) {
    const live = await request(route);
    assert.equal(live.statusCode, 200, route);
    assert.ok(live.body.equals(BODIES[feed]), `${route}: bytes relayed`);
    assert.equal(live.headers['x-feed-bridge'], 'collector', route);
    assert.equal(live.headers['x-feed-source'], SOURCE[feed], route);
  }
  assert.deepEqual(
    collector.seen,
    Object.values(routes).map((f) => `/v1/latest/${f}`),
  );

  await collector.stop();
  const stale = {
    '/api/firms': 3 * 1_800_000,
    '/api/firms/status': 3 * 1_800_000,
    '/api/fire-perimeters': 3 * 900_000,
    '/api/cyclones': 3 * 900_000,
  };
  now = lastOk + 2 * 3_600_000;
  for (const [route, threshold] of Object.entries(stale)) {
    const r = await request(route);
    assert.equal(r.statusCode, 200, route);
    assert.ok(r.body.equals(BODIES[routes[route]]), `${route}: last good kept`);
    assert.equal(r.headers['x-feed-cache'], 'STALE', route);
    assert.equal(r.headers['x-feed-bridge'], 'cache', route);
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
});

test('network-blocked: no snapshot -> 503 noDataSince, never the upstream plugin', async (t) => {
  t.mock.method(console, 'warn', () => {});
  withFirmsKey(t);
  const blocked = blockNetwork(t, 'http://127.0.0.1:9');
  const request = chain([
    ...historyPlugins({
      env: {
        GEV_BRIDGE_FIRMS: '1',
        GEV_BRIDGE_FIRE_PERIMETERS: '1',
        GEV_BRIDGE_CYCLONES: '1',
        GEV_COLLECTOR_URLS: 'http://127.0.0.1:9',
        GEV_COLLECTOR_TIMEOUT_MS: '300',
      },
    }),
    firmsProxy(),
    firePerimetersProxy(),
    cycloneProxy(),
  ]);
  for (const route of [
    '/api/firms',
    '/api/firms/status',
    '/api/fire-perimeters',
    '/api/cyclones',
  ]) {
    const r = await request(route);
    assert.equal(r.statusCode, 503, route);
    assert.deepEqual(JSON.parse(r.body), {
      error: 'no snapshot',
      noDataSince: null,
    });
    assert.equal(r.headers['x-feed-bridge'], 'none', route);
  }
  // non-GET is refused by the bridge (the upstream plugins would poll)
  assert.equal((await request('/api/firms', 'POST')).statusCode, 405);
  assert.equal((await request('/api/cyclones', 'POST')).statusCode, 405);
  assert.deepEqual(blocked, []);
});

test('InciWeb sub-routes and unflagged feeds stay on the GEV plugins', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const blocked = blockNetwork(t, 'http://127.0.0.1:9');
  const request = chain([
    ...historyPlugins({
      env: {
        GEV_BRIDGE_FIRE_PERIMETERS: '1',
        GEV_COLLECTOR_URLS: 'http://127.0.0.1:9',
        GEV_COLLECTOR_TIMEOUT_MS: '300',
      },
    }),
    firePerimetersProxy(),
    cycloneProxy(),
  ]);
  // /inciweb/* is not bridged: the GEV plugin answers (its upstream is
  // blocked here, so it reports unavailable), and the bridge never saw it
  const inci = await request('/api/fire-perimeters/inciweb/index');
  assert.equal(inci.statusCode, 502);
  assert.equal(inci.headers['x-feed-bridge'], undefined);
  assert.deepEqual(blocked, ['https://inciweb.wildfire.gov']);
  // cyclones flag off: GEV's own plugin answers (bridge not installed for it)
  const cyc = await request('/api/cyclones');
  assert.equal(cyc.headers['x-feed-bridge'], undefined);
  assert.equal(JSON.parse(cyc.body).unavailable, true);
});

test('all B6 flags off: historyPlugins installs nothing (byte-identical GEV)', () => {
  assert.deepEqual(
    historyPlugins({
      env: {
        GEV_BRIDGE_FIRMS: '0',
        GEV_BRIDGE_FIRE_PERIMETERS: '',
        GEV_BRIDGE_CYCLONES: 'yes',
      },
    }),
    [],
  );
});
