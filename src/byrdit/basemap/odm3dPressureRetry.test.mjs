import test from 'node:test';
import assert from 'node:assert/strict';
import { Odm3dLayer } from './odm3d.js';
import { composeOverlays } from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';

const THREE_D = {
  id: 'odm-3d-9be42b4f',
  name: 'Byrd Ranch shop area 3D (2026-10-31)',
  kind: 'overlay-3d',
  format: '3dtiles',
  archive: 'odm3d/odm-3d-9be42b4f',
  bounds: [-95.1545, 32.6896, -95.1511, 32.6918],
  ground_m: 112,
  height_offset_m: 0,
  canopy_default_ft: 90,
  canopy_options_ft: [90, 120],
  default_opacity: 1,
  status: 'live-data',
  credit: 'Byrd-IT ODM drone survey',
  sha256: 'cd'.repeat(32),
  file: 'hires/odm3d/odm-3d-9be42b4f/tileset.json',
};
const entry3d = () =>
  normalizeOverlays(
    composeOverlays({
      ...OVERLAYS_PUBLISH,
      layers: [...OVERLAYS_PUBLISH.layers, THREE_D],
    }).browser,
  ).layers.find((l) => l.id === THREE_D.id);

const HEAP_MAX = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function fake() {
  const calls = { added: [], removed: [], sse: [], options: [] };
  const Cesium = {
    Cartesian3: class {
      constructor(x = 0, y = 0, z = 0) {
        Object.assign(this, { x, y, z });
      }
      static fromDegrees(lon, lat, h) {
        return new this(lon, lat, h);
      }
      static multiplyByScalar(v, k, out) {
        return Object.assign(out, { x: v.x * k, y: v.y * k, z: v.z * k });
      }
    },
    ClippingPlane: class {},
    Ellipsoid: {
      WGS84: {
        geodeticSurfaceNormal: (c, out) =>
          Object.assign(out, { x: 0, y: 0, z: 1 }),
      },
    },
    Matrix4: { fromTranslation: (v) => ({ translation: v }) },
    Rectangle: { fromDegrees: (w, s, e, n) => ({ w, s, e, n }) },
    Cesium3DTileset: {
      async fromUrl(url, options) {
        calls.sse.push(options.maximumScreenSpaceError);
        calls.options.push({ ...options });
        const listeners = [];
        const tileset = {
          url,
          options,
          show: options.show,
          maximumScreenSpaceError: options.maximumScreenSpaceError,
          statistics: { numberOfTilesWithContentReady: 0 },
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
          isDestroyed() {
            return this.destroyed;
          },
          loadProgress: {
            addEventListener(fn) {
              listeners.push(fn);
              return () => listeners.splice(listeners.indexOf(fn), 1);
            },
          },
          report(p, pr) {
            for (const fn of [...listeners]) fn(p, pr);
          },
        };
        calls.tilesets = [...(calls.tilesets ?? []), tileset];
        return tileset;
      },
    },
  };
  const viewer = {
    terrainProvider: {},
    scene: {
      primitives: {
        add: (t) => calls.added.push(t),
        remove: (t) => calls.removed.push(t),
      },
      requestRender() {},
    },
    camera: {},
  };
  return { Cesium, viewer, calls };
}

const timersOf = () => {
  const intervals = new Map();
  let nextId = 1;
  return {
    timers: {
      setInterval: (fn) => (intervals.set(nextId, fn), nextId++),
      clearInterval: (id) => intervals.delete(id),
    },
    tick: () => [...intervals.values()].forEach((fn) => fn()),
  };
};

const gateSpy = () => {
  const log = [];
  const factory = () => {
    const gate = {
      resource: { __odmGated: true },
      paused: false,
      destroyed: false,
      setPaused(p) {
        this.paused = p === true;
        log.push(['setPaused', this.paused]);
      },
      destroy() {
        this.destroyed = true;
        log.push(['destroyed']);
      },
    };
    return { resource: gate.resource, gate };
  };
  return { factory, log };
};

// A mode toggle must not leave a FAILED phone gate failure pinned to the old
// mode: with no build in flight and no tileset, disabling (or re-enabling)
// phone mode retries the load — and the retry must not surface the stale
// gateError of the attempt it is replacing.
test('after a failed phone gate, setPhoneMode(false) retries safely: clean desktop build, no stale gateError', async () => {
  const f = fake();
  const t = timersOf();
  // The DEFAULT factory (a fake Cesium has no Resource) cannot create the
  // gate: the phone load fails closed.
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: {
      ...entry3d(),
      phoneUrl: '/basemap/odm3d/odm-3d-9be42b4f-phone/tileset.json',
    },
    phoneMode: true,
    timers: t.timers,
  });
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(layer._gate, null);
  assert.ok(layer.gateError, 'the failure is recorded for the panel');

  // Toggling phone mode off on a failed layer must retry, not stay failed.
  layer.setPhoneMode(false);
  assert.equal(layer.phoneActive, false);
  await layer.load();
  // The failed phone attempt never reached fromUrl; only the retry built.
  assert.equal((f.calls.tilesets ?? []).length, 1, 'a tileset was rebuilt');
  assert.match(f.calls.tilesets[0].url, /tileset\.json$/, 'the plain url');
  assert.equal(layer.status, 'ready', 'the retry loaded as desktop');
  assert.equal(layer.gateError, null, 'the stale gate failure is gone');
  assert.equal(layer.error, null, 'no stale error text after the retry');
  assert.equal(
    f.calls.options[0].maximumScreenSpaceError,
    24,
    'desktop SSE on the retry',
  );
  assert.equal(f.calls.options[0].cacheBytes, 256 * MiB, 'desktop cache');
  layer.destroy();
});

// The pump stops once a load settles, so after an idle stretch any sync
// triggered from elsewhere (loadProgress, a camera move restarting the pump)
// must take a FRESH heap reading before acting — a press on the old ratio
// would pause the gate before the next probe ever ran.
test('a pressure sync after an idle stretch reads the heap fresh: no pause on a stale ratio', async () => {
  const f = fake();
  const t = timersOf();
  const heapNow = { v: 0.5 * HEAP_MAX };
  const g = gateSpy();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    phoneMode: true,
    timers: t.timers,
    heapProbe: () => ({ used: heapNow.v, limit: HEAP_MAX }),
    requestGateFactory: g.factory,
  });
  await layer.load();
  assert.equal(layer.status, 'ready');
  assert.equal(g.log.length, 0, 'no pause at a healthy heap');

  // Press on a genuinely high heap (a monitor tick probes it).
  heapNow.v = 0.95 * HEAP_MAX;
  t.tick();
  assert.equal(layer._pressed, true, 'high heap presses');
  assert.equal(layer._gate.paused, true, 'the gate pauses');
  assert.equal(layer._heapRatio, 0.95);

  // Idle: the pump settles, then stops; the heap comes back down on its own
  // (GC/eviction) with nothing monitoring it.
  for (let i = 0; i < 8; ++i) t.tick();
  layer._stopPump();
  heapNow.v = 0.5 * HEAP_MAX;
  assert.equal(t.tick() ?? undefined, undefined);

  // LoadProgress (Cesium's queue reporting) syncs while the pump is stopped:
  // with the OLD ratio this would press again and pause the gate.
  f.calls.tilesets.at(-1).report(2, 0);
  assert.equal(layer._heapRatio, 0.5, 'the reading was taken now, not reused');
  assert.equal(layer._pressed, false, 'the stale press did not survive');
  assert.equal(
    layer._gate.paused,
    false,
    'the gate did not pause on stale heap',
  );
  layer.destroy();
});
