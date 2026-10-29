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
