import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_OBSTACLES,
  OBSTACLE_CLEARANCE_MARGIN_M,
  OBSTACLE_HORIZONTAL_MARGIN_M,
  applyObstacleClearance,
  transitNeeds,
  createObstacleStore,
  normalizeObstacle,
  normalizeObstacles,
  obstacleLabel,
} from './obstacles.js';
import { AGL_CAP_M, assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';

const CENTER = { lon: -97.77, lat: 30.27 };
const m = metersPerDegree(CENTER.lat);
const east = (lon, metres) => lon + metres / m.lon;
function boxAround(widthM, heightM) {
  return {
    west: CENTER.lon - widthM / 2 / m.lon,
    east: CENTER.lon + widthM / 2 / m.lon,
    south: CENTER.lat - heightM / 2 / m.lat,
    north: CENTER.lat + heightM / 2 / m.lat,
  };
}
const tower = (over = {}) => ({
  id: 'faa-48-1',
  kind: 'tower',
  lon: CENTER.lon,
  lat: CENTER.lat,
  radiusM: 6,
  heightM: 60,
  source: 'faa',
  estimatedHeightM: 60,
  ...over,
});

// ------------------------------------------------------------- the model --
test('normalizeObstacle: fills defaults, clamps, and refuses what has no place', () => {
  const o = normalizeObstacle({
    id: 'a b!',
    kind: 'weird',
    lon: '-97.5',
    lat: '30',
    heightM: 9999,
    radiusM: 1,
    source: 'nope',
  });
  assert.equal(o.id, 'a-b-');
  assert.equal(o.kind, 'other');
  assert.equal(o.source, 'user');
  assert.equal(o.heightM, 400);
  assert.equal(o.radiusM, 2);
  assert.equal(o.estimatedHeightM, null);
  assert.equal(o.userEdited, false);
  assert.equal(normalizeObstacle({ id: 'x', lon: 'a', lat: 1 }), null);
  assert.equal(normalizeObstacle({ id: 'x', lon: 1, lat: 95 }), null);
  assert.equal(normalizeObstacle({ lon: 1, lat: 1 }), null);
  assert.equal(normalizeObstacle(null), null);
  // A missing height falls back to the estimate.
  assert.equal(
    normalizeObstacle({ id: 'e', lon: 1, lat: 1, estimatedHeightM: 18 })
      .heightM,
    18,
  );
});

test('normalizeObstacles: duplicates dropped and the list is capped', () => {
  const many = Array.from({ length: MAX_OBSTACLES + 20 }, (_, i) => ({
    id: `o${i}`,
    lon: 1,
    lat: 1,
  }));
  assert.equal(normalizeObstacles(many).length, MAX_OBSTACLES);
  assert.equal(
    normalizeObstacles([tower(), tower(), tower({ id: 'other' })]).length,
    2,
  );
  assert.deepEqual(normalizeObstacles('nope'), []);
});

test('store: add, type a height, drag, reset to the estimate, remove', () => {
  const seen = [];
  const store = createObstacleStore({ onChange: (l) => seen.push(l.length) });
  store.replaceEstimates([tower()]);
  assert.equal(store.list().length, 1);
  assert.equal(store.get('faa-48-1').userEdited, false);

  assert.equal(store.setHeight('faa-48-1', 75), true);
  let o = store.get('faa-48-1');
  assert.equal(o.heightM, 75);
  assert.equal(o.estimatedHeightM, 60, 'the estimate is kept for Reset');
  assert.equal(o.userEdited, true);

  assert.equal(store.setHeight('faa-48-1', 'abc'), false);
  assert.equal(store.setHeight('missing', 5), false);
  assert.equal(store.setHeight('faa-48-1', -3), true);
  assert.equal(store.get('faa-48-1').heightM, 0, 'clamped at the ground');

  assert.equal(store.reset('faa-48-1'), true);
  o = store.get('faa-48-1');
  assert.equal(o.heightM, 60);
  assert.equal(o.userEdited, false);

  const added = store.add({ lon: CENTER.lon, lat: CENTER.lat, heightM: 12 });
  assert.equal(added.source, 'user');
  assert.equal(added.userEdited, true);
  assert.equal(added.estimatedHeightM, null);
  assert.equal(store.reset(added.id), false, 'a user obstacle has no estimate');
  assert.equal(store.get(added.id).heightM, 12);

  assert.equal(store.remove(added.id), true);
  assert.equal(store.remove(added.id), false);
  assert.equal(store.list().length, 1);
  assert.ok(seen.length >= 6, 'every edit notifies');
});

test('store: a refresh keeps the operator edits and user obstacles, drops stale estimates', () => {
  const store = createObstacleStore();
  store.replaceEstimates([
    tower({ id: 'faa-1', estimatedHeightM: 60, heightM: 60 }),
    tower({ id: 'faa-2', estimatedHeightM: 40, heightM: 40 }),
    tower({ id: 'faa-3', estimatedHeightM: 30, heightM: 30 }),
  ]);
  store.setHeight('faa-1', 99);
  store.setHeight('faa-2', 41);
  const mine = store.add({ lon: 1, lat: 1, heightM: 20 });
  store.replaceEstimates([
    tower({ id: 'faa-1', estimatedHeightM: 65, heightM: 65 }),
    tower({ id: 'faa-4', estimatedHeightM: 10, heightM: 10 }),
  ]);
  const ids = store.list().map((o) => o.id);
  assert.ok(ids.includes('faa-1'), 'edited and seen again: kept');
  assert.ok(ids.includes('faa-2'), 'an edited obstacle is never dropped by a refresh');
  assert.ok(!ids.includes('faa-3'));
  assert.ok(ids.includes('faa-4'));
  assert.ok(ids.includes(mine.id), 'user obstacle always survives');
  const kept = store.get('faa-1');
  assert.equal(kept.heightM, 99, 'user edits win over estimates');
  assert.equal(kept.estimatedHeightM, 65, 'the estimate itself is refreshed');
  // user-source rows in a refresh are ignored: only the operator makes them
  store.replaceEstimates([{ id: 'sneaky', lon: 1, lat: 1, source: 'user' }]);
  assert.ok(!store.list().some((o) => o.id === 'sneaky'));
  store.clear();
  assert.equal(store.list().length, 0);
});

test('store: adding past the cap is refused', () => {
  const store = createObstacleStore();
  for (let i = 0; i < MAX_OBSTACLES; i += 1)
    assert.ok(store.add({ lon: 1, lat: 1 }));
  assert.equal(store.add({ lon: 1, lat: 1 }), null);
});

test('label reads "<kind> <h> m"', () => {
  assert.equal(obstacleLabel({ kind: 'tower', heightM: 60.4 }), 'tower 60 m');
  assert.equal(
    obstacleLabel({ kind: 'tree', heightM: 18 }, (k) => k.toUpperCase()),
    'TREE 18 m',
  );
});

// ------------------------------------------------------ planner clearance --
const legOf = (lons, agl = 40, lat = CENTER.lat) => ({
  id: 0,
  waypoints: lons.map((lon, i) => ({ id: i, lon, lat, aglM: agl })),
});

test('clearance: a waypoint inside radius + margin is raised to height + 5 m', () => {
  const near = east(CENTER.lon, 6 + OBSTACLE_HORIZONTAL_MARGIN_M - 1);
  const far = east(CENTER.lon, 6 + OBSTACLE_HORIZONTAL_MARGIN_M + 40);
  const out = applyObstacleClearance(
    [legOf([near, far, east(far, 200)])],
    [tower({ heightM: 50 })],
    { capM: AGL_CAP_M },
  );
  const [a, b, c] = out.legs[0].waypoints;
  assert.equal(a.aglM, 50 + OBSTACLE_CLEARANCE_MARGIN_M);
  assert.equal(b.aglM, 55, 'the stretch a to b starts in the reach, so b is lifted too');
  assert.equal(c.aglM, 40, 'the stretch b to c is clear of the column');
  assert.equal(out.raised, 2);
  assert.deepEqual(out.blocked, []);
});

test('clearance: a stretch that passes the column lifts both ends', () => {
  const out = applyObstacleClearance(
    [legOf([east(CENTER.lon, -300), east(CENTER.lon, 300)], 10)],
    [tower({ heightM: 30 })],
    { capM: AGL_CAP_M },
  );
  assert.deepEqual(
    out.legs[0].waypoints.map((w) => w.aglM),
    [35, 35],
  );
});

test('clearance: each obstacle has its own height; the tallest one near a point wins', () => {
  const lon = east(CENTER.lon, 4);
  const out = applyObstacleClearance(
    [legOf([lon])],
    [
      tower({ id: 'low', heightM: 10 }),
      tower({ id: 'high', heightM: 70, lon: east(CENTER.lon, 8) }),
    ],
    { capM: AGL_CAP_M },
  );
  assert.equal(out.legs[0].waypoints[0].aglM, 75);
  // Far from the tall one, only the short one applies.
  const farLon = east(CENTER.lon, 500);
  const out2 = applyObstacleClearance(
    [legOf([farLon], 5)],
    [
      tower({ id: 'low', heightM: 10, lon: farLon }),
      tower({ id: 'high', heightM: 70 }),
    ],
    { capM: AGL_CAP_M },
  );
  assert.equal(out2.legs[0].waypoints[0].aglM, 15);
});

test('clearance: waypoints already high enough are untouched and the legs are not mutated', () => {
  const leg = legOf([CENTER.lon], 100);
  const out = applyObstacleClearance([leg], [tower({ heightM: 30 })], {
    capM: AGL_CAP_M,
  });
  assert.equal(out.legs[0], leg, 'same leg object when nothing changed');
  const low = legOf([CENTER.lon], 10);
  const before = JSON.stringify(low);
  applyObstacleClearance([low], [tower({ heightM: 30 })], { capM: AGL_CAP_M });
  assert.equal(JSON.stringify(low), before);
});

test('clearance: where the cap cannot clear, the leg is marked blocked and capped', () => {
  const out = applyObstacleClearance(
    [legOf([CENTER.lon, east(CENTER.lon, 2)], 100)],
    [tower({ heightM: 140 })],
    { capM: AGL_CAP_M },
  );
  assert.equal(out.legs[0].obstacleBlocked, true);
  assert.deepEqual(
    out.legs[0].waypoints.map((w) => [w.aglM, w.obstacleBlocked]),
    [
      [AGL_CAP_M, true],
      [AGL_CAP_M, true],
    ],
  );
  assert.equal(out.blocked.length, 2);
  assert.equal(out.blocked[0].needAglM, 145);
  assert.equal(out.blocked[0].obstacleId, 'faa-48-1');
});

test('clearance: no obstacles means the very same legs back', () => {
  const legs = [legOf([CENTER.lon])];
  assert.equal(applyObstacleClearance(legs, [], { capM: 120 }).legs, legs);
});

// ---------------------------------------------- through the real planner --
test('plan: a grid flown at 40 m climbs over a 50 m tower and warns', () => {
  const plan = planFlight(boxAround(160, 160), {
    pattern: 'grid',
    aglM: 40,
    obstacles: [tower({ heightM: 50 })],
  });
  assert.equal(plan.error, undefined);
  assert.equal(plan.options.obstacles.length, 1);
  const done = assembleMissions(plan, { known: false });
  const wps = done.missions.flatMap((mi) => mi.waypoints);
  const high = wps.filter((w) => w.aglM >= 55);
  assert.ok(high.length > 0, 'something was lifted');
  assert.ok(wps.every((w) => w.aglM === 40 || w.aglM >= 55));
  assert.ok(done.warnings.some((w) => w.code === 'obstacle-raised'));
  assert.ok(!done.warnings.some((w) => w.code === 'obstacle-blocked'));
  // Every waypoint within the reach of the tower is at least 55 m.
  for (const w of wps) {
    const d = Math.hypot((w.lon - CENTER.lon) * m.lon, (w.lat - CENTER.lat) * m.lat);
    if (d <= 6 + OBSTACLE_HORIZONTAL_MARGIN_M) assert.ok(w.aglM >= 55, `d=${d}`);
  }
});

test('plan: a tower too tall for the cap warns and marks the legs red', () => {
  const plan = planFlight(boxAround(160, 160), {
    pattern: 'grid',
    aglM: 40,
    obstacles: [tower({ heightM: 150 })],
  });
  const done = assembleMissions(plan, { known: false });
  const warn = done.warnings.find((w) => w.code === 'obstacle-blocked');
  assert.ok(warn);
  assert.equal(warn.params.capM, AGL_CAP_M);
  assert.equal(warn.params.needM, 155);
  const legs = done.missions.flatMap((mi) => mi.legs);
  assert.ok(legs.some((l) => l.obstacleBlocked));
  assert.ok(done.missions.flatMap((mi) => mi.waypoints).every((w) => w.aglM <= AGL_CAP_M));
});

test('plan: orbit rings are lifted per obstacle, not just by the plan-wide height', () => {
  const plan = planFlight(boxAround(120, 120), {
    pattern: 'orbit',
    orbitRadiusM: 30,
    orbitHeightsM: [30, 40],
    obstacleHeightM: 10,
    obstacles: [
      tower({
        heightM: 60,
        lon: east(CENTER.lon, 30),
        radiusM: 8,
      }),
    ],
  });
  const done = assembleMissions(plan, { known: false });
  const orbit = done.missions.flatMap((mi) => mi.legs).filter((l) => l.kind === 'orbit');
  assert.ok(orbit.length >= 2);
  for (const leg of orbit) {
    const tall = leg.waypoints.filter((w) => w.aglM >= 65);
    assert.ok(tall.length > 0, 'points beside the tower are lifted');
    assert.ok(tall.length < leg.waypoints.length, 'the rest of the ring stays low');
  }
});

test('plan: with no obstacles nothing changes', () => {
  const opts = { pattern: 'grid', aglM: 40 };
  const a = assembleMissions(planFlight(boxAround(160, 160), opts), { known: false });
  const b = assembleMissions(
    planFlight(boxAround(160, 160), { ...opts, obstacles: [] }),
    { known: false },
  );
  assert.deepEqual(a.missions.map((x) => x.waypoints), b.missions.map((x) => x.waypoints));
  assert.ok(!a.warnings.some((w) => w.code.startsWith('obstacle')));
});

// ------------------------------------------------- Google terms: guard --
test('no obstacle code reads heights or picks from the Google 3D tiles', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const root = join(dir, '..', '..', '..');
  const files = [
    join(dir, 'obstacles.js'),
    join(dir, 'obstacleData.js'),
    join(dir, 'obstacleLayer.js'),
    join(root, 'server', 'providers', 'obstacles.js'),
  ];
  const banned = [
    /sampleHeight/i,
    /sampleHeightMostDetailed/i,
    /clampToHeight/i,
    /pickPosition/i,
    /drillPick/i,
    /scene\??\.pick\w*\s*\(/,
    /pickFromRay/,
    /3d-tiles|3dTiles/i,
    /photorealistic/i,
    /tile\.googleapis\.com/i,
    /Cesium3DTileset/,
    /createGoogleEarth/i,
  ];
  for (const file of files) {
    // Comments may explain the rule; code may not break it.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const re of banned) {
      assert.ok(!re.test(code), `${file} must not match ${re}`);
    }
  }
  // The folder-wide rule is stricter for the sampler used elsewhere:
  // the only terrain reads in dronePlan go through terrain.js.
  const others = readdirSync(dir).filter(
    (f) => f.endsWith('.js') && !/^(terrain|panel|pointTool)\.js$/.test(f),
  );
  for (const f of others) {
    const code = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/clampToHeight|sampleHeight\b|sampleHeightMostDetailed/.test(code), f);
  }
});

