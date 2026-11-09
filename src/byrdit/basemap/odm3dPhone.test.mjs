import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import {
  Odm3dLayer,
  DESKTOP_SSE,
  PHONE_LIMITS,
  PHONE_MEDIA_QUERY,
  PHONE_COARSE_QUERY,
  isPhoneView,
  isPhoneEnvironment,
  acquireSchedulerThrottle,
  schedulerServerKey,
} from './odm3d.js';
import { composeOverlays } from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';

// The same minimal 3D build the main test file uses.
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

function fake({ terrain = [94, 94, 94] } = {}) {
  const calls = { added: [], removed: [], sse: [], options: [], requests: [] };
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }
    static fromDegrees(lon, lat, h) {
      return new Cartesian3(lon, lat, h);
    }
    static multiplyByScalar(v, k, out) {
      return Object.assign(out, { x: v.x * k, y: v.y * k, z: v.z * k });
    }
  }
  const RequestScheduler = {
    maximumRequests: 500,
    maximumRequestsPerServer: 64,
    // Dead knob Cesium does not implement: it must stay untouched forever.
    maximumSimultaneousTileRequests: 50,
    requestsByServer: {},
  };
  const Cesium = {
    Cartesian3,
    ClippingPlane: class {},
    Ellipsoid: {
      WGS84: {
        geodeticSurfaceNormal: (c, out) =>
          Object.assign(out, { x: 0, y: 0, z: 1 }),
      },
    },
    Matrix4: { fromTranslation: (v) => ({ translation: v }) },
    Rectangle: { fromDegrees: (w, s, e, n) => ({ w, s, e, n }) },
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat, height: 0 }) },
    sampleTerrainMostDetailed: async (provider, pts) =>
      pts.map((p, i) => ({ ...p, height: terrain[i % terrain.length] })),
    RequestScheduler,
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
          // the fake raises loadProgress on the layer's behalf
          report(p, pr) {
            calls.requests.push([p, pr]);
            for (const fn of [...listeners]) fn(p, pr);
          },
        };
        calls.tilesets = [...(calls.tilesets ?? []), tileset];
        return tileset;
      },
    },
  };
  let renders = 0;
  const viewer = {
    terrainProvider: {},
    scene: {
      primitives: {
        add: (t) => calls.added.push(t),
        remove: (t) => calls.removed.push(t),
      },
      requestRender() {
        renders += 1;
      },
    },
    camera: {},
  };
  return { Cesium, viewer, calls, renders: () => renders, RequestScheduler };
}

const MiB = 1024 * 1024;

test('PHONE_LIMITS meet the owner bar: 64-96 SSE, 64MiB cache with no overflow, throttle + pressure caps present', () => {
  assert.ok(
    PHONE_LIMITS.initialError >= 64 && PHONE_LIMITS.initialError <= 96,
    `coarse phone SSE ${PHONE_LIMITS.initialError} must sit in 64-96`,
  );
  assert.ok(
    PHONE_LIMITS.phoneFineError >= 64 && PHONE_LIMITS.phoneFineError <= 96,
    `refined phone SSE ${PHONE_LIMITS.phoneFineError} must stay in 64-96`,
  );
  assert.ok(
    PHONE_LIMITS.phoneFineError < PHONE_LIMITS.initialError,
    'refined quality is sharper than the coarse start',
  );
  assert.equal(
    PHONE_LIMITS.fineError,
    DESKTOP_SSE,
    'desktop quality only leaves the band when phone mode is off',
  );
  assert.equal(PHONE_LIMITS.cacheBytes, 64 * MiB);
  assert.equal(PHONE_LIMITS.cacheOverflowBytes, 0, 'no overflow cache');
  assert.ok(Number.isInteger(PHONE_LIMITS.inFlightCap));
  assert.ok(PHONE_LIMITS.inFlightCap > 0);
  assert.ok(
    PHONE_LIMITS.heapPressureFraction > 0 &&
      PHONE_LIMITS.heapPressureFraction <= 1,
  );
  assert.ok(
    PHONE_LIMITS.heapResumeFraction < PHONE_LIMITS.heapPressureFraction,
    'hysteresis',
  );
  assert.ok(PHONE_LIMITS.loadedTileCap > 0);
  assert.ok(
    PHONE_LIMITS.schedulerRequestsPerServer < DESKTOP_SSE,
    'throttle tight enough to matter',
  );
});

