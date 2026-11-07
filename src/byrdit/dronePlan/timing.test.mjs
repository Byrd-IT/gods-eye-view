import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreset } from './presets.js';
import { footprint, writtenSpacingM } from './planner.js';
import {
  INTERVAL_QUICK_FILL_S,
  MAX_TIMED_INTERVAL_S,
  MPH_PER_MS,
  cleanTimedIntervalS,
  effectiveSpeedMs,
  mphToMs,
  msToMph,
  suiteTimingRows,
  timingFigures,
} from './timing.js';

const preset = getPreset('dji-mini-5-pro');
// 80 m nadir on the Mini 5 Pro: the along-track footprint is 80 m.
const ALONG = footprint(preset, 80, 0).alongM;

test('mph and m/s: values computed with a tool (python3, 1 mi = 1609.344 m)', () => {
  assert.equal(MPH_PER_MS, 3600 / 1609.344);
  // 15 mph = 6.7056 m/s, 16 mph = 7.15264 m/s, 10.5 mph = 4.69392 m/s
  assert.ok(Math.abs(mphToMs(15) - 6.7056) < 1e-9);
  assert.ok(Math.abs(mphToMs(16) - 7.15264) < 1e-9);
  assert.ok(Math.abs(mphToMs(10.5) - 4.69392) < 1e-9);
  assert.ok(Math.abs(msToMph(6.7056) - 15) < 1e-9);
  assert.ok(Math.abs(msToMph(7.15264) - 16) < 1e-9);
  // 15 mph is exactly 22 ft/s; 10.5 mph is 15.4 ft/s
  assert.ok(Math.abs(mphToMs(15) / 0.3048 - 22) < 1e-9);
  assert.ok(Math.abs(mphToMs(10.5) / 0.3048 - 15.4) < 1e-9);
});

test('a speed typed as 15 or 16 ft/s is about 10.2 and 10.9 mph, not 15 and 16', () => {
  assert.ok(Math.abs(msToMph(15 * 0.3048) - 10.2273) < 1e-3);
  assert.ok(Math.abs(msToMph(16 * 0.3048) - 10.9091) < 1e-3);
});

test('cleanTimedIntervalS keeps a positive number and drops everything else', () => {
  assert.equal(cleanTimedIntervalS(7), 7);
  assert.equal(cleanTimedIntervalS(6.4), 6.4);
  assert.equal(cleanTimedIntervalS('8'), 8);
  assert.equal(cleanTimedIntervalS(' 12.5 '), 12.5);
  assert.equal(cleanTimedIntervalS(MAX_TIMED_INTERVAL_S), MAX_TIMED_INTERVAL_S);
  for (const bad of [
    0,
    -3,
    NaN,
    Infinity,
    '',
    ' ',
    'abc',
    null,
    undefined,
    true,
    false,
    [],
    {},
    MAX_TIMED_INTERVAL_S + 1,
  ])
    assert.equal(cleanTimedIntervalS(bad), null, String(bad));
});

test('quick-fill values are examples: 5, 7 and 10 s, and nothing asserts them as firmware values', () => {
  assert.deepEqual([...INTERVAL_QUICK_FILL_S], [5, 7, 10]);
});

test('effectiveSpeedMs clamps the way the planner does', () => {
  assert.equal(effectiveSpeedMs(5, preset), 5);
  assert.equal(effectiveSpeedMs(0, preset), 0.1);
  assert.equal(effectiveSpeedMs(99, preset), preset.maxSpeedMs);
  assert.equal(effectiveSpeedMs('x', preset), preset.defaultSpeedMs);
});

test('recommended interval is desired spacing over speed', () => {
  // 80% front: 16 m between photos. At 3.2 m/s that is 5 s.
  const f = timingFigures({
    alongM: ALONG,
    speedMs: 3.2,
    frontOverlapPct: 80,
    minIntervalS: 5,
  });
  assert.ok(Math.abs(f.desiredSpacingM - 16) < 1e-9);
  assert.ok(Math.abs(f.recommendedIntervalS - 5) < 1e-9);
  assert.equal(f.chosen, null);
});

test('a chosen interval gives the resulting front overlap at once', () => {
  const f = timingFigures({
    alongM: ALONG,
    speedMs: 3.2,
    frontOverlapPct: 80,
    timedIntervalS: 7,
    minIntervalS: 5,
  });
  // 3.2 x 7 = 22.4 m -> 1 - 22.4/80 = 72%
  assert.equal(f.chosen.intervalS, 7);
  assert.equal(f.chosen.spacingM, writtenSpacingM(22.4));
  assert.ok(Math.abs(f.chosen.frontPct - 72) < 1e-9);
  assert.ok(Math.abs(f.chosen.shortfallPct - 8) < 1e-9);
  assert.equal(f.chosen.state, 'short');
  assert.equal(f.chosen.underCameraMin, false);
});

