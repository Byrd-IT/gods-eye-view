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

test('unavailable aggregate budget fails closed in phone mode before gate or tileset', async () => {
  const f = fake();
  let gateCalls = 0;
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    phoneLimits: { ...PHONE_LIMITS, unavailable: true },
    requestGateFactory: () => {
      gateCalls++;
      return null;
    },
    sampleTerrain: async () => 0,
  });
  layer.setPhoneMode(true);
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(gateCalls, 0);
  assert.equal(f.calls.options.length, 0);
  assert.doesNotThrow(() => layer.pressureSummary());
  layer.destroy();
});
const schedulerUntouched = (f, label) => {
  const s = f.Cesium.RequestScheduler;
  assert.equal(s.maximumRequestsPerServer, 6, `${label}: per-server default`);
  assert.equal(s.maximumRequests, 500, `${label}: global cap`);
  assert.equal(s.maximumSimultaneousTileRequests, 50, `${label}: dead knob`);
  assert.deepEqual(s.requestsByServer, {}, `${label}: no per-origin override`);
};

test('PHONE_LIMITS meet the owner bar: 64-96 SSE, 64MiB cache, no overflow, a per-tileset request cap', () => {
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
    PHONE_LIMITS.pressureError,
    undefined,
    'pressure never coarsens quality: the request pause is the gate',
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

// A gate factory the layer can be pointed at: it hands the layer a
// distinguishable resource plus a gate whose pause/destroy calls are logged.
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
    log.push(['created', { resource: gate.resource }]);
    return { resource: gate.resource, gate };
  };
  return { factory, log };
};

// The wiring: ONLY a phone tileset fetches through the gate, and it is the
// tileset's own resource chain that carries the gate (never the scheduler).
test('phone wraps the tileset fetch in a per-tileset request gate; desktop gets the plain url and no gate', async () => {
  const f = fake();
  const g = gateSpy();
  const layer = phoneLayer(f, { requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];
  assert.equal(tileset.url.__odmGated, true, 'phone fetches through the gate');
  assert.equal(layer._gate.paused, false, 'calm gate is open');
  schedulerUntouched(f, 'phone with gate');
  layer.destroy();
  assert.equal(layer._gate, null);

  const d = fake();
  const dg = gateSpy();
  const desktop = new Odm3dLayer({
    Cesium: d.Cesium,
    viewer: d.viewer,
    entry: entry3d(),
    requestGateFactory: dg.factory,
  });
  await desktop.load();
  const dtileset = d.calls.added[0];
  assert.equal(
    dtileset.url,
    entry3d().url,
    'desktop fetches the plain tileset json: behaviour unchanged',
  );
  assert.equal(dg.log.length, 0, 'the desktop never creates a gate');
  desktop.destroy();
});

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
  const layer = phoneLayer(f, {
    timers,
    requestGateFactory: gateSpy().factory,
  });
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
// loadProgress would strand and a pressed gate could never release. The
// stop PAUSES NEW LOADS on the tileset's own request gate instead (the
// real request flow lives in odmRequestGate.test.mjs): started requests
// drain, queued ones wait with their Cesium Request intact, and the page
// origin's other users (imagery, terrain, the buildings tileset — every
// throttleByServer requester in 1.138) are untouched: no shared scheduler
// state is read or written, and quality never coarsens with pressure.

test('phone: queued-work pressure alone can never press the gate — gate-queued requests never drain while paused, so a queue press would deadlock the release', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];
  tick();
  tileset.report(PHONE_LIMITS.inFlightCap + 41, 0);
  assert.equal(layer._pressed, false, 'queue overload never presses');
  assert.equal(
    layer._gate.paused,
    false,
    'and so never pauses the gate: the cap already bounds in-flight work',
  );
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'quality never coarsens from pressure',
  );
  schedulerUntouched(f, 'queue overload without a press');
  layer.destroy();
});

