import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Odm3dLayer,
  DESKTOP_SSE,
  DESKTOP_CACHE_BYTES,
  DESKTOP_CACHE_OVERFLOW_BYTES,
  PHONE_LIMITS,
  PHONE_MEDIA_QUERY,
  PHONE_COARSE_QUERY,
  isPhoneView,
  isPhoneEnvironment,
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
  // Everything the old phone code used to mutate on the scheduler. The one
  // behavioral guarantee this file asserts: a phone layer never writes any
  // of it (a per-origin pause would strand the app's unrelated same-origin
  // loaders: /basemap/ imagery, terrain and the buildings tileset).
  const RequestScheduler = {
    maximumRequests: 500,
    maximumRequestsPerServer: 6, // Cesium 1.138's shipped default
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
const schedulerUntouched = (f, label) => {
  const s = f.Cesium.RequestScheduler;
  assert.equal(s.maximumRequestsPerServer, 6, `${label}: per-server default`);
  assert.equal(s.maximumRequests, 500, `${label}: global cap`);
  assert.equal(s.maximumSimultaneousTileRequests, 50, `${label}: dead knob`);
  assert.deepEqual(s.requestsByServer, {}, `${label}: no per-origin override`);
};

test('PHONE_LIMITS meet the owner bar: 64-96 SSE, 64MiB cache with no overflow, per-tileset pressure gate', () => {
  assert.ok(
    PHONE_LIMITS.initialError >= 64 && PHONE_LIMITS.initialError <= 96,
    `coarse phone SSE ${PHONE_LIMITS.initialError} must sit in 64-96`,
  );
  assert.ok(
    PHONE_LIMITS.phoneFineError >= 64 && PHONE_LIMITS.phoneFineError <= 96,
    `refined phone SSE ${PHONE_LIMITS.phoneFineError} must stay in 64-96`,
  );
  assert.ok(
    PHONE_LIMITS.pressureError >= 64 && PHONE_LIMITS.pressureError <= 96,
    `pressed phone SSE ${PHONE_LIMITS.pressureError} must stay in 64-96`,
  );
  assert.ok(
    PHONE_LIMITS.phoneFineError < PHONE_LIMITS.initialError,
    'refined quality is sharper than the coarse start',
  );
  assert.ok(
    PHONE_LIMITS.pressureError > PHONE_LIMITS.initialError,
    'pressure coarsens further than the coarse start',
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

const phoneLayer = (f, extra = {}) =>
  new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    phoneMode: true,
    ...extra,
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

// Cesium 1.138 facts under test: fromUrl called with `undefined` cache
// options adopts the engine's 512 MiB + 512 MiB defaults, so the desktop
// budget is passed explicitly and equals what the tileset shipped with.
test('desktop keeps its cache budget explicitly: 256 MiB with 256 MiB overflow, not Cesium 512 defaults', async () => {
  const f = fake();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    sampleTerrain: null,
  });
  await layer.load();
  const opts = f.calls.options[0];
  assert.equal(opts.cacheBytes, DESKTOP_CACHE_BYTES, '256 MiB cache');
  assert.equal(opts.maximumCacheOverflowBytes, 256 * MiB, 'overflow budget');
  assert.equal(DESKTOP_CACHE_BYTES, 256 * MiB);
  assert.equal(DESKTOP_CACHE_OVERFLOW_BYTES, 256 * MiB);
  assert.equal(f.calls.sse[0], DESKTOP_SSE, 'desktop SSE unchanged');
  schedulerUntouched(f, 'desktop');
  layer.destroy();
});

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
  schedulerUntouched(f, 'phone, calm');
  layer.destroy();
});

// The pressure stop never hides the tileset: Cesium's Cesium3DTileset.update
// exits before the tile queue when show is false, so pending work and
// loadProgress would strand and a pressed gate could never release. The stop
// COARSENES the tileset itself (maximumScreenSpaceError -> the band's upper
// edge): Cesium's next update recomputes the wanted-tile set, so new
// requests stop by demand, already-queued work drains, and the page origin's
// other users (imagery, terrain, the buildings tileset — every
// throttleByServer requester in 1.138) are untouched: no shared scheduler
// state is read or written.

test('phone: pressure coarsens the tileset into the band edge, never hides it, and never touches the scheduler', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  tick();
  tick();
  tick();
  assert.equal(tileset.show, true, 'ready and unpressed = drawn');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'settled: refined to 64',
  );

  tileset.report(PHONE_LIMITS.inFlightCap + 1, 0);
  assert.equal(layer._pressed, true, 'over cap = pressure engaged');
  assert.equal(
    tileset.show,
    true,
    'never hidden: a hidden tileset would strand its queue',
  );
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.pressureError,
    'coarsened to the band edge, still inside 64-96',
  );

  tileset.report(PHONE_LIMITS.inFlightCap, 0);
  assert.equal(layer._pressed, true, 'at the cap is still pressure');

  tileset.report(
    Math.round(PHONE_LIMITS.inFlightCap * PHONE_LIMITS.resumeFraction),
    0,
  );
  assert.equal(layer._pressed, false, 'hysteresis release under the threshold');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'released back to the settled quality',
  );
  schedulerUntouched(f, 'pressed and released');
  layer.destroy();
});

