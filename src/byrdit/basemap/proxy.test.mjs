import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import {
  basemapEnabled,
  basemapPlugins,
  basemapSettingsFromEnv,
  composeImagery,
  composeTerrain,
  createBasemapHandler,
  BASEMAP_PLUGIN_NAME,
} from './proxy.js';
import {
  basemapConfigFindings,
  basemapConfigLeakCount,
} from './configSafety.js';
import { normalizeBasemapConfig } from './config.js';

/** The P2 publish file (S5 /var/lib/gev-basemap/state/imagery-config.json, trimmed). */
const IMAGERY_PUBLISH = {
  schema: 1,
  generated: '2026-10-12T04:41:31Z',
  archive: { name: 'imagery-2025', year: 2025, bytes: 2937204473 },
  tile_url: '/imagery-2025/{z}/{x}/{y}.webp',
  missing_tile_status: 204,
  layers: [
    {
      id: 'gibs-bluemarble',
      minzoom: 0,
      maxzoom: 8,
      bounds: [-180, -85.0511, 180, 85.0511],
    },
    {
      id: 'sentinel2-2025',
      minzoom: 9,
      maxzoom: 14,
      regions: [
        {
          bounds: [-107.57812, 25.16517, -92.8125, 37.16032],
          z9_tiles: 272,
          maxzoom: 14,
        },
        {
          bounds: [18.28125, 67.33986, 21.79688, 68.65655],
          z9_tiles: 25,
          maxzoom: 13,
        },
      ],
    },
  ],
  credit: { text: 'x', year: 2025 },
};
const TERRAIN_CONFIG = {
  version: 'mh0.0.13-wm20261011',
  terrain: {
    path: '/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid',
    minzoom: 0,
    maxzoom: 14,
    format: 'quantized-mesh-1.0',
  },
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A stub terrain edge + imagery server; records what they were asked. */
async function upstreams({
  terrainStatus = 200,
  imageryStatus = null,
  extra = {},
} = {}) {
  const seen = [];
  const edge = await listen((req, res) => {
    seen.push({
      who: 'edge',
      url: req.url,
      accept: req.headers.accept,
      cookie: req.headers.cookie,
    });
    if (terrainStatus !== 200) {
      res.writeHead(terrainStatus);
      return res.end('down');
    }
    if (req.url === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...TERRAIN_CONFIG, ...extra }));
    }
    if (req.url.includes('layer.json')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'max-age=60, must-revalidate',
      });
      return res.end('{"tilejson":"2.1.0"}');
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.quantized-mesh',
      etag: '"t1"',
    });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const tiles = await listen((req, res) => {
    seen.push({ who: 'imagery', url: req.url });
    if (imageryStatus) {
      res.writeHead(imageryStatus);
      return res.end();
    }
    if (req.url === '/imagery-2025/9/0/0.webp') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'image/webp' });
    res.end(Buffer.from('RIFFxxxxWEBP'));
  });
  return {
    edge,
    tiles,
    seen,
    close: () => Promise.all([edge.close(), tiles.close()]),
  };
}

/** GET with the path sent byte for byte (fetch would normalize "..").  */
function rawStatus(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

async function gev(settings, deps = {}) {
  const handler = createBasemapHandler(
    {
      timeoutMs: 2_000,
      switch: basemapSettingsFromEnv({}).switch,
      ...settings,
    },
    { log: () => {}, ...deps },
  );
  let passed = 0;
  const front = await listen((req, res) =>
    handler(req, res, () => {
      passed += 1;
      res.writeHead(299);
      res.end('next');
    }),
  );
  return { ...front, passed: () => passed };
}

test('flag OFF by default: no plugin at all', () => {
  assert.equal(basemapEnabled({}), false);
  assert.equal(basemapEnabled({ GEV_BASEMAP: '0' }), false);
  assert.deepEqual(basemapPlugins({ env: {} }), []);
  assert.deepEqual(basemapPlugins({ env: { GEV_BASEMAP: 'true' } }), []);
});

test('flag ON: one plugin that marks index.html for the browser', () => {
  const plugins = basemapPlugins({ env: { GEV_BASEMAP: '1' } });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, BASEMAP_PLUGIN_NAME);
  assert.deepEqual(plugins[0].transformIndexHtml(), [
    {
      tag: 'meta',
      attrs: { name: 'gev-basemap', content: '1' },
      injectTo: 'head',
    },
  ]);
  const used = [];
  plugins[0].configureServer({ middlewares: { use: (fn) => used.push(fn) } });
  plugins[0].configurePreviewServer({
    middlewares: { use: (fn) => used.push(fn) },
  });
  assert.equal(used.length, 2);
});

