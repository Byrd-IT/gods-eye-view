import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alongAtHeightFn,
  fractionOnRange,
  frontOverlapPct,
  heightForOverlap,
  intervalForOverlap,
  linkedMarks,
  nearestTickIndex,
  speedForOverlap,
  tickPosition,
} from './linkedControls.js';
import { effectivePreset } from './cameraLimits.js';
import { AGL_CAP_M, MIN_AGL_M, footprint } from './planner.js';
import { getPreset } from './presets.js';

const mini = getPreset('dji-mini-5-pro');
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// Mini 5 Pro, nadir: along-track footprint is exactly the height (8.8 mm
// sensor height over 8.8 mm focal length), so the arithmetic below can be
// checked by hand: at 80 m along = 80 m.
const OPTIONS_12 = [2, 3, 5, 7, 10, 15, 20, 30, 60];
const OPTIONS_50 = [5, 7, 10, 15, 20, 30, 60];

test('overlap given by speed and interval: 5 m/s x 5 s at 80 m is 68.75 %', () => {
  close(frontOverlapPct({ alongM: 80, speedMs: 5, intervalS: 5 }), 68.75);
  // The along value really is the planner's footprint.
  close(footprint(mini, 80, 0).alongM, 80);
});

test('speed that gives the wanted overlap: (1 - w) x along / interval', () => {
  close(speedForOverlap({ alongM: 80, wantedPct: 80, intervalS: 5 }), 3.2);
  close(speedForOverlap({ alongM: 80, wantedPct: 70, intervalS: 3 }), 8);
});

test('interval that gives the wanted overlap: (1 - w) x along / speed', () => {
  close(intervalForOverlap({ alongM: 80, wantedPct: 80, speedMs: 5 }), 3.2);
  close(intervalForOverlap({ alongM: 80, wantedPct: 75, speedMs: 4 }), 5);
});

test('round trip: apply the marked speed and the overlap equals the wanted one', () => {
  for (const alongM of [40, 80, 123.4, 300]) {
    for (const wanted of [50, 70, 80, 90, 98]) {
      for (const intervalS of [2, 3, 5, 7.5, 10, 60]) {
        const v = speedForOverlap({ alongM, wantedPct: wanted, intervalS });
        close(frontOverlapPct({ alongM, speedMs: v, intervalS }), wanted, 1e-9);
        const t = intervalForOverlap({ alongM, wantedPct: wanted, speedMs: v });
        close(t, intervalS, 1e-9);
      }
    }
  }
});

test('unreadable or impossible inputs give no figure', () => {
  const bad = [0, -1, NaN, null, undefined, '', 'x', Infinity];
  for (const x of bad) {
    assert.equal(
      frontOverlapPct({ alongM: x, speedMs: 5, intervalS: 5 }),
      null,
    );
    assert.equal(
      frontOverlapPct({ alongM: 80, speedMs: x, intervalS: 5 }),
      null,
    );
    assert.equal(
      frontOverlapPct({ alongM: 80, speedMs: 5, intervalS: x }),
      null,
    );
    assert.equal(
      speedForOverlap({ alongM: x, wantedPct: 80, intervalS: 5 }),
      null,
    );
    assert.equal(
      speedForOverlap({ alongM: 80, wantedPct: 80, intervalS: x }),
      null,
    );
    assert.equal(
      intervalForOverlap({ alongM: 80, wantedPct: 80, speedMs: x }),
      null,
    );
  }
  // A wanted overlap of 0, 100 or more has no spacing to solve for.
  for (const w of [0, -5, 100, 120, NaN, null]) {
    assert.equal(
      speedForOverlap({ alongM: 80, wantedPct: w, intervalS: 5 }),
      null,
    );
    assert.equal(
      intervalForOverlap({ alongM: 80, wantedPct: w, speedMs: 5 }),
      null,
    );
  }
});

test('height: inverts the planner footprint numerically (nadir)', () => {
  const alongAt = alongAtHeightFn(mini, 0);
  const r = heightForOverlap({
    alongAt,
    minM: MIN_AGL_M,
    maxM: AGL_CAP_M,
    speedMs: 5,
    intervalS: 5,
    wantedPct: 80,
  });
  // spacing 25 m at 80 % wanted -> along 125 m -> 125 m high for this sensor.
  assert.equal(r.status, 'inside');
  close(r.valueM, 125, 1e-6);
  // Round trip: at that height the plan gives the wanted overlap.
  close(
    frontOverlapPct({ alongM: alongAt(r.valueM), speedMs: 5, intervalS: 5 }),
    80,
    1e-6,
  );
});

test('height: also inverts a tilted (double grid) footprint', () => {
  for (const tiltDeg of [20, 30]) {
    const alongAt = alongAtHeightFn(mini, tiltDeg);
    const r = heightForOverlap({
      alongAt,
      minM: MIN_AGL_M,
      maxM: AGL_CAP_M,
      speedMs: 4,
      intervalS: 6,
      wantedPct: 75,
    });
    assert.equal(r.status, 'inside');
    close(alongAt(r.valueM), (4 * 6) / 0.25, 1e-6);
  }
});

