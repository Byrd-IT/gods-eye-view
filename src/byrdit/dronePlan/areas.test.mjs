import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleAreaPlan, distanceToAreasM, jobSlug, planAreas } from './areas.js';
import { groundDistanceM, makeFrame, metersPerDegree } from './geo.js';
import { pointInRing } from './polygon.js';
import { assembleMissions, planFlight } from './planner.js';

function boxAround(lon, lat, widthM, heightM) {
  const m = metersPerDegree(lat);
  return {
    west: lon - widthM / 2 / m.lon,
    east: lon + widthM / 2 / m.lon,
    south: lat - heightM / 2 / m.lat,
    north: lat + heightM / 2 / m.lat,
  };
}

const near = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label ?? ''} expected ${expected} ±${tol}, got ${actual}`,
  );

function flatGround(plan, takeoffM = 100) {
  const wpM = [];
  for (const leg of plan.legs) {
    for (const w of leg.waypoints) wpM[w.id] = takeoffM;
  }
  return { known: true, takeoffM, wpM };
}

function waypointFields(plan) {
  return plan.legs.flatMap((leg) =>
    leg.waypoints.map((w) => [w.lon, w.lat, w.aglM, w.photo, w.pitchDeg, w.headingDeg]),
  );
}

const opts = {
  presetId: 'dji-phantom-4',
  aglM: 80,
  frontOverlap: 70,
  sideOverlap: 70,
  pattern: 'grid',
};

test('a single rectangle matches planFlight waypoint for waypoint', () => {
  const box = boxAround(-94.5, 32.7, 180, 120);
  const direct = planFlight(box, opts);
  const via = planAreas(
    [{ id: 'a1', name: 'Area 1', kind: 'rect', box }],
    opts,
  );
  assert.equal(via.error, undefined);
  assert.deepEqual(waypointFields(via), waypointFields(direct));
  const ground = flatGround(direct);
  const left = assembleMissions(direct, ground);
  const right = assembleAreaPlan(via, flatGround(via));
  assert.equal(right.totals.missionCount, left.totals.missionCount);
  assert.equal(right.totals.photoCount, left.totals.photoCount);
  assert.equal(right.totals.waypointCount, left.totals.waypointCount);
  near(right.totals.distanceM, left.totals.distanceM, 0.01, 'distance');
  assert.equal(right.missions[0].jobName, 'Area 1');
});

test('a self-intersecting polygon is rejected with a clear error', () => {
  const frame = makeFrame(-94.5, 32.7);
  const bowtie = [
    { x: 0, y: 0 },
    { x: 80, y: 80 },
    { x: 0, y: 80 },
    { x: 80, y: 0 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  const plan = planAreas(
    [{ id: 'bad', name: 'Bad', kind: 'polygon', ring: bowtie }],
    opts,
  );
  assert.equal(plan.error, 'self-intersecting');
  assert.match(plan.message, /crosses itself/);
});

test('an L polygon is not flown over its missing corner', () => {
  const frame = makeFrame(-94.5, 32.7);
  // 400 m square with a 250 m by 200 m south-east notch. The photo margin is
  // about 69 m, so the middle of the notch must stay empty while the edge
  // band is flown.
  const ell = [
    { x: 0, y: 0 },
    { x: 150, y: 0 },
    { x: 150, y: 200 },
    { x: 400, y: 200 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  const plan = planAreas(
    [{ id: 'L', name: 'L field', kind: 'polygon', ring: ell }],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.ok(plan.legs.length > 0);
  assert.ok(plan.footprintMarginM > 20 && plan.footprintMarginM < 100);
  const margin = plan.footprintMarginM;
  let outsideOriginal = false;
  for (const leg of plan.legs) {
    for (const w of leg.waypoints) {
      const p = frame.toXY(w.lon, w.lat);
      assert.ok(
        !(p.x > 150 + margin + 5 && p.y < 200 - margin - 5),
        `waypoint in the notch at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`,
      );
      if (p.x > 150 && p.x < 150 + margin && p.y > 20 && p.y < 180) {
        outsideOriginal = true;
      }
    }
  }
  assert.equal(outsideOriginal, true, 'the footprint margin must cover the edge');
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].name, 'L field');
});

test('overlapping rectangles are flown once and keep a job each', () => {
  const a = boxAround(-94.5, 32.7, 160, 160);
  const b = boxAround(-94.5 + 0.0008, 32.7 + 0.0008, 160, 160);
  const plan = planAreas(
    [
      { id: 'a', name: 'North', kind: 'rect', box: a },
      { id: 'b', name: 'South', kind: 'rect', box: b },
    ],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.jobs.length, 2);
  assert.deepEqual(
    plan.jobs.map((job) => job.name),
    ['North', 'South'],
  );
  const alone = planFlight(a, opts);
  assert.ok(
    plan.waypointCount < alone.waypointCount * 2,
    `union ${plan.waypointCount} should be well under twice one box (${alone.waypointCount})`,
  );
  const built = assembleAreaPlan(plan, flatGround(plan));
  assert.deepEqual(
    built.missions.map((m) => m.jobId).filter((id, i, all) => all.indexOf(id) === i),
    ['job-1', 'job-2'],
  );
  const photos = built.areaStats.reduce((sum, row) => sum + row.photoCount, 0);
  assert.equal(photos, built.totals.photoCount);
  assert.equal(built.areaStats[0].shared, false);
});

test('a waypoint in only one of two overlapping boxes stays in that box job', () => {
  const shift = 100 / metersPerDegree(32.7).lon;
  const a = boxAround(-94.5, 32.7, 200, 120);
  const b = {
    west: a.west + shift,
    east: a.east + shift,
    south: a.south,
    north: a.north,
  };
  const plan = planAreas(
    [
      { id: 'a', name: 'West', kind: 'rect', box: a },
      { id: 'b', name: 'East', kind: 'rect', box: b },
    ],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.jobs.length, 2);
  const inside = (box, w) =>
    w.lon >= box.west &&
    w.lon <= box.east &&
    w.lat >= box.south &&
    w.lat <= box.north;
  let onlyWest = 0;
  let onlyEast = 0;
  for (const leg of plan.legs) {
    for (const w of leg.waypoints) {
      const west = inside(a, w);
      const east = inside(b, w);
      if (west && !east) {
        onlyWest += 1;
        assert.equal(leg.jobId, 'job-1', `${w.lon},${w.lat}`);
      }
      if (east && !west) {
        onlyEast += 1;
        assert.equal(leg.jobId, 'job-2', `${w.lon},${w.lat}`);
      }
    }
  }
  assert.ok(onlyWest > 0, 'west exclusive ground has no photos');
  assert.ok(onlyEast > 0, 'east exclusive ground has no photos');
});

test('disjoint rectangles stay separate flight blocks', () => {
  const a = boxAround(-94.5, 32.7, 140, 100);
  const b = boxAround(-94.48, 32.7, 140, 100);
  const plan = planAreas(
    [
      { id: 'a', name: 'West', kind: 'rect', box: a },
      { id: 'b', name: 'East', kind: 'rect', box: b },
    ],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.blocks.length, 2);
  assert.equal(plan.jobs.length, 2);
  const west = plan.legs.filter((leg) => leg.jobId === 'job-1');
  const east = plan.legs.filter((leg) => leg.jobId === 'job-2');
  assert.ok(west.length > 0 && east.length > 0);
  const westPlan = planFlight(a, opts);
  assert.equal(
    west.reduce((sum, leg) => sum + leg.waypoints.length, 0),
    westPlan.waypointCount,
  );
});

test('one job for the whole plan tags every mission with that job', () => {
  const a = boxAround(-94.5, 32.7, 140, 100);
  const b = boxAround(-94.48, 32.7, 140, 100);
  const plan = planAreas(
    [
      { id: 'a', name: 'West', kind: 'rect', box: a },
      { id: 'b', name: 'East', kind: 'rect', box: b },
    ],
    { ...opts, jobGrouping: 'whole' },
  );
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].name, 'Whole plan');
  const built = assembleAreaPlan(plan, flatGround(plan));
  assert.ok(built.missions.every((m) => m.jobName === 'Whole plan'));
  assert.ok(built.totals.missionCount >= 1);
});

test('the mission split still caps a multi-area plan at 200 waypoints', () => {
  const a = boxAround(-94.5, 32.7, 400, 300);
  const b = boxAround(-94.49, 32.72, 400, 300);
  const plan = planAreas(
    [
      { id: 'a', name: 'One', kind: 'rect', box: a },
      { id: 'b', name: 'Two', kind: 'rect', box: b },
    ],
    { ...opts, maxWaypoints: 12, jobGrouping: 'whole' },
  );
  assert.equal(plan.error, undefined, plan.message);
  const built = assembleAreaPlan(plan, flatGround(plan));
  assert.ok(built.missions.length > 1, 'a short waypoint cap must split the plan');
  for (const mission of built.missions) {
    assert.ok(mission.waypointCount <= 12);
  }
});

test('a short box across the antimeridian still matches planFlight', () => {
  const box = { west: 179.995, south: 0.1, east: -179.995, north: 0.102 };
  const direct = planFlight(box, opts);
  assert.equal(direct.error, undefined, direct.message);
  const via = planAreas(
    [{ id: 'date', name: 'Dateline', kind: 'rect', box }],
    opts,
  );
  assert.deepEqual(waypointFields(via), waypointFields(direct));
  const polygon = planAreas(
    [{ id: 'datep', name: 'Dateline poly', kind: 'polygon', ring: [
      { lon: box.west, lat: box.south },
      { lon: box.east, lat: box.south },
      { lon: box.east, lat: box.north },
      { lon: box.west, lat: box.north },
    ] }],
    opts,
  );
  assert.equal(polygon.error, undefined, polygon.message);
  for (const leg of polygon.legs) {
    for (const w of leg.waypoints) {
      assert.ok(Math.abs(w.lon) > 179.9, `lon ${w.lon} is not on the short arc`);
    }
  }
});

test('takeoff inside a polygon is 0 m and far outside is the edge distance', () => {
  const frame = makeFrame(-94.5, 32.7);
  const ring = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 0, y: 200 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  const area = { id: 'p', name: 'P', kind: 'polygon', ring, box: null };
  const inside = frame.toLonLat(100, 100);
  assert.equal(distanceToAreasM([area], inside), 0);
  const outside = frame.toLonLat(100, -50);
  near(distanceToAreasM([area], outside), 50, 0.5, 'edge distance');
});

test('the download zip puts each job in its own folder and the README names them', async () => {
  const { buildBundleZip, readmeText } = await import('./wpml.js');
  const { readZip } = await import('./zip.js');
  const a = boxAround(-94.5, 32.7, 180, 140);
  const b = boxAround(-94.492, 32.704, 180, 140);
  const plan = planAreas(
    [
      { id: 'north', name: 'North field', kind: 'rect', box: a },
      { id: 'south', name: 'South field', kind: 'rect', box: b },
    ],
    { ...opts, presetId: 'dji-mini-5-pro' },
  );
  assert.equal(plan.error, undefined, plan.message);
  const built = assembleAreaPlan(plan, flatGround(plan));
  const when = new Date('2026-10-29T15:04:00Z');
  const files = readZip(buildBundleZip(built, { when }));
  const names = [...files.keys()];
  assert.ok(names.includes('README.txt'));
  assert.ok(
    names.some((name) => name.startsWith('job-1-North-field/') && name.endsWith('.kmz')),
    names.join(', '),
  );
  assert.ok(
    names.some((name) => name.startsWith('job-2-South-field/') && name.endsWith('.kmz')),
    names.join(', '),
  );
  const readme = new TextDecoder().decode(files.get('README.txt'));
  assert.equal(readme, readmeText(built, when));
  assert.match(readme, /Job: North field/);
  assert.match(readme, /Job: South field/);
  assert.match(readme, /processed together \(ODM\)/);
  assert.match(readme, /only in the first job/);
  assert.match(readme, /Photos: /);
  const whole = assembleAreaPlan(
    planAreas(
      [
        { id: 'north', name: 'North field', kind: 'rect', box: a },
        { id: 'south', name: 'South field', kind: 'rect', box: b },
      ],
      { ...opts, presetId: 'dji-mini-5-pro', jobGrouping: 'whole' },
    ),
    flatGround(plan),
  );
  const wholeNames = [...readZip(buildBundleZip(whole, { when })).keys()];
  assert.ok(
    wholeNames.every((name) => name === 'README.txt' || !name.includes('/')),
    wholeNames.join(', '),
  );
  assert.ok(wholeNames.some((name) => name.endsWith('.kmz')));
});

test('two jobs with the same name do not share a folder or a photo count', async () => {
  const { buildBundleZip, readmeText } = await import('./wpml.js');
  const { readZip } = await import('./zip.js');
  const a = boxAround(-94.5, 32.7, 140, 100);
  const b = boxAround(-94.48, 32.7, 140, 100);
  const plan = planAreas(
    [
      { id: 'a', name: 'North field', kind: 'rect', box: a },
      { id: 'b', name: 'North field', kind: 'rect', box: b },
    ],
    { ...opts, presetId: 'dji-mini-5-pro' },
  );
  const built = assembleAreaPlan(plan, flatGround(plan));
  const when = new Date('2026-10-29T15:04:00Z');
  const names = [...readZip(buildBundleZip(built, { when })).keys()];
  const folders = names
    .filter((name) => name.includes('/'))
    .map((name) => name.split('/')[0]);
  assert.equal(new Set(folders).size, 2, names.join(', '));
  assert.equal(new Set(names).size, names.length, 'duplicate zip paths');
  const readme = readmeText(built, when);
  const photos = [...readme.matchAll(/Photos: (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(photos.length, 3);
  assert.equal(photos[1] + photos[2], photos[0]);
});

test('a dotted area name cannot become a parent folder', () => {
  assert.equal(jobSlug('..'), 'area');
  assert.equal(jobSlug('../secret'), 'secret');
  assert.equal(jobSlug('North field'), 'North-field');
});

test('a takeoff near one area is kept when another area is far', () => {
  const a = boxAround(-94.5, 32.7, 140, 100);
  const b = boxAround(-94.45, 32.7, 140, 100);
  const takeoff = { lon: -94.5, lat: 32.7 };
  const plan = planAreas(
    [
      { id: 'a', name: 'Near', kind: 'rect', box: a },
      { id: 'b', name: 'Far', kind: 'rect', box: b },
    ],
    { ...opts, takeoff },
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.takeoff.custom, true);
  near(plan.takeoff.lon, takeoff.lon, 1e-6, 'takeoff lon');
  assert.equal(
    plan.notes.some((n) => n.code === 'takeoff-too-far'),
    false,
  );
  assert.equal(
    plan.notes.some((n) => n.code === 'areas-spread'),
    true,
  );
});

test('orbit stays a separate job on each area', () => {
  const a = boxAround(-94.5, 32.7, 80, 80);
  const b = boxAround(-94.48, 32.7, 80, 80);
  const plan = planAreas(
    [
      { id: 'a', name: 'West', kind: 'rect', box: a },
      { id: 'b', name: 'East', kind: 'rect', box: b },
    ],
    { ...opts, pattern: 'orbit' },
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.jobs.length, 2);
  assert.ok(plan.legs.every((leg) => leg.kind === 'orbit'));
});

test('a double-grid polygon plans without using the bounding box as the flown area', () => {
  const frame = makeFrame(-94.5, 32.7);
  const ring = [
    { x: 0, y: 0 },
    { x: 150, y: 0 },
    { x: 150, y: 200 },
    { x: 400, y: 200 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  const plan = planAreas(
    [{ id: 'L', name: 'L field', kind: 'polygon', ring }],
    { ...opts, pattern: 'double' },
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.ok(plan.legs.length > 1);
  assert.equal(plan.jobs.length, 1);
});

function legAims(leg, frame, look) {
  const pts = leg.waypoints.map((w) => frame.toXY(w.lon, w.lat));
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = len > 1e-6 ? (b.x - a.x) / len : 0;
  const uy = len > 1e-6 ? (b.y - a.y) / len : 0;
  return pts.map((p) => ({
    x: p.x + ux * look,
    y: p.y + uy * look,
    jobId: leg.jobId,
  }));
}

function distToSeg(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

test('a double-grid of two overlapping rectangles aims at each edge and keeps each job in its own box', () => {
  const frame = makeFrame(-94.5, 32.7);
  const agl = 60;
  const tilt = -45;
  const look = agl * Math.tan(((90 + tilt) * Math.PI) / 180);
  near(look, agl, 0.01, 'look-ahead');
  const rect = (x0, y0, x1, y1) => {
    const sw = frame.toLonLat(x0, y0);
    const ne = frame.toLonLat(x1, y1);
    return { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat };
  };
  const plan = planAreas(
    [
      { id: 'a', name: 'West', kind: 'rect', box: rect(0, 0, 180, 140) },
      { id: 'b', name: 'East', kind: 'rect', box: rect(90, 0, 270, 140) },
    ],
    { ...opts, pattern: 'double', aglM: agl, tiltPitchDeg: tilt },
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.jobs.length, 2);
  const spacing = Math.max(...plan.legs.map((leg) => leg.photoSpacingM));
  const aims = plan.legs.flatMap((leg) => legAims(leg, frame, look));
  const west = aims.filter((p) => p.jobId === 'job-1');
  const east = aims.filter((p) => p.jobId === 'job-2');
  assert.ok(west.length > 0 && east.length > 0);
  for (const p of west) {
    assert.ok(p.x >= -1 && p.x <= 181 && p.y >= -1 && p.y <= 141, `west aim ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`);
  }
  for (const p of east) {
    assert.ok(p.x >= 179 && p.x <= 271 && p.y >= -1 && p.y <= 141, `east aim ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`);
  }
  const edges = [
    [{ x: 0, y: 0 }, { x: 0, y: 140 }],
    [{ x: 270, y: 0 }, { x: 270, y: 140 }],
    [{ x: 0, y: 0 }, { x: 270, y: 0 }],
    [{ x: 0, y: 140 }, { x: 270, y: 140 }],
  ];
  for (const [a, b] of edges) {
    const best = Math.min(...aims.map((p) => distToSeg(p, a, b)));
    assert.ok(best <= spacing, `edge ${a.x},${a.y}-${b.x},${b.y} is ${best.toFixed(1)} m from the nearest aim (spacing ${spacing.toFixed(1)})`);
  }
});

test('a double-grid polygon aims at its own edges and not at the missing corner', () => {
  const frame = makeFrame(-94.5, 32.7);
  const agl = 60;
  const tilt = -45;
  const look = agl * Math.tan(((90 + tilt) * Math.PI) / 180);
  const local = [
    { x: 0, y: 0 },
    { x: 150, y: 0 },
    { x: 150, y: 200 },
    { x: 400, y: 200 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ];
  const plan = planAreas(
    [{ id: 'L', name: 'L field', kind: 'polygon', ring: local.map((p) => frame.toLonLat(p.x, p.y)) }],
    { ...opts, pattern: 'double', aglM: agl, tiltPitchDeg: tilt },
  );
  assert.equal(plan.error, undefined, plan.message);
  const spacing = Math.max(...plan.legs.map((leg) => leg.photoSpacingM));
  const margin = plan.footprintMarginM;
  const aims = plan.legs.flatMap((leg) => legAims(leg, frame, look));
  assert.ok(aims.length > 4);
  for (const p of aims) {
    const inside = pointInRing(p, local) || distToRing(p, local) <= margin * Math.SQRT2 + 2;
    assert.ok(inside, `aim ${p.x.toFixed(1)}, ${p.y.toFixed(1)} is outside the footprint`);
    assert.ok(
      !(p.x > 150 + margin * Math.SQRT2 + 2 && p.y < 200 - margin * Math.SQRT2 - 2),
      `aim ${p.x.toFixed(1)}, ${p.y.toFixed(1)} is in the missing corner`,
    );
  }
  for (let i = 0; i < local.length; i += 1) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    const best = Math.min(...aims.map((p) => distToSeg(p, a, b)));
    assert.ok(
      best <= spacing,
      `edge ${i} is ${best.toFixed(1)} m from the nearest aim (spacing ${spacing.toFixed(1)})`,
    );
  }
});

function distToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)));
  }
  return best;
}

test('a sharp polygon does not fly a spike past the footprint margin', () => {
  const frame = makeFrame(-94.5, 32.7);
  const local = [
    { x: 0, y: 0 },
    { x: 250, y: 0 },
    { x: 246, y: 43 },
  ];
  const plan = planAreas(
    [{ id: 'thin', name: 'Thin', kind: 'polygon', ring: local.map((p) => frame.toLonLat(p.x, p.y)) }],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  const margin = plan.footprintMarginM;
  assert.ok(margin > 10, `margin ${margin}`);
  assert.ok(plan.legs.length > 0);
  for (const leg of plan.legs) {
    for (const w of leg.waypoints) {
      const dist = distToRing(frame.toXY(w.lon, w.lat), local);
      assert.ok(
        dist <= margin * Math.SQRT2 + 2,
        `waypoint ${dist.toFixed(1)} m from the ring (margin ${margin.toFixed(1)})`,
      );
      assert.equal(w.headingDeg, leg.waypoints[0].headingDeg);
    }
  }
});

test('a notch narrower than the footprint margin is not flown as a bowtie', () => {
  const frame = makeFrame(-94.5, 32.7);
  const local = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 100 },
    { x: 180, y: 100 },
    { x: 180, y: 120 },
    { x: 300, y: 120 },
    { x: 300, y: 250 },
    { x: 0, y: 250 },
  ];
  const plan = planAreas(
    [{ id: 'notch', name: 'Notch', kind: 'polygon', ring: local.map((p) => frame.toLonLat(p.x, p.y)) }],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  const margin = plan.footprintMarginM;
  assert.ok(margin > 20, 'the notch must be narrower than the margin');
  assert.ok(20 < margin * 2);
  let coveredEdge = false;
  for (const leg of plan.legs) {
    for (const w of leg.waypoints) {
      const p = frame.toXY(w.lon, w.lat);
      const dist = distToRing(p, local);
      assert.ok(
        dist <= margin * Math.SQRT2 + 2,
        `waypoint ${dist.toFixed(1)} m from the ring`,
      );
      if (p.x > 300 && p.x < 300 + margin && p.y > 40 && p.y < 80) coveredEdge = true;
    }
  }
  assert.equal(coveredEdge, true, 'the east edge still gets the footprint margin');
});

test('a rectangle overlapping a polygon is not flown past its own edges', () => {
  const frame = makeFrame(-94.5, 32.7);
  const poly = [
    { x: 0, y: 0 },
    { x: 160, y: 0 },
    { x: 160, y: 160 },
    { x: 0, y: 160 },
  ];
  const rect = {
    west: frame.toLonLat(80, 20).lon,
    east: frame.toLonLat(240, 140).lon,
    south: frame.toLonLat(80, 20).lat,
    north: frame.toLonLat(240, 140).lat,
  };
  const plan = planAreas(
    [
      { id: 'poly', name: 'Poly', kind: 'polygon', ring: poly.map((p) => frame.toLonLat(p.x, p.y)) },
      { id: 'rect', name: 'Rect', kind: 'rect', box: rect },
    ],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.jobs.length, 2);
  const margin = plan.footprintMarginM;
  let onlyPoly = 0;
  let onlyRect = 0;
  for (const leg of plan.legs) {
    for (const w of leg.waypoints) {
      const p = frame.toXY(w.lon, w.lat);
      const inRect = p.x >= 80 - 1 && p.x <= 240 + 1 && p.y >= 20 - 1 && p.y <= 140 + 1;
      if (leg.jobId === 'job-2') {
        assert.ok(inRect, `rectangle job flew ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`);
        if (p.x > 160 + 1) onlyRect += 1;
      }
      if (leg.jobId === 'job-1') {
        assert.ok(
          distToRing(p, poly) <= margin * Math.SQRT2 + 2,
          `polygon job flew ${distToRing(p, poly).toFixed(1)} m outside`,
        );
        if (p.x < 80 - 1) onlyPoly += 1;
      }
    }
  }
  assert.ok(onlyPoly > 0, 'the polygon-only ground must stay in the polygon job');
  assert.ok(onlyRect > 0, 'the rectangle-only ground must stay in the rectangle job');
});

test('the line-of-sight note is measured from the shared takeoff', () => {
  const a = boxAround(-94.5, 32.7, 80, 80);
  const shift = 700 / metersPerDegree(32.7).lon;
  const b = boxAround(-94.5 + shift, 32.7, 80, 80);
  const plan = planAreas(
    [
      { id: 'near', name: 'Near', kind: 'rect', box: a },
      { id: 'far', name: 'Far', kind: 'rect', box: b },
    ],
    { ...opts, takeoff: { lon: -94.5, lat: 32.7 } },
  );
  assert.equal(plan.error, undefined, plan.message);
  const vlos = plan.notes.find((note) => note.code === 'vlos');
  assert.ok(vlos, 'a far area must warn');
  assert.ok(vlos.params.distanceM > 600, `distance ${vlos.params.distanceM}`);
});

test('a polygon whose footprint margin pushes the box past 3 km is refused', () => {
  const frame = makeFrame(-94.5, 32.7);
  const local = [
    { x: 0, y: 0 },
    { x: 2980, y: 0 },
    { x: 2980, y: 40 },
    { x: 0, y: 40 },
  ];
  const plan = planAreas(
    [{ id: 'wide', name: 'Wide', kind: 'polygon', ring: local.map((p) => frame.toLonLat(p.x, p.y)) }],
    opts,
  );
  assert.equal(plan.error, 'too-large', plan.message);
  assert.match(plan.message, /3 km/);
});

test('a separate rectangle starts at the corner nearest the shared takeoff', () => {
  const a = boxAround(-94.5, 32.7, 200, 80);
  const b = boxAround(-94.48, 32.7, 200, 80);
  const m = metersPerDegree(32.7);
  const takeoff = {
    lon: a.east + 15 / m.lon,
    lat: a.north + 15 / m.lat,
  };
  const plan = planAreas(
    [
      { id: 'a', name: 'Near', kind: 'rect', box: a },
      { id: 'b', name: 'Far', kind: 'rect', box: b },
    ],
    { ...opts, takeoff },
  );
  assert.equal(plan.error, undefined, plan.message);
  const near = plan.legs.filter((leg) => leg.jobId === 'job-1');
  assert.ok(near.length > 1, 'the near box should have several lines');
  const start = near[0].waypoints[0];
  const away = groundDistanceM(takeoff, start);
  assert.ok(
    away < 80,
    `first waypoint is ${away.toFixed(1)} m from the shared takeoff; the near corner should start the box`,
  );
});

test('a clipped polygon starts at the corner nearest the shared takeoff', () => {
  const frame = makeFrame(-94.5, 32.7);
  const ring = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 80 },
    { x: 0, y: 80 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  // South-east of the ring. An unturned shell starts at the south-west.
  const takeoff = frame.toLonLat(220, -20);
  const plan = planAreas(
    [{ id: 'p', name: 'Poly', kind: 'polygon', ring }],
    { ...opts, takeoff },
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.clippedToPolygon, true);
  const start = plan.legs[0].waypoints[0];
  const away = groundDistanceM(takeoff, start);
  assert.ok(
    away < 80,
    `first waypoint is ${away.toFixed(1)} m from the shared takeoff; a clipped polygon should start at the near corner`,
  );
});

test('areas planned together start at the corner nearest the shared takeoff', () => {
  const m = metersPerDegree(32.7);
  const west = boxAround(-94.5, 32.7, 160, 80);
  const east = {
    west: west.west + 40 / m.lon,
    east: west.east + 40 / m.lon,
    south: west.south,
    north: west.north,
  };
  const takeoff = {
    lon: east.east + 15 / m.lon,
    lat: east.north + 15 / m.lat,
  };
  const areas = [
    { id: 'a', name: 'West', kind: 'rect', box: west },
    { id: 'b', name: 'East', kind: 'rect', box: east },
  ];
  const whole = planAreas(areas, { ...opts, takeoff, jobGrouping: 'whole' });
  assert.equal(whole.error, undefined, whole.message);
  assert.equal(whole.jobs.length, 1);
  const wholeAway = groundDistanceM(takeoff, whole.legs[0].waypoints[0]);
  assert.ok(
    wholeAway < 80,
    `merged group starts ${wholeAway.toFixed(1)} m from the shared takeoff`,
  );
  const split = planAreas(areas, { ...opts, takeoff });
  assert.equal(split.error, undefined, split.message);
  const nearJob = split.legs.filter((leg) => leg.jobId === 'job-2');
  assert.ok(nearJob.length > 1, 'the eastern area should have several lines');
  const splitAway = groundDistanceM(takeoff, nearJob[0].waypoints[0]);
  assert.ok(
    splitAway < 80,
    `eastern job starts ${splitAway.toFixed(1)} m from the shared takeoff`,
  );
});

test('a clipped line keeps its pieces in travel order when the start turns toward takeoff', () => {
  const frame = makeFrame(-94.5, 32.7);
  // U opening north. East-west lines through the arms are two pieces with a gap.
  const ring = [
    [0, 0],
    [300, 0],
    [300, 200],
    [260, 200],
    [260, 50],
    [40, 50],
    [40, 200],
    [0, 200],
  ].map(([x, y]) => frame.toLonLat(x, y));
  const area = [{ id: 'u', name: 'U', kind: 'polygon', ring }];
  const shared = { ...opts, direction: 'ew' };
  const notch = frame.toLonLat(150, 220);
  const calm = frame.toLonLat(-20, -20);

  function legXY(leg) {
    return {
      a: frame.toXY(leg.waypoints[0].lon, leg.waypoints[0].lat),
      b: frame.toXY(leg.waypoints.at(-1).lon, leg.waypoints.at(-1).lat),
    };
  }
  function transitSum(plan) {
    let sum = 0;
    for (let i = 1; i < plan.legs.length; i += 1) {
      sum += groundDistanceM(
        plan.legs[i - 1].waypoints.at(-1),
        plan.legs[i].waypoints[0],
      );
    }
    return sum;
  }
  function sameLineJumps(plan) {
    const jumps = [];
    for (let i = 1; i < plan.legs.length; i += 1) {
      const prev = legXY(plan.legs[i - 1]);
      const cur = legXY(plan.legs[i]);
      if (Math.abs(prev.a.y - cur.a.y) < 5) {
        jumps.push(
          groundDistanceM(plan.legs[i - 1].waypoints.at(-1), plan.legs[i].waypoints[0]),
        );
      }
    }
    return jumps;
  }
  function assertOrdered(plan, label) {
    assert.equal(plan.error, undefined, plan.message);
    const jumps = sameLineJumps(plan);
    assert.ok(
      jumps.length >= 2,
      `${label} should split a line into pieces, got ${jumps.length}`,
    );
    for (const jump of jumps) {
      assert.ok(
        jump < 120,
        `${label} piece jump ${jump.toFixed(0)} m backtracks along the line`,
      );
    }
    for (const leg of plan.legs) {
      if ((leg.waypoints?.length ?? 0) < 3) continue;
      const { a, b } = legXY(leg);
      const mid = leg.waypoints[Math.floor(leg.waypoints.length / 2)];
      const m = frame.toXY(mid.lon, mid.lat);
      const along = (m.x - a.x) * (b.x - a.x) + (m.y - a.y) * (b.y - a.y);
      assert.ok(along > 0, `${label} line points were reversed`);
    }
  }

  const turned = planAreas(area, { ...shared, takeoff: notch });
  const calmPlan = planAreas(area, { ...shared, takeoff: calm });
  assertOrdered(turned, 'nadir');
  const turnedTransit = transitSum(turned);
  const calmTransit = transitSum(calmPlan);
  // 150 m was only slack so the old backtrack would fail. On this fixture the
  // turned plan is no longer than the unturned one.
  assert.ok(
    turnedTransit <= calmTransit,
    `turned transit ${turnedTransit.toFixed(0)} m is worse than the unturned ${calmTransit.toFixed(0)} m`,
  );

  const tilted = planAreas(area, { ...shared, pattern: 'double', takeoff: notch });
  const tiltedCalm = planAreas(area, { ...shared, pattern: 'double', takeoff: calm });
  assertOrdered(tilted, 'tilted');
  const tiltedTransit = transitSum(tilted);
  const tiltedCalmTransit = transitSum(tiltedCalm);
  assert.ok(
    tiltedTransit <= tiltedCalmTransit,
    `tilted transit ${tiltedTransit.toFixed(0)} m is worse than the unturned ${tiltedCalmTransit.toFixed(0)} m`,
  );
});

test('a clipped corner does not start farther than it does now, and a line does not double back', () => {
  const frame = makeFrame(-94.5, 32.7);
  // Right triangle. The empty corner of the outer box is (200, 200).
  // The first flown point is about 153 m from the takeoff, past that
  // clipped corner. The test only locks the upper bound, so a later
  // closer start is not a failure.
  const ring = [
    [0, 0],
    [200, 0],
    [0, 200],
  ].map(([x, y]) => frame.toLonLat(x, y));
  const empty = frame.toLonLat(200, 200);
  const takeoff = frame.toLonLat(200 + 21, 200 + 21);
  const plan = planAreas(
    [{ id: 'tri', name: 'Tri', kind: 'polygon', ring }],
    { ...opts, direction: 'ew', takeoff },
  );
  assert.equal(plan.error, undefined, plan.message);
  near(groundDistanceM(empty, takeoff), 30, 1, 'empty corner');
  const startAway = groundDistanceM(takeoff, plan.legs[0].waypoints[0]);
  assert.ok(
    startAway <= 155,
    `triangle starts ${startAway.toFixed(1)} m from takeoff`,
  );
  for (const leg of plan.legs) {
    if ((leg.waypoints?.length ?? 0) < 3) continue;
    const a = frame.toXY(leg.waypoints[0].lon, leg.waypoints[0].lat);
    const b = frame.toXY(leg.waypoints.at(-1).lon, leg.waypoints.at(-1).lat);
    const mid = leg.waypoints[Math.floor(leg.waypoints.length / 2)];
    const m = frame.toXY(mid.lon, mid.lat);
    const along = (m.x - a.x) * (b.x - a.x) + (m.y - a.y) * (b.y - a.y);
    // A straight line still has its middle between the ends if it is
    // flown the other way. This only catches a leg that doubles back.
    assert.ok(along > 0, 'line doubles back on itself');
  }
});

test('a polygon with no custom takeoff turns toward the area centre', () => {
  const frame = makeFrame(-94.5, 32.7);
  // Right angle in the north-east, not on the default south-west start.
  // Without the turn the first point is about 336 m from that corner.
  // With the turn it is about 85 m away.
  const ring = [
    [300, 300],
    [0, 300],
    [300, 0],
  ].map(([x, y]) => frame.toLonLat(x, y));
  const plan = planAreas(
    [{ id: 'p', name: 'Poly', kind: 'polygon', ring }],
    { ...opts, direction: 'ew' },
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.takeoff.custom, false);
  const meanLon = ring.reduce((sum, p) => sum + p.lon, 0) / ring.length;
  const meanLat = ring.reduce((sum, p) => sum + p.lat, 0) / ring.length;
  near(plan.takeoff.lon, meanLon, 1e-6, 'centre lon');
  near(plan.takeoff.lat, meanLat, 1e-6, 'centre lat');
  const rightAngle = frame.toLonLat(300, 300);
  const start = plan.legs[0].waypoints[0];
  const toCorner = groundDistanceM(rightAngle, start);
  assert.ok(
    toCorner < 120,
    `start is ${toCorner.toFixed(0)} m from the corner nearest the centre`,
  );
});

test('a polygon after a separate rectangle still marks the whole plan clipped', () => {
  const rect = boxAround(-94.5, 32.7, 140, 100);
  const frame = makeFrame(-94.48, 32.7);
  const ring = [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 90 },
    { x: 0, y: 90 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  const plan = planAreas(
    [
      { id: 'r', name: 'Rect', kind: 'rect', box: rect },
      { id: 'p', name: 'Poly', kind: 'polygon', ring },
    ],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(plan.clippedToPolygon, true);
  assert.ok(
    plan.footprintMarginM > 20 && plan.footprintMarginM < 100,
    `margin ${plan.footprintMarginM}`,
  );
});

test('the reported margin stays finite when height is left out', () => {
  const rect = boxAround(-94.5, 32.7, 140, 100);
  const frame = makeFrame(-94.48, 32.7);
  const ring = [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 90 },
    { x: 0, y: 90 },
  ].map((p) => frame.toLonLat(p.x, p.y));
  const bare = { ...opts };
  delete bare.aglM;
  const areas = [
    { id: 'r', name: 'Rect', kind: 'rect', box: rect },
    { id: 'p', name: 'Poly', kind: 'polygon', ring },
  ];
  const plan = planAreas(areas, bare);
  const only = planAreas([{ id: 'p', name: 'Poly', kind: 'polygon', ring }], bare);
  assert.equal(plan.error, undefined, plan.message);
  assert.equal(only.error, undefined, only.message);
  assert.equal(Number.isFinite(plan.footprintMarginM), true);
  assert.equal(plan.footprintMarginM, only.footprintMarginM);
});

test('an area with no photos of its own is left out of the jobs', () => {
  // The inner box sits inside the outer one, so every photo in the overlap
  // belongs to the first area. The inner bucket is empty and gets no job.
  const outer = boxAround(-94.5, 32.7, 200, 200);
  const inner = boxAround(-94.5, 32.7, 40, 40);
  const plan = planAreas(
    [
      { id: 'outer', name: 'Outer', kind: 'rect', box: outer },
      { id: 'inner', name: 'Inner', kind: 'rect', box: inner },
    ],
    opts,
  );
  assert.equal(plan.error, undefined, plan.message);
  assert.deepEqual(
    plan.areas.map((area) => area.name),
    ['Outer', 'Inner'],
  );
  assert.deepEqual(
    plan.jobs.map((job) => job.name),
    ['Outer'],
  );
  assert.deepEqual(
    plan.blocks.map((block) => block.areaIds),
    [['outer']],
  );
  assert.equal(
    plan.legs.every((leg) => leg.jobId === 'job-1'),
    true,
  );
});

