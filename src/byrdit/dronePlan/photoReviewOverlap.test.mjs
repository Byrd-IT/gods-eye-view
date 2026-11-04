import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPhotoOverlap } from './photoReviewOverlap.js';
const p = (lon = -95) => ({ lon, lat: 32, widthPx: 4096, heightPx: 3072, focal35Mm: 24, relAltM: 80, gimbalPitchDeg: -90, gimbalYawDeg: 0 });
const s = (photoIndex) => ({ photoIndex, key: `w${photoIndex}`, status: 'matched', pass: 'A', mission: 0, leg: 0, shot: 'in', aglM: 80, relHeightM: 80 });

test('overlap estimates intersecting footprints, not just waypoint spacing', () => {
  const out = assessPhotoOverlap([p(), p()], [s(0), s(1)]);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs[0].status, 'modeled');
  assert.ok(out.pairs[0].overlapFraction > 0.999);
  assert.equal(out.pairs[0].reason, null);
  assert.equal(out.verified, false);
});

test('nonintersecting footprints flag an overlap gap with both shot keys', () => {
  const out = assessPhotoOverlap([p(), p(-94.99)], [s(0), s(1)]);
  assert.equal(out.pairs[0].overlapFraction, 0);
  assert.equal(out.pairs[0].reason, 'modeled-overlap-gap');
  assert.deepEqual(out.pairs[0].shotKeys, ['w0', 'w1']);
});

test('missing height, attitude, and horizon clipping remain unknown', () => {
  for (const change of [{ relAltM: null }, { gimbalYawDeg: null }, { gimbalPitchDeg: -10 }]) {
    const out = assessPhotoOverlap([p(), { ...p(), ...change }], [s(0), s(1)]);
    assert.equal(out.pairs[0].status, 'unknown');
    assert.equal(out.pairs[0].overlapFraction, null);
  }
});

test('different legs and in/out views are not asserted to require overlap', () => {
  assert.equal(assessPhotoOverlap([p(), p()], [s(0), { ...s(1), leg: 1 }]).pairs.length, 0);
  assert.equal(assessPhotoOverlap([p(), p()], [s(0), { ...s(1), shot: 'out' }]).pairs.length, 0);
});

test('missing capture and different ground planes cannot prove overlap', () => {
  for (const change of [{ status: 'missing', photoIndex: null }, { aglM: 20 }]) {
    const out = assessPhotoOverlap([p(), p()], [s(0), { ...s(1), ...change }]);
    assert.equal(out.pairs[0].status, 'unknown');
  }
});
