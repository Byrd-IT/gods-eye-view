import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorOf,
  coveredMaxzoom,
  createBasemapImageryProvider,
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

function fakeCesium(serve) {
  const requests = [];
  class UrlTemplateImageryProvider {
    constructor(options) {
      this.options = options;
    }
    requestImage(x, y, level, request) {
      requests.push(`${level}/${x}/${y}`);
      return serve(level, x, y, request);
    }
  }
  return { Cesium: { UrlTemplateImageryProvider }, requests };
}

test('the provider is built from the config URL and max zoom', () => {
  const { Cesium } = fakeCesium(async () => ({}));
  const provider = createBasemapImageryProvider(Cesium, imagery);
  assert.equal(provider.options.url, imagery.url);
  assert.equal(provider.options.maximumLevel, 14);
  assert.equal(provider.options.tileWidth, 256);
});

test('outside coverage: no request for the missing tile, one shared ancestor request', async () => {
  const { Cesium, requests } = fakeCesium(async (z, x, y) => ({
    tile: `${z}/${x}/${y}`,
    width: 256,
    height: 256,
  }));
  const crops = [];
  const provider = createBasemapImageryProvider(Cesium, imagery, {
    crop: async (image, part) => {
      crops.push({ from: image.tile, part });
      return { cropped: image.tile };
    },
  });
  const p = tileAt(...PARIS, 12);
  const [a, b] = await Promise.all([
    provider.requestImage(p.x, p.y, 12),
    provider.requestImage(p.x + 1, p.y, 12),
  ]);
  const anc = ancestorOf(p.x, p.y, 12, 8);
  assert.deepEqual(requests, [`8/${anc.x}/${anc.y}`]);
  assert.equal(a.cropped, `8/${anc.x}/${anc.y}`);
  assert.equal(b.cropped, `8/${anc.x}/${anc.y}`);
  assert.equal(crops.length, 2);
});

test('inside coverage a 204/failed tile falls back to the base ancestor', async () => {
  const a = tileAt(...AUSTIN, 13);
  const { Cesium, requests } = fakeCesium(async (z, x, y) => {
    if (z === 13) throw new Error('204 No Content');
    return { tile: `${z}/${x}/${y}`, width: 256, height: 256 };
  });
  const provider = createBasemapImageryProvider(Cesium, imagery, {
    crop: async (image) => ({ cropped: image.tile }),
  });
  const image = await provider.requestImage(a.x, a.y, 13, { id: 1 });
  const anc = ancestorOf(a.x, a.y, 13, 8);
  assert.deepEqual(requests, [`13/${a.x}/${a.y}`, `8/${anc.x}/${anc.y}`]);
  assert.equal(image.cropped, `8/${anc.x}/${anc.y}`);
});

test('service down: the failure reaches Cesium (tile-failure fallback counts it)', async () => {
  const a = tileAt(...AUSTIN, 13);
  const { Cesium } = fakeCesium(async () => {
    throw new Error('502');
  });
  const provider = createBasemapImageryProvider(Cesium, imagery, {
    crop: async (image) => image,
  });
  await assert.rejects(provider.requestImage(a.x, a.y, 13, {}));
  await assert.rejects(provider.requestImage(0, 0, 0, {}), /502/);
});

test("Cesium's request throttle (undefined) is passed through", () => {
  const { Cesium } = fakeCesium(() => undefined);
  const provider = createBasemapImageryProvider(Cesium, imagery);
  const a = tileAt(...AUSTIN, 14);
  assert.equal(provider.requestImage(a.x, a.y, 14, {}), undefined);
});

test('a failed ancestor is retried, not cached', async () => {
  let fail = true;
  const { Cesium, requests } = fakeCesium(async (z, x, y) => {
    if (fail) throw new Error('down');
    return { tile: `${z}/${x}/${y}`, width: 256, height: 256 };
  });
  const provider = createBasemapImageryProvider(Cesium, imagery, {
    crop: async (image) => image,
  });
  const p = tileAt(...PARIS, 10);
  await assert.rejects(provider.requestImage(p.x, p.y, 10));
  fail = false;
  await provider.requestImage(p.x, p.y, 10);
  assert.equal(requests.length, 2);
});
