import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLatLon, cellCorners, modelHeight } from './coordinates.js';
test('matches published model photo coordinates at ranch origin', () => {
  const v = modelLatLon({ lat: 32.690664, lon: -95.1527088 }, -0.076, 1.948);
  assert(Math.abs(v.lat - 32.6906815) < 1e-7);
  assert(Math.abs(v.lon - -95.1527096) < 1e-7);
});
test('cell corners follow sparse row-major index and reject out of bounds', () => {
  const g = { nx: 2, ny: 2, x0: 0, y0: 0, cell_m: 10 },
    o = { lat: 0, lon: 0 };
  const c = cellCorners(g, o, 3);
  assert.equal(c.length, 4);
  assert(c[0].lon > 0);
  assert(c[0].lat > 0);
  assert(c[2].lat > c[0].lat);
  assert.throws(() => cellCorners(g, o, 4));
});
test('solved altitude is shifted relative to sampled ground, never interpreted as absolute height', () => {
  assert.equal(modelHeight(1, -14, 100), 115);
  assert.throws(() => modelHeight(1, -14, NaN));
});
