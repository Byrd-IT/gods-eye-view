import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import {
  CCTV_GEO_REFINE_MAX_HEIGHT_M,
  CCTV_GEO_REFINE_MAX_PER_PASS,
  createViewTest,
  defineLazyFields,
  panelPreviewVisible,
  screenPointInView,
  shouldRefreshLiveFrame,
  visibleRecordsNeedingGeometry,
} from './liveVisibility.js';
import {
  upstreamDemandActive,
  upstreamIdleReleaseMs,
  UPSTREAM_IDLE_RELEASE_MS,
} from './upstreamDemand.js';
import { createGeometryQueue } from '../layers/cctv/geometryQueue.js';
import { createFrames } from '../layers/cctv/frames.js';
import { createPresentation } from '../layers/cctv/presentation.js';
import { DataLayerManager } from '../data/manager.js';

// Byrd-IT (t_75fc43e5): live data only for what is on screen.

const W = 1000;
const H = 600;

/** Fake viewer: a real camera position over Texas (so the real horizon
 * occluder works) and a lookup table for canvas coordinates. */
function fakeViewer({ heightM = 20_000, screens = new Map() } = {}) {
  const positionWC = Cesium.Cartesian3.fromDegrees(-97.7, 30.3, heightM);
  return {
    isDestroyed: () => false,
    camera: {
      positionWC,
      positionCartographic: {
        latitude: Cesium.Math.toRadians(30.3),
        longitude: Cesium.Math.toRadians(-97.7),
        height: heightM,
      },
    },
    trackedEntity: null,
    scene: {
      canvas: { clientWidth: W, clientHeight: H },
      cartesianToCanvasCoordinates: (p) => screens.get(p),
    },
    screens,
  };
}

function rec(id, lon, lat) {
  return {
    camera: {
      id,
      lon,
      lat,
      name: id,
      city: 'Austin',
      headingDeg: 0,
      fovDeg: 50,
      pitchDeg: -10,
    },
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 10),
  };
}

test('screenPointInView honors the margin and rejects junk', () => {
  assert.equal(screenPointInView({ x: 500, y: 300 }, W, H), true);
  assert.equal(screenPointInView({ x: -50, y: 300 }, W, H, 0.1), true);
  assert.equal(screenPointInView({ x: -150, y: 300 }, W, H, 0.1), false);
  assert.equal(screenPointInView({ x: 500, y: H + 100 }, W, H, 0.1), false);
  assert.equal(screenPointInView(undefined, W, H), false);
  assert.equal(screenPointInView({ x: NaN, y: 1 }, W, H), false);
  assert.equal(screenPointInView({ x: 1, y: 1 }, 0, 0), false);
});

test('createViewTest: on screen yes, off screen no, horizon-occluded no', () => {
  const viewer = fakeViewer();
  const near = rec('near', -97.7, 30.3);
  const far = rec('far', 80, -30); // other side of the planet
  viewer.screens.set(near.position, { x: 400, y: 300 });
  viewer.screens.set(far.position, { x: 400, y: 300 }); // would project, but occluded
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    viewer.camera.positionWC,
  );
  const inView = createViewTest(viewer, occluder);
  assert.equal(inView(near.position), true);
  assert.equal(inView(far.position), false, 'far side of the globe');
  viewer.screens.set(near.position, { x: 4000, y: 300 });
  assert.equal(inView(near.position), false, 'panned away');
});

test('visibleRecordsNeedingGeometry: only on-screen, unrefined, low enough, tab visible', () => {
  const a = rec('a', 0, 0);
  const b = rec('b', 0, 0);
  const c = rec('c', 0, 0);
  c.byrditGeometryRefined = true;
  const inView = (p) => p === a.position || p === c.position;
  const view = { viewerHeightM: 10_000 };
  assert.deepEqual(visibleRecordsNeedingGeometry([a, b, c], inView, view), [a]);
  assert.deepEqual(
    visibleRecordsNeedingGeometry([a, b, c], inView, {
      viewerHeightM: CCTV_GEO_REFINE_MAX_HEIGHT_M + 1,
    }),
    [],
    'state/national zoom: no per-camera ground lookups',
  );
  assert.deepEqual(
    visibleRecordsNeedingGeometry([a], inView, { ...view, hidden: true }),
    [],
  );
});

