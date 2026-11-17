/**
 * Plain-grid gimbal angle (Brandon 2026-11-17): the planner, the areas
 * planner, the recommendation, the saved plan and the README all use the
 * angle the person set. Default -90 keeps every older plan and file the same.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleMissions,
  footprint,
  normalizeOptions,
  planFlight,
  shallowestGridPitchDeg,
  surveyPitchDeg,
  surveyTiltDeg,
} from './planner.js';
import { listPresets, getPreset } from './presets.js';
import { recommend, recommendedOptions } from './recommend.js';
import { readPlan, serializePlan } from './planDoc.js';
import { buildMissionFiles, readmeText } from './wpml.js';
import { planAreas } from './areas.js';
import { metersPerDegree } from './geo.js';
import { suiteOptions } from './suite.js';

const box = (() => {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - 150 / m.lon,
    east: -97.77 + 150 / m.lon,
    south: 30.27 - 100 / m.lat,
    north: 30.27 + 100 / m.lat,
  };
})();

const waypointsOf = (plan) => plan.legs.flatMap((l) => l.waypoints);

test('shallowest grid angle: on the 5 degree step, never past the horizon limit', () => {
  for (const preset of listPresets()) {
    const p = shallowestGridPitchDeg(preset);
    assert.ok(p <= -30 && p >= -90, `${preset.id}: ${p}`);
    assert.equal(Math.abs(p % 5), 0);
    assert.doesNotThrow(() => footprint(preset, 80, 90 + p), preset.id);
    // One step shallower would reach the horizon (or pass -30).
    if (p < -30) {
      assert.throws(() => footprint(preset, 80, 90 + p + 5), RangeError);
    }
  }
  assert.equal(shallowestGridPitchDeg(getPreset('dji-mini-5-pro')), -35);
});

test('normalizeOptions: grid angle default -90, held to -90 .. shallowest, on the step', () => {
  const n = (v) => normalizeOptions({ gridPitchDeg: v }).options.gridPitchDeg;
  assert.equal(normalizeOptions({}).options.gridPitchDeg, -90);
  assert.equal(n(undefined), -90);
  assert.equal(n('nope'), -90);
  assert.equal(n(-100), -90);
  assert.equal(n(-20), -35);
  assert.equal(n(-62), -60);
  assert.equal(n(-75), -75);
});

test('surveyPitchDeg / surveyTiltDeg follow the pattern', () => {
  assert.equal(surveyPitchDeg({ pattern: 'grid' }), -90);
  assert.equal(surveyPitchDeg({ pattern: 'grid', gridPitchDeg: -60 }), -60);
  assert.equal(
    surveyPitchDeg({ pattern: 'double', tiltPitchDeg: -75, gridPitchDeg: -50 }),
    -75,
  );
  assert.equal(surveyPitchDeg({ pattern: 'orbit' }), null);
  assert.equal(surveyTiltDeg({ pattern: 'grid', gridPitchDeg: -60 }), 30);
  assert.equal(surveyTiltDeg({ pattern: 'orbit' }), 0);
});

test('planFlight: a -90 grid is the same plan as before the setting existed', () => {
  const before = planFlight(box, { aglM: 80 });
  const after = planFlight(box, { aglM: 80, gridPitchDeg: -90 });
  assert.ok(!before.error && !after.error);
  assert.deepEqual(
    waypointsOf(after).map((w) => [w.lon, w.lat, w.pitchDeg]),
    waypointsOf(before).map((w) => [w.lon, w.lat, w.pitchDeg]),
  );
  for (const wp of waypointsOf(after)) assert.equal(wp.pitchDeg, -90);
});

test('planFlight: a tilted grid flies the set angle, uses the tilted footprint and looks ahead', () => {
  const nadir = planFlight(box, { aglM: 80 });
  for (const capture of ['stop', 'distance', 'timed']) {
    const tilted = planFlight(box, {
      aglM: 80,
      gridPitchDeg: -60,
      captureMode: capture,
      timedIntervalS: 5,
    });
    assert.ok(!tilted.error, String(tilted.error));
    assert.equal(tilted.options.gridPitchDeg, -60);
    for (const leg of tilted.legs) assert.equal(leg.pitchDeg, -60, capture);
    for (const wp of waypointsOf(tilted)) assert.equal(wp.pitchDeg, -60, capture);
  }
  const tilted = planFlight(box, { aglM: 80, gridPitchDeg: -60 });
  // The tilted footprint is wider across, so the lines are further apart.
  const fp0 = footprint(getPreset('dji-mini-5-pro'), 80, 0);
  const fp30 = footprint(getPreset('dji-mini-5-pro'), 80, 30);
  assert.ok(fp30.acrossM > fp0.acrossM);
  assert.ok(tilted.legs.length <= nadir.legs.length);
  // Lines are shifted back by the look-ahead (80 m * tan 30 deg = 46 m), so
  // the camera, not the drone, covers the box edge.
  const m = metersPerDegree(30.27);
  const outsideM = (p) =>
    Math.max(
      ...waypointsOf(p).map((w) =>
        Math.max(0, box.west - w.lon, w.lon - box.east) * m.lon,
      ),
    );
  assert.ok(outsideM(nadir) < 1, String(outsideM(nadir)));
  assert.ok(outsideM(tilted) > 40, String(outsideM(tilted)));
});

test('KMZ: every waypoint of a tilted timed grid writes the set gimbal pitch', () => {
  const plan = planFlight(box, {
    aglM: 80,
    gridPitchDeg: -45,
    captureMode: 'timed',
    timedIntervalS: 5,
    batteryMin: 60,
  });
  const result = assembleMissions(plan, { known: false });
  assert.ok(result.missions.length >= 1);
  for (const mission of result.missions) {
    const { waylinesWpml: xml } = buildMissionFiles(mission, result.plan);
    const marks = xml.split('<Placemark>').slice(1);
    assert.ok(marks.length >= 2);
    for (const m of marks) {
      assert.match(
        m,
        /<wpml:waypointGimbalPitchAngle>-45<\/wpml:waypointGimbalPitchAngle>/,
      );
      const rotates = [
        ...m.matchAll(
          /<wpml:gimbalPitchRotateAngle>([^<]+)<\/wpml:gimbalPitchRotateAngle>/g,
        ),
      ].map((x) => x[1]);
      assert.ok(rotates.length >= 1, 'a gimbal command on every waypoint');
      for (const p of rotates) assert.equal(p, '-45');
    }
  }
  const readme = readmeText(result, new Date(0));
  assert.match(readme, /Gimbal: -45 deg at every waypoint\. Check the gimbal angle in DJI Fly/);
});

test('README: a straight-down grid says -90 and the DJI Fly check', () => {
  const result = assembleMissions(planFlight(box, { aglM: 80 }), {
    known: false,
  });
  assert.match(readmeText(result, new Date(0)), /Gimbal: -90 deg at every waypoint/);
});

test('recommend: every survey mode recommends a straight-down grid; Use Recommended resets it', () => {
  const preset = getPreset('dji-mini-5-pro');
  for (const mode of ['mapping-grid', 'mapping-grid-timed', 'fast-survey']) {
    const rec = recommend(preset, mode);
    assert.equal(rec.gridPitchDeg, -90, mode);
    assert.equal(recommendedOptions(rec).gridPitchDeg, -90, mode);
    assert.equal(recommendedOptions(rec).tiltPitchDeg, -60, mode);
  }
});

test('PLAN ALL: the nadir pass stays straight down whatever the grid angle is', () => {
  const passes = suiteOptions({ presetId: 'dji-mini-5-pro', gridPitchDeg: -50 });
  const nadir = passes.find((p) => p.id === 'nadir');
  assert.equal(nadir.options.gridPitchDeg, -90);
});

test('saved plan: the grid angle is kept; a non-number is dropped', () => {
  const state = {
    areas: [],
    nextArea: 1,
    jobGrouping: 'per-area',
    takeoff: null,
    options: { pattern: 'grid', gridPitchDeg: -55, aglM: 80 },
  };
  const doc = JSON.parse(JSON.stringify(serializePlan(state, {})));
  assert.equal(doc.options.gridPitchDeg, -55);
  assert.equal(readPlan(doc).options.gridPitchDeg, -55);
  doc.options.gridPitchDeg = 'x';
  assert.equal(readPlan(doc).options.gridPitchDeg, undefined);
});

test('areas: a polygon with a tilted grid plans at the set angle', () => {
  const m = metersPerDegree(30.27);
  const ring = [
    [-97.77 - 120 / m.lon, 30.27 - 80 / m.lat],
    [-97.77 + 120 / m.lon, 30.27 - 80 / m.lat],
    [-97.77, 30.27 + 90 / m.lat],
  ].map(([lon, lat]) => ({ lon, lat }));
  const plan = planAreas(
    [{ id: 'a1', name: 'Area 1', kind: 'polygon', ring }],
    { aglM: 60, gridPitchDeg: -70 },
  );
  assert.ok(!plan.error, String(plan.error ?? plan.message));
  const wps = plan.legs.flatMap((l) => l.waypoints);
  assert.ok(wps.length > 0);
  for (const wp of wps) assert.equal(wp.pitchDeg, -70);
});