test('settings: URL lists in order, junk dropped, switch from env', () => {
  const s = basemapSettingsFromEnv({
    GEV_BASEMAP_TERRAIN_URLS:
      'http://127.0.0.1:12350/, file:///etc, http://10.10.99.105:12350',
    GEV_BASEMAP_IMAGERY_URLS: 'http://127.0.0.1:12351',
    GEV_BASEMAP_IMAGERY_CONFIG:
      '/srv/x/config.json, http://10.10.99.101:8480/imagery/config.json',
    GEV_BASEMAP_ENTER_M: '4000',
    GEV_BASEMAP_AUTO: '0',
  });
  assert.deepEqual(s.terrainUrls, [
    'http://127.0.0.1:12350',
    'http://10.10.99.105:12350',
  ]);
  assert.deepEqual(s.imageryConfig, [
    '/srv/x/config.json',
    'http://10.10.99.101:8480/imagery/config.json',
  ]);
  assert.equal(s.switch.enterM, 4000);
  assert.equal(s.switch.leaveM, 8000);
  assert.equal(s.switch.auto, false);
});

test('compose: terrain + imagery publish config -> browser config', () => {
  assert.deepEqual(composeTerrain(TERRAIN_CONFIG), {
    available: true,
    version: 'mh0.0.13-wm20261011',
    url: '/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid',
    minzoom: 0,
    maxzoom: 14,
    waterMask: true,
  });
  assert.deepEqual(composeImagery(IMAGERY_PUBLISH), {
    available: true,
    archive: 'imagery-2025',
    url: '/basemap/imagery/imagery-2025/{z}/{x}/{y}.webp',
    baseMaxzoom: 8,
    maxzoom: 14,
    year: 2025,
    regions: [
      { bounds: [-107.57812, 25.16517, -92.8125, 37.16032], maxzoom: 14 },
      { bounds: [18.28125, 67.33986, 21.79688, 68.65655], maxzoom: 13 },
    ],
  });
  assert.equal(composeTerrain({ version: '../../etc' }).available, false);
  assert.equal(
    composeImagery({ tile_url: 'http://x/{z}/{x}/{y}.webp', layers: [{}] })
      .available,
    false,
  );
});

