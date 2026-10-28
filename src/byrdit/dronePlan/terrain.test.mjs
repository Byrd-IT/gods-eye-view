import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleGround } from './terrain.js';

class EllipsoidTerrainProvider {}
const fakeCesium = (calls) => ({
  EllipsoidTerrainProvider,
  Cartographic: {
    fromDegrees: (lon, lat) => ({ longitude: lon, latitude: lat, height: 0 }),
  },
  sampleTerrainMostDetailed: async (_provider, cartos) => {
    calls.push(cartos.length);
    return cartos.map((c) => ({
      ...c,
      height: 100 + c.longitude * 0 + c.latitude,
    }));
  },
});
const realProvider = { requestTileGeometry() {} };
const pts = (n) =>
  Array.from({ length: n }, (_, i) => ({
    lon: -95 + i * 1e-5,
    lat: 30 + i * 1e-5,
  }));

test('samples every point plus the takeoff point, in chunks, through the globe terrain', async () => {
  const calls = [];
  const points = pts(900);
  const out = await sampleGround({
    viewer: { terrainProvider: realProvider },
    cesium: fakeCesium(calls),
    points,
    takeoff: { lon: -95, lat: 30 },
  });
  assert.equal(out.known, true);
  assert.equal(out.wpM.length, 900);
  assert.equal(out.takeoffM, 100 + 30);
  assert.ok(Math.abs(out.wpM[10] - (130 + 10 * 1e-5)) < 1e-9);
  assert.deepEqual(
    calls,
    [400, 400, 100],
    'chunks of 400; the takeoff point shares the first waypoint',
  );
});

test('a cache makes the second plan free', async () => {
  const calls = [];
  const cache = new Map();
  const args = {
    viewer: { terrainProvider: realProvider },
    cesium: fakeCesium(calls),
    points: pts(50),
    takeoff: { lon: -95, lat: 30 },
    cache,
  };
  await sampleGround(args);
  const before = calls.length;
  const again = await sampleGround(args);
  assert.equal(calls.length, before);
  assert.equal(again.known, true);
});

test('no real terrain, a failing sampler or a timeout resolve unknown, never throw', async () => {
  const base = { points: pts(5), takeoff: { lon: -95, lat: 30 } };
  const flat = await sampleGround({
    ...base,
    viewer: { terrainProvider: new EllipsoidTerrainProvider() },
    cesium: fakeCesium([]),
  });
  assert.deepEqual(flat, {
    known: false,
    takeoffM: 0,
    wpM: [0, 0, 0, 0, 0],
    missing: 0,
  });
  const broken = await sampleGround({
    ...base,
    viewer: { terrainProvider: realProvider },
    cesium: {
      ...fakeCesium([]),
      sampleTerrainMostDetailed: async () => {
        throw new Error('boom');
      },
    },
  });
  assert.equal(broken.known, false);
  const slow = await sampleGround({
    ...base,
    viewer: { terrainProvider: realProvider },
    cesium: {
      ...fakeCesium([]),
      sampleTerrainMostDetailed: () => new Promise(() => {}),
    },
    timeoutMs: 20,
  });
  assert.equal(slow.known, false);
  const none = await sampleGround({ ...base, viewer: {}, cesium: null });
  assert.equal(none.known, false);
});

test('a point the terrain gives no height for is reported, never filled with the takeoff height', async () => {
  const out = await sampleGround({
    viewer: { terrainProvider: realProvider },
    cesium: {
      ...fakeCesium([]),
      sampleTerrainMostDetailed: async (_p, cartos) =>
        cartos.map((c) => ({
          ...c,
          // the third waypoint is unreadable, however the points are batched
          height: c.longitude === pts(3)[2].lon ? undefined : 50,
        })),
    },
    points: pts(3),
    takeoff: { lon: -95, lat: 30 },
  });
  assert.equal(out.known, true);
  assert.equal(out.takeoffM, 50);
  assert.deepEqual(out.wpM, [50, 50, null]);
  assert.equal(out.missing, 1);
});

test('points a failed tile left without a height are asked for once more', async () => {
  const calls = [];
  let pass = 0;
  const out = await sampleGround({
    viewer: { terrainProvider: realProvider },
    cesium: {
      ...fakeCesium([]),
      sampleTerrainMostDetailed: async (_p, cartos) => {
        pass += 1;
        calls.push(cartos.length);
        // the first pass loses the middle point; the retry gets it
        return cartos.map((c, i) => ({
          ...c,
          height: pass === 1 && i === 2 ? undefined : 70,
        }));
      },
    },
    points: pts(3),
    takeoff: { lon: -95, lat: 30 },
  });
  assert.deepEqual(calls, [3, 1], 'a second request for only the gap');
  assert.deepEqual(out.wpM, [70, 70, 70]);
  assert.equal(out.missing, 0);
});
