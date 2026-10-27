/**
 * B12a round 3 (review R1 / R3, owner decision option A on t_884fea7d):
 * history frames through the REAL path
 *
 *   refresh driver -> layer.update -> live source parser -> history router
 *   -> slice adapter -> layer snapshot renderer / records (with the
 *   resetForHistoryFrame + setMotionClock seams)
 *
 * using the production flights, military and vessels layers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
} from '../../data/flights.js';
import militaryLayer, {
  _setTrackedMilitaryRefreshStateForTest,
} from '../../data/militaryFlights.js';
import vesselsLayer, {
  _getVesselStateForTest,
  _setVesselStateForTest,
  _reconcileVesselsForTest,
} from '../../data/aisLiveVessels.js';
import { createHistoryRouter } from './historyRouter.js';
import { createRefreshDriver } from './historyRefresh.js';
import { fakeDocument, fakeWindow, jsonResponse } from './fakeDom.mjs';

// vessel selection teardown touches the document (no jsdom here)
globalThis.document ??= fakeDocument();

const ORIGIN = 'https://gev.example';
const HOUR = 3_600_000;
const sec = (ms) => Math.round(ms / 1000);

/** OpenSky state vector (the B9 aircraft slice row shape). */
function osState(icao24, { lon, lat, ageS = 5, t, velocity = 0, track = 90 }) {
  const fix = sec(t) - ageS;
  return [
    icao24,
    `${icao24.toUpperCase()} `,
    'United States',
    fix,
    fix,
    lon,
    lat,
    10_668,
    false,
    velocity,
    track,
    0,
    null,
    10_700,
    null,
    false,
    0,
    5,
  ];
}

/**
 * The whole stack on a fake window: `frames(feed, t)` returns the rows of a
 * slice at t; every other route answers `live(path)`.
 */
function stack({ frames, live = () => ({}), enabled = ['flights'] }) {
  const calls = [];
  const fetch = async (input) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/history/slice') {
      const q = Object.fromEntries(url.searchParams);
      const t = Date.parse(q.t);
      const rows = frames(q.feed, t);
      if (q.feed === 'military')
        return jsonResponse(
          { ac: rows, now: t, msg: 'No error' },
          { headers: { 'X-History-Source': 'adsb.lol' } },
        );
      return jsonResponse(
        { time: sec(t), states: rows },
        {
          headers: {
            'X-History-Source': 'opensky',
            'X-History-Rows': String(rows.length),
          },
        },
      );
    }
    return jsonResponse(live(url.pathname), {
      headers: { 'X-Feed-Source': 'live' },
    });
  };
  const win = fakeWindow(`${ORIGIN}/`, fetch);
  const router = createHistoryRouter({ target: win });
  router.install();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => win.fetch(...a);
  const viewer = {
    camera: { positionCartographic: null },
    scene: {},
    entities: { add: (e) => e, remove() {}, removeById() {} },
    trackedEntity: null,
  };
  const modules = { flights: flightsLayer, military: militaryLayer };
  const dm = {
    layers: new Map(
      Object.entries(modules).map(([id, module]) => [id, { module }]),
    ),
    getEnabledLayerIds: () => new Set(enabled),
    subscribe: () => () => {},
    async refreshLayer(id) {
      await modules[id].update(viewer);
      return true;
    },
  };
  const driver = createRefreshDriver({
    router,
    getDataManager: () => dm,
    releaseDebounceMs: 0,
    playPollMs: 3_600_000, // no playback ticks: the tests drive frames
  });
  return {
    router,
    driver,
    viewer,
    calls,
    /** Enter / move history at t (paused) and apply the frame once. */
    async seek(t, extra = {}) {
      driver.onHistory({ active: true, timeMs: t, playing: false, ...extra });
      await new Promise((r) => setTimeout(r, 5)); // the (0 ms) release
      await driver.settle();
    },
    cleanup() {
      driver.destroy();
      router.destroy();
      globalThis.fetch = realFetch;
    },
  };
}

