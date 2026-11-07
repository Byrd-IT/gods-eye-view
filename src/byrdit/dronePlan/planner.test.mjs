import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGL_CAP_FT,
  AGL_CAP_M,
  DEFAULT_OPTIONS,
  DJI_DEFAULT_HEIGHT_LIMIT_M,
  FT_PER_M,
  MAX_ORBIT_TARGETS,
  MAX_WAYPOINTS_PER_MISSION,
  assembleMissions,
  cleanTimedIntervalS,
  cleanUsableBatteryMin,
  captureSpacingM,
  estimateMission,
  footprint,
  minOrbitAglM,
  normalizeOptions,
  normalizeOrbitTargets,
  orbitClearance,
  planFlight,
  spacing,
  INTERVAL_TRIGGER_PROVEN,
  isIntervalTriggerProven,
  takeoffDistanceFromBoxM,
  MAX_MISSIONS,
  MAX_TAKEOFF_FROM_BOX_M,
} from './planner.js';
import { DRONE_PRESETS, getPreset, listPresets } from './presets.js';
import { makeFrame, metersPerDegree, groundDistanceM } from './geo.js';

const mini = getPreset('dji-mini-5-pro');

/** A degrees box `widthM` east-west by `heightM` north-south around a centre. */
function boxAround(lon, lat, widthM, heightM) {
  const m = metersPerDegree(lat);
  return {
    west: lon - widthM / 2 / m.lon,
    east: lon + widthM / 2 / m.lon,
    south: lat - heightM / 2 / m.lat,
    north: lat + heightM / 2 / m.lat,
  };
}
const CENTER = { lon: -97.77, lat: 30.27 };
const flatGround = (plan, takeoffM = 100) => ({
  known: true,
  takeoffM,
  wpM: plan.legs.flatMap((l) => l.waypoints).map(() => takeoffM),
});
const near = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label ?? ''} expected ${expected} +-${tol}, got ${actual}`,
  );

test('presets are a table with the Mini 5 Pro first', () => {
  assert.ok(Object.isFrozen(DRONE_PRESETS));
  assert.equal(listPresets()[0].id, 'dji-mini-5-pro');
  assert.equal(mini.imageWidthPx, 8192);
  assert.equal(mini.imageHeightPx, 6144);
  assert.equal(getPreset('nope'), undefined);
});

test('GSD and footprint match the hand-worked Mini 5 Pro numbers', () => {
  // pixel pitch 8.8 mm / 6144 = 1.4323 um; f = 8.8 mm  =>  GSD = height / 6144.
  const at120 = footprint(mini, 120);
  near(at120.gsdCm, 1.953125, 1e-9, 'gsd 120 m');
  const at100 = footprint(mini, 100);
  near(at100.gsdCm, (100 / 6144) * 100, 1e-9, 'gsd 100 m');
  near(at100.acrossM, 133.3333333, 1e-6, 'across 100 m = 4/3 x height');
  near(at100.alongM, 100, 1e-9, 'along 100 m = 1 x height');
  near(footprint(mini, 50).gsdCm, 0.8138, 1e-3, 'gsd 50 m');
});

test('overlap turns into line and photo spacing', () => {
  const fp = footprint(mini, 100);
  const sp = spacing(fp, 80, 70);
  near(sp.lineM, 40, 1e-6, 'side overlap 70% -> 30% of 133.33 m');
  near(sp.photoM, 20, 1e-9, 'front overlap 80% -> 20% of 100 m');
});

test('a forward-tilted camera sees a longer, narrower-at-the-near-edge footprint', () => {
  // 120 m, gimbal -60 deg => 30 deg off nadir. Vertical half-FOV =
  // atan(4.4/8.8) = 26.565 deg, so the ground runs from
  // 120*tan(3.435 deg) = 7.2 m to 120*tan(56.565 deg) = 181.8 m ahead.
  const fp = footprint(mini, 120, 30);
  near(fp.alongM, 174.55, 0.2, 'along');
  const centre = 120 / Math.cos((30 * Math.PI) / 180);
  near(fp.gsdCm, (centre * (8.8 / 6144) * 100) / 8.8, 1e-6, 'centre gsd');
  assert.ok(fp.acrossM > footprint(mini, 120).acrossM);
  assert.throws(() => footprint(mini, 120, 70), RangeError);
});

test('the planning maximum is 1500 ft (457.2 m); the DJI default limit stays 120 m', () => {
  assert.equal(AGL_CAP_FT, 1500);
  assert.equal(AGL_CAP_M, 457.2);
  near(AGL_CAP_FT * 0.3048, AGL_CAP_M, 1e-9, '1500 ft in metres');
  near(AGL_CAP_M * FT_PER_M, 1500, 1e-9, '457.2 m in feet');
  // The aircraft app's own starting limit is a different fact and is kept.
  assert.equal(DJI_DEFAULT_HEIGHT_LIMIT_M, 120);
  assert.equal(DEFAULT_OPTIONS.aglM, 80, 'the default mission height is unchanged');
  const { options, notes } = normalizeOptions({ aglM: 500 });
  assert.equal(options.aglM, AGL_CAP_M);
  assert.equal(notes[0].code, 'agl-capped');
  assert.deepEqual(notes[0].params, { requested: 500, cap: 457.2 });
  assert.equal(normalizeOptions({ aglM: 1 }).options.aglM, 10);
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 300, 300), {
    aglM: 999,
  });
  assert.ok(
    plan.legs.every((l) => l.waypoints.every((w) => w.aglM <= AGL_CAP_M)),
  );
});

test('heights up to and including 1500 ft are kept as asked; only above it is capped', () => {
  for (const aglM of [120, 121.92, 122, 300, 456.9, 457.2]) {
    const { options, notes } = normalizeOptions({ aglM });
    assert.equal(options.aglM, aglM, `${aglM} m kept`);
    assert.deepEqual(notes, [], `${aglM} m raises no cap note`);
  }
  const over = normalizeOptions({ aglM: 457.21 });
  assert.equal(over.options.aglM, 457.2);
  assert.equal(over.notes[0].code, 'agl-capped');
  // What the feet slider hands over at its top stop is the cap, not above it.
  const topFeetAsMetres = Math.round((1500 / FT_PER_M) * 100) / 100;
  assert.equal(topFeetAsMetres, AGL_CAP_M);
  assert.deepEqual(normalizeOptions({ aglM: topFeetAsMetres }).notes, []);
});

test('a grid at 1500 ft plans at 457.2 m, keeps relative heights, and says what the maximum is not', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 300, 300), {
    aglM: 457.2,
    batteryMin: 60,
  });
  assert.equal(plan.error, undefined);
  assert.equal(plan.options.aglM, 457.2);
  assert.equal(plan.notes.find((n) => n.code === 'agl-capped'), undefined);
  const waypoints = plan.legs.flatMap((l) => l.waypoints);
  assert.ok(waypoints.length > 0);
  assert.ok(waypoints.every((w) => w.aglM === 457.2));
  const done = assembleMissions(plan, flatGround(plan, 100));
  const rel = done.missions.flatMap((mi) => mi.waypoints.map((w) => w.relHeightM));
  assert.ok(rel.every((h) => h === 457.2), 'heights relative to takeoff on flat ground');
  const notice = done.warnings.find((w) => w.code === 'agl-above-400ft');
  assert.ok(notice, 'the planning-maximum notice is raised');
  assert.deepEqual(notice.params, { maxAglM: 457.2, capM: 457.2 });
  // The aircraft app starts at 120 m above takeoff: that warning stays too.
  const dji = done.warnings.find((w) => w.code === 'rel-height-over-limit');
  assert.ok(dji);
  assert.equal(dji.params.limitM, 120);
  assert.equal(dji.params.maxRelM, 457);
  assert.equal(done.warnings.find((w) => w.code === 'agl-capped'), undefined);
});

test('the 400 ft notice starts above 400 ft and never on the default heights', () => {
  const noticeFor = (aglM) => {
    const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 300, 300), {
      aglM,
      batteryMin: 60,
    });
    return assembleMissions(plan, flatGround(plan, 0)).warnings.some(
      (w) => w.code === 'agl-above-400ft',
    );
  };
  assert.equal(noticeFor(DEFAULT_OPTIONS.aglM), false, 'default 80 m');
  assert.equal(noticeFor(120), false, '120 m');
  assert.equal(noticeFor(121.92), false, 'exactly 400 ft');
  assert.equal(noticeFor(122), true, 'just over 400 ft');
  assert.equal(noticeFor(250), true);
});

test('a 1500 ft orbit keeps its rings under the planning maximum, not 400 ft', () => {
  const { options } = normalizeOptions({
    pattern: 'orbit',
    orbitRingMode: 'heights',
    orbitHeightsM: [200, 457.2, 900],
    obstacleHeightM: 15,
  });
  assert.deepEqual(options.orbitHeightsM, [200, 457.2, 457.2]);
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 200, 200), {
    pattern: 'orbit',
    orbitRingMode: 'heights',
    orbitHeightsM: [300, 457.2],
    batteryMin: 60,
  });
  assert.equal(plan.error, undefined);
  const heights = [
    ...new Set(plan.legs.flatMap((l) => l.waypoints.map((w) => w.aglM))),
  ].sort((a, b) => a - b);
  assert.deepEqual(heights, [300, 457.2]);
});

test('nadir grid: 400 x 200 m at 100 m gives 5 lines of 21 photos', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const plan = planFlight(box, {
    aglM: 100,
    frontOverlap: 80,
    sideOverlap: 70,
  });
  assert.equal(plan.error, undefined);
  // 200 m / 40 m spacing = 5 lines; 400 m / 20 m = 20 gaps = 21 photos each.
  assert.equal(plan.legs.length, 5);
  assert.ok(plan.legs.every((l) => l.waypoints.length === 21));
  assert.equal(plan.waypointCount, 105);
  const frame = makeFrame(plan.center.lon, plan.center.lat);
  const ys = plan.legs.map(
    (l) => frame.toXY(l.waypoints[0].lon, l.waypoints[0].lat).y,
  );
  ys.forEach((y, i) => near(y, -80 + 40 * i, 0.05, `line ${i} offset`));
  // Lines run east-west (long axis) and alternate direction (boustrophedon).
  const xs = plan.legs.map((l) => [
    frame.toXY(l.waypoints[0].lon, l.waypoints[0].lat).x,
    frame.toXY(l.waypoints[20].lon, l.waypoints[20].lat).x,
  ]);
  near(xs[0][0], -200, 0.05);
  near(xs[0][1], 200, 0.05);
  near(xs[1][0], 200, 0.05);
  near(xs[1][1], -200, 0.05);
  // Photo spacing is no wider than the requested 20 m.
  const a = plan.legs[0].waypoints;
  assert.ok(groundDistanceM(a[0], a[1]) <= 20.001);
  assert.ok(plan.legs.every((l) => l.pitchDeg === -90));
  near(plan.gsdCm, (100 / 6144) * 100, 1e-6);
  assert.equal(plan.takeoff.custom, false);
  near(plan.takeoff.lon, CENTER.lon, 1e-6);
});

test('photo spacing caps the speed to what the shutter can keep up with', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    speedMs: 5,
  });
  // 20 m between photos / 5 s minimum interval = 4 m/s.
  assert.equal(plan.speedMs, 4);
  assert.equal(plan.speedLimitedBy, 'camera');
  assert.ok(plan.notes.some((n) => n.code === 'speed-camera-limited'));
  const slow = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    speedMs: 2,
  });
  assert.equal(slow.speedMs, 2);
  assert.equal(slow.speedLimitedBy, null);
});

test('direction: auto follows the long side, ns and custom angles rotate it', () => {
  const tall = planFlight(boxAround(CENTER.lon, CENTER.lat, 200, 400), {
    aglM: 100,
  });
  const frame = makeFrame(tall.center.lon, tall.center.lat);
  const a = frame.toXY(
    tall.legs[0].waypoints[0].lon,
    tall.legs[0].waypoints[0].lat,
  );
  const b = frame.toXY(
    tall.legs[0].waypoints[1].lon,
    tall.legs[0].waypoints[1].lat,
  );
  assert.ok(Math.abs(b.y - a.y) > Math.abs(b.x - a.x), 'runs north-south');
  const ns = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    direction: 'ns',
  });
  const c = frame.toXY(
    ns.legs[0].waypoints[0].lon,
    ns.legs[0].waypoints[0].lat,
  );
  const d = frame.toXY(
    ns.legs[0].waypoints[1].lon,
    ns.legs[0].waypoints[1].lat,
  );
  assert.ok(Math.abs(d.y - c.y) > Math.abs(d.x - c.x));
  // A 45 degree plan still stays inside the box (clipped to it).
  const diag = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    direction: 45,
  });
  for (const w of diag.legs.flatMap((l) => l.waypoints)) {
    const p = frame.toXY(w.lon, w.lat);
    assert.ok(Math.abs(p.x) <= 200.01 && Math.abs(p.y) <= 100.01);
  }
});

test('double grid: two perpendicular tilted passes, lines shifted back by the look-ahead', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 300), {
    aglM: 100,
    pattern: 'double',
    tiltPitchDeg: -60,
  });
  assert.equal(plan.passCount, 2);
  assert.deepEqual([...new Set(plan.legs.map((l) => l.passId))], [0, 1]);
  assert.ok(plan.legs.every((l) => l.pitchDeg === -60));
  const frame = makeFrame(plan.center.lon, plan.center.lat);
  const first = plan.legs[0].waypoints[0];
  const p = frame.toXY(first.lon, first.lat);
  // Travelling east, the camera looks east: the drone starts west of the box
  // edge (x = -200) by 100 m * tan(30 deg) = 57.7 m.
  near(p.x, -200 - 100 * Math.tan(Math.PI / 6), 0.05, 'look-ahead shift');
  const secondPass = plan.legs.find((l) => l.passId === 1);
  const a = frame.toXY(
    secondPass.waypoints[0].lon,
    secondPass.waypoints[0].lat,
  );
  const b = frame.toXY(
    secondPass.waypoints[1].lon,
    secondPass.waypoints[1].lat,
  );
  assert.ok(
    Math.abs(b.y - a.y) > Math.abs(b.x - a.x),
    'second pass is perpendicular',
  );
});

test('orbit: rings on the radius, aimed at the centre', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 100, 100), {
    pattern: 'orbit',
    orbitRadiusM: 50,
    orbitHeightsM: [30, 60],
    orbitTargetHeightM: 3,
  });
  assert.equal(plan.legs.length, 2);
  const frame = makeFrame(plan.center.lon, plan.center.lat);
  for (const leg of plan.legs) {
    assert.equal(leg.kind, 'orbit');
    assert.ok(leg.waypoints.length >= 12);
    for (const w of leg.waypoints) {
      const p = frame.toXY(w.lon, w.lat);
      near(Math.hypot(p.x, p.y), 50, 0.05, 'on the ring');
      // Heading is the compass bearing to the centre.
      const toCentre = (Math.atan2(-p.x, -p.y) * 180) / Math.PI;
      const diff = ((w.headingDeg - toCentre + 540) % 360) - 180;
      near(diff, 0, 0.1, 'faces the centre');
    }
  }
  // Pitch aims at 3 m above the ground at the centre: atan((30-3)/50).
  near(plan.legs[0].pitchDeg, -Math.atan2(27, 50) * (180 / Math.PI), 0.06);
  assert.deepEqual(
    plan.legs.map((l) => l.waypoints[0].aglM),
    [30, 60],
  );
  // The second ring runs the other way round.
  const dir = (leg) => {
    const f = (w) => {
      const p = frame.toXY(w.lon, w.lat);
      return Math.atan2(p.y, p.x);
    };
    return Math.sign(Math.sin(f(leg.waypoints[1]) - f(leg.waypoints[0])));
  };
  assert.equal(dir(plan.legs[0]), -dir(plan.legs[1]));
});

test('custom takeoff point is kept', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 200, 200), {
    takeoff: { lon: -97.769, lat: 30.271 },
  });
  assert.equal(plan.takeoff.custom, true);
  assert.equal(plan.takeoff.lon, -97.769);
});

test('a takeoff point must be two real coordinates', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 200, 200);
  for (const bad of [
    { lon: '-97.769', lat: '30.271' },
    { lon: NaN, lat: 30.27 },
    { lon: -97.77, lat: 91 },
    { lon: 181, lat: 30.27 },
    { lon: -97.77 },
    'north',
  ]) {
    const plan = planFlight(box, { takeoff: bad });
    assert.equal(plan.takeoff.custom, false, JSON.stringify(bad));
    assert.equal(plan.options.takeoff, null);
  }
  const ok = planFlight(box, {
    takeoff: { lon: -97.769, lat: 30.271, extra: 1 },
  });
  assert.deepEqual(ok.options.takeoff, { lon: -97.769, lat: 30.271 });
});

test('a short box across the antimeridian is planned on that arc, not the other side of the earth', () => {
  const lat = -15;
  const m = metersPerDegree(lat);
  const half = 200 / m.lon;
  const box = {
    west: 180 - half,
    east: -180 + half,
    south: lat - 20 / m.lat,
    north: lat + 20 / m.lat,
  };
  const across = groundDistanceM(
    { lon: box.west, lat },
    { lon: box.east, lat },
  );
  assert.ok(across < 500, `short arc is ${across} m, not a world crossing`);
  const away = takeoffDistanceFromBoxM(box, { lon: 180, lat });
  assert.ok(away < 30, `centre reads as ${away} m from the box`);
  // A non-finite radius asks for the box-derived default. null is a set value
  // (Number(null) is 0) and is not that path.
  assert.equal(
    normalizeOptions({ orbitRadiusM: Number.NaN }, box).options.orbitRadiusM,
    120,
  );
  const plan = planFlight(box, { aglM: 50, frontOverlap: 70, sideOverlap: 60 });
  assert.equal(plan.error, undefined, plan.message);
  const lons = plan.legs.flatMap((leg) => leg.waypoints.map((w) => w.lon));
  assert.ok(lons.length > 2);
  for (const lon of lons) {
    const fromDateline = Math.min(Math.abs(lon - 180), Math.abs(lon + 180));
    assert.ok(fromDateline < 0.02, `waypoint lon ${lon} left the dateline`);
  }
});

test('unplannable boxes are refused, not thrown', () => {
  assert.equal(planFlight(null).error, 'bad-box');
  assert.equal(
    planFlight({ west: 1, east: 1, south: 0, north: 1 }).error,
    'bad-box',
  );
  const huge = planFlight(boxAround(CENTER.lon, CENTER.lat, 20000, 20000), {
    aglM: 40,
    frontOverlap: 90,
    sideOverlap: 90,
  });
  assert.equal(huge.error, 'too-large');
});

test('terrain: heights are relative to the takeoff point and AGL is kept', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 80,
    batteryMin: 60,
  });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  // Ground rises 0.1 m per waypoint id from 100 m at the takeoff point.
  const wpM = ids.map((id) => 100 + id * 0.1);
  const result = assembleMissions(plan, { known: true, takeoffM: 100, wpM });
  for (const m of result.missions) {
    for (const w of m.waypoints) {
      near(w.relHeightM, wpM[w.id] + 80 - 100, 0.051, 'relative height');
      near(w.groundM + w.aglM - 100, w.relHeightM, 0.051);
      assert.equal(w.aglM, 80);
    }
  }
  assert.equal(
    result.warnings.some((w) => w.code === 'rel-height-over-limit'),
    false,
  );
});

test('terrain too steep for the height: warns that the limit is unreachable', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    batteryMin: 60,
  });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  // A 60 m hill above the takeoff point: 100 m AGL is 160 m above takeoff.
  const wpM = ids.map(() => 160);
  const result = assembleMissions(plan, { known: true, takeoffM: 100, wpM });
  const warning = result.warnings.find(
    (w) => w.code === 'rel-height-over-limit',
  );
  assert.ok(warning);
  assert.equal(warning.params.maxRelM, 160);
  assert.equal(warning.params.limitM, 120);
  assert.equal(result.totals.maxRelHeightM, 160);
});

test('terrain below the takeoff point and steep segments are flagged', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 20,
    batteryMin: 60,
  });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const wpM = ids.map((id) => (id % 2 ? 40 : 100));
  const result = assembleMissions(plan, { known: true, takeoffM: 100, wpM });
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes('below-takeoff'));
  assert.ok(codes.includes('steep-segment'));
});

test('missing terrain falls back to flat ground and says so', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 200, 200), {});
  const result = assembleMissions(plan, { known: false });
  assert.ok(result.warnings.some((w) => w.code === 'terrain-unknown'));
  assert.ok(result.missions[0].waypoints.every((w) => w.relHeightM === 80));
});

test('split: no mission exceeds the waypoint limit and nothing is lost', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    batteryMin: 60,
    maxWaypoints: 50,
  });
  const result = assembleMissions(plan, flatGround(plan));
  // 5 lines of 21: two lines per mission (42), then 42, then one line (21).
  assert.deepEqual(
    result.missions.map((m) => m.waypointCount),
    [42, 42, 21],
  );
  assert.equal(result.totals.waypointCount, 105);
  assert.equal(result.totals.photoCount, 105);
  assert.equal(result.totals.missionCount, 3);
  // Whole lines stay together; indexes restart at 0 in every mission.
  for (const m of result.missions) {
    assert.deepEqual(
      m.waypoints.map((w) => w.index),
      m.waypoints.map((_, i) => i),
    );
  }
});

test('split: the hard 200-waypoint limit cannot be raised', () => {
  assert.equal(
    normalizeOptions({ maxWaypoints: 5000 }).options.maxWaypoints,
    200,
  );
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 1000, 700), {
    aglM: 80,
    batteryMin: 60,
    maxWaypoints: 5000,
  });
  const result = assembleMissions(plan, flatGround(plan));
  assert.ok(result.missions.length > 1);
  for (const m of result.missions) {
    assert.ok(
      m.waypointCount <= MAX_WAYPOINTS_PER_MISSION,
      `${m.waypointCount}`,
    );
  }
  const ids = new Set(
    result.missions.flatMap((m) => m.waypoints.map((w) => w.id)),
  );
  assert.equal(ids.size, plan.waypointCount, 'every planned waypoint is flown');
});

test('split: battery time bounds every mission', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 800, 600), {
    aglM: 100,
    batteryMin: 5,
    speedMs: 4,
  });
  const result = assembleMissions(plan, flatGround(plan));
  assert.ok(result.missions.length > 1);
  for (const m of result.missions) {
    assert.ok(
      m.durationS <= 5 * 60 + 0.001,
      `mission ${m.index} ${m.durationS}s`,
    );
  }
  assert.equal(
    result.warnings.some((w) => w.code === 'mission-over-budget'),
    false,
  );
});

test('a leg longer than one battery is cut, sharing its boundary waypoint', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 1500, 100), {
    aglM: 100,
    batteryMin: 5,
    speedMs: 4,
  });
  const result = assembleMissions(plan, flatGround(plan));
  assert.ok(result.missions.length >= 2);
  const a = result.missions[0].waypoints.at(-1);
  const b = result.missions[1].waypoints[0];
  assert.equal(a.id, b.id, 'pieces join at the same waypoint');
});

test('estimateMission counts the climb out, the route and the way home', () => {
  const takeoff = { lon: CENTER.lon, lat: CENTER.lat };
  const m = metersPerDegree(CENTER.lat);
  const wp = (xM, h) => ({
    lon: CENTER.lon + xM / m.lon,
    lat: CENTER.lat,
    relHeightM: h,
  });
  const est = estimateMission([wp(100, 0), wp(300, 0)], takeoff, 4, 1);
  near(est.routeM, 200, 0.05);
  near(est.distanceM, 100 + 200 + 300, 0.1);
  // 200 m at 4 m/s + 400 m at 8 m/s + 45 s overhead.
  near(est.durationS, 50 + 50 + 45, 0.1);
});

test('interval photo mode flies few waypoints and photos by distance', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    photoMode: 'interval',
  });
  assert.ok(plan.legs.every((l) => l.photoMode === 'interval'));
  assert.ok(plan.legs.every((l) => l.waypoints.length === 8)); // 400 m / 60 m
  assert.ok(
    plan.legs.every((l) => l.waypoints.every((w) => w.photo === false)),
  );
  assert.equal(plan.legs[0].photoCount, 21);
  near(plan.legs[0].photoSpacingM, 20, 1e-9);
});

test('waypoints without a terrain height are counted, guessed from the route and never from the takeoff height', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    batteryMin: 60,
  });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  // 100 m of ground at the takeoff point, 40 m of ground along the route, and
  // three waypoints the terrain could not read.
  const wpM = ids.map((id) => (id >= 10 && id < 13 ? null : 40));
  const result = assembleMissions(plan, {
    known: true,
    takeoffM: 100,
    wpM,
    missing: 3,
  });
  assert.equal(result.terrainComplete, false);
  assert.equal(result.ground.missing, 3);
  const warning = result.warnings.find((w) => w.code === 'terrain-partial');
  assert.deepEqual(warning.params, { count: 3 });
  const flown = result.missions.flatMap((m) => m.waypoints);
  const guessed = flown.filter((w) => w.groundEstimated);
  assert.deepEqual(
    guessed.map((w) => w.id),
    [10, 11, 12],
  );
  for (const w of guessed) {
    assert.equal(
      w.groundM,
      40,
      'the nearest read height before it, not the takeoff 100 m',
    );
    near(w.relHeightM, 40 + 100 - 100, 0.051);
  }
});

test('a plan is terrain-complete only when every height was read', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 200, 200), {});
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const read = assembleMissions(plan, {
    known: true,
    takeoffM: 5,
    wpM: ids.map(() => 5),
    missing: 0,
  });
  assert.equal(read.terrainComplete, true);
  assert.equal(
    read.warnings.some((w) => w.code === 'terrain-partial'),
    false,
  );
  const unknown = assembleMissions(plan, { known: false });
  assert.equal(unknown.terrainComplete, false);
});

test('the distance from a takeoff point to the box is measured to its nearest edge', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const m = metersPerDegree(CENTER.lat);
  assert.equal(takeoffDistanceFromBoxM(box, CENTER), 0, 'inside');
  const east = { lon: CENTER.lon + (200 + 300) / m.lon, lat: CENTER.lat };
  near(
    takeoffDistanceFromBoxM(box, east),
    300,
    0.1,
    'straight out from an edge',
  );
  const corner = {
    lon: CENTER.lon + (200 + 300) / m.lon,
    lat: CENTER.lat + (100 + 400) / m.lat,
  };
  near(takeoffDistanceFromBoxM(box, corner), 500, 0.1, '3-4-5 from a corner');
});

test('a takeoff further than the limit from the box is refused and the centre is used', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const m = metersPerDegree(CENTER.lat);
  const at = (metres) => ({
    lon: CENTER.lon + (200 + metres) / m.lon,
    lat: CENTER.lat,
  });
  const near900 = planFlight(box, {
    takeoff: at(MAX_TAKEOFF_FROM_BOX_M - 100),
  });
  assert.equal(near900.takeoff.custom, true);
  assert.equal(
    near900.notes.some((n) => n.code === 'takeoff-too-far'),
    false,
  );
  const far = planFlight(box, { takeoff: at(MAX_TAKEOFF_FROM_BOX_M + 500) });
  assert.equal(far.takeoff.custom, false);
  near(far.takeoff.lon, CENTER.lon, 1e-6);
  const note = far.notes.find((n) => n.code === 'takeoff-too-far');
  assert.equal(note.params.limitM, MAX_TAKEOFF_FROM_BOX_M);
  assert.ok(note.params.distanceM > MAX_TAKEOFF_FROM_BOX_M);
});

test('a waypoint where a long leg is cut is photographed once, not in both missions', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 1500, 100), {
    aglM: 100,
    batteryMin: 5,
    speedMs: 4,
  });
  const result = assembleMissions(plan, flatGround(plan));
  assert.ok(result.missions.length >= 2);
  const flown = result.missions.flatMap((m) => m.waypoints);
  const unique = new Set(flown.map((w) => w.id));
  assert.equal(
    result.totals.photoCount,
    unique.size,
    'one photo per distinct waypoint',
  );
  const a = result.missions[0].waypoints.at(-1);
  const b = result.missions[1].waypoints[0];
  assert.equal(a.id, b.id);
  assert.equal(a.photo, true);
  assert.equal(
    b.photo,
    false,
    'the second mission starts there without a second photo',
  );
});

test('a plan that would need more than the mission cap is cut off and flagged, not built in full', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 2500, 2500), {
    aglM: 100,
    batteryMin: 5,
    speedMs: 4,
  });
  assert.equal(plan.error, undefined);
  const result = assembleMissions(plan, flatGround(plan));
  assert.equal(result.truncated, true);
  assert.equal(result.missions.length, MAX_MISSIONS);
  const warning = result.warnings.find((w) => w.code === 'too-many-missions');
  assert.deepEqual(warning.params, { count: MAX_MISSIONS });
  const over = result.warnings.filter((w) => w.code === 'mission-over-budget');
  assert.ok(
    over.length <= 1,
    'the over-budget warning is raised once, not per piece',
  );
});

test('a gap at the start of the route takes the first height read after it, not the takeoff height', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    batteryMin: 60,
  });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const wpM = ids.map((id) => (id < 3 ? null : 40));
  const result = assembleMissions(plan, {
    known: true,
    takeoffM: 100,
    wpM,
    missing: 3,
  });
  const guessed = result.missions
    .flatMap((m) => m.waypoints)
    .filter((w) => w.groundEstimated);
  assert.deepEqual(
    guessed.map((w) => w.id),
    [0, 1, 2],
  );
  assert.ok(
    guessed.every((w) => w.groundM === 40),
    'not the 100 m takeoff ground',
  );
});

test('interval mode: a cut leg is not counted twice at the cut', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 1500, 100), {
    aglM: 100,
    batteryMin: 5,
    speedMs: 4,
    photoMode: 'interval',
  });
  const result = assembleMissions(plan, flatGround(plan));
  assert.ok(result.missions.length >= 2);
  const spacing = plan.legs[0].photoSpacingM;
  const metres = result.missions
    .flatMap((m) => m.legs)
    .reduce((sum, l) => sum + l.lengthM, 0);
  // One photo per spacing step along the line plus one at its very start.
  assert.ok(
    result.totals.photoCount <= Math.floor(metres / spacing) + plan.legs.length,
    `${result.totals.photoCount} photos for ${Math.round(metres)} m`,
  );
  const continued = result.missions
    .flatMap((m) => m.legs)
    .filter((l) => l.continued);
  assert.ok(
    continued.length >= 1,
    'later pieces are marked as continuing a leg',
  );
});

// ------------------------------------------------ obstacle / tree clearance --
test('orbit: rings are raised to obstacle + 5 m and the plan says so', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 100, 100);
  const plan = planFlight(box, {
    pattern: 'orbit',
    orbitRadiusM: 40,
    orbitHeightsM: [12, 20],
    obstacleHeightM: 25,
  });
  assert.equal(plan.error, undefined);
  const aglOf = (leg) => new Set(leg.waypoints.map((w) => w.aglM));
  assert.deepEqual([...aglOf(plan.legs[0])], [30]);
  assert.deepEqual([...aglOf(plan.legs[1])], [30]);
  assert.equal(plan.orbit.minAglM, 30);
  assert.ok(plan.notes.some((n) => n.code === 'orbit-raised-for-obstacles'));
});

test('orbit: the default obstacle is 15 m, so no ring flies under 20 m', () => {
  assert.equal(normalizeOptions({}).options.obstacleHeightM, 15);
  const { options } = normalizeOptions({
    pattern: 'orbit',
    orbitHeightsM: [10, 60],
  });
  assert.deepEqual(options.orbitHeightsM, [20, 60]);
  assert.equal(minOrbitAglM(15), 20);
  assert.equal(minOrbitAglM(0), 10);
  assert.equal(minOrbitAglM(500), AGL_CAP_M);
});

test('orbit: rings already above the fly-over floor are left alone', () => {
  const { options, notes } = normalizeOptions({
    pattern: 'orbit',
    orbitHeightsM: [40, 80],
    obstacleHeightM: 15,
  });
  assert.deepEqual(options.orbitHeightsM, [40, 80]);
  assert.ok(!notes.some((n) => n.code === 'orbit-raised-for-obstacles'));
});

test('orbitClearance: the sightline clears trees beyond the reported zone', () => {
  const c = orbitClearance({
    ringAglM: 40,
    radiusM: 30,
    targetHeightM: 3,
    obstacleHeightM: 15,
  });
  // The line from the camera to the target top: height 3 + 37 * d / 30.
  near(c.obstructionRadiusM, (30 * 12) / 37, 0.1, 'obstruction radius');
  assert.equal(c.flyoverClearM, 25);
  assert.equal(c.clearsFlyover, true);
  const d = c.obstructionRadiusM + 0.5;
  assert.ok(3 + (37 * d) / 30 > 15, 'a tree just past the zone is cleared');
  const lowTree = orbitClearance({
    ringAglM: 20,
    radiusM: 30,
    targetHeightM: 15,
    obstacleHeightM: 15,
  });
  assert.equal(lowTree.obstructionRadiusM, 0, 'target as tall as the trees');
});

test('orbit targets: one orbit per active target, hopping above the trees', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 300);
  const m = metersPerDegree(CENTER.lat);
  const t1 = { lon: CENTER.lon - 100 / m.lon, lat: CENTER.lat, id: 'a' };
  const t2 = { lon: CENTER.lon + 100 / m.lon, lat: CENTER.lat, id: 'b' };
  const off = { lon: CENTER.lon, lat: CENTER.lat + 80 / m.lat, id: 'c', active: false };
  const plan = planFlight(box, {
    pattern: 'orbit',
    orbitRadiusM: 30,
    orbitHeightsM: [30, 50],
    obstacleHeightM: 20,
    orbitTargets: [t1, off, t2],
  });
  assert.equal(plan.error, undefined);
  const kinds = plan.legs.map((l) => l.kind);
  assert.deepEqual(kinds, ['orbit', 'orbit', 'transit', 'orbit', 'orbit']);
  assert.deepEqual(
    plan.orbit.targets.map((t) => t.id),
    ['a', 'b'],
    'the switched-off target is not flown',
  );
  const frame = makeFrame(CENTER.lon, CENTER.lat);
  for (const [legIndex, target] of [[0, t1], [3, t2]]) {
    const c = frame.toXY(target.lon, target.lat);
    for (const w of plan.legs[legIndex].waypoints) {
      const p = frame.toXY(w.lon, w.lat);
      near(Math.hypot(p.x - c.x, p.y - c.y), 30, 0.5, 'on the target ring');
    }
  }
  // Nothing is ever flown below obstacle + margin, hop or ring.
  for (const w of plan.legs.flatMap((l) => l.waypoints)) {
    assert.ok(w.aglM >= 25, `waypoint at ${w.aglM} m is under the trees + margin`);
  }
  const hop = plan.legs[2];
  assert.ok(hop.waypoints.every((w) => w.aglM >= 50 && !w.photo));
  assert.equal(hop.photoCount, 0);
  const missions = assembleMissions(plan, flatGround(plan));
  assert.ok(missions.missions.length >= 1);
  assert.equal(
    missions.totals.photoCount,
    plan.legs.reduce((s, l) => s + l.photoCount, 0),
  );
});

test('orbit targets: all switched off is an error, an empty list means the centre', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 200, 200);
  const none = planFlight(box, {
    pattern: 'orbit',
    orbitTargets: [{ lon: CENTER.lon, lat: CENTER.lat, active: false }],
  });
  assert.equal(none.error, 'no-orbit-targets');
  const centre = planFlight(box, { pattern: 'orbit', orbitTargets: [] });
  assert.equal(centre.error, undefined);
  assert.equal(centre.orbit.targets.length, 1);
  near(centre.orbit.targets[0].lon, CENTER.lon, 1e-6, 'centre lon');
});

test('orbit targets: bad entries are dropped and the list is capped', () => {
  const list = normalizeOrbitTargets([
    { lon: 'x', lat: 1 },
    { lon: 200, lat: 1 },
    ...Array.from({ length: 30 }, (_, i) => ({ lon: i / 100, lat: 1 })),
  ]);
  assert.equal(list.length, MAX_ORBIT_TARGETS);
  assert.equal(list[0].active, true);
  assert.equal(normalizeOrbitTargets(null), null);
});

test('captureMode defaults to stop; maxWaypoints is 20 to 200', () => {
  const { options } = normalizeOptions({});
  assert.equal(options.captureMode, 'stop');
  assert.equal(options.photoMode, 'waypoint');
  assert.equal(options.continuousRoute, false);
  assert.equal(options.intervalTriggerProven, false);
  assert.equal(DEFAULT_OPTIONS.intervalTriggerProven, false);
  assert.equal(options.photoSpacingM, null);
  assert.equal(options.maxWaypoints, 200);
  assert.equal(options.usableBatteryMin, 20);
  assert.equal(cleanUsableBatteryMin(undefined), 20);
  assert.equal(cleanUsableBatteryMin(null), 20);
  assert.equal(cleanUsableBatteryMin(0), 20);
  assert.equal(cleanUsableBatteryMin(-3), 20);
  assert.equal(cleanUsableBatteryMin('x'), 20);
  assert.equal(normalizeOptions({ usableBatteryMin: 4 }).options.usableBatteryMin, 5);
  assert.equal(normalizeOptions({ usableBatteryMin: 90 }).options.usableBatteryMin, 60);
  assert.equal(normalizeOptions({ usableBatteryMin: 18 }).options.usableBatteryMin, 18);
  assert.equal(normalizeOptions({ usableBatteryMin: 20.6 }).options.usableBatteryMin, 21);
  assert.equal(MAX_WAYPOINTS_PER_MISSION, 200);
  const junk = normalizeOptions({
    captureMode: 'hover',
    continuousRoute: true,
    photoSpacingM: 0,
    maxWaypoints: 10,
  });
  assert.equal(junk.options.captureMode, 'stop');
  assert.equal(junk.options.continuousRoute, false);
  assert.equal(junk.options.photoSpacingM, null);
  assert.equal(junk.options.maxWaypoints, 20);
  assert.equal(normalizeOptions({ maxWaypoints: 19.9 }).options.maxWaypoints, 20);
  assert.equal(normalizeOptions({ maxWaypoints: 200 }).options.maxWaypoints, 200);
  assert.equal(normalizeOptions({ maxWaypoints: 5000 }).options.maxWaypoints, 200);
  assert.equal(
    normalizeOptions({ photoSpacingM: '25' }).options.photoSpacingM,
    null,
    'a numeric string is not an explicit number',
  );
  assert.equal(
    normalizeOptions({ photoSpacingM: 25 }).options.photoSpacingM,
    25,
  );
});

test('intervalTriggerProven stays false; a stored true cannot prove the trigger', () => {
  assert.equal(isIntervalTriggerProven(undefined), false);
  assert.equal(isIntervalTriggerProven(false), false);
  assert.equal(isIntervalTriggerProven('true'), false);
  assert.equal(isIntervalTriggerProven(1), false);
  assert.equal(INTERVAL_TRIGGER_PROVEN, false);
  assert.equal(isIntervalTriggerProven(true), false);
  assert.equal(isIntervalTriggerProven(), INTERVAL_TRIGGER_PROVEN);
  assert.equal(normalizeOptions({}).options.intervalTriggerProven, false);
  assert.equal(
    normalizeOptions({ captureMode: 'distance' }).options.intervalTriggerProven,
    false,
  );
  assert.equal(
    normalizeOptions({ intervalTriggerProven: 'yes' }).options.intervalTriggerProven,
    false,
  );
  assert.equal(
    normalizeOptions({ intervalTriggerProven: false }).options.intervalTriggerProven,
    false,
  );
  const stored = normalizeOptions({
    captureMode: 'distance',
    intervalTriggerProven: true,
  });
  assert.equal(stored.options.intervalTriggerProven, false);
  assert.equal(stored.options.captureMode, 'distance');
});

test('distance capture flies line endpoints and counts photos by spacing', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const stop = planFlight(box, { aglM: 100 });
  const plan = planFlight(box, { aglM: 100, captureMode: 'distance' });
  assert.equal(plan.options.captureMode, 'distance');
  assert.equal(plan.options.continuousRoute, false);
  assert.equal(plan.options.intervalTriggerProven, false);
  assert.equal(plan.legs.length, stop.legs.length);
  for (const leg of plan.legs) {
    assert.equal(leg.captureMode, 'distance');
    assert.equal(leg.continuousRoute, false);
    assert.equal(leg.photoMode, 'waypoint');
    assert.equal(leg.waypoints.length, 2);
    assert.ok(leg.waypoints.every((w) => w.photo === false));
    near(leg.photoSpacingM, 20, 1e-6);
    assert.equal(
      leg.photoCount,
      Math.floor(leg.lengthM / leg.photoSpacingM + 1e-9) + 1,
    );
  }
  assert.equal(plan.legs[0].photoCount, 21);
  for (let i = 0; i < plan.legs.length; i += 1) {
    const a = plan.legs[i].waypoints;
    const b = stop.legs[i].waypoints;
    near(a[0].lon, b[0].lon, 1e-8, 'start lon');
    near(a[0].lat, b[0].lat, 1e-8, 'start lat');
    near(a[1].lon, b.at(-1).lon, 1e-8, 'end lon');
    near(a[1].lat, b.at(-1).lat, 1e-8, 'end lat');
  }
});

test('explicit photoSpacingM overrides overlap only for distance and timed', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const distance = planFlight(box, {
    aglM: 100,
    captureMode: 'distance',
    photoSpacingM: 25,
  });
  assert.ok(distance.legs.every((leg) => leg.photoSpacingM === 25));
  assert.equal(
    distance.legs[0].photoCount,
    Math.floor(distance.legs[0].lengthM / 25 + 1e-9) + 1,
  );
  const timed = planFlight(box, {
    aglM: 100,
    captureMode: 'timed',
    photoSpacingM: 40,
  });
  assert.ok(timed.legs.every((leg) => leg.photoSpacingM === 40));
  assert.ok(timed.legs.every((leg) => leg.waypoints.length === 2));
  const ignored = planFlight(box, { aglM: 100, photoSpacingM: 25 });
  near(ignored.legs[0].photoSpacingM, 20, 1e-6);
  assert.ok(ignored.legs[0].waypoints.length > 2);
  assert.equal(ignored.options.continuousRoute, false);
  const tight = planFlight(box, {
    aglM: 100,
    captureMode: 'distance',
    photoSpacingM: 8,
    speedMs: 15,
  });
  const legacy = planFlight(box, { aglM: 100, photoSpacingM: 8, speedMs: 15 });
  assert.equal(legacy.options.captureMode, 'stop');
  assert.ok(legacy.speedMs < 15, 'legacy stop still lowers speed');
  assert.equal(legacy.speedLimitedBy, 'camera');
  assert.equal(tight.speedMs, 15, 'distance keeps the requested speed');
  assert.equal(tight.speedLimitedBy, null);
  const limit = tight.notes.find((note) => note.code === 'speed-exceeds-camera-limit');
  assert.equal(limit.params.requested, 15);
  assert.equal(limit.params.preserved, true);
  assert.ok(limit.params.limited < 15);
  assert.equal(
    tight.notes.some((note) => note.code === 'speed-camera-limited'),
    false,
  );
});

test('distance with continuousRoute false keeps endpoints but still splits on battery', () => {
  const wide = boxAround(CENTER.lon, CENTER.lat, 200, 800);
  const plan = planFlight(wide, {
    aglM: 100,
    direction: 'ew',
    captureMode: 'distance',
    continuousRoute: false,
    batteryMin: 5,
    speedMs: 15,
    maxWaypoints: 200,
  });
  assert.equal(plan.options.continuousRoute, false);
  assert.ok(plan.legs.every((leg) => leg.waypoints.length === 2));
  assert.ok(plan.legs.every((leg) => leg.continuousRoute === false));
  const built = assembleMissions(plan, flatGround(plan));
  assert.ok(built.missions.length > 1, 'battery split stays on');
  assert.equal(
    built.warnings.some((warning) => warning.code === 'line-end-split'),
    false,
    'a battery split is not a cap-triggered line-end split',
  );
  assert.equal(
    normalizeOptions({
      pattern: 'orbit',
      captureMode: 'timed',
      continuousRoute: true,
    }).options.continuousRoute,
    false,
  );
});

test('distance capture overrides legacy interval subdivision but keeps photoMode', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    photoMode: 'interval',
    captureMode: 'distance',
  });
  assert.equal(plan.options.continuousRoute, false);
  assert.ok(plan.legs.every((leg) => leg.photoMode === 'interval'));
  assert.ok(plan.legs.every((leg) => leg.waypoints.length === 2));
  assert.equal(plan.legs[0].photoCount, 21);
});

test('legacy interval photoMode is unchanged when captureMode is stop', () => {
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 400, 200), {
    aglM: 100,
    photoMode: 'interval',
    captureMode: 'stop',
  });
  assert.equal(plan.options.continuousRoute, false);
  assert.ok(plan.legs.every((leg) => leg.waypoints.length === 8));
  assert.equal(plan.legs[0].photoCount, 21);
  near(plan.legs[0].photoSpacingM, 20, 1e-6);
});

test('continuous distance route skips battery splits and cuts only between lines', () => {
  const wide = boxAround(CENTER.lon, CENTER.lat, 200, 800);
  const shared = {
    aglM: 100,
    direction: 'ew',
    batteryMin: 5,
    speedMs: 15,
  };
  const plan = planFlight(wide, {
    ...shared,
    captureMode: 'distance',
    continuousRoute: true,
    maxWaypoints: 20,
  });
  assert.ok(plan.legs.length > 10, `legs ${plan.legs.length}`);
  assert.ok(plan.legs.every((leg) => leg.waypoints.length === 2));
  const result = assembleMissions(plan, flatGround(plan));
  assert.ok(result.missions.length >= 2);
  for (const mission of result.missions) {
    assert.ok(mission.waypointCount <= 20, `${mission.waypointCount}`);
    assert.equal(mission.waypointCount % 2, 0);
    assert.ok(mission.legs.every((leg) => leg.waypoints.length === 2));
    assert.ok(mission.legs.every((leg) => leg.continued !== true));
  }
  const ids = result.missions.flatMap((mission) =>
    mission.waypoints.map((w) => w.id),
  );
  assert.equal(new Set(ids).size, ids.length, 'no shared cut waypoint');
  assert.equal(
    result.totals.photoCount,
    plan.legs.reduce((sum, leg) => sum + leg.photoCount, 0),
  );
  const split = result.warnings.find((warning) => warning.code === 'line-end-split');
  assert.equal(split.params.reason, 'waypoint-cap');
  assert.equal(split.params.count, result.missions.length - 1);
  assert.equal(split.params.maxWaypoints, 20);
  assert.equal(
    result.warnings.some((warning) => warning.code === 'mission-over-budget'),
    false,
    'a cap split must not block on planned duration',
  );
  const whole = planFlight(wide, {
    ...shared,
    captureMode: 'timed',
    continuousRoute: true,
  });
  const wholeBuilt = assembleMissions(whole, flatGround(whole));
  assert.equal(wholeBuilt.missions.length, 1);
  assert.ok(wholeBuilt.missions[0].durationS > 5 * 60);
  assert.equal(
    wholeBuilt.warnings.some((warning) => warning.code === 'mission-over-budget'),
    false,
    'continuous duration alone must not block the file',
  );
  const stop = assembleMissions(planFlight(wide, shared), flatGround(planFlight(wide, shared)));
  assert.ok(stop.missions.length > 1, 'stop mode still splits on the battery');
});

test('line-end-split is only emitted on a continuous route', () => {
  const wide = boxAround(CENTER.lon, CENTER.lat, 200, 800);
  const stopPlan = planFlight(wide, {
    aglM: 100,
    direction: 'ew',
    batteryMin: 60,
    speedMs: 15,
    maxWaypoints: 50,
  });
  const stopBuilt = assembleMissions(stopPlan, flatGround(stopPlan));
  assert.equal(stopPlan.options.captureMode, 'stop');
  assert.equal(stopPlan.options.continuousRoute, false);
  assert.ok(stopBuilt.missions.length > 1, 'mode A still splits at the waypoint cap');
  assert.equal(
    stopBuilt.warnings.some((warning) => warning.code === 'line-end-split'),
    false,
    'mode A must not get the continuous line-end warning',
  );
  const off = planFlight(wide, {
    aglM: 100,
    direction: 'ew',
    captureMode: 'distance',
    continuousRoute: false,
    photoSpacingM: 25,
    batteryMin: 60,
    speedMs: 8,
    maxWaypoints: 4,
  });
  const offBuilt = assembleMissions(off, flatGround(off));
  assert.equal(off.options.continuousRoute, false);
  assert.ok(offBuilt.missions.length > 1);
  assert.equal(
    offBuilt.warnings.some((warning) => warning.code === 'line-end-split'),
    false,
  );
});

test('continuous over-budget after a transit lift does not block unless the lift is what crosses the battery', () => {
  const m = metersPerDegree(CENTER.lat);
  const box = boxAround(CENTER.lon, CENTER.lat, 160, 60);
  const takeoff = { lon: box.east + 200 / m.lon, lat: CENTER.lat };
  const shared = {
    aglM: 40,
    direction: 'ew',
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 20,
    batteryMin: 60,
    speedMs: 5,
    presetId: 'dji-mini-5-pro',
    takeoff,
  };
  // On the outbound leg, clear of the survey, so only the transit lift changes height.
  const obstacle = {
    id: 'transit-tree',
    kind: 'tree',
    lon: takeoff.lon - 25 / m.lon,
    lat: takeoff.lat,
    heightM: 400,
    radiusM: 8,
  };
  const plainPlan = planFlight(box, shared);
  const liftedPlan = planFlight(box, { ...shared, obstacles: [obstacle] });
  assert.equal(plainPlan.takeoff.custom, true);
  const plain = assembleMissions(plainPlan, flatGround(plainPlan));
  const lifted = assembleMissions(liftedPlan, flatGround(liftedPlan));
  const plainS = plain.missions[0].durationS;
  const liftedS = lifted.missions[0].durationS;
  assert.equal(
    lifted.missions[0].waypoints[1].aglM,
    plain.missions[0].waypoints[1].aglM,
    'the survey line itself is not raised',
  );
  assert.ok(
    lifted.missions[0].waypoints[0].aglM > plain.missions[0].waypoints[0].aglM,
    'transit lift raised the first waypoint',
  );
  assert.ok(liftedS > plainS + 1, `lift added time ${plainS} -> ${liftedS}`);
  const at = (plan, batteryMin) =>
    assembleMissions(
      { ...plan, options: { ...plan.options, batteryMin } },
      flatGround(plan),
    );
  const longBox = boxAround(CENTER.lon, CENTER.lat, 2400, 40);
  const longTakeoff = { lon: longBox.east + 200 / m.lon, lat: CENTER.lat };
  const longLifted = planFlight(longBox, {
    ...shared,
    takeoff: longTakeoff,
    speedMs: 12,
    batteryMin: 5,
    obstacles: [{ ...obstacle, lon: longTakeoff.lon - 25 / m.lon }],
  });
  const alreadyOver = assembleMissions(longLifted, flatGround(longLifted));
  assert.ok(alreadyOver.missions[0].durationS > 5 * 60);
  assert.ok(alreadyOver.missions[0].waypoints[0].aglM > 40);
  assert.equal(
    alreadyOver.warnings.some((warning) => warning.code === 'mission-over-budget'),
    false,
    'a continuous file already over the battery must not be blocked by the transit lift',
  );
  const fitsMin = Math.ceil(liftedS / 60) + 1;
  const stillFits = at(liftedPlan, fitsMin);
  assert.ok(stillFits.missions[0].durationS <= fitsMin * 60);
  assert.equal(
    stillFits.warnings.some((warning) => warning.code === 'mission-over-budget'),
    false,
    'a transit lift that still fits must not block',
  );
  const crossMin = Math.ceil(plainS / 60);
  assert.ok(
    plainS <= crossMin * 60 && liftedS > crossMin * 60,
    `need a minute the lift crosses: plain ${plainS} lifted ${liftedS}`,
  );
  const crossed = at(liftedPlan, crossMin);
  assert.equal(
    crossed.warnings.some((warning) => warning.code === 'mission-over-budget'),
    true,
    'a lift that pushes an otherwise fitting continuous mission over the battery still warns',
  );
});

test('orbit geometry ignores distance capture and does not go continuous', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 100, 100);
  const shared = { pattern: 'orbit', orbitRadiusM: 40, orbitHeightsM: [40] };
  const stop = planFlight(box, shared);
  const distance = planFlight(box, {
    ...shared,
    captureMode: 'distance',
    continuousRoute: true,
    photoSpacingM: 12,
  });
  assert.equal(distance.error, undefined);
  assert.equal(distance.options.captureMode, 'distance');
  assert.equal(distance.options.continuousRoute, false);
  assert.equal(distance.waypointCount, stop.waypointCount);
  assert.equal(distance.legs.length, stop.legs.length);
});

test('usableBatteryMin 20 rides on a generated plan and does not change mode A splits', () => {
  const wide = boxAround(CENTER.lon, CENTER.lat, 200, 800);
  const shared = { aglM: 100, direction: 'ew', batteryMin: 5, speedMs: 15 };
  const plain = planFlight(wide, shared);
  assert.equal(plain.options.usableBatteryMin, 20);
  assert.equal(plain.options.captureMode, 'stop');
  const marked = planFlight(wide, { ...shared, usableBatteryMin: 16 });
  assert.equal(marked.options.usableBatteryMin, 16);
  const split = (plan) => assembleMissions(plan, flatGround(plan)).missions.length;
  assert.equal(split(plain), split(marked));
  assert.ok(split(plain) > 1, 'mode A still splits on battery time');
  const distance = planFlight(wide, {
    ...shared,
    captureMode: 'distance',
    continuousRoute: true,
    usableBatteryMin: 12,
  });
  assert.equal(distance.options.usableBatteryMin, 12);
  assert.equal(distance.options.continuousRoute, true);
  assert.equal(distance.options.captureMode, 'distance');
});

test('KMZ import still warns above 200 waypoints and not at 200', async () => {
  const { checkMission } = await import('./djiKmz.js');
  const { WPML_NAMESPACE } = await import('./wpml.js');
  const mission = (count) => ({
    namespace: WPML_NAMESPACE,
    hasWaylines: true,
    config: { droneEnumValue: 68, droneSubEnumValue: 0 },
    wayline: { executeHeightMode: 'relativeToStartPoint' },
    waypoints: Array.from({ length: count }, (_, index) => ({
      index,
      lon: 0,
      lat: 0,
      heightM: 50,
      speedMs: 5,
      heading: { mode: 'followWayline' },
      groups: [],
    })),
  });
  assert.equal(
    checkMission(mission(200)).some((item) => item.code === 'too-many'),
    false,
  );
  const warn = checkMission(mission(201)).find((item) => item.code === 'too-many');
  assert.equal(warn.level, 'warn');
  assert.equal(warn.args.max, 200);
  assert.equal(warn.args.count, 201);
});

test('Mini 5 Pro 50 MP interval is 5 s, derived and unverified', () => {
  assert.equal(mini.minPhotoIntervalS, 5);
  assert.equal(mini.minPhotoIntervalStatus, 'derived');
  assert.equal(mini.verified, 'unverified');
  assert.ok(mini.flags.includes('interval-derived'));
  assert.equal(DEFAULT_OPTIONS.minPhotoIntervalS, null);
});

test('unset camera minimum keeps mode A on the preset speed limit', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const legacy = planFlight(box, {
    aglM: 100,
    speedMs: 5,
    captureMode: 'stop',
  });
  const absent = planFlight(box, { aglM: 100, speedMs: 5 });
  assert.equal(legacy.speedMs, 4);
  assert.equal(absent.speedMs, 4);
  assert.ok(Math.abs(legacy.speedLimits.intervalMs - 4) < 1e-9);
  assert.equal(legacy.preset, mini);
  assert.equal(absent.preset, mini);
  assert.equal(legacy.options.minPhotoIntervalS, null);
  const same = planFlight(box, {
    aglM: 100,
    speedMs: 5,
    minPhotoIntervalS: 5,
  });
  assert.equal(same.speedMs, 4);
  assert.equal(same.preset, mini);
  assert.equal(same.footprint.alongM, legacy.footprint.alongM);
  assert.equal(same.gsdCm, legacy.gsdCm);
});

test('a custom camera minimum drives the planner speedLimits', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  const plan = planFlight(box, {
    aglM: 100,
    speedMs: 5,
    captureMode: 'stop',
    minPhotoIntervalS: 10,
  });
  // 20 m spacing / 10 s = 2 m/s. The preset default would have been 4 m/s.
  assert.ok(Math.abs(plan.speedLimits.intervalMs - 2) < 1e-9);
  assert.equal(plan.speedLimits.limitedBy, 'interval');
  assert.equal(plan.speedMs, 2);
  assert.equal(plan.speedLimitedBy, 'camera');
  assert.equal(plan.preset.minPhotoIntervalS, 10);
  assert.notEqual(plan.preset, mini);
  assert.equal(plan.preset.imageWidthPx, mini.imageWidthPx);
  assert.equal(
    plan.footprint.alongM,
    planFlight(box, { aglM: 100 }).footprint.alongM,
  );

  const distance = planFlight(box, {
    aglM: 100,
    speedMs: 5,
    captureMode: 'distance',
    photoSpacingM: 20,
    minPhotoIntervalS: 10,
  });
  assert.equal(distance.speedMs, 5, 'distance mode does not silently slow down');
  assert.equal(distance.speedLimits.intervalMs, 2);
  assert.ok(
    distance.notes.some((n) => n.code === 'speed-exceeds-camera-limit'),
  );
});

test('an unusable camera minimum is rejected and mode A stays on the preset', () => {
  const box = boxAround(CENTER.lon, CENTER.lat, 400, 200);
  for (const bad of [0, -1, 0.05, 61, NaN, Infinity, true, false, 'fast', {}, []]) {
    const plan = planFlight(box, {
      aglM: 100,
      speedMs: 5,
      minPhotoIntervalS: bad,
    });
    assert.equal(plan.speedMs, 4, `bad ${bad}`);
    assert.equal(plan.options.minPhotoIntervalS, null, `stored ${bad}`);
    assert.equal(plan.preset, mini, `preset ${bad}`);
  }
  const typed = planFlight(box, {
    aglM: 100,
    speedMs: 5,
    minPhotoIntervalS: '10',
  });
  assert.equal(typed.speedMs, 2);
  assert.equal(typed.options.minPhotoIntervalS, 10);
});

// ---- Timed shot interval (speed & photo timing) ---------------------------

const TIMED_BOX = boxAround(CENTER.lon, CENTER.lat, 400, 200);

test('timed shot with a chosen interval spaces stations at speed x interval', () => {
  // 100 m height on the Mini 5 Pro: 100 m along-track footprint. 4 m/s x 7 s = 28 m.
  const plan = planFlight(TIMED_BOX, {
    aglM: 100,
    captureMode: 'timed',
    speedMs: 4,
    timedIntervalS: 7,
  });
  assert.equal(plan.options.timedIntervalS, 7);
  assert.ok(plan.legs.every((leg) => leg.photoSpacingM === 28));
  assert.ok(plan.legs.every((leg) => leg.waypoints.length === 2));
  assert.equal(
    plan.legs[0].photoCount,
    Math.floor(plan.legs[0].lengthM / 28 + 1e-9) + 1,
  );
  assert.equal(plan.speedMs, 4, 'the plan speed is not changed to fit the interval');
  const overlap = (1 - plan.legs[0].photoSpacingM / plan.footprint.alongM) * 100;
  near(overlap, 72, 1e-9, 'front overlap at 7 s');
});

test('a chosen interval beats a fixed distance; clearing it falls back to the fixed distance', () => {
  const withBoth = planFlight(TIMED_BOX, {
    aglM: 100,
    captureMode: 'timed',
    speedMs: 4,
    photoSpacingM: 40,
    timedIntervalS: 5,
  });
  assert.ok(withBoth.legs.every((leg) => leg.photoSpacingM === 20));
  const cleared = planFlight(TIMED_BOX, {
    aglM: 100,
    captureMode: 'timed',
    speedMs: 4,
    photoSpacingM: 40,
    timedIntervalS: null,
  });
  assert.ok(cleared.legs.every((leg) => leg.photoSpacingM === 40));
  const overlapOnly = planFlight(TIMED_BOX, {
    aglM: 100,
    captureMode: 'timed',
    speedMs: 4,
  });
  near(overlapOnly.legs[0].photoSpacingM, 20, 1e-6, 'from 80% front overlap');
});

test('the interval is ignored by stop, distance and orbit capture', () => {
  const base = { aglM: 100, speedMs: 4, timedIntervalS: 7 };
  const stop = planFlight(TIMED_BOX, base);
  near(stop.legs[0].photoSpacingM, 20, 1e-6, 'stop');
  const distance = planFlight(TIMED_BOX, { ...base, captureMode: 'distance' });
  near(distance.legs[0].photoSpacingM, 20, 1e-6, 'distance');
  const orbit = planFlight(TIMED_BOX, {
    ...base,
    captureMode: 'timed',
    pattern: 'orbit',
  });
  const orbitWithout = planFlight(TIMED_BOX, {
    aglM: 100,
    speedMs: 4,
    captureMode: 'timed',
    pattern: 'orbit',
  });
  assert.deepEqual(
    orbit.legs.map((l) => l.photoSpacingM),
    orbitWithout.legs.map((l) => l.photoSpacingM),
  );
});

test('an interval under the camera minimum keeps the speed and says so', () => {
  // 4 m/s x 3 s = 12 m; the Mini 5 Pro preset minimum is 5 s -> limit 2.4 m/s
  const plan = planFlight(TIMED_BOX, {
    aglM: 100,
    captureMode: 'timed',
    speedMs: 4,
    timedIntervalS: 3,
  });
  assert.equal(plan.speedMs, 4, 'no silent slowdown in timed mode');
  const note = plan.notes.find((n) => n.code === 'speed-exceeds-camera-limit');
  assert.ok(note, 'warned');
  assert.equal(note.params.preserved, true);
});

test('timed and distance keep 15 and 16 mph; stop mode still lowers to the camera limit', () => {
  // 15 mph = 6.7056 m/s and 16 mph = 7.15264 m/s (python3: mph x 1609.344 / 3600)
  for (const mph of [15, 16]) {
    const ms = (mph * 1609.344) / 3600;
    for (const captureMode of ['timed', 'distance']) {
      const plan = planFlight(TIMED_BOX, { aglM: 100, captureMode, speedMs: ms });
      assert.equal(plan.options.speedMs, ms, `${mph} mph ${captureMode} requested`);
      assert.equal(plan.speedMs, ms, `${mph} mph ${captureMode} planned`);
      assert.equal(plan.speedLimitedBy, null);
    }
    const stop = planFlight(TIMED_BOX, { aglM: 100, speedMs: ms });
    assert.ok(stop.speedMs < ms, `${mph} mph stop is lowered to the camera limit`);
    assert.equal(stop.speedLimitedBy, 'camera');
    assert.ok(
      stop.notes.some((n) => n.code === 'speed-camera-limited'),
      'and the plan says so',
    );
  }
});

test('timedIntervalS is cleaned like a seconds field and survives normalizeOptions', () => {
  assert.equal(cleanTimedIntervalS('7'), 7);
  assert.equal(cleanTimedIntervalS(0), null);
  assert.equal(normalizeOptions({ timedIntervalS: -1 }).options.timedIntervalS, null);
  assert.equal(normalizeOptions({ timedIntervalS: 6.4 }).options.timedIntervalS, 6.4);
  assert.equal(DEFAULT_OPTIONS.timedIntervalS, null);
  assert.equal(
    captureSpacingM({ captureMode: 'timed', timedIntervalS: 6, speedMs: 3 }, 99),
    18,
  );
  assert.equal(
    captureSpacingM({ captureMode: 'stop', timedIntervalS: 6, speedMs: 3 }, 99),
    99,
  );
});
