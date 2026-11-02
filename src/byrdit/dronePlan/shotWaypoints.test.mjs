/**
 * One photo per waypoint (first flight, 2026-11-01): DJI Fly took only the
 * first takePhoto of a waypoint's action group, so a ring stop with an outward
 * photo is two waypoints at one place, and the camera is tilted BEFORE the
 * first photo of a mission.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';
import { buildKmz, buildMissionFiles, readmeText } from './wpml.js';
import { hasOutwardShot, splitOutwardShots } from './shotWaypoints.js';
import { plannedPhotoPoints } from './photoCheck.js';
import { checkMission, parseDjiKmz } from './djiKmz.js';
import { CENTRE, boxAround } from './buildingFixtures.mjs';

const M = metersPerDegree(CENTRE.lat);
const at = (n, e) => ({ lon: CENTRE.lon + e / M.lon, lat: CENTRE.lat + n / M.lat });
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const target = (extra = {}) => ({
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

function ringMission(targets = [target()], box = boxAround(240, 240), options = {}) {
  const p = planFlight(box, {
    pattern: 'orbit',
    presetId: 'dji-mini-4-pro',
    orbitTargets: targets,
    ...options,
  });
  assert.ok(!p.error, String(p.error));
  const ids = p.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const result = assembleMissions(p, { known: true, takeoffM: 100, wpM: ids.map(() => 100) });
  return { plan: p, result };
}

/** Placemarks of a written mission, reduced to what the tests look at. */
function marks(result, mission = result.missions[0]) {
  const { waylinesWpml } = buildMissionFiles(mission, result.plan);
  return waylinesWpml
    .split('<Placemark>')
    .slice(1)
    .map((m) => ({
      text: m,
      where: m.match(/<coordinates>\s*([^<\s]+)/)[1],
      heading: Number(m.match(/<wpml:waypointHeadingAngle>([^<]+)</)[1]),
      pitch: Number(m.match(/<wpml:waypointGimbalPitchAngle>([^<]+)</)[1]),
      photos: (m.match(/<wpml:actionActuatorFunc>takePhoto</g) ?? []).length,
      funcs: [...m.matchAll(/<wpml:actionActuatorFunc>(\w+)</g)].map((x) => x[1]),
    }));
}

test('a ring with N stops is 2N photo waypoints, each with exactly one takePhoto', () => {
  const { plan, result } = ringMission();
  const stops = plan.legs
    .filter((l) => l.kind === 'orbit')
    .reduce((n, l) => n + l.waypoints.length, 0);
  assert.ok(stops >= 12);
  assert.equal(result.missions.length, 1);
  const mission = result.missions[0];
  assert.equal(mission.waypointCount, 2 * stops);
  assert.equal(mission.photoCount, 2 * stops);
  assert.equal(result.totals.waypointCount, 2 * stops);
  const m = marks(result);
  assert.equal(m.length, 2 * stops);
  assert.ok(m.every((x) => x.photos === 1), 'exactly one takePhoto per waypoint');
  assert.equal(m.reduce((n, x) => n + x.photos, 0), 2 * stops);
  assert.ok(m.every((x) => !x.funcs.includes('rotateYaw')));
});

test('inward waypoint faces the target at the ring pitch, outward faces away at the outward pitch', () => {
  const { plan, result } = ringMission();
  const planned = plan.legs.filter((l) => l.kind === 'orbit').flatMap((l) => l.waypoints);
  const m = marks(result);
  planned.forEach((w, s) => {
    const inward = m[2 * s];
    const outward = m[2 * s + 1];
    assert.equal(inward.where, outward.where, 'same place');
    assert.ok(angDiff(inward.heading, w.headingDeg) < 0.06);
    assert.ok(angDiff(outward.heading, w.headingDeg + 180) < 0.2);
    assert.equal(inward.pitch, Math.round(w.pitchDeg * 10) / 10);
    assert.equal(outward.pitch, -5);
    // Both are stops that use the stored heading.
    for (const x of [inward, outward]) {
      assert.ok(x.text.includes('toPointAndStopWithContinuityCurvature'));
      assert.ok(x.text.includes('<wpml:waypointHeadingAngleEnable>1<'));
    }
  });
  const flat = result.missions[0].waypoints;
  flat.forEach((w, i) => {
    if (w.shot === 'in') assert.equal(flat[i + 1].shot, 'out');
    if (w.shot === 'out') assert.equal(flat[i - 1].shot, 'in');
    assert.equal(w.outwardHeadingDeg, undefined, 'no two-photo waypoint is left');
  });
});

