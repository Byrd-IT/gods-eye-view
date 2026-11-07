import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ASSUMPTIONS,
  DEFAULT_USABLE_MIN,
  DISCLAIMER,
  MIN_ADVANCE_M,
  batteryBreaks,
} from './batteryBreaks.js';
import { groundDistanceM, metersPerDegree, wrapLon } from './geo.js';
import {
  OVERHEAD_S,
  TRANSIT_SPEED_MS,
  TURN_S,
  estimateMission,
  linePhotoCount,
} from './planner.js';

const LAT = 30;
const LON0 = -97;
const M = metersPerDegree(LAT);
const SPEED = 5;

function near(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    msg ?? `${actual} not within ${tol} of ${expected}`,
  );
}

/** East metres from (LON0, LAT). Height is relative to takeoff, which is 0. */
function at(eastM, extra = {}) {
  return { lon: LON0 + eastM / M.lon, lat: LAT, ...extra };
}

function atNE(eastM, northM, extra = {}) {
  return {
    lon: LON0 + eastM / M.lon,
    lat: LAT + northM / M.lat,
    ...extra,
  };
}

function eastRoute(endM, stepM, extra = {}) {
  const points = [];
  for (let east = 0; east < endM - 1e-9; east += stepM) points.push(at(east, extra));
  points.push(at(endM, extra));
  return points;
}

/**
 * Independent of estimateMission. Straight east line, constant height, home
 * at `homeEast`. This is the planner formula written out:
 *   route/speed + (out + back) / TRANSIT_SPEED_MS + OVERHEAD_S
 */
function straightDuration(s0, s1, height, homeEast = 0) {
  const route = Math.abs(s1 - s0);
  const out = Math.hypot(s0 - homeEast, height);
  const back = Math.hypot(s1 - homeEast, height);
  return route / SPEED + (out + back) / TRANSIT_SPEED_MS + OVERHEAD_S;
}

/** Flat legs joined by a north step. The step is a connector, not a photo line. */
function ladder(lines, spacingM, captureMode = 'distance') {
  const legs = lines.map((line) => ({
    waypoints: [atNE(line.east0, line.north), atNE(line.east1, line.north)],
    photoSpacingM: spacingM,
    captureMode,
    continued: line.continued === true,
  }));
  return { legs, route: legs.flatMap((leg) => leg.waypoints) };
}

