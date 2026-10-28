import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PRESET_ID,
  DRONE_PRESETS,
  getPreset,
  kmzStatus,
  listPresets,
} from './presets.js';
import {
  MODES,
  modeFor,
  orbitPlanRunCount,
  recommend,
  recommendedOptions,
} from './recommend.js';
import {
  floorTo,
  minShutterDenominator,
  shutterDenominatorOrDefault,
  speedLimits,
} from './speed.js';
import { assembleMissions, footprint, planFlight } from './planner.js';
import { buildKmz } from './wpml.js';

const IDS = [
  'dji-mini-5-pro',
  'dji-mini-4-pro',
  'dji-air-3',
  'dji-air-3s',
  'dji-mavic-3',
  'dji-phantom-4',
];
const BOX = { south: 32.0, west: -95.0, north: 32.003, east: -94.997 };
const flatGround = (plan, takeoffM = 100) => ({
  known: true,
  takeoffM,
  wpM: plan.legs.flatMap((l) => l.waypoints).map(() => takeoffM),
});
const planMission = (box, opts) => planFlight(box, opts);

test('the table holds exactly the six aircraft, Mini 5 Pro first and default', () => {
  assert.deepEqual(
    listPresets().map((p) => p.id),
    IDS,
  );
  assert.equal(DEFAULT_PRESET_ID, 'dji-mini-5-pro');
  assert.equal(getPreset('nope'), undefined);
  assert.equal(getPreset('__proto__'), undefined);
  assert.ok(Object.isFrozen(DRONE_PRESETS));
});

for (const id of IDS) {
  test(`preset ${id}: complete, frozen, sane geometry`, () => {
    const p = getPreset(id);
    assert.ok(p.name && p.app && p.sensorText);
    for (const k of [
      'sensorWidthMm',
      'sensorHeightMm',
      'focalMm',
      'imageWidthPx',
      'imageHeightPx',
      'minPhotoIntervalS',
      'maxSpeedMs',
      'defaultSpeedMs',
    ]) {
      assert.ok(Number.isFinite(p[k]) && p[k] > 0, `${id}.${k}`);
    }
    assert.ok(['electronic', 'mechanical'].includes(p.shutterType));
    assert.ok(['verified', 'derived', 'unverified'].includes(p.verified));
    assert.ok(
      p.sources.length > 0 && p.sources.every((u) => /^https:/.test(u)),
    );
    assert.ok(p.maxSpeedMs <= 15);
    assert.ok(p.defaultSpeedMs <= p.maxSpeedMs);
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.kmz));
    // landscape 4:3 still, 3:2 or 4:3 sensor: width over height 1.33 +- 0.01
    assert.ok(Math.abs(p.sensorWidthMm / p.sensorHeightMm - 4 / 3) < 0.01);
    // pixel pitch and diagonal FOV are in a physical range
    const fov =
      2 *
      Math.atan(Math.hypot(p.sensorWidthMm, p.sensorHeightMm) / 2 / p.focalMm);
    assert.ok(fov > 1.2 && fov < 1.8, `${id} fov ${fov}`);
    if (p.geometryBasis === 'sensor') {
      const pitchUm = (p.sensorWidthMm / p.imageWidthPx) * 1000;
      assert.ok(pitchUm > 1 && pitchUm < 2, `${id} pitch ${pitchUm}`);
    }
    // GSD at 100 m is a plausible mapping figure
    const gsd = footprint(p, 100, 0).gsdCm;
    assert.ok(gsd > 1 && gsd < 6, `${id} gsd ${gsd}`);
  });

  test(`preset ${id}: speed limits are finite, positive and ordered`, () => {
    const p = getPreset(id);
    for (const spacing of [1, 5, 20]) {
      for (const gsd of [0.5, 2, 5]) {
        const l = speedLimits({
          preset: p,
          photoSpacingM: spacing,
          gsdCm: gsd,
        });
        assert.ok(l.limitMs > 0 && l.limitMs <= p.maxSpeedMs);
        assert.equal(l.limitMs, Math.min(l.intervalMs, l.blurMs, l.aircraftMs));
      }
    }
  });

  test(`preset ${id}: every mode gives a plannable recommendation`, () => {
    const p = getPreset(id);
    for (const mode of MODES) {
      const rec = recommend(p, mode);
      assert.equal(rec.presetId, id);
      assert.ok(rec.speedMs >= 0.1 && rec.speedMs <= p.maxSpeedMs);
      assert.ok(rec.speedMs <= rec.limits.limitMs + 1e-9);
      assert.equal(modeFor(recommendedOptions(rec)), mode);
      const plan = planMission(BOX, {
        presetId: id,
        orbitRadiusM: 40,
        ...recommendedOptions(rec),
      });
      assert.ok(plan.speedMs <= rec.limits.limitMs + 0.011);
      assert.ok(!plan.speedLimitedBy, `${id}/${mode} should fly as asked`);
    }
  });
}

test('only the Phantom 4 and unknown-code aircraft are refused a KMZ, with the right reason', () => {
  assert.deepEqual(kmzStatus(getPreset('dji-mini-5-pro')), { ok: true });
  assert.deepEqual(kmzStatus(getPreset('dji-mini-4-pro')), { ok: true });
  for (const id of ['dji-air-3', 'dji-air-3s', 'dji-mavic-3']) {
    assert.deepEqual(kmzStatus(getPreset(id)), {
      ok: false,
      reason: 'no-code',
    });
    // a typed-in code opens it
    assert.deepEqual(kmzStatus(getPreset(id), 77), { ok: true });
  }
  const p4 = getPreset('dji-phantom-4');
  assert.deepEqual(kmzStatus(p4), { ok: false, reason: 'no-fly-waypoints' });
  // even a typed-in code does not make a Phantom 4 file
  assert.deepEqual(kmzStatus(p4, 68), {
    ok: false,
    reason: 'no-fly-waypoints',
  });
  assert.equal(p4.app, 'DJI GO 4');
});

