/**
 * Every waypoint of a newly exported file states its own speed and its own
 * gimbal pitch, so a mission that is paused and resumed (battery swap, split
 * files, a resume part way down a line) does not depend on a command given at
 * an earlier waypoint.
 *
 * What is written, from DJI's WPML reference (developer.dji.com, Cloud API,
 * waylines.wpml and Common Elements) and the real Mini 5 Pro files in
 * fixtures/djifly-mini5pro:
 *  - `wpml:waypointSpeed` (m/s, float, (0, max]) in EVERY Placemark: "speed of
 *    the drone flying from this waypoint to the next". It was already written
 *    for every waypoint; these tests lock that in for every capture mode.
 *  - a `gimbalRotate` (absoluteAngle, pitch only) action in a reachPoint
 *    group of its own waypoint, for EVERY waypoint. Before, only the first
 *    waypoint of a file and the outward shot of a ring stop had one; every other
 *    waypoint relied on the pitch left by an earlier command.
 *
 * What must NOT change: photo actions and their counts, turn modes, stops,
 * heading, straight-line flags and damping, the per-waypoint
 * waypointGimbalHeadingParam, and anything in template.kml.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleMissions, planFlight } from './planner.js';
import { buildMissionFiles, readmeText } from './wpml.js';
import { parseXml } from './wpmlCompare.mjs';
import { metersPerDegree } from './geo.js';
import { CENTRE, boxAround } from './buildingFixtures.mjs';
import { mphToMs, msToMph } from './timing.js';

const find = (node, name) => node.children.find((c) => c.name === name);
const findAll = (node, name) => node.children.filter((c) => c.name === name);
const leaf = (node, name) => find(node, name)?.text.trim();

/** One waypoint reduced to what these tests compare. */
function readMarks(xml) {
  const doc = parseXml(xml);
  const folder = find(find(doc, 'Document'), 'Folder');
  return findAll(folder, 'Placemark').map((mark) => {
    const groups = findAll(mark, 'wpml:actionGroup').map((g) => ({
      start: Number(leaf(g, 'wpml:actionGroupStartIndex')),
      end: Number(leaf(g, 'wpml:actionGroupEndIndex')),
      mode: leaf(g, 'wpml:actionGroupMode'),
      trigger: leaf(find(g, 'wpml:actionTrigger'), 'wpml:actionTriggerType'),
      param: leaf(find(g, 'wpml:actionTrigger'), 'wpml:actionTriggerParam'),
      actions: findAll(g, 'wpml:action').map((a) => {
        const p = find(a, 'wpml:actionActuatorFuncParam');
        return {
          id: Number(leaf(a, 'wpml:actionId')),
          func: leaf(a, 'wpml:actionActuatorFunc'),
          pitch: leaf(p, 'wpml:gimbalPitchRotateAngle'),
          rotateMode: leaf(p, 'wpml:gimbalRotateMode'),
          pitchEnable: leaf(p, 'wpml:gimbalPitchRotateEnable'),
          yawEnable: leaf(p, 'wpml:gimbalYawRotateEnable'),
          rollEnable: leaf(p, 'wpml:gimbalRollRotateEnable'),
        };
      }),
      id: Number(leaf(g, 'wpml:actionGroupId')),
    }));
    const rest = mark.children
      .filter((c) => c.name !== 'wpml:actionGroup' && c.name !== 'Point')
      .map((c) => `${c.name}:${JSON.stringify(c)}`)
      .join('|');
    return {
      index: Number(leaf(mark, 'wpml:index')),
      speed: leaf(mark, 'wpml:waypointSpeed'),
      turn: leaf(find(mark, 'wpml:waypointTurnParam'), 'wpml:waypointTurnMode'),
      straight: leaf(mark, 'wpml:useStraightLine'),
      pitchParam: leaf(
        find(mark, 'wpml:waypointGimbalHeadingParam'),
        'wpml:waypointGimbalPitchAngle',
      ),
      groups,
      rest,
    };
  });
}

const sigOf = (g, a) =>
  `${g.start}-${g.end}:${g.trigger}:${g.param ?? ''}:${a.func}:${a.pitch ?? ''}`;
const actionsOf = (m) => m.groups.flatMap((g) => g.actions.map((a) => sigOf(g, a)));
const rotatesAt = (m) =>
  m.groups.flatMap((g) =>
    g.start === m.index && g.end === m.index && g.trigger === 'reachPoint'
      ? g.actions.filter((a) => a.func === 'gimbalRotate')
      : [],
  );

const mbox = (() => {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - 200 / m.lon,
    east: -97.77 + 200 / m.lon,
    south: 30.27 - 100 / m.lat,
    north: 30.27 + 100 / m.lat,
  };
})();