test('frame/preview/polling gates', () => {
  assert.equal(shouldRefreshLiveFrame({ hidden: false, inView: true }), true);
  assert.equal(shouldRefreshLiveFrame({ hidden: false, inView: false }), false);
  assert.equal(shouldRefreshLiveFrame({ hidden: true, inView: true }), false);
  assert.equal(
    shouldRefreshLiveFrame({ force: true, hidden: true, inView: false }),
    true,
  );
  assert.equal(panelPreviewVisible({ hidden: false, collapsed: false }), true);
  assert.equal(panelPreviewVisible({ hidden: true, collapsed: false }), false);
  assert.equal(panelPreviewVisible({ hidden: false, collapsed: true }), false);
});

test('defineLazyFields computes once, on first read, and stays enumerable', () => {
  let calls = 0;
  const o = defineLazyFields({ id: 'x' }, { url: () => `u${++calls}` });
  assert.equal(calls, 0, 'not computed at build time');
  assert.deepEqual(Object.keys(o), ['id', 'url']);
  assert.equal(o.url, 'u1');
  assert.equal(o.url, 'u1');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(JSON.stringify(o)).url, 'u1');
  assert.deepEqual({ ...o }, { id: 'x', url: 'u1' });
});

function geometryQueueHarness({ heightM = 20_000 } = {}) {
  const viewer = fakeViewer({ heightM });
  const onScreen = rec('on', -97.7, 30.3);
  const offScreen = rec('off', -97.0, 30.0);
  const farSide = rec('farside', 80, -30);
  viewer.screens.set(onScreen.position, { x: 500, y: 300 });
  viewer.screens.set(offScreen.position, { x: 5000, y: 300 });
  viewer.screens.set(farSide.position, { x: 500, y: 300 });
  const visited = [];
  const state = {
    _viewer: viewer,
    _enabled: true,
    _records: [onScreen, offScreen, farSide],
    _geoQueue: [],
    _geoQueueTimer: 0,
  };
  const parts = {
    selection: { getActiveRecord: () => null },
    model: { haversineKm: () => 1 },
    geometry: { updateRecordGeometry: (r) => visited.push(r.camera.id) },
    presentation: { notifyListeners: () => {} },
    rendering: { refreshCoverageStyles: () => {} },
    cards: { refreshAmbientCards: () => {} },
  };
  const q = createGeometryQueue({ state, services: {}, parts, source: {} });
  return { q, state, viewer, visited, onScreen, offScreen, farSide };
}

function drain(h) {
  for (let i = 0; i < 50 && h.state._geoQueueTimer; i++) {
    clearTimeout(h.state._geoQueueTimer);
    h.q.processGeometryBatch();
  }
}

test('geometry drain grounds only on-screen cameras; panning in queues the rest once', () => {
  const h = geometryQueueHarness();
  h.q.startGeometryLoadQueue();
  assert.deepEqual(
    h.state._geoQueue.map((r) => r.camera.id),
    ['on'],
  );
  drain(h);
  assert.deepEqual(
    h.visited,
    ['on'],
    'no ground lookups for off-screen cameras',
  );

  // Pan so the second camera is on screen.
  h.viewer.screens.set(h.offScreen.position, { x: 300, y: 200 });
  h.q.enqueueVisibleGeometry();
  assert.deepEqual(
    h.state._geoQueue.map((r) => r.camera.id),
    ['off'],
  );
  drain(h);
  assert.deepEqual(h.visited, ['on', 'off'], 'each camera grounded once');
  h.q.enqueueVisibleGeometry();
  assert.equal(h.state._geoQueue.length, 0, 'no repeat work on later settles');
  assert.ok(
    !h.visited.includes('farside'),
    'far side of the globe never queued',
  );
  h.q.stopGeometryLoadQueue();
});

test('geometry drain does nothing at state/national zoom', () => {
  const h = geometryQueueHarness({ heightM: 1_600_000 });
  h.q.startGeometryLoadQueue();
  drain(h);
  assert.deepEqual(h.visited, []);
  h.q.stopGeometryLoadQueue();
});

