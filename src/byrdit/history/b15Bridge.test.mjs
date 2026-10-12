import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historyPlugins } from './index.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import {
  GBFS_INFO_CADENCE_MS,
  GBFS_STATUS_CADENCE_MS,
  TRANSIT_CADENCE_MS,
  WEATHER_CADENCE_MS,
  WEATHER_PRODUCTS,
  resolveGbfs,
  resolveTransit,
  resolveWeather,
} from './feedsC.js';
import { transitProxy } from '../../../server/providers/transit.js';
import { gbfsProxy } from '../../../server/providers/gbfs.js';
import { weatherProxy } from '../../../server/providers/weather.js';
import { buildTransitSnapshot } from '../../data/transitProxy.js';
import {
  TRANSIT_ENABLED_FEEDS,
  getTransitFeed,
} from '../../data/transitFeeds.js';
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';

/**
 * B15 (gev-history t_112ad6e3): bridge entries for /api/transit/*,
 * /api/gbfs/<encoded url> and /api/weather/manifest.
 *
 * Contract fixtures (fixtures/b15-*): raw upstream payloads captured on
 * 2026-10-12 (TransLink SEQ GTFS-RT, nowCOAST weather_radar GetCapabilities,
 * Madison BCycle station_status) and the bodies the COLLECTOR rendered from
 * them (gev-history branch gev-history-b15-20261012). GEV's own code must
 * produce exactly those bytes from the same payloads; the collector repo runs
 * the mirror test against bodies GEV produced (test/b15-contract.test.js).
 * Post-merge checklist item "history bridge fixtures still match" covers this
 * file too.
 */

const fx = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const TRANSLINK_AT = 1_791_818_271_245; // collector fetchedAt of the capture
const WEATHER_NOW = Date.parse('2026-10-12T15:18:30.000Z');
const ALL_ON = {
  GEV_BRIDGE_TRANSIT: '1',
  GEV_BRIDGE_GBFS: '1',
  GEV_BRIDGE_WEATHER: '1',
  GEV_COLLECTOR_URLS: 'http://collector.test',
};
const enc = (u) => `/api/gbfs/${encodeURIComponent(u)}`;

// ---------------------------------------------------------------- contract
test('contract: GEV decodes the TransLink fixture to the collector body, byte for byte', () => {
  const feed = getTransitFeed('translink-seq');
  const body = JSON.stringify(
    buildTransitSnapshot(
      feed,
      new Uint8Array(fx('b15-transit-translink-seq.pb')),
      TRANSLINK_AT,
    ),
  );
  assert.equal(
    Buffer.compare(
      Buffer.from(body),
      fx('b15-collector-transit-translink-seq.body'),
    ),
    0,
  );
});

test('contract: GEV /api/weather/manifest?product=radar equals the collector body', async () => {
  const xml = fx('b15-nowcoast-weather_radar.xml').toString('utf8');
  const plugin = weatherProxy({
    now: () => WEATHER_NOW,
    fetchImpl: async () =>
      new Response(xml, {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      }),
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (_r, h) => (handler = h) } });
  const body = await new Promise((resolve) =>
    handler(
      { url: '/manifest?product=radar', method: 'GET' },
      { once() {}, writeHead() {}, end: (b) => resolve(Buffer.from(b)) },
    ),
  );
  assert.equal(Buffer.compare(body, fx('b15-collector-weather-radar.body')), 0);
});

test('registry: B15 entries, cadences equal the collector feeds, flags', () => {
  assert.equal(TRANSIT_CADENCE_MS, 60_000);
  assert.equal(GBFS_STATUS_CADENCE_MS, 300_000);
  assert.equal(GBFS_INFO_CADENCE_MS, 86_400_000);
  assert.equal(WEATHER_CADENCE_MS, 120_000);
  assert.equal(BRIDGE_FEEDS.transit.flag, 'GEV_BRIDGE_TRANSIT');
  assert.equal(BRIDGE_FEEDS.gbfs.flag, 'GEV_BRIDGE_GBFS');
  assert.equal(BRIDGE_FEEDS.weather.flag, 'GEV_BRIDGE_WEATHER');
  assert.deepEqual(enabledBridgeFeeds({ GEV_BRIDGE_GBFS: '1' }), ['gbfs']);
  assert.deepEqual(enabledBridgeFeeds({}), []);
});

