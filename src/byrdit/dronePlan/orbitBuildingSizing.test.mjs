import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBuildings } from './buildingFootprints.js';
import {
  aimHeightFor,
  footprintReach,
  mergeOverlapping,
  orbitRadiusFor,
  recommendOrbitTargets,
} from './orbitTargets.js';
import {
  AGL_CAP_M,
  ROOF_CLEARANCE_M,
  normalizeOptions,
  planFlight,
  targetRingHeights,
} from './planner.js';
import { downtownPayload, rectArea, way, boxAround } from './buildingFixtures.mjs';

const area = rectArea(300, 200);
const recommend = (elements, opts = {}) =>
  recommendOrbitTargets([area], { footprints: parseBuildings({ elements }), ...opts });

test('sizing: radius = farthest corner + max(10 m, half the size), clamped 10-300', () => {
  const [fp] = parseBuildings({ elements: [way(1, 0, 0, 30, 20)] });
  const { farM, sizeM } = footprintReach(fp.ring);
  assert.ok(Math.abs(farM - Math.hypot(15, 10)) < 0.2);
  assert.ok(Math.abs(sizeM - 30) < 0.2);
  assert.equal(orbitRadiusFor({ farM: 18.03, sizeM: 30 }), 34); // 18.03 + 15
  assert.equal(orbitRadiusFor({ farM: 7.07, sizeM: 10 }), 18); // margin floor 10 m
  assert.equal(orbitRadiusFor({ farM: 1, sizeM: 1 }), 11);
  assert.equal(orbitRadiusFor({ farM: 900, sizeM: 900 }), 300);
  const [t] = recommend([way(1, 0, 0, 30, 20)]);
  assert.equal(t.radiusM, 34);
  assert.equal(t.source, 'building');
});

test('sizing: aim is half the roof height (>= 2 m); unknown height leaves the plan default', () => {
  assert.equal(aimHeightFor(12), 6);
  assert.equal(aimHeightFor(1), 2);
  assert.equal(aimHeightFor(null), null);
  const targets = recommend([
    way(1, -80, 0, 30, 20, { height: '12' }),
    way(2, 80, 0, 20, 20),
  ]);
  const tall = targets.find((t) => t.roofHeightM === 12);
  const unknown = targets.find((t) => t.roofHeightM == null);
  assert.equal(tall.heightM, 6);
  assert.equal(unknown.heightM, null);
});

test('merge: overlapping building orbits merge into one covering both', () => {
  const targets = recommend([
    way(105, 0, -60, 15, 15, { height: '9' }),
    way(106, 20, -60, 15, 15, { height: '6 m' }),
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].roofHeightM, 9);
  assert.ok(targets[0].radiusM >= 20 && targets[0].radiusM <= 80);
  assert.equal(targets[0].source, 'building');
});

test('merge: not merged when the merged radius would exceed 80 m', () => {
  const elements = [way(1, -30, 0, 60, 60), way(2, 30, 0, 60, 60)];
  const footprints = parseBuildings({ elements });
  const targets = recommendOrbitTargets([area], { footprints });
  assert.equal(targets.length, 2, 'each keeps its own orbit');
  assert.ok(targets.every((t) => t.radiusM > 40));
});

test('mergeOverlapping: order independent', () => {
  const mk = (id, lon) => ({
    lon,
    lat: 30.27,
    radiusM: 20,
    areaM2: 100,
    sizeM: 10,
    roofHeightM: null,
    areaId: 'a1',
    osmId: id,
  });
  const a = mergeOverlapping([mk('a', -97.77), mk('b', -97.7699)]);
  const b = mergeOverlapping([mk('b', -97.7699), mk('a', -97.77)]);
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});

test('caps: live cap of 5 recommendations; largest first; area centre kept as fallback', () => {
  const elements = Array.from({ length: 9 }, (_, i) =>
    way(i + 1, -130 + i * 32, i % 2 ? 60 : -60, 12 + i, 12 + i),
  );
  const targets = recommend(elements);
  assert.equal(targets.length, 5);
  assert.deepEqual(
    targets.map((t) => t.areaM2),
    [...targets.map((t) => t.areaM2)].sort((x, y) => y - x),
  );
  assert.deepEqual(recommend([]).map((t) => t.source), ['area']);
  assert.equal(recommend([]).at(0).radiusM, undefined, 'centre fallback keeps the plan radius');
});

test('rings: max(requested, roof + 15, obstacle + 5) within AGL min/cap', () => {
  const { options } = normalizeOptions({ pattern: 'orbit', orbitHeightsM: [20, 30], obstacleHeightM: 15 });
  const rings = options.orbitHeightsM; // [20, 30]: already above the 15 + 5 floor
  const tall = targetRingHeights({ roofHeightM: 40 }, rings, 15);
  assert.deepEqual(tall.heights, [55]);
  assert.equal(tall.belowRoofClearance, false);
  const low = targetRingHeights({ roofHeightM: 6 }, rings, 15);
  assert.deepEqual(low.heights, [21, 30], 'roof + 15 = 21 beats the 20 m ring, 30 stays');
  const tallObstacle = targetRingHeights({ roofHeightM: 6 }, [10, 40], 30);
  assert.deepEqual(tallObstacle.heights, [35, 40], 'obstacle floor 35 beats roof + 15 = 21');
  const none = targetRingHeights({ roofHeightM: null }, rings, 15);
  assert.deepEqual(none.heights, rings, 'no roof: live behaviour');
  const over = targetRingHeights({ roofHeightM: 200 }, rings, 15);
  assert.deepEqual(over.heights, [AGL_CAP_M]);
  assert.equal(over.belowRoofClearance, true);
  assert.equal(ROOF_CLEARANCE_M, 15);
});

test('planner: building targets orbit at their own radius and rings; others keep the plan radius', () => {
  const box = boxAround(300, 200);
  const stops = [
    { id: 'b', lon: -97.77, lat: 30.27, label: 'Tower', source: 'building', active: true, heightM: 20, roofHeightM: 40, radiusM: 60 },
    { id: 'u', lon: -97.7695, lat: 30.2705, label: 'Spot', source: 'custom', active: true, heightM: null },
  ];
  const plan = planFlight(box, { pattern: 'orbit', orbitRadiusM: 30, orbitHeightsM: [20, 30], obstacleHeightM: 15, orbitTargets: stops });
  assert.equal(plan.error, undefined);
  const [tb, tu] = plan.orbit.targets;
  assert.equal(tb.radiusM, 60);
  assert.deepEqual(tb.ringsAglM, [55]);
  assert.equal(tu.radiusM, 30);
  assert.deepEqual(tu.ringsAglM, [20, 30]);
  const orbitLegs = plan.legs.filter((l) => l.kind === 'orbit');
  const aglsOf = (id) => [...new Set(orbitLegs.filter((l) => l.targetId === id).flatMap((l) => l.waypoints.map((w) => w.aglM)))];
  assert.deepEqual(aglsOf('b'), [55]);
  assert.deepEqual(aglsOf('u'), [20, 30]);
  assert.equal(plan.orbit.transitAglM, 55, 'crossing between targets clears the tall roof');
  assert.ok(plan.orbit.minAglM <= 20, 'live obstacle floor unchanged');
  // The sized orbit really is 60 m wide: first-ring waypoints sit 60 m out.
  assert.ok(orbitLegs.find((l) => l.targetId === 'b').waypoints.length > 12);
});
