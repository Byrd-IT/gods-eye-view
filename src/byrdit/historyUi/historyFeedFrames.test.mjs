/**
 * B12b (owner decision D-T1 / D-B1 option A on t_2551f0be): transit and
 * bike share history frames through the REAL path
 *
 *   layer.update / proximity load -> live source -> history router
 *   -> slice adapter -> production layer, armed by the refresh driver
 *   (transit: resetForHistoryFrame per answer; bike share:
 *   reloadForHistoryFrame once per frame time and once back on live)
 *
 * using the production transit and bike share layers.
 *
 * Review R1: FIRMS through the same path with the production FIRMS layer.
 * A recorded gap must clear what the layer DRAWS (glow sprites, heat cells,
 * overlay cards, voice context), not only its count. The upstream
 * renderCurrentLod skipped the rebuild on an empty answer, so the sprites
 * and cards of the previous time stayed (one-statement touch point in
 * src/layers/firms/rendering.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTransitLayer } from '../../layers/transit/index.js';
import { createTransitSource } from '../../layers/transit/source.js';
import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import { createBikeshareSource } from '../../layers/bikeshare/source.js';
import {
  createFirmsHeatmapLayer,
  createFirmsSource,
  FIRMS_OVERLAY_SOURCE_ID,
} from '../../layers/firms/index.js';
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';
import {
  gbfsEnvelope,
  gbfsInfoStation,
  gbfsStatusStation,
} from '../history/historyRows.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';
import { createHistoryRouter } from './historyRouter.js';
import { createRefreshDriver } from './historyRefresh.js';
import { fakeDocument, fakeWindow, flush, jsonResponse } from './fakeDom.mjs';

const ORIGIN = 'https://gev.example';
const MIN = 60_000;
const HOUR = 60 * MIN;
const BOSTON = { lat: 42.3601, lon: -71.0589 };
const MADISON = GBFS_CITY_REGISTRY.find((e) => e.id === 'madison-bcycle');
/** Whole-minute history times well inside every quantum. */
const T0 = Math.floor((Date.now() - 48 * HOUR) / HOUR) * HOUR;
const T1 = T0 - 6 * HOUR;
const T2 = T0 - 12 * HOUR;
const sec = (ms) => Math.floor(ms / 1000);

/** No driver timers: the tests drive the refreshes. */
const noTimers = {
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
};

function vehicle(id, lat, lon, atMs) {
  return {
    id,
    lat,
    lon,
    bearing: null,
    speedMps: null,
    timestamp: sec(atMs),
    timestampSource: 'vehicle',
    routeId: '1',
    tripId: null,
    directionId: null,
    label: null,
    stopId: null,
    status: null,
    occupancy: null,
  };
}

function transitSnapshot(feedId, vehicles, fetchedAt) {
  return {
    feedId,
    name: feedId,
    fetchedAt,
    feedTimestamp: null,
    version: '2.0',
    entityCount: vehicles.length,
    truncated: false,
    count: vehicles.length,
    vehicles,
  };
}

