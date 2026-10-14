import test from 'node:test';
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

function fakeCesium({ fail = false } = {}) {
  const calls = [];
  class Resource {
    constructor(options) {
      this.options = options;
    }
  }
  return {
    calls,
    Cesium: {
      Resource,
      CesiumTerrainProvider: {
        async fromUrl(resource, options) {
          calls.push({ resource, options });
          if (fail) throw new Error('layer.json 502');
          return { terrain: 'open' };
        },
      },
      UrlTemplateImageryProvider: class {
        constructor(options) {
          this.options = options;
        }
      },
    },
  };
}

test('terrain: same-origin URL, normals + water mask, the shared retry policy', async () => {
  const { Cesium, calls } = fakeCesium();
  const result = await createBasemapTerrain(Cesium, config.terrain, {
    fallback: () => assert.fail('no fallback'),
  });
  assert.deepEqual(result, { provider: { terrain: 'open' } });
  assert.equal(calls.length, 1);
  const { resource, options } = calls[0];
  assert.equal(
    resource.options.url,
    '/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid',
  );
  assert.equal(resource.options.retryAttempts, TERRAIN_RETRY_ATTEMPTS);
  assert.equal(typeof resource.options.retryCallback, 'function');
  assert.deepEqual(options, {
    requestVertexNormals: true,
    requestWaterMask: true,
  });
});

test('terrain: layer.json failure opens on the fallback terrain', async () => {
  const { Cesium } = fakeCesium({ fail: true });
  const warnings = [];
  const result = await createBasemapTerrain(Cesium, config.terrain, {
    fallback: async () => ({ provider: 'keyless' }),
    warn: (...args) => warnings.push(args),
  });
  assert.deepEqual(result, { provider: 'keyless' });
  assert.equal(warnings.length, 1);
});

test('terrain: an aborted switch is not turned into a fallback', async () => {
  const { Cesium } = fakeCesium();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createBasemapTerrain(Cesium, config.terrain, {
      fallback: async () => ({ provider: 'keyless' }),
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
  const { Cesium } = fakeCesium();
  const source = createBasemapMapSource({
    Cesium,
    config,
    fallbackTerrain: async () => ({ provider: 'keyless' }),
  });
  assert.equal(source.descriptor, BYRDIT_OPEN_STACK);
  assert.equal(source.available, true);
  assert.equal(source.credit, basemapCreditHtml(config));
  assert.equal(source.constructionFallback.id, 'esri-imagery');
  assert.equal(source.tileFailureFallback.id, 'esri-imagery');
  assert.equal(source.tileFailureFallback.threshold, 3);
  assert.equal(source.terrain.id, 'byrdit-open');
  const provider = source.imagery({});
  assert.equal(provider.options.url, config.imagery.url);
  assert.deepEqual(await source.terrain.create({}), {
    provider: { terrain: 'open' },
  });
});

test('service down: available:false with the reason, never activated', () => {
  const down = normalizeBasemapConfig(null);
  down.unavailableReason = 'Byrd-IT Open map service is unavailable (HTTP 502)';
  const source = createBasemapMapSource({
    Cesium: {},
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
