import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLEARANCE_STEP_M,
  checkClearance,
  createSurfaceModel,
  createSurfaceProbe,
} from './clearance.js';
import {
  createSurfaceGrid,
  decodeSurfaceHeader,
  encodeSurface,
  parseSurface,
} from './surfaceGrid.js';
import { metersPerDegree } from './geo.js';
import { makeGrid } from './surfaceFixtures.mjs';
import { lonLatToUtm, utmZoneOf } from './utm.js';

const LON = -95.1;
const LAT = 32.55;
const M = metersPerDegree(LAT);

/** local metres -> lon/lat around the test origin */
const ll = (x, y) => ({ lon: LON + x / M.lon, lat: LAT + y / M.lat });

const leg = (id, pts) => ({
  id,
  waypoints: pts.map(([x, y, aglM], i) => ({ id: i, ...ll(x, y), aglM })),
});

const run = (grids, legs, minClearanceM = 6.096, errorMarginM = 3.048) =>
  checkClearance({
    legs,
    model: createSurfaceModel(Array.isArray(grids) ? grids : [grids]),
    minClearanceM,
    errorMarginM,
  });

test('utm: known points and the zone of a longitude', () => {
  const eq = lonLatToUtm(-93, 0, 15, true);
  assert.ok(Math.abs(eq.e - 500000) < 0.001 && Math.abs(eq.n) < 0.001);
  // Reference values from an independent implementation (Snyder's series).
  const ts = lonLatToUtm(-73.9855, 40.758, 18, true);
  assert.ok(Math.abs(ts.e - 585632.974) < 0.01, String(ts.e));
  assert.ok(Math.abs(ts.n - 4512388.313) < 0.01, String(ts.n));
  const ranch = lonLatToUtm(-95.1, 32.55, 15, true);
  assert.ok(Math.abs(ranch.e - 302818.236) < 0.01, String(ranch.e));
  assert.ok(Math.abs(ranch.n - 3603346.445) < 0.01, String(ranch.n));
  assert.equal(utmZoneOf(-95.1), 15);
  assert.equal(utmZoneOf(-96.1), 14);
  const south = lonLatToUtm(-93, -1, 15, false);
  assert.ok(south.n < 10000000 && south.n > 9880000);
});

test('surface file: encode and parse give the same grid', () => {
  const g = makeGrid({ size: 20, topAt: (x) => x });
  const buf = encodeSurface(g.meta, g.top, g.ground);
  const back = parseSurface(buf);
  assert.equal(back.cols, g.cols);
  assert.deepEqual(Array.from(back.top.slice(0, 30)), Array.from(g.top.slice(0, 30)));
  assert.equal(decodeSurfaceHeader(buf).meta.id, 'test');
  assert.throws(() => parseSurface(buf.slice(0, 40)));
  assert.throws(() => parseSurface(new ArrayBuffer(8)));
  assert.throws(() =>
    encodeSurface({ ...g.meta, id: '../x' }, g.top, g.ground),
  );
});

test('point above the canopy: clear well above, flagged when too close', () => {
  // A 30 m wide stand of trees, 20 m tall, flat ground at 100 m.
  const grid = makeGrid({
    topAt: (x, y) => (Math.abs(x) <= 15 && Math.abs(y) <= 15 ? 120 : 100),
    groundAt: () => 100,
  });
  const high = run(grid, [leg(0, [[0, 0, 40]])]);
  assert.equal(high.spanCount, 0);
  assert.equal(high.covered, 1);
  const low = run(grid, [leg(0, [[0, 0, 27]])]);
  assert.equal(low.spanCount, 1);
  assert.equal(low.spans[0].vertM, 7);
  assert.ok(Math.abs(low.worst.distM - 7) < 0.05);
  // 29.2 m AGL is 9.2 m above the tops: just inside the 9.144 m wanted.
  assert.equal(run(grid, [leg(0, [[0, 0, 29.2]])]).spanCount, 0);
  assert.equal(run(grid, [leg(0, [[0, 0, 29.0]])]).spanCount, 1);
});

test('the clearance is the minimum plus the position error', () => {
  const grid = makeGrid({ topAt: () => 20, groundAt: () => 0 });
  // 6.096 + 3.048 = 9.144 above a flat 20 m roof.
  assert.equal(run(grid, [leg(0, [[0, 0, 29.2]])]).requiredM, 9.144);
  assert.equal(run(grid, [leg(0, [[0, 0, 29.2]])]).spanCount, 0);
  assert.equal(run(grid, [leg(0, [[0, 0, 27]])]).spanCount, 1);
  // Without the margin, 27 m passes (7 m over a 6.096 m minimum).
  assert.equal(run(grid, [leg(0, [[0, 0, 27]])], 6.096, 0).spanCount, 0);
  // No margin, no minimum: nothing can be a violation.
  assert.equal(run(grid, [leg(0, [[0, 0, 20.5]])], 0, 0).spanCount, 0);
});

