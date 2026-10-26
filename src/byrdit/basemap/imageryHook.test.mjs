import test from 'node:test';
import assert from 'node:assert/strict';
import { openBasemap } from './index.js';

const SERVED = {
  schema: 1,
  terrain: {
    available: true,
    version: 'mh0.0.13-wm20261011',
    url: '/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid',
    minzoom: 0,
    maxzoom: 14,
    waterMask: true,
  },
  imagery: {
    available: true,
    archive: 'imagery-2025',
    url: '/basemap/imagery/imagery-2025/{z}/{x}/{y}.webp',
    baseMaxzoom: 8,
    maxzoom: 14,
    year: 2025,
    regions: [],
  },
  buildings: { available: false },
  switch: {},
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  body: { cancel: async () => {} },
});

function controller() {
  return {
    getActiveId: () => 'byrdit-open',
    setStack: async () => ({}),
    getStacks: () => [],
    isStackAvailable: () => true,
    getStack: () => ({}),
    getState: () => ({}),
    subscribe: () => () => {},
    _emitChange() {},
  };
}

test('basemap attach installs the imagery hook and tears down only its own', async () => {
  delete globalThis.__gevImagery;
  const hook = {};
  const result = await openBasemap({
    Cesium: { UrlTemplateImageryProvider: class {} },
    viewer: {
      scene: { primitives: { add() {}, remove() {} } },
      container: { ownerDocument: { defaultView: hook } },
    },
    doc: { querySelector: () => ({ getAttribute: () => '1' }) },
    fetchImpl: async (url) => {
      if (url === '/basemap/config.json') return json(SERVED);
      return json({ state: 'ok', warnings: [] });
    },
    createHealthMonitor: () => ({ start() {}, stop() {}, onChange: null }),
  });
  const detach = result.attach(controller());
  assert.equal(typeof hook.__gevImagery.voice.year, 'function');
  assert.equal(globalThis.__gevImagery, undefined);
  detach();
  assert.equal(hook.__gevImagery, undefined);

  const again = result.attach(controller());
  const foreign = { voice: { foreign: true } };
  hook.__gevImagery = foreign;
  again();
  assert.equal(hook.__gevImagery, foreign);
  assert.equal(globalThis.__gevImagery, undefined);
  result.destroy();
});
