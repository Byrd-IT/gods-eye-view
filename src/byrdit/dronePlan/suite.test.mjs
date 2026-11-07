import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleAreaPlan, planAreas } from './areas.js';
import { readZip } from './zip.js';
import { SUITE_PASSES, buildSuiteZip, suiteOptions } from './suite.js';

const box = { west: -94.9, east: -94.898, south: 32.58, north: 32.582 };
const area = { id: 'a1', name: 'Field', kind: 'rect', box };
const flat = (plan) => ({
  known: true, complete: true, takeoffM: 100,
  wpM: plan.legs.flatMap((l) => l.waypoints).map(() => 100),
});

function runAll(presetId) {
  return suiteOptions({ presetId }).map((p) => {
    const plan = planAreas([area], p.options);
    assert.ok(!plan.error, `${p.id}: ${plan.error}`);
    const pts = plan.legs.flatMap((l) => l.waypoints);
    const byId = [];
    pts.forEach((w, i) => { byId[w.id] = 100; });
    const result = assembleAreaPlan(plan, { ...flat(plan), wpM: byId });
    return { id: p.id, label: p.label, options: p.options, result };
  });
}

test('suite passes keep interval settings and do not invent them', () => {
  const o = suiteOptions({
    presetId: 'dji-mini-5-pro',
    batteryMin: 20,
    direction: 'ns',
    maxWaypoints: 40,
    captureMode: 'distance',
    photoSpacingM: 8,
    continuousRoute: true,
    usableBatteryMin: 16,
  });
  assert.equal(o.length, SUITE_PASSES.length);
  assert.ok(o.every((p) => p.options.captureMode === 'distance'));
  assert.ok(o.every((p) => p.options.photoSpacingM === 8));
  assert.ok(o.every((p) => p.options.continuousRoute === true));
  assert.ok(o.every((p) => p.options.usableBatteryMin === 16));
  assert.ok(o.every((p) => p.options.maxWaypoints === 40));
  assert.ok(o.every((p) => p.options.batteryMin === 20));
  assert.ok(o.every((p) => p.options.direction === 'ns'));
  assert.equal(o[0].options.pattern, 'grid');
  assert.equal(o[1].options.pattern, 'double');
  assert.equal(o[1].options.tiltPitchDeg, -60);
  assert.equal(o[2].options.aglM, 50);
  assert.equal(o[3].options.pattern, 'orbit');

  const off = suiteOptions({
    presetId: 'dji-mini-5-pro',
    continuousRoute: false,
    photoSpacingM: 0,
  });
  assert.ok(off.every((p) => p.options.continuousRoute === false));
  assert.ok(off.every((p) => p.options.photoSpacingM === 0));

  const legacy = suiteOptions({ presetId: 'dji-mini-5-pro', batteryMin: 20 });
  for (const p of legacy) {
    assert.equal(p.options.batteryMin, 20);
    assert.equal(p.options.pattern, p.id === 'nadir' ? 'grid' : p.id === 'orbit' ? 'orbit' : 'double');
    for (const key of ['captureMode', 'photoSpacingM', 'continuousRoute', 'usableBatteryMin', 'maxWaypoints', 'intervalTriggerProven', 'minPhotoIntervalS', 'timedIntervalS']) {
      assert.equal(Object.hasOwn(p.options, key), false, `${p.id} ${key}`);
    }
  }
});

test('suiteOptions gives every pass the chosen Timed-shot interval, each with its own speed', () => {
  const o = suiteOptions({
    presetId: 'dji-mini-5-pro',
    captureMode: 'timed',
    timedIntervalS: 7,
  });
  assert.ok(o.every((p) => p.options.timedIntervalS === 7));
  assert.ok(o.every((p) => p.options.captureMode === 'timed'));
  assert.ok(new Set(o.map((p) => p.options.speedMs)).size > 1, 'passes keep their own speeds');
});

test('suiteOptions gives one recommended set per pass', () => {
  const o = suiteOptions({ presetId: 'dji-mini-5-pro', batteryMin: 20 });
  assert.deepEqual(o.map((p) => p.id), SUITE_PASSES.map((p) => p.id));
  assert.equal(o[0].options.pattern, 'grid');
  assert.equal(o[1].options.pattern, 'double');
  assert.equal(o[1].options.tiltPitchDeg, -60);
  assert.equal(o[2].options.tiltPitchDeg, -45);
  assert.equal(o[2].options.aglM, 50);
  assert.equal(o[3].options.pattern, 'orbit');
  assert.ok(o.every((p) => p.options.batteryMin === 20));
  assert.ok(o.every((p) => p.options.speedMs > 0));
  assert.deepEqual(suiteOptions({ presetId: 'nope' }), []);
});