function built(box, options) {
  const plan = planFlight(box, { aglM: 100, batteryMin: 60, ...options });
  assert.ok(!plan.error, String(plan.error));
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  return assembleMissions(plan, {
    known: true,
    takeoffM: 100,
    wpM: ids.map((id) => 100 + (id % 5)),
  });
}

const speedText = (ms) => String(Number(ms.toFixed(1)));

const SCENARIOS = [
  ['stop grid', mbox, {}],
  ['stop double grid, 60 deg', mbox, { pattern: 'double', tiltPitchDeg: -60 }],
  ['stop double grid, 45 deg', mbox, { pattern: 'double', tiltPitchDeg: -45 }],
  ['legacy interval photos', mbox, { photoMode: 'interval' }],
  ['distance', mbox, { captureMode: 'distance', photoSpacingM: 25 }],
  ['timed', mbox, { captureMode: 'timed', photoSpacingM: 25 }],
  [
    'timed with a chosen interval',
    mbox,
    { captureMode: 'timed', speedMs: 4, timedIntervalS: 7 },
  ],
  [
    'continuous distance route',
    mbox,
    { captureMode: 'distance', continuousRoute: true, photoSpacingM: 25 },
  ],
  [
    'continuous timed route, capped files',
    boxAround(200, 800),
    { captureMode: 'timed', continuousRoute: true, maxWaypoints: 20 },
  ],
  [
    'stop, split by the waypoint cap',
    boxAround(400, 300),
    { maxWaypoints: 50 },
  ],
  ['orbit', mbox, { pattern: 'orbit', orbitRadiusM: 50, orbitHeightsM: [30, 60] }],
];

for (const [name, box, options] of SCENARIOS) {
  test(`${name}: every waypoint of every file carries the plan speed and an explicit gimbal pitch`, () => {
    const result = built(box, options);
    const speed = speedText(result.plan.speedMs);
    let waypoints = 0;
    for (const mission of result.missions) {
      const { waylinesWpml } = buildMissionFiles(mission, result.plan);
      const marks = readMarks(waylinesWpml);
      assert.equal(marks.length, mission.waypointCount);
      marks.forEach((m, k) => {
        waypoints += 1;
        assert.equal(m.speed, speed, `${name} wp ${k} speed`);
        const rotates = rotatesAt(m);
        assert.ok(rotates.length >= 1, `${name} wp ${k} has its own gimbalRotate`);
        for (const r of rotates) {
          assert.equal(r.rotateMode, 'absoluteAngle');
          assert.equal(r.pitchEnable, '1');
          assert.equal(r.yawEnable, '0', 'pitch only: no yaw');
          assert.equal(r.rollEnable, '0', 'pitch only: no roll');
          assert.equal(r.pitch, m.pitchParam, `${name} wp ${k} rotate = waypoint pitch`);
        }
      });
    }
    assert.ok(waypoints > 2, `${name}: waypoints seen`);
  });
}

for (const [name, box, options] of SCENARIOS) {
  test(`${name}: only gimbal rotates are added; photos, stops, turns, speed and heading are unchanged`, () => {
    const result = built(box, options);
    for (const mission of result.missions) {
      const now = readMarks(buildMissionFiles(mission, result.plan).waylinesWpml);
      const before = readMarks(
        buildMissionFiles(mission, result.plan, {
          explicitWaypointGimbal: false,
        }).waylinesWpml,
      );
      assert.equal(now.length, before.length, 'no new waypoint, so no new stop');
      now.forEach((m, k) => {
        const b = before[k];
        assert.equal(m.rest, b.rest, `wp ${k}: turn, speed, heading, straight line, pitch param unchanged`);
        // Every action that was there is still there, exactly once; the
        // extras are gimbalRotate actions and nothing else.
        const left = [...actionsOf(m)];
        for (const sig of actionsOf(b)) {
          const at = left.indexOf(sig);
          assert.ok(at >= 0, `wp ${k}: lost action ${sig}`);
          left.splice(at, 1);
        }
        assert.ok(
          left.every((sig) => sig.includes(':gimbalRotate:')),
          `wp ${k}: unexpected extra ${left.join(', ')}`,
        );
        assert.ok(left.length <= 1, `wp ${k}: at most one added rotate`);
        const photos = (list) => list.filter((s) => s.includes(':takePhoto:')).length;
        assert.equal(photos(actionsOf(m)), photos(actionsOf(b)), `wp ${k}: photos`);
        assert.ok(photos(actionsOf(m)) <= 1, `wp ${k}: never two photos at one waypoint`);
      });
    }
  });
}