test('geometry drain pauses while the tab is hidden', () => {
  const h = geometryQueueHarness();
  const saved = globalThis.document;
  globalThis.document = { hidden: true };
  try {
    h.state._geoQueue = [h.onScreen];
    h.q.processGeometryBatch();
    assert.deepEqual(h.visited, [], 'hidden: no work');
    assert.ok(h.state._geoQueueTimer, 'rescheduled');
    globalThis.document = { hidden: false };
    clearTimeout(h.state._geoQueueTimer);
    h.q.processGeometryBatch();
    assert.deepEqual(h.visited, ['on'], 'resumes when visible');
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
    h.q.stopGeometryLoadQueue();
  }
});

function framesHarness() {
  const viewer = fakeViewer();
  const r = rec('cam', -97.7, 30.3);
  viewer.screens.set(r.position, { x: 500, y: 300 });
  r.projection = {
    mode: 'image',
    image: {},
    imageLoading: false,
    lastImageRefreshAt: 0,
  };
  const state = { _viewer: viewer, _activeCameraId: 'cam' };
  const frames = createFrames({
    state,
    services: {},
    parts: { model: { safeNumber: (v, d) => (Number.isFinite(v) ? v : d) } },
    source: {
      getFrameUrl: () => '/api/cctv/frame/cam?x=1',
      getMediaUrl: () => '',
    },
  });
  return { frames, viewer, r };
}

test('active camera picture refreshes only while its plane is on screen', () => {
  const h = framesHarness();
  h.frames.refreshProjectionImage(h.r);
  assert.match(String(h.r.projection.image.src), /\/api\/cctv\/frame\/cam/);

  // Pan away: the next due refresh must not fetch.
  h.r.projection = {
    mode: 'image',
    image: {},
    imageLoading: false,
    lastImageRefreshAt: 0,
  };
  h.viewer.screens.set(h.r.position, { x: 9000, y: 300 });
  h.frames.refreshProjectionImage(h.r);
  assert.equal(h.r.projection.image.src, undefined, 'off screen: no fetch');

  // A forced refresh (fresh activation) still runs.
  h.frames.refreshProjectionImage(h.r, true);
  assert.match(String(h.r.projection.image.src), /\/api\/cctv\/frame\/cam/);
});

test('UI state does not build frame URLs for every catalog camera', () => {
  let urlBuilds = 0;
  const records = Array.from({ length: 500 }, (_, i) => rec(`c${i}`, -97, 30));
  const state = {
    _records: records,
    _healthById: new Map(),
    _cardIds: new Set(),
    _listeners: new Set(),
    _coverageMode: 'off',
  };
  const parts = {
    selection: { getActiveRecord: () => records[0] },
    model: {
      isNoFeedType: () => false,
      isVideoFeedType: () => false,
      sectorAreaKm2: () => 1,
      currentViewContext: () => 'city:x',
    },
    geometry: { coverageNeighborCount: () => 0 },
    calibration: {
      normalizeCalibration: () => ({}),
      deriveCalBadge: () => 'raw-prior',
    },
    frames: {
      frameUrlFor: (camera) => `/api/cctv/frame/${camera.id}?n=${++urlBuilds}`,
      mediaUrlFor: (camera) => `/api/cctv/media/${camera.id}`,
    },
  };
  const p = createPresentation({ state, services: {}, parts, source: {} });
  const ui = p.uiState();
  assert.equal(ui.cameras.length, 500);
  assert.ok(urlBuilds <= 1, `built ${urlBuilds} frame URLs for one notify`);
  assert.match(ui.activeCamera.frameUrl, /\/api\/cctv\/frame\/c0/);
  assert.match(
    ui.cameras[42].frameUrl,
    /\/api\/cctv\/frame\/c42/,
    'still readable on demand',
  );
});