function sceneViewer({ at, altitude, primitives = [] }) {
  return {
    camera: {
      changed: new Cesium.Event(),
      percentageChanged: 0.5,
      positionCartographic: {
        height: altitude,
        latitude: Cesium.Math.toRadians(at.lat),
        longitude: Cesium.Math.toRadians(at.lon),
      },
      computeViewRectangle() {
        return Cesium.Rectangle.fromDegrees(
          at.lon - 0.1,
          at.lat - 0.1,
          at.lon + 0.1,
          at.lat + 0.1,
        );
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => undefined,
      requestRenderMode: false,
      requestRender() {},
      preRender: new Cesium.Event(),
      primitives: {
        add: (p) => (primitives.push(p), p),
        remove(p) {
          const i = primitives.indexOf(p);
          if (i >= 0) primitives.splice(i, 1);
          return i >= 0;
        },
        contains: (p) => primitives.includes(p),
        raiseToTop() {},
      },
    },
  };
}

const baseServices = (sprites) => ({
  render: {
    governorRequestRender() {},
    holdContinuousRender() {},
    releaseContinuousRender() {},
  },
  sprites: {
    registerSpriteCollection: (id, c) => sprites.set(id, c),
    unregisterSpriteCollection: (id) => sprites.delete(id),
    restoreSpriteOrder() {},
  },
  picking: { registerPickOwner() {}, unregisterPickOwner() {} },
  overlays: {
    setOverlayEntries() {},
    setOverlaySourceVisible() {},
    clearOverlaySource() {},
  },
});

/**
 * Router + driver + data manager on a fake window; `slice(feed, t)` answers
 * /api/history/slice, `live(path)` every other route. globalThis.fetch goes
 * through the router (every live source calls it at call time).
 */
function historyStack(t, { slice, live, layerId, module }) {
  const asked = [];
  const fetch = async (input) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    asked.push(url.pathname + url.search);
    if (url.pathname === '/api/history/slice') {
      const q = Object.fromEntries(url.searchParams);
      return jsonResponse(slice(q.feed, Date.parse(q.t)), {
        headers: { 'X-History-Source': 'recorder' },
      });
    }
    return live(url);
  };
  const win = fakeWindow(`${ORIGIN}/`, fetch);
  const router = createHistoryRouter({
    target: win,
    adapters: ALL_HISTORY_ADAPTERS,
    budgetPerMin: 1_000,
  });
  router.install();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => win.fetch(...a);
  const dm = {
    layers: new Map([[layerId, { module }]]),
    getEnabledLayerIds: () => new Set([layerId]),
    subscribe: () => () => {},
    async refreshLayer() {
      await module.update();
      return true;
    },
  };
  const driver = createRefreshDriver({
    router,
    getDataManager: () => dm,
    timers: noTimers,
  });
  t.after(() => {
    driver.destroy();
    router.uninstall?.();
    globalThis.fetch = realFetch;
  });
  const slices = () => asked.filter((p) => p.startsWith('/api/history/slice'));
  return { router, driver, asked, slices };
}

// ── transit ───────────────────────────────────────────────