// The detector: small width (never the user agent). The coarse-pointer and
// device-memory signals have their own tests below.
test('isPhoneView: a correct matchMedia detector on the viewport; missing or throwing = desktop', () => {
  const narrow = (q) => ({ matches: q === PHONE_MEDIA_QUERY });
  assert.equal(PHONE_MEDIA_QUERY.startsWith('(max-width'), true);
  assert.equal(isPhoneView(narrow), true, 'phone-width viewport matches');
  assert.equal(
    isPhoneView((q) => ({ matches: false })),
    false,
  );
  assert.equal(isPhoneView(null), false, 'no matchMedia at all = desktop');
  assert.equal(
    isPhoneView(() => {
      throw new Error('no such engine');
    }),
    false,
    'a throwing matchMedia = desktop, never a crash',
  );
});

test('isPhoneEnvironment: the no-argument form overlays.js uses; Node answers false', () => {
  assert.equal(isPhoneEnvironment(), false, 'no window here = desktop');
});

const phoneLayer = (f, { timers, ...extra } = {}) => {
  // A real page has an origin; give the module the location its scheduler
  // key and per-origin pause ask for (Node has none). Desktop layers in the
  // desktop-specific tests never reach this helper.
  if (!globalThis.location) {
    globalThis.location = { host: 'tiles.byrd-it.test', protocol: 'https:' };
  }
  return new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    phoneMode: true,
    timers,
    ...extra,
  });
};

// The location above is a module-level side effect; remove it again so no
// later test file in the process inherits it.
after(() => {
  const loc = globalThis.location;
  if (loc && loc.host === 'tiles.byrd-it.test') delete globalThis.location;
});

const timersOf = () => {
  const intervals = new Map();
  let nextId = 1;
  return {
    map: intervals,
    timers: {
      setInterval: (fn) => (intervals.set(nextId, fn), nextId++),
      clearInterval: (id) => intervals.delete(id),
    },
    tick: () => [...intervals.values()].forEach((fn) => fn()),
  };
};

const heap = (used) => () => ({ used, limit: HEAP_MAX });

// The real page has an origin; these tests run in Node. Give the module the
// location it asks for and restore whatever was there.
const withLocation = (host, fn) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const original = globalThis.location;
  try {
    globalThis.location = { host, protocol: 'https:' };
    return fn();
  } finally {
    if (had) globalThis.location = original;
    else delete globalThis.location;
  }
};

test('phone: coarse first within the owner band, 64MiB cache with no overflow, then refines inside the owner band once settled', async () => {
  const f = fake();
  const { timers, map, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  assert.equal(f.calls.sse[0], PHONE_LIMITS.initialError, 'coarse initial SSE');
  const opts = f.calls.options[0];
  assert.equal(opts.cacheBytes, 64 * MiB, '64MiB cache');
  assert.equal(opts.maximumCacheOverflowBytes, 0, 'no overflow');
  tileset.tilesLoaded = true;
  tick();
  tick();
  tick();
  assert.equal(map.size, 0, 'pump stops once settled');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'refined inside the owner band after settle',
  );
  assert.equal(layer.phoneActive, true);
  layer.destroy();
});

// The pressure stop never hides the tileset: Cesium's Cesium3DTileset.update
// exits before the tile queue when show is false, so pending work and
// loadProgress would strand and a pressed gate could never release. The stop
// pauses NEW requests on the scheduler's per-origin override
// (requestsByServer[key] = 0, the throttleByServer path: throttled requests
// are deferred, retried after the release) while show stays true and the
// update keeps processing the queue.