test('phone: heap pressure pauses new loads on the tileset gate and lifts on recovery — hysteresis, no deadlock even with pending work', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, map, tick } = timersOf();
  let used = Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction);
  const layer = phoneLayer(f, {
    timers,
    heapProbe: () => ({ used, limit: HEAP_MAX }),
    requestGateFactory: g.factory,
  });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  tick();
  assert.equal(layer._pressed, true, 'heap at the pressure line = pressed');
  assert.equal(layer._gate.paused, true, 'the gate closed: no new loads start');
  assert.equal(tileset.show, true, 'still visible and still updating');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'quality untouched by pressure (still unrefined here)',
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
  assert.equal(layer._gate.paused, false, 'the gate reopens on release');
  tick();
  tick(); // three settled ticks refine the release
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'refined quality back after release and the settle pass',
  );
  schedulerUntouched(f, 'heap pressure');
  layer.destroy();
});

test('phone: loaded-tile pressure pauses the gate and recovers under hysteresis', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  tileset.statistics.numberOfTilesWithContentReady =
    PHONE_LIMITS.loadedTileCap + 1;
  tick();
  assert.equal(layer._pressed, true, 'too many loaded tiles = pressure');
  assert.equal(
    layer._gate.paused,
    true,
    'gate closed while tile count is over',
  );
  assert.equal(tileset.show, true, 'never hidden');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'quality untouched',
  );

  tileset.statistics.numberOfTilesWithContentReady = Math.round(
    PHONE_LIMITS.loadedTileCap * PHONE_LIMITS.resumeFraction,
  );
  tileset.report(0, 0);
  assert.equal(layer._pressed, false, 'under the resume threshold = released');
  assert.equal(layer._gate.paused, false, 'gate reopens');
  tileset.tilesLoaded = true;
  tick();
  tick(); // three settled ticks refine the release
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.phoneFineError,
    'refined after the settle pass post-release',
  );
  schedulerUntouched(f, 'loaded-tile pressure');
  layer.destroy();
});

test('phone: pressure pauses during load, keeps the queue draining, ready show wins once calm', async () => {
  const f = fake();
  const { timers, map, tick } = timersOf();
  const g = gateSpy();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];

  layer.heapProbe = () => ({
    used: Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction),
    limit: HEAP_MAX,
  });
  tick();
  assert.equal(layer._pressed, true, 'pressure engages even before ready');
  assert.equal(layer._gate.paused, true, 'gate closed while still loading');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'quality untouched while loading',
  );
  tileset.tilesLoaded = true;
  tileset.report(0, 0);
  layer.heapProbe = () => ({ used: HEAP_MAX * 0.5, limit: HEAP_MAX });
  for (let i = 0; i < 3; i++) tick();
  assert.equal(layer.status, 'ready');
  assert.equal(tileset.show, true, 'ready + calm = drawn, one code path');
  assert.equal(layer._gate.paused, false, 'gate reopened once calm');
  layer.destroy();
});

test('phone: many phone layers together still write nothing shared; the last destroy leaves Cesium defaults', async () => {
  const f = fake();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, {
    timers,
    requestGateFactory: gateSpy().factory,
  });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.tilesLoaded = true;
  for (let i = 0; i < 3; i++) tick();

  const f2 = fake();
  f2.Cesium.RequestScheduler = f.Cesium.RequestScheduler;
  const g2 = gateSpy();
  const layer2 = phoneLayer(f2, { timers, requestGateFactory: g2.factory });
  await layer2.load();
  const tileset2 = f2.calls.added[0];
  layer2.heapProbe = () => ({
    used: Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction),
    limit: HEAP_MAX,
  });
  tick(); // layer2 pressed by heap, layer1 calm
  assert.equal(layer2._pressed, true);
  assert.equal(
    layer2._gate.paused,
    true,
    'the pressed layer pauses its OWN gate',
  );
  assert.equal(layer._pressed, false, 'the calm layer is not pressed');
  schedulerUntouched(f, 'two phone layers, one pressed');

  layer.destroy();
  layer2.destroy();
  schedulerUntouched(f, 'after both destroyed');
});

test('phone uses its variant through the gate and mode switches restore each URL', async () => {
  const f = fake();
  const entry = {
    ...entry3d(),
    phoneUrl: '/basemap/odm3d/odm-3d-9be42b4f-phone/tileset.json',
  };
  const urls = [];
  const g = gateSpy();
  const layer = phoneLayer(f, {
    entry,
    requestGateFactory: (C, url, options) => {
      urls.push(url);
      return g.factory(C, url, options);
    },
  });
  await layer.load();
  assert.deepEqual(urls, [entry.phoneUrl]);
  layer.setPhoneMode(false);
  await layer._loading;
  assert.equal(f.calls.added[1].url, entry.url);
  layer.setPhoneMode(true);
  await layer._loading;
  assert.deepEqual(urls, [entry.phoneUrl, entry.phoneUrl]);
  layer.destroy();
});

