import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createBasemapTerrain } from './terrain.js';
import {
  createBasemapMapSource,
  createUnavailableBasemapSource,
  BYRDIT_OPEN_STACK,
  BASEMAP_AUTO_STACK,
} from './stack.js';
import { normalizeBasemapConfig } from './config.js';
import { basemapCreditHtml } from './credits.js';
import { TERRAIN_RETRY_ATTEMPTS } from '../../maps/terrainRetry.js';
import { SERVED } from './fixtures/config.mjs';

const config = normalizeBasemapConfig(SERVED);

/** A fetch that answers per URL; records every URL asked. */
function fakeFetch(answers = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const answer = answers[url] ?? answers['*'] ?? { ok: true, status: 200 };
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { urls, fetchImpl };
}

const TERRAIN_FOLDER =
  '/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid';

test('terrain: the same-origin folder as a quantized-mesh spec, normals + water mask', async () => {
  const { urls, fetchImpl } = fakeFetch();
  const result = await createBasemapTerrain(config.terrain, {
    fetchImpl,
    fallback: () => assert.fail('no fallback'),
  });
  assert.deepEqual(urls, [`${TERRAIN_FOLDER}/layer.json`]);
  assert.deepEqual(result, {
    provider: null,
    spec: {
      kind: 'quantizedMesh',
      url: TERRAIN_FOLDER,
      requestVertexNormals: true,
      requestWaterMask: true,
    },
  });
});

test('terrain: layer.json failure opens on the fallback terrain', async () => {
  const { fetchImpl } = fakeFetch({ '*': { ok: false, status: 502 } });
  const warnings = [];
  const result = await createBasemapTerrain(config.terrain, {
    fetchImpl,
    fallback: async () => ({ provider: null, spec: { kind: 'ellipsoid' } }),
    warn: (...args) => warnings.push(args),
  });
  assert.deepEqual(result, { provider: null, spec: { kind: 'ellipsoid' } });
  assert.equal(warnings.length, 1);
});

test('terrain: a network failure opens on the fallback terrain too', async () => {
  const { fetchImpl } = fakeFetch({ '*': new TypeError('fetch failed') });
  const result = await createBasemapTerrain(config.terrain, {
    fetchImpl,
    fallback: async () => ({ provider: null, spec: { kind: 'keyless' } }),
    warn: () => {},
  });
  assert.deepEqual(result.spec, { kind: 'keyless' });
});

test('terrain: an aborted switch is not turned into a fallback', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createBasemapTerrain(config.terrain, {
      fetchImpl: fakeFetch().fetchImpl,
      fallback: async () => ({ provider: null }),
      signal: controller.signal,
    }),
  );
});

test('stack descriptors are the decided ones', () => {
  assert.deepEqual(BYRDIT_OPEN_STACK, {
    id: 'byrdit-open',
    label: 'Byrd-IT Open',
    shortLabel: 'OPEN',
    kind: 'byrdit-open',
    requiresIon: false,
  });
  assert.equal(BASEMAP_AUTO_STACK.id, 'basemap-auto');
  assert.equal(BASEMAP_AUTO_STACK.label, 'Auto');
  assert.equal(BASEMAP_AUTO_STACK.requiresIon, false);
});

test('available source: imagery, terrain, credit, Esri fallbacks', async () => {
  const { fetchImpl } = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  after(() => {
    globalThis.fetch = realFetch;
  });
  const source = createBasemapMapSource({
    config,
    fallbackTerrain: async () => ({
      provider: null,
      spec: { kind: 'keyless' },
    }),
  });
  assert.equal(source.descriptor, BYRDIT_OPEN_STACK);
  assert.equal(source.available, true);
  assert.equal(source.credit, basemapCreditHtml(config));
  assert.equal(source.constructionFallback.id, 'esri-imagery');
  assert.equal(source.tileFailureFallback.id, 'esri-imagery');
  assert.equal(source.tileFailureFallback.threshold, 3);
  assert.equal(source.terrain.id, 'byrdit-open');
  // The globe port's imagery spec (what the map stack hands the renderer).
  const spec = source.imagery({});
  assert.equal(spec.kind, 'xyz');
  assert.equal(spec.url, config.imagery.url);
  assert.equal(spec.maxLevel, 14);
  assert.equal(spec.tileSize, 256);
  assert.equal(typeof spec.fetchTile, 'function');
  assert.equal((await source.terrain.create({})).spec.kind, 'quantizedMesh');
});

test('service down: available:false with the reason, never activated', () => {
  const down = normalizeBasemapConfig(null);
  down.unavailableReason = 'Byrd-IT Open map service is unavailable (HTTP 502)';
  const source = createBasemapMapSource({
    config: down,
    fallbackTerrain: null,
  });
  assert.equal(source.available, false);
  assert.equal(
    source.unavailableReason,
    'Byrd-IT Open map service is unavailable (HTTP 502)',
  );
  assert.throws(() => source.imagery(), /HTTP 502/);
  assert.equal(
    createUnavailableBasemapSource().unavailableReason,
    'Byrd-IT Open map service is unavailable',
  );
});