test('phone: an actual in-flight cap — new requests pause per origin, the tileset never goes hidden, and the queue can always drain', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  const s = f.Cesium.RequestScheduler;
  const key = schedulerServerKey();
  assert.equal(
    s.requestsByServer[key],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'phone cap while active',
  );
  tileset.tilesLoaded = true;
  tick();
  tick();
  tick();
  assert.equal(tileset.show, true, 'ready and unpressed = drawn');

  tileset.report(PHONE_LIMITS.inFlightCap + 1, 0);
  assert.equal(layer._pressed, true, 'over cap = pressure engaged');
  assert.equal(
    tileset.show,
    true,
    'never hidden: a hidden tileset would strand its queue',
  );
  assert.equal(
    s.requestsByServer[key],
    0,
    'new requests paused on the per-origin override',
  );

  tileset.report(PHONE_LIMITS.inFlightCap, 0);
  assert.equal(layer._pressed, true, 'at the cap is still pressure');

  tileset.report(
    Math.round(PHONE_LIMITS.inFlightCap * PHONE_LIMITS.resumeFraction),
    0,
  );
  assert.equal(layer._pressed, false, 'hysteresis release under the threshold');
  assert.equal(
    s.requestsByServer[key],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'requests resume at the phone cap',
  );
  assert.equal(tileset.show, true, 'drawn again');
  layer.destroy();
});

test('phone: heap pressure pauses requests, drops when the heap recovers — hysteresis, no deadlock even with pending work', async () => {
  const f = fake();
  const { timers, map, tick } = timersOf();
  let used = Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction);
  const layer = phoneLayer(f, {
    timers,
    heapProbe: () => ({ used, limit: HEAP_MAX }),
  });
  await layer.load();
  const tileset = f.calls.added[0];
  const s = f.Cesium.RequestScheduler;
  tileset.tilesLoaded = true;
  tick();
  assert.equal(layer._pressed, true, 'heap at the pressure line = pressed');
  assert.equal(
    tileset.show,
    true,
    'still visible and still updating: only new requests pause',
  );
  assert.equal(
    s.requestsByServer[schedulerServerKey()],
    0,
    'paused per origin',
  );
  assert.equal(map.size > 0, true, 'monitor stays alive while pressed');

  // Pending work still reports; the calm queue cannot release a high heap.
  tileset.report(3, 0);
  assert.equal(layer._pressed, true, 'heap signal holds the pressure');

  used = Math.ceil(HEAP_MAX * (PHONE_LIMITS.heapResumeFraction - 0.05));
  tileset.report(
    Math.round(PHONE_LIMITS.inFlightCap * PHONE_LIMITS.resumeFraction),
    0,
  );
  tick(); // the heap signal is probed on the monitor tick
  assert.equal(
    layer._pressed,
    false,
    'heap recovered + queue under resume = released',
  );
  assert.equal(
    s.requestsByServer[schedulerServerKey()],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'resume at the phone cap',
  );
  assert.equal(tileset.show, true, 'draws again');
  layer.destroy();
});

test('phone: loaded-tile pressure pauses requests and recovers under hysteresis', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  const s = f.Cesium.RequestScheduler;
  tileset.tilesLoaded = true;
  tileset.statistics.numberOfTilesWithContentReady =
    PHONE_LIMITS.loadedTileCap + 1;
  tick();
  assert.equal(layer._pressed, true, 'too many loaded tiles = pressure');
  assert.equal(tileset.show, true, 'never hidden');
  assert.equal(s.requestsByServer[schedulerServerKey()], 0);

  tileset.statistics.numberOfTilesWithContentReady = Math.round(
    PHONE_LIMITS.loadedTileCap * PHONE_LIMITS.resumeFraction,
  );
  tileset.report(0, 0);
  assert.equal(layer._pressed, false, 'under the resume threshold = released');
  assert.equal(tileset.show, true);
  assert.equal(
    s.requestsByServer[schedulerServerKey()],
    PHONE_LIMITS.schedulerRequestsPerServer,
  );
  layer.destroy();
});

test('phone: pressure holds during load, restores with ready, and never fights the ready show', async () => {
  const f = fake();
  const { timers, map } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  const s = f.Cesium.RequestScheduler;
  tileset.report(PHONE_LIMITS.inFlightCap + 5, 2);
  assert.equal(layer._pressed, true, 'pressure engages even before ready');
  assert.equal(
    s.requestsByServer[schedulerServerKey()],
    0,
    'paused while loading, too',
  );
  tileset.tilesLoaded = true;
  for (let i = 0; i < 3; i++) [...map.values()].forEach((fn) => fn());
  assert.equal(layer.status, 'ready');
  tileset.report(0, 0);
  assert.equal(layer._pressed, false);
  assert.equal(tileset.show, true, 'ready + calm = drawn, one code path');
  layer.destroy();
});