function billboardCollection() {
  const added = [];
  return {
    added,
    show: true,
    add(options) {
      const b = { ...options };
      added.push(b);
      return b;
    },
    remove() {},
  };
}

const lonOf = (described) => described?.longitude;

test('flights R1+R3: each frame replaces the other time (same icao forward/back, increasing age, gap, LIVE)', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const T1 = T0 + 2 * HOUR; // forward
  const T2 = T0 - 3 * HOUR; // backward
  const GAP = T0 + 5 * HOUR;
  const frames = (feed, t) => {
    if (feed !== 'aircraft') return [];
    if (t === T0)
      return [
        osState('a00001', { lon: -97, lat: 30, ageS: 5, t }),
        osState('b00002', { lon: -96, lat: 31, ageS: 5, t }),
      ];
    // the same aircraft elsewhere with an OLDER fix (rebased epoch goes
    // backwards: the live append predicate would reject it)
    if (t === T1)
      return [osState('a00001', { lon: -90, lat: 35, ageS: 120, t })];
    if (t === T2)
      return [osState('a00001', { lon: -80, lat: 40, ageS: 60, t })];
    return []; // GAP: recorded gap / empty slice
  };
  const live = (path) =>
    path === '/api/flights'
      ? {
          time: sec(Date.now()),
          states: [
            osState('c00003', { lon: -70, lat: 20, ageS: 2, t: Date.now() }),
          ],
        }
      : { ac: [] };
  const s = stack({ frames, live });
  const bbs = billboardCollection();
  _setTrackedFlightRefreshStateForTest({
    icao24: 'seed00',
    entity: null,
    billboard: { show: false, position: Cesium.Cartesian3.fromDegrees(0, 0) },
    billboardCollection: bbs,
    viewer: s.viewer,
    meta: { rawLat: 0, rawLon: 0, onGround: false },
    tracked: false,
  });
  try {
    await s.seek(T0);
    assert.ok(!flightsLayer.hasContact('seed00'), 'other-time seed gone');
    assert.equal(flightsLayer.hasContact('a00001'), true);
    assert.equal(flightsLayer.hasContact('b00002'), true);
    assert.ok(Math.abs(lonOf(flightsLayer.findByQuery('a00001')) + 97) < 0.01);

    await s.seek(T1);
    assert.ok(!flightsLayer.hasContact('b00002'), 'absent = gone at once');
    assert.ok(
      Math.abs(lonOf(flightsLayer.findByQuery('a00001')) + 90) < 0.01,
      `forward seek, older fix: ${lonOf(flightsLayer.findByQuery('a00001'))}`,
    );

    await s.seek(T2);
    assert.ok(
      Math.abs(lonOf(flightsLayer.findByQuery('a00001')) + 80) < 0.01,
      `backward seek: ${lonOf(flightsLayer.findByQuery('a00001'))}`,
    );

    await s.seek(GAP);
    assert.ok(!flightsLayer.hasContact('a00001'), 'gap draws nothing');
    assert.equal(flightsLayer.getStats().count, 0);

    await s.seek(T1);
    s.driver.onHistory({ active: false, timeMs: null });
    await s.driver.settle();
    assert.ok(!flightsLayer.hasContact('a00001'), 'LIVE: no history');
    assert.equal(flightsLayer.hasContact('c00003'), true, 'LIVE data at once');
  } finally {
    s.cleanup();
  }
});

