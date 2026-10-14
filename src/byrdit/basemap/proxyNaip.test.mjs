import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { basemapSettingsFromEnv, createBasemapHandler } from './proxy.js';
import {
  composeNaip,
  naipEnabled,
  regionalBases,
  resolveNaipTile,
} from './naipProxy.js';
import { basemapConfigLeakCount } from './configSafety.js';
import { normalizeBasemapConfig } from './config.js';
import { NAIP_PUBLISH } from './fixtures/naip.mjs';

const TERRAIN_CONFIG = {
  version: 'mh0.0.13-wm20261011',
  terrain: { minzoom: 0, maxzoom: 14 },
};
const IMAGERY_PUBLISH = {
  tile_url: '/imagery-2025/{z}/{x}/{y}.webp',
  layers: [{ id: 'gibs', minzoom: 0, maxzoom: 8 }],
  credit: { year: 2025 },
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
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

/** Terrain edge + imagery + NAIP config + statewide and regional tile servers. */
async function upstreams({ naipConfig = NAIP_PUBLISH } = {}) {
  const seen = [];
  const edge = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TERRAIN_CONFIG));
  });
  const meta = await listen((req, res) => {
    seen.push({ who: 'meta', url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url === '/naip/config.json' ? naipConfig : IMAGERY_PUBLISH,
      ),
    );
  });
  const tileServer = (who) =>
    listen((req, res) => {
      seen.push({ who, url: req.url, cookie: req.headers.cookie });
      if (req.url.endsWith('/1/1/1.webp')) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': 'image/webp',
        'cache-control': 'no-store',
      });
      res.end(Buffer.from(`RIFF${who}WEBP`));
    });
  const naip = await tileServer('naip');
  const hires = await tileServer('hires');
  return {
    edge,
    meta,
    naip,
    hires,
    seen,
    close: () => Promise.all([edge, meta, naip, hires].map((s) => s.close())),
  };
}

function env(up, extra = {}) {
  return {
    GEV_BASEMAP: '1',
    GEV_BASEMAP_TERRAIN_URLS: up.edge.url,
    GEV_BASEMAP_IMAGERY_URLS: up.meta.url,
    GEV_BASEMAP_IMAGERY_CONFIG: `${up.meta.url}/imagery/config.json`,
    GEV_BASEMAP_NAIP: '1',
    GEV_BASEMAP_NAIP_CONFIG: `${up.meta.url}/naip/config.json`,
    GEV_BASEMAP_NAIP_URLS: up.naip.url,
    GEV_BASEMAP_HIRES_URLS: up.hires.url,
    ...extra,
  };
}

async function gev(environment) {
  const handler = createBasemapHandler(basemapSettingsFromEnv(environment), {
    log: () => {},
  });
  return listen((req, res) =>
    handler(req, res, () => {
      res.writeHead(299);
      res.end('next');
    }),
  );
}

test('naip flag: off unless GEV_BASEMAP_NAIP=1', () => {
  assert.equal(naipEnabled({}), false);
  assert.equal(naipEnabled({ GEV_BASEMAP_NAIP: 'true' }), false);
  assert.equal(naipEnabled({ GEV_BASEMAP_NAIP: '1' }), true);
  const s = basemapSettingsFromEnv({
    GEV_BASEMAP_NAIP: '1',
    GEV_BASEMAP_NAIP_CONFIG:
      'http://10.10.99.101:8480/naip/config.json, /var/x.json',
    GEV_BASEMAP_NAIP_URLS: 'http://127.0.0.1:12352/,http://10.10.99.105:12352',
    GEV_BASEMAP_HIRES_URLS: 'http://127.0.0.1:12353',
  });
  assert.equal(s.naip, true);
  assert.deepEqual(s.naipConfig, [
    'http://10.10.99.101:8480/naip/config.json',
    '/var/x.json',
  ]);
  assert.deepEqual(s.naipUrls, [
    'http://127.0.0.1:12352',
    'http://10.10.99.105:12352',
  ]);
  assert.equal(basemapSettingsFromEnv({}).naip, false);
});

