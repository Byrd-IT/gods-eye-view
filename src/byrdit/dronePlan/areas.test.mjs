import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleAreaPlan, distanceToAreasM, jobSlug, planAreas } from './areas.js';
import { makeFrame, metersPerDegree } from './geo.js';
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