test('store: estimates of a source that failed to load are kept, the others are replaced', () => {
  const store = createObstacleStore();
  store.replaceEstimates([
    { id: 'faa-1', kind: 'tower', source: 'faa', lon: -97.77, lat: 30.27, radiusM: 6, estimatedHeightM: 60, heightM: 60 },
    { id: 'chm-1', kind: 'tree', source: 'canopy', lon: -97.77, lat: 30.28, radiusM: 20, estimatedHeightM: 18, heightM: 18 },
  ]);
  store.replaceEstimates([], { keepSources: ['faa'] });
  assert.deepEqual(store.list().map((o) => o.id), ['faa-1']);
});

test('guard: the ADD tool is given the terrain-only pick, not the annotation depth pick', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(dir, 'panel.js'), 'utf8');
  assert.match(
    panel,
    /owner: OBSTACLE_ADD_POINTER_OWNER,\s*pickWorld: \(v, nx, ny\) =>\s*pickTerrainLonLat\(v, nx, ny, cesium, groundHintM\)/,
  );
});

test('store: an edited obstacle survives when the area moves and its ids change', () => {
  const store = createObstacleStore();
  const row = (id, lon) => ({ id, kind: 'tree', source: 'canopy', lon, lat: 30.28, radiusM: 100, estimatedHeightM: 18, heightM: 18 });
  store.replaceEstimates([row('chm-a', -97.77)]);
  store.setHeight('chm-a', 40);
  store.replaceEstimates([row('chm-b', -97.7702)]);
  const list = store.list();
  assert.equal(list.length, 1, 'the fresh row at the same place is not added twice');
  assert.equal(list[0].heightM, 40);
  assert.equal(list[0].userEdited, true);
  store.replaceEstimates([]);
  assert.equal(store.list()[0].heightM, 40, 'never dropped, even when nothing comes back');
});

