// Photo stations of an imported mission, for the 3D check. The KMZ files are
// built here in the shape the GEV writer and DJI Fly use (synthetic
// coordinates), then read with the real parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDjiKmz, distanceM } from './djiKmz.js';
import { east, group, kmz, mark, LAT, LON } from './importKmzFixture.mjs';
import { deriveImportShots, importCheckMission } from './importShots.js';
import { openDroneFile } from './importFile.js';
import { serializePlan } from './planDoc.js';

const parse = (marks) => parseDjiKmz(kmz(marks), { fileName: 'x.kmz' });

test('point photos: one station per takePhoto waypoint, pitch and heading from the waypoint', async () => {
  const m = await parse([
    mark(0, east(0), LAT, {
      mode: 'smoothTransition',
      angle: 180,
      enable: 1,
      pitch: -56.9,
      groups: group(1, 0, 0, 'reachPoint'),
    }),
    mark(1, east(10), LAT, {
      mode: 'smoothTransition',
      angle: -175,
      enable: 1,
      pitch: -30,
      groups: group(2, 1, 1, 'reachPoint'),
    }),
    mark(2, east(20), LAT, { pitch: -30 }),
  ]);
  const s = deriveImportShots(m);
  assert.equal(s.path.length, 3);
  assert.equal(s.stations.length, 2);
  assert.equal(s.photoActions, 2);
  assert.deepEqual(
    s.path.map((p) => p.photo),
    [true, true, false],
  );
  assert.equal(s.stations[0].pitchDeg, -56.9);
  assert.equal(s.stations[0].headingDeg, 180);
  assert.equal(s.stations[1].headingDeg, 185, '-175 is 185 from north');
  assert.equal(s.stations[1].pitchDeg, -30);
  assert.equal(s.stations[0].heightM, 60);
});

test('distance interval: stations every N m along the legs, facing the way it flies', async () => {
  const m = await parse([
    mark(0, east(0), LAT, { groups: group(1, 0, 1, 'multipleDistance', 12) }),
    mark(1, east(120), LAT),
  ]);
  const s = deriveImportShots(m);
  // 0, 12, ... 120 m: eleven stations, plus the two waypoints themselves.
  assert.equal(s.stations.length, 11);
  assert.equal(s.path.length, 13);
  assert.equal(
    s.path[0].photo,
    false,
    'the leg end points are not photo spots',
  );
  assert.ok(Math.abs(distanceM(s.stations[0], s.stations[1]) - 12) < 0.05);
  assert.ok(
    s.stations.every((p) => Math.abs(p.headingDeg - 90) < 0.01),
    'follows the wayline, east',
  );
  assert.ok(s.stations.every((p) => p.pitchDeg === -55 && p.heightM === 60));
  // Stations are on the straight leg and in order: east only, north unchanged.
  assert.ok(
    s.stations.every((p, i) => i === 0 || p.lon > s.stations[i - 1].lon),
  );
  assert.ok(s.stations.every((p) => Math.abs(p.lat - LAT) < 1e-7));
});

test('distance interval across several legs keeps the spacing round corners', async () => {
  const m = await parse([
    mark(0, east(0), LAT, { groups: group(1, 0, 2, 'multipleDistance', 50) }),
    mark(1, east(100), LAT),
    mark(2, east(100), LAT + 105 / 110850),
  ]);
  const s = deriveImportShots(m);
  assert.equal(s.stations.length, 5, '0, 50, 100, 150, 200 m');
  const last = s.stations.at(-1);
  assert.ok(
    Math.abs(last.headingDeg - 0) < 0.01 ||
      Math.abs(last.headingDeg - 360) < 0.01,
    'north on the second leg',
  );
});

test('timing interval: speed x seconds apart; speed of the first waypoint, else the file speed', async () => {
  const m = await parse([
    mark(0, east(0), LAT, {
      speed: 3,
      groups: group(1, 0, 1, 'multipleTiming', 4),
    }),
    mark(1, east(120), LAT, { speed: 3 }),
  ]);
  const s = deriveImportShots(m);
  // 12 m apart: 0..120 m is eleven stations.
  assert.equal(s.stations.length, 11);
  assert.ok(Math.abs(distanceM(s.stations[0], s.stations[1]) - 12) < 0.05);
});

test('a file with no photo action has no stations and says nothing is invented', async () => {
  const m = await parse([
    mark(0, east(0), LAT, {
      groups: group(1, 0, 0, 'reachPoint', undefined, 'gimbalRotate'),
    }),
    mark(1, east(50), LAT),
  ]);
  const s = deriveImportShots(m);
  assert.equal(s.stations.length, 0);
  assert.equal(s.photoActions, 0);
  assert.equal(s.path.length, 2);
  assert.deepEqual(deriveImportShots({ waypoints: [] }), {
    path: [],
    stations: [],
    photoActions: 0,
  });
  assert.deepEqual(deriveImportShots(null), {
    path: [],
    stations: [],
    photoActions: 0,
  });
});

