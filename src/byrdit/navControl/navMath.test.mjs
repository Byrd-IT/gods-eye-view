import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HORIZON_PITCH,
  LOOK_MAX_PITCH,
  LOOK_UP_PITCH,
  MAX_RANGE_M,
  MIN_RANGE_M,
  TILT_SPAN_DEG,
  TOP_DOWN_PITCH,
  ZOOM_FRACTION,
  clampPitch,
  clampRange,
  easeInOut,
  headingDegrees,
  headingFromDrag,
  horizonPitchForRange,
  liftPitchForClearance,
  normalizeHeading,
  pitchToTiltDeg,
  planAction,
  planLook,
  pointerAngle,
  shortestTurn,
  splitTilt,
  tiltDegToPitch,
  tiltDescription,
  zoomRange,
} from './navMath.js';

const DEG = Math.PI / 180;
const near = (actual, expected, epsilon = 1e-9, message = '') =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message} expected ${expected}, got ${actual}`,
  );

test('headings wrap into 0..360 and bad input reads as north', () => {
  near(normalizeHeading(-90 * DEG), 270 * DEG);
  near(normalizeHeading(450 * DEG), 90 * DEG);
  assert.equal(normalizeHeading(Number.NaN), 0);
  assert.equal(normalizeHeading(Number.POSITIVE_INFINITY), 0);
  // A hair under a full turn is north, not 359.9999999 degrees.
  assert.equal(normalizeHeading(2 * Math.PI - 1e-12), 0);
  assert.equal(headingDegrees(359.6 * DEG), 0);
  assert.equal(headingDegrees(-1 * DEG), 359);
});

test('the shortest turn to north never goes the long way round', () => {
  near(shortestTurn(350 * DEG, 0), 10 * DEG);
  near(shortestTurn(10 * DEG, 0), -10 * DEG);
  near(shortestTurn(0, 270 * DEG), -90 * DEG);
  near(Math.abs(shortestTurn(0, 180 * DEG)), 180 * DEG);
});

test('pitch is clamped between top-down and near-horizon', () => {
  assert.equal(clampPitch(-120 * DEG), TOP_DOWN_PITCH);
  assert.equal(clampPitch(-90 * DEG), TOP_DOWN_PITCH);
  assert.equal(clampPitch(0), HORIZON_PITCH, 'never past the horizon');
  assert.equal(clampPitch(20 * DEG), HORIZON_PITCH);
  assert.equal(clampPitch(-45 * DEG), -45 * DEG);
  assert.equal(clampPitch(Number.NaN), TOP_DOWN_PITCH);
});

test('close in, the horizon limit tightens so the camera cannot sink', () => {
  // 30 m from the target a 10-degree lean is only 5 m up: the limit moves
  // toward top-down so the 8 m clearance holds.
  const limit = horizonPitchForRange(30);
  assert.ok(limit < HORIZON_PITCH, 'limit is steeper than the global horizon');
  assert.ok(30 * Math.sin(-limit) >= 8 - 1e-9, 'camera at least 8 m up');
  assert.equal(horizonPitchForRange(5_000), HORIZON_PITCH);
  assert.equal(clampPitch(-10 * DEG, 30), limit);
  assert.equal(horizonPitchForRange(Number.NaN), TOP_DOWN_PITCH);
  assert.equal(horizonPitchForRange(4), TOP_DOWN_PITCH);
});

test('the tilt slider maps top-down to 0 and straight up to its maximum', () => {
  assert.equal(TILT_SPAN_DEG, 179);
  assert.equal(LOOK_UP_PITCH, 90 * DEG);
  assert.equal(pitchToTiltDeg(TOP_DOWN_PITCH), 0);
  assert.equal(pitchToTiltDeg(HORIZON_PITCH), 79);
  assert.equal(pitchToTiltDeg(0), 89);
  assert.equal(pitchToTiltDeg(LOOK_UP_PITCH), 179);
  assert.equal(pitchToTiltDeg(-200 * DEG), 0);
  assert.equal(pitchToTiltDeg(120 * DEG), TILT_SPAN_DEG);
  assert.equal(pitchToTiltDeg(Number.NaN), 0);
  near(tiltDegToPitch(0), TOP_DOWN_PITCH);
  near(tiltDegToPitch(79), HORIZON_PITCH);
  near(tiltDegToPitch(89), 0);
  near(tiltDegToPitch(179), LOOK_UP_PITCH);
  near(tiltDegToPitch(500), LOOK_UP_PITCH, 1e-9, 'over-range slider value');
  near(tiltDegToPitch(-5), TOP_DOWN_PITCH);
  for (const tilt of [0, 79, 89, 179])
    assert.equal(pitchToTiltDeg(tiltDegToPitch(tilt)), tilt);
  for (let tilt = 0; tilt <= TILT_SPAN_DEG; tilt++)
    assert.equal(pitchToTiltDeg(tiltDegToPitch(tilt)), tilt);
});

test('the orbit clamp and clearance lift are unchanged by the look-up range', () => {
  assert.equal(clampPitch(LOOK_UP_PITCH), HORIZON_PITCH);
  assert.equal(clampPitch(5 * DEG), HORIZON_PITCH);
  assert.equal(HORIZON_PITCH, -10 * DEG);
  assert.equal(liftPitchForClearance(-10 * DEG, () => 100), -10 * DEG);
  near(
    liftPitchForClearance(-10 * DEG, (p) => (p < -11 * DEG ? 20 : 2)),
    -12 * DEG,
  );
});

test('splitTilt orbits up to the limit and looks the rest', () => {
  const below = splitTilt(-45 * DEG, HORIZON_PITCH);
  assert.equal(below.orbitPitch, -45 * DEG);
  assert.equal(below.gazePitch, -45 * DEG);
  assert.equal(below.lookUp, false);

  const above = splitTilt(-5 * DEG, HORIZON_PITCH);
  assert.equal(above.orbitPitch, HORIZON_PITCH);
  assert.equal(above.gazePitch, -5 * DEG);
  assert.equal(above.lookUp, true);

  const up = splitTilt(LOOK_UP_PITCH, HORIZON_PITCH);
  assert.equal(up.orbitPitch, HORIZON_PITCH);
  assert.equal(up.gazePitch, LOOK_UP_PITCH);
  assert.equal(up.lookUp, true);
  assert.equal(splitTilt(200 * DEG, HORIZON_PITCH).gazePitch, LOOK_UP_PITCH);

  const exact = splitTilt(HORIZON_PITCH, HORIZON_PITCH);
  assert.equal(exact.lookUp, false);

  // Non-finite wanted reads as top-down, non-finite limit as the horizon.
  const bad = splitTilt(Number.NaN, HORIZON_PITCH);
  assert.deepEqual(bad, {
    orbitPitch: TOP_DOWN_PITCH,
    gazePitch: TOP_DOWN_PITCH,
    lookUp: false,
  });
  const badLimit = splitTilt(LOOK_UP_PITCH, Number.NaN);
  assert.equal(badLimit.orbitPitch, HORIZON_PITCH);
  assert.equal(badLimit.lookUp, true);

  // Terrain lowered the limit: the orbit stays there, the gaze does the rest.
  const lowered = splitTilt(-10 * DEG, -30 * DEG);
  assert.equal(lowered.orbitPitch, -30 * DEG);
  assert.equal(lowered.gazePitch, -10 * DEG);
  assert.equal(lowered.lookUp, true);
  // A limit below top-down never takes the orbit past top-down.
  assert.equal(splitTilt(-80 * DEG, -120 * DEG).orbitPitch, TOP_DOWN_PITCH);
});

test('tiltDescription speaks the slider value', () => {
  assert.equal(tiltDescription(0), 'top-down');
  assert.equal(tiltDescription(1), '88 degrees below the horizon');
  assert.equal(tiltDescription(79), '10 degrees below the horizon');
  assert.equal(tiltDescription(89), 'level with the horizon');
  assert.equal(tiltDescription(99), '10 degrees above the horizon');
  assert.equal(tiltDescription(179), 'straight up');
  assert.equal(tiltDescription(500), 'straight up');
  assert.equal(tiltDescription(Number.NaN), 'top-down');
});

test('zoom steps travel a fraction of the distance and are clamped', () => {
  near(zoomRange(1000, 'in'), 1000 * (1 - ZOOM_FRACTION));
  near(zoomRange(1000, 'out'), 1000 / (1 - ZOOM_FRACTION));
  // Out then in lands back where it began.
  near(zoomRange(zoomRange(1000, 'out'), 'in'), 1000, 1e-6);
  assert.equal(zoomRange(MIN_RANGE_M, 'in'), MIN_RANGE_M);
  assert.equal(zoomRange(MIN_RANGE_M + 1, 'in'), MIN_RANGE_M);
  assert.equal(zoomRange(MAX_RANGE_M, 'out'), MAX_RANGE_M);
  assert.equal(clampRange(Number.NaN), MIN_RANGE_M);
  assert.equal(clampRange(-5), MIN_RANGE_M);
  assert.equal(clampRange(1e12), MAX_RANGE_M);
  // Holding the button repeats the step and still never leaves the span.
  let range = 2_000;
  for (let i = 0; i < 60; i++) range = zoomRange(range, 'in');
  assert.equal(range, MIN_RANGE_M);
  for (let i = 0; i < 200; i++) range = zoomRange(range, 'out');
  assert.equal(range, MAX_RANGE_M);
});

test('dragging the ring turns the view opposite to the pointer', () => {
  // Pointer angle: 0 at 12 o'clock, clockwise positive.
  near(pointerAngle(100, 100, 100, 50), 0);
  near(pointerAngle(100, 100, 150, 100), 90 * DEG);
  near(pointerAngle(100, 100, 100, 150), 180 * DEG);
  near(pointerAngle(100, 100, 50, 100), -90 * DEG);
  // A quarter turn clockwise moves north clockwise: heading 0 becomes 270.
  near(
    headingFromDrag({ startHeading: 0, startAngle: 90 * DEG, angle: 180 * DEG }),
    270 * DEG,
  );
  near(
    headingFromDrag({
      startHeading: 45 * DEG,
      startAngle: 0,
      angle: -30 * DEG,
    }),
    75 * DEG,
  );
  // No movement is no change.
  near(
    headingFromDrag({ startHeading: 123 * DEG, startAngle: 1, angle: 1 }),
    123 * DEG,
  );
});

test('planned actions: zoom, tilt, top-down, north, rotate', () => {
  const base = { heading: 200 * DEG, pitch: -45 * DEG, range: 1_000 };
  const zoomed = planAction(base, 'zoom-in');
  near(zoomed.range, 700);
  assert.equal(zoomed.pitch, base.pitch);
  near(zoomed.heading, base.heading);
  near(planAction(base, 'zoom-out').range, 1_000 / 0.7, 1e-6);

  near(planAction(base, 'tilt-up').pitch, -35 * DEG);
  near(planAction(base, 'tilt-down').pitch, -55 * DEG);
  assert.equal(planAction(base, 'top-down').pitch, TOP_DOWN_PITCH);
  assert.equal(planAction(base, 'north').heading, 0);
  assert.equal(planAction(base, 'north').pitch, base.pitch);
  near(planAction(base, 'rotate-left').heading, 185 * DEG);
  near(planAction(base, 'rotate-right').heading, 215 * DEG);
  // Rotating past north wraps.
  near(
    planAction({ ...base, heading: 5 * DEG }, 'rotate-left').heading,
    350 * DEG,
  );
  // Unknown action: unchanged apart from clamping.
  const unchanged = planAction(base, 'nonsense');
  near(unchanged.heading, base.heading);
  assert.equal(unchanged.pitch, base.pitch);
  assert.equal(unchanged.range, base.range);
});

test('planned tilt stops at both ends however many times it is pressed', () => {
  let view = { heading: 0, pitch: -45 * DEG, range: 5_000 };
  for (let i = 0; i < 20; i++) view = planAction(view, 'tilt-up');
  assert.equal(view.pitch, HORIZON_PITCH);
  for (let i = 0; i < 20; i++) view = planAction(view, 'tilt-down');
  assert.equal(view.pitch, TOP_DOWN_PITCH);
  // Zooming in close drags a near-horizon lean back up from the ground.
  const low = planAction(
    { heading: 0, pitch: HORIZON_PITCH, range: 60 },
    'zoom-in',
  );
  assert.ok(low.range >= MIN_RANGE_M);
  assert.ok(low.range * Math.sin(-low.pitch) >= 8 - 1e-9, 'stays above ground');
});

test('top-down reset twice is stable and north reset keeps the tilt', () => {
  const base = { heading: 90 * DEG, pitch: -20 * DEG, range: 2_000 };
  const once = planAction(base, 'top-down');
  assert.deepEqual(planAction(once, 'top-down'), once);
  assert.equal(planAction(planAction(base, 'north'), 'north').heading, 0);
  assert.equal(planAction(planAction(base, 'north'), 'north').pitch, base.pitch);
});

test('clearance lift raises a buried pitch toward top-down and stops', () => {
  // A hill makes the camera 30 m too low at 10 deg and fine from -30 deg.
  const clearanceAt = (pitch) => (pitch < -30 * DEG ? 50 : -30);
  const lifted = liftPitchForClearance(-10 * DEG, clearanceAt);
  assert.ok(lifted <= -30 * DEG && lifted > -35 * DEG, `lifted to ${lifted}`);
  // Unknown ground (tiles still streaming) never changes the pitch.
  assert.equal(liftPitchForClearance(-10 * DEG, () => Number.NaN), -10 * DEG);
  // Already clear: unchanged.
  assert.equal(liftPitchForClearance(-10 * DEG, () => 500), -10 * DEG);
  // Always buried: ends at top-down instead of looping forever.
  assert.equal(liftPitchForClearance(-10 * DEG, () => -1), TOP_DOWN_PITCH);
});

test('look around turns the gaze in place and clamps the pitch', () => {
  const look = { heading: 10 * DEG, pitch: -45 * DEG };
  near(planLook(look, 'look-left').heading, 7 * DEG);
  near(planLook(look, 'look-right').heading, 13 * DEG);
  near(planLook(look, 'look-up').pitch, -42 * DEG);
  near(planLook(look, 'look-down').pitch, -48 * DEG);
  near(planLook({ heading: 1 * DEG, pitch: 0 }, 'look-left').heading, 358 * DEG);
  let up = look;
  for (let i = 0; i < 100; i++) up = planLook(up, 'look-up');
  assert.equal(up.pitch, LOOK_MAX_PITCH);
  let down = look;
  for (let i = 0; i < 100; i++) down = planLook(down, 'look-down');
  assert.equal(down.pitch, TOP_DOWN_PITCH);
  near(
    planLook({ heading: 0, pitch: Number.NaN }, 'look-up').pitch,
    TOP_DOWN_PITCH + 3 * DEG,
  );
  // A gaze the tilt slider raised past the pad's cap stays there: look-down
  // steps from it, look-up and look-left keep it, nothing passes straight up.
  near(planLook({ heading: 0, pitch: 90 * DEG }, 'look-down').pitch, 87 * DEG);
  near(planLook({ heading: 0, pitch: 60 * DEG }, 'look-left').pitch, 60 * DEG);
  near(planLook({ heading: 0, pitch: 60 * DEG }, 'look-up').pitch, 60 * DEG);
  near(planLook({ heading: 0, pitch: 89 * DEG }, 'look-up').pitch, 89 * DEG);
});

test('ease runs 0 to 1 monotonically and clamps its input', () => {
  assert.equal(easeInOut(-1), 0);
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(2), 1);
  near(easeInOut(0.5), 0.5);
  let last = -1;
  for (let i = 0; i <= 20; i++) {
    const value = easeInOut(i / 20);
    assert.ok(value >= last);
    last = value;
  }
});
