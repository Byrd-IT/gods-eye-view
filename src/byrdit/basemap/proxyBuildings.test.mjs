import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  basemapSettingsFromEnv,
  composeBuildings,
  createBasemapHandler,
} from './proxy.js';
import { basemapConfigLeakCount } from './configSafety.js';
import { normalizeBasemapConfig } from './config.js';

/** /config.json of the P5 gev-buildings edge (S5 127.0.0.1:12354, 2026-10-14). */
const BUILDINGS_EDGE_CONFIG = {
  version: 'ov2026-09-23.1-v5-add',
  release: '2026-09-23.1',
  impl: 'v5-add',
  buildings: {
    path: '/v/ov2026-09-23.1-v5-add/buildings/tileset.json',
    minzoom: 12,
    maxzoom: 14,
    bounds: [-106.65, 25.84, -93.51, 36.5],
    format: '3d-tiles-1.1+glb',
  },
  copyright:
    'Buildings &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
};
const VER = BUILDINGS_EDGE_CONFIG.version;
const TERRAIN_CONFIG = {
  version: 'mh0.0.13-wm20261011',
  terrain: { minzoom: 0, maxzoom: 14 },
};
const IMAGERY_PUBLISH = {
  tile_url: '/imagery-2025-r2/{z}/{x}/{y}.webp',
  layers: [{ id: 'base', minzoom: 0, maxzoom: 8 }],
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });
}

/** A stub gev-buildings edge (P5 routes and statuses). */
async function buildingsEdge({ status = null } = {}) {
  const seen = [];
  const edge = await listen((req, res) => {
    seen.push(req.url);
    if (status) {
      res.writeHead(status);
      return res.end('down');
    }
    if (req.url === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(BUILDINGS_EDGE_CONFIG));
    }
    if (req.url === `/v/${VER}/buildings/tileset.json`) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60, must-revalidate',
      });
      return res.end('{"asset":{"version":"1.1"}}');
    }
    if (req.url.startsWith(`/v/${VER}/buildings/old-impl/`)) {
      res.writeHead(410, { 'cache-control': 'no-store' });
      return res.end('unknown impl version, re-fetch tileset.json\n');
    }
    if (req.url === `/v/${VER}/buildings/v5-add/sub/1/0/0/tileset.json`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"asset":{"version":"1.1"},"root":{}}');
    }
    if (req.url === `/v/${VER}/buildings/v5-add/14/3743/6745.glb`) {
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'cache-control': 'public, max-age=2592000, immutable',
        etag: '"g1"',
      });
      return res.end(Buffer.from('glTF\x02\x00\x00\x00'));
    }
    res.writeHead(404);
    res.end();
  });
  return { ...edge, seen };
}

async function terrainEdge() {
  return listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TERRAIN_CONFIG));
  });
}

async function gev(settings) {
  const handler = createBasemapHandler(
    {
      ...basemapSettingsFromEnv({}),
      timeoutMs: 2_000,
      imageryUrls: ['http://127.0.0.1:9'],
      imageryConfig: ['/fake/imagery.json'],
      ...settings,
    },
    {
      log: () => {},
      readFileImpl: async () => JSON.stringify(IMAGERY_PUBLISH),
    },
  );
  const front = await listen((req, res) =>
    handler(req, res, () => {
      res.writeHead(299);
      res.end('next');
    }),
  );
  return front;
}

test('settings: buildings URL list and threshold from env, defaults otherwise', () => {
  const s = basemapSettingsFromEnv({
    GEV_BASEMAP_BUILDINGS_URLS:
      'http://127.0.0.1:12354/, ftp://x, http://10.10.99.105:12354',
    GEV_BASEMAP_BUILDINGS_BELOW_M: '6000',
  });
  assert.deepEqual(s.buildingsUrls, [
    'http://127.0.0.1:12354',
    'http://10.10.99.105:12354',
  ]);
  assert.equal(s.buildings.showBelowM, 6000);
  assert.equal(s.buildings.hideAboveM, 7500);
  const d = basemapSettingsFromEnv({});
  assert.deepEqual(d.buildingsUrls, []);
  assert.deepEqual(d.buildings, {
    showBelowM: 8000,
    hideAboveM: 10000,
    maximumScreenSpaceError: 16,
    cacheBytes: 268435456,
    maximumCacheOverflowBytes: 134217728,
  });
});

test('compose: edge config -> browser buildings block, field by field', () => {
  const b = composeBuildings(BUILDINGS_EDGE_CONFIG);
  assert.deepEqual(b, {
    available: true,
    version: VER,
    url: `/basemap/v/${VER}/buildings/tileset.json`,
    minzoom: 12,
    maxzoom: 14,
    bounds: [-106.65, 25.84, -93.51, 36.5],
    showBelowM: 8000,
    hideAboveM: 10000,
    maximumScreenSpaceError: 16,
    cacheBytes: 268435456,
    maximumCacheOverflowBytes: 134217728,
  });
  assert.doesNotMatch(JSON.stringify(b), /copyright|https?:|<a /);
  for (const bad of [
    { ...BUILDINGS_EDGE_CONFIG, version: '../x' },
    {
      ...BUILDINGS_EDGE_CONFIG,
      buildings: { path: 'http://evil/v/x/buildings/tileset.json' },
    },
    { ...BUILDINGS_EDGE_CONFIG, buildings: { path: '/v/other/buildings/tileset.json' } },
    null,
  ])
    assert.equal(composeBuildings(bad).available, false);
});

