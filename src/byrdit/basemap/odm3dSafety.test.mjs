import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { basemapSettingsFromEnv, createBasemapHandler } from './proxy.js';
import { composeOverlays } from './overlaysProxy.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';

/**
 * Synthetic-secret probe for the 3D build route (/basemap/odm3d/...): bearer
 * token, URL userinfo, a token with a recognisable suffix, and an API key in a
 * header and in a query string go in; none of them may come out in a log line,
 * an error body, a response header, or reach the upstream.
 */

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

const LAYER = {
  id: 'odm-3d-probe0001',
  name: 'Probe build 3D',
  kind: 'overlay-3d',
  format: '3dtiles',
  archive: 'odm3d/odm-3d-probe0001',
  bounds: [-95.1545, 32.6896, -95.1511, 32.6918],
  ground_m: 112,
  canopy_options_ft: [90, 120],
  canopy_default_ft: 90,
  status: 'live-data',
  credit: 'Byrd-IT ODM drone survey',
};
const manifest = {
  ...OVERLAYS_PUBLISH,
  layers: [...OVERLAYS_PUBLISH.layers, LAYER],
};
const SYN = {
  pass: 'SYNTHpass9f3a1c',
  key: 'SYNTHkey7d2e5b',
  bearer: 'SYNTHbearer41c0aa',
  tokenSuffix: 'SYNTHtoken-ABC123',
};
const forms = (secret) => [
  secret,
  secret.slice(0, 8),
  secret.slice(-6),
  encodeURIComponent(secret),
  Buffer.from(secret).toString('base64'),
];

async function meta() {
  return listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url === '/m2/overlays.json'
          ? manifest
          : { tile_url: '/i/{z}/{x}/{y}.webp', layers: [], credit: {} },
      ),
    );
  });
}

const environment = (metaUrl, extra) => ({
  GEV_BASEMAP: '1',
  GEV_BASEMAP_TERRAIN_URLS: metaUrl,
  GEV_BASEMAP_IMAGERY_URLS: metaUrl,
  GEV_BASEMAP_IMAGERY_CONFIG: `${metaUrl}/imagery/config.json`,
  GEV_BASEMAP_OVERLAYS: '1',
  GEV_BASEMAP_OVERLAYS_CONFIG: `${metaUrl}/m2/overlays.json`,
  GEV_BASEMAP_HIRES_URLS: metaUrl,
  ...extra,
});

test('odm3d route: a dead origin with credentials in its URL leaks nothing to logs, the 502 body or headers', async () => {
  const m = await meta();
  const dead = await listen(() => {});
  const deadPort = dead.port;
  await dead.close();
  const logs = [];
  const handler = createBasemapHandler(
    basemapSettingsFromEnv(
      environment(m.url, {
        GEV_BASEMAP_ODM3D_URLS: `http://user:${SYN.pass}@127.0.0.1:${deadPort}/hires?api_key=${SYN.key}`,
      }),
    ),
    { log: (...args) => logs.push(args.map(String).join(' ')) },
  );
  const s = await listen((req, res) =>
    handler(req, res, () => res.end('next')),
  );
  try {
    const res = await fetch(
      `${s.url}/basemap/odm3d/${LAYER.id}/tileset.json?api_key=${SYN.key}`,
      {
        headers: {
          authorization: `Bearer ${SYN.bearer}`,
          'x-api-key': SYN.key,
          cookie: `session=${SYN.tokenSuffix}`,
        },
      },
    );
    const body = await res.text();
    assert.equal(res.status, 502);
    assert.ok(
      logs.some((l) => l.includes('odm3d upstream failed')),
      'the failure path ran and logged',
    );
    const haystack = [...logs, body, JSON.stringify([...res.headers])].join(
      '\n',
    );
    for (const secret of Object.values(SYN))
      for (const form of forms(secret))
        assert.ok(
          !haystack.includes(form),
          `leaked ${form.length} chars of a synthetic secret`,
        );
  } finally {
    await Promise.all([s.close(), m.close()]);
  }
});

test('odm3d route: nothing from the browser request (query, authorization, cookie, api key) reaches the origin', async () => {
  const m = await meta();
  const seen = [];
  const origin = await listen((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"asset":{"version":"1.0"}}');
  });
  const handler = createBasemapHandler(
    basemapSettingsFromEnv(
      environment(m.url, { GEV_BASEMAP_ODM3D_URLS: `${origin.url}/hires` }),
    ),
    { log: () => {} },
  );
  const s = await listen((req, res) =>
    handler(req, res, () => res.end('next')),
  );
  try {
    const res = await fetch(
      `${s.url}/basemap/odm3d/${LAYER.id}/tileset.json?api_key=${SYN.key}`,
      {
        headers: {
          authorization: `Bearer ${SYN.bearer}`,
          'x-api-key': SYN.key,
          cookie: `session=${SYN.tokenSuffix}`,
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `/hires/odm3d/${LAYER.id}/tileset.json`);
    const sent = JSON.stringify(seen[0]);
    for (const secret of Object.values(SYN))
      for (const form of forms(secret))
        assert.ok(
          !sent.includes(form),
          `forwarded ${form.length} chars of a synthetic secret`,
        );
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers.cookie, undefined);
  } finally {
    await Promise.all([s.close(), origin.close(), m.close()]);
  }
});

test('composeOverlays: the browser block for a 3D layer carries no archive, hash, source or origin detail', () => {
  const { browser } = composeOverlays({
    ...manifest,
    layers: [
      ...manifest.layers,
      {
        ...LAYER,
        id: 'odm-3d-probe0002',
        archive: 'odm3d/odm-3d-probe0002',
        sha256: 'ef'.repeat(32),
        source: `S4:/srv/odm/data/${SYN.tokenSuffix}`,
        edge: { origin: `http://user:${SYN.pass}@10.0.0.1:8480/hires` },
      },
    ],
  });
  const text = JSON.stringify(browser);
  for (const secret of [SYN.pass, SYN.tokenSuffix, 'efefefef', '10.0.0.1'])
    assert.ok(
      !text.includes(secret),
      `browser block leaked ${secret.length} chars`,
    );
});