test('a photo waypoint holds the rotate and the photo in one ordered group, rotate first', () => {
  const result = built(mbox, { pattern: 'double', tiltPitchDeg: -60 });
  const marks = readMarks(buildMissionFiles(result.missions[0], result.plan).waylinesWpml);
  let seen = 0;
  for (const m of marks) {
    for (const g of m.groups) {
      const funcs = g.actions.map((a) => a.func);
      if (!funcs.includes('takePhoto')) continue;
      seen += 1;
      assert.equal(g.mode, 'sequence', `wp ${m.index}`);
      assert.deepEqual(funcs, ['gimbalRotate', 'takePhoto'], `wp ${m.index}`);
    }
  }
  assert.ok(seen > 4);
});

test('timed capture still writes no photo action, distance still one group per line', () => {
  const timed = built(mbox, { captureMode: 'timed', photoSpacingM: 25 });
  const xml = buildMissionFiles(timed.missions[0], timed.plan).waylinesWpml;
  assert.equal(xml.includes('takePhoto'), false);
  assert.equal(xml.includes('multipleTiming'), false);
  const distance = built(mbox, { captureMode: 'distance', photoSpacingM: 25 });
  const marks = readMarks(
    buildMissionFiles(distance.missions[0], distance.plan).waylinesWpml,
  );
  const groups = marks.flatMap((m) => m.groups).filter((g) => g.trigger === 'multipleDistance');
  assert.equal(groups.length, distance.missions[0].legs.length);
});

test('action ids are unique across the file and group ids are unique inside a waypoint', () => {
  for (const [name, box, options] of SCENARIOS) {
    const result = built(box, options);
    for (const mission of result.missions) {
      const marks = readMarks(buildMissionFiles(mission, result.plan).waylinesWpml);
      const ids = marks.flatMap((m) => m.groups.flatMap((g) => g.actions.map((a) => a.id)));
      assert.equal(new Set(ids).size, ids.length, `${name}: action ids`);
      for (const m of marks) {
        const gids = m.groups.map((g) => g.id);
        assert.equal(new Set(gids).size, gids.length, `${name} wp ${m.index}: group ids`);
        assert.ok(gids.every((g) => g >= 1));
      }
    }
  }
});

test('a gradual tilt between legs still ends on the pitch the next waypoint states', () => {
  const result = built(mbox, { pattern: 'double', tiltPitchDeg: -60 });
  const marks = readMarks(buildMissionFiles(result.missions[0], result.plan).waylinesWpml);
  for (const m of marks) {
    for (const g of m.groups) {
      for (const a of g.actions) {
        if (a.func !== 'gimbalEvenlyRotate') continue;
        const target = marks.find((x) => x.index === g.end);
        assert.equal(a.pitch, target.pitchParam, 'the tilt target is the next waypoint pitch');
        assert.equal(rotatesAt(target)[0].pitch, target.pitchParam);
      }
    }
  }
});

test('per-pass angles are kept: nadir is -90, a 60 deg oblique pass is -60, a 45 deg pass is -45', () => {
  for (const [options, pitch] of [
    [{}, '-90'],
    [{ pattern: 'double', tiltPitchDeg: -60 }, '-60'],
    [{ pattern: 'double', tiltPitchDeg: -45 }, '-45'],
  ]) {
    const result = built(mbox, options);
    const marks = readMarks(buildMissionFiles(result.missions[0], result.plan).waylinesWpml);
    assert.ok(
      marks.every((m) => rotatesAt(m).every((r) => r.pitch === pitch)),
      `pitch ${pitch}`,
    );
  }
});

test('ring stops: the inward waypoint holds the ring pitch and the outward waypoint its own outward pitch', () => {
  const target = {
    id: 'b1',
    lon: CENTRE.lon,
    lat: CENTRE.lat,
    label: 'Hall',
    source: 'building',
    active: true,
    heightM: 6,
    roofHeightM: 12,
    radiusM: 30,
  };
  const result = built(boxAround(240, 240), {
    pattern: 'orbit',
    presetId: 'dji-mini-4-pro',
    orbitTargets: [target],
  });
  const marks = readMarks(buildMissionFiles(result.missions[0], result.plan).waylinesWpml);
  const pitches = new Set();
  for (const m of marks) {
    const own = rotatesAt(m);
    assert.equal(own.length, 1, `wp ${m.index}: exactly one own rotate`);
    assert.equal(own[0].pitch, m.pitchParam);
    pitches.add(own[0].pitch);
  }
  assert.ok(pitches.size >= 2, 'inward ring pitch and outward pitch are both written');
  const photos = marks.map((m) => actionsOf(m).filter((s) => s.includes(':takePhoto:')).length);
  assert.ok(photos.every((n) => n === 1), 'one photo per ring waypoint, none added');
});