function transitHarness(t, { slice, live }) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { dataset: {} },
  });
  globalThis.window = new EventTarget();
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    const prior = globalThis[name];
    globalThis[name] ??= class {};
    t.after(() => {
      if (prior === undefined) delete globalThis[name];
    });
  }
  const sprites = new Map();
  const warm = new Map();
  const cell = (la, lo) => ({ lat: +la.toFixed(3), lon: +lo.toFixed(3) });
  const services = {
    ...baseServices(sprites),
    ground: {
      GROUND_FLOOR_LIFT_M: 1.5,
      coarseFloorCoord: cell,
      cachedGroundFloor: (la, lo) => {
        const c = cell(la, lo);
        return warm.get(`${c.lat},${c.lon}`) ?? null;
      },
      neighborFloorM: () => 10,
      warmGroundFloor(points) {
        for (const p of points) {
          const c = cell(p.lat, p.lon);
          warm.set(`${c.lat},${c.lon}`, 10);
        }
      },
    },
    mesh: { sampleMeshFloorCells() {} },
    credits: {
      registerDynamicCredit() {},
      transitFeedCredit: (feed) => ({ key: feed.id, html: feed.name }),
    },
  };
  const layer = createTransitLayer({
    services,
    source: createTransitSource(),
  });
  const viewer = sceneViewer({ at: BOSTON, altitude: 4_000 });
  layer.init(viewer);
  const stack = historyStack(t, {
    slice,
    live,
    layerId: 'transit',
    module: layer,
  });
  t.after(() => {
    try {
      layer.destroy(viewer);
    } catch {
      /* already destroyed */
    }
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return {
    ...stack,
    layer,
    viewer,
    state: () => layer._transitStateForTest(),
    parts: () => layer._transitPartsForTest(),
    fleet: () =>
      [...layer._transitStateForTest()._vehicles.values()]
        .map((e) => [e.record.id, e.to?.lat ?? null])
        .sort(),
  };
}

/** Recorded mbta fleets: positions far apart in time and space. */
const RECORDED = {
  [T1]: [
    ['bus-1', 42.2], // 18 km south of the live fix: an "impossible" jump
    ['bus-9', 42.25],
  ],
  [T2]: [['bus-1', 42.5]], // a seek further back: another jump north
};

function transitSlice(feed, t) {
  assert.equal(feed, 'transit');
  const rows = RECORDED[t];
  return {
    fetchedAt: t,
    feeds: rows
      ? [
          {
            ...transitSnapshot(
              'mbta',
              rows.map(([id, lat]) => vehicle(id, lat, -71.06, t - 15_000)),
              t,
            ),
            name: 'MBTA',
          },
        ]
      : [], // a recorded gap: the feed is absent at t
  };
}

function transitLive(url) {
  if (url.pathname === '/api/transit/vehicles/mbta') {
    const now = Date.now();
    return jsonResponse(
      transitSnapshot(
        'mbta',
        [
          vehicle('bus-1', 42.36, -71.06, now - 15_000),
          vehicle('bus-3', 42.37, -71.07, now - 15_000),
        ],
        now,
      ),
    );
  }
  return jsonResponse({ error: 'not found' }, { status: 404 });
}

test('transit frames: each history answer replaces the feed fleet (no earlier-time vehicle, no plausibility hold), a gap shows nothing, LIVE replaces it back', async (t) => {
  const app = transitHarness(t, { slice: transitSlice, live: transitLive });
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.deepEqual(app.fleet(), [
    ['bus-1', 42.36],
    ['bus-3', 42.37],
  ]);

  app.driver.onHistory({ active: true, timeMs: T1, playing: false });
  await app.layer.update();
  assert.deepEqual(
    app.fleet(),
    [
      ['bus-1', 42.2],
      ['bus-9', 42.25],
    ],
    'the recorded fleet at t, the live-only bus gone at once',
  );
  const one =
    app.state()._vehicles.get('mbta:bus-1') ??
    [...app.state()._vehicles.values()].find((e) => e.record.id === 'bus-1');
  assert.equal(one.fixes.length, 1, 'no fix of another time');

  // a seek: another impossible jump is drawn at once, not held for 2 fixes
  app.driver.onHistory({ active: true, timeMs: T2, playing: false });
  await app.layer.update();
  assert.deepEqual(app.fleet(), [['bus-1', 42.5]]);

  // the same frame asked again (paused re-poll) stays the same
  await app.layer.update();
  assert.deepEqual(app.fleet(), [['bus-1', 42.5]]);

  // a recorded gap: nothing at once (not after MISSED_POLLS_TO_DROP polls)
  app.driver.onHistory({ active: true, timeMs: T0, playing: false });
  await app.layer.update();
  assert.deepEqual(app.fleet(), [], 'gap -> nothing');

  // D2: the poll time is shown as now, the fixes keep their age at t
  app.driver.onHistory({ active: true, timeMs: T1, playing: false });
  await app.layer.update();
  const status = app.state()._feedStatus.get('mbta');
  assert.ok(Math.abs(status.lastUpdate - Date.now()) < 5_000);
  for (const e of app.state()._vehicles.values())
    assert.ok(
      Math.abs(e.fetchedAt - e.record.timestamp * 1000 - 15_000) < 1_000,
    );

  // LIVE (D4): the live fleet replaces the frame at once
  app.driver.onHistory({ active: false });
  await app.layer.update();
  assert.deepEqual(app.fleet(), [
    ['bus-1', 42.36],
    ['bus-3', 42.37],
  ]);
  assert.equal(
    app.slices().every((p) => /feed=transit/.test(p)),
    true,
  );
});

test('transit frames: the selected vehicle stays selected while it is in the frame and is released when it is not', async (t) => {
  const app = transitHarness(t, { slice: transitSlice, live: transitLive });
  app.layer.enable(app.viewer);
  app.driver.onHistory({ active: true, timeMs: T1, playing: false });
  await app.layer.update();
  const key = [...app.state()._vehicles.values()].find(
    (e) => e.record.id === 'bus-1',
  ).key;
  app.parts().selection.selectVehicle(key);
  assert.equal(app.state()._selectedKey, key);
  app.driver.onHistory({ active: true, timeMs: T2, playing: false });
  await app.layer.update();
  assert.equal(app.state()._selectedKey, key, 'still in the frame');
  assert.equal(app.state()._vehicles.get(key).to.lat, 42.5);
  app.driver.onHistory({ active: true, timeMs: T0, playing: false });
  await app.layer.update();
  assert.equal(app.state()._selectedKey, null, 'absent at t -> released');
  // the live trail of a vehicle shown from history is refused (D3)
  const trail = await globalThis.fetch(`/api/transit/trail/mbta/bus-1`);
  assert.equal(trail.status, 404);
});

test('transit seam: an unarmed snapshot keeps the upstream behaviour (2-poll eviction)', async (t) => {
  const app = transitHarness(t, { slice: transitSlice, live: transitLive });
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.fleet().length, 2);
  // the seam is armed only by resetForHistoryFrame
  app.layer.resetForHistoryFrame();
  assert.deepEqual([...app.state()._historyFrameFeeds], ['mbta']);
  await app.layer.update();
  assert.equal(app.state()._historyFrameFeeds.size, 0, 'consumed');
  assert.equal(app.fleet().length, 2, 'the same live fleet');
});