const heapProbeOf = (used) => () => ({ used, limit: HEAP_MAX });

test('phone: RequestScheduler throttled while active, reference-counted, restored exactly once and to the originals', async () => {
  const f = fake();
  const { timers } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const s = f.Cesium.RequestScheduler;
  const key = schedulerServerKey();
  assert.equal(
    s.requestsByServer[key],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'per-origin cap while active',
  );
  assert.equal(
    s.maximumRequestsPerServer,
    64,
    'global default untouched when an origin key exists',
  );

  // A second phone layer must not snapshot the throttled values.
  const f2 = fake();
  f2.Cesium.RequestScheduler = s;
  const layer2 = phoneLayer(f2, { timers });
  await layer2.load();
  assert.equal(layer2.phoneActive, true);

  layer.destroy();
  assert.equal(
    s.requestsByServer[key],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'still held by layer2',
  );
  layer2.destroy();
  assert.equal(
    s.requestsByServer[key],
    undefined,
    'the key is gone again: exact restoration',
  );
  assert.equal(
    s.maximumRequestsPerServer,
    64,
    'global never touched in this path',
  );
  // Knobs that do not exist in Cesium must never be written or restored.
  assert.equal(s.maximumSimultaneousTileRequests, 50, 'unknown knob untouched');
});

test('desktop does not throttle: RequestScheduler fields untouched, and a raised pending queue changes nothing', async () => {
  const f = fake();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    sampleTerrain: null,
  });
  await layer.load();
  const tileset = f.calls.added[0];
  assert.equal(f.calls.sse[0], DESKTOP_SSE, 'desktop SSE unchanged');
  tileset.report(500, 500);
  assert.equal(layer._pressed, false);
  assert.equal(tileset.show, true, 'no show gating without phone mode');
  assert.equal(f.Cesium.RequestScheduler.maximumRequestsPerServer, 64);
  layer.destroy();
  assert.equal(f.Cesium.RequestScheduler.maximumRequestsPerServer, 64);
});

test('phone can be allowed off: setPhoneMode(false) releases pressure AND the scheduler throttle; re-enabling goes coarse again', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  const s = f.Cesium.RequestScheduler;
  const key = schedulerServerKey();
  tileset.report(PHONE_LIMITS.inFlightCap + 1, 0);
  assert.equal(layer._pressed, true, 'pressed');
  assert.equal(s.requestsByServer[key], 0, 'pressed: new requests paused');

  assert.equal(layer.phoneActive, true);
  layer.setPhoneMode(false);
  assert.equal(layer.phoneActive, false);
  assert.equal(layer._pressed, false, 'pressure released');
  assert.equal(tileset.show, true, 'drawn again');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.fineError,
    'full quality restored',
  );
  assert.equal(
    s.requestsByServer[key],
    undefined,
    'throttle released: key deleted',
  );
  assert.equal(s.maximumRequestsPerServer, 64, 'global untouched');
  assert.equal(s.maximumSimultaneousTileRequests, 50, 'unknown knob untouched');

  layer.setPhoneMode(true);
  assert.equal(layer.phoneActive, true);
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'coarse again until it settles',
  );
  assert.equal(
    s.requestsByServer[key],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'throttled again, per origin',
  );
  tileset.tilesLoaded = true;
  assert.equal(tileset.show, true, 'no pressure just from re-enabling');
  layer.destroy();
});