test('phone can be allowed off: setPhoneMode(false) releases pressure and REBUILDS a clean desktop build (ungated, desktop cache); re-enabling rebuilds through the gate', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, tick } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const phoneTileset = f.calls.added[0];
  layer.heapProbe = () => ({
    used: Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction),
    limit: HEAP_MAX,
  });
  tick();
  assert.equal(layer._pressed, true, 'pressed');
  assert.equal(layer._gate.paused, true, 'paused');

  assert.equal(layer.phoneActive, true);
  const beforeSwitch = g.log.length;
  layer.setPhoneMode(false);
  assert.equal(
    g.log
      .slice(beforeSwitch)
      .some(([event, value]) => event === 'setPaused' && value === false),
    false,
    'mode switch never reopens a pressured gate before destroying it',
  );
  await layer._loading; // the desktop rebuild
  assert.equal(layer.phoneActive, false);
  assert.equal(layer._pressed, false, 'pressure released');
  assert.equal(
    phoneTileset.destroyed,
    true,
    'the gated phone build was torn down',
  );
  const desktopTileset = f.calls.added[1];
  assert.equal(
    desktopTileset.url,
    entry3d().url,
    'the desktop rebuild is plain: no gate on its chain',
  );
  assert.equal(layer._gate, null, 'no gate on the desktop build');
  const opts = f.calls.options[1];
  assert.equal(opts.cacheBytes, DESKTOP_CACHE_BYTES, 'desktop cache restored');
  assert.equal(
    opts.maximumCacheOverflowBytes,
    DESKTOP_CACHE_OVERFLOW_BYTES,
    'desktop overflow restored',
  );
  assert.equal(
    layer.tileset.maximumScreenSpaceError,
    PHONE_LIMITS.fineError,
    'desktop SSE restored',
  );
  assert.equal(desktopTileset.show, true, 'drawn');
  schedulerUntouched(f, 'phone mode off');

  layer.setPhoneMode(true); // a desktop build has no gate: rebuild again
  await layer._loading;
  assert.equal(layer.phoneActive, true);
  assert.equal(f.calls.added.length, 3, 'third build through the gate');
  assert.equal(
    f.calls.added[2].url.__odmGated,
    true,
    're-enabling rebuilds through the gate',
  );
  assert.equal(f.calls.options[2].cacheBytes, 64 * MiB, 'phone cache again');
  assert.equal(
    f.calls.options[2].maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'coarse again until it settles',
  );
  assert.equal(layer._gate.paused, false, 'no pressure just from re-enabling');
  layer.destroy();
});

test('a mode change during a failed load retries using the final mode', async () => {
  const f = fake();
  const original = f.Cesium.Cesium3DTileset.fromUrl;
  let fail;
  let calls = 0;
  f.Cesium.Cesium3DTileset.fromUrl = (...args) => {
    if (calls++ === 0)
      return new Promise((resolve, reject) => {
        fail = reject;
      });
    return original(...args);
  };
  const layer = phoneLayer(f, { requestGateFactory: gateSpy().factory });
  const first = layer.load();
  layer.setPhoneMode(false);
  fail(new Error('failure'));
  await first;
  await layer._loading;
  assert.equal(calls, 2);
  assert.equal(layer.status, 'ready');
  assert.equal(f.calls.tilesets[0].url, entry3d().url);
  layer.destroy();
});