// ── bike share ────────────────────────────────────────────

const LIVE_STATIONS = ['L1', 'L2', 'L3'];
const RECORDED_STATIONS = { [T1]: ['H1', 'H2'], [T2]: ['H3'] };

function bikeSlice(feed, t) {
  assert.equal(feed, 'bikeshare');
  const ids = RECORDED_STATIONS[t];
  if (!ids) return { fetchedAt: t, systems: [] }; // a recorded gap
  const info = ids.map((id, i) =>
    gbfsInfoStation({
      station_id: id,
      name: id,
      location: { lat: MADISON.centerLat + i / 1000, lon: MADISON.centerLon },
      capacity: 10,
    }),
  );
  const status = ids.map((id) =>
    gbfsStatusStation({
      station_id: id,
      num_bikes_available: 4,
      num_docks_available: 6,
      is_installed: true,
      is_renting: true,
      is_returning: true,
      last_reported: new Date(t - MIN).toISOString(),
    }),
  );
  return {
    fetchedAt: t,
    systems: [
      {
        systemId: 'madison-bcycle',
        station_information: gbfsEnvelope(info, t),
        station_status: gbfsEnvelope(status, t),
      },
    ],
  };
}

function bikeLive(url) {
  const m = /^\/api\/gbfs\/(.+)$/.exec(url.pathname);
  const upstream = m ? decodeURIComponent(m[1]) : '';
  const now = sec(Date.now());
  if (upstream === MADISON.stationInformationUrl)
    return jsonResponse({
      last_updated: now,
      ttl: 60,
      data: {
        stations: LIVE_STATIONS.map((id, i) => ({
          station_id: id,
          name: id,
          lat: MADISON.centerLat - i / 1000,
          lon: MADISON.centerLon,
          capacity: 12,
        })),
      },
    });
  if (upstream === MADISON.stationStatusUrl)
    return jsonResponse({
      last_updated: now,
      ttl: 60,
      data: {
        stations: LIVE_STATIONS.map((id) => ({
          station_id: id,
          num_bikes_available: 1,
          num_docks_available: 11,
          is_installed: true,
          is_renting: true,
          is_returning: true,
          last_reported: now,
        })),
      },
    });
  return jsonResponse({ error: 'not found' }, { status: 404 });
}

