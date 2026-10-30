import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaCenter,
  footprintStats,
  recommendOrbitTargets,
  targetInsideAreas,
} from './orbitTargets.js';
import { metersPerDegree } from './geo.js';

const LON = -97.77;
const LAT = 30.27;
const m = metersPerDegree(LAT);
const at = (dx, dy) => ({ lon: LON + dx / m.lon, lat: LAT + dy / m.lat });
const square = (cx, cy, side) => [
  at(cx - side / 2, cy - side / 2),
  at(cx + side / 2, cy - side / 2),
  at(cx + side / 2, cy + side / 2),
  at(cx - side / 2, cy + side / 2),
];
const rect = (id, w, h, cx = 0, cy = 0) => ({
  id,
  name: id,
  kind: 'rect',
  box: {
    west: at(cx - w / 2, 0).lon,
    east: at(cx + w / 2, 0).lon,
    south: at(0, cy - h / 2).lat,
    north: at(0, cy + h / 2).lat,
  },
});

test('footprintStats: area and centroid of a square', () => {
  const s = footprintStats(square(50, 20, 10));
  assert.ok(Math.abs(s.areaM2 - 100) < 1, String(s.areaM2));
  assert.ok(Math.abs(s.lon - at(50, 0).lon) < 1e-6);
  assert.ok(Math.abs(s.lat - at(0, 20).lat) < 1e-6);
});

test('recommend: biggest footprints inside the area win, tiny ones are skipped', () => {
  const area = rect('area-1', 300, 200);
  const footprints = [
    { ring: square(-60, 0, 10), label: 'Shed' }, // 100 m2
    { ring: square(60, 30, 30), label: 'Warehouse' }, // 900 m2
    { ring: square(0, 0, 3) }, // 9 m2: noise
    { ring: square(900, 0, 40) }, // outside
    { ring: [at(0, 0)] }, // not a ring
  ];
  const out = recommendOrbitTargets([area], { footprints });
  assert.deepEqual(
    out.map((t) => t.label),
    ['Warehouse', 'Shed'],
  );
  assert.ok(out.every((t) => t.source === 'building' && t.active));
  assert.equal(out[0].areaM2, 900);
  assert.equal(recommendOrbitTargets([area], { footprints, max: 1 }).length, 1);
});

test('recommend: falls back to the area centre, per area without buildings', () => {
  const a = rect('area-1', 200, 100, 0, 0);
  const b = rect('area-2', 100, 100, 500, 0);
  const one = recommendOrbitTargets([a]);
  assert.equal(one.length, 1);
  assert.equal(one[0].source, 'area');
  assert.ok(Math.abs(one[0].lon - LON) < 1e-6);
  const two = recommendOrbitTargets([a, b], {
    footprints: [{ ring: square(10, 10, 20) }],
  });
  assert.deepEqual(
    two.map((t) => [t.source, t.areaId]),
    [
      ['building', 'area-1'],
      ['area', 'area-2'],
    ],
  );
  assert.deepEqual(recommendOrbitTargets([]), []);
});

test('polygon areas: centre and containment', () => {
  const ring = square(0, 0, 100);
  const poly = { id: 'p', name: 'p', kind: 'polygon', ring };
  const c = areaCenter(poly);
  assert.ok(Math.abs(c.lon - LON) < 1e-6 && Math.abs(c.lat - LAT) < 1e-6);
  const inside = at(10, 10);
  const outside = at(200, 0);
  assert.equal(targetInsideAreas([poly], inside.lon, inside.lat), true);
  assert.equal(targetInsideAreas([poly], outside.lon, outside.lat), false);
});
