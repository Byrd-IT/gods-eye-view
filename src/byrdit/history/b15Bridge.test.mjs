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
  // R4: tile/image are answered by the bridge itself, never passed on
  assert.deepEqual(resolveWeather(u('/tile?product=radar')), {
    local: 'weatherImagery',
  });
  assert.deepEqual(resolveWeather(u('/image?product=radar')), {
    local: 'weatherImagery',
  });
  assert.equal(resolveWeather(u('/tile/')), null);
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
function rig({
  now = () => WEATHER_NOW,
  liveFetchImpl,
  injectWeather = true,
} = {}) {
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
    if (collector.failFeeds?.has(feed)) throw new TypeError('collector down');
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
      ...(liveFetchImpl ? { liveFetchImpl } : {}),
      // server/byrdit/history.js injects GEV's weatherProxy the same way
      ...(injectWeather ? { weatherProxy } : {}),
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

test('integration: weather manifest from the collector; invalid queries answered offline', async () => {
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
  } finally {
    r.restore();
  }
});

// ------------------------------------------------- R4 weather tile / image
// Review t_c057aa83 R4: with the bridge on, /api/weather/tile and /image
// validate time/bounds against COLLECTOR-owned capabilities (collector
// snapshot nowcoast-caps-<service>); only GetMap image bytes are live, and
// GEV never requests NOAA GetCapabilities, also not when the collector is
// down. Every case starts with cold caches (a fresh rig = a fresh bridge).
const RADAR_MANIFEST = JSON.parse(
  fx('b15-collector-weather-radar.body').toString('utf8'),
);
const RADAR_TIME = RADAR_MANIFEST.latest;
const tileUrl = (time = RADAR_TIME, x = 0) =>
  `/api/weather/tile?product=radar&time=${encodeURIComponent(time)}&z=0&x=${x}&y=0`;
const imageUrl = (time = RADAR_TIME) =>
  `/api/weather/image?product=radar&time=${encodeURIComponent(time)}&size=1024x512`;

/** A PNG header weatherProxy's validatePng accepts for width x height. */
function png(width, height) {
  const b = Buffer.alloc(64);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Live nowCOAST stand-in: answers GetMap only, records every request. */
function liveNoaa() {
  const live = { urls: [] };
  live.fetch = async (url) => {
    const u = new URL(String(url));
    live.urls.push(u.href);
    const req = u.searchParams.get('request');
    if (req !== 'GetMap') return new Response('', { status: 500 });
    return new Response(
      png(
        Number(u.searchParams.get('width')),
        Number(u.searchParams.get('height')),
      ),
      { status: 200, headers: { 'Content-Type': 'image/png' } },
    );
  };
  live.capabilities = () =>
    live.urls.filter((x) => /request=getcapabilities/i.test(x));
  return live;
}

function radarCaps(r, { stale = false, lastOk = WEATHER_NOW - 1000 } = {}) {
  r.snapshots.set('nowcoast-caps-weather-radar', {
    body: fx('b15-nowcoast-weather_radar.xml'),
    type: 'application/xml',
    lastOk,
    stale,
  });
}

for (const [kind, path, size] of [
  ['tile', tileUrl, [256, 256]],
  ['image', imageUrl, [1024, 512]],
]) {
  test(`R4 weather ${kind}: cold cache, collector up -> validated by collector metadata; GetMap only, zero GetCapabilities`, async () => {
    const live = liveNoaa();
    const r = rig({ liveFetchImpl: live.fetch });
    try {
      radarCaps(r);
      const res = await r.call(path());
      assert.equal(res.statusCode, 200, String(res.body));
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.body.readUInt32BE(16), size[0]);
      assert.ok(
        r.collector.calls.some((u) =>
          u.endsWith('/v1/latest/nowcoast-caps-weather-radar'),
        ),
        'metadata read from the collector',
      );
      assert.equal(live.urls.length, 1);
      assert.match(live.urls[0], /request=GetMap/);
      assert.deepEqual(live.capabilities(), [], 'no GetCapabilities from GEV');
      assert.deepEqual(r.blocked, []);
      // a time the collector metadata does not list: 400, no GetMap
      const unknown = await r.call(path('2026-10-12T09:00:00.000Z'));
      assert.equal(unknown.statusCode, 400);
      assert.equal(JSON.parse(unknown.body).error, 'unknown_weather_time');
      assert.equal(live.urls.length, 1);
    } finally {
      r.restore();
    }
  });

  test(`R4 weather ${kind}: cold cache, collector down -> 503, no NOAA request at all`, async () => {
    const live = liveNoaa();
    const r = rig({ liveFetchImpl: live.fetch });
    try {
      radarCaps(r);
      r.collector.up = false;
      const res = await r.call(path());
      assert.equal(res.statusCode, 503);
      assert.deepEqual(live.urls, [], 'no GetCapabilities, no GetMap');
      assert.deepEqual(r.blocked, [], 'no global fetch either');
    } finally {
      r.restore();
    }
  });

  test(`R4 weather ${kind}: cold cache, collector metadata STALE -> 503, no NOAA request`, async () => {
    const live = liveNoaa();
    const r = rig({ liveFetchImpl: live.fetch });
    try {
      radarCaps(r, { stale: true });
      const res = await r.call(path());
      assert.equal(res.statusCode, 503);
      assert.deepEqual(live.urls, []);
      assert.deepEqual(r.blocked, []);
    } finally {
      r.restore();
    }
  });
}

