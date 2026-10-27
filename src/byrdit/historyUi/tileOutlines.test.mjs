import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  OUTLINE_MAX_LAT,
  OUTLINE_STEP_DEG,
  createTileOutlines,
  outlinePolylines,
} from './tileOutlines.js';

const WORLD = [-180, -90, 180, 90];
const TEXAS = [-107, 25.8, -93.5, 36.5];
const BOXES = [
  WORLD,
  TEXAS,
  [-180, -60, 180, 60], // all longitudes, off the poles
  [-180, 0, 180, 90], // all longitudes, north edge on the pole
  [0, 80, 10, 90], // reaches the pole
  [-10, -90, 10, -80], // reaches the south pole
  [170, -10, 180, 10],
  [-179.9, -89.9, 179.9, 89.9], // nearly the world
];

/** PolylineGeometry.createGeometry as Cesium's worker runs it. */
function build(degrees, arcType) {
  const geometry = new Cesium.PolylineGeometry({
    positions: Cesium.Cartesian3.fromDegreesArray(degrees),
    width: 1.5,
    arcType,
  });
  return Cesium.PolylineGeometry.createGeometry(geometry);
}

test('the old corner-to-corner outline of a whole-world tile is refused by Cesium (the QA crash)', () => {
  const [w, s, e, n] = WORLD;
  assert.throws(
    () => build([w, s, e, s, e, n, w, n, w, s], Cesium.ArcType.GEODESIC),
    /0\.0125/,
  );
});

test('every outline segment runs along a parallel or meridian, at most the step, off the poles', () => {
  for (const box of BOXES) {
    for (const flat of outlinePolylines(box)) {
      assert.ok(flat.length >= 4, `${box}: at least two points`);
      for (let i = 0; i < flat.length; i += 2) {
        const lat = flat[i + 1];
        assert.ok(Math.abs(lat) <= OUTLINE_MAX_LAT, `${box}: lat ${lat}`);
        if (i === 0) continue;
        const dLon = Math.abs(flat[i] - flat[i - 2]);
        const dLat = Math.abs(lat - flat[i - 1]);
        assert.ok(
          (dLon === 0 || dLat === 0) && dLon + dLat > 0,
          `${box}: segment ${i / 2} is along a parallel or meridian`,
        );
        assert.ok(
          dLon <= OUTLINE_STEP_DEG + 1e-9 && dLat <= OUTLINE_STEP_DEG + 1e-9,
          `${box}: segment ${i / 2} at most ${OUTLINE_STEP_DEG} deg`,
        );
      }
    }
  }
});

test('Cesium builds every outline (rhumb) without an error', () => {
  for (const box of BOXES)
    for (const flat of outlinePolylines(box)) {
      const g = build(flat, Cesium.ArcType.RHUMB);
      assert.ok(g?.attributes?.position, `${box}: geometry built`);
    }
});

test('a whole-world tile draws nothing; an all-longitude band draws its two parallels; a box draws one closed ring', () => {
  assert.deepEqual(outlinePolylines(WORLD), []);
  const band = outlinePolylines([-180, -60, 180, 60]);
  assert.equal(band.length, 2);
  for (const flat of band) {
    assert.equal(flat[0], -180);
    assert.equal(flat.at(-2), 180);
  }
  assert.equal(outlinePolylines([-180, 0, 180, 90]).length, 1);
  const [ring] = outlinePolylines(TEXAS);
  assert.deepEqual(ring.slice(0, 2), [-107, 25.8]);
  assert.deepEqual(ring.slice(-2), [-107, 25.8]);
  for (const bad of [[1, 2, 1, 3], [1, 3, 2, 3], [NaN, 0, 1, 1], null, [0, 1]])
    assert.deepEqual(outlinePolylines(bad), [], JSON.stringify(bad));
});

test('createTileOutlines draws rhumb polylines, none for a whole-world tile', () => {
  const added = [];
  const viewer = {
    dataSources: { add: () => {}, remove: () => {} },
    scene: { requestRender: () => {} },
  };
  const cesium = {
    ...Cesium,
    CustomDataSource: class {
      constructor(name) {
        this.name = name;
        this.entities = {
          removeAll: () => added.splice(0),
          add: (e) => added.push(e),
        };
      }
    },
  };
  const outlines = createTileOutlines(viewer, { cesium });
  outlines.show([WORLD]);
  assert.equal(added.length, 0);
  outlines.show([WORLD, TEXAS]);
  assert.equal(added.length, 1);
  assert.equal(added[0].polyline.arcType, Cesium.ArcType.RHUMB);
  assert.ok(added[0].polyline.positions.length > 5);
});
