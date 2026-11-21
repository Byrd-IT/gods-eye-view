import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorOf,
  coveredMaxzoom,
  createBasemapImagerySpec,
  cropRect,
  isCovered,
  planTile,
  tileBounds,
} from './imagery.js';
import { normalizeBasemapConfig } from './config.js';
import { SERVED } from './fixtures/config.mjs';

const imagery = normalizeBasemapConfig(SERVED).imagery;

/** XYZ tile containing lon/lat at zoom z. */
function tileAt(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  );
  return { x, y, z };
}

const AUSTIN = [-97.74, 30.27];
const KIRUNA = [20.22, 67.85];
const PARIS = [2.35, 48.86];

test('tileBounds matches the Web Mercator grid', () => {
  assert.deepEqual(
    tileBounds(0, 0, 0).map((v) => Math.round(v * 1e4) / 1e4),
    [-180, -85.0511, 180, 85.0511],
  );
  const [w, s, e, n] = tileBounds(1, 0, 1);
  assert.equal(w, 0);
  assert.equal(e, 180);
  assert.equal(s, 0);
  assert.ok(n > 85);
});

test('coverage comes from the config regions, not a hard-coded list', () => {
  const austin = tileAt(...AUSTIN, 14);
  assert.equal(coveredMaxzoom(imagery, austin.x, austin.y, 14), 14);
  const kiruna = tileAt(...KIRUNA, 14);
  assert.equal(coveredMaxzoom(imagery, kiruna.x, kiruna.y, 14), 13);
  const paris = tileAt(...PARIS, 14);
  assert.equal(coveredMaxzoom(imagery, paris.x, paris.y, 14), 8);
  assert.equal(isCovered(imagery, ...AUSTIN), true);
  assert.equal(isCovered(imagery, ...PARIS), false);
  const noRegions = { ...imagery, regions: [] };
  assert.equal(coveredMaxzoom(noRegions, austin.x, austin.y, 14), 8);
});

test('planTile: direct inside coverage, ancestor outside (coarse global base)', () => {
  const a = tileAt(...AUSTIN, 14);
  assert.deepEqual(planTile(imagery, a.x, a.y, 14), {
    kind: 'direct',
    fallbackLevel: 8,
  });
  const p = tileAt(...PARIS, 12);
  assert.deepEqual(planTile(imagery, p.x, p.y, 12), {
    kind: 'ancestor',
    level: 8,
  });
  const k = tileAt(...KIRUNA, 14);
  assert.deepEqual(planTile(imagery, k.x, k.y, 14), {
    kind: 'ancestor',
    level: 13,
  });
  assert.deepEqual(planTile(imagery, 3, 5, 4), {
    kind: 'direct',
    fallbackLevel: 3,
  });
  assert.deepEqual(planTile(imagery, 0, 0, 0), {
    kind: 'direct',
    fallbackLevel: -1,
  });
});

test('ancestorOf and cropRect address the right quarter, flipped or not', () => {
  const part = ancestorOf(5, 6, 3, 1);
  assert.deepEqual(part, { x: 1, y: 1, z: 1, n: 4, col: 1, row: 2 });
  assert.deepEqual(cropRect(256, 256, part, false), {
    sx: 64,
    sy: 128,
    sw: 64,
    sh: 64,
  });
  // Cesium decodes ImageBitmaps bottom-up (flipY), so the row mirrors.
  assert.deepEqual(cropRect(256, 256, part, true), {
    sx: 64,
    sy: 64,
    sw: 64,
    sh: 64,
  });
});

/**
 * The archive as a fetch: `serve(z, x, y)` answers a tile or throws; every URL
 * asked is recorded. Decoding, cropping and encoding are replaced by markers
 * so the tests see which ancestor a tile was made from.
 */
function archive(serve) {
  const requests = [];
  const fetchImpl = async (url) => {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url);
    const [z, x, y] = [m[1], m[2], m[3]].map(Number);
    requests.push(`${z}/${x}/${y}`);
    const answer = await serve(z, x, y);
    return (
      answer ?? {
        ok: true,
        status: 200,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () =>
          new TextEncoder().encode(`${z}/${x}/${y}`).buffer,
      }
    );
  };
  const options = {
    fetchImpl,
    decode: async ({ bytes }) => ({ tile: new TextDecoder().decode(bytes) }),
    crop: async (image, part) => ({ from: image.tile, part }),
    encode: async (cropped) => ({ bytes: cropped, contentType: 'image/webp' }),
  };
  return { requests, options };
}