test('the module reuses planner and geo and does not cycle', () => {
  const src = readFileSync(new URL('./batteryBreaks.js', import.meta.url), 'utf8');
  const planner = readFileSync(new URL('./planner.js', import.meta.url), 'utf8');
  assert.equal((src.match(/^import /gm) || []).length, 2);
  assert.match(src, /from '\.\/geo\.js'/);
  assert.match(src, /from '\.\/planner\.js'/);
  assert.doesNotMatch(src, /from '\.\/(panel|intervalMetrics|wpml|areas)\.js'/);
  assert.equal(planner.includes('batteryBreaks'), false);
  assert.match(src, /estimateMission\(/);
  assert.equal(ASSUMPTIONS.integrated, false);
  assert.equal(ASSUMPTIONS.addsWaypoints, false);
  assert.equal(ASSUMPTIONS.timeModel, 'estimateMission');
  assert.equal(ASSUMPTIONS.usableMinDefault, 20);
  assert.equal(ASSUMPTIONS.usableMinClamped, false);
  assert.equal(ASSUMPTIONS.overheadS, OVERHEAD_S);
  assert.equal(ASSUMPTIONS.overheadS, 45);
  assert.equal(ASSUMPTIONS.transitSpeedMs, TRANSIT_SPEED_MS);
  assert.equal(ASSUMPTIONS.transitSpeedMs, 8);
  assert.equal(ASSUMPTIONS.turnS, TURN_S);
  assert.equal(ASSUMPTIONS.turnS, 3);
  assert.equal(ASSUMPTIONS.turnPenaltyOnBreaks, true);
  assert.equal(ASSUMPTIONS.turnPenaltyRequiresLegs, true);
  assert.equal(ASSUMPTIONS.windModelled, false);
  assert.equal(ASSUMPTIONS.groundSwapTimeIncluded, false);
  assert.equal(ASSUMPTIONS.greedyPrefix, true);
  assert.equal(ASSUMPTIONS.minAdvanceM, MIN_ADVANCE_M);
  assert.equal(MIN_ADVANCE_M, 25);
  assert.equal(Object.isFrozen(ASSUMPTIONS), true);
  assert.match(DISCLAIMER, /wind/i);
  assert.match(DISCLAIMER, /not waypoints/i);
  assert.match(DISCLAIMER, /not waypoints and the route is not split/);
  assert.equal(DEFAULT_USABLE_MIN, 20);
});

test('worked example: 20 min break includes the 45 s overhead', () => {
  // s/5 + s/8 + 45 = 1200
  // s * (1/5 + 1/8) = 1155
  // s = 1155 / 0.325 = 46200/13 m
  const expectedM = 46200 / 13;
  const withoutOverheadM = 1200 / (1 / SPEED + 1 / TRANSIT_SPEED_MS);
  assert.equal(expectedM, 3553.846153846154);
  assert.ok(withoutOverheadM - expectedM > 100);

  const route = [at(0), at(5000)];
  const result = batteryBreaks(route, {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 20,
    photoSpacingM: 100,
  });

  assert.equal(result.addsWaypoints, false);
  assert.equal(result.waypoints, undefined);
  assert.equal(result.usableMin, 20);
  assert.equal(result.budgetS, 1200);
  assert.equal(result.legsUsed, false);
  assert.equal(result.breaks.length >= 1, true);
  const marker = result.breaks[0];
  near(marker.groundM, expectedM, 1e-3);
  near(marker.routeM, expectedM, 1e-3);
  near(marker.durationS, 1200, 1e-3);
  near(marker.minutes, 20, 1e-4);
  assert.ok(
    Math.abs(marker.groundM - withoutOverheadM) > 100,
    'overhead was left out of the break',
  );
  assert.equal(marker.addedWaypoint, false);
  assert.equal(marker.segmentIndex, 0);
  assert.ok(marker.fraction > 0.7 && marker.fraction < 0.72);
  near(marker.lon, LON0 + expectedM / M.lon, 1e-8);
  near(marker.lat, LAT, 1e-12);
  assert.equal(marker.photoCount, linePhotoCount(marker.groundM, 100, false));
  assert.equal(marker.photoCount, 36);
  assert.equal(marker.legCount, 1);
  assert.equal(marker.turnS, 0);
  assert.ok(marker.advanceM >= MIN_ADVANCE_M);

  const piece = estimateMission(
    [at(0), { lon: marker.lon, lat: marker.lat, relHeightM: 0 }],
    at(0),
    SPEED,
    1,
  );
  near(piece.durationS, marker.durationS, 1e-6);
  near(straightDuration(0, marker.groundM, 0), marker.durationS, 1e-3);
  const past = estimateMission([at(0), at(marker.groundM + 1)], at(0), SPEED, 1);
  assert.ok(past.durationS > 1200);
});

test('defaults are 20 usable minutes and 5 m/s, and takeoff height is ignored', () => {
  const route = [at(0), at(5000)];
  const named = batteryBreaks(route, { takeoff: at(0), speedMs: 5, usableMin: 20 });
  const defaults = batteryBreaks(route, { takeoff: { lon: LON0, lat: LAT, relHeightM: 999 } });
  near(defaults.breaks[0].groundM, named.breaks[0].groundM, 1e-6);
  assert.equal(defaults.usableMin, 20);
  assert.equal(defaults.speedMs, 5);
  assert.equal(defaults.budgetS, 20 * 60);
});

test('a longer usable time moves the break; a large value is not clamped to 60', () => {
  const route = [at(0), at(5000)];
  const at20 = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 20 });
  const at40 = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 40 });
  // 5000 m at 5 m/s: 5000/5 + 5000/8 + 45 = 1670 s = 27.8 min, so 40 min finishes it.
  assert.equal(at40.breaks.length, 0);
  assert.equal(at40.unreachable, null);
  assert.equal(at40.covered, true);
  assert.equal(at40.batteryCount, 1);
  assert.equal(at20.breaks.length >= 1, true);
  assert.ok(at20.breaks[0].groundM < 5000);
  const at90 = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 90 });
  assert.equal(at90.usableMin, 90);
  assert.equal(at90.breaks.length, 0);
  assert.equal(at90.batteryCount, 1);
});

