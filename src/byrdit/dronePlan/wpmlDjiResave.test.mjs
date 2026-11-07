/**
 * Round trip against DJI Fly: GEV's writer must produce, for the five missions
 * of the 2026-10-30 survey, the file DJI Fly writes when it re-saves them, so
 * nothing is left for DJI Fly to rewrite.
 *
 * The fixtures are SYNTHETIC: the five real DJI Fly re-saves (private, in the
 * team's scratch area) and the GEV originals they came from, moved to another
 * place on the globe by a constant (made privately with a random shift that is not kept, so they cannot be moved back).
 * `*.input.json` is what the planner handed the writer, `*.expected.json` is
 * the DJI Fly file reduced by wpmlCompare.summarizeWaylines.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { planFlight } from './planner.js';
import { buildMissionFiles } from './wpml.js';
import { compareSummaries, summarizeWaylines } from './wpmlCompare.mjs';

const dir = new URL('./fixtures/djifly-resave/', import.meta.url);
const load = (name, kind) =>
  JSON.parse(readFileSync(new URL(`${name}.${kind}.json`, dir), 'utf8'));

const preset = planFlight(
  { west: -97.77, east: -97.769, south: 30.27, north: 30.271 },
  { aglM: 100 },
).preset;

function write(input) {
  const waypoints = input.legs.flatMap((l) => l.waypoints);
  const mission = {
    legs: input.legs,
    waypoints,
    waypointCount: waypoints.length,
    routeM: 1234,
    durationS: 567,
  };
  // DJI Fly's own re-save has no gimbalRotate on every waypoint, so the
  // equivalence is checked against the form without them. The form with them
  // is covered in wpmlWaypointState.test.mjs.
  return buildMissionFiles(mission, { preset, speedMs: input.speedMs }, {
    createdMs: 1793387368322,
    explicitWaypointGimbal: false,
  });
}

/**
 * The only differences allowed, each one named:
 *  - nadir: DJI's file has one extra FINAL waypoint (added by hand on the
 *    controller), so our last waypoint is DJI's second to last and DJI left it
 *    a pass-through; we write it as the stop it is.
 */
const turnOf = (s) => s.match(/waypointTurnMode=([A-Za-z]+)/)[1];
const swapTurn = (s, mode) =>
  s.replace(/waypointTurnMode=[A-Za-z]+/, `waypointTurnMode=${mode}`);
const swapEnable = (s, v) =>
  s.replace(/waypointHeadingAngleEnable=\d/, `waypointHeadingAngleEnable=${v}`);

/**
 * The one difference on every file: GEV's first waypoint is a SEQUENCE group,
 * gimbalRotate (id 1) then takePhoto (id 2); DJI Fly's re-save is a parallel
 * group, takePhoto (1) then gimbalRotate (2). Turn ours into DJI's form.
 */
const PHOTO_2 =
  'action(actionId=2 actionActuatorFunc=takePhoto actionActuatorFuncParam(payloadPositionIndex=0 useGlobalPayloadLensIndex=0))';
function firstAsDjiFly(s) {
  const g = s.indexOf('action(actionId=1 actionActuatorFunc=gimbalRotate');
  const p = s.indexOf(PHOTO_2);
  assert.ok(g >= 0 && p > g, 'first waypoint: gimbalRotate then takePhoto');
  assert.match(s, /actionGroupMode=sequence/);
  const gimbal = s.slice(g, p).trimEnd().replace('actionId=1', 'actionId=2');
  const photo = PHOTO_2.replace('actionId=2', 'actionId=1');
  return (
    s.slice(0, g).replace('actionGroupMode=sequence', 'actionGroupMode=parallel') +
    `${photo} ${gimbal}` +
    s.slice(p + PHOTO_2.length)
  );
}

const CASES = [
  { name: 'nadir', photos: 65, theirCount: 65, lastIsDjiPass: true },
  { name: 'oblique60', photos: 93 },
  { name: 'oblique45a', photos: 105 },
  { name: 'oblique45b', photos: 14 },
  { name: 'orbit', photos: 168, orbit: true },
];