test('planner: a column on the closing gap of an orbit ring is cleared too', () => {
  const m = metersPerDegree(30.27);
  const wp = (id, x, y) => ({ id, lon: -97.77 + x / m.lon, lat: 30.27 + y / m.lat, aglM: 30 });
  // Ring points around (0,0) at 60 m; the gap between the last and first
  // point passes through (60, 0): put the column there, away from all points.
  const ring = [
    wp('p0', 60, 30), wp('p1', 0, 60), wp('p2', -60, 0), wp('p3', 0, -60), wp('p4', 60, -30),
  ];
  const ob = { id: 'x', kind: 'tower', source: 'user', lon: -97.77 + 60 / m.lon, lat: 30.27, radiusM: 3, heightM: 80 };
  const out = applyObstacleClearance([{ id: 'o', kind: 'orbit', waypoints: ring }], [ob], { capM: 120 });
  assert.ok(out.legs[0].waypoints[0].aglM >= 85);
  assert.ok(out.legs[0].waypoints[4].aglM >= 85);
  const flat = applyObstacleClearance([{ id: 'o', kind: 'path', waypoints: ring }], [ob], { capM: 120 });
  assert.equal(flat.legs[0].waypoints[0].aglM, 30, 'only a ring closes on itself');
});

// ------------------------------------------- stretches between legs / slope --
{
  const m = metersPerDegree(30.27);
  const at = (id, x, y, aglM = 30) => ({
    id,
    lon: CENTER.lon + x / m.lon,
    lat: CENTER.lat + y / m.lat,
    aglM,
  });
  const col = (x, y, heightM = 80, radiusM = 3) => ({
    id: 'col',
    kind: 'tower',
    source: 'user',
    lon: CENTER.lon + x / m.lon,
    lat: CENTER.lat + y / m.lat,
    radiusM,
    heightM,
  });

  test('clearance: the turn between two grid lines is checked, not only each line', () => {
    const legs = [
      { id: 'l1', kind: 'path', waypoints: [at('a', -100, 0), at('b', 100, 0)] },
      { id: 'l2', kind: 'path', waypoints: [at('c', 100, 60), at('d', -100, 60)] },
    ];
    // The column stands between b and c: on neither line.
    const out = applyObstacleClearance(legs, [col(100, 30)], { capM: 120 });
    assert.equal(out.legs[0].waypoints[1].aglM, 85);
    assert.equal(out.legs[1].waypoints[0].aglM, 85);
    assert.equal(out.legs[0].waypoints[0].aglM, 30, 'far ends stay put');
  });

  test('transit: the way out and the way home are checked against the mission ends', () => {
    const takeoff = { lon: CENTER.lon, lat: CENTER.lat };
    const need = transitNeeds([col(100, 0)], takeoff, at('a', 200, 0), at('b', 300, 0));
    assert.equal(need.first.needAglM, 85);
    assert.equal(need.last.needAglM, 85, 'the way home passes it too');
    assert.equal(transitNeeds([col(100, 0)], null, at('a', 200, 0), at('b', 300, 0)).first, null);
    assert.equal(transitNeeds([col(100, 90)], takeoff, at('a', 200, 0), at('b', 300, 0)).first, null);
  });

  test('planner: every battery mission checks its OWN way out from takeoff', () => {
    const box = boxAround(900, 300);
    const wide = { aglM: 40, batteryMin: 3, obstacles: [] };
    const base = planFlight(box, wide);
    assert.ok(!base.error, base.error);
    const m0 = assembleMissions(base, { known: false });
    assert.ok(m0.missions.length >= 2, `needs 2+ missions, got ${m0.missions.length}`);
    const second = m0.missions[1].waypoints[0];
    const mid = {
      lon: (base.takeoff.lon + second.lon) / 2,
      lat: (base.takeoff.lat + second.lat) / 2,
    };
    const tower = { id: 'mid', kind: 'tower', source: 'user', lon: mid.lon, lat: mid.lat, radiusM: 3, heightM: 60 };
    const plan = planFlight(box, { ...wide, obstacles: [tower] });
    const out = assembleMissions(plan, { known: false });
    assert.ok(out.missions[1].waypoints[0].aglM >= 65, `lifted: ${out.missions[1].waypoints[0].aglM}`);
    const tall = planFlight(box, { ...wide, obstacles: [{ ...tower, heightM: 200 }] });
    const blocked = assembleMissions(tall, { known: false });
    assert.ok(blocked.warnings.some((w) => w.code === 'obstacle-blocked'));
    assert.equal(blocked.missions[1].waypoints[0].obstacleBlocked, true);
  });

  test('clearance: a column on higher ground than the waypoint needs the difference on top', () => {
    const legs = [{ id: 'l1', kind: 'path', waypoints: [at('a', -5, 0), at('b', 5, 0)] }];
    const ground = { a: 100, b: 100 };
    const out = applyObstacleClearance(legs, [col(0, 0, 40)], {
      capM: 120,
      groundOf: (w) => ground[w.id],
      obstacleGroundOf: () => 130,
    });
    // 40 m column + 5 m margin + 30 m higher ground.
    assert.equal(out.legs[0].waypoints[0].aglM, 75);
    const flat = applyObstacleClearance(legs, [col(0, 0, 40)], {
      capM: 120,
      groundOf: (w) => ground[w.id],
      obstacleGroundOf: () => 90,
    });
    assert.equal(flat.legs[0].waypoints[0].aglM, 45, 'lower ground adds nothing');
    const capped = applyObstacleClearance(legs, [col(0, 0, 100)], {
      capM: 120,
      groundOf: (w) => ground[w.id],
      obstacleGroundOf: () => 130,
    });
    assert.equal(capped.blocked.length, 2, 'the slope can make a column impossible to clear');
  });

  test('planner: obstacle ground from the terrain read lifts the real plan', () => {
    const plan = planFlight(boxAround(160, 160), {
      aglM: 40,
      obstacles: [col(0, 0, 30, 5)],
    });
    assert.ok(!plan.error, plan.error);
    const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
    const wpM = [];
    ids.forEach((id) => (wpM[id] = 100));
    const flat = assembleMissions(plan, { known: true, takeoffM: 100, wpM, obstacleM: { col: 100 } });
    const hill = assembleMissions(plan, { known: true, takeoffM: 100, wpM, obstacleM: { col: 160 } });
    const maxAgl = (r) => Math.max(...r.missions.flatMap((mi) => mi.waypoints.map((w) => w.aglM)));
    assert.equal(maxAgl(flat), 40);
    assert.equal(maxAgl(hill), 95, '30 m column + 5 m margin + 60 m higher ground');
  });
}

test('store: when the cap bites, new towers beat old rows kept from a failed source', () => {
  const store = createObstacleStore();
  const old = Array.from({ length: MAX_OBSTACLES }, (_, i) => ({
    id: `chm-old-${i}`, kind: 'tree', source: 'canopy', lon: -90 + i * 0.0001, lat: 30, radiusM: 20, estimatedHeightM: 10, heightM: 10,
  }));
  store.replaceEstimates(old);
  assert.equal(store.list().length, MAX_OBSTACLES);
  const tower = { id: 'faa-new', kind: 'tower', source: 'faa', lon: -97, lat: 30, radiusM: 6, estimatedHeightM: 70, heightM: 70 };
  store.replaceEstimates([tower], { keepSources: ['canopy'], within: () => true });
  const ids = store.list().map((o) => o.id);
  assert.ok(ids.includes('faa-new'));
  assert.equal(ids.length, MAX_OBSTACLES);
  store.replaceEstimates([tower], { keepSources: ['canopy'], within: (o) => o.lon > -50 });
  assert.deepEqual(store.list().map((o) => o.id), ['faa-new']);
});