test('a budget that lands on a corner marks that vertex, not a nearby sample', () => {
  // To 2000 m: 2000/5 + 2000/8 + 45 = 695 s exactly, before lon/lat round-off.
  const route = [at(0), at(2000), at(5000)];
  const result = batteryBreaks(route, {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 695 / 60,
  });
  const marker = result.breaks[0];
  near(marker.groundM, 2000, 0.05);
  assert.equal(marker.segmentIndex, 0);
  near(marker.fraction, 1, 1e-4);
  near(marker.lon, at(2000).lon, 1e-8);
  near(marker.lat, LAT, 1e-12);
  assert.ok(result.breaks.length >= 2 || result.unreachable);
  if (result.breaks[1]) {
    assert.ok(result.breaks[1].groundM > 2000);
    assert.ok(result.breaks[1].groundM < 5000);
    assert.equal(result.breaks[1].segmentIndex, 1);
    assert.ok(result.breaks[1].fraction > 0 && result.breaks[1].fraction < 1);
    assert.ok(result.breaks[1].advanceM >= MIN_ADVANCE_M);
  }
});

test('4 mile route at 500 ft includes overhead and does not crawl forever', () => {
  // 4 * 1609.344 = 6437.376 m. 500 ft = 152.4 m.
  // Return is at 8 m/s. 20 min minus 45 s overhead is 1155 s, which is only
  // about 2.87 miles of round trip. The far end cannot be reached and still
  // get home. The walk used to keep placing pauses at 4616 m then 4617 m.
  // A gain under 25 m is that wall, not another battery.
  const fourMilesM = 4 * 1609.344;
  const heightM = 500 * 0.3048;
  assert.equal(fourMilesM, 6437.376);
  near(heightM, 152.4, 1e-12);
  const route = [at(0, { relHeightM: heightM }), at(fourMilesM, { relHeightM: heightM })];
  const takeoff = { lon: LON0, lat: LAT };
  const before = JSON.stringify(route);
  const result = batteryBreaks(route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
  });
  assert.equal(JSON.stringify(route), before);
  assert.equal(result.addsWaypoints, false);
  near(result.groundM, fourMilesM, 1e-3);
  assert.equal(result.breaks.length >= 1, true);
  assert.ok(result.breaks.length < 8);
  near(result.breaks[0].groundM, 3493.953, 0.05);
  near(result.breaks[0].durationS, 1200, 1e-2);
  near(result.breaks[0].relHeightM, heightM, 1e-6);
  near(
    straightDuration(0, result.breaks[0].groundM, heightM),
    result.breaks[0].durationS,
    1e-2,
  );
  const full = estimateMission(route, takeoff, SPEED, 1);
  near(result.routeEstimate.durationS, full.durationS, 1e-9);
  near(result.routeEstimate.routeM, full.routeM, 1e-9);
  assert.ok(result.routeEstimate.durationS > fourMilesM / SPEED + OVERHEAD_S);
  let prev = 0;
  for (const marker of result.breaks) {
    assert.ok(marker.advanceM >= MIN_ADVANCE_M);
    assert.ok(marker.groundM - prev >= MIN_ADVANCE_M);
    prev = marker.groundM;
  }
  assert.ok(result.breaks.at(-1).groundM < 4620);
  assert.equal(result.covered, false);
  assert.ok(result.unreachable);
  assert.equal(result.unreachable.reason, 'no-progress');
  assert.ok(result.unreachable.remainingGroundM > 1000);
  assert.ok(result.unreachable.advanceM < MIN_ADVANCE_M);
  assert.equal(result.waypoints, undefined);
});