test('failed model load never exposes raw exception text', async () => {
  const f = fake();
  const secret = 'SYNTHETIC-BEARER-secretSuffix123';
  f.Cesium.Cesium3DTileset.fromUrl = async () => {
    throw new Error(
      `Authorization: Bearer ${secret} https://user:pass@host/path?key=${secret}`,
    );
  };
  const layer = phoneLayer(f, { requestGateFactory: gateSpy().factory });
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(layer.error, '3D model load failed');
  assert.equal(JSON.stringify(layer.error).includes(secret), false);
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
  const g = gateSpy();
  const layer = phoneLayer(boom, { requestGateFactory: g.factory });
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(layer._pressed, false, 'no pressure state survives the failure');
  assert.equal(layer.tileset, null);
  assert.equal(layer._gate, null, 'the failed layer holds no gate');
  assert.equal(
    g.log.some((e) => e[0] === 'destroyed'),
    true,
    'gate destroyed',
  );
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

test('phone: destroy under pressure stops the pump, kills the gate, removes the tileset; nothing left running, nothing shared left behind', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, map, tick } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];
  layer.heapProbe = () => ({
    used: Math.ceil(HEAP_MAX * PHONE_LIMITS.heapPressureFraction),
    limit: HEAP_MAX,
  });
  tick();
  assert.equal(layer._pressed, true);
  assert.equal(layer._gate.paused, true);
  layer.destroy();
  assert.equal(f.calls.removed[0], tileset);
  assert.equal(tileset.destroyed, true);
  assert.equal(map.size, 0, 'no timers left');
  assert.equal(
    g.log.some((e) => e[0] === 'destroyed'),
    true,
    'gate destroyed',
  );
  assert.equal(layer._gate, null, 'no gate left behind');
  assert.equal(layer._pressed, true, 'flag is inert after destroy');
  layer.heapProbe = () => ({ used: 0, limit: HEAP_MAX });
  tick();
  assert.equal(f.calls.removed.length, 1, 'no revival after destroy');
  schedulerUntouched(f, 'destroy while pressed');
});

test('phone: Fly to coarsens a ready, refined layer back to the initial SSE and lets it refine again after settling', async () => {
  const f = fake();
  const { timers, tick, map } = timersOf();
  const layer = phoneLayer(f, {
    timers,
    requestGateFactory: gateSpy().factory,
  });
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

// ---------------------------------------------------------------------------
// In-flight mode toggles: a mode switch that lands while a load is in flight
// must still take effect. The cache budget, gate presence and SSE are fixed
// at fromUrl() and cannot be adopted in place, so the drift resolver at the
// end of load() rebuilds the tileset for the mode that is actually active.
// ---------------------------------------------------------------------------

// A fake that defers only the FIRST fromUrl() until released (a drift
// rebuild call passes straight through, so the layer can settle).
const deferredFake = (f) => {
  const fromUrl = f.Cesium.Cesium3DTileset.fromUrl;
  let release = null;
  let deferred = 0;
  f.Cesium.Cesium3DTileset.fromUrl = (url, opts) =>
    deferred++ === 0
      ? new Promise((res) => {
          release = () => res(fromUrl(url, opts));
        })
      : fromUrl(url, opts);
  return () => {
    const r = release;
    release = null;
    r?.();
  };
};

test('setPhoneMode(true) during an in-flight desktop load ends with a gated phone build — the drift is rebuilt, not stranded', async () => {
  const f = fake();
  const g = gateSpy();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    requestGateFactory: g.factory,
  });
  const release = deferredFake(f);
  const p = layer.load(); // the desktop build
  for (let i = 0; i < 8; i++) await Promise.resolve();
  layer.setPhoneMode(true); // mid-flight toggle ON
  release();
  await p;
  await layer._loading; // the drift rebuild (pre-fix: never happens)
  assert.equal(f.calls.tilesets.length, 2, 'a second tileset was built');
  assert.equal(
    f.calls.tilesets[0].destroyed,
    true,
    'the ungated desktop build was torn down',
  );
  const opts = f.calls.options[1];
  assert.equal(
    f.calls.tilesets[1].url.__odmGated,
    true,
    'the rebuilt tileset fetches through the gate',
  );
  assert.equal(opts.cacheBytes, 64 * MiB, 'phone cache budget applies');
  assert.equal(opts.maximumCacheOverflowBytes, 0);
  assert.equal(opts.maximumScreenSpaceError, PHONE_LIMITS.initialError);
  assert.equal(layer._gate?.paused, false);
  assert.equal(layer.tileset, f.calls.tilesets[1]);
  assert.equal(layer.status, 'ready');
  assert.equal(layer.phoneActive, true);
  schedulerUntouched(f, 'drift rebuild phone');
  layer.destroy();
});