test('GET /basemap/config.json carries buildings; no credential, URL or edge markup', async () => {
  const edge = await buildingsEdge();
  const terrain = await terrainEdge();
  const front = await gev({
    terrainUrls: [terrain.url],
    buildingsUrls: ['http://127.0.0.1:9', edge.url],
  });
  try {
    const body = await (await fetch(`${front.url}/basemap/config.json`)).json();
    assert.equal(body.buildings.available, true);
    assert.equal(body.buildings.url, `/basemap/v/${VER}/buildings/tileset.json`);
    assert.equal(basemapConfigLeakCount(body), 0);
    assert.doesNotMatch(JSON.stringify(body), /copyright|127\.0\.0\.1|openstreetmap/i);
    const config = normalizeBasemapConfig(body);
    assert.equal(config.available, true);
    assert.equal(config.buildings.available, true);
    assert.equal(config.buildings.showBelowM, 8000);
  } finally {
    await front.close();
    await edge.close();
    await terrain.close();
  }
});

test('no buildings edge configured: the stack is available without buildings; routes 502', async () => {
  const terrain = await terrainEdge();
  const front = await gev({ terrainUrls: [terrain.url], buildingsUrls: [] });
  try {
    const body = await (await fetch(`${front.url}/basemap/config.json`)).json();
    assert.deepEqual(body.buildings, { available: false });
    const config = normalizeBasemapConfig(body);
    assert.equal(config.available, true);
    assert.equal(config.buildings.available, false);
    const res = await fetch(`${front.url}/basemap/v/${VER}/buildings/tileset.json`);
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await front.close();
    await terrain.close();
  }
});

test('buildings relay: root 60 s, versioned sub-tilesets and glb 30 d, 404 1 d, 410 never cached', async () => {
  const edge = await buildingsEdge();
  const front = await gev({ buildingsUrls: [edge.url] });
  const get = (path, init) => fetch(`${front.url}/basemap/v/${VER}/buildings/${path}`, init);
  try {
    let res = await get('tileset.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'max-age=60, must-revalidate');
    assert.equal((await res.json()).asset.version, '1.1');
    res = await get('v5-add/sub/1/0/0/tileset.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
    await res.arrayBuffer();
    res = await get('v5-add/14/3743/6745.glb');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal(res.headers.get('etag'), '"g1"');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'glTF');
    res = await get('v5-add/14/1/1.glb');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
    res = await get('old-impl/14/1/1.glb');
    assert.equal(res.status, 410);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    res = await get('v5-add/14/3743/6745.glb', { method: 'HEAD' });
    assert.equal(res.status, 200);
    // Query strings are not forwarded.
    await (await get('tileset.json?key=secret&v=1')).arrayBuffer();
    assert.ok(edge.seen.every((u) => !u.includes('?')), edge.seen.join(' '));
  } finally {
    await front.close();
    await edge.close();
  }
});

test('buildings failover: a 5xx edge -> the standby', async () => {
  const down = await buildingsEdge({ status: 503 });
  const up = await buildingsEdge();
  const front = await gev({ buildingsUrls: [down.url, up.url] });
  try {
    const res = await fetch(`${front.url}/basemap/v/${VER}/buildings/v5-add/14/3743/6745.glb`);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.equal(down.seen.length, 1);
    assert.equal(up.seen.length, 1);
  } finally {
    await front.close();
    await down.close();
    await up.close();
  }
});

test('buildings routes are strict: no traversal, no debug or raw-data paths', async () => {
  const edge = await buildingsEdge();
  const front = await gev({ buildingsUrls: [edge.url] });
  const status = (path) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(front.url);
      const req = http.request({ hostname, port, path, method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  try {
    for (const path of [
      `/basemap/v/${VER}/buildings/../../../config.json`,
      `/basemap/v/${VER}/buildings/v5-add/sub/1/0/tileset.json`,
      `/basemap/v/${VER}/buildings/v5-add/14/1/1.pbf`,
      `/basemap/v/${VER}/buildings/debug/overture.pmtiles`,
      `/basemap/v/${VER}/buildings/`,
      '/basemap/buildings/tileset.json',
      `/basemap/v/${VER}/buildings/v5-add/14/1/1.glb/x`,
    ])
      assert.equal(await status(path), 404, path);
    assert.deepEqual(edge.seen, []);
  } finally {
    await front.close();
    await edge.close();
  }
});
