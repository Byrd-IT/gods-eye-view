import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areasBox,
  buildingHeightM,
  buildingsQuery,
  createBuildingFootprintProvider,
  parseBuildings,
  parseHeightM,
} from './buildingFootprints.js';
import { downtownPayload, okResponse, rectArea, relation, way } from './buildingFixtures.mjs';

test('parseHeightM: metres, units, feet, junk', () => {
  assert.equal(parseHeightM('12'), 12);
  assert.equal(parseHeightM('12.5 m'), 12.5);
  assert.equal(parseHeightM('12,5'), 12.5);
  assert.ok(Math.abs(parseHeightM("30'") - 9.144) < 1e-9);
  assert.equal(parseHeightM('tall'), null);
  assert.equal(parseHeightM(undefined), null);
});

test('buildingHeightM: height tag wins, then levels x 3 m, else null', () => {
  assert.equal(buildingHeightM({ height: '20', 'building:levels': '2' }), 20);
  assert.equal(buildingHeightM({ 'building:levels': '4' }), 12);
  assert.equal(buildingHeightM({ height: 'x' }), null);
  assert.equal(buildingHeightM({}), null);
});

test('buildingsQuery: bbox of ways and relations, bounded timeout and count', () => {
  const q = buildingsQuery({ west: -97.8, south: 30.2, east: -97.7, north: 30.3 });
  assert.match(q, /way\["building"\]\(30\.200000,-97\.800000,30\.300000,-97\.700000\)/);
  assert.match(q, /relation\["building"\]/);
  assert.match(q, /\[timeout:20\]/);
  assert.match(q, /out tags geom 2000;/);
});

test('parseBuildings: rings plus height/name/id; skips non-buildings, open multipolygons, dups', () => {
  const payload = downtownPayload();
  payload.elements.push(payload.elements[0]); // duplicate OSM id
  const found = parseBuildings(payload);
  const byId = Object.fromEntries(found.map((f) => [f.osmId, f]));
  assert.ok(byId['way-101'] && byId['relation-201']);
  assert.equal(byId['way-999'], undefined);
  assert.equal(found.filter((f) => f.osmId === 'way-101').length, 1);
  assert.equal(byId['way-101'].label, 'Hall');
  assert.equal(byId['way-101'].heightM, 12);
  assert.equal(byId['way-102'].heightM, 12);
  assert.equal(byId['way-103'].heightM, null);
  assert.ok(Math.abs(byId['relation-201'].heightM - 9.144) < 1e-9);
  assert.equal(byId['relation-201'].ring.length, 4, 'inner ring ignored, closing point dropped');
  assert.deepEqual(Object.keys(byId['way-101']).sort(), ['heightM', 'label', 'osmId', 'ring']);
});

test('parseBuildings: capped, largest first', () => {
  const payload = { elements: [way(1, 0, 0, 10, 10), way(2, 50, 0, 40, 40), way(3, 90, 0, 20, 20)] };
  assert.deepEqual(
    parseBuildings(payload, { max: 2 }).map((f) => f.osmId),
    ['way-2', 'way-3'],
  );
  const r = relation(5, 0, 0, 20, 20);
  r.members[0].geometry = r.members[0].geometry.slice(0, 3); // unclosed
  assert.deepEqual(parseBuildings({ elements: [r] }), []);
});

test('areasBox: union of rects and polygons; antimeridian rects unsupported', () => {
  const a = rectArea(100, 100, 'a');
  const poly = {
    id: 'p',
    kind: 'polygon',
    ring: [
      { lon: -97.7, lat: 30.3 },
      { lon: -97.69, lat: 30.3 },
      { lon: -97.69, lat: 30.31 },
    ],
  };
  const box = areasBox([a, poly]);
  assert.equal(box.east, -97.69);
  assert.equal(box.north, 30.31);
  assert.equal(box.west, a.box.west);
  assert.equal(areasBox([]), null);
  assert.equal(areasBox([{ id: 'x', kind: 'rect', box: { west: 179, east: -179, south: 0, north: 1 } }]), null);
});

test('provider: posts to /api/overpass and returns footprints', async () => {
  const calls = [];
  const provider = createBuildingFootprintProvider({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse(downtownPayload());
    },
  });
  const found = await provider([rectArea(300, 200)]);
  assert.equal(calls[0].url, '/api/overpass');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(decodeURIComponent(calls[0].init.body), /building/);
  assert.ok(found.length >= 6);
  assert.equal(provider.lastStatus.ok, true);
  assert.equal(provider.lastStatus.count, found.length);
});

test('provider: fails soft with a reason (HTTP error, rate limit, remark, throw, no area, huge area)', async () => {
  const cases = [
    [async () => ({ ok: false, status: 500 }), 'unavailable'],
    [async () => ({ ok: false, status: 429 }), 'rate-limited'],
    [async () => ({ ok: false, status: 504 }), 'timeout'],
    [async () => okResponse({ elements: [], remark: 'runtime error' }), 'incomplete'],
    [async () => { throw new Error('offline'); }, 'offline'],
  ];
  for (const [fetchImpl, reason] of cases) {
    const provider = createBuildingFootprintProvider({ fetchImpl });
    assert.deepEqual(await provider([rectArea(300, 200)]), []);
    assert.deepEqual(provider.lastStatus, { ok: false, reason, count: 0 });
  }
  const p = createBuildingFootprintProvider({ fetchImpl: async () => okResponse({ elements: [] }) });
  assert.deepEqual(await p([]), []);
  assert.equal(p.lastStatus.reason, 'no-area');
  assert.deepEqual(await p([rectArea(20000, 20000)]), []);
  assert.equal(p.lastStatus.reason, 'area-too-large');
  assert.deepEqual(await p([rectArea(300, 200)]), []);
  assert.deepEqual(p.lastStatus, { ok: true, reason: 'none', count: 0 });
});

test('provider: a hung request is aborted at the timeout and falls back', async () => {
  let aborted = false;
  const provider = createBuildingFootprintProvider({
    timeoutMs: 20,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  });
  assert.deepEqual(await provider([rectArea(300, 200)]), []);
  assert.equal(aborted, true);
  assert.equal(provider.lastStatus.reason, 'timeout');
});