test('gap between trees: wide gap passes, narrow gap is flagged', () => {
  const rows = (gapHalf) => (x) => (Math.abs(x) >= gapHalf ? 25 : 0);
  // Trees 25 m tall on both sides; the path runs north along x = 0 at 15 m.
  const wide = makeGrid({ topAt: (x) => rows(10.5)(x) });
  const pass = run(wide, [leg(0, [[0, -60, 15], [0, 60, 15]])]);
  assert.equal(pass.spanCount, 0);
  assert.ok(pass.checked > 118, 'sampled about every metre');
  assert.equal(pass.stepM, CLEARANCE_STEP_M);
  assert.equal(pass.outside, 0);
  const narrow = makeGrid({ topAt: (x) => rows(7)(x) });
  const fail = run(narrow, [leg(0, [[0, -60, 15], [0, 60, 15]])]);
  assert.equal(fail.spanCount, 1);
  // Sideways distance to the nearest tree cell, about 7 m.
  assert.ok(fail.worst.distM > 6.5 && fail.worst.distM < 7.6, String(fail.worst.distM));
  assert.ok(fail.spans[0].lengthM > 110, 'the whole gap is flagged');
});

test('a leg crossing a canopy edge flags only the stretch near the trees', () => {
  // Open ground for x < 0, 20 m trees for x >= 0; the leg flies east at 12 m.
  const grid = makeGrid({ topAt: (x) => (x >= 0 ? 20 : 0) });
  const r = run(grid, [leg(0, [[-60, 0, 12], [30, 0, 12]])]);
  assert.equal(r.spanCount, 1);
  const s = r.spans[0];
  // At 12 m the drone is 8 m below the tops, so the sideways distance to the
  // edge must be at least 9.144 m: the flag starts about 9 m before x = 0.
  const startX = (s.start.lon - LON) * M.lon;
  assert.ok(startX > -10.2 && startX < -8.2, String(startX));
  const endX = (s.end.lon - LON) * M.lon;
  assert.ok(endX > 29, String(endX));
  assert.equal(s.atWaypoint, true, 'the span reaches the last waypoint');
  // Climbing to 30 m over the same canopy clears it (10 m above the tops).
  const high = run(grid, [leg(0, [[-60, 0, 12], [-12, 0, 30], [30, 0, 30]])]);
  assert.equal(high.spanCount, 0);
});

test('terrain rise: clearance follows the ground of the surface', () => {
  // Ground climbs 10 m east over 100 m; trees 18 m tall on top of it.
  const grid = makeGrid({
    groundAt: (x) => 100 + x / 10,
    topAt: (x) => 100 + x / 10 + 18,
  });
  // A drone 30 m AGL stays 12 m above the tops everywhere on that slope.
  assert.equal(run(grid, [leg(0, [[-80, 0, 30], [80, 0, 30]])]).spanCount, 0);
  assert.equal(run(grid, [leg(0, [[-80, 0, 25], [80, 0, 25]])]).spanCount, 1);
});

test('outside the model there is no verdict, and it is counted', () => {
  const grid = makeGrid({ size: 100, topAt: () => 20 });
  const r = run(grid, [leg(0, [[-40, 0, 5], [400, 0, 5]])]);
  assert.ok(r.outside > 300);
  assert.ok(r.covered > 70 && r.covered < 120);
  assert.ok(r.covered + r.outside === r.checked);
  // No surface at all: nothing is checked, nothing is flagged.
  const none = checkClearance({
    legs: [leg(0, [[0, 0, 5], [10, 0, 5]])],
    model: createSurfaceModel([]),
    minClearanceM: 6,
    errorMarginM: 3,
  });
  assert.equal(none.checked, 0);
  assert.equal(none.spanCount, 0);
});

test('holes in the surface (no data) are not treated as clear ground', () => {
  const hole = makeGrid({
    topAt: (x, y) => (Math.abs(x) < 10 && Math.abs(y) < 10 ? NaN : 20),
    groundAt: () => 0,
  });
  const r = run(hole, [leg(0, [[0, 0, 12]])]);
  // Over the hole there is no owner cell: outside coverage, not a verdict.
  assert.equal(r.covered, 0);
  assert.equal(r.outside, 1);
});