test('wiring: layer polling and panel preview consult the visibility gates', () => {
  const tools = fs.readFileSync(
    new URL('../app/tools.js', import.meta.url),
    'utf8',
  );
  assert.match(tools, /dataManager\.pollingSuspended = hidden;/);
  const panel = fs.readFileSync(
    new URL('../ui/cctvPresentation.js', import.meta.url),
    'utf8',
  );
  assert.match(panel, /panelPreviewVisible\(\{/);
  const layerLifecycle = fs.readFileSync(
    new URL('../layers/cctv/lifecycle.js', import.meta.url),
    'utf8',
  );
  assert.match(
    layerLifecycle,
    /parts\.geometryQueue\.enqueueVisibleGeometry\(\)/,
  );
});

test('server upstream feeds: no demand at startup, released after the idle window', () => {
  const idle = UPSTREAM_IDLE_RELEASE_MS;
  assert.equal(
    upstreamDemandActive(0, 1_000_000, idle),
    false,
    'never asked: no connect',
  );
  assert.equal(upstreamDemandActive(1_000, 1_000 + idle, idle), true);
  assert.equal(
    upstreamDemandActive(1_000, 1_001 + idle, idle),
    false,
    'idle: release',
  );
  assert.equal(
    upstreamDemandActive(0, 5, 0),
    true,
    '0 = upstream behavior (always on)',
  );
  assert.equal(upstreamIdleReleaseMs({}), idle);
  assert.equal(upstreamIdleReleaseMs({ GEV_UPSTREAM_IDLE_RELEASE_MS: '0' }), 0);
  assert.equal(
    upstreamIdleReleaseMs({ GEV_UPSTREAM_IDLE_RELEASE_MS: '60000' }),
    60000,
  );
  assert.equal(
    upstreamIdleReleaseMs({ GEV_UPSTREAM_IDLE_RELEASE_MS: 'x' }),
    idle,
  );
  const ais = fs.readFileSync(
    new URL('../../server/providers/vessels/ais-live.js', import.meta.url),
    'utf8',
  );
  assert.match(
    ais,
    /_aisLastDemandAt = Date\.now\(\);[\s\S]*ensureAisStreamConnection\(\);/,
  );
  assert.match(
    ais,
    /if \(\s*!upstreamDemandActive\([\s\S]*?releaseIdleAisStream\(\);\s*return;/,
  );
});

test('per-pass cap keeps the nearest on-screen cameras', () => {
  const many = Array.from(
    { length: CCTV_GEO_REFINE_MAX_PER_PASS + 25 },
    (_, i) => {
      const r = rec(`m${i}`, 0, 0);
      r.d = CCTV_GEO_REFINE_MAX_PER_PASS + 25 - i; // reverse order
      return r;
    },
  );
  const picked = visibleRecordsNeedingGeometry(many, () => true, {
    viewerHeightM: 5_000,
    distanceOf: (r) => r.d,
  });
  assert.equal(picked.length, CCTV_GEO_REFINE_MAX_PER_PASS);
  assert.equal(picked[0].d, 1, 'nearest first');
});

test('panning away drops queued off-screen cameras before they are grounded', () => {
  const h = geometryQueueHarness();
  h.q.startGeometryLoadQueue();
  assert.deepEqual(
    h.state._geoQueue.map((r) => r.camera.id),
    ['on'],
  );
  h.viewer.screens.set(h.onScreen.position, { x: -5000, y: 300 }); // pan away
  h.q.enqueueVisibleGeometry();
  assert.equal(h.state._geoQueue.length, 0, 'queue pruned');
  drain(h);
  assert.deepEqual(
    h.visited,
    [],
    'no ground lookup for a camera that left the screen',
  );
  h.viewer.screens.set(h.onScreen.position, { x: 500, y: 300 }); // back in view
  h.q.enqueueVisibleGeometry();
  drain(h);
  assert.deepEqual(h.visited, ['on'], 're-queued once it is back on screen');
  h.q.stopGeometryLoadQueue();
});

test('live layers do not poll while the tab is hidden, and resume after', async () => {
  const mgr = new DataLayerManager({});
  let updates = 0;
  mgr.register({
    id: 'flights',
    name: 'Live Flights',
    icon: '',
    source: 'test',
    updateInterval: 20,
    init() {},
    enable() {},
    disable() {},
    async update() {
      updates += 1;
      return true;
    },
    getStats() {
      return { count: 1, lastUpdate: Date.now(), error: null, available: true };
    },
  });
  const entry = mgr.layers.get('flights');
  entry.initialized = true;
  entry.enabled = true;
  entry.lifecycleState = 'enabled';
  mgr.pollingSuspended = true;
  mgr._armUpdateLoop('flights', entry);
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(updates, 0, 'hidden tab: no polling');
    mgr.pollingSuspended = false;
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(updates > 0, 'visible again: polling resumes');
  } finally {
    clearInterval(entry.intervalId);
  }
});
