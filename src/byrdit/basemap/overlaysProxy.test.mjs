import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { basemapSettingsFromEnv, createBasemapHandler } from './proxy.js';
import {
  composeOverlays,
  overlayBases,
  safeErrorText,
  overlaysEnabled,
  resolveOverlayTile,
} from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { basemapConfigLeakCount } from './configSafety.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';

const listen = (handler) =>
  new Promise((resolve) => {
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

async function upstreams() {
  const seen = [];
  const manifest = { port: 0 };
  const meta = await listen((req, res) => {
    seen.push({ who: 'meta', url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url === '/m2/overlays.json'
          ? {
              ...OVERLAYS_PUBLISH,
              // the edge port of the manifest points at the stub, never at a real edge
              layers: OVERLAYS_PUBLISH.layers.map((l) => ({
                ...l,
                edge: { ...l.edge, port: manifest.port },
              })),
            }
          : {
                tile_url: '/imagery-2025/{z}/{x}/{y}.webp',
                layers: [{ id: 'gibs', minzoom: 0, maxzoom: 8 }],
                credit: { year: 2025 },
              },
      ),
    );
  });
  const edge = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 'v1', terrain: { minzoom: 0, maxzoom: 14 } }));
  });
  const hires = await listen((req, res) => {
    seen.push({ who: 'hires', url: req.url, cookie: req.headers.cookie });
    if (req.url.endsWith('/1/1/1.mvt')) {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, {
      'content-type': req.url.endsWith('.mvt')
        ? 'application/vnd.mapbox-vector-tile'
        : 'image/webp',
    });
    res.end(Buffer.from('TILE'));
  });
  manifest.port = hires.port;
  return {
    manifest,
    meta,
    edge,
    hires,
    seen,
    close: () => Promise.all([meta, edge, hires].map((s) => s.close())),
  };
}

const env = (up, extra = {}) => ({
  GEV_BASEMAP: '1',
  GEV_BASEMAP_TERRAIN_URLS: up.edge.url,
  GEV_BASEMAP_IMAGERY_URLS: up.meta.url,
  GEV_BASEMAP_IMAGERY_CONFIG: `${up.meta.url}/imagery/config.json`,
  GEV_BASEMAP_OVERLAYS: '1',
  GEV_BASEMAP_OVERLAYS_CONFIG: `${up.meta.url}/m2/overlays.json`,
  GEV_BASEMAP_HIRES_URLS: up.hires.url,
  ...extra,
});

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

test('overlays flag: off unless GEV_BASEMAP_OVERLAYS=1', () => {
  assert.equal(overlaysEnabled({}), false);
  assert.equal(overlaysEnabled({ GEV_BASEMAP_OVERLAYS: 'true' }), false);
  assert.equal(overlaysEnabled({ GEV_BASEMAP_OVERLAYS: '1' }), true);
  const s = basemapSettingsFromEnv({
    GEV_BASEMAP_OVERLAYS: '1',
    GEV_BASEMAP_OVERLAYS_CONFIG: 'http://10.10.99.101:8480/hires/m2/overlays.json, /x.json',
  });
  assert.equal(s.overlays, true);
  assert.deepEqual(s.overlaysConfig, [
    'http://10.10.99.101:8480/hires/m2/overlays.json',
    '/x.json',
  ]);
  assert.equal(basemapSettingsFromEnv({}).overlays, false);
});

test('composeOverlays: live layers only, field by field, no upstream detail', () => {
  const { browser, routes } = composeOverlays(OVERLAYS_PUBLISH);
  assert.equal(browser.available, true);
  assert.deepEqual(
    browser.layers.map((l) => [l.id, l.kind, l.format, l.defaultOpacity]),
    [
      ['ustopo', 'raster', 'webp', 1],
      ['hillshade', 'raster', 'webp', 0.5],
      ['relief', 'raster', 'webp', 0.6],
      ['terrain-rgb', 'raster', 'webp', 1],
      ['contours', 'vector', 'mvt', 1],
      ['lake-depth', 'vector', 'mvt', 1],
    ],
  );
  const lake = browser.layers.at(-1);
  assert.equal(lake.url, '/basemap/overlay/lake-depth/{z}/{x}/{y}.mvt');
  assert.deepEqual(lake.vectorLayers.map((v) => v.id), [
    'lake_pool',
    'bathy_major',
    'bathy_contours',
  ]);
  assert.equal(basemapConfigLeakCount({ overlays: browser }), 0);
  const text = JSON.stringify(browser);
  for (const secretish of ['10.10.99', 'sha256', 'pmtiles', '12353', 'archive', 'm2/'])
    assert.ok(!text.includes(secretish), secretish);
  assert.equal(routes.has('staged'), false);
  assert.deepEqual(routes.get('contours'), {
    archive: 'm2/contours-3dep1m',
    format: 'mvt',
    port: 12353,
  });
});