test('height: pins at the slider ends and says which', () => {
  const alongAt = alongAtHeightFn(mini, 0);
  const common = { alongAt, minM: MIN_AGL_M, maxM: AGL_CAP_M, wantedPct: 80 };
  const low = heightForOverlap({ ...common, speedMs: 0.1, intervalS: 2 });
  assert.deepEqual(low, { valueM: MIN_AGL_M, status: 'below' });
  const high = heightForOverlap({ ...common, speedMs: 15, intervalS: 60 });
  assert.deepEqual(high, { valueM: AGL_CAP_M, status: 'above' });
});

test('height: no solution for an unreadable input or a throwing footprint', () => {
  const alongAt = alongAtHeightFn(mini, 0);
  const base = {
    alongAt,
    minM: 10,
    maxM: 100,
    speedMs: 5,
    intervalS: 5,
    wantedPct: 80,
  };
  assert.equal(heightForOverlap({ ...base, speedMs: 0 }), null);
  assert.equal(heightForOverlap({ ...base, intervalS: null }), null);
  assert.equal(heightForOverlap({ ...base, wantedPct: 100 }), null);
  assert.equal(heightForOverlap({ ...base, minM: 100, maxM: 10 }), null);
  assert.equal(heightForOverlap({ ...base, alongAt: undefined }), null);
  // A tilt that reaches the horizon throws in footprint(): no mark, no throw.
  assert.equal(
    heightForOverlap({ ...base, alongAt: alongAtHeightFn(mini, 80) }),
    null,
  );
});

test('12 MP changes nothing in the height solution (same field of view)', () => {
  const e12 = effectivePreset(mini, 'test-12mp');
  const a = alongAtHeightFn(e12, 0);
  const b = alongAtHeightFn(mini, 0);
  for (const h of [10, 80, 200, 457.2]) close(a(h), b(h));
});

test('even tick scale: position by interpolation between neighbouring ticks', () => {
  assert.deepEqual(tickPosition(OPTIONS_12, 2), { index: 0, status: 'inside' });
  assert.deepEqual(tickPosition(OPTIONS_12, 60), {
    index: 8,
    status: 'inside',
  });
  assert.deepEqual(tickPosition(OPTIONS_12, 3), { index: 1, status: 'inside' });
  // 6.2 s lies between 5 s (index 2) and 7 s (index 3): 2 + 1.2/2 = 2.6.
  const p = tickPosition(OPTIONS_12, 6.2);
  assert.equal(p.status, 'inside');
  close(p.index, 2.6);
  // 40 s lies between 30 s (index 7) and 60 s (index 8): 7 + 10/30.
  close(tickPosition(OPTIONS_12, 40).index, 7 + 1 / 3);
  assert.deepEqual(tickPosition(OPTIONS_50, 1), { index: 0, status: 'below' });
  assert.deepEqual(tickPosition(OPTIONS_50, 61), { index: 6, status: 'above' });
  assert.equal(tickPosition([], 5), null);
  assert.equal(tickPosition(OPTIONS_12, NaN), null);
});

test('nearest tick for a typed value; ties go to the shorter interval', () => {
  assert.equal(nearestTickIndex(OPTIONS_12, 6), 2); // |6-5|=1 < |6-7|=1 tie -> shorter
  assert.equal(nearestTickIndex(OPTIONS_12, 6.1), 3);
  assert.equal(nearestTickIndex(OPTIONS_12, 0.5), 0);
  assert.equal(nearestTickIndex(OPTIONS_12, 500), 8);
  assert.equal(nearestTickIndex(OPTIONS_12, 12), 4); // |12-10|=2 < |12-15|=3
  assert.equal(nearestTickIndex([], 5), -1);
  assert.equal(nearestTickIndex(OPTIONS_12, 'x'), -1);
});

test('fraction on a range is pinned to 0..1', () => {
  assert.equal(fractionOnRange(5, 0, 10), 0.5);
  assert.equal(fractionOnRange(-5, 0, 10), 0);
  assert.equal(fractionOnRange(50, 0, 10), 1);
  assert.equal(fractionOnRange(5, 10, 10), null);
  assert.equal(fractionOnRange(NaN, 0, 10), null);
});

const RANGES = {
  speedRange: { min: 0.1, max: 15, step: 0.1 },
  overlapRange: { min: 50, max: 98, step: 0.5 },
  heightRange: { min: MIN_AGL_M, max: AGL_CAP_M, step: 0.2 },
  intervalOptions: OPTIONS_12,
};
const marks = (over = {}) =>
  linkedMarks({
    alongM: 80,
    speedMs: 5,
    intervalS: 5,
    frontOverlapPct: 80,
    aglM: 80,
    alongAt: alongAtHeightFn(mini, 0),
    ...RANGES,
    ...over,
  });

