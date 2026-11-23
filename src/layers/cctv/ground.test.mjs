import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from './ground.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

function setup(record) {
  const calls = { culling: 0, geometry: [], notify: 0 };
  const state = {
    _viewer: null,
    _recordById: new Map([[record.camera.id, record]]),
  };
  const parts = {
    rendering: {
      refreshHorizonCulling: () => (calls.culling++, true),
      moveCameraIcon() {},
    },
    geometryQueue: { enqueueViewGeometry() {} },
    presentation: { notifyListeners: () => calls.notify++ },
    geometry: {
      // Same choice as geometry.updateRecordGeometry on a globe with a cold floor cell.
      updateRecordGeometry(r) {
        calls.geometry.push(
          ground.groundPriorAltFor(r) + r.camera.mountHeightM,
        );
      },
    },
  };
  const ground = createGround({
    state,
    services: {
      ground: { resolveGroundFloorCells: async () => {} },
      terrain: { resolveEllipsoidalGround: async () => [] },
    },
    parts,
  });
  return { ground, calls };
}

test('a late geoid fallback leaves a drawn-terrain height in place', () => {
  const camera = {
    id: 'a',
    lat: 42,
    lon: -118,
    mountHeightM: 8,
    absoluteHeightM: 1880,
  };
  const record = {
    camera,
    position: fromDegrees(camera.lon, camera.lat, 1880),
    frustumGeometry: {},
    frustumPositions: {},
    groundSamples: {},
    groundResolved: {},
    groundPrior: { ellipsoid: 1872, source: 'drawn-terrain', rangeM: 2000 },
  };
  const { ground, calls } = setup(record);
  ground.applyLateGroundPriors(
    [record],
    [{ ellipsoid: 0, source: 'geoid-fallback' }],
  );

  assert.equal(record.groundPrior.source, 'drawn-terrain');
  assert.ok(!calls.geometry.includes(8), 'mount not lowered to the fallback');
});

test('a visibility-gated prior batch asks for the passed records only', async () => {
  const requested = [];
  const makeRecord = (id, lon) => ({
    camera: { id, lat: 40, lon, mountHeightM: 5 },
    position: fromDegrees(lon, 40, 100),
    frustumGeometry: null,
    frustumPositions: null,
    groundSamples: {},
    groundResolved: {},
    groundPrior: null,
  });
  const records = [
    makeRecord('a', -77),
    makeRecord('b', -78),
    makeRecord('c', -79),
  ];
  const state = {
    _viewer: null,
    _recordById: new Map(records.map((record) => [record.camera.id, record])),
  };
  const parts = {
    rendering: { refreshHorizonCulling: () => false, moveCameraIcon() {} },
    geometryQueue: { enqueueViewGeometry() {} },
    presentation: { notifyListeners() {} },
    geometry: { updateRecordGeometry() {} },
  };
  const ground = createGround({
    state,
    services: {
      ground: { resolveGroundFloorCells: async () => {} },
      terrain: {
        async resolveEllipsoidalGround(coords) {
          requested.push(coords.map((coord) => coord.lon));
          return coords.map(() => ({ ellipsoid: 1234, source: 'reearth' }));
        },
      },
    },
    parts,
  });

  // The view pass shows a and c; b is off screen and must not be fetched.
  const count = await ground.resolveVisibleGroundPriors([
    records[0],
    records[2],
  ]);

  assert.equal(count, 2);
  assert.deepEqual(requested, [[-77, -79]]);
  assert.equal(records[0].groundPrior.ellipsoid, 1234);
  assert.equal(records[0].groundPrior.source, 'reearth');
  assert.equal(records[1].groundPrior, null, 'an off-view camera is untouched');

  // A later settle re-passes the same working set; warm records are not
  // requested again.
  await ground.resolveVisibleGroundPriors(records);
  assert.deepEqual(
    requested,
    [[-77, -79], [-78]],
    'only the cold record is asked for',
  );
  assert.equal(records[2].groundPrior.source, 'reearth');
});
