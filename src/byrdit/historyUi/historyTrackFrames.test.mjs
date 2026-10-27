/**
 * B12e through the REAL path with the production flights and military
 * layers:
 *
 *   refresh driver -> layer.update -> history frame (router slice) ->
 *   snapshot renderer: a TRACKED aircraft in a history frame restarts its
 *   trail (the one-line seam in src/layers/{flights,military}/
 *   snapshotRenderer.js) -> tracking._startTrail -> source.getTrack ->
 *   router -> /api/history/track [t-6h, t] -> the trail polyline
 *
 * so the selected aircraft's recorded track follows t; nothing is asked
 * when nothing is tracked.
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
import { createHistoryRouter } from './historyRouter.js';
import { createRefreshDriver } from './historyRefresh.js';
import { fakeDocument, fakeWindow, jsonResponse } from './fakeDom.mjs';

globalThis.document ??= fakeDocument();

const ORIGIN = 'https://gev.example';
const MIN = 60_000;
const HOUR = 60 * MIN;
const sec = (ms) => Math.round(ms / 1000);

function osState(icao24, { lon, lat, t }) {
  const fix = sec(t) - 5;
  return [
    icao24,
    'HIST1 ',
    'United States',
    fix,
    fix,
    lon,
    lat,
    10_668,
    false,
    0,
    90,
    0,
    null,
    10_700,
    null,
    false,
    0,
    5,
  ];
}

/** A B10 track answer ending 2 min before `to` (two sources, one gap). */
function b10Body(id, to) {
  const at = (minBefore) => sec(to) - minBefore * 60;
  return {
    feed: 'aircraft',
    id,
    icao24: id,
    callsign: null,
    path: [
      [at(300), 29.0, -97, 3000, 0, false, 'adsblol'],
      [at(290), 29.1, -97, 3000, 0, false, 'adsblol'],
      [at(120), 29.6, -97, 3000, 0, false, 'opensky'],
      [at(2), 29.9, -97, 3000, 0, false, 'opensky'],
    ],
    sources: ['adsblol', 'opensky'],
  };
}

function stack({ frames, trackFor = b10Body }) {
  const calls = [];
  const fetch = async (input) => {
    const url = new URL(String(input?.url ?? input), ORIGIN);
    calls.push(url.pathname + url.search);
    const q = Object.fromEntries(url.searchParams);
    if (url.pathname === '/api/history/slice') {
      const t = Date.parse(q.t);
      const rows = frames(q.feed, t);
      if (q.feed === 'military')
        return jsonResponse(
          { ac: rows, now: t, msg: 'No error' },
          { headers: { 'X-History-Source': 'adsb.lol' } },
        );
      return jsonResponse(
        { time: sec(t), states: rows },
        { headers: { 'X-History-Source': 'opensky' } },
      );
    }
    if (url.pathname === '/api/history/track')
      return jsonResponse(trackFor(q.id, Date.parse(q.to)), {
        headers: {
          'X-History-Source': 'adsblol,opensky',
          'X-History-Rows': '4',
        },
      });
    return jsonResponse({}, { status: 404 });
  };
  const win = fakeWindow(`${ORIGIN}/`, fetch);
  const router = createHistoryRouter({ target: win });
  router.install();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => win.fetch(...a);
  const added = [];
  const viewer = {
    camera: { positionCartographic: null, cancelFlight() {} },
    scene: { requestRender() {} },
    entities: {
      add: (e) => {
        added.push(e);
        return e;
      },
      remove() {},
      removeById() {},
      contains: () => true,
    },
    trackedEntity: null,
    isDestroyed: () => false,
  };
  const modules = { flights: flightsLayer, military: militaryLayer };
  const dm = {
    layers: new Map(
      Object.entries(modules).map(([id, module]) => [id, { module }]),
    ),
    getEnabledLayerIds: () => new Set(['flights', 'military']),
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
    playPollMs: 3_600_000,
  });
  /** The trail body polyline (not the head segment) of the layer. */
  const trailPositions = (prefix) => {
    const trails = added.filter(
      (e) =>
        typeof e?.id === 'string' &&
        e.id.startsWith('gev-trail:') &&
        !e.id.startsWith(prefix),
    );
    return trails.map((e) => e.polyline.positions.getValue());
  };
  return {
    router,
    driver,
    viewer,
    calls,
    trailPositions,
    trackCalls: () =>
      calls
        .filter((c) => c.startsWith('/api/history/track'))
        .map((c) => Object.fromEntries(new URL(c, ORIGIN).searchParams)),
    async seek(t) {
      driver.onHistory({ active: true, timeMs: t, playing: false });
      await new Promise((r) => setTimeout(r, 5));
      await driver.settle();
    },
    cleanup() {
      driver.destroy();
      router.destroy();
      globalThis.fetch = realFetch;
    },
  };
}

/** The backfill is fire-and-forget (geoid import + bounded floor lookup). */
async function until(pred, ms = 4_000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 20));
  return pred();
}

