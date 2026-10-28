import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGL_CAP_FT,
  AGL_CAP_M,
  FT_PER_M,
  MAX_WAYPOINTS_PER_MISSION,
  assembleMissions,
  estimateMission,
  footprint,
  normalizeOptions,
  planFlight,
  spacing,
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

test('the height cap is 120 m and stays under 400 ft', () => {
  assert.equal(AGL_CAP_M, 120);
  assert.equal(AGL_CAP_FT, 400);
  assert.ok(AGL_CAP_M <= 400 * 0.3048);
  near(AGL_CAP_M * FT_PER_M, 393.7, 0.05, '120 m in feet');
  const { options, notes } = normalizeOptions({ aglM: 500 });
  assert.equal(options.aglM, AGL_CAP_M);
  assert.equal(notes[0].code, 'agl-capped');
  assert.equal(normalizeOptions({ aglM: 1 }).options.aglM, 10);
  const plan = planFlight(boxAround(CENTER.lon, CENTER.lat, 300, 300), {
    aglM: 999,
  });
  assert.ok(
    plan.legs.every((l) => l.waypoints.every((w) => w.aglM <= AGL_CAP_M)),
  );
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