test('flights R1: a TRACKED aircraft absent from the frame is released and removed at once', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const frames = (feed, t) =>
    feed === 'aircraft' ? [osState('a00001', { lon: -97, lat: 30, t })] : [];
  const s = stack({ frames });
  const entity = { gevLabelModel: { title: 'OLD', details: [] } };
  _setTrackedFlightRefreshStateForTest({
    icao24: 'f00ba4',
    entity,
    billboard: {
      show: false,
      position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 9_000),
      color: Cesium.Color.WHITE,
    },
    billboardCollection: billboardCollection(),
    viewer: s.viewer,
    meta: { callsign: 'OLD1', rawLat: 30.2, rawLon: -97.7, onGround: false },
  });
  try {
    assert.equal(flightsLayer.getTrackedInfo()?.icao24, 'f00ba4');
    await s.seek(T0);
    assert.equal(flightsLayer.getTrackedInfo(), null, 'tracking released');
    assert.ok(!flightsLayer.hasContact('f00ba4'));
    assert.equal(flightsLayer.hasContact('a00001'), true);
  } finally {
    s.cleanup();
  }
});

test('flights R3 paused: the history motion clock freezes dead reckoning; playing it runs at rate x wall', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const frames = (feed, t) =>
    feed === 'aircraft'
      ? [osState('a00001', { lon: -97, lat: 30, ageS: 10, t, velocity: 250 })]
      : [];
  const s = stack({ frames });
  _setTrackedFlightRefreshStateForTest({
    icao24: 'seed00',
    entity: null,
    billboard: { show: false, position: Cesium.Cartesian3.fromDegrees(0, 0) },
    billboardCollection: billboardCollection(),
    viewer: s.viewer,
    meta: { rawLat: 0, rawLon: 0, onGround: false },
    tracked: false,
  });
  try {
    await s.seek(T0);
    const a = lonOf(flightsLayer.findByQuery('a00001'));
    await new Promise((r) => setTimeout(r, 400));
    const b = lonOf(flightsLayer.findByQuery('a00001'));
    // 400 ms on the wall clock would coast 100 m at 250 m/s
    const coastM = Math.abs(b - a) * 111_320 * Math.cos((30 * Math.PI) / 180);
    assert.ok(coastM < 2, `paused at t: no coasting (${coastM.toFixed(2)} m)`);
    // a re-poll of the same paused time is a new frame at the same place
    await s.driver.refreshTargets();
    await s.driver.settle();
    const again = lonOf(flightsLayer.findByQuery('a00001'));
    const hopM = Math.abs(again - b) * 111_320 * Math.cos((30 * Math.PI) / 180);
    assert.ok(hopM < 2, `re-polled frame hops ${hopM.toFixed(2)} m`);
    // play at 60x without a new frame: 400 ms wall = 24 s of history, about
    // 6 km east at 250 m/s (inside the layer's own coast limit)
    s.driver.onHistory({ active: true, timeMs: T0, playing: true, rate: 60 });
    await new Promise((r) => setTimeout(r, 400));
    const c = lonOf(flightsLayer.findByQuery('a00001'));
    const movedKm = (c - again) * 111.32 * Math.cos((30 * Math.PI) / 180);
    assert.ok(movedKm > 4 && movedKm < 9, `moved ${movedKm.toFixed(2)} km`);
  } finally {
    s.cleanup();
  }
});

test('military R1+R3: same hex moved by a frame of another time; a gap removes it at once', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const T1 = T0 + HOUR;
  const row = (lon, lat, seen) => ({
    hex: 'ae0001',
    flight: 'RCH001 ',
    lat,
    lon,
    seen_pos: seen,
    seen,
    alt_baro: 20_000,
    gs: 0,
    track: 90,
    t: 'C17',
  });
  const frames = (feed, t) =>
    feed !== 'military'
      ? []
      : t === T0
        ? [row(-100, 35, 3)]
        : t === T1
          ? [row(-110, 36, 165)]
          : [];
  const s = stack({ frames, enabled: ['military'] });
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'seed01',
    entity: null,
    billboard: { show: false, position: Cesium.Cartesian3.fromDegrees(0, 0) },
    billboardCollection: billboardCollection(),
    viewer: s.viewer,
    meta: { rawLat: 0, rawLon: 0, onGround: false },
    tracked: false,
  });
  try {
    await s.seek(T0);
    assert.ok(
      Math.abs(lonOf(militaryLayer.findByQuery('ae0001')) + 100) < 0.01,
    );
    await s.seek(T1);
    assert.ok(
      Math.abs(lonOf(militaryLayer.findByQuery('ae0001')) + 110) < 0.01,
      `older fix at another place: ${lonOf(militaryLayer.findByQuery('ae0001'))}`,
    );
    await s.seek(T1 + HOUR);
    assert.equal(
      militaryLayer.findByQuery('ae0001'),
      null,
      'gap: gone at once',
    );
  } finally {
    s.cleanup();
  }
});