test('composeNaip: live entries only, field by field, no upstream detail', () => {
  const { browser, routes } = composeNaip(NAIP_PUBLISH);
  assert.equal(browser.available, true);
  assert.equal(browser.defaultYear, 2024);
  assert.deepEqual(browser.years, [
    {
      year: 2024,
      url: '/basemap/naip/2024/{z}/{x}/{y}.webp',
      minzoom: 12,
      maxzoom: 18,
      bounds: [-106.69922, 25.79989, -93.42773, 36.59789],
      acquired: { from: '2024-05-14', to: '2024-11-22' },
    },
  ]);
  assert.deepEqual(
    browser.regional.map((r) => [r.id, r.year, r.credit, r.minzoom, r.maxzoom]),
    [
      ['hist-upshur-1939', 1939, 'TxGIO / USDA 1939', 12, 16],
      ['hires-2018', 2018, 'TxGIO / StratMap East Texas 2018', 14, 20],
      ['hires-2024', 2024, 'TxGIO / ETCOG 2024', 14, 20],
    ],
  );
  assert.equal(browser.regional[0].greyscale, true);
  assert.equal(basemapConfigLeakCount({ naip: browser }), 0);
  const text = JSON.stringify(browser);
  for (const secretish of ['10.10.99', 'sha256', 'pmtiles', '12353', 'archive'])
    assert.ok(!text.includes(secretish), secretish);
  assert.deepEqual(routes.years.get(2024), { archive: '2024/naip-tx-2024' });
  assert.equal(routes.years.has(2022), false); // building, not live
  assert.deepEqual(routes.regional.get('hires-2024'), {
    archive: '2024/hires-wood-upshur-2024',
    port: 12353,
  });
  assert.equal(routes.regional.has('hist-wood-1949'), false); // staged
});

test('composeNaip: bad entries dropped; nothing usable = unavailable', () => {
  const raw = structuredClone(NAIP_PUBLISH);
  raw.years[0].archive = '../etc/passwd';
  raw.regional = [
    { ...raw.regional[0], id: 'bad id' },
    { ...raw.regional[1], credit: { text: '<img src=x onerror=alert(1)>' } },
  ];
  const { browser } = composeNaip(raw);
  assert.deepEqual(browser.years, []);
  assert.deepEqual(
    browser.regional.map((r) => [r.id, r.credit]),
    [['hires-2018', 'TxGIO 2018']],
  );
  assert.deepEqual(composeNaip({}).browser, { available: false });
  assert.deepEqual(composeNaip(null).browser, { available: false });
  // No regional tile server configured: regional layers are not offered.
  assert.deepEqual(
    composeNaip(NAIP_PUBLISH, { regional: false }).browser.regional,
    [],
  );
});

test('resolveNaipTile: strict routes, unknown year/id = null, edge port applied', () => {
  const { routes } = composeNaip(NAIP_PUBLISH);
  const settings = {
    naipUrls: ['http://127.0.0.1:12352', 'http://10.10.99.105:12352'],
    hiresUrls: ['http://127.0.0.1:9999', 'http://10.10.99.105:9999'],
  };
  assert.deepEqual(
    resolveNaipTile('/basemap/naip/2024/17/30074/53392.webp', routes, settings),
    {
      bases: settings.naipUrls,
      path: '/2024/naip-tx-2024/17/30074/53392.webp',
    },
  );
  assert.deepEqual(
    resolveNaipTile(
      '/basemap/naip/regional/hires-2024/20/1/2.webp',
      routes,
      settings,
    ),
    {
      bases: ['http://127.0.0.1:12353', 'http://10.10.99.105:12353'],
      path: '/2024/hires-wood-upshur-2024/20/1/2.webp',
    },
  );
  for (const bad of [
    '/basemap/naip/2022/12/1/1.webp', // not live
    '/basemap/naip/1999/12/1/1.webp',
    '/basemap/naip/regional/hist-wood-1949/12/1/1.webp',
    '/basemap/naip/2024/12/1/1.png',
    '/basemap/naip/2024/../1/1.webp',
    '/basemap/naip/regional/../../x/1/1/1.webp',
  ])
    assert.equal(resolveNaipTile(bad, routes, settings), null, bad);
  assert.deepEqual(regionalBases(['http://a:1'], null), ['http://a:1']);
});

