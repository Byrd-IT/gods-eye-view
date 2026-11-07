import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGevPlanFile,
  cleanControllerIds,
  cleanImport,
  parseGevPlanFile,
  readPlan,
  serializePlan,
} from './planDoc.js';
import { createLibraryClient, LibraryClientError } from './libraryClient.js';
import { drawableFor, openDroneFile } from './importFile.js';
import { getPreset } from './presets.js';

const state = () => ({
  areas: [
    { id: 'area-1', name: 'Area 1', kind: 'rect', box: { west: -97.1, east: -97.09, south: 30.1, north: 30.11 } },
    { id: 'area-2', name: 'Roof', kind: 'polygon', ring: [{ lon: -97, lat: 30 }, { lon: -96.99, lat: 30 }, { lon: -96.99, lat: 30.01 }], box: { west: -97, east: -96.99, south: 30, north: 30.01 } },
  ],
  nextArea: 3,
  jobGrouping: 'whole',
  takeoff: { lon: -97.1, lat: 30.1 },
  options: { presetId: 'dji-mini-5-pro', aglM: 70, pattern: 'grid', speedMs: 4, orbitTargets: [], obstacles: [], junk: 'x' },
  orbitTargetsTouched: true,
  orbitsPlanned: true,
  wpml: { droneEnumValue: null, droneSubEnumValue: null },
  suite: { passes: [] },
  suiteHidden: new Set(['nadir']),
});

test('serialize then read keeps everything editable and drops unknown keys', () => {
  const doc = serializePlan(state(), { controllerIds: ['9560f7b3-daa9-481a-b2f5-37ccf3b8b996', 'nope', null] });
  assert.equal(doc.options.junk, undefined);
  const back = readPlan(JSON.parse(JSON.stringify(doc)));
  assert.equal(back.areas.length, 2);
  assert.equal(back.areas[1].kind, 'polygon');
  assert.deepEqual(back.areas[1].box, { west: -97, east: -96.99, south: 30, north: 30.01 });
  assert.equal(back.jobGrouping, 'whole');
  assert.deepEqual(back.takeoff, { lon: -97.1, lat: 30.1 });
  assert.equal(back.options.aglM, 70);
  assert.equal(back.orbitTargetsTouched, true);
  assert.equal(back.suite.planned, true);
  assert.deepEqual(back.suite.hidden, ['nadir']);
  assert.deepEqual(back.controllerIds, ['9560F7B3-DAA9-481A-B2F5-37CCF3B8B996', null, null]);
});

test('readPlan refuses documents that are not plans or are too new', () => {
  for (const bad of [null, [], 'x', {}, { schema: 'gevplan' }, { schema: 'other', version: 1, areas: [] }]) {
    assert.throws(() => readPlan(bad), /not-a-plan/);
  }
  assert.throws(() => readPlan({ schema: 'gevplan', version: 99, areas: [] }), /newer-version/);
  assert.throws(() => readPlan({ schema: 'gevplan', version: 1, areas: new Array(21).fill({}) }), /bad-areas/);
});

test('hostile content is cleaned or refused, never trusted', () => {
  const doc = { schema: 'gevplan', version: 1, areas: [{ kind: 'rect', box: { west: 1e9, east: 2, south: 0, north: 1 } }] };
  assert.throws(() => readPlan(doc), /bad-areas/);
  const ring = Array.from({ length: 501 }, () => ({ lon: 1, lat: 1 }));
  assert.throws(() => readPlan({ ...doc, areas: [{ kind: 'polygon', ring }] }), /bad-areas/);
  const ok = readPlan({
    schema: 'gevplan',
    version: 1,
    areas: [],
    options: { presetId: '__proto__', aglM: 'big', speedMs: 3, pattern: 'zigzag', evil: 1 },
    wpml: { droneEnumValue: 'x' },
    controllerIds: ['../../etc/passwd'],
    imports: [{ waypoints: [{ lon: 999, lat: 0 }] }],
    nextArea: -5,
  });
  assert.deepEqual(ok.options, { speedMs: 3 });
  assert.equal(ok.wpml.droneEnumValue, null);
  assert.deepEqual(ok.controllerIds, [null]);
  assert.deepEqual(ok.imports, []);
  assert.equal(ok.nextArea, 1);
  assert.equal(cleanImport({ waypoints: [{ lon: 1, lat: 1, heightM: 'a' }], uuid: 'x'.repeat(5) }).uuid, null);
  assert.deepEqual(cleanControllerIds('x'), []);
});