test('resolvers: only registered ids and registry URLs map to collector snapshots', () => {
  const u = (p) => new URL(p, 'http://localhost');
  assert.deepEqual(resolveTransit(u('/feeds')).collectorFeed, 'transit-feeds');
  for (const f of TRANSIT_ENABLED_FEEDS)
    assert.equal(
      resolveTransit(u(`/vehicles/${f.id}`)).collectorFeed,
      `transit-${f.id}`,
    );
  assert.equal(resolveTransit(u('/vehicles/nyct-subway')), null);
  assert.equal(resolveTransit(u('/vehicles/%E0%A4%A')), null);
  assert.equal(resolveTransit(u('/trail/mbta/y1234')).local, 'trail');
  assert.equal(resolveTransit(u('/trail/hsl-helsinki/1')), null);
  let n = 0;
  for (const e of GBFS_CITY_REGISTRY) {
    const s = resolveGbfs(u(enc(e.stationStatusUrl).slice('/api/gbfs'.length)));
    const i = resolveGbfs(
      u(enc(e.stationInformationUrl).slice('/api/gbfs'.length)),
    );
    assert.equal(s.collectorFeed, `gbfs-${e.id}-status`);
    assert.equal(i.collectorFeed, `gbfs-${e.id}-info`);
    assert.equal(s.cadenceMs, GBFS_STATUS_CADENCE_MS);
    assert.equal(i.cadenceMs, GBFS_INFO_CADENCE_MS);
    n += 2;
  }
  assert.equal(n, 64);
  const other = resolveGbfs(
    u(
      `/${encodeURIComponent('https://gbfs.lyft.com/gbfs/2.3/xyz/en/station_status.json')}`,
    ),
  );
  assert.equal(other.reply.status, 404, 'allowlisted but not recorded');
  assert.equal(resolveGbfs(u('/')).reply.status, 400);
  assert.equal(
    resolveGbfs(
      u(`/${encodeURIComponent('https://evil.example/station_status.json')}`),
    ).reply.status,
    403,
  );
  for (const p of WEATHER_PRODUCTS)
    assert.equal(
      resolveWeather(u(`/manifest?product=${p}`)).collectorFeed,
      `weather-${p}`,
    );
  assert.equal(resolveWeather(u('/manifest?product=snow')), null);
  assert.equal(resolveWeather(u('/manifest?product=radar&x=1')), null);
  assert.equal(resolveWeather(u('/tile?product=radar')), null);
});

