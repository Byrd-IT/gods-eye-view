import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWayback } from './index.js';

function docWith(hook) {
  const doc = {
    defaultView: hook,
    querySelector: (selector) =>
      selector === 'meta[name="gev-wayback"]'
        ? { getAttribute: () => '1' }
        : null,
  };
  return doc;
}

function viewerFor(doc) {
  return {
    container: { ownerDocument: doc },
    imageryLayers: {
      length: 1,
      add() {},
      remove() {},
      indexOf() {
        return 0;
      },
    },
    scene: { requestRender() {}, frameState: {} },
    camera: {
      moveEnd: {
        addEventListener() {
          return () => {};
        },
      },
    },
  };
}

const releases = {
  releases: [{ release: 10, date: '2014-02-20' }],
  info: false,
};

async function attach(doc) {
  return attachWayback({
    Cesium: { Credit: class {} },
    viewer: viewerFor(doc),
    controller: {
      _imageryLayer: {},
      getActiveId: () => 'esri-imagery',
      subscribe: () => () => {},
    },
    doc,
    fetchImpl: async () => ({ ok: true, json: async () => releases }),
    timers: {
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
    createPanel: () => ({ update() {}, destroy() {} }),
  });
}

test('wayback does not install the voice hook on globalThis', async () => {
  delete globalThis.__gevWayback;
  delete globalThis.__gevImagery;
  const detach = await attach(docWith(undefined));
  assert.equal(globalThis.__gevWayback, undefined);
  assert.equal(globalThis.__gevImagery, undefined);
  detach();
  assert.equal(globalThis.__gevWayback, undefined);
});

test('wayback installs the hook on the document window and tears down only what it owns', async () => {
  const foreign = { voice: { foreign: true } };
  const hook = { __gevImagery: foreign };
  const detach = await attach(docWith(hook));
  assert.equal(typeof hook.__gevWayback.catalog, 'function');
  assert.equal(hook.__gevImagery, foreign);
  detach();
  assert.equal(hook.__gevWayback, undefined);
  assert.equal(hook.__gevImagery, foreign);
  assert.equal(globalThis.__gevWayback, undefined);
});

test('wayback installs a wayback-only voice and removes only that voice', async () => {
  const hook = {};
  const detach = await attach(docWith(hook));
  const voice = hook.__gevImagery.voice;
  assert.equal(typeof voice.off, 'function');
  assert.equal(typeof hook.__gevWayback.disable, 'function');
  const other = { voice: { other: true } };
  hook.__gevImagery = other;
  detach();
  assert.equal(hook.__gevWayback, undefined);
  assert.equal(hook.__gevImagery, other);
});