test('composeOverlays: bad entries dropped; nothing usable = unavailable', () => {
  const raw = structuredClone(OVERLAYS_PUBLISH);
  raw.layers[0].archive = '../etc/passwd';
  raw.layers[1].id = 'Bad Id';
  raw.layers[2].format = 'mvt'; // kind/format mismatch
  raw.layers[3].bounds = [1, 2, 0, 3];
  raw.layers[4].name = '<img src=x onerror=alert(1)>';
  raw.layers[5].default_opacity = 7;
  const { browser } = composeOverlays(raw);
  assert.deepEqual(browser.layers.map((l) => [l.id, l.name, l.defaultOpacity]), [
    ['contours', 'contours', 1],
    ['lake-depth', 'TWDB lake depth contours', 1],
  ]);
  assert.deepEqual(composeOverlays({}).browser, { available: false });
  assert.deepEqual(composeOverlays(null).browser, { available: false });
});

test('resolveOverlayTile: strict routes, id and extension must match, edge port applied', () => {
  const { routes } = composeOverlays(OVERLAYS_PUBLISH);
  const settings = { hiresUrls: ['http://127.0.0.1:9999'] };
  assert.deepEqual(
    resolveOverlayTile('/basemap/overlay/hillshade/15/7678/13134.webp', routes, settings),
    { bases: ['http://127.0.0.1:12353'], path: '/m2/hillshade-3dep1m/15/7678/13134.webp' },
  );
  assert.deepEqual(
    resolveOverlayTile('/basemap/overlay/contours/15/7678/13134.mvt', routes, settings)?.path,
    '/m2/contours-3dep1m/15/7678/13134.mvt',
  );
  for (const bad of [
    '/basemap/overlay/hillshade/15/7678/13134.mvt', // wrong extension
    '/basemap/overlay/contours/15/7678/13134.webp',
    '/basemap/overlay/staged/15/1/1.webp',
    '/basemap/overlay/nope/15/1/1.webp',
    '/basemap/overlay/hillshade/15/1/1.png',
    '/basemap/overlay/hillshade/../1/1.webp',
    '/basemap/overlay/hillshade/15/1/1.webp/x',
  ])
    assert.equal(resolveOverlayTile(bad, routes, settings), null, bad);
  assert.equal(resolveOverlayTile('/basemap/overlay/hillshade/15/1/1.webp', null, settings), null);
  assert.equal(resolveOverlayTile('/basemap/overlay/hillshade/15/1/1.webp', routes, { hiresUrls: [] }), null);
  assert.deepEqual(overlayBases(['http://h:1'], null), ['http://h:1']);
});

test('normalizeOverlays: served block round-trips; garbage = unavailable', () => {
  const served = composeOverlays(OVERLAYS_PUBLISH).browser;
  const n = normalizeOverlays(served);
  assert.equal(n.available, true);
  assert.equal(n.layers.length, 6);
  assert.equal(n.layers[0].key, 'overlay-ustopo');
  assert.deepEqual(normalizeOverlays(undefined), { available: false, layers: [] });
  assert.deepEqual(normalizeOverlays({ available: true, layers: [{ id: 'x', url: 'https://evil/x' }] }), {
    available: false,
    layers: [],
  });
  const tampered = structuredClone(served);
  tampered.layers[0].url = '/basemap/overlay/other/{z}/{x}/{y}.webp';
  assert.equal(normalizeOverlays(tampered).layers.length, 5);
});

test('proxy: overlays block in config, tiles relayed, unknown = 404, flag off = nothing', async () => {
  const up = await upstreams();
  const on = await gev(env(up));
  const off = await gev(env(up, { GEV_BASEMAP_OVERLAYS: '' }));
  try {
    const config = await (await fetch(`${on.url}/basemap/config.json`)).json();
    assert.equal(config.overlays.available, true);
    assert.equal(config.overlays.layers.length, 6);
    assert.equal(basemapConfigLeakCount({ overlays: config.overlays }), 0);

    const webp = await fetch(`${on.url}/basemap/overlay/hillshade/15/7678/13134.webp`, {
      headers: { cookie: 'session=SECRET' },
    });
    assert.equal(webp.status, 200);
    assert.equal(webp.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await webp.arrayBuffer()).toString(), 'TILE');
    const mvt = await fetch(`${on.url}/basemap/overlay/lake-depth/15/7678/13134.mvt`);
    assert.equal(mvt.status, 200);
    assert.equal(mvt.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
    const none = await fetch(`${on.url}/basemap/overlay/contours/1/1/1.mvt`);
    assert.equal(none.status, 204);

    for (const path of [
      '/basemap/overlay/staged/15/1/1.webp',
      '/basemap/overlay/hillshade/15/1/1.mvt',
      '/basemap/overlay/unknown/15/1/1.webp',
    ]) {
      const before = up.seen.filter((s) => s.who === 'hires').length;
      assert.equal((await fetch(on.url + path)).status, 404, path);
      assert.equal(up.seen.filter((s) => s.who === 'hires').length, before);
    }
    const hires = up.seen.filter((s) => s.who === 'hires');
    assert.deepEqual(hires.map((s) => s.url).slice(0, 2), [
      '/m2/hillshade-3dep1m/15/7678/13134.webp',
      '/m2/lake-depth-twdb/15/7678/13134.mvt',
    ]);
    assert.ok(hires.every((s) => s.cookie === undefined), 'no cookies upstream');

    // Flag off: the P3 config byte for byte (no overlays key) and 404 routes.
    const offConfig = await (await fetch(`${off.url}/basemap/config.json`)).json();
    assert.equal('overlays' in offConfig, false);
    const before = up.seen.length;
    assert.equal((await fetch(`${off.url}/basemap/overlay/hillshade/15/1/2.webp`)).status, 404);
    assert.equal(up.seen.length, before);
  } finally {
    await Promise.all([on.close(), off.close(), up.close()]);
  }
});

