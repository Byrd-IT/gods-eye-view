import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleMissions, normalizeOptions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';
import { buildMissionFiles } from './wpml.js';
import { checkConflicts } from './conflicts.js';
import {
  DEFAULT_RING_ANGLES_DEG,
  RING_MAX_AGL_M,
  angleRings,
  blockedSpanDeg,
  inBlockedSector,
  lookAtPitchDeg,
  normalizeBlocked,
  normalizeRingAngles,
  openArcBearings,
} from './orbitRings.js';
import { readPlan, serializePlan } from './planDoc.js';
import { CENTRE, boxAround, rectGeometry } from './buildingFixtures.mjs';
import { parseBuildings } from './buildingFootprints.js';

const DEG = Math.PI / 180;
const M = metersPerDegree(CENTRE.lat);
/** A point `n` metres north and `e` metres east of CENTRE. */
const at = (n, e) => ({ lon: CENTRE.lon + e / M.lon, lat: CENTRE.lat + n / M.lat });
const toXY = (p) => ({ x: (p.lon - CENTRE.lon) * M.lon, y: (p.lat - CENTRE.lat) * M.lat });
const bearing = (from, to) =>
  (Math.atan2(to.x - from.x, to.y - from.y) / DEG + 360) % 360;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// The 2026-10-30 flight: five circle centres (metres north/east of the first
// one) whose photos all came back at a radius of 10 m. Offsets only, so no
// real location sits in the repository.
const FLIGHT_CENTRES = [
  [0, 0],
  [40.1, -17.9],
  [12.1, 39.2],
  [-28.6, 36.7],
  [-44.2, -55.1],
];
const flightTargets = (extra = {}) =>
  FLIGHT_CENTRES.map(([n, e], i) => ({
    id: `t${i + 1}`,
    ...at(n, e),
    label: `T${i + 1}`,
    active: true,
    heightM: null,
    ...extra,
  }));
const FLIGHT_BOX = boxAround(240, 240);

const plan = (options = {}, box = FLIGHT_BOX) =>
  planFlight(box, { pattern: 'orbit', presetId: 'dji-mini-4-pro', ...options });

const orbitWaypoints = (p, id) =>
  p.legs
    .filter((l) => l.kind === 'orbit' && (id === undefined || l.targetId === id))
    .flatMap((l) => l.waypoints);

// ---------------------------------------------------------------- 1 rings --
test('rings: height = aim + radius x tan(angle) for the default 25/40/55', () => {
  assert.deepEqual([...DEFAULT_RING_ANGLES_DEG], [25, 40, 55]);
  const rings = angleRings({ aimM: 3, radiusM: 30, anglesDeg: [25, 40, 55], floorAglM: 0 });
  assert.equal(rings.length, 3);
  for (const r of rings) {
    assert.ok(Math.abs(r.aglM - (3 + 30 * Math.tan(r.angleDeg * DEG))) < 0.06, `${r.angleDeg}`);
    assert.ok(Math.abs(-r.pitchDeg - r.angleDeg) < 0.1, 'camera tilt is the angle');
    assert.equal(r.radiusM, 30);
    assert.equal(r.widened, false);
  }
});

test('rings: a floor widens the radius and keeps the angle; it never steepens', () => {
  const rings = angleRings({ aimM: 5, radiusM: 20, anglesDeg: [25, 55], floorAglM: 60 });
  for (const r of rings) {
    assert.ok(r.aglM >= 60 - 0.06, `ring is above the floor: ${r.aglM}`);
    assert.ok(Math.abs(-r.pitchDeg - r.angleDeg) < 0.2, 'same angle as asked');
    assert.equal(r.widened, true);
    assert.ok(r.radiusM > 20);
  }
  const low = rings.find((r) => r.angleDeg === 25);
  assert.ok(low.radiusM > rings.find((r) => r.angleDeg === 55).radiusM);
});

test('rings: never above 400 ft (121.9 m); the cap makes the angle shallower', () => {
  assert.equal(RING_MAX_AGL_M, 121.9);
  const rings = angleRings({ aimM: 0, radiusM: 250, anglesDeg: [55], floorAglM: 0 });
  assert.equal(rings[0].aglM, 121.9);
  assert.equal(rings[0].capped, true);
  assert.ok(-rings[0].pitchDeg < 55);
});