test('.gevplan file: round trip, size and version checks', () => {
  const plan = serializePlan(state());
  const text = buildGevPlanFile({ name: 'Barn', site: 'Farm', status: 'flown' }, plan);
  const got = parseGevPlanFile(text);
  assert.equal(got.details.name, 'Barn');
  assert.equal(got.details.status, 'flown');
  assert.equal(got.plan.areas.length, 2);
  assert.throws(() => parseGevPlanFile('{'), /not-a-plan/);
  assert.throws(() => parseGevPlanFile(JSON.stringify({ schema: 'gevplan', version: 1, kind: 'x' })), /not-a-plan/);
  assert.throws(() => parseGevPlanFile(text.replace('"version": 1,\n "kind"', '"version": 9,\n "kind"')), /newer-version/);
  assert.throws(() => parseGevPlanFile('x'.repeat(26 * 1024 * 1024)), /too-large/);
});

test('openDroneFile: gevplan, kmz, junk', async () => {
  const text = buildGevPlanFile({ name: 'N' }, serializePlan(state()));
  const g = await openDroneFile(new TextEncoder().encode(text), 'a.gevplan');
  assert.equal(g.kind, 'gevplan');
  assert.equal((await openDroneFile(new TextEncoder().encode('{}'), 'a.gevplan')).code, 'not-a-plan');
  assert.equal((await openDroneFile(new Uint8Array([1, 2, 3]), 'a.kmz')).code, 'not-a-kmz');
  assert.equal((await openDroneFile(new Uint8Array(), 'a.kmz')).code, 'empty');
  const d = drawableFor('p', '#fff', readPlan(JSON.parse(JSON.stringify(serializePlan(state())))));
  assert.equal(d.rings.length, 2);
  assert.equal(d.rings[0].length, 4);
  void getPreset;
});

test('libraryClient sends the CSRF header, scopes owner, and maps errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('bad')) return { ok: false, status: 404, json: async () => ({ error: 'not-found', message: 'No such plan' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const c = createLibraryClient({ fetchImpl });
  await c.open('p_1', { owner: 'a b', version: 2 });
  assert.equal(calls[0].url, '/api/byrdit/plans/p_1?owner=a%20b&version=2');
  assert.equal(calls[0].init.headers['x-requested-with'], 'gev');
  await c.list({ scope: 'all', trash: true });
  assert.equal(calls[1].url, '/api/byrdit/plans/?scope=all&trash=1');
  await c.save('p_1', { a: 1 }, { name: 'n' });
  assert.equal(calls[2].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[2].init.body), { name: 'n', plan: { a: 1 } });
  await assert.rejects(() => c.open('bad'), (e) => e instanceof LibraryClientError && e.code === 'not-found' && e.status === 404);
  const off = createLibraryClient({ fetchImpl: async () => { throw new Error('net'); } });
  await assert.rejects(() => off.me(), (e) => e.code === 'offline');
});

test('the camera preset round-trips and an unknown one is dropped', () => {
  const s = state();
  s.options.cameraPresetId = 'test-12mp';
  const back = readPlan(JSON.parse(JSON.stringify(serializePlan(s))));
  assert.equal(back.options.cameraPresetId, 'test-12mp');
  const bad = state();
  bad.options.cameraPresetId = 'nope';
  assert.equal(readPlan(JSON.parse(JSON.stringify(serializePlan(bad)))).options.cameraPresetId, undefined);
});