test('an interval that is at least as long as needed meets the wanted overlap', () => {
  const f = timingFigures({
    alongM: ALONG,
    speedMs: 3.2,
    frontOverlapPct: 80,
    timedIntervalS: 5,
    minIntervalS: 5,
  });
  assert.equal(f.chosen.state, 'meets');
  assert.ok(f.chosen.frontPct >= 80 - 1e-9);
  const shorter = timingFigures({
    alongM: ALONG,
    speedMs: 3.2,
    frontOverlapPct: 80,
    timedIntervalS: 4,
    minIntervalS: 2,
  });
  assert.equal(shorter.chosen.state, 'meets');
  assert.ok(shorter.chosen.frontPct > 80);
});

test('an interval under the camera minimum is flagged, and the number stays theoretical', () => {
  const f = timingFigures({
    alongM: ALONG,
    speedMs: 3.2,
    frontOverlapPct: 80,
    timedIntervalS: 3,
    minIntervalS: 5,
  });
  assert.equal(f.chosen.underCameraMin, true);
});

test('an interval so long that photos no longer touch is a gap, not a small overlap', () => {
  const f = timingFigures({
    alongM: ALONG,
    speedMs: 10,
    frontOverlapPct: 80,
    timedIntervalS: 10,
    minIntervalS: 5,
  });
  // 100 m between photos on an 80 m footprint
  assert.equal(f.chosen.state, 'gap');
  assert.ok(f.chosen.frontPct < 0);
});

test('fit speed: the fastest 0.1 m/s step that still gives the wanted overlap', () => {
  const f = timingFigures({
    alongM: ALONG,
    speedMs: 3.2,
    frontOverlapPct: 80,
    timedIntervalS: 7,
    minIntervalS: 5,
  });
  // 16 m / 7 s = 2.2857 m/s -> floor to 2.2
  assert.equal(f.chosen.fitSpeedMs, 2.2);
  const check = timingFigures({
    alongM: ALONG,
    speedMs: f.chosen.fitSpeedMs,
    frontOverlapPct: 80,
    timedIntervalS: 7,
    minIntervalS: 5,
  });
  assert.equal(check.chosen.state, 'meets');
});

test('unusable inputs give null, never a made-up number', () => {
  for (const bad of [
    { alongM: 0, speedMs: 3, frontOverlapPct: 80 },
    { alongM: NaN, speedMs: 3, frontOverlapPct: 80 },
    { alongM: 80, speedMs: 0, frontOverlapPct: 80 },
    { alongM: 80, speedMs: 3, frontOverlapPct: NaN },
    { alongM: 80, speedMs: 3, frontOverlapPct: 100 },
  ])
    assert.equal(timingFigures(bad), null, JSON.stringify(bad));
});

test('suite rows: one interval, a different overlap on each pass', () => {
  const nadir = footprint(preset, 80, 0).alongM;
  const oblique = footprint(preset, 50, 45).alongM;
  const rows = suiteTimingRows(
    [
      {
        id: 'nadir',
        label: 'Nadir',
        result: {
          plan: {
            speedMs: 3,
            footprint: { alongM: nadir },
            options: { frontOverlap: 80, pattern: 'grid' },
          },
        },
      },
      {
        id: 'oblique45',
        label: 'Oblique',
        result: {
          plan: {
            speedMs: 2,
            footprint: { alongM: oblique },
            options: { frontOverlap: 80, pattern: 'double' },
          },
        },
      },
      {
        id: 'orbit',
        label: 'Orbit',
        result: {
          plan: {
            speedMs: 2,
            footprint: { alongM: 10 },
            options: { frontOverlap: 80, pattern: 'orbit' },
          },
        },
      },
      { id: 'failed', label: 'Failed', result: null },
    ],
    7,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['nadir', 'oblique45'],
    'orbits keep their own spacing; failed passes have no numbers',
  );
  assert.ok(Math.abs(rows[0].frontPct - (1 - 21 / nadir) * 100) < 0.2);
  assert.ok(Math.abs(rows[1].frontPct - (1 - 14 / oblique) * 100) < 0.2);
  assert.notEqual(
    Math.round(rows[0].frontPct),
    Math.round(rows[1].frontPct),
    'the passes differ',
  );
  assert.equal(rows[0].speedMs, 3);
  assert.equal(suiteTimingRows([], 7).length, 0);
  assert.equal(suiteTimingRows(null, 7).length, 0);
  assert.equal(suiteTimingRows([{ id: 'a', result: null }], null).length, 0);
  // No interval chosen: each pass still says the interval it would need.
  const bare = suiteTimingRows(
    [
      {
        id: 'nadir',
        label: 'Nadir',
        result: {
          plan: {
            speedMs: 3,
            footprint: { alongM: nadir },
            options: { frontOverlap: 80, pattern: 'grid' },
          },
        },
      },
    ],
    null,
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0].frontPct, null);
  assert.equal(bare[0].state, null);
  assert.ok(Math.abs(bare[0].recommendedIntervalS - (nadir * 0.2) / 3) < 1e-9);
});