test('R4 weather: warm cache then collector down -> cached frame served, NO new GetMap for stale metadata, no GetCapabilities', async () => {
  let t = WEATHER_NOW;
  const live = liveNoaa();
  const r = rig({ now: () => t, liveFetchImpl: live.fetch });
  try {
    radarCaps(r);
    assert.equal((await r.call(tileUrl())).statusCode, 200);
    assert.equal(live.urls.length, 1);
    // collector gone; metadata TTL (120 s) passed -> metadata is stale
    r.collector.up = false;
    t += 5 * 60_000;
    const cached = await r.call(tileUrl());
    assert.equal(cached.statusCode, 200, 'cached frame still served');
    const fresh = await r.call(tileUrl(RADAR_TIME, 1));
    assert.equal(fresh.statusCode, 503, 'stale metadata: no new frame');
    assert.equal(live.urls.length, 1, 'no GetMap for a stale manifest');
    assert.deepEqual(live.capabilities(), []);
    assert.deepEqual(r.blocked, []);
    // the collector comes back (after weatherProxy's 30 s retry gap)
    r.collector.up = true;
    radarCaps(r, { lastOk: t });
    t += 31_000;
    assert.equal((await r.call(tileUrl(RADAR_TIME, 1))).statusCode, 200);
    assert.equal(live.urls.length, 2);
    assert.deepEqual(live.capabilities(), []);
  } finally {
    r.restore();
  }
});

test('R4 weather: an expired frame (older than 24 h) is refused before any request', async () => {
  const live = liveNoaa();
  const r = rig({
    now: () => WEATHER_NOW + 25 * 3600_000,
    liveFetchImpl: live.fetch,
  });
  try {
    radarCaps(r, { lastOk: WEATHER_NOW + 25 * 3600_000 - 1000 });
    const res = await r.call(tileUrl());
    // every time in the capture is > 24 h old at this clock: weatherProxy
    // rejects the metadata as expired and never asks for the image
    assert.equal(res.statusCode, 503);
    assert.deepEqual(live.urls, []);
    assert.deepEqual(r.blocked, []);
  } finally {
    r.restore();
  }
});

test('R4 weather: without the injected weatherProxy the bridge fails closed (503, no request)', async () => {
  const live = liveNoaa();
  const r = rig({ liveFetchImpl: live.fetch, injectWeather: false });
  try {
    radarCaps(r);
    const res = await r.call(tileUrl());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(live.urls, []);
    assert.deepEqual(r.blocked, [], 'never reached the live plugin');
  } finally {
    r.restore();
  }
});

test('R4 weather: server/byrdit/history.js injects GEV weatherProxy (vite.config.js composition)', async () => {
  const { historyPlugins: serverHistoryPlugins } =
    await import('../../../server/byrdit/history.js');
  const live = liveNoaa();
  const collectorFetch = async (url) => {
    assert.ok(url.endsWith('/v1/latest/nowcoast-caps-weather-radar'), url);
    return new Response(fx('b15-nowcoast-weather_radar.xml'), {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'X-Feed-Cache': 'HIT',
        'X-Feed-Last-OK': String(WEATHER_NOW - 1000),
      },
    });
  };
  const call = chain(
    serverHistoryPlugins({
      env: { GEV_BRIDGE_WEATHER: '1', GEV_COLLECTOR_URLS: 'http://c.test' },
      fetchImpl: collectorFetch,
      liveFetchImpl: live.fetch,
      now: () => WEATHER_NOW,
      log: () => {},
    }),
  );
  const res = await call(tileUrl());
  assert.equal(res.statusCode, 200);
  assert.equal(live.urls.length, 1);
  assert.match(live.urls[0], /request=GetMap/);
});

test('R4 weather: flag off -> no bridge middleware; GEV provider unchanged (rollback)', () => {
  assert.deepEqual(
    historyPlugins({ env: { GEV_COLLECTOR_URLS: 'http://collector.test' } }),
    [],
  );
  const onlyTransit = historyPlugins({
    env: { GEV_BRIDGE_TRANSIT: '1' },
  });
  const mounted = [];
  for (const p of onlyTransit)
    p.configureServer({ middlewares: { use: (route) => mounted.push(route) } });
  assert.deepEqual(mounted, ['/api/transit'], 'weather not bridged');
});

test('flags off: no B15 middleware at all', () => {
  assert.deepEqual(historyPlugins({ env: {} }), []);
});