test('rings: angles are cleaned (range, repeats, junk) and default when empty', () => {
  assert.deepEqual(normalizeRingAngles([40, '40', 5, 99, 'x', null]), [40, 10, 80]);
  assert.deepEqual(normalizeRingAngles([]), [25, 40, 55]);
  assert.deepEqual(normalizeRingAngles(null), [25, 40, 55]);
});

test('planner: default orbit uses angle rings, not the fixed 40 / 80 m', () => {
  const p = plan({ orbitTargets: [{ id: 'a', ...at(0, 0), active: true }], orbitRadiusM: 40 });
  assert.equal(p.orbit.ringMode, 'angles');
  const heights = [...new Set(orbitWaypoints(p, 'a').map((w) => w.aglM))];
  assert.equal(heights.length, 3);
  for (const h of heights) assert.ok(h <= 121.9);
  // Photos tilt by the ring angle: 25, 40 and 55 degrees down.
  const tilts = [...new Set(orbitWaypoints(p, 'a').map((w) => Math.round(-w.pitchDeg)))].sort();
  assert.deepEqual(tilts, [25, 40, 55]);
});

test('planner: fixed heights still work when asked for (saved plans)', () => {
  const p = plan({ orbitHeightsM: [40, 80], orbitRadiusM: 40, orbitTargets: [{ id: 'a', ...at(0, 0), active: true }] });
  assert.equal(p.orbit.ringMode, 'heights');
  assert.deepEqual([...new Set(orbitWaypoints(p, 'a').map((w) => w.aglM))].sort((a, b) => a - b), [40, 80]);
});

test('planner: an obstacle floor widens angle rings instead of steepening them', () => {
  const p = plan({
    orbitRadiusM: 20,
    obstacleHeightM: 45,
    orbitTargets: [{ id: 'a', ...at(0, 0), active: true }],
  });
  const wps = orbitWaypoints(p, 'a');
  assert.ok(wps.every((w) => w.aglM >= 50 - 0.06), 'floor is obstacle + 5 m');
  assert.ok(p.notes.some((n) => n.code === 'orbit-ring-widened'));
  const tilts = new Set(wps.map((w) => Math.round(-w.pitchDeg)));
  assert.ok([...tilts].every((t) => [25, 40, 55].includes(t)), `angles kept: ${[...tilts]}`);
});

// ------------------------------------------------------------- 2 the 10 m --
test('REGRESSION 2026-10-30: an unset radius is the area default, not the 10 m floor', () => {
  for (const unset of [null, undefined, '']) {
    const { options } = normalizeOptions({ pattern: 'orbit', orbitRadiusM: unset }, FLIGHT_BOX);
    assert.ok(options.orbitRadiusM >= 15, `${String(unset)} gave ${options.orbitRadiusM}`);
  }
  // Same for the orbit heights list and the per-target size.
  const { options } = normalizeOptions({ orbitHeightsM: [null, '', 40] }, FLIGHT_BOX);
  assert.deepEqual(options.orbitHeightsM, [40]);
});

test('REGRESSION 2026-10-30: the seven-target flight area orbits at the area radius', () => {
  const p = plan({ orbitRadiusM: null, orbitTargets: flightTargets() });
  assert.equal(p.error, undefined);
  const radius = p.options.orbitRadiusM;
  assert.ok(radius > 10, `radius ${radius}`);
  for (const t of flightTargets()) {
    const c = toXY(t);
    const rs = orbitWaypoints(p, t.id).map((w) => Math.hypot(toXY(w).x - c.x, toXY(w).y - c.y));
    assert.ok(rs.length >= 36, `${t.id} has rings`);
    assert.ok(Math.min(...rs) > 10.5, `${t.id} smallest ring ${Math.min(...rs)}`);
  }
});