test('4 mile route with the takeoff in the middle finishes on the second battery', () => {
  const fourMilesM = 4 * 1609.344;
  const heightM = 500 * 0.3048;
  const homeEast = fourMilesM / 2;
  const route = [at(0, { relHeightM: heightM }), at(fourMilesM, { relHeightM: heightM })];
  const takeoff = at(homeEast);
  const result = batteryBreaks(route, { takeoff, speedMs: SPEED, usableMin: 20 });
  assert.equal(result.unreachable, null);
  assert.equal(result.covered, true);
  assert.equal(result.breaks.length, 1);
  assert.equal(result.batteryCount, 2);
  near(result.breaks[0].groundM, 3539.235, 0.05);
  near(result.breaks[0].durationS, 1200, 1e-2);
  assert.ok(result.breaks[0].fraction > 0 && result.breaks[0].fraction < 1);
  near(result.pieces[1].durationS, 1071.781, 0.05);
  assert.equal(result.pieces[1].fits, true);
  const marker = result.breaks[0];
  const piece = estimateMission(
    [
      route[0],
      { lon: marker.lon, lat: marker.lat, relHeightM: heightM },
    ],
    takeoff,
    SPEED,
    1,
  );
  near(piece.durationS, marker.durationS, 1e-4);
  near(
    straightDuration(0, marker.groundM, heightM, homeEast),
    marker.durationS,
    1e-2,
  );
});

test('extra returns are not the single-mission time estimate', () => {
  const route = [at(0), at(5000)];
  const result = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 20 });
  // One mission: 5000/5 + 5000/8 + 45 = 1670 s.
  near(result.routeEstimate.durationS, 1670, 1e-3);
  const summed = result.pieces.reduce((sum, piece) => sum + piece.durationS, 0);
  assert.ok(summed > result.routeEstimate.durationS + OVERHEAD_S);
});

test('photo count is cumulative ground distance, and spacing is optional', () => {
  const route = [at(0), at(5000)];
  const withPhotos = batteryBreaks(route, {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 20,
    photoSpacingM: 20,
  });
  const marker = withPhotos.breaks[0];
  assert.equal(marker.photoCount, Math.floor(marker.groundM / 20 + 1e-9) + 1);
  assert.equal(marker.photoCount, linePhotoCount(marker.groundM, 20, false));
  const noPhotos = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 20 });
  assert.equal(noPhotos.breaks[0].photoCount, null);
  assert.equal(noPhotos.photoSpacingM, null);
  assert.equal(noPhotos.photoCount, null);
});

test('the route is not mutated and no waypoint is inserted', () => {
  const route = [at(0, { relHeightM: 10, photo: true }), at(4000, { relHeightM: 10 })];
  const snapshot = structuredClone(route);
  const result = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 20 });
  assert.deepEqual(route, snapshot);
  assert.equal(result.waypoints, undefined);
  assert.equal(result.breaks.every((b) => b.addedWaypoint === false), true);
  assert.equal(route.length, 2);
});