test('the camera is tilted before the first photo of the mission and before every outward photo', () => {
  const { plan, result } = ringMission();
  const m = marks(result);
  const ring = plan.legs.find((l) => l.kind === 'orbit').pitchDeg;
  // Waypoint 0: ONE sequence group, tilt first, at the planned pitch.
  assert.deepEqual(m[0].funcs, ['gimbalRotate', 'takePhoto']);
  assert.match(m[0].text, /<wpml:actionGroupMode>sequence</);
  assert.equal(Number(m[0].text.match(/<wpml:gimbalPitchRotateAngle>([^<]+)</)[1]), ring);
  // Outward waypoint: tilt to the outward pitch, then photo, same ordered group.
  assert.deepEqual(m[1].funcs.slice(0, 2), ['gimbalRotate', 'takePhoto']);
  assert.match(m[1].text, /<wpml:actionGroupMode>sequence</);
  assert.equal(Number(m[1].text.match(/<wpml:gimbalPitchRotateAngle>([^<]+)</)[1]), -5);
  // The next inward waypoint is reached with the tilt back to the ring pitch
  // (a gradual tilt written on the outward waypoint).
  assert.deepEqual(m[1].funcs, ['gimbalRotate', 'takePhoto', 'gimbalEvenlyRotate']);
  assert.match(m[1].text, /gimbalEvenlyRotate<\/wpml:actionActuatorFunc>\s*<wpml:actionActuatorFuncParam>\s*<wpml:gimbalPitchRotateAngle>-?\d+(\.\d+)?</);
  // A plain inward waypoint in the middle has just its photo.
  assert.deepEqual(m[2].funcs, ['takePhoto']);
});

test('a plan without outward photos is unchanged: one waypoint per stop, one photo each', () => {
  const { plan, result } = ringMission([target()], boxAround(240, 240), { orbitOutward: false });
  const stops = plan.legs.filter((l) => l.kind === 'orbit').reduce((n, l) => n + l.waypoints.length, 0);
  assert.equal(result.missions[0].waypointCount, stops);
  assert.ok(marks(result).every((x) => x.photos === 1));
});

test('the 200-waypoint limit counts both shots and never cuts between them', () => {
  const targets = Array.from({ length: 12 }, (_, i) =>
    target({ id: `b${i}`, ...at(i * 15, 0), radiusM: 60 }));
  const { result } = ringMission(targets, boxAround(400, 400));
  assert.ok(result.missions.length > 2, 'split into several missions');
  for (const mission of result.missions) {
    assert.ok(mission.waypointCount <= 200, String(mission.waypointCount));
    mission.waypoints.forEach((w, i) => {
      if (w.shot === 'in') assert.equal(mission.waypoints[i + 1]?.shot, 'out', 'a stop stays whole');
    });
    const written = marks(result, mission);
    assert.ok(written.every((x) => x.photos <= 1));
  }
  const photos = result.missions.reduce((n, mission) => n + mission.photoCount, 0);
  assert.equal(photos, result.totals.photoCount);
});

test('flight time grows with the second stop; photo totals match the waypoints', () => {
  const on = ringMission().result;
  const off = ringMission([target()], boxAround(240, 240), { orbitOutward: false }).result;
  const stops = off.missions[0].waypointCount;
  assert.equal(on.totals.photoCount - off.totals.photoCount, stops);
  assert.ok(on.totals.durationS - off.totals.durationS >= stops * 2.4);
  assert.equal(on.totals.photoCount, on.totals.waypointCount);
});

test('photo check expects one photo per waypoint, so 2N for a ring', () => {
  const { result } = ringMission();
  assert.equal(plannedPhotoPoints({ result }).length, result.totals.photoCount);
});

test('the exported ring KMZ passes GEV\'s own check and reads back', async () => {
  const { result } = ringMission();
  const mission = result.missions[0];
  const parsed = await parseDjiKmz(buildKmz(mission, result.plan), { fileName: 'ring.kmz' });
  assert.equal(parsed.waypoints.length, mission.waypointCount);
  assert.deepEqual(checkMission(parsed, { preset: result.plan.preset }), []);
});

test('a hand-built two-photo waypoint is split by the writer, never written as two takePhotos', () => {
  const { plan, result } = ringMission();
  const one = plan.legs.find((l) => l.kind === 'orbit').waypoints.slice(0, 3)
    .map((w, i) => ({ ...w, index: i, relHeightM: 50, groundM: 0 }));
  assert.ok(one.every(hasOutwardShot));
  const mission = { legs: [{ kind: 'orbit', photoMode: 'waypoint', waypoints: one, pitchDeg: one[0].pitchDeg }] };
  mission.waypoints = one;
  const written = marks({ plan: result.plan }, mission);
  assert.equal(written.length, 6);
  assert.ok(written.every((x) => x.photos === 1));
  // Idempotent on its own output.
  assert.deepEqual(splitOutwardShots(splitOutwardShots(one)), splitOutwardShots(one));
});

test('the README lists the doubled waypoint count and says what the camera gives in waypoint mode', () => {
  const { result } = ringMission();
  const text = readmeText(result, new Date('2026-11-01T00:00:00Z'));
  const m = result.missions[0];
  assert.ok(text.includes(`${m.waypointCount} waypoints, ${m.photoCount} photos`));
  assert.match(text, /4096 x 3072 \(12 MP\)/);
});