test('a look-at path writes each waypoint own pitch, not one pitch for the whole path', () => {
  const m = metersPerDegree(CENTRE.lat);
  const at = (n, e) => ({ lon: CENTRE.lon + e / m.lon, lat: CENTRE.lat + n / m.lat });
  const result = built(boxAround(300, 300), {
    pattern: 'orbit',
    presetId: 'dji-mini-4-pro',
    orbitTargets: [
      { id: 't1', ...at(0, 0), label: 'Hall', source: 'custom', active: true, heightM: 4 },
    ],
    lookAtPaths: [
      {
        id: 'p1',
        label: 'Road',
        active: true,
        targetId: 't1',
        aglM: 40,
        points: [at(-80, -60), at(-80, 60), at(-60, 120)],
      },
    ],
  });
  const marks = readMarks(buildMissionFiles(result.missions[0], result.plan).waylinesWpml);
  assert.ok(marks.length > 3);
  for (const mark of marks) {
    for (const r of rotatesAt(mark)) assert.equal(r.pitch, mark.pitchParam);
  }
  const distinct = new Set(marks.map((x) => x.pitchParam));
  assert.ok(distinct.size > 1, 'the path has more than one pitch');
});

test('template.kml is unchanged and no global gimbal or speed element is added', () => {
  const result = built(mbox, { captureMode: 'timed', speedMs: 4, timedIntervalS: 7 });
  const now = buildMissionFiles(result.missions[0], result.plan, { createdMs: 1 });
  const before = buildMissionFiles(result.missions[0], result.plan, {
    createdMs: 1,
    explicitWaypointGimbal: false,
  });
  assert.equal(now.templateKml, before.templateKml);
  for (const xml of [now.templateKml, now.waylinesWpml]) {
    assert.doesNotMatch(xml, /globalWaypoint|gimbalPitchMode|useGlobalSpeed|startActionGroup/);
  }
  assert.match(now.waylinesWpml, /<wpml:autoFlightSpeed>2\.5</);
});

test('a battery-split file and a resumed second file each open with speed and pitch of their own', () => {
  const result = built(boxAround(400, 300), { batteryMin: 5, maxWaypoints: 200 });
  assert.ok(result.missions.length > 1, 'split into several files');
  for (const mission of result.missions) {
    const marks = readMarks(buildMissionFiles(mission, result.plan).waylinesWpml);
    assert.equal(marks[0].speed, speedText(result.plan.speedMs));
    assert.ok(rotatesAt(marks[0]).length >= 1);
    assert.equal(rotatesAt(marks.at(-1)).length >= 1, true, 'and the last waypoint too');
  }
});

test('requested 15 and 16 mph reach the file as 6.7 and 7.2 m/s on every waypoint of timed and distance files', () => {
  // 15 mph = 6.7056 m/s, 16 mph = 7.15264 m/s. The file keeps one decimal
  // (6.7 m/s = 14.99 mph, 7.2 m/s = 16.11 mph), DJI Fly's own precision.
  for (const [mph, text] of [
    [15, '6.7'],
    [16, '7.2'],
    [10.5, '4.7'],
  ]) {
    for (const captureMode of ['timed', 'distance']) {
      const result = built(mbox, {
        captureMode,
        photoSpacingM: 25,
        speedMs: mphToMs(mph),
      });
      assert.equal(result.plan.speedMs, mphToMs(mph), 'no silent reduction');
      const marks = readMarks(buildMissionFiles(result.missions[0], result.plan).waylinesWpml);
      assert.ok(marks.every((m) => m.speed === text), `${mph} mph ${captureMode}`);
      assert.ok(Math.abs(msToMph(Number(text)) - mph) < 0.15, 'file speed within 0.15 mph');
    }
  }
});

test('the README gives the plan speed in m/s and mph, and says what each waypoint carries', () => {
  const result = built(mbox, {
    captureMode: 'timed',
    speedMs: mphToMs(15),
    photoSpacingM: 25,
  });
  const readme = readmeText(result);
  assert.match(readme, /Speed: 6\.7 m\/s \(15\.0 mph\)/);
  assert.match(
    readme,
    /Every waypoint states the plan speed and its own gimbal pitch/,
  );
  assert.match(readme, /not verified in DJI Fly/i);
});

test('an unusable plan speed stops the export instead of writing NaN or 0', () => {
  const result = built(mbox, {});
  for (const bad of [0, -1, NaN, undefined, null, 'x']) {
    assert.throws(
      () => buildMissionFiles(result.missions[0], { ...result.plan, speedMs: bad }),
      /plan speed/i,
      String(bad),
    );
  }
});