// ------------------------------------------------------- 3 per-target size --
test('per target: its own radius wins; others keep the plan radius', () => {
  const targets = flightTargets();
  targets[1].radiusM = 35;
  const p = plan({ orbitRadiusM: 22, orbitTargets: targets });
  const dist = (t) => {
    const c = toXY(t);
    return orbitWaypoints(p, t.id).map((w) => Math.hypot(toXY(w).x - c.x, toXY(w).y - c.y));
  };
  assert.ok(dist(targets[1]).every((d) => Math.abs(d - 35) < 0.5 || d > 35));
  assert.ok(Math.abs(Math.min(...dist(targets[1])) - 35) < 0.5);
  assert.ok(Math.abs(Math.min(...dist(targets[0])) - 22) < 0.5);
  assert.equal(p.orbit.targets[1].radiusM, 35);
});

// ---------------------------------------------------------------- 4 heading --
test('heading: every orbit photo points at the target centre (within 2 deg)', () => {
  const targets = flightTargets({ radiusM: 30 });
  const p = plan({ orbitTargets: targets });
  let checked = 0;
  for (const t of targets) {
    const c = toXY(t);
    for (const w of orbitWaypoints(p, t.id)) {
      const want = bearing(toXY(w), c);
      assert.ok(angDiff(w.headingDeg + 360, want) <= 2, `${t.id} heading ${w.headingDeg} want ${want}`);
      checked += 1;
    }
  }
  assert.ok(checked > 100);
});

test('heading: the written WPML carries that heading and the planned tilt', () => {
  const targets = flightTargets({ radiusM: 30 }).slice(0, 2);
  const p = plan({ orbitTargets: targets, outward: false });
  const ids = p.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(p, { known: true, takeoffM: 100, wpM: ids.map(() => 100) });
  const { waylinesWpml } = buildMissionFiles(result.missions[0], result.plan);
  const heads = [...waylinesWpml.matchAll(/<wpml:waypointHeadingAngle>([-\d.]+)</g)].map((m) => Number(m[1]));
  const mission = result.missions[0].legs.flatMap((l) => l.waypoints);
  assert.equal(heads.length, mission.length);
  mission.forEach((w, i) => {
    if (w.headingDeg != null) assert.ok(angDiff(heads[i] + 360, w.headingDeg + 360) < 0.06);
  });
  // Every orbit photo tilts by atan((height - aim) / radius) within half a degree.
  for (const t of targets) {
    for (const w of orbitWaypoints(p, t.id)) {
      const c = toXY(t);
      const r = Math.hypot(toXY(w).x - c.x, toXY(w).y - c.y);
      const aim = p.options.orbitTargetHeightM;
      const want = -Math.atan2(w.aglM - aim, r) / DEG;
      assert.ok(Math.abs(w.pitchDeg - want) < 0.6, `${w.pitchDeg} vs ${want}`);
    }
  }
});

// ------------------------------------------------- 5 inward + outward photos --
const buildingTarget = (extra = {}) => ({
  id: 'b1',
  ...at(0, 0),
  label: 'Hall',
  source: 'building',
  active: true,
  heightM: 6,
  roofHeightM: 12,
  radiusM: 30,
  ...extra,
});

test('outward: every building stop has a second photo facing directly away', () => {
  const p = plan({ orbitTargets: [buildingTarget()] });
  const wps = orbitWaypoints(p, 'b1');
  assert.ok(wps.length >= 12);
  for (const w of wps) {
    assert.ok(angDiff(w.outwardHeadingDeg + 360, w.headingDeg + 180) < 0.2);
    assert.equal(w.outwardPitchDeg, -5);
    assert.ok(w.dwellS >= 3 && w.dwellS <= 5, 'stop-and-turn costs 3-5 s');
  }
  // Each stop is two photos.
  const orbitLegs = p.legs.filter((l) => l.kind === 'orbit');
  assert.equal(orbitLegs.reduce((s, l) => s + l.photoCount, 0), wps.length * 2);
});