test('setPhoneMode(false) during an in-flight phone load ends with a clean desktop build — ungated, desktop cache, desktop SSE', async () => {
  const f = fake();
  const g = gateSpy();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    phoneMode: true,
    requestGateFactory: g.factory,
  });
  const release = deferredFake(f);
  const p = layer.load(); // the phone build
  for (let i = 0; i < 8; i++) await Promise.resolve();
  layer.setPhoneMode(false); // mid-flight toggle OFF
  release();
  await p;
  await layer._loading; // the drift rebuild (pre-fix: never happens)
  assert.equal(f.calls.tilesets.length, 2, 'a second tileset was built');
  assert.equal(f.calls.tilesets[0].destroyed, true, 'phone build torn down');
  const second = f.calls.tilesets[1];
  assert.equal(
    second.url,
    entry3d().url,
    'the rebuilt desktop tileset is plain (no gate left)',
  );
  const opts = f.calls.options[1];
  assert.equal(opts.cacheBytes, DESKTOP_CACHE_BYTES, 'desktop cache restored');
  assert.equal(opts.maximumCacheOverflowBytes, DESKTOP_CACHE_OVERFLOW_BYTES);
  assert.equal(opts.maximumScreenSpaceError, DESKTOP_SSE, 'desktop SSE');
  assert.equal(layer._gate, null, 'no gate on the desktop build');
  assert.equal(second.destroyed, false);
  assert.equal(layer.status, 'ready');
  assert.equal(layer.phoneActive, false);
  assert.equal(
    g.log.some((e) => e[0] === 'destroyed'),
    true,
    'gate destroyed',
  );
  schedulerUntouched(f, 'drift rebuild desktop');
  layer.destroy();
});

test('rapid toggles during an in-flight load settle to the final mode with exactly one rebuild', async () => {
  const f = fake();
  const g = gateSpy();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    requestGateFactory: g.factory,
  });
  const release = deferredFake(f);
  const p = layer.load();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  layer.setPhoneMode(true);
  layer.setPhoneMode(false);
  layer.setPhoneMode(true);
  layer.setPhoneMode(false);
  layer.setPhoneMode(true);
  release();
  await p;
  await layer._loading;
  assert.equal(f.calls.tilesets.length, 2, 'one rebuild, not five');
  assert.equal(layer.phoneActive, true, 'the final wins');
  assert.equal(layer.tileset, f.calls.tilesets[1]);
  assert.equal(f.calls.tilesets[1].url.__odmGated, true);
  assert.equal(f.calls.options[1].cacheBytes, 64 * MiB);
  assert.equal(layer.status, 'ready');
  layer.destroy();
});

test('destroy during an in-flight load with a pending drift: no post-destroy rebuild, no timers, gate dead', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, map } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  const release = deferredFake(f);
  const p = layer.load();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  layer.setPhoneMode(false); // mid-flight toggle OFF: a pending drift exists
  layer.destroy();
  try {
    release();
    await p;
  } catch {
    /* a load that already failed or was cancelled is fine here */
  }
  assert.equal(f.calls.tilesets?.length, 1, 'no post-destroy rebuild');
  assert.equal(f.calls.tilesets[0].destroyed, true, 'the build was destroyed');
  assert.equal(map.size, 0, 'no timers left');
  assert.equal(
    g.log.some((e) => e[0] === 'destroyed'),
    true,
    'gate destroyed',
  );
  assert.equal(layer._gate, null);
  layer.setPhoneMode(false); // inert after destroy
  layer.setPhoneMode(true);
});

// ---------------------------------------------------------------------------
// Pressure policy: the gate must NEVER reopen while a pressure signal sits
// above its release threshold. An idle press above the release threshold is
// a stall: it holds (surfaced, not hidden) until the signal itself falls
// (Cesium eviction or GC on its own schedule), and the monitor keeps ticking
// at 4 Hz so a genuine fall releases on the next tick — no busy loop.
// ---------------------------------------------------------------------------

