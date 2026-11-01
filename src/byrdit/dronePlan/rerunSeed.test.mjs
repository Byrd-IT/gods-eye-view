import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../../../server/byrdit/planLibrary/store.js';
import { readPlan } from './planDoc.js';
import { planFlight } from './planner.js';
import { parseDjiKmz } from './djiKmz.js';
import {
  TOLERANCE,
  buildItem,
  compareToReference,
  isSeedName,
  planStats,
  seedLibrary,
} from './rerunSeed.js';

// A made-up site: the real spec and KMZs are not in the repository.
const spec = {
  site: 'Test field',
  center: { lat: 30.2, lon: -97.7 },
  takeoff: { lat: 30.1997, lon: -97.6997 },
  plans: [
    {
      name: 'Suggested rerun - ring',
      areaHalfM: 55,
      options: { pattern: 'orbit', orbitHeightsM: [55], obstacleHeightM: 38, speedMs: 3, frontOverlap: 96.5, cameraPresetId: 'mapping-50mp' },
      orbitTargets: [{ radiusM: 30, heightM: 9 }],
    },
    {
      name: 'Suggested test - 12MP stop',
      areaHalfM: 55,
      options: { pattern: 'orbit', orbitHeightsM: [55], obstacleHeightM: 38, speedMs: 3, frontOverlap: 96.5, cameraPresetId: 'test-12mp' },
      orbitTargets: [{ radiusM: 30, heightM: 9 }],
    },
    {
      name: 'Suggested rerun - arc',
      areaHalfM: 80,
      options: { pattern: 'orbit', orbitHeightsM: [22, 32], obstacleHeightM: 8, speedMs: 2, frontOverlap: 97 },
      orbitTargets: [{ radiusM: 50, heightM: 9, blocked: { fromDeg: 152.5, toDeg: 117.5 } }],
    },
  ],
};

test('the overlap limit lets a slow, dense ring reach about 72 photos', () => {
  const s = planStats(spec, spec.plans[0]);
  assert.ok(s.waypointCount >= 68 && s.waypointCount <= 76, String(s.waypointCount));
  assert.ok(s.speedMs < 1, 'the planner picks the slow camera-limited speed');
  assert.deepEqual(s.heights, [55]);
  assert.ok(Math.abs(s.meanRadiusM - 30) <= TOLERANCE.radiusM);
  const arc = planStats(spec, spec.plans[2]);
  assert.deepEqual(arc.heights, [22, 32]);
  assert.ok(arc.waypointCount >= 28 && arc.waypointCount <= 32, String(arc.waypointCount));
});

test('overlap above the limit is clamped to 98', () => {
  const box = { west: -97.701, east: -97.699, south: 30.199, north: 30.201 };
  const hi = planFlight(box, { pattern: 'grid', frontOverlap: 99 });
  const top = planFlight(box, { pattern: 'grid', frontOverlap: 98 });
  assert.equal(hi.options.frontOverlap, 98);
  assert.equal(top.options.frontOverlap, 98);
});

test('compareToReference flags a different count, height, pitch or radius', () => {
  const s = planStats(spec, spec.plans[0]);
  assert.deepEqual(compareToReference(s, { ...s }), []);
  assert.equal(compareToReference(s, { ...s, waypointCount: 100 }).length, 1);
  assert.equal(compareToReference(s, { ...s, heights: [60] }).length, 1);
  assert.equal(compareToReference(s, { ...s, pitches: [-20] }).length, 1);
  assert.equal(compareToReference(s, { ...s, meanRadiusM: s.meanRadiusM + 3 }).length, 1);
});

test('seeding keeps the geometry, camera preset and a readable plan; re-running does not duplicate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-'));
  try {
    const store = createStore({ root });
    const own = store.create('byrdit', { name: 'My own plan' }, { schema: 'gevplan', version: 1, areas: [] });
    const items = spec.plans.map((e) => buildItem(spec, e));
    const first = seedLibrary(store, 'byrdit', items);
    assert.deepEqual(first.map((r) => r.action), ['created', 'created', 'created']);
    const second = seedLibrary(store, 'byrdit', items);
    assert.deepEqual(second.map((r) => r.action), ['unchanged', 'unchanged', 'unchanged']);
    assert.equal(store.list('byrdit').length, 4);
    const test12 = store.list('byrdit').find((p) => p.name === 'Suggested test - 12MP stop');
    const stored = readPlan(store.get('byrdit', test12.id).plan);
    assert.equal(stored.options.cameraPresetId, 'test-12mp');
    assert.equal(stored.orbitTargets.length, 1, 'orbit target (camera positions) kept');
    assert.equal(stored.orbitTargets[0].radiusM, 30);
    assert.equal(stored.options.pattern, 'orbit');
    assert.match(test12.notes, /Planned by GEV: \d+ waypoints/);
    // A changed plan becomes a new version, not a second plan.
    const edited = [{ ...items[0], plan: { ...items[0].plan, nextArea: 9 } }, items[1], items[2]];
    assert.equal(seedLibrary(store, 'byrdit', edited)[0].action, 'updated');
    assert.equal(store.list('byrdit').length, 4);
    // The user's own plan is untouched.
    assert.equal(store.get('byrdit', own.id).meta.name, 'My own plan');
    assert.equal(store.get('byrdit', own.id).meta.version, 1);
    // A dry run writes nothing.
    const dry = mkdtempSync(path.join(tmpdir(), 'seed-'));
    try {
      const s2 = createStore({ root: dry });
      assert.deepEqual(seedLibrary(s2, 'byrdit', items, { dryRun: true }).map((r) => r.action), ['created', 'created', 'created']);
      assert.equal(s2.list('byrdit').length, 0);
    } finally {
      rmSync(dry, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only "Suggested ..." names are seeded', () => {
  assert.equal(isSeedName('Suggested rerun - x'), true);
  assert.equal(isSeedName('My plan'), false);
  assert.throws(() => buildItem(spec, { ...spec.plans[0], name: 'My plan' }));
  assert.throws(() => seedLibrary(createStore({ root: tmpdir() }), 'u', [{ details: { name: 'My plan' }, plan: {} }]));
});

// Real check against the Byrd Ranch spec and KMZs; only where they exist.
const SPEC = process.env.GEV_RERUN_SPEC;
const KMZ_DIR = process.env.GEV_RERUN_KMZ_DIR;
test('the Byrd Ranch reruns match their KMZs within tolerance', { skip: !(SPEC && KMZ_DIR) }, async () => {
  const real = JSON.parse(readFileSync(SPEC, 'utf8'));
  const { referenceStats } = await import('./rerunSeed.js');
  let checked = 0;
  for (const entry of real.plans.filter((e) => e.reference)) {
    const mission = await parseDjiKmz(new Uint8Array(readFileSync(path.join(KMZ_DIR, entry.reference))), { fileName: entry.reference });
    assert.deepEqual(compareToReference(planStats(real, entry), referenceStats(mission, real.center)), [], entry.name);
    checked++;
  }
  assert.equal(checked, 3);
});
