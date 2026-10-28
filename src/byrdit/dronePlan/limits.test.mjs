import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_BOX_SIDE_M, MIN_BOX_SIDE_M, validateDroneBox } from './limits.js';
import { metersPerDegree } from './geo.js';

const boxM = (w, h, lat = 30.27, lon = -97.77) => {
  const m = metersPerDegree(lat);
  return {
    west: lon - w / 2 / m.lon,
    east: lon + w / 2 / m.lon,
    south: lat - h / 2 / m.lat,
    north: lat + h / 2 / m.lat,
  };
};

test('a flyable box passes and edges are put in order', () => {
  const ok = validateDroneBox(boxM(400, 300));
  assert.equal(ok.ok, true);
  // Swapped edges are put in order first, so the size rule judges the real box:
  // this 1 degree (about 100 km) box is too big, not "degenerate".
  const swapped = validateDroneBox({ west: 2, south: 2, east: 1, north: 1 });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, 'too-large');
  const tinySwapped = boxM(5, 5);
  const tiny = validateDroneBox({
    west: tinySwapped.east,
    east: tinySwapped.west,
    south: tinySwapped.north,
    north: tinySwapped.south,
  });
  assert.equal(
    tiny.reason,
    'degenerate',
    'a swapped sub-20 m box is too small',
  );
  const reversed = boxM(400, 300);
  const fixed = validateDroneBox({
    west: reversed.east,
    east: reversed.west,
    south: reversed.north,
    north: reversed.south,
  });
  assert.equal(fixed.ok, true);
  assert.ok(
    fixed.box.west < fixed.box.east && fixed.box.south < fixed.box.north,
  );
});

test('boxes that are too small, too big or not numbers are refused with a reason', () => {
  assert.equal(
    validateDroneBox(boxM(MIN_BOX_SIDE_M - 5, 200)).reason,
    'degenerate',
  );
  assert.equal(
    validateDroneBox(boxM(200, MAX_BOX_SIDE_M + 100)).reason,
    'too-large',
  );
  assert.equal(
    validateDroneBox({ west: NaN, south: 0, east: 1, north: 1 }).reason,
    'invalid',
  );
  assert.equal(validateDroneBox(null).reason, 'invalid');
  assert.ok(validateDroneBox(boxM(MAX_BOX_SIDE_M - 50, MIN_BOX_SIDE_M + 5)).ok);
});
