import assert from 'node:assert/strict';
import test from 'node:test';
import { planFlight } from './planner.js';
import { checkClearance, createSurfaceModel, createSurfaceProbe } from './clearance.js';
import { metersPerDegree } from './geo.js';
import { makeGrid } from './surfaceFixtures.mjs';
import { CENTRE, boxAround } from './buildingFixtures.mjs';

const M = metersPerDegree(CENTRE.lat);
const at = (n, e) => ({ lon: CENTRE.lon + e / M.lon, lat: CENTRE.lat + n / M.lat });
const BOX = boxAround(240, 240);
const origin = { lon: CENTRE.lon, lat: CENTRE.lat };

// A stand of 35 m trees, 60 m across, centred on the target.
const stand = makeGrid({
  size: 300,
  origin,
  topAt: (x, y) => (Math.hypot(x, y) <= 30 ? 35 : 0),
});
const model = createSurfaceModel([stand]);
const REQUIRED = 9.144;

const plan = (extra = {}) =>
  planFlight(BOX, {
    pattern: 'orbit',
    presetId: 'dji-mini-4-pro',
    orbitRadiusM: 20,
    orbitTargets: [{ id: 'a', ...at(0, 0), active: true }],
    ...extra,
  });
const orbitWps = (p) =>
  p.legs.filter((l) => l.kind === 'orbit').flatMap((l) => l.waypoints);

test('planner: rings clear the surface instead of the single tree height', () => {
  const guess = plan({ obstacleHeightM: 15 });
  const probe = createSurfaceProbe(model, REQUIRED);
  const withSurface = plan({ obstacleHeightM: 15, surfaceProbe: probe });
  const lowest = (p) => Math.min(...orbitWps(p).map((w) => w.aglM));
  assert.ok(lowest(withSurface) > lowest(guess), 'the model sees the 35 m trees');
  assert.ok(withSurface.orbit.surface.fromSurface > 0);
  assert.equal(withSurface.orbit.surface.requiredM, REQUIRED);
  // Every orbit waypoint clears the model by the wanted distance.
  const r = checkClearance({
    legs: withSurface.legs.filter((l) => l.kind === 'orbit'),
    model,
    minClearanceM: 6.096,
    errorMarginM: 3.048,
  });
  assert.equal(r.spanCount, 0, JSON.stringify(r.worst));
  // The probe never leaks into the saved options.
  assert.equal(withSurface.options.surfaceProbe, null);
  assert.ok(!JSON.stringify(withSurface).includes('ringFloor'));
});

test('planner: outside the model the tree height setting stands in, and says so', () => {
  const far = makeGrid({ size: 100, origin: { lon: CENTRE.lon + 0.01, lat: CENTRE.lat }, topAt: () => 40 });
  const probe = createSurfaceProbe(createSurfaceModel([far]), REQUIRED);
  const a = plan({ obstacleHeightM: 30, surfaceProbe: probe });
  const b = plan({ obstacleHeightM: 30 });
  assert.deepEqual(orbitWps(a).map((w) => w.aglM), orbitWps(b).map((w) => w.aglM));
  assert.ok(a.notes.some((n) => n.code === 'orbit-surface-fallback'));
  assert.equal(a.orbit.surface.fromSurface, 0);
  assert.ok(!b.notes.some((n) => n.code === 'orbit-surface-fallback'));
});

test('planner: a bare-ground surface lets a ring fly lower than the tree guess', () => {
  const bare = makeGrid({ size: 300, origin, topAt: () => 0 });
  const probe = createSurfaceProbe(createSurfaceModel([bare]), REQUIRED);
  const guess = plan({ obstacleHeightM: 45 });
  const withSurface = plan({ obstacleHeightM: 45, surfaceProbe: probe });
  const lowest = (p) => Math.min(...orbitWps(p).map((w) => w.aglM));
  assert.ok(lowest(withSurface) < lowest(guess));
});

test('planner: a look-at path over trees is lifted to clear them', () => {
  const probe = createSurfaceProbe(model, REQUIRED);
  const opts = {
    obstacleHeightM: 10,
    lookAtPaths: [{ id: 'p', active: true, aglM: 20, points: [at(-60, 0), at(60, 0)] }],
  };
  const lo = plan(opts);
  const hi = plan({ ...opts, surfaceProbe: probe });
  const path = (p) => p.legs.filter((l) => l.kind === 'lookat').flatMap((l) => l.waypoints);
  assert.ok(path(lo).length > 0, 'look-at leg built');
  assert.ok(Math.min(...path(hi).map((w) => w.aglM)) > Math.min(...path(lo).map((w) => w.aglM)));
  assert.equal(hi.orbit.lookAt[0].floorSource, 'surface');
});