test('vessels R1: a SELECTED vessel absent from a history frame is removed at once (live keeps its pin)', () => {
  const vessel = (mmsi) => ({
    name: `V${mmsi}`,
    mmsi,
    lat: 51.93,
    lon: 4.05,
    type: 'Cargo',
    destination: '',
    speed: 10,
    course: 90,
    heading: 90,
    lastPositionUtc: '',
    missedRefreshes: 0,
    position: Cesium.Cartesian3.fromDegrees(4.05, 51.93, 3),
    billboard: null,
  });
  try {
    // live: an empty complete answer keeps the selected vessel pinned (STALE)
    const live = vessel('111111111');
    _setVesselStateForTest({ records: [live], selectedRecord: live });
    _reconcileVesselsForTest({}, []);
    assert.equal(_getVesselStateForTest().vesselCount, 1, 'live pin kept');
    assert.equal(vesselsLayer.getSelectedInfo()?.mmsi, '111111111');

    // history frame: the same situation removes it and its selection
    const sel = vessel('222222222');
    _setVesselStateForTest({ records: [sel], selectedRecord: sel });
    vesselsLayer.resetForHistoryFrame();
    _reconcileVesselsForTest({}, []);
    assert.equal(_getVesselStateForTest().vesselCount, 0, 'not pinned at t');
    assert.equal(vesselsLayer.getSelectedInfo(), null, 'selection released');

    // the frame is one-shot: the next (live) answer pins again
    const again = vessel('333333333');
    _setVesselStateForTest({ records: [again], selectedRecord: again });
    _reconcileVesselsForTest({}, []);
    assert.equal(_getVesselStateForTest().vesselCount, 1);
  } finally {
    _setVesselStateForTest({ enabled: false });
  }
});

test('vessels R1: a selected vessel PRESENT in the frame stays selected; its trail starts over at t', () => {
  const sel = {
    name: 'KEEP',
    mmsi: '444444444',
    lat: 51.93,
    lon: 4.05,
    type: 'Cargo',
    destination: '',
    speed: 10,
    course: 90,
    heading: 90,
    lastPositionUtc: '',
    missedRefreshes: 0,
    position: Cesium.Cartesian3.fromDegrees(4.05, 51.93, 3),
    billboard: null,
  };
  const trail = {
    clears: 0,
    clear() {
      this.clears++;
    },
    setPositions() {},
    destroy() {},
  };
  try {
    _setVesselStateForTest({
      records: [sel],
      selectedRecord: sel,
      trail,
      trailMmsi: sel.mmsi,
      trailPositions: [sel.position, sel.position],
    });
    vesselsLayer.resetForHistoryFrame();
    _reconcileVesselsForTest({}, [
      { mmsi: sel.mmsi, name: 'KEEP', lat: 10, lon: 20, speed: 3 },
    ]);
    assert.equal(vesselsLayer.getSelectedInfo()?.mmsi, sel.mmsi);
    assert.equal(vesselsLayer.getSelectedInfo()?.latitude, 10);
    assert.equal(trail.clears, 1, 'no trail across times');
    assert.ok(_getVesselStateForTest().trailPositionCount <= 1);
  } finally {
    _setVesselStateForTest({ enabled: false });
  }
});