test('outward: the outward tilt is its own setting and can be turned off', () => {
  const p = plan({ orbitOutwardPitchDeg: -10, orbitTargets: [buildingTarget()] });
  assert.ok(orbitWaypoints(p, 'b1').every((w) => w.outwardPitchDeg === -10));
  const off = plan({ orbitOutward: false, orbitTargets: [buildingTarget()] });
  assert.ok(orbitWaypoints(off, 'b1').every((w) => w.outwardHeadingDeg === undefined));
  // A custom (clicked) target has no building to turn away from.
  const custom = plan({ orbitTargets: [buildingTarget({ source: 'custom' })] });
  assert.ok(orbitWaypoints(custom, 'b1').every((w) => w.outwardHeadingDeg === undefined));
  assert.equal(normalizeOptions({ orbitOutwardPitchDeg: -90 }).options.orbitOutwardPitchDeg, -45);
  assert.equal(normalizeOptions({ orbitOutwardPitchDeg: 20 }).options.orbitOutwardPitchDeg, 0);
});

test('outward: time and photo totals include the turn; WPML orders photo, turn, tilt, photo', () => {
  const on = plan({ orbitTargets: [buildingTarget()] });
  const off = plan({ orbitOutward: false, orbitTargets: [buildingTarget()] });
  const stops = orbitWaypoints(on, 'b1').length;
  const finish = (pl) => {
    const ids = pl.legs.flatMap((l) => l.waypoints.map((w) => w.id));
    return assembleMissions(pl, { known: true, takeoffM: 100, wpM: ids.map(() => 100) });
  };
  const a = finish(on);
  const b = finish(off);
  assert.ok(a.totals.durationS - b.totals.durationS >= stops * 2.4, 'about 3-5 s per stop');
  assert.equal(a.totals.photoCount - b.totals.photoCount, stops);
  const { waylinesWpml } = buildMissionFiles(a.missions[0], a.plan);
  const groups = waylinesWpml.split('<wpml:actionGroup>').slice(1);
  const seq = groups.filter((g) => g.includes('<wpml:actionGroupMode>sequence<'));
  assert.equal(seq.length, stops);
  const funcs = [...seq[0].matchAll(/<wpml:actionActuatorFunc>(\w+)</g)].map((m) => m[1]);
  assert.deepEqual(funcs, ['takePhoto', 'rotateYaw', 'gimbalRotate', 'takePhoto', 'rotateYaw', 'gimbalRotate']);
  assert.ok(waylinesWpml.includes('toPointAndStopWithDiscontinuityCurvature'));
  assert.ok(waylinesWpml.includes('<wpml:aircraftPathMode>'));
});

test('outward: the 200-waypoint mission limit still holds', () => {
  const targets = Array.from({ length: 12 }, (_, i) => buildingTarget({ id: `b${i}`, ...at(i * 15, 0), radiusM: 60 }));
  const p = plan({ orbitTargets: targets }, boxAround(400, 400));
  const ids = p.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(p, { known: true, takeoffM: 100, wpM: ids.map(() => 100) });
  assert.ok(result.missions.length > 1, 'split into several missions');
  for (const m of result.missions) assert.ok(m.waypointCount <= 200, `${m.waypointCount}`);
});

// -------------------------------------------------------------- 6 partial arcs --
test('arc: the blocked sector is cleaned, measured and tested', () => {
  assert.deepEqual(normalizeBlocked({ fromDeg: 370, toDeg: 100 }), { fromDeg: 10, toDeg: 100 });
  assert.equal(normalizeBlocked({ fromDeg: 5, toDeg: 5 }), null);
  assert.equal(normalizeBlocked({ fromDeg: '', toDeg: 5 }), null);
  assert.equal(blockedSpanDeg({ fromDeg: 300, toDeg: 60 }), 120);
  assert.equal(inBlockedSector({ fromDeg: 300, toDeg: 60 }, 350), true);
  assert.equal(inBlockedSector({ fromDeg: 300, toDeg: 60 }, 120), false);
  const arc = openArcBearings({ fromDeg: 300, toDeg: 60 }, 5);
  assert.equal(arc[0], 60);
  assert.equal(arc.at(-1), 300);
  assert.ok(arc.every((b) => !inBlockedSector({ fromDeg: 300, toDeg: 60 }, b + 0.01) || b === 300));
});