test('phone: the gate never reopens while heap pressure is above the release threshold, even when idle, and the stall state is surfaced', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, map, tick } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];
  let used = Math.ceil(HEAP_MAX * 0.95);
  layer.heapProbe = () => ({ used, limit: HEAP_MAX });
  tileset.tilesLoaded = true;
  tileset.report(0, 0);
  tick();
  assert.equal(layer._pressed, true, 'heap at 95% = pressed');
  assert.equal(layer._gate.paused, true, 'the gate closed');
  for (let i = 0; i < 40; i++) tick(); // 40 idle ticks must NOT reopen
  assert.equal(
    layer._gate.paused,
    true,
    'the gate stays closed while the heap is above the release threshold',
  );
  assert.equal(layer._pressed, true, 'still pressed: no violation');
  assert.equal(layer.pressurePaused, true, 'the pause state is surfaced');
  assert.equal(layer.pressureStalled, true, 'the stall state is surfaced');
  assert.equal(map.size, 1, 'exactly one monitor (no busy loop)');
  const s = layer.pressureSummary();
  assert.equal(s.gatePaused, true);
  assert.ok(s.heapRatio >= PHONE_LIMITS.heapResumeFraction);

  used = Math.ceil(HEAP_MAX * (PHONE_LIMITS.heapResumeFraction - 0.05));
  tick(); // the heap genuinely fell: one tick releases
  assert.equal(layer._pressed, false, 'released on genuine recovery');
  assert.equal(layer._gate.paused, false, 'the gate reopens');
  assert.equal(layer.pressureStalled, false);
  schedulerUntouched(f, 'heap stall hold');
  layer.destroy();
});

test('phone: a tile-count press above its release threshold holds while idle (no two-tick release), holds the pause, and releases only when the count falls', async () => {
  const f = fake();
  const g = gateSpy();
  const { timers, map, tick } = timersOf();
  const layer = phoneLayer(f, { timers, requestGateFactory: g.factory });
  await layer.load();
  const tileset = f.calls.added[0];
  tileset.statistics.numberOfTilesWithContentReady =
    PHONE_LIMITS.loadedTileCap + 50;
  tileset.tilesLoaded = true;
  tileset.report(0, 0);
  tick();
  assert.equal(layer._pressed, true, 'count over the cap = pressed');
  assert.equal(layer._gate.paused, true);
  for (let i = 0; i < 40; i++) tick();
  assert.equal(layer._gate.paused, true, 'idle does NOT lift the pause');
  assert.equal(layer._pressed, true);
  assert.equal(layer.pressureStalled, true, 'the stall is surfaced');
  assert.equal(
    tileset.maximumScreenSpaceError,
    PHONE_LIMITS.initialError,
    'nothing coarsens: the pause IS the gate',
  );
  assert.equal(tileset.show, true, 'the tileset stays visible');

  // Cesium eviction on its own schedule moves the count below the resume line:
  tileset.statistics.numberOfTilesWithContentReady = Math.round(
    PHONE_LIMITS.loadedTileCap * PHONE_LIMITS.resumeFraction,
  );
  tick();
  assert.equal(layer._pressed, false, 'released when the count actually falls');
  assert.equal(layer._gate.paused, false, 'the gate reopened under the cap');
  schedulerUntouched(f, 'tile-count stall hold');
  layer.destroy();
});

test('pressurePaused and pressureSummary describe a calm layer (no false stall)', async () => {
  const f = fake();
  const g = gateSpy();
  const layer = phoneLayer(f, { requestGateFactory: g.factory });
  await layer.load();
  assert.equal(layer.pressurePaused, false);
  assert.equal(layer.pressureStalled, false);
  const s = layer.pressureSummary();
  assert.equal(s.pressed, false);
  assert.equal(s.gatePaused, false);
  assert.equal(s.stalled, false);
  schedulerUntouched(f, 'calm summary');
  layer.destroy();
});

// A desktop build's resource chain was fixed at fromUrl() WITHOUT the gate,
// and its cache budget is the desktop one. Neither can be adopted in place,
// so setPhoneMode(true) after a desktop load must rebuild the tileset
// through the gate — pre-fix it only rewrote the SSE and the phone kept
// loading ungated on the desktop chain with the desktop cache.
test('setPhoneMode(true) after a desktop load rebuilds the tileset through the gate with the phone cache', async () => {
  const f = fake();
  const g = gateSpy();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    requestGateFactory: g.factory,
  });
  await layer.load();
  const desktopTileset = f.calls.added[0];
  assert.equal(
    desktopTileset.url,
    entry3d().url,
    'the desktop build is ungated, as designed',
  );
  assert.equal(
    g.log.some((e) => e[0] === 'created'),
    false,
  );

  layer.setPhoneMode(true);
  await layer._loading; // the rebuild load
  assert.equal(
    f.calls.tilesets?.length,
    2,
    'a second tileset was built (pre-fix: still one)',
  );
  assert.equal(
    desktopTileset.destroyed,
    true,
    'the ungated desktop build was torn down',
  );
  const phoneTileset = f.calls.added[1];
  assert.equal(
    phoneTileset.url.__odmGated,
    true,
    'the rebuilt tileset fetches through the gate',
  );
  const opts = f.calls.options[1];
  assert.equal(opts.cacheBytes, 64 * MiB, 'the phone cache budget applies');
  assert.equal(opts.maximumCacheOverflowBytes, 0, 'no overflow');
  assert.equal(opts.maximumScreenSpaceError, PHONE_LIMITS.initialError);
  assert.equal(
    layer._gate?.paused,
    false,
    'the layer carries a real, open gate',
  );
  assert.equal(layer.tileset, phoneTileset);
  assert.equal(layer.status, 'ready');
  schedulerUntouched(f, 'desktop -> phone rebuild');
  layer.destroy();
  assert.equal(
    g.log.some((e) => e[0] === 'destroyed'),
    true,
  );
});