// ------------------------------------------------------------ integration
/** Connect-compatible dispatcher over Vite plugin configureServer hooks. */
function chain(plugins) {
  const stack = [];
  const server = {
    middlewares: { use: (route, handler) => stack.push({ route, handler }) },
    httpServer: { once() {} },
  };
  for (const plugin of plugins) plugin.configureServer?.(server);
  return async (path, method = 'GET') => {
    let done;
    const finished = new Promise((resolve) => (done = resolve));
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      once() {},
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
            handler({ url: rest, method }, res, () => dispatch(index + 1)),
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

/**
 * The REAL upstream plugins behind the history plugin, global fetch replaced
 * by a blocker that records every non-collector request and refuses it.
 */
function rig({ now = () => WEATHER_NOW } = {}) {
  const blocked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    blocked.push(String(url));
    throw new TypeError('network blocked in test');
  };
  const snapshots = new Map();
  const collector = { up: true, calls: [] };
  const collectorFetch = async (url) => {
    collector.calls.push(url);
    if (!collector.up) throw new TypeError('collector down');
    const feed = /\/v1\/latest\/([a-z0-9-]+)$/.exec(url)[1];
    const snap = snapshots.get(feed);
    if (!snap)
      return new Response('{"error":"no snapshot yet","noDataSince":null}', {
        status: 503,
        headers: { 'X-Feed-Reason': 'system_down' },
      });
    return new Response(snap.body, {
      status: 200,
      headers: {
        'Content-Type': snap.type ?? 'application/json',
        'Cache-Control': 'no-store',
        'X-Feed-Source': 'test',
        'X-Collector-Role': 'active',
        'X-Feed-Cache': snap.stale ? 'STALE' : 'HIT',
        'X-Feed-Age-Ms': '1000',
        'X-Feed-Last-OK': String(snap.lastOk),
        ...(snap.stale
          ? {
              'X-Feed-Stale-Since': String(snap.lastOk + 180_000),
              'X-Feed-Reason': 'upstream_error',
            }
          : {}),
      },
    });
  };
  const lines = [];
  const call = chain([
    ...historyPlugins({
      env: ALL_ON,
      fetchImpl: collectorFetch,
      now,
      log: (l) => lines.push(l),
    }),
    transitProxy(),
    gbfsProxy(),
    weatherProxy(),
  ]);
  return {
    call,
    blocked,
    snapshots,
    collector,
    lines,
    restore: () => (globalThis.fetch = realFetch),
  };
}

test('integration: transit vehicles relayed with GEV client headers; never an upstream call', async () => {
  const r = rig();
  try {
    r.snapshots.set('transit-translink-seq', {
      body: fx('b15-collector-transit-translink-seq.body'),
      lastOk: WEATHER_NOW - 1000,
    });
    const res = await r.call('/api/transit/vehicles/translink-seq');
    assert.equal(res.statusCode, 200);
    assert.equal(
      Buffer.compare(res.body, fx('b15-collector-transit-translink-seq.body')),
      0,
    );
    assert.equal(res.headers['x-feed-bridge'], 'collector');
    assert.equal(res.headers['x-gev-cache'], 'HIT');
    assert.equal(res.headers['x-transit-contact'], String(WEATHER_NOW - 1000));
    // stale collector snapshot -> the layer's own STALE-ERROR + grey headers
    r.snapshots.get('transit-translink-seq').stale = true;
    const stale = await r.call('/api/transit/vehicles/translink-seq');
    assert.equal(stale.headers['x-gev-cache'], 'STALE-ERROR');
    assert.ok(stale.headers['x-feed-grey-until']);
    // collector gone -> bridge copy, still no upstream
    r.collector.up = false;
    const cached = await r.call('/api/transit/vehicles/translink-seq');
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.headers['x-feed-bridge'], 'cache');
    // never-seen feed with the collector gone -> 503, no upstream
    const none = await r.call('/api/transit/vehicles/mbta');
    assert.equal(none.statusCode, 503);
    // /feeds from the collector; unknown ids answered by GEV (404) offline
    r.collector.up = true;
    r.snapshots.set('transit-feeds', { body: '{"feeds":[]}', lastOk: 1 });
    assert.equal((await r.call('/api/transit/feeds')).statusCode, 200);
    assert.equal((await r.call('/api/transit/vehicles/nyct')).statusCode, 404);
    assert.equal((await r.call('/api/transit/feeds', 'POST')).statusCode, 405);
    assert.deepEqual(r.blocked, [], 'no request ever left for an operator');
  } finally {
    r.restore();
  }
});