test('boundary inputs: empty, unfit round trip, and rejected numbers', () => {
  const empty = batteryBreaks([], { speedMs: SPEED });
  assert.equal(empty.batteryCount, 0);
  assert.deepEqual(empty.breaks, []);
  assert.equal(empty.routeEstimate.durationS, 0);
  assert.equal(empty.unreachable, null);
  assert.equal(empty.covered, true);

  const parked = batteryBreaks([at(0, { relHeightM: 30 })], {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 20,
  });
  assert.equal(parked.breaks.length, 0);
  assert.equal(parked.batteryCount, 1);
  assert.equal(parked.unreachable, null);

  const tooFar = batteryBreaks([at(20000, { relHeightM: 0 })], {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 1,
  });
  assert.deepEqual(tooFar.breaks, []);
  assert.equal(tooFar.batteryCount, 0);
  assert.equal(tooFar.covered, false);
  assert.equal(tooFar.unreachable.reason, 'round-trip-exceeds-usable-minutes');
  assert.ok(tooFar.unreachable.durationS > 60);

  assert.throws(() => batteryBreaks(null, {}), /array/);
  assert.throws(() => batteryBreaks([at(0)], { speedMs: SPEED }), /takeoff/);
  assert.throws(() => batteryBreaks([at(0)], { takeoff: at(0), speedMs: 0 }), /speedMs/);
  assert.throws(
    () => batteryBreaks([at(0)], { takeoff: at(0), speedMs: SPEED, usableMin: 0 }),
    /usableMin/,
  );
  assert.throws(
    () => batteryBreaks([at(0)], { takeoff: at(0), speedMs: SPEED, usableMin: -5 }),
    /usableMin/,
  );
  assert.throws(
    () => batteryBreaks([{ lon: 0 }], { takeoff: at(0), speedMs: SPEED }),
    /finite/,
  );
  assert.throws(
    () =>
      batteryBreaks([at(0), at(100)], {
        takeoff: at(0),
        speedMs: SPEED,
        photoSpacingM: 0,
      }),
    /photoSpacingM/,
  );
});

test('a route that comes back home is not skipped ahead to the closer end', () => {
  // Out to 4000 m does not fit in 20 min (break is at 46200/13). The end, 1000 m
  // from home, is closer, but he would have to fly the bulge to get there.
  const route = [at(0), at(4000), at(1000)];
  const result = batteryBreaks(route, { takeoff: at(0), speedMs: SPEED, usableMin: 20 });
  near(result.breaks[0].groundM, 46200 / 13, 1e-2);
  assert.equal(result.breaks[0].segmentIndex, 0);
  assert.ok(result.breaks[0].fraction < 1);
  assert.ok(result.breaks[0].groundM < 4000);
});

test('a break on a segment across the antimeridian stays on the short arc', () => {
  const a = { lon: 179.9, lat: LAT, relHeightM: 0 };
  const b = { lon: -179.9, lat: LAT, relHeightM: 0 };
  const span = groundDistanceM(a, b);
  assert.ok(span > 10000);
  assert.ok(span < 25000);
  const result = batteryBreaks([a, b], { takeoff: a, speedMs: SPEED, usableMin: 20 });
  const marker = result.breaks[0];
  assert.equal(marker.segmentIndex, 0);
  assert.ok(marker.fraction > 0 && marker.fraction < 1);
  const expectedLon = wrapLon(179.9 + 0.2 * marker.fraction);
  near(marker.lon, expectedLon, 1e-6);
  assert.ok(Math.abs(marker.lon) > 179);
  near(marker.lat, LAT, 1e-8);
});

test('headline time matches estimateMission, including a height change', () => {
  const route = [
    at(0, { relHeightM: 0 }),
    at(1000, { relHeightM: 50 }),
    at(1000, { relHeightM: 50, lat: LAT + 500 / M.lat }),
  ];
  const takeoff = at(0);
  const result = batteryBreaks(route, { takeoff, speedMs: SPEED, usableMin: 90 });
  const est = estimateMission(route, takeoff, SPEED, 1);
  near(result.routeM, est.routeM, 1e-6);
  near(result.routeEstimate.durationS, est.durationS, 1e-9);
  near(result.routeEstimate.distanceM, est.distanceM, 1e-9);
  assert.equal(result.breaks.length, 0);
  assert.equal(result.batteryCount, 1);
});