function billboardCollection() {
  return {
    show: true,
    add: (o) => ({ ...o }),
    remove() {},
  };
}

test('flights B12e: the TRACKED aircraft asks its recorded track [t-6h, t] on each history frame; the trail is drawn from it and follows t', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const T1 = T0 + 30 * MIN;
  const frames = (feed, t) =>
    feed === 'aircraft' ? [osState('a00001', { lon: -97, lat: 30, t })] : [];
  const s = stack({ frames });
  _setTrackedFlightRefreshStateForTest({
    icao24: 'a00001',
    entity: { gevLabelModel: { title: 'OLD', details: [] } },
    billboard: {
      show: false,
      position: Cesium.Cartesian3.fromDegrees(-97, 30, 10_000),
      color: Cesium.Color.WHITE,
    },
    billboardCollection: billboardCollection(),
    viewer: s.viewer,
    meta: { callsign: 'HIST1', rawLat: 30, rawLon: -97, onGround: false },
  });
  try {
    await s.seek(T0);
    assert.equal(flightsLayer.getTrackedInfo()?.icao24, 'a00001');
    assert.ok(await until(() => s.trackCalls().length === 1));
    assert.deepEqual(s.trackCalls()[0], {
      feed: 'aircraft',
      id: 'a00001',
      from: new Date(T0 - 6 * HOUR).toISOString(),
      to: new Date(T0).toISOString(),
      minGapSec: '60',
    });
    // the 4 recorded points are spliced in behind the icon; the trail body
    // draws all but the newest (the head segment runs from there to the
    // icon), exactly as live
    assert.ok(
      await until(() =>
        s.trailPositions('gev-trail:fl-head').some((p) => p.length === 3),
      ),
      `trail ${JSON.stringify(s.trailPositions('gev-trail:fl-head').map((p) => p.length))}`,
    );
    const body = s
      .trailPositions('gev-trail:fl-head')
      .find((p) => p.length === 3);
    const first = Cesium.Cartographic.fromCartesian(body[0]);
    assert.ok(Math.abs(Cesium.Math.toDegrees(first.latitude) - 29.0) < 1e-6);
    assert.equal(s.router.getState().track.id, 'a00001');
    assert.deepEqual(s.router.getState().track.sources, [
      'adsb.lol',
      'OpenSky',
    ]);
    assert.equal(
      s.router.getState().track.gaps.length,
      2,
      '290->120 and 120->2 min',
    );

    // t moves: the selected aircraft's track is asked again for the new t
    await s.seek(T1);
    assert.ok(await until(() => s.trackCalls().length === 2));
    assert.equal(s.trackCalls()[1].to, new Date(T1).toISOString());
    assert.equal(s.trackCalls()[1].from, new Date(T1 - 6 * HOUR).toISOString());
    assert.ok(
      !s.calls.some((c) => c.startsWith('/api/flights/track')),
      'never the live track',
    );
  } finally {
    s.cleanup();
  }
});

test('flights B12e: nothing tracked -> no track request on history frames (no prefetch, no polling)', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const frames = (feed, t) =>
    feed === 'aircraft' ? [osState('a00001', { lon: -97, lat: 30, t })] : [];
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
    await s.seek(T0 + 10 * MIN);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(flightsLayer.hasContact('a00001'), true);
    assert.equal(s.trackCalls().length, 0);
  } finally {
    s.cleanup();
  }
});

test('military B12e: the TRACKED military aircraft asks feed=military [t-6h, t] on each frame', async () => {
  const T0 = Date.parse('2026-10-13T12:00:00Z');
  const milRow = (t) => ({
    hex: 'ae1000',
    flight: 'HMIL1',
    t: 'C17',
    dbFlags: 1,
    alt_baro: 22000,
    gs: 380,
    track: 90,
    lat: 30,
    lon: -97,
    seen: 1,
    seen_pos: 2,
  });
  const frames = (feed, t) => (feed === 'military' ? [milRow(t)] : []);
  const s = stack({ frames });
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'ae1000',
    entity: { gevLabelModel: { title: 'OLD', details: [] } },
    billboard: {
      show: false,
      position: Cesium.Cartesian3.fromDegrees(-97, 30, 7_000),
      color: Cesium.Color.WHITE,
    },
    billboardCollection: billboardCollection(),
    viewer: s.viewer,
    meta: { callsign: 'HMIL1', rawLat: 30, rawLon: -97, onGround: false },
  });
  try {
    await s.seek(T0);
    assert.ok(await until(() => s.trackCalls().length === 1));
    assert.equal(s.trackCalls()[0].feed, 'military');
    assert.equal(s.trackCalls()[0].id, 'ae1000');
    assert.equal(s.trackCalls()[0].to, new Date(T0).toISOString());
    await s.seek(T0 + 20 * MIN);
    assert.ok(await until(() => s.trackCalls().length === 2));
    assert.equal(s.trackCalls()[1].to, new Date(T0 + 20 * MIN).toISOString());
    assert.ok(!s.calls.some((c) => c.startsWith('/api/military/track')));
  } finally {
    s.cleanup();
  }
});
