import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreset, listPresets } from './presets.js';
import { planFlight, footprint } from './planner.js';
import {
  CAMERA_FASTEST_SHUTTER_DENOMINATOR,
  defaultTimedInterval,
  effectivePreset,
  hasPhotoSizes,
  photoSizeLimits,
  shutterAdvice,
  timedIntervalOptions,
} from './cameraLimits.js';
import { cameraPresetOrDefault } from './cameraSettings.js';
import { minShutterDenominator } from './speed.js';

const BOX = { west: -97.0, east: -96.997, south: 33.0, north: 33.002 };
const mini = getPreset('dji-mini-5-pro');
const air3s = getPreset('dji-air-3s');

test('the 12 MP preset is called "12 MP, 4:3" and keeps its stored id', () => {
  const p = cameraPresetOrDefault('test-12mp');
  assert.equal(p.id, 'test-12mp');
  assert.equal(p.name, '12 MP, 4:3');
  assert.equal(cameraPresetOrDefault('mapping-50mp').name, '50 MP, 4:3 (mapping)');
});

test("only aircraft with both photo sizes (Mini 5 Pro, Air 3S) get a size choice", () => {
  const withSizes = listPresets().filter((p) => hasPhotoSizes(p)).map((p) => p.id);
  assert.deepEqual(withSizes.sort(), ['dji-air-3s', 'dji-mini-5-pro']);
});

test('DJI Timed shot lists: 12 MP 2..60 s, 50 MP 5..60 s', () => {
  assert.deepEqual(
    [...timedIntervalOptions(mini, 'test-12mp')],
    [2, 3, 5, 7, 10, 15, 20, 30, 60],
  );
  assert.deepEqual(
    [...timedIntervalOptions(mini, 'mapping-50mp')],
    [5, 7, 10, 15, 20, 30, 60],
  );
  assert.deepEqual(
    [...timedIntervalOptions(air3s, 'test-12mp')],
    [...timedIntervalOptions(mini, 'test-12mp')],
  );
  // An unknown id falls back to the default (50 MP) size.
  assert.deepEqual(
    [...timedIntervalOptions(mini, 'nope')],
    [...timedIntervalOptions(mini, 'mapping-50mp')],
  );
});

test('other aircraft keep their own preset exactly (same object, no list)', () => {
  for (const p of listPresets().filter((x) => !hasPhotoSizes(x))) {
    assert.equal(effectivePreset(p, 'test-12mp'), p, p.id);
    assert.equal(effectivePreset(p, 'mapping-50mp'), p, p.id);
    assert.equal(timedIntervalOptions(p, 'test-12mp'), null, p.id);
    assert.equal(photoSizeLimits(p, 'test-12mp'), null, p.id);
  }
});

test('the effective preset: pixel size and default interval follow the size', () => {
  const e50 = effectivePreset(mini, 'mapping-50mp');
  const e12 = effectivePreset(mini, 'test-12mp');
  assert.equal(e50, mini, 'the default 50 MP plan uses the aircraft preset object');
  assert.deepEqual(
    [e12.imageWidthPx, e12.imageHeightPx, e12.minPhotoIntervalS],
    [4096, 3072, 2],
  );
  assert.deepEqual(
    [e50.imageWidthPx, e50.imageHeightPx, e50.minPhotoIntervalS],
    [8192, 6144, 5],
  );
  // Same sensor and optics: only the pixel count changes.
  for (const k of ['sensorWidthMm', 'sensorHeightMm', 'focalLengthMm']) {
    assert.equal(e12[k], e50[k], k);
  }
  assert.equal(effectivePreset(mini, 'test-12mp'), e12, 'same copy every time');
});

test('12 MP ground detail is exactly twice the 50 MP value at the same height', () => {
  const g50 = footprint(effectivePreset(mini, 'mapping-50mp'), 80, 0).gsdCm;
  const g12 = footprint(effectivePreset(mini, 'test-12mp'), 80, 0).gsdCm;
  assert.ok(Math.abs(g12 / g50 - 2) < 1e-12, `${g12} / ${g50}`);
  // Measured with the program's own footprint function: 1.302 and 2.604 cm/px.
  assert.ok(Math.abs(g50 - 1.3021) < 1e-3);
  assert.ok(Math.abs(g12 - 2.6042) < 1e-3);
  // The field of view is unchanged.
  const f50 = footprint(effectivePreset(mini, 'mapping-50mp'), 80, 0);
  const f12 = footprint(effectivePreset(mini, 'test-12mp'), 80, 0);
  assert.equal(f12.alongM, f50.alongM);
  assert.equal(f12.acrossM, f50.acrossM);
});

test('planFlight uses the chosen size: ground detail and the camera minimum', () => {
  const p50 = planFlight(BOX, { aglM: 80, cameraPresetId: 'mapping-50mp' });
  const p12 = planFlight(BOX, { aglM: 80, cameraPresetId: 'test-12mp' });
  assert.ok(Math.abs(p12.gsdCm / p50.gsdCm - 2) < 1e-9);
  assert.equal(p50.preset.minPhotoIntervalS, 5);
  assert.equal(p12.preset.minPhotoIntervalS, 2);
});