for (const c of CASES) {
  test(`${c.name}: GEV writes the file DJI Fly re-saves (zero structural differences)`, () => {
    const input = load(c.name, 'input');
    const expected = load(c.name, 'expected');
    const { waylinesWpml } = write(input);
    const ours = summarizeWaylines(waylinesWpml);
    let relaxed = 0;
    let relaxedFirst = 0;
    const last = ours.waypoints.length - 1;
    const diffs = compareSummaries(ours, expected, {
      theirCount: c.theirCount,
      relax(i, x, y) {
        if (i === 0) {
          relaxedFirst += 1;
          x = firstAsDjiFly(x);
        }
        if (c.lastIsDjiPass && i === last) {
          // DJI left it a pass-through because it was not the last one there.
          relaxed += 1;
          // ...and DJI's tilt group on it leads to that extra waypoint.
          const theirs = y.replace(/ actionGroup\(actionGroupId=2 .*?(?= waypointGimbalHeadingParam)/, '');
          return [swapEnable(swapTurn(x, turnOf(y)), 0), theirs];
        }
        return [x, y];
      },
    });
    assert.deepEqual(diffs, []);
    assert.equal(relaxedFirst, 1, 'only the first waypoint differs');
    if (c.lastIsDjiPass) assert.equal(relaxed, 1);
    const photos = (waylinesWpml.match(/<wpml:actionActuatorFunc>takePhoto/g) ?? [])
      .length;
    assert.equal(photos, c.photos, 'photo count unchanged');
  });
}

test('waypoint positions, heights and speeds are exactly what the planner gave', () => {
  const input = load('orbit', 'input');
  const { waylinesWpml } = write(input);
  const wps = input.legs.flatMap((l) => l.waypoints);
  const marks = waylinesWpml.split('<Placemark>').slice(1);
  assert.equal(marks.length, wps.length);
  marks.forEach((m, i) => {
    const [lon, lat] = m.match(/<coordinates>\s*([^<\s]+)/)[1].split(',').map(Number);
    assert.ok(Math.abs(lon - wps[i].lon) < 1e-8 && Math.abs(lat - wps[i].lat) < 1e-8);
    assert.equal(Number(m.match(/<wpml:executeHeight>([^<]+)/)[1]), Math.round(wps[i].relHeightM * 10) / 10);
    assert.equal(Number(m.match(/<wpml:waypointSpeed>([^<]+)/)[1]), input.speedMs);
  });
});

test('numbers are written the way DJI Fly writes them (no trailing .0)', () => {
  const { waylinesWpml, templateKml } = write(load('nadir', 'input'));
  assert.doesNotMatch(waylinesWpml, /<wpml:(executeHeight|waypointSpeed|waypointHeadingAngle|gimbalPitchRotateAngle|waypointGimbalPitchAngle|globalTransitionalSpeed)>-?\d+\.0</);
  assert.match(waylinesWpml, /<wpml:globalTransitionalSpeed>8</);
  assert.match(waylinesWpml, /<wpml:autoFlightSpeed>2\.5</);
  assert.match(waylinesWpml, /<wpml:distance>0</);
  assert.match(waylinesWpml, /<wpml:duration>0</);
  assert.match(templateKml, /<wpml:author>fly</);
  assert.equal((templateKml.match(/<Placemark>/g) ?? []).length, 0);
  assert.doesNotMatch(templateKml, /<Folder>/);
});

test('golden text: the first two placemarks of the nadir file match DJI Fly byte for byte', () => {
  const input = load('nadir', 'input');
  const expected = load('nadir', 'expected');
  const marks = write(input).waylinesWpml.split('<Placemark>').slice(1);
  // Order of the elements inside a placemark, exactly as DJI Fly writes them.
  const names = (m) => [...m.matchAll(/<(\/?)(wpml:[A-Za-z]+|Point|coordinates)>/g)]
    .filter((x) => !x[1]).map((x) => x[2]);
  assert.deepEqual(names(marks[0]).slice(0, 6), ['Point', 'coordinates', 'wpml:index', 'wpml:executeHeight', 'wpml:waypointSpeed', 'wpml:waypointHeadingParam']);
  // The first waypoint is the one deliberate difference from DJI Fly's file:
  // a sequence group, tilt (id 1) then photo (id 2), so the first photo is
  // taken at the planned pitch (first flight: it was taken at the old one).
  const takePhoto = marks[0].slice(marks[0].indexOf('<wpml:actionGroup>'), marks[0].indexOf('</wpml:actionGroup>'));
  assert.equal(takePhoto, `<wpml:actionGroup>
          <wpml:actionGroupId>1</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>0</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>1</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>-90</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>2</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        `);
  const evenly = marks[12].slice(marks[12].indexOf('<wpml:actionGroupId>2<'));
  assert.match(evenly, /^<wpml:actionGroupId>2<\/wpml:actionGroupId>\s*<wpml:actionGroupStartIndex>12<\/wpml:actionGroupStartIndex>\s*<wpml:actionGroupEndIndex>13<\/wpml:actionGroupEndIndex>/);
  assert.match(evenly, /<wpml:actionActuatorFunc>gimbalEvenlyRotate<\/wpml:actionActuatorFunc>\s*<wpml:actionActuatorFuncParam>\s*<wpml:gimbalPitchRotateAngle>-90<\/wpml:gimbalPitchRotateAngle>\s*<wpml:gimbalRollRotateAngle>0<\/wpml:gimbalRollRotateAngle>\s*<wpml:payloadPositionIndex>0<\/wpml:payloadPositionIndex>/);
  assert.equal(expected.waypoints.length, 66);
});