test('proxy: manifest unreachable = overlays unavailable, tiles 404, rest of config intact', async () => {
  const up = await upstreams();
  const s = await gev(env(up, { GEV_BASEMAP_OVERLAYS_CONFIG: `${up.meta.url}/missing.json` }));
  try {
    const config = await (await fetch(`${s.url}/basemap/config.json`)).json();
    assert.deepEqual(config.overlays, { available: false });
    assert.equal(config.terrain.available, true);
    assert.equal((await fetch(`${s.url}/basemap/overlay/hillshade/15/1/2.webp`)).status, 404);
  } finally {
    await Promise.all([s.close(), up.close()]);
  }
});

test('proxy: no credential reaches logs, error bodies or the browser config (synthetic probe)', async () => {
  const up = await upstreams();
  const dead = await listen(() => {});
  const deadPort = dead.port;
  await dead.close();
  const SYN = {
    pass: 'SYNTHpass9f3a1c',
    key: 'SYNTHkey7d2e5b',
    bearer: 'SYNTHbearer41c0aa',
  };
  const logs = [];
  const environment = env(up, {
    GEV_BASEMAP_OVERLAYS_CONFIG: `http://user:${SYN.pass}@127.0.0.1:${deadPort}/m2/overlays.json?api_key=${SYN.key}`,
    GEV_BASEMAP_HIRES_URLS: `http://user:${SYN.pass}@127.0.0.1:${deadPort}`,
  });
  const handler = createBasemapHandler(basemapSettingsFromEnv(environment), {
    log: (...args) => logs.push(args.map(String).join(' ')),
  });
  const s = await listen((req, res) => handler(req, res, () => res.end('next')));
  try {
    // Second server: good manifest, but the edge (with userinfo in its URL) is down.
    up.manifest.port = deadPort;
    const logs2 = [];
    const h2 = createBasemapHandler(
      basemapSettingsFromEnv({
        ...environment,
        GEV_BASEMAP_OVERLAYS_CONFIG: `${up.meta.url}/m2/overlays.json`,
      }),
      { log: (...args) => logs2.push(args.map(String).join(' ')) },
    );
    const s2 = await listen((req, res) => h2(req, res, () => res.end('next')));
    try {
      const down = await fetch(`${s2.url}/basemap/overlay/hillshade/15/1/2.webp`, {
        headers: { authorization: `Bearer ${SYN.bearer}` },
      });
      assert.equal(down.status, 502);
      logs.push(...logs2, await down.text());
      assert.ok(logs2.some((l) => l.includes('overlay upstream failed')));
    } finally {
      await s2.close();
    }
    const cfg = await fetch(`${s.url}/basemap/config.json`);
    const cfgBody = await cfg.text();
    const tile = await fetch(`${s.url}/basemap/overlay/hillshade/15/1/2.webp`, {
      headers: { authorization: `Bearer ${SYN.bearer}`, 'x-api-key': SYN.key },
    });
    const tileBody = await tile.text();
    assert.ok(logs.length > 0, "the failure paths ran and logged");
    const haystack = [...logs, cfgBody, tileBody, JSON.stringify([...tile.headers])].join('\n');
    for (const secret of Object.values(SYN))
      for (const form of [secret, secret.slice(0, 8), secret.slice(-6), encodeURIComponent(secret), Buffer.from(secret).toString('base64')])
        assert.ok(!haystack.includes(form), `leaked ${form.length} chars of a synthetic secret`);
  } finally {
    await Promise.all([s.close(), up.close()]);
  }
});

test('safeErrorText: URLs reduced to scheme://host/path', () => {
  assert.equal(
    safeErrorText(new Error('bad http://u:p@h.example:81/a/b.json?api_key=K#frag and https://x/y?token=T')),
    'bad http://h.example/a/b.json and https://x/y',
  );
  assert.equal(safeErrorText('HTTP 502'), 'HTTP 502');
  assert.equal(safeErrorText(null), 'null');
});