test('auto detection: phone when small viewport OR pointer coarse OR deviceMemory <= 4; absent match Media and no navigator = off', () => {
  // coarse pointer alone (touch device that is not narrow)
  const coarse = fake();
  const coarseLayer = new Odm3dLayer({
    Cesium: coarse.Cesium,
    viewer: coarse.viewer,
    entry: entry3d(),
    matchMedia: (q) => ({ matches: q === PHONE_COARSE_QUERY }),
  });
  assert.equal(coarseLayer.phoneActive, true, 'coarse pointer = phone');
  coarseLayer.destroy();

  // small device memory alone
  const lowmem = fake();
  const lowLayer = new Odm3dLayer({
    Cesium: lowmem.Cesium,
    viewer: lowmem.viewer,
    entry: entry3d(),
    matchMedia: () => ({ matches: false }),
    deviceMemory: 4,
  });
  assert.equal(lowLayer.phoneActive, true, 'deviceMemory 4 = phone');
  lowLayer.destroy();

  // deviceMemory 5 with a desktop-width, fine-pointer matchMedia = desktop
  const strong = fake();
  const strongLayer = new Odm3dLayer({
    Cesium: strong.Cesium,
    viewer: strong.viewer,
    entry: entry3d(),
    matchMedia: () => ({ matches: false }),
    deviceMemory: 5,
  });
  assert.equal(strongLayer.phoneActive, false);
  strongLayer.destroy();
});

test('manual phoneMode values: explicit false beats a phone-shaped matchMedia', () => {
  const forced = fake();
  const forcedLayer = new Odm3dLayer({
    Cesium: forced.Cesium,
    viewer: forced.viewer,
    entry: entry3d(),
    matchMedia: (q) => ({
      matches: q === PHONE_MEDIA_QUERY || q === PHONE_COARSE_QUERY,
    }),
    deviceMemory: 2,
    phoneMode: false,
  });
  assert.equal(forcedLayer.phoneActive, false);
  forcedLayer.destroy();
});

test('phone: destroy during pressure stops the pump, removes the tileset and restores the scheduler; nothing left running', async () => {
  const f = fake();
  const { timers, map } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.report(PHONE_LIMITS.inFlightCap + 1, 0);
  assert.equal(layer._pressed, true);
  layer.destroy();
  assert.equal(f.calls.removed[0], tileset);
  assert.equal(tileset.destroyed, true);
  assert.equal(map.size, 0, 'no timers left');
  assert.equal(
    f.Cesium.RequestScheduler.maximumRequestsPerServer,
    64,
    'throttle restored',
  );
  assert.equal(
    f.Cesium.RequestScheduler.requestsByServer[schedulerServerKey()],
    undefined,
    'a key that did not exist before is deleted again, also from a pressed state',
  );
  assert.equal(layer._pressed, true, 'flag is inert after destroy');
  tileset.report(0, 0);
  assert.equal(f.calls.removed.length, 1, 'no revival after destroy');
});

test('acquireSchedulerThrottle: null scheduler is a no-op release, and release is idempotent', () => {
  assert.equal(typeof acquireSchedulerThrottle(null), 'function');
  const off = acquireSchedulerThrottle(null);
  assert.doesNotThrow(off);
  const f = fake();
  const s = f.Cesium.RequestScheduler;
  const a = acquireSchedulerThrottle(s);
  const b = acquireSchedulerThrottle(s);
  a();
  a(); // double release by one layer must not restore too early
  assert.equal(
    s.maximumRequestsPerServer,
    PHONE_LIMITS.schedulerRequestsPerServer,
  );
  b();
  assert.equal(s.maximumRequestsPerServer, 64);
  assert.equal(s.maximumSimultaneousTileRequests, 50);
  assert.deepEqual(s.requestsByServer, {}, 'server map untouched in this path');
});

test('acquireSchedulerThrottle with a server key: the documented per-server override, snapshot-and-restore, absent key deleted', async () => {
  const f = fake();
  const s = f.Cesium.RequestScheduler;

  // No key existed before: release must delete it again.
  const a = acquireSchedulerThrottle(s, 'open.byrdit.com:443');
  assert.equal(
    s.requestsByServer['open.byrdit.com:443'],
    PHONE_LIMITS.schedulerRequestsPerServer,
  );
  assert.equal(s.maximumRequestsPerServer, 64, 'global default untouched');

  // A key the scheduler already had is restored to its own value.
  s.requestsByServer['api.cesium.com:443'] = 18;
  const b = acquireSchedulerThrottle(s, 'api.cesium.com:443');
  assert.equal(
    s.requestsByServer['api.cesium.com:443'],
    PHONE_LIMITS.schedulerRequestsPerServer,
  );

  a(); // only b still holds it
  assert.equal(
    s.requestsByServer['api.cesium.com:443'],
    PHONE_LIMITS.schedulerRequestsPerServer,
    'still held by b',
  );
  b();
  assert.equal(
    s.requestsByServer['api.cesium.com:443'],
    18,
    'pre-existing override restored',
  );
  assert.equal(
    s.requestsByServer['open.byrdit.com:443'],
    undefined,
    'key that was absent is deleted, not left throttled',
  );
});