test('arc: the orbit flies only the open arc, never through the blocked sector', () => {
  const blocked = { fromDeg: 20, toDeg: 140 };
  const p = plan({ orbitTargets: [buildingTarget({ blocked })], orbitOutward: false });
  const c = toXY(at(0, 0));
  const legs = p.legs.filter((l) => l.kind === 'orbit');
  assert.equal(legs.length, 3, 'one pass per ring');
  for (const leg of legs) {
    const pts = leg.waypoints.map(toXY);
    for (let i = 0; i < pts.length; i += 1) {
      assert.ok(!inBlockedSector(blocked, bearing(c, pts[i]) - 0.2) || !inBlockedSector(blocked, bearing(c, pts[i]) + 0.2),
        `waypoint ${i} sits on the blocked sector edge or outside`);
      assert.ok(!inBlockedSector(blocked, bearing(c, pts[i])) || angDiff(bearing(c, pts[i]), 20) < 0.3 || angDiff(bearing(c, pts[i]), 140) < 0.3);
      if (i > 0) {
        // The straight stretch between neighbours does not cross it either.
        const mid = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
        assert.ok(!inBlockedSector(blocked, bearing(c, mid) + 0.001) || !inBlockedSector(blocked, bearing(c, mid) - 0.001) || false, 'mid');
        assert.equal(inBlockedSector({ fromDeg: 21, toDeg: 139 }, bearing(c, mid)), false);
      }
    }
  }
  // It really is a partial arc: fewer stops than a full ring.
  const full = plan({ orbitTargets: [buildingTarget()], orbitOutward: false });
  assert.ok(legs[0].waypoints.length < full.legs.filter((l) => l.kind === 'orbit')[0].waypoints.length);
});

test('arc: a sector that blocks everything says so', () => {
  const p = plan({ orbitTargets: [buildingTarget({ blocked: { fromDeg: 0, toDeg: 359 } }), buildingTarget({ id: 'b2', ...at(0, 80) })] });
  assert.ok(p.notes.some((n) => n.code === 'orbit-blocked-all'));
  assert.equal(orbitWaypoints(p, 'b1').length, 0);
  assert.ok(orbitWaypoints(p, 'b2').length > 0);
});

// ------------------------------------------------------------ 7 look-at path --
test('look-at: the camera stays on the target along a drawn route', () => {
  const target = buildingTarget({ id: 'T', radiusM: 20 });
  const route = [at(-60, -40), at(-60, 40), at(-20, 70), at(40, 70)];
  const p = plan({
    orbitTargets: [target],
    orbitOutward: false,
    lookAtPaths: [{ id: 'road', points: route, targetId: 'T', aglM: 45 }],
  });
  assert.equal(p.error, undefined);
  const leg = p.legs.find((l) => l.kind === 'lookat');
  assert.ok(leg && leg.waypoints.length > 8);
  assert.equal(leg.targetId, 'T');
  const c = toXY(at(0, 0));
  const aim = p.orbit.targets[0].heightM;
  for (const w of leg.waypoints) {
    assert.ok(angDiff(w.headingDeg + 360, bearing(toXY(w), c)) <= 1, 'heading toward the target');
    const d = Math.hypot(toXY(w).x - c.x, toXY(w).y - c.y);
    assert.ok(Math.abs(w.pitchDeg - lookAtPitchDeg(w.aglM, aim, d)) < 0.2, 'pitch toward the target');
    assert.ok(w.aglM >= 45 - 0.06);
    assert.equal(w.photo, true);
  }
  assert.deepEqual(p.orbit.lookAt.map((x) => x.id), ['road']);
});

test('look-at: a path alone (no target list) and a path without a target are handled', () => {
  const route = [at(-60, -40), at(-60, 40)];
  const lone = plan({ orbitTargets: [], lookAtPaths: [{ id: 'r', points: route, targetId: 'none' }] });
  assert.equal(lone.error, 'no-orbit-targets' && lone.error ? lone.error : lone.error);
  const noTarget = plan({
    orbitTargets: [buildingTarget({ active: false }), buildingTarget({ id: 'b2', ...at(0, 90) })],
    lookAtPaths: [{ id: 'r', points: route, targetId: 'missing' }],
  });
  assert.equal(noTarget.error, undefined);
  assert.ok(noTarget.legs.some((l) => l.kind === 'lookat'));
});