test('vertical interpolation puts the break on the climb, at the budget', () => {
  // Same lon/lat, climb h metres. duration = h/5 + h/8 + 45.
  // 1 minute budget: h = (60 - 45) / 0.325 = 600/13 m.
  const expectedH = 600 / 13;
  const route = [
    { lon: LON0, lat: LAT, relHeightM: 0 },
    { lon: LON0, lat: LAT, relHeightM: 200 },
  ];
  const result = batteryBreaks(route, {
    takeoff: { lon: LON0, lat: LAT },
    speedMs: SPEED,
    usableMin: 1,
  });
  const marker = result.breaks[0];
  near(marker.relHeightM, expectedH, 1e-3);
  near(marker.lon, LON0, 1e-12);
  near(marker.lat, LAT, 1e-12);
  near(marker.durationS, 60, 1e-3);
  assert.ok(marker.fraction > 0 && marker.fraction < 1);
});

test('leg count without lines changes the headline estimate only', () => {
  const plain = [at(0), at(5000)];
  const takeoff = at(0);
  const one = batteryBreaks(plain, { takeoff, speedMs: SPEED, usableMin: 20, legCount: 1 });
  const three = batteryBreaks(plain, { takeoff, speedMs: SPEED, usableMin: 20, legCount: 3 });
  near(three.routeEstimate.durationS - one.routeEstimate.durationS, TURN_S * 2, 1e-9);
  near(three.breaks[0].groundM, one.breaks[0].groundM, 1e-6);
  near(three.breaks[0].durationS, one.breaks[0].durationS, 1e-6);
  assert.equal(three.legsUsed, false);
  assert.equal(three.breaks[0].turnS, 0);

  const dwelling = [at(0, { dwellS: 100 }), at(5000)];
  const withDwell = batteryBreaks(dwelling, { takeoff, speedMs: SPEED, usableMin: 20 });
  // Extra 100 s of dwell: s = (1155 - 100) / 0.325 = 3246.153... m.
  near(withDwell.breaks[0].groundM, 1055 / 0.325, 1e-2);
  assert.ok(withDwell.breaks[0].groundM < one.breaks[0].groundM - 50);
});

test('worked multi-leg route charges 3 s per extra line inside the piece', () => {
  // Six east-west lines of 2200 m. The first battery crosses at least one
  // line join, so the 3 s turn has to move the pause back.
  const lines = [0, 1, 2, 3, 4, 5].map((i) => ({
    east0: i % 2 === 0 ? 0 : 2200,
    east1: i % 2 === 0 ? 2200 : 0,
    north: i * 12,
  }));
  const built = ladder(lines, 25);
  const takeoff = at(0);
  const before = JSON.stringify(built.route);
  const plain = batteryBreaks(built.route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
  });
  const withLegs = batteryBreaks(built.route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
    legs: built.legs,
    legCount: 1,
  });
  assert.equal(JSON.stringify(built.route), before);
  assert.equal(withLegs.legsUsed, true);
  assert.equal(withLegs.legCount, built.legs.length);
  near(
    withLegs.routeEstimate.durationS,
    estimateMission(built.route, takeoff, SPEED, built.legs.length).durationS,
    1e-6,
  );
  near(
    withLegs.routeEstimate.durationS - plain.routeEstimate.durationS,
    TURN_S * (built.legs.length - 1),
    1e-6,
  );
  assert.ok(withLegs.breaks.length >= 1);
  assert.ok(plain.breaks.length >= 1);
  const marker = withLegs.breaks[0];
  assert.ok(marker.legCount >= 2, 'the first battery crosses a line start');
  assert.equal(marker.turnS, TURN_S * (marker.legCount - 1));
  assert.ok(
    marker.routeM < plain.breaks[0].routeM - 5,
    'missing turn penalty lets the pause sit too far out',
  );
  near(marker.durationS, 1200, 0.05);
  const piece = [built.route[0]];
  let walked = 0;
  for (let i = 1; i < built.route.length; i += 1) {
    const step = groundDistanceM(built.route[i - 1], built.route[i]);
    if (walked + step < marker.routeM - 0.05) {
      piece.push(built.route[i]);
      walked += step;
    } else {
      break;
    }
  }
  piece.push({ lon: marker.lon, lat: marker.lat, relHeightM: 0 });
  const timed = estimateMission(piece, takeoff, SPEED, marker.legCount);
  near(timed.durationS, marker.durationS, 0.05);
  const noTurn = estimateMission(piece, takeoff, SPEED, 1);
  near(timed.durationS - noTurn.durationS, marker.turnS, 1e-6);
  assert.equal(withLegs.addsWaypoints, false);
  assert.ok(marker.advanceM >= MIN_ADVANCE_M);
});