test('every pass plans and the ZIP has a folder per pass', () => {
  const passes = runAll('dji-mini-5-pro');
  for (const p of passes) {
    assert.ok(p.result.missions.length >= 1, p.id);
    assert.ok(p.result.missions.every((m) => m.waypointCount <= 200), p.id);
  }
  const zip = readZip(buildSuiteZip(passes, { when: new Date('2026-10-29T12:00:00') }));
  const names = [...zip.keys()];
  assert.ok(names.includes('README.txt'));
  for (let i = 0; i < passes.length; i += 1) {
    assert.ok(names.some((n) => n.startsWith(`pass-${i + 1}-${passes[i].id}/`) && n.endsWith('.kmz')), passes[i].id);
  }
  assert.equal(new Set(names).size, names.length);
});

test('a pass that failed to plan is listed, not zipped', () => {
  const passes = runAll('dji-mini-5-pro');
  passes[1] = { ...passes[1], result: null, error: 'bad-box' };
  const names = [...readZip(buildSuiteZip(passes)).keys()];
  assert.ok(!names.some((n) => n.startsWith('pass-2-')));
  const readme = new TextDecoder().decode(readZip(buildSuiteZip(passes)).get('README.txt'));
  assert.match(readme, /NOT PLANNED/);
});

test('a generated suite plan gets usableBatteryMin 20 and the folder README lists it', () => {
  const pass = suiteOptions({ presetId: 'dji-mini-5-pro' })[0];
  assert.equal(Object.hasOwn(pass.options, 'usableBatteryMin'), false);
  const plan = planAreas([area], pass.options);
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.options.usableBatteryMin, 20);
  assert.equal(plan.options.captureMode, 'stop');
  const pts = plan.legs.flatMap((l) => l.waypoints);
  const byId = [];
  pts.forEach((w) => { byId[w.id] = 100; });
  const result = assembleAreaPlan(plan, { known: true, complete: true, takeoffM: 100, wpM: byId });
  const zip = readZip(buildSuiteZip(
    [{ id: pass.id, label: pass.label, options: pass.options, result }],
    { when: new Date('2026-10-29T12:00:00Z') },
  ));
  const folder = new TextDecoder().decode(zip.get('pass-1-nadir/README.txt'));
  assert.match(folder, /Requested mode: A stop/);
  assert.match(folder, /Camera settings \(set in DJI Fly/);
  assert.match(folder, /Waypoint cap: /);
  assert.match(folder, /Pause markers are not estimated/);
  const top = new TextDecoder().decode(zip.get('README.txt'));
  assert.match(top, /not one battery/);
  assert.match(top, /estimated battery breaks/);
  assert.match(top, /Camera settings are in each folder README/);
});

test('suite passes do not copy intervalTriggerProven from the panel', () => {
  const on = suiteOptions({
    presetId: 'dji-mini-5-pro',
    intervalTriggerProven: true,
  });
  assert.ok(on.every((p) => Object.hasOwn(p.options, 'intervalTriggerProven') === false));
  const off = suiteOptions({
    presetId: 'dji-mini-5-pro',
    intervalTriggerProven: false,
  });
  assert.ok(off.every((p) => Object.hasOwn(p.options, 'intervalTriggerProven') === false));
  const missing = suiteOptions({ presetId: 'dji-mini-5-pro' });
  assert.ok(missing.every((p) => Object.hasOwn(p.options, 'intervalTriggerProven') === false));
});

test('suite passes carry a custom camera minimum into planner speedLimits', () => {
  const passes = suiteOptions({
    presetId: 'dji-mini-5-pro',
    minPhotoIntervalS: 10,
    captureMode: 'stop',
  });
  assert.ok(passes.every((p) => p.options.minPhotoIntervalS === 10));
  const plan = planAreas([area], passes[0].options);
  assert.equal(plan.error, undefined);
  assert.equal(plan.preset.minPhotoIntervalS, 10);
  assert.ok(Math.abs(plan.speedLimits.intervalMs - plan.spacing.photoM / 10) < 1e-9);
  const legacy = planAreas([area], suiteOptions({ presetId: 'dji-mini-5-pro' })[0].options);
  assert.equal(legacy.preset.minPhotoIntervalS, 5);
  assert.ok(Math.abs(legacy.speedLimits.intervalMs - legacy.spacing.photoM / 5) < 1e-9);
  assert.notEqual(plan.speedLimits.intervalMs, legacy.speedLimits.intervalMs);
});