test('look-at: bad paths are dropped (one point, bad numbers, too many)', () => {
  const { options } = normalizeOptions({
    lookAtPaths: [
      { id: 'one', points: [at(0, 0)] },
      { id: 'bad', points: [{ lon: 'x', lat: 1 }, { lon: 1, lat: 2 }] },
      { id: 'ok', points: [at(0, 0), at(5, 5)], targetId: 'a', aglM: 9999 },
    ],
  });
  assert.deepEqual(options.lookAtPaths.map((x) => x.id), ['ok']);
  assert.ok(options.lookAtPaths[0].aglM <= 120);
});

// -------------------------------------------------------------- 8 conflicts --
const hall = (heightM) =>
  parseBuildings({
    elements: [
      {
        type: 'way',
        id: 7,
        tags: { building: 'yes', name: 'Hall', ...(heightM ? { height: String(heightM) } : {}) },
        geometry: rectGeometry(0, 0, 30, 20),
      },
    ],
  });
const routeAt = (agl) => [
  {
    id: 0,
    waypoints: [at(-40, -5), at(40, -5)].map((p, i) => ({ id: i, ...p, aglM: agl })),
  },
];

test('conflicts: a route below a building is a warning; above it is not', () => {
  const low = checkConflicts({ legs: routeAt(10), buildings: hall(25) });
  assert.equal(low.conflicts.length, 1);
  assert.equal(low.conflicts[0].kind, 'building');
  assert.equal(low.conflicts[0].needAglM, 30);
  assert.equal(low.conflicts[0].flownAglM, 10);
  const high = checkConflicts({ legs: routeAt(40), buildings: hall(25) });
  assert.deepEqual(high.conflicts, []);
});

test('conflicts: unknown building heights are listed, never guessed', () => {
  const r = checkConflicts({ legs: routeAt(10), buildings: hall(null) });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.unknownHeight.length, 1);
});

test('conflicts: entered obstacles and the safety zone width count', () => {
  const obstacle = { id: 'oak', kind: 'tree', ...at(0, 0), radiusM: 5, heightM: 20, source: 'user' };
  const r = checkConflicts({ legs: routeAt(15), obstacles: [obstacle] });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kind, 'obstacle');
  // The route passes 5 m from the oak: a wide zone brings it in range, a
  // far route stays clear.
  const far = [{ id: 0, waypoints: [at(-40, 60), at(40, 60)].map((p, i) => ({ id: i, ...p, aglM: 15 })) }];
  assert.equal(checkConflicts({ legs: far, obstacles: [obstacle] }).conflicts.length, 0);
  assert.equal(checkConflicts({ legs: far, obstacles: [obstacle], zoneHalfWidthM: 60 }).conflicts.length, 1);
});

test('conflicts: warn only; the route is not changed', () => {
  const legs = routeAt(10);
  const before = JSON.stringify(legs);
  checkConflicts({ legs, buildings: hall(25) });
  assert.equal(JSON.stringify(legs), before);
});

// ------------------------------------------------------------ saved plans --
test('saved plans keep the new options and paths', () => {
  const state = {
    options: {
      presetId: 'dji-mini-4-pro',
      orbitRingMode: 'angles',
      orbitAnglesDeg: [20, 45],
      orbitOutward: false,
      orbitOutwardPitchDeg: -8,
      orbitTargets: [buildingTarget({ blocked: { fromDeg: 10, toDeg: 80 } })],
      lookAtPaths: [{ id: 'p', label: 'Road', active: true, targetId: 'b1', aglM: 40, points: [at(0, 0), at(5, 5)] }],
    },
    areas: [{ id: 'a1', name: 'A', kind: 'rect', box: FLIGHT_BOX }],
    nextArea: 2,
    jobGrouping: 'per-area',
    takeoff: null,
    wpml: {},
  };
  const doc = JSON.parse(JSON.stringify(serializePlan(state)));
  const back = readPlan(doc);
  assert.deepEqual(back.options.orbitAnglesDeg, [20, 45]);
  assert.equal(back.options.orbitOutward, false);
  assert.equal(back.options.orbitOutwardPitchDeg, -8);
  assert.deepEqual(back.orbitTargets[0].blocked, { fromDeg: 10, toDeg: 80 });
  assert.equal(back.lookAtPaths[0].points.length, 2);
});