test('buildKmz refuses an aircraft without a waypoint path or code instead of writing aircraft 0', () => {
  for (const id of ['dji-phantom-4', 'dji-air-3']) {
    const plan = planMission(BOX, { presetId: id });
    const m = assembleMissions(plan, flatGround(plan));
    assert.throws(() => buildKmz(m.missions[0], m.plan, { when: new Date(0) }));
  }
  const plan = planMission(BOX, { presetId: 'dji-air-3' });
  const m = assembleMissions(plan, flatGround(plan));
  const ok = buildKmz(m.missions[0], m.plan, {
    when: new Date(0),
    wpml: { droneEnumValue: 77 },
  });
  assert.ok(ok.length > 100);
});

test('the Mini 5 Pro keeps its old geometry and aircraft code', () => {
  const p = getPreset('dji-mini-5-pro');
  assert.equal(p.wpml.droneEnumValue, 68);
  assert.ok(Math.abs(p.sensorHeightMm - 8.8) < 1e-9);
  // GSD at 50 m: 8.8 mm sensor height / 6144 px, per DJI geometry 0.81-0.88
  const gsd = footprint(p, 50, 0).gsdCm;
  assert.ok(gsd > 0.78 && gsd < 0.9, `gsd ${gsd}`);
});

test('P3: a low, high-overlap plan is never flown faster than the camera allows', () => {
  const p = getPreset('dji-mini-5-pro');
  // 20 m, 90 % front: spacing is tiny, the 5 s interval limits hard
  const r = planMission(BOX, {
    presetId: p.id,
    aglM: 20,
    frontOverlap: 90,
    sideOverlap: 80,
    speedMs: 5,
  });
  const limit = r.speedLimits.limitMs;
  assert.ok(limit < 1, `limit ${limit}`);
  assert.ok(r.speedMs <= limit + 1e-9, `${r.speedMs} > ${limit}`);
  assert.ok(r.speedMs < 1, 'no 1 m/s floor above the limit');
  assert.ok(r.speedLimitedBy);
});

test('speed is limited by blur on a fine GSD and a slow shutter', () => {
  const p = getPreset('dji-mavic-3');
  const slow = speedLimits({
    preset: p,
    photoSpacingM: 100,
    gsdCm: 1,
    shutterDenominator: 250,
  });
  const fast = speedLimits({
    preset: p,
    photoSpacingM: 100,
    gsdCm: 1,
    shutterDenominator: 2000,
  });
  assert.equal(slow.limitedBy, 'blur');
  assert.ok(Math.abs(slow.blurMs - 0.5 * 0.01 * 250) < 1e-9);
  assert.ok(fast.limitMs > slow.limitMs);
  assert.equal(shutterDenominatorOrDefault('junk'), 1000);
  assert.equal(shutterDenominatorOrDefault(1e9), 1000);
  assert.equal(minShutterDenominator(p, 1, 5), 1000);
});

test('limit helpers round down, never up', () => {
  assert.equal(floorTo(1.239, 0.01), 1.23);
  assert.ok(Math.abs(floorTo(0.3, 0.1) - 0.3) < 1e-9);
});

test('the speed note names blur or camera and the plan carries the limits', () => {
  const r = planMission(BOX, {
    presetId: 'dji-mavic-3',
    aglM: 30,
    frontOverlap: 60,
    sideOverlap: 50,
    speedMs: 15,
    shutterDenominator: 250,
  });
  assert.equal(r.speedLimitedBy, 'blur');
  assert.ok(r.notes.some((w) => w.code === 'speed-blur-limited'));
});

test('orbit mode ignores side overlap in the recommended options', () => {
  const rec = recommend(getPreset('dji-air-3s'), 'splat-orbit');
  assert.equal(rec.sideOverlap, null);
  assert.equal('sideOverlap' in recommendedOptions(rec), false);
  assert.equal(rec.gimbalPitchDeg, null);
  assert.deepEqual(rec.orbitHeightsM, [40, 80]);
});

test('orbit recommend() memoises the planner run by aircraft, mode and radius', () => {
  const p = getPreset('dji-air-3s');
  const first = recommend(p, 'splat-orbit', { orbitRadiusM: 33.5 });
  const runs = orbitPlanRunCount();
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(
      recommend(p, 'splat-orbit', { orbitRadiusM: 33.5 }),
      first,
    );
  }
  assert.equal(orbitPlanRunCount(), runs, 'no new planFlight for same inputs');
  recommend(p, 'splat-orbit', { orbitRadiusM: 34.5 });
  assert.equal(orbitPlanRunCount(), runs + 1, 'new radius computes once');
  recommend(getPreset('dji-mavic-3'), 'splat-orbit', { orbitRadiusM: 33.5 });
  assert.equal(orbitPlanRunCount(), runs + 2, 'new aircraft computes once');
  // Grid modes never run an orbit plan.
  recommend(p, 'mapping-grid');
  recommend(p, 'fast-survey');
  assert.equal(orbitPlanRunCount(), runs + 2);
});

test('memoised orbit recommendation is not corrupted by caller mutation', () => {
  const p = getPreset('dji-air-3');
  const a = recommend(p, 'splat-orbit', { orbitRadiusM: 41.25 });
  const snapshot = JSON.stringify(a);
  a.limits.limitMs = -1;
  a.orbitHeightsM.push(999);
  a.camera.isoRange.push(1);
  assert.equal(
    JSON.stringify(recommend(p, 'splat-orbit', { orbitRadiusM: 41.25 })),
    snapshot,
  );
});