// (superseded stall-release test removed)

// ------------------------------------------------- gate fail-closed on phone

// A phone build without its gate is ungated, unmanaged load pressure: the
// DEFAULT factory failing is a load failure, not a silent fallback.
test('phone without a validated smaller variant fails closed without loading the original', async () => {
  const f = fake();
  let attempted = false;
  f.Cesium.Cesium3DTileset.fromUrl = async () => {
    attempted = true;
    throw new Error('original must not load');
  };
  const layer = phoneLayer(f);
  await layer.load();
  assert.equal(layer.status, 'failed');
  assert.equal(layer.error, 'Phone 3D variant unavailable');
  assert.equal(attempted, false);
  f.Cesium.Cesium3DTileset.fromUrl = async () => {
    throw new Error('desktop was attempted');
  };
  layer.setPhoneMode(false);
  await layer._loading;
  assert.equal(
    layer.error,
    '3D model load failed',
    'disabling phone retries the original instead of stranding the layer',
  );
  layer.destroy();
});

test('phone: the default gate factory failing fails the load closed (no ungated tileset)', async () => {
  const f = fake();
  const { timers } = timersOf();
  // A fake Cesium has no Resource class, so `createOdmRequestGateResource`
  // (the layer's DEFAULT factory) cannot create a gate: the load must not
  // fall back to the plain URL.
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: {
      ...entry3d(),
      phoneUrl: '/basemap/odm3d/odm-3d-9be42b4f-phone/tileset.json',
    },
    phoneMode: true,
    timers,
  });
  await layer.load();
  assert.equal(layer.status, 'failed', 'fail closed: status failed');
  assert.match(
    String(layer.error),
    /gate/i,
    'the failure names the request gate',
  );
  assert.ok(layer.gateError, 'the gate failure is recorded for the panel');
  assert.equal(layer.tileset, null, 'no tileset was built ungated');
  assert.equal(f.calls.added.length, 0, 'nothing entered the scene');
  assert.equal(
    f.calls.tilesets?.length ?? 0,
    0,
    'Cesium3DTileset.fromUrl was never reached',
  );
  layer.destroy();
});

test('phone: an INJECTED gate factory stays dependency-injectable (may be fake)', async () => {
  // An explicitly injected factory returns no gate: the layer keeps the test
  // fallback behaviour and only records what happened.
  const f = fake();
  const { timers } = timersOf();
  const layer = new Odm3dLayer({
    Cesium: f.Cesium,
    viewer: f.viewer,
    entry: entry3d(),
    phoneMode: true,
    timers,
    requestGateFactory: () => null,
  });
  await layer.load();
  assert.equal(layer.status, 'ready', 'an injected fake factory still loads');
  assert.equal(f.calls.sse[0], PHONE_LIMITS.initialError);
  layer.destroy();

  // An injected factory that throws: same fallback, but the error is visible.
  const f2 = fake();
  const layer2 = new Odm3dLayer({
    Cesium: f2.Cesium,
    viewer: f2.viewer,
    entry: entry3d(),
    phoneMode: true,
    timers,
    requestGateFactory: () => {
      throw new Error('injected factory exploded');
    },
  });
  await layer2.load();
  assert.equal(layer2.status, 'ready');
  assert.equal(layer2.gateError, 'the gate factory threw');
  layer2.destroy();
});