test('a short multi-leg route that fits uses estimateMission once, with every turn', () => {
  const built = ladder(
    [
      { east0: 0, east1: 90, north: 0 },
      { east0: 90, east1: 180, north: 10 },
    ],
    40,
  );
  const takeoff = at(0);
  const result = batteryBreaks(built.route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
    legs: built.legs,
  });
  assert.equal(result.breaks.length, 0);
  assert.equal(result.unreachable, null);
  assert.equal(result.covered, true);
  assert.equal(result.batteryCount, 1);
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].legCount, 2);
  assert.equal(result.pieces[0].fits, true);
  const est = estimateMission(built.route, takeoff, SPEED, 2);
  near(result.routeEstimate.durationS, est.durationS, 1e-9);
  near(result.pieces[0].durationS, est.durationS, 1e-9);
  const perLine = built.legs.reduce(
    (sum, leg) =>
      sum +
      linePhotoCount(
        groundDistanceM(leg.waypoints[0], leg.waypoints[1]),
        40,
        false,
      ),
    0,
  );
  assert.equal(perLine, 6);
  assert.equal(result.photoCount, perLine);
  assert.equal(result.pieces[0].photoCount, perLine);
  assert.notEqual(result.photoCount, linePhotoCount(result.groundM, 40, false));
});

test('interval photos restart at each line and a continued line does not', () => {
  const built = ladder(
    [
      { east0: 0, east1: 90, north: 0 },
      { east0: 90, east1: 180, north: 10 },
    ],
    40,
  );
  const takeoff = at(0);
  const fitted = batteryBreaks(built.route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
    legs: built.legs,
    photoSpacingM: 100,
  });
  // Leg spacing wins over the fallback. Two lines: 3 + 3, not one spacing
  // along 90 + 10 + 90.
  assert.equal(fitted.photoCount, 6);
  assert.equal(linePhotoCount(fitted.groundM, 40, false), 5);
  assert.notEqual(fitted.photoCount, linePhotoCount(fitted.groundM, 40, false));
  assert.notEqual(fitted.photoCount, linePhotoCount(fitted.groundM, 100, false));

  const continued = ladder(
    [
      { east0: 0, east1: 90, north: 0 },
      { east0: 90, east1: 180, north: 10, continued: true },
    ],
    40,
  );
  const resumed = batteryBreaks(continued.route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
    legs: continued.legs,
  });
  assert.equal(resumed.photoCount, 5);

  const long = ladder(
    [
      { east0: 0, east1: 2000, north: 0 },
      { east0: 2000, east1: 4000, north: 10 },
      { east0: 4000, east1: 6000, north: 20 },
    ],
    40,
  );
  const paused = batteryBreaks(long.route, {
    takeoff,
    speedMs: SPEED,
    usableMin: 20,
    legs: long.legs,
  });
  const marker = paused.breaks[0];
  assert.ok(marker.routeM > 2000 + 10, 'pause is past the first line start');
  assert.equal(marker.legIndex, 1);
  const onSecond = marker.routeM - (2000 + 10);
  const expected =
    linePhotoCount(2000, 40, false) + linePhotoCount(onSecond, 40, false);
  assert.equal(marker.photoCount, expected);
  assert.notEqual(marker.photoCount, linePhotoCount(marker.groundM, 40, false));
  assert.equal(marker.addedWaypoint, false);
});

