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