test('acquireSchedulerThrottle never raises a pre-existing tighter per-server cap', () => {
  const f = fake();
  const s = f.Cesium.RequestScheduler;
  s.requestsByServer['tight.server:443'] = 4;
  const release = acquireSchedulerThrottle(s, 'tight.server:443');
  assert.equal(
    s.requestsByServer['tight.server:443'],
    Math.min(4, PHONE_LIMITS.schedulerRequestsPerServer),
    'the tighter cap stays',
  );
  release();
  assert.equal(s.requestsByServer['tight.server:443'], 4, 'exact restoration');
});

test('schedulerServerKey: Cesium getServerKey normalization — default port appended, non-default kept, absent location = null', () => {
  const hadLocation = Object.prototype.hasOwnProperty.call(
    globalThis,
    'location',
  );
  const original = globalThis.location;
  try {
    globalThis.location = { host: 'byrd-it.example:8443', protocol: 'https:' };
    assert.equal(schedulerServerKey(), 'byrd-it.example:8443');
    // Cesium appends the default port: https -> :443 (see its getServerKey).
    globalThis.location = { host: 'byrd-it.example', protocol: 'https:' };
    assert.equal(schedulerServerKey(), 'byrd-it.example:443');
    globalThis.location = { host: 'byrd-it.example', protocol: 'http:' };
    assert.equal(
      schedulerServerKey(),
      'byrd-it.example:80',
      'http default port',
    );
    globalThis.location = { host: '' };
    assert.equal(schedulerServerKey(), null);
    delete globalThis.location;
    assert.equal(schedulerServerKey(), null);
  } finally {
    if (hadLocation) globalThis.location = original;
    else delete globalThis.location;
  }
});

test('phone: Fly to coarsens a ready, refined layer back to the initial SSE and lets it refine again after settling', async () => {
  const f = fake();
  const { timers, tick, map } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  // The bounding-sphere flight path Cesium really takes; a spy camera.
  tileset.boundingSphere = { radius: 120 };
  let flights = [];
  f.viewer.camera.flyToBoundingSphere = (sphere, opts) => {
    flights.push({ sphere, opts });
  };
  f.Cesium.HeadingPitchRange = class {};
  f.Cesium.Math = { toRadians: (d) => (d * Math.PI) / 180 };

  tileset.tilesLoaded = true;
  tick();
  tick();
  tick();
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'settled: refined',
  );
  assert.equal(map.size, 0, 'pump went quiet');

  layer.flyTo();
  assert.equal(flights.length, 1, 'the flight was issued');
  assert.equal(layer._refined, false, 'refine state reset for the flight');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'coarsened for the flight',
  );
  assert.equal(
    map.size > 0,
    true,
    'the pump runs again so the layer can refine after arrival',
  );

  tileset.tilesLoaded = true;
  tick();
  tick();
  tick();
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'refined again after the flight settled',
  );
  layer.destroy();
});

test('desktop: Fly to never changes quality', () => {
  const f = fake();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    sampleTerrain: null,
  });
  const tileset = { boundingSphere: { radius: 5 } };
  layer.tileset = tileset;
  layer.status = 'ready';
  f.viewer.camera.flyToBoundingSphere = () => {};
  f.Cesium.HeadingPitchRange = class {};
  f.Cesium.Math = { toRadians: (d) => (d * Math.PI) / 180 };
  tileset.maximumScreenSpaceError = DESKTOP_SSE;
  layer.flyTo();
  assert.equal(
    tileset.maximumScreenSpaceError,
    DESKTOP_SSE,
    'desktop SSE untouched by Fly to',
  );
});