test('GET /basemap/config.json: composed, cacheable 60 s, no credentials, browser-valid', async () => {
  const up = await upstreams({
    extra: {
      token: 'MLY|1234567890|abcdefabcdefabcdefabcdef',
      upstream: 'http://10.0.0.1',
    },
  });
  const front = await gev(
    {
      terrainUrls: [up.edge.url],
      imageryUrls: [up.tiles.url],
      imageryConfig: ['/fake/imagery-config.json'],
    },
    {
      readFileImpl: async () =>
        JSON.stringify({
          ...IMAGERY_PUBLISH,
          api_key: 'AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        }),
    },
  );
  try {
    const res = await fetch(`${front.url}/basemap/config.json`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('cache-control'),
      'max-age=60, must-revalidate',
    );
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(
      basemapConfigLeakCount(body),
      0,
      JSON.stringify(basemapConfigFindings(body)),
    );
    assert.doesNotMatch(
      JSON.stringify(body),
      /MLY|AIza|10\.0\.0\.1|127\.0\.0\.1/,
    );
    assert.equal(body.terrain.available, true);
    assert.equal(body.imagery.available, true);
    assert.deepEqual(body.switch, {
      auto: true,
      enterM: 5000,
      leaveM: 8000,
      dwellMs: 5000,
      reRootAgeMs: 9000000,
      rootAttemptsPerHour: 3,
    });
    assert.equal(normalizeBasemapConfig(body).available, true);
  } finally {
    await front.close();
    await up.close();
  }
});

test('config with the service down: 200 + available:false (the browser takes the Esri path)', async () => {
  const front = await gev({
    terrainUrls: ['http://127.0.0.1:9'],
    imageryUrls: ['http://127.0.0.1:9'],
    imageryConfig: ['http://127.0.0.1:9/config.json'],
    timeoutMs: 500,
  });
  try {
    const body = await (await fetch(`${front.url}/basemap/config.json`)).json();
    assert.equal(body.terrain.available, false);
    assert.equal(body.imagery.available, false);
    assert.equal(normalizeBasemapConfig(body).available, false);
    assert.equal(basemapConfigLeakCount(body), 0);
  } finally {
    await front.close();
  }
});

test('terrain relay: only the extensions/v query and Accept go upstream; no cookies', async () => {
  const up = await upstreams();
  const front = await gev({
    terrainUrls: [up.edge.url],
    imageryUrls: [],
    imageryConfig: [],
  });
  try {
    const res = await fetch(
      `${front.url}/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid/14/7487/10947.terrain?extensions=octvertexnormals-watermask&v=1.2.0&evil=1`,
      {
        headers: {
          accept:
            'application/vnd.quantized-mesh;extensions=octvertexnormals-watermask',
          cookie: 'session=abc',
        },
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      [...new Uint8Array(await res.arrayBuffer())],
      [1, 2, 3, 4],
    );
    assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal(res.headers.get('etag'), '"t1"');
    const hit = up.seen.find((s) => s.url.includes('.terrain'));
    assert.equal(
      hit.url,
      '/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid/14/7487/10947.terrain?extensions=octvertexnormals-watermask&v=1.2.0',
    );
    assert.match(hit.accept, /quantized-mesh/);
    assert.equal(hit.cookie, undefined);
    const layer = await fetch(
      `${front.url}/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid/layer.json`,
    );
    assert.equal(
      layer.headers.get('cache-control'),
      'max-age=60, must-revalidate',
    );
  } finally {
    await front.close();
    await up.close();
  }
});

test('imagery relay: bytes pass, a missing tile stays 204', async () => {
  const up = await upstreams();
  const front = await gev({
    terrainUrls: [],
    imageryUrls: [up.tiles.url],
    imageryConfig: [],
  });
  try {
    const ok = await fetch(
      `${front.url}/basemap/imagery/imagery-2025/14/3743/6745.webp`,
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/webp');
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal(await ok.text(), 'RIFFxxxxWEBP');
    const missing = await fetch(
      `${front.url}/basemap/imagery/imagery-2025/9/0/0.webp`,
    );
    assert.equal(missing.status, 204);
    assert.equal(missing.headers.get('cache-control'), 'public, max-age=86400');
    assert.deepEqual(
      up.seen.map((s) => s.url),
      ['/imagery-2025/14/3743/6745.webp', '/imagery-2025/9/0/0.webp'],
    );
  } finally {
    await front.close();
    await up.close();
  }
});

test('failover: a 5xx or dead first upstream -> the next one (S4 then S5)', async () => {
  const sick = await upstreams({ imageryStatus: 503 });
  const good = await upstreams();
  const front = await gev({
    terrainUrls: [],
    imageryUrls: ['http://127.0.0.1:9', sick.tiles.url, good.tiles.url],
    imageryConfig: [],
    timeoutMs: 1_000,
  });
  try {
    const res = await fetch(
      `${front.url}/basemap/imagery/imagery-2025/14/3743/6745.webp`,
    );
    assert.equal(res.status, 200);
    assert.equal(sick.seen.length, 1);
    assert.equal(good.seen.length, 1);
  } finally {
    await front.close();
    await sick.close();
    await good.close();
  }
});

test('all upstreams down: 502, not cached', async () => {
  const front = await gev({
    terrainUrls: [],
    imageryUrls: ['http://127.0.0.1:9'],
    imageryConfig: [],
    timeoutMs: 500,
  });
  try {
    const res = await fetch(
      `${front.url}/basemap/imagery/imagery-2025/1/0/0.webp`,
    );
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await front.close();
  }
});

test('not an open proxy: unknown paths 404, other methods 405, other routes pass through', async () => {
  const up = await upstreams();
  const front = await gev({
    terrainUrls: [up.edge.url],
    imageryUrls: [up.tiles.url],
    imageryConfig: [],
  });
  try {
    for (const path of [
      '/basemap/imagery/../../etc/passwd',
      '/basemap/imagery/imagery-2025/1/0/0.png',
      '/basemap/imagery/a%2F..%2Fb/1/0/0.webp',
      '/basemap/v/x/terrain/cesium-mesh/ellipsoid/../../config.json',
      '/basemap/http://evil.example/x',
      '/basemap/',
    ]) {
      assert.equal(await rawStatus(front.url, path), 404, path);
    }
    const post = await fetch(`${front.url}/basemap/config.json`, {
      method: 'POST',
    });
    assert.equal(post.status, 405);
    const other = await fetch(`${front.url}/api/flights`);
    assert.equal(other.status, 299);
    assert.equal(front.passed(), 1);
    assert.equal(up.seen.length, 0, 'nothing reached an upstream');
  } finally {
    await front.close();
    await up.close();
  }
});

test('configSafety flags credential fields, key-shaped values and absolute URLs', () => {
  const findings = basemapConfigFindings({
    terrain: { url: '/basemap/v/x', apiKey: 'x' },
    imagery: { url: 'https://tile.example/{z}/{x}/{y}?key=abc' },
    other: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'],
  });
  assert.deepEqual(findings.credentialFields, ['terrain.apiKey']);
  assert.deepEqual(findings.credentialValues, ['imagery.url', 'other[0]']);
  assert.deepEqual(findings.externalUrls, ['imagery.url']);
  assert.equal(basemapConfigLeakCount({ a: '/basemap/x', reRootAgeMs: 1 }), 0);
});

test('check-key-exposure.mjs asserts /basemap/config.json holds no credentials', () => {
  const source = readFileSync(
    new URL('../../../scripts/check-key-exposure.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /'\/basemap\/config\.json'/);
  assert.match(source, /basemapConfigFindings/);
  assert.match(source, /await checkBasemapConfig\(origin\)/);
});