test('integration: MBTA trails are kept from relayed snapshots (GEV store and limits)', async () => {
  let t = WEATHER_NOW;
  const r = rig({ now: () => t });
  try {
    const snap = (fetchedAt, lat) =>
      JSON.stringify({
        feedId: 'mbta',
        name: 'MBTA',
        fetchedAt,
        feedTimestamp: Math.floor(fetchedAt / 1000),
        version: '2.0',
        entityCount: 1,
        truncated: false,
        count: 1,
        vehicles: [
          {
            id: 'y1234',
            lat,
            lon: -71.06,
            bearing: 90,
            speedMps: 5,
            timestamp: Math.floor(fetchedAt / 1000),
            routeId: '1',
            tripId: 't1',
            directionId: 0,
            label: '1234',
            stopId: null,
            status: null,
            occupancy: null,
            timestampSource: 'vehicle',
          },
        ],
      });
    for (let i = 0; i < 3; i += 1) {
      r.snapshots.set('transit-mbta', {
        body: snap(t, 42.35 + i * 0.001),
        lastOk: t,
      });
      assert.equal(
        (await r.call('/api/transit/vehicles/mbta')).statusCode,
        200,
      );
      t += 60_000;
    }
    const trail = await r.call('/api/transit/trail/mbta/y1234');
    assert.equal(trail.statusCode, 200);
    const body = JSON.parse(trail.body);
    assert.ok(JSON.stringify(body).includes('42.351'), JSON.stringify(body));
    assert.deepEqual(r.blocked, []);
  } finally {
    r.restore();
  }
});

test('integration: GBFS registry URLs from the collector; other URLs 404 and are never proxied', async () => {
  const r = rig();
  try {
    const madison = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
    r.snapshots.set('gbfs-madison-bcycle-status', {
      body: fx('b15-gbfs-madison-status.body'),
      lastOk: WEATHER_NOW,
    });
    const ok = await r.call(enc(madison.stationStatusUrl));
    assert.equal(ok.statusCode, 200);
    assert.equal(
      Buffer.compare(ok.body, fx('b15-gbfs-madison-status.body')),
      0,
    );
    assert.equal(ok.headers['x-gbfs-upstream'], 'gbfs.bcycle.com');
    // a dead registry system: the collector says system_down -> 503, quiet
    const broward = GBFS_CITY_REGISTRY.find(
      (e) => e.id === 'fort-lauderdale-broward',
    );
    const down = await r.call(enc(broward.stationStatusUrl));
    assert.equal(down.statusCode, 503);
    assert.equal(down.headers['x-feed-reason'], 'system_down');
    // allowlisted host, not a registry URL: 404 here, never fetched live
    const other = await r.call(
      enc('https://gbfs.bcycle.com/bcycle_other/station_status.json'),
    );
    assert.equal(other.statusCode, 404);
    assert.equal(
      (await r.call(enc('http://gbfs.lyft.com/x/station_status.json')))
        .statusCode,
      400,
    );
    assert.deepEqual(r.blocked, []);
    assert.ok(
      r.collector.calls.every((u) =>
        u.startsWith('http://collector.test/v1/latest/gbfs-'),
      ),
    );
  } finally {
    r.restore();
  }
});

test('integration: weather manifest from the collector; tiles stay on the live plugin', async () => {
  const r = rig();
  try {
    r.snapshots.set('weather-radar', {
      body: fx('b15-collector-weather-radar.body'),
      lastOk: WEATHER_NOW,
    });
    const m = await r.call('/api/weather/manifest?product=radar');
    assert.equal(m.statusCode, 200);
    assert.equal(
      Buffer.compare(m.body, fx('b15-collector-weather-radar.body')),
      0,
    );
    // invalid manifest queries are answered by GEV (400) before any fetch
    const bad = await r.call('/api/weather/manifest?product=snow');
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(r.blocked, [], 'manifest never read nowCOAST');
    // the tile route is NOT bridged: imagery bytes stay live (DESIGN #14)
    await r.call(
      '/api/weather/tile?product=radar&time=2026-10-12T15:11:52.000Z&z=0&x=0&y=0',
    );
    assert.ok(r.blocked.length >= 1, 'tile route reached the live plugin');
    assert.ok(
      r.blocked.every((u) => u.startsWith('https://nowcoast.noaa.gov/')),
    );
  } finally {
    r.restore();
  }
});

test('flags off: no B15 middleware at all', () => {
  assert.deepEqual(historyPlugins({ env: {} }), []);
});