test('proxy: flag off = no naip key in config.json and naip routes 404', async () => {
  const up = await upstreams();
  const front = await gev(env(up, { GEV_BASEMAP_NAIP: '' }));
  try {
    const config = await (
      await fetch(`${front.url}/basemap/config.json`)
    ).json();
    assert.equal('naip' in config, false);
    assert.equal(normalizeBasemapConfig(config).naip.available, false);
    const tile = await fetch(`${front.url}/basemap/naip/2024/17/1/1.webp`);
    assert.equal(tile.status, 404);
    assert.equal(up.seen.filter((s) => s.who === 'naip').length, 0);
    assert.equal(
      up.seen.filter((s) => s.url === '/naip/config.json').length,
      0,
    );
  } finally {
    await front.close();
    await up.close();
  }
});

test('proxy: naip block composed, tiles relayed like Sentinel imagery', async () => {
  const up = await upstreams();
  const front = await gev(env(up));
  try {
    const res = await fetch(`${front.url}/basemap/config.json`);
    const config = await res.json();
    assert.equal(config.naip.available, true);
    assert.equal(basemapConfigLeakCount(config), 0);
    const naip = normalizeBasemapConfig(config).naip;
    assert.deepEqual(
      naip.years.map((y) => y.year),
      [2024],
    );
    // statewide tile -> archive path on the NAIP server, our cache policy
    const tile = await fetch(
      `${front.url}/basemap/naip/2024/17/30074/53392.webp`,
      {
        headers: { cookie: 'session=secret' },
      },
    );
    assert.equal(tile.status, 200);
    assert.equal(tile.headers.get('content-type'), 'image/webp');
    assert.equal(tile.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal(
      Buffer.from(await tile.arrayBuffer()).toString(),
      'RIFFnaipWEBP',
    );
    const missing = await fetch(`${front.url}/basemap/naip/2024/1/1/1.webp`);
    assert.equal(missing.status, 204);
    assert.equal(missing.headers.get('cache-control'), 'public, max-age=86400');
    const unknown = await fetch(`${front.url}/basemap/naip/2022/17/1/1.webp`);
    assert.equal(unknown.status, 404);
    const naipSeen = up.seen.filter((s) => s.who === 'naip');
    assert.deepEqual(
      naipSeen.map((s) => s.url),
      [
        '/2024/naip-tx-2024/17/30074/53392.webp',
        '/2024/naip-tx-2024/1/1/1.webp',
      ],
    );
    assert.ok(naipSeen.every((s) => s.cookie === undefined));
  } finally {
    await front.close();
    await up.close();
  }
});

test('proxy: regional tiles go to the hires server on its edge port', async () => {
  // The config is serialized per request, so the regional entries can name
  // the hires test server's real port after it is listening. The configured
  // hires host has a dead port: only the edge port can make this work.
  const raw = structuredClone(NAIP_PUBLISH);
  const up = await upstreams({ naipConfig: raw });
  for (const r of raw.regional) r.edge = { port: up.hires.port };
  const front = await gev(
    env(up, { GEV_BASEMAP_HIRES_URLS: `http://127.0.0.1:1` }),
  );
  try {
    const tile = await fetch(
      `${front.url}/basemap/naip/regional/hires-2024/20/250000/400000.webp`,
    );
    assert.equal(tile.status, 200);
    assert.equal(
      Buffer.from(await tile.arrayBuffer()).toString(),
      'RIFFhiresWEBP',
    );
    assert.deepEqual(
      up.seen.filter((s) => s.who === 'hires').map((s) => s.url),
      ['/2024/hires-wood-upshur-2024/20/250000/400000.webp'],
    );
  } finally {
    await front.close();
    await up.close();
  }
});

test('proxy: naip config down = stack still available, slider not offered', async () => {
  const up = await upstreams();
  const front = await gev(
    env(up, { GEV_BASEMAP_NAIP_CONFIG: 'http://127.0.0.1:1/naip/config.json' }),
  );
  try {
    const config = await (
      await fetch(`${front.url}/basemap/config.json`)
    ).json();
    assert.deepEqual(config.naip, { available: false });
    const normal = normalizeBasemapConfig(config);
    assert.equal(normal.available, true);
    assert.equal(normal.naip.available, false);
    const tile = await fetch(`${front.url}/basemap/naip/2024/17/1/1.webp`);
    assert.equal(tile.status, 404);
  } finally {
    await front.close();
    await up.close();
  }
});