test('all four marks for 5 m/s, 5 s, 80 m, 80 % wanted', () => {
  const m = marks();
  // Overlap the settings give: 68.75 %, on the 50..98 slider.
  close(m.overlap.value, 68.75);
  close(m.overlap.fraction, (68.75 - 50) / 48);
  assert.equal(m.overlap.status, 'inside');
  assert.equal(m.overlap.matches, false);
  // Speed that gives 80 %: 3.2 m/s.
  close(m.speed.value, 3.2);
  close(m.speed.fraction, (3.2 - 0.1) / 14.9);
  // Interval that gives 80 %: 3.2 s, between 3 s (index 1) and 5 s (index 2).
  close(m.interval.value, 3.2);
  close(m.interval.index, 1.1);
  close(m.interval.fraction, 1.1 / 8);
  // Height that gives 80 %: 125 m.
  close(m.height.value, 125, 1e-6);
  assert.equal(m.height.status, 'inside');
});

test('marks pin at the ends and carry their status', () => {
  // Wanted 98 % at 15 m/s and 2 s needs a 1500 m footprint: above the cap.
  const m = marks({ speedMs: 15, intervalS: 2, frontOverlapPct: 98 });
  assert.equal(m.height.status, 'above');
  assert.equal(m.height.fraction, 1);
  // The overlap given is 62.5 % at 80 m: inside; at 20 m: a gap (< 0 %).
  const gap = marks({ alongM: 20, speedMs: 15, intervalS: 5 });
  assert.equal(gap.overlap.status, 'below');
  assert.equal(gap.overlap.fraction, 0);
  assert.ok(gap.overlap.value < 0);
  // A speed that needs 40 m/s: above this slider's top.
  const fast = marks({ intervalS: 1, alongM: 400, frontOverlapPct: 90 });
  assert.equal(fast.speed.status, 'above');
  assert.equal(fast.speed.fraction, 1);
  assert.ok(fast.speed.value > 15);
  // An interval needed under the shortest option pins at the first tick.
  const quick = marks({ speedMs: 15, frontOverlapPct: 90 });
  assert.equal(quick.interval.status, 'below');
  assert.equal(quick.interval.index, 0);
  assert.equal(quick.interval.fraction, 0);
  // And one over the longest pins at the last tick.
  const slow = marks({ speedMs: 0.1, frontOverlapPct: 50 });
  assert.equal(slow.interval.status, 'above');
  assert.equal(slow.interval.fraction, 1);
});

test('"matches" when the thumb is within one step of its mark', () => {
  // 80 % wanted, 4 m/s, 4 s at 80 m: overlap given is 80 %, speed needs 4,
  // interval needs 4 s (nearest tick 3 s or 5 s: tie, shorter 3 s; mark 1.5).
  const m = marks({ speedMs: 4, intervalS: 4, frontOverlapPct: 80 });
  assert.equal(m.overlap.matches, true);
  assert.equal(m.speed.matches, true);
  assert.equal(m.height.matches, true);
  assert.equal(m.interval.matches, true);
  // Off by more than a step: no match.
  const off = marks({ speedMs: 4.3, intervalS: 4, frontOverlapPct: 80 });
  assert.equal(off.speed.matches, false);
  assert.equal(off.overlap.matches, false);
  // A pinned mark never says matches.
  const pinned = marks({ speedMs: 15, frontOverlapPct: 90 });
  assert.equal(pinned.interval.matches, false);
});

test('unreadable inputs give no marks, and the others stay independent', () => {
  const none = marks({ speedMs: 0 });
  assert.equal(none.overlap, null);
  assert.equal(none.speed.status, 'inside'); // needs interval + along + wanted only
  assert.equal(none.interval, null);
  assert.equal(none.height, null);
  const noInterval = marks({ intervalS: null });
  assert.equal(noInterval.overlap, null);
  assert.equal(noInterval.speed, null);
  assert.equal(noInterval.height, null);
  assert.ok(noInterval.interval);
  const noAlong = marks({ alongM: NaN });
  assert.deepEqual(
    [noAlong.overlap, noAlong.speed, noAlong.interval],
    [null, null, null],
  );
  // A footprint that throws: only the height mark is lost.
  const throwing = marks({
    alongAt: () => {
      throw new RangeError('Camera tilt reaches the horizon');
    },
  });
  assert.equal(throwing.height, null);
  assert.ok(throwing.speed);
});

test('mark values do not depend on the photo size (same field of view)', () => {
  const a = marks({ intervalOptions: OPTIONS_12 });
  const b = marks({ intervalOptions: OPTIONS_50 });
  close(a.speed.value, b.speed.value);
  close(a.height.value, b.height.value);
  // Only the tick position follows the option list.
  assert.notEqual(a.interval.index, b.interval.index);
});