test('interval capture settings round-trip; legacy plans do not grow defaults', () => {
  for (const captureMode of ['stop', 'distance', 'timed']) {
    const s = state();
    s.options.photoMode = 'interval';
    s.options.captureMode = captureMode;
    s.options.photoSpacingM = 12.5;
    s.options.continuousRoute = false;
    s.options.usableBatteryMin = 18;
    s.options.maxWaypoints = 80.5;
    const doc = serializePlan(s);
    assert.equal(doc.schema, 'gevplan');
    assert.equal(doc.version, 1);
    const back = readPlan(JSON.parse(JSON.stringify(doc)));
    assert.equal(back.options.photoMode, 'interval');
    assert.equal(back.options.captureMode, captureMode);
    assert.equal(back.options.photoSpacingM, 12.5);
    assert.equal(back.options.continuousRoute, false);
    assert.equal(back.options.usableBatteryMin, 18);
    assert.equal(back.options.maxWaypoints, 80.5);
    const filed = parseGevPlanFile(buildGevPlanFile({ name: 'Interval' }, doc));
    assert.equal(filed.plan.options.captureMode, captureMode);
    assert.equal(filed.plan.options.continuousRoute, false);
  }

  const zero = state();
  zero.options.photoSpacingM = 0;
  zero.options.continuousRoute = true;
  const zeroBack = readPlan(JSON.parse(JSON.stringify(serializePlan(zero))));
  assert.equal(zeroBack.options.photoSpacingM, 0);
  assert.equal(zeroBack.options.continuousRoute, true);

  const legacy = readPlan({
    schema: 'gevplan',
    version: 1,
    areas: [],
    options: { speedMs: 4, photoMode: 'waypoint', batteryMin: 25 },
  });
  assert.equal(legacy.options.speedMs, 4);
  assert.equal(legacy.options.photoMode, 'waypoint');
  assert.equal(legacy.options.batteryMin, 25);
  for (const key of ['captureMode', 'photoSpacingM', 'continuousRoute', 'usableBatteryMin', 'maxWaypoints', 'intervalTriggerProven', 'minPhotoIntervalS']) {
    assert.equal(Object.hasOwn(legacy.options, key), false, key);
  }

  const dirty = state();
  dirty.options.captureMode = 'hover';
  dirty.options.photoSpacingM = null;
  dirty.options.continuousRoute = 'yes';
  dirty.options.usableBatteryMin = Infinity;
  dirty.options.maxWaypoints = '200';
  dirty.options.intervalTriggerProven = 'yes';
  const dropped = readPlan(JSON.parse(JSON.stringify(serializePlan(dirty))));
  assert.equal(dropped.options.captureMode, undefined);
  assert.equal(Object.hasOwn(dropped.options, 'photoSpacingM'), false);
  assert.equal(Object.hasOwn(dropped.options, 'continuousRoute'), false);
  assert.equal(Object.hasOwn(dropped.options, 'usableBatteryMin'), false);
  assert.equal(Object.hasOwn(dropped.options, 'maxWaypoints'), false);
  assert.equal(Object.hasOwn(dropped.options, 'intervalTriggerProven'), false);
});

test('a forged intervalTriggerProven true is dropped from a plan and a .gevplan file', () => {
  const on = state();
  on.options.intervalTriggerProven = true;
  const saved = serializePlan(on);
  assert.equal(Object.hasOwn(saved.options, 'intervalTriggerProven'), false);
  const onBack = readPlan(JSON.parse(JSON.stringify(saved)));
  assert.equal(Object.hasOwn(onBack.options, 'intervalTriggerProven'), false);

  const forged = {
    schema: 'gevplan',
    version: 1,
    areas: [],
    options: { captureMode: 'distance', intervalTriggerProven: true },
  };
  const read = readPlan(forged);
  assert.equal(read.options.captureMode, 'distance');
  assert.equal(Object.hasOwn(read.options, 'intervalTriggerProven'), false);
  assert.notEqual(read.options.intervalTriggerProven, true);

  const filed = parseGevPlanFile(buildGevPlanFile({ name: 'forged' }, forged));
  assert.equal(filed.plan.options.captureMode, 'distance');
  assert.equal(Object.hasOwn(filed.plan.options, 'intervalTriggerProven'), false);

  const rawFile = JSON.stringify({
    schema: 'gevplan',
    version: 1,
    kind: 'file',
    details: { name: 'forged-raw' },
    plan: {
      schema: 'gevplan',
      version: 1,
      areas: [],
      options: { intervalTriggerProven: true, captureMode: 'distance' },
    },
  });
  const parsed = parseGevPlanFile(rawFile);
  assert.equal(parsed.plan.options.captureMode, 'distance');
  assert.equal(Object.hasOwn(parsed.plan.options, 'intervalTriggerProven'), false);
});

test('a custom camera minimum round-trips; invalid values are dropped', () => {
  const s = state();
  s.options.minPhotoIntervalS = 7.5;
  const doc = serializePlan(s);
  assert.equal(doc.options.minPhotoIntervalS, 7.5);
  const back = readPlan(JSON.parse(JSON.stringify(doc)));
  assert.equal(back.options.minPhotoIntervalS, 7.5);
  const filed = parseGevPlanFile(buildGevPlanFile({ name: 'interval' }, doc));
  assert.equal(filed.plan.options.minPhotoIntervalS, 7.5);

  for (const bad of [0, -2, 61, NaN, '7.5', true, null]) {
    const dirty = state();
    dirty.options.minPhotoIntervalS = bad;
    const saved = serializePlan(dirty);
    assert.equal(
      Object.hasOwn(saved.options, 'minPhotoIntervalS'),
      false,
      `saved ${bad}`,
    );
    const forged = {
      schema: 'gevplan',
      version: 1,
      areas: [],
      options: { minPhotoIntervalS: bad, speedMs: 4 },
    };
    const read = readPlan(forged);
    assert.equal(Object.hasOwn(read.options, 'minPhotoIntervalS'), false, `read ${bad}`);
    assert.equal(read.options.speedMs, 4);
  }
});