function bikeHarness(t) {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument();
  const sprites = new Map();
  const layer = createBikeshareLayer({
    services: baseServices(sprites),
    source: createBikeshareSource(),
  });
  const viewer = sceneViewer({
    at: { lat: MADISON.centerLat, lon: MADISON.centerLon },
    altitude: 5_000,
  });
  layer.init(viewer);
  let reloads = 0;
  const module = {
    update: () => layer.update(),
    reloadForHistoryFrame() {
      reloads += 1;
      layer.reloadForHistoryFrame();
    },
  };
  const stack = historyStack(t, {
    slice: bikeSlice,
    live: bikeLive,
    layerId: 'bikeshare',
    module,
  });
  t.after(() => {
    try {
      layer.destroy(viewer);
    } catch {
      /* already destroyed */
    }
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const points = () => {
    const c = sprites.get('bikeshare');
    const ids = [];
    for (let i = 0; i < c.length; i++) ids.push(c.get(i).id);
    return ids.sort();
  };
  return { ...stack, layer, viewer, points, reloads: () => reloads };
}

const key = (id) => `madison-bcycle:${id}`;

test('bike share frames: station information is reloaded once per frame time (recorded stations only), a gap shows nothing, LIVE reloads live stations', async (t) => {
  const app = bikeHarness(t);
  app.layer.enable(app.viewer);
  await flush();
  assert.deepEqual(app.points(), LIVE_STATIONS.map(key));

  // entering history: the driver's refresh asks status; the frame reloads
  app.driver.onHistory({ active: true, timeMs: T1, playing: false });
  await app.driver.refreshTargets(); // a released seek
  await flush();
  assert.deepEqual(
    app.points(),
    ['H1', 'H2'].map(key),
    'stations recorded at t, none of today',
  );
  assert.equal(app.reloads(), 1, 'one reload for the frame time');
  // the layer's own status poll at the same t does not reload again
  await app.layer.update();
  await flush();
  assert.equal(app.reloads(), 1);
  assert.deepEqual(app.points(), ['H1', 'H2'].map(key));

  app.driver.onHistory({ active: true, timeMs: T2, playing: false });
  await app.driver.refreshTargets(); // a released seek
  await flush();
  assert.deepEqual(app.points(), [key('H3')], 'a seek: that time only');
  assert.equal(app.reloads(), 2);

  // a recorded gap: nothing (not the cached stations of another time)
  app.driver.onHistory({ active: true, timeMs: T0, playing: false });
  await app.driver.refreshTargets(); // a released seek
  await flush();
  assert.deepEqual(app.points(), [], 'gap -> nothing');
  assert.equal(app.reloads(), 3);

  // D4: back to LIVE, no history station information survives
  app.driver.onHistory({ active: true, timeMs: T1, playing: false });
  await app.driver.refreshTargets(); // a released seek
  await flush();
  assert.deepEqual(app.points(), ['H1', 'H2'].map(key));
  const before = app.slices().length;
  app.driver.onHistory({ active: false });
  await flush();
  assert.deepEqual(app.points(), LIVE_STATIONS.map(key));
  assert.equal(app.slices().length, before, 'no slice after LIVE');
  // every recorded answer used the server default window (no window param)
  for (const p of app.slices()) {
    const q = new URL(p, ORIGIN).searchParams;
    assert.deepEqual([...q.keys()].sort(), ['feed', 't']);
  }
});

test('bike share seam: reloadForHistoryFrame on a disabled layer drops the caches only', async (t) => {
  const app = bikeHarness(t);
  app.layer.enable(app.viewer);
  await flush();
  assert.equal(app.points().length, 3);
  app.layer.disable(app.viewer);
  const asked = app.asked.length;
  app.layer.reloadForHistoryFrame();
  await flush();
  assert.equal(app.asked.length, asked, 'nothing asked while disabled');
  // enabled again: station information is asked again (cache dropped)
  app.layer.enable(app.viewer);
  await flush();
  assert.ok(
    app.asked
      .slice(asked)
      .some((p) =>
        p.includes(encodeURIComponent(MADISON.stationInformationUrl)),
      ),
  );
  assert.equal(app.points().length, 3);
});

// ── FIRMS (review R1: a gap must clear what is DRAWN, not only the count) ──

const AUSTIN = { lat: 30.2672, lon: -97.7431 };

/** A recorded FIRMS row (the live /api/firms row keys, B9 firmsRow). */
function fireRow(i, atMs) {
  const iso = new Date(atMs - i * HOUR).toISOString();
  return {
    lat: AUSTIN.lat + 0.02 * i,
    lon: AUSTIN.lon + 0.03 * i,
    frp: 10 + i * 6,
    confidence: 'n',
    brightness: 330 + i,
    brightnessTi5: 290,
    daynight: 'D',
    acqDate: iso.slice(0, 10),
    acqTime: iso.slice(11, 16).replace(':', ''),
    satellite: 'N21',
    instrument: 'VIIRS',
  };
}

const RECORDED_FIRES = { [T1]: 3, [T2]: 2 };

function firmsSlice(feed, t) {
  assert.equal(feed, 'firms');
  const n = RECORDED_FIRES[t] ?? 0; // T0: a recorded gap (no row)
  const fires = Array.from({ length: n }, (_, i) => fireRow(i, t));
  return {
    fetchedAt: t,
    stale: false,
    ttlMs: 1_800_000,
    sources: n ? [{ source: 'VIIRS_NOAA21_NRT', count: n, ok: true }] : [],
    count: n,
    fires,
  };
}

function firmsLive(url) {
  if (url.pathname === '/api/firms') {
    const now = Date.now();
    return jsonResponse({
      fetchedAt: now,
      stale: false,
      fires: [0, 1, 2, 3].map((i) => ({
        ...fireRow(i, now),
        lat: AUSTIN.lat - 0.02 * (i + 1),
      })),
    });
  }
  return jsonResponse({ error: 'not found' }, { status: 404 });
}

/**
 * The production FIRMS layer (createFirmsHeatmapLayer) on a fake viewer,
 * with a recording overlay host: what it would PAINT is the overlay source
 * entries, the billboard sprites (detection bands) and the heat-cell
 * entities (cell bands), plus the voice context registrations.
 */
function firmsHarness(t, { altitude }) {
  const originalDocument = globalThis.document;
  // glowSprite draws on a 2-D canvas; no canvas in node -> an empty image
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  const originalProject = Cesium.SceneTransforms.worldToWindowCoordinates;
  // a flat projection keeps every in-view fire (or cell) on screen and apart
  const pxPerDeg = altitude < 1_000_000 ? 4000 : 200;
  Cesium.SceneTransforms.worldToWindowCoordinates = (_scene, position) => {
    const c = Cesium.Cartographic.fromCartesian(position);
    return new Cesium.Cartesian2(
      700 + (Cesium.Math.toDegrees(c.longitude) - AUSTIN.lon) * pxPerDeg,
      450 - (Cesium.Math.toDegrees(c.latitude) - AUSTIN.lat) * pxPerDeg,
    );
  };
  const primitives = [];
  const viewer = sceneViewer({ at: AUSTIN, altitude, primitives });
  viewer.camera.moveEnd = new Cesium.Event();
  // the real BillboardCollection reads the scene mode when a sprite is added
  viewer.scene.frameState = { mode: Cesium.SceneMode.SCENE3D };
  viewer.scene.canvas = {
    clientWidth: 1400,
    clientHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  };
  const dataSources = [];
  viewer.dataSources = {
    add: (d) => (dataSources.push(d), d),
    remove(d) {
      const i = dataSources.indexOf(d);
      if (i >= 0) dataSources.splice(i, 1);
      return i >= 0;
    },
  };
  const overlay = new Map();
  const overlayHost = {
    setEntries: (sourceId, entries) => overlay.set(sourceId, entries),
    setVisible() {},
    clearSource: (sourceId) => overlay.set(sourceId, []),
    hitTest: () => null,
  };
  const store = { entities: new Map() };
  const sprites = new Map();
  const layer = createFirmsHeatmapLayer({
    id: 'local-firms',
    name: 'Fires',
    feed: createFirmsSource(),
    overlayHost,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      removeInputAction() {},
      destroy() {},
    }),
    services: {
      ...baseServices(sprites),
      sprites: {
        registerSpriteCollection: (id, c) => sprites.set(id, c),
        restoreSpriteOrder() {},
        restoreSpriteOrderOnEnable() {},
      },
      context: {
        selectEntityContext() {},
        clearSelectedEntityContextForLayer() {},
        getContextStore: () => store,
        registerEntityContext: (_entity, record) =>
          store.entities.set(record.id, record),
      },
      picking: {
        registerPickOwner() {},
        unregisterPickOwner() {},
        resolvePickId: () => null,
        isOwnedByOtherLayer: () => false,
      },
      focus: { requestWorldFocus() {} },
      anchors: {
        fireAnchorHeight: () => 0,
        warmFireAnchorFloors: async () => false,
      },
    },
  });
  layer.init(viewer);
  const stack = historyStack(t, {
    slice: firmsSlice,
    live: firmsLive,
    layerId: 'local-firms',
    module: layer,
  });
  t.after(() => {
    try {
      layer.destroy(viewer);
    } catch {
      /* already destroyed */
    }
    Cesium.SceneTransforms.worldToWindowCoordinates = originalProject;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const billboards = () => sprites.get('firms');
  return {
    ...stack,
    layer,
    viewer,
    /** what the layer draws right now, beyond its count */
    drawn: () => ({
      count: layer.getStats().count,
      cards: (overlay.get(FIRMS_OVERLAY_SOURCE_ID) ?? []).length,
      sprites: billboards()?.length ?? 0,
      cells: dataSources[0]?.entities.values.length ?? 0,
      context: store.entities.size,
    }),
  };
}

for (const [band, altitude, drawnAt] of [
  // close band: glow sprites + ambient cards (the review R1 screenshot)
  ['detections', 20_000, (n) => ({ sprites: n, cells: 0 })],
  // regional band: heat-cell rectangles + cell cards
  ['cells', 4_000_000, () => ({ sprites: 0 })],
]) {
  test(`FIRMS frames (${band} band): a recorded gap clears the drawn sprites, cells, cards and context, not only the count; LIVE draws the live fires again`, async (t) => {
    const app = firmsHarness(t, { altitude });
    await app.layer.enable(app.viewer);
    let d = app.drawn();
    assert.equal(d.count, 4, 'live fires');
    assert.ok(d.cards > 0, 'live cards');

    app.driver.onHistory({ active: true, timeMs: T1, playing: false });
    await app.layer.update();
    d = app.drawn();
    assert.equal(d.count, RECORDED_FIRES[T1]);
    assert.ok(d.cards > 0, 'cards of the recorded fires at t');
    assert.ok(d.context > 0, 'context registrations at t');
    for (const [k, v] of Object.entries(drawnAt(RECORDED_FIRES[T1])))
      assert.equal(d[k], v);
    if (band === 'cells') assert.ok(d.cells > 0, 'heat cells at t');

    // the recorded gap (D3): NOTHING drawn, not the sprites/cards of T1
    app.driver.onHistory({ active: true, timeMs: T0, playing: false });
    await app.layer.update();
    assert.deepEqual(app.drawn(), {
      count: 0,
      cards: 0,
      sprites: 0,
      cells: 0,
      context: 0,
    });
    // a camera move in the gap must not bring the old cards back
    app.viewer.camera.moveEnd.raiseEvent();
    assert.equal(app.drawn().cards, 0, 'no stale card after moveEnd');

    // a frame with fires again draws them
    app.driver.onHistory({ active: true, timeMs: T2, playing: false });
    await app.layer.update();
    assert.equal(app.drawn().count, RECORDED_FIRES[T2]);
    assert.ok(app.drawn().cards > 0);

    // LIVE (D4): the driver refreshes the layer once
    app.driver.onHistory({ active: false });
    for (let i = 0; i < 50 && app.drawn().count !== 4; i++) await flush();
    d = app.drawn();
    assert.equal(d.count, 4);
    assert.ok(d.cards > 0);
    assert.ok(
      app.slices().length > 0 &&
        app.slices().every((p) => /feed=firms/.test(p)),
    );
  });
}