test('fit speed: after the 0.1 m rounding the written spacing never exceeds the wanted spacing', () => {
  let checked = 0;
  for (const alongM of [8, 11.3, 15.7, 24.9, 40.2, 80, 133.3])
    for (const frontOverlapPct of [60, 70, 75, 80, 85, 90])
      for (const timedIntervalS of [0.5, 1, 2, 2.5, 3, 5, 7, 10, 13.7]) {
        const speedMs = 15;
        const f = timingFigures({ alongM, speedMs, frontOverlapPct, timedIntervalS });
        const fit = f.chosen.fitSpeedMs;
        if (fit == null) {
          // Only when even 0.1 m/s writes more than the wanted spacing.
          assert.ok(
            writtenSpacingM(0.1 * timedIntervalS) > f.desiredSpacingM + 1e-9 ||
              f.desiredSpacingM < 0.1,
            `no fit but one exists: ${alongM} ${frontOverlapPct} ${timedIntervalS}`,
          );
          continue;
        }
        const label = `${alongM} ${frontOverlapPct} ${timedIntervalS} -> ${fit}`;
        assert.ok(writtenSpacingM(fit * timedIntervalS) <= f.desiredSpacingM + 1e-9, label);
        const after = timingFigures({ alongM, speedMs: fit, frontOverlapPct, timedIntervalS });
        assert.equal(after.chosen.state, 'meets', label);
        // And it is the fastest step: 0.1 m/s faster would be short.
        const fasterMs = Number((fit + 0.1).toFixed(1));
        const faster = timingFigures({
          alongM,
          speedMs: fasterMs,
          frontOverlapPct,
          timedIntervalS,
        });
        assert.ok(
          writtenSpacingM(fasterMs * timedIntervalS) > f.desiredSpacingM + 1e-9 ||
            faster.chosen.state === 'meets',
          label,
        );
        checked++;
      }
  assert.ok(checked > 200);
});

test('fit speed: a small footprint where rounding up used to leave the plan short', () => {
  // Wanted spacing 10.07 m at a 1.017 s interval. The old fit, 9.9 m/s, is 10.068 m, which the
  // file writes as 10.1 m: short by 0.03 m, so the same offer would have come back.
  const f = timingFigures({
    alongM: 50.35,
    speedMs: 15,
    frontOverlapPct: 80,
    timedIntervalS: 1.017,
  });
  assert.ok(Math.abs(f.desiredSpacingM - 10.07) < 1e-9);
  assert.ok(writtenSpacingM(9.9 * 1.017) > f.desiredSpacingM, 'the old fit of 9.9 m/s wrote 10.1 m');
  assert.ok(f.chosen.fitSpeedMs < 9.9, String(f.chosen.fitSpeedMs));
  const after = timingFigures({
    alongM: 50.35,
    speedMs: f.chosen.fitSpeedMs,
    frontOverlapPct: 80,
    timedIntervalS: 1.017,
  });
  assert.equal(after.chosen.state, 'meets');
});

test('fit speed: null when even the slowest plan speed writes more than the wanted spacing', () => {
  // Wanted 0.8 m, interval 10 s: 0.1 m/s still writes 1.0 m.
  const f = timingFigures({
    alongM: 4,
    speedMs: 3,
    frontOverlapPct: 80,
    timedIntervalS: 10,
  });
  assert.equal(f.chosen.fitSpeedMs, null);
});

test('suite rows: a pass with incomplete terrain heights is unknown, not a made-up overlap', () => {
  const nadir = footprint(preset, 80, 0).alongM;
  const pass = (id, terrainComplete) => ({
    id,
    label: id,
    result: {
      terrainComplete,
      plan: {
        speedMs: 3,
        footprint: { alongM: nadir },
        options: { frontOverlap: 80, pattern: 'grid' },
      },
    },
  });
  for (const interval of [7, null]) {
    const rows = suiteTimingRows(
      [pass('good', true), pass('bad', false), pass('legacy', undefined)],
      interval,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by.bad.unknown, true);
    assert.equal(by.bad.frontPct, null);
    assert.equal(by.bad.recommendedIntervalS, null);
    assert.equal(by.bad.state, null);
    assert.equal(by.good.unknown, false);
    assert.ok(by.good.recommendedIntervalS > 0);
    assert.equal(by.legacy.unknown, false, 'only an explicit false is unknown');
  }
});