test('phone: heap pressure coarsens, drops when the heap recovers — hysteresis, no deadlock even with pending work', async () => {
  const f = fake();
  const { timers, map, tick } = timersOf();
  let used = Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction);
  const layer = phoneLayer(f, {
    timers,
    heapProbe: () => ({ used, limit: HEAP_MAX }),
  });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  tick();
  assert.equal(layer._pressed, true, 'heap at the pressure line = pressed');
  assert.equal(
    tileset.show,
    true,
    'still visible and still updating: only demand coarsens',
  );
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.pressureError,
    'coarsened to the band edge',
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
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'settled quality back after release',
  );
  schedulerUntouched(f, 'heap pressure');
  layer.destroy();
});

test('phone: loaded-tile pressure coarsens and recovers under hysteresis', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  tileset.statistics.numberOfTilesWithContentReady =
    PHONE_LIMITS.loadedTileCap + 1;
  tick();
  assert.equal(layer._pressed, true, 'too many loaded tiles = pressure');
  assert.equal(tileset.show, true, 'never hidden');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.pressureError,
    'coarsened inside the band',
  );

  tileset.statistics.numberOfTilesWithContentReady = Math.round(
    PHONE_LIMITS.loadedTileCap * PHONE_LIMITS.resumeFraction,
  );
  tileset.report(0, 0);
  assert.equal(layer._pressed, false, 'under the resume threshold = released');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'refined back after release',
  );
  schedulerUntouched(f, 'loaded-tile pressure');
  layer.destroy();
});

test('phone: pressure coarsens during load, keeps the queue draining, ready show wins once calm', async () => {
  const f = fake();
  const { timers, map, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.report(PHONE_LIMITS.inFlightCap + 5, 2);
  assert.equal(layer._pressed, true, 'pressure engages even before ready');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.pressureError,
    'coarsened while loading, too',
  );
  tileset.tilesLoaded = true;
  tileset.report(0, 0);
  for (let i = 0; i < 3; i++) tick();
  assert.equal(layer.status, 'ready');
  assert.equal(tileset.show, true, 'ready + calm = drawn, one code path');
  assert.equal(
    tileset.maximumScreenSpaceError < PHONE_LIMITS.pressureError,
    true,
    'quality restored after release',
  );
  layer.destroy();
});

test('phone: many phone layers together still write nothing shared; the last destroy leaves Cesium defaults', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  for (let i = 0; i < 3; i++) tick();

  const f2 = fake();
  f2.Cesium.RequestScheduler = f.Cesium.RequestScheduler;
  const layer2 = phoneLayer(f2, { timers });
  await layer2.load();
  const tileset2 = f2.calls.added[0];
  tileset2.report(PHONE_LIMITS.inFlightCap + 1, 0); // layer2 pressed
  assert.equal(layer2._pressed, true);
  assert.equal(
    tileset2.maximumScreenSpaceError,
    PHONE_LIMITS.pressureError,
    'the pressed tileset coarsens; nothing shared changes',
  );
  schedulerUntouched(f, 'two phone layers, one pressed');

  layer.destroy();
  layer2.destroy();
  schedulerUntouched(f, 'after both destroyed');
});

test('phone can be allowed off: setPhoneMode(false) releases pressure and restores the desktop-like SSE; re-enabling goes coarse again', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.report(PHONE_LIMITS.inFlightCap + 1, 0);
  assert.equal(layer._pressed, true, 'pressed');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.pressureError,
    'coarsened',
  );

  assert.equal(layer.phoneActive, true);
  layer.setPhoneMode(false);
  assert.equal(layer.phoneActive, false);
  assert.equal(layer._pressed, false, 'pressure released');
  assert.equal(tileset.show, true, 'drawn again');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.fineError,
    'desktop quality restored',
  );
  schedulerUntouched(f, 'phone mode off');

  layer.setPhoneMode(true);
  assert.equal(layer.phoneActive, true);
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'coarse again until it settles',
  );
  tileset.tilesLoaded = true;
  assert.equal(tileset.show, true, 'no pressure just from re-enabling');
  layer.destroy();
});

test('setPhoneMode on a failed layer changes nothing shared and cannot strand pressure', async () => {
  const f = fake();
  // Break the tileset factory: the layer fails before a tileset exists.
  const boom = { ...f };
  boom.Cesium = { ...f.Cesium };
  boom.Cesium.Cesium3DTileset = {
    async fromUrl() {
      throw new Error('origin unavailable');
    },
  };
  const layer = phoneLayer(boom, {});
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(layer._pressed, false, 'no pressure state survives the failure');
  assert.equal(layer.tileset, null);
  assert.equal(layer.setPhoneMode(false) === undefined, true);
  layer.setPhoneMode(true);
  assert.equal(layer.phoneActive, true);
  schedulerUntouched(boom, 'failed layer');
  layer.destroy();
});

test('auto detection: phone when small viewport OR pointer coarse OR deviceMemory <= 4; absent matchMedia and no navigator = off', () => {
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

test('phone: destroy during pressure stops the pump, removes the tileset; nothing left running, nothing shared left behind', async () => {
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
  assert.equal(layer._pressed, true, 'flag is inert after destroy');
  tileset.report(0, 0);
  assert.equal(f.calls.removed.length, 1, 'no revival after destroy');
  schedulerUntouched(f, 'destroy while pressed');
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
  schedulerUntouched(f, 'fly to');
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