const ask = (spec, { x, y, z }, url = `/direct/${z}/${x}/${y}`) =>
  spec.fetchTile({ tile: { x, y, level: z }, url, signal: undefined });

test('the spec is the globe port xyz imagery over the config URL and max zoom', () => {
  const spec = createBasemapImagerySpec(imagery);
  assert.equal(spec.kind, 'xyz');
  assert.equal(spec.url, imagery.url);
  assert.equal(spec.maxLevel, 14);
  assert.equal(spec.tileSize, 256);
  assert.equal(spec.tiling, 'webMercator');
  assert.equal(typeof spec.fetchTile, 'function');
});

test('the renderer builds a layer from the spec (a provider object here was the blank globe)', async () => {
  const { providerFor } = await import('../../render/cesium/imagery.js');
  const provider = providerFor(createBasemapImagerySpec(imagery));
  assert.equal(provider.constructor.name, 'UrlTemplateImageryProvider');
  assert.equal(provider.maximumLevel, 14);
});

test('a direct tile inside coverage is the archive tile, unchanged', async () => {
  const a = tileAt(...AUSTIN, 13);
  const { requests, options } = archive(async () => undefined);
  const spec = createBasemapImagerySpec(imagery, options);
  const url = `/basemap/direct/${a.z}/${a.x}/${a.y}.webp`;
  const out = await spec.fetchTile({
    tile: { x: a.x, y: a.y, level: a.z },
    url,
    signal: undefined,
  });
  assert.equal(out.contentType, 'image/webp');
  assert.deepEqual(requests, [`${a.z}/${a.x}/${a.y}`]);
  assert.equal(new TextDecoder().decode(out.bytes), `${a.z}/${a.x}/${a.y}`);
});

test('outside coverage: no request for the missing tile, one shared ancestor request', async () => {
  const { requests, options } = archive(async () => undefined);
  const crops = [];
  const spec = createBasemapImagerySpec(imagery, {
    ...options,
    crop: async (image, part) => {
      crops.push({ from: image.tile, part });
      return { cropped: image.tile };
    },
  });
  const p = tileAt(...PARIS, 12);
  const [a, b] = await Promise.all([
    ask(spec, p),
    ask(spec, { ...p, x: p.x + 1 }),
  ]);
  const anc = ancestorOf(p.x, p.y, 12, 8);
  assert.deepEqual(requests, [`8/${anc.x}/${anc.y}`]);
  assert.equal(a.bytes.cropped, `8/${anc.x}/${anc.y}`);
  assert.equal(b.bytes.cropped, `8/${anc.x}/${anc.y}`);
  assert.equal(crops.length, 2);
});

test('inside coverage a 204/failed tile falls back to the base ancestor', async () => {
  const a = tileAt(...AUSTIN, 13);
  const { requests, options } = archive(async () => undefined);
  const failing = {
    ...options,
    fetchImpl: async (url) => {
      if (/^\/direct\//.test(url)) return { ok: true, status: 204 };
      return options.fetchImpl(url);
    },
  };
  const spec = createBasemapImagerySpec(imagery, {
    ...failing,
    crop: async (image) => ({ cropped: image.tile }),
  });
  const out = await ask(spec, a);
  const anc = ancestorOf(a.x, a.y, 13, 8);
  assert.deepEqual(requests, [`8/${anc.x}/${anc.y}`]);
  assert.equal(out.bytes.cropped, `8/${anc.x}/${anc.y}`);
});

test('service down: the failure reaches the layer (the tile-failure fallback counts it)', async () => {
  const a = tileAt(...AUSTIN, 13);
  const down = async () => ({ ok: false, status: 502 });
  const { options } = archive(down);
  const spec = createBasemapImagerySpec(imagery, {
    ...options,
    fetchImpl: down,
  });
  await assert.rejects(ask(spec, a), /502/);
  await assert.rejects(ask(spec, { x: 0, y: 0, z: 0 }), /502/);
});

test('a failed ancestor is retried, not cached', async () => {
  let fail = true;
  const { requests, options } = archive(async () =>
    fail ? { ok: false, status: 503 } : undefined,
  );
  const spec = createBasemapImagerySpec(imagery, options);
  const p = tileAt(...PARIS, 10);
  await assert.rejects(ask(spec, p));
  fail = false;
  await ask(spec, p);
  assert.equal(requests.length, 2);
});