test('an interval group without a usable spacing gives no stations', async () => {
  const m = await parse([
    mark(0, east(0), LAT, { groups: group(1, 0, 1, 'multipleDistance', 0) }),
    mark(1, east(50), LAT),
  ]);
  assert.equal(deriveImportShots(m).stations.length, 0);
});

test('towardPOI faces the point; a fixed heading is used as written', async () => {
  const m = await parse([
    mark(0, east(0), LAT, {
      mode: 'towardPOI',
      poi: `${LAT + 0.001},${LON},0`,
      groups: group(1, 0, 0, 'reachPoint'),
    }),
    mark(1, east(20), LAT, {
      mode: 'fixed',
      angle: -90,
      enable: 1,
      groups: group(2, 1, 1, 'reachPoint'),
    }),
  ]);
  const s = deriveImportShots(m);
  assert.ok(Math.abs(s.stations[0].headingDeg - 0) < 0.01, 'POI is due north');
  assert.equal(s.stations[1].headingDeg, 270);
});

test('gimbalRotate action pitch is used when the waypoint has no pitch field', () => {
  const m = {
    waypoints: [
      {
        index: 0,
        lon: LON,
        lat: LAT,
        heightM: 40,
        speedMs: 2,
        heading: { mode: 'followWayline' },
        gimbalPitchDeg: null,
        groups: [
          {
            id: 1,
            start: 0,
            end: 0,
            trigger: 'reachPoint',
            actions: [
              {
                func: 'gimbalRotate',
                params: {
                  gimbalPitchRotateEnable: '1',
                  gimbalPitchRotateAngle: '-33',
                },
              },
            ],
          },
          {
            id: 2,
            start: 0,
            end: 0,
            trigger: 'reachPoint',
            actions: [{ func: 'takePhoto', params: {} }],
          },
        ],
      },
      {
        index: 1,
        lon: east(10),
        lat: LAT,
        heightM: 40,
        speedMs: 2,
        heading: { mode: 'followWayline' },
        gimbalPitchDeg: null,
        groups: [],
      },
    ],
  };
  assert.equal(deriveImportShots(m).stations[0].pitchDeg, -33);
  m.waypoints[0].groups.shift();
  assert.equal(
    deriveImportShots(m).stations[0].pitchDeg,
    -90,
    'nothing set: straight down',
  );
});

test('importCheckMission: height above the ground under each station, flat when terrain is unknown', async () => {
  const m = await parse([
    mark(0, east(0), LAT, { h: 50, groups: group(1, 0, 0, 'reachPoint') }),
    mark(1, east(10), LAT, { h: 50, groups: group(2, 1, 1, 'reachPoint') }),
  ]);
  const s = deriveImportShots(m);
  const flat = importCheckMission(s, null);
  assert.deepEqual(
    flat.waypoints.map((w) => [w.groundM, w.aglM]),
    [
      [0, 50],
      [0, 50],
    ],
  );
  const hilly = importCheckMission(s, {
    known: true,
    takeoffM: 100,
    wpM: [100, 110],
  });
  assert.deepEqual(
    hilly.waypoints.map((w) => [w.groundM, w.aglM]),
    [
      [100, 50],
      [110, 40],
    ],
  );
  const high = importCheckMission(s, {
    known: true,
    takeoffM: 100,
    wpM: [100, 200],
  });
  assert.equal(high.waypoints[1].aglM, 0, 'never below the ground');
  assert.ok(
    hilly.waypoints.every(
      (w) => w.photo === true && Number.isFinite(w.headingDeg),
    ),
  );
});

test('openDroneFile keeps the stations on the import without changing its stored shape', async () => {
  const bytes = kmz([
    mark(0, east(0), LAT, { groups: group(1, 0, 0, 'reachPoint') }),
    mark(1, east(10), LAT, { groups: group(2, 1, 1, 'reachPoint') }),
  ]);
  const out = await openDroneFile(bytes, 'x.kmz');
  assert.equal(out.kind, 'mission');
  assert.equal(out.item.shots.stations.length, 2);
  assert.deepEqual(Object.keys(out.item.waypoints[0]).sort(), [
    'headingMode',
    'heightM',
    'lat',
    'lon',
    'poi',
    'speedMs',
  ]);
  const none = await openDroneFile(
    kmz([mark(0, east(0), LAT), mark(1, east(5), LAT)]),
    'y.kmz',
  );
  assert.equal(none.item.shots.stations.length, 0);
});

test('the stored plan does not carry the stations (plan document unchanged)', async () => {
  const out = await openDroneFile(
    kmz([
      mark(0, east(0), LAT, { groups: group(1, 0, 0, 'reachPoint') }),
      mark(1, east(10), LAT),
    ]),
    'x.kmz',
  );
  const doc = serializePlan(
    {
      areas: [],
      options: {},
      wpml: {},
      suite: { passes: [] },
      suiteHidden: new Set(),
    },
    { imports: [out.item] },
  );
  assert.equal(doc.imports.length, 1);
  assert.equal(JSON.stringify(doc).includes('shots'), false);
  assert.equal(JSON.stringify(doc).includes('headingDeg'), false);
});