test('mission legs and the waypoint array agree when there is one line', () => {
  const route = [at(0), at(5000)];
  const legs = [{ waypoints: route, captureMode: 'distance', photoSpacingM: 100 }];
  const viaArray = batteryBreaks(route, {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 20,
    photoSpacingM: 100,
  });
  const viaLegs = batteryBreaks(route, {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 20,
    legs,
  });
  const viaMission = batteryBreaks(
    { waypoints: route, legs },
    { takeoff: at(0), speedMs: SPEED, usableMin: 20 },
  );
  near(viaLegs.breaks[0].groundM, viaArray.breaks[0].groundM, 1e-3);
  assert.equal(viaLegs.breaks[0].photoCount, viaArray.breaks[0].photoCount);
  assert.equal(viaLegs.legsUsed, true);
  assert.equal(viaLegs.legCount, 1);
  assert.equal(viaLegs.breaks[0].turnS, 0);
  near(viaMission.breaks[0].groundM, viaArray.breaks[0].groundM, 1e-6);
  assert.equal(viaMission.breaks[0].photoCount, 36);
  assert.throws(
    () =>
      batteryBreaks([at(0), at(100)], {
        takeoff: at(0),
        speedMs: SPEED,
        legs: [{ waypoints: [at(0), at(200)], captureMode: 'distance' }],
      }),
    /match/,
  );
});

test('a hover action is dwell for estimateMission when dwellS is absent', () => {
  const takeoff = at(0);
  const acted = [
    { ...at(0), actions: [{ func: 'hover', params: { hoverTime: '100' } }] },
    at(5000),
  ];
  const dwelling = [at(0, { dwellS: 100 }), at(5000)];
  const withAction = batteryBreaks(acted, { takeoff, speedMs: SPEED, usableMin: 20 });
  const withDwell = batteryBreaks(dwelling, { takeoff, speedMs: SPEED, usableMin: 20 });
  near(withAction.breaks[0].groundM, withDwell.breaks[0].groundM, 1e-2);
  near(withAction.breaks[0].groundM, 1055 / 0.325, 1e-2);
  assert.equal(JSON.stringify(acted[0].actions), JSON.stringify([{ func: 'hover', params: { hoverTime: '100' } }]));
});

test('a supplied line length keeps the photo that rounding would drop', () => {
  // 8-decimal lon/lat can leave a 4000 m line a centimetre short. 25 m spacing
  // then loses the last station unless the planner length is used.
  const route = [at(0), at(3999.99)];
  const result = batteryBreaks(route, {
    takeoff: at(0),
    speedMs: SPEED,
    usableMin: 90,
    legs: [
      {
        waypoints: route,
        captureMode: 'distance',
        photoSpacingM: 25,
        lengthM: 4000,
      },
    ],
  });
  assert.equal(result.breaks.length, 0);
  assert.equal(result.photoCount, linePhotoCount(4000, 25, false));
  assert.equal(result.photoCount, 161);
  assert.equal(linePhotoCount(3999.99, 25, false), 160);
});

test('an unreachable round trip is returned, not thrown', () => {
  const route = [at(0, { relHeightM: 80 }), at(3000, { relHeightM: 80 })];
  assert.doesNotThrow(() => {
    const result = batteryBreaks(route, {
      takeoff: at(0),
      speedMs: SPEED,
      usableMin: 1,
      legs: [{ waypoints: route, captureMode: 'distance', photoSpacingM: 20 }],
    });
    assert.equal(result.breaks.length, 0);
    assert.equal(result.batteryCount, 0);
    assert.equal(result.covered, false);
    assert.equal(result.unreachable.reason, 'round-trip-exceeds-usable-minutes');
    assert.ok(result.unreachable.remainingGroundM > 0);
    assert.equal(result.addsWaypoints, false);
  });
});