test('a newer surface replaces an older one for the same ground', () => {
  const older = makeGrid({
    id: 'a-old',
    capturedAt: '2026-01-01T00:00:00Z',
    topAt: () => 20,
  });
  // The newer run found the trees gone (felled): bare ground.
  const newer = makeGrid({
    id: 'b-new',
    capturedAt: '2026-10-01T00:00:00Z',
    topAt: () => 0,
  });
  const path = [leg(0, [[0, 0, 15]])];
  assert.equal(run(older, path).spanCount, 1);
  assert.equal(run(newer, path).spanCount, 0);
  const both = run([older, newer], path);
  assert.equal(both.spanCount, 0);
  assert.deepEqual(both.surfaceIds, ['b-new']);
  // Order of the list does not matter.
  assert.equal(run([newer, older], path).spanCount, 0);
});

test('an older surface still covers what the newer one does not reach', () => {
  const older = makeGrid({
    id: 'old',
    capturedAt: '2026-01-01T00:00:00Z',
    size: 200,
    topAt: () => 20,
  });
  // The newer run covers only x < 0 (NaN elsewhere).
  const newer = makeGrid({
    id: 'new',
    capturedAt: '2026-10-01T00:00:00Z',
    size: 200,
    topAt: (x) => (x < 0 ? 0 : NaN),
    groundAt: (x) => (x < 0 ? 0 : NaN),
  });
  const west = run([older, newer], [leg(0, [[-50, 0, 15]])]);
  assert.equal(west.spanCount, 0, 'newer data wins in the west');
  const east = run([older, newer], [leg(0, [[50, 0, 15]])]);
  assert.equal(east.spanCount, 1, 'older data still warns in the east');
  assert.deepEqual(east.surfaceIds, ['old']);
});

test('two surfaces in different UTM zones still agree in one frame', () => {
  // Origin near the zone 14/15 edge (96 W): one grid in each zone.
  const lon = -95.9999;
  const a = makeGrid({
    id: 'z15',
    origin: { lon, lat: LAT },
    topAt: () => 20,
  });
  assert.equal(a.meta.crs.zone, 15);
  const b = createSurfaceGrid(
    {
      ...a.meta,
      id: 'z14',
      crs: { type: 'utm', zone: 14, north: true },
      ...(() => {
        const c = lonLatToUtm(lon, LAT, 14, true);
        return { originE: c.e - 100, originN: c.n + 100 };
      })(),
    },
    new Float32Array(a.top.length).fill(0),
    new Float32Array(a.top.length).fill(0),
  );
  const f = (grid) => {
    const m = createSurfaceModel([grid]);
    return m.view(lon, LAT).distanceAt(0, 0, 15, 30);
  };
  assert.ok(Math.abs(f(a).vertM - -5) < 0.05, 'zone 15 grid');
  assert.ok(Math.abs(f(b).vertM - 15) < 0.05, 'zone 14 grid');
});

test('probe: ring and path floors from the surface', () => {
  // A 20 m tree stand, 30 m wide, on flat ground at 0.
  const grid = makeGrid({
    topAt: (x, y) => (Math.abs(x) <= 15 && Math.abs(y) <= 15 ? 20 : 0),
  });
  const model = createSurfaceModel([grid]);
  const probe = createSurfaceProbe(model, 9.144);
  // A ring of 10 m radius around the stand centre runs over the trees.
  const over = probe.ringFloor(LON, LAT, 10);
  assert.equal(over.covered, 'full');
  assert.ok(over.aglM >= 29.1 && over.aglM <= 30.1, String(over.aglM));
  // A ring 60 m out clears the trees sideways: only the ground floor is left.
  const far = probe.ringFloor(LON, LAT, 60);
  assert.equal(far.covered, 'full');
  assert.ok(far.aglM < 10, String(far.aglM));
  // A ring half off the model is partly covered.
  const edge = ll(95, 0);
  assert.equal(probe.ringFloor(edge.lon, edge.lat, 30).covered, 'partial');
  const away = ll(500, 500);
  assert.deepEqual(probe.ringFloor(away.lon, away.lat, 30), {
    aglM: null,
    covered: 'none',
  });
  const path = probe.pathFloor([ll(-50, 0), ll(50, 0)]);
  assert.ok(path.aglM >= 29.1 && path.aglM <= 30.1);
  assert.deepEqual(createSurfaceProbe(null, 9).ringFloor(LON, LAT, 20), {
    aglM: null,
    covered: 'none',
  });
});

test('spans are capped but the count stays exact', () => {
  // A comb of 40 narrow pillars the leg weaves between at low height.
  const grid = makeGrid({
    topAt: (x, y) =>
      Math.abs(y) < 1 && ((Math.round(x) % 20) + 20) % 20 === 0 ? 30 : 0,
  });
  const r = run(grid, [leg(0, [[-90, 0, 12], [90, 0, 12]])]);
  assert.ok(r.spanCount >= 8);
  assert.ok(r.spans.length <= 200);
  assert.ok(r.spans[0].minDistM <= r.spans[r.spans.length - 1].minDistM);
});