test('a camera minimum the user typed is kept when the size is switched', () => {
  const a = planFlight(BOX, {
    aglM: 80,
    cameraPresetId: 'mapping-50mp',
    minPhotoIntervalS: 4,
  });
  const b = planFlight(BOX, {
    aglM: 80,
    cameraPresetId: 'test-12mp',
    minPhotoIntervalS: 4,
  });
  assert.equal(a.preset.minPhotoIntervalS, 4);
  assert.equal(b.preset.minPhotoIntervalS, 4);
});

test('an aircraft without a size choice plans exactly as before', () => {
  const air3 = getPreset('dji-air-3');
  const a = planFlight(BOX, { presetId: 'dji-air-3', aglM: 80 });
  const b = planFlight(BOX, {
    presetId: 'dji-air-3',
    aglM: 80,
    cameraPresetId: 'test-12mp',
  });
  assert.equal(a.gsdCm, b.gsdCm);
  assert.equal(a.preset.imageWidthPx, air3.imageWidthPx);
  assert.equal(b.preset.imageWidthPx, air3.imageWidthPx);
});

test('default Timed interval: the longest option that still gives the wanted overlap', () => {
  const options = timedIntervalOptions(mini, 'test-12mp');
  // 80 m, along 80 m, 80 % wanted: spacing may be 16 m; at 3 m/s that is 5.33 s.
  assert.equal(
    defaultTimedInterval({
      options,
      minIntervalS: 2,
      alongM: 80,
      speedMs: 3,
      frontOverlapPct: 80,
    }),
    5,
  );
  // Too fast for any option: the shortest allowed one (the most overlap).
  assert.equal(
    defaultTimedInterval({
      options: timedIntervalOptions(mini, 'mapping-50mp'),
      minIntervalS: 5,
      alongM: 80,
      speedMs: 15,
      frontOverlapPct: 80,
    }),
    5,
  );
  // A camera minimum above an option rules it out.
  assert.equal(
    defaultTimedInterval({
      options,
      minIntervalS: 5,
      alongM: 80,
      speedMs: 15,
      frontOverlapPct: 80,
    }),
    5,
  );
  assert.equal(defaultTimedInterval({ options: [] }), null);
  assert.equal(
    defaultTimedInterval({ options, minIntervalS: 100 }),
    60,
    'every option under the minimum: the longest',
  );
});

test('shutter advice uses the effective preset: 12 MP allows a slower shutter', () => {
  const speed = 5;
  const e50 = effectivePreset(mini, 'mapping-50mp');
  const e12 = effectivePreset(mini, 'test-12mp');
  const g50 = footprint(e50, 80, 0).gsdCm;
  const g12 = footprint(e12, 80, 0).gsdCm;
  const a50 = shutterAdvice(e50, g50, speed);
  const a12 = shutterAdvice(e12, g12, speed);
  assert.equal(a50.exact, minShutterDenominator(e50, g50, speed));
  assert.equal(a12.exact, minShutterDenominator(e12, g12, speed));
  assert.ok(a12.exact < a50.exact);
  assert.ok(a12.standard <= a50.standard);
  assert.equal(shutterAdvice(e50, g50, 0), null);
  assert.equal(shutterAdvice(e50, NaN, 5), null);
});

test('shutter advice rounds up to a standard stop and flags what the camera cannot do', () => {
  const e = effectivePreset(mini, 'mapping-50mp');
  const g = footprint(e, 80, 0).gsdCm;
  const slow = shutterAdvice(e, g, 1);
  assert.ok([250, 500, 1000, 2000, 4000].includes(slow.standard));
  assert.ok(slow.standard >= slow.exact);
  assert.equal(slow.beyondCamera, false);
  const fast = shutterAdvice(e, g, 15);
  assert.equal(fast.beyondCamera, fast.exact > CAMERA_FASTEST_SHUTTER_DENOMINATOR);
  const veryFast = shutterAdvice(e, g / 20, 15);
  assert.equal(veryFast.beyondTable, true);
  assert.equal(veryFast.standard, null);
  assert.equal(veryFast.beyondCamera, true);
});

test('the 1/8000 s camera limit applies only to the 1-inch camera aircraft', () => {
  const other = getPreset('dji-mavic-3');
  assert.equal(hasPhotoSizes(other), false);
  const fast = shutterAdvice(other, 0.05, 15);
  assert.ok(fast.exact > CAMERA_FASTEST_SHUTTER_DENOMINATOR);
  assert.equal(fast.beyondCamera, false);
  const e = effectivePreset(mini, 'mapping-50mp');
  assert.equal(shutterAdvice(e, 0.05, 15).beyondCamera, true);
});
