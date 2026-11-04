import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFrame } from './geo.js';
import {
  MATCH_PROXIMITY_M,
  matchPhotosToShots,
  matchPlanPhotos,
} from './photoQualityMatch.js';

const HERE = { lat: 33.1, lon: -96.2 };
const frame = makeFrame(HERE.lon, HERE.lat);
const at = (x, y) => frame.toLonLat(x, y);

const shotAt = (x, y, extra = {}) => ({
  ...at(x, y),
  waypointId: extra.waypointId ?? 1,
  shot: extra.shot ?? null,
  mission: extra.mission ?? 0,
  leg: extra.leg ?? 0,
  pass: extra.pass ?? 'a',
  pitchDeg: -55,
  headingDeg: 90,
  aglM: 60,
  relHeightM: 60,
  ...extra,
});

const photoAt = (x, y, i, extra = {}) => ({
  name: `DJI_${String(i).padStart(4, '0')}.JPG`,
  ...at(x, y),
  gimbalPitchDeg: -55,
  gimbalYawDeg: 90,
  ...extra,
});

test('a photo within 1.5 m matches one planned shot and keeps waypoint identity', () => {
  assert.equal(MATCH_PROXIMITY_M, 1.5);
  const shots = [
    shotAt(0, 0, { waypointId: 7, shot: 'in', mission: 2, leg: 4 }),
  ];
  const photos = [photoAt(1.2, 0.4, 1)];
  const report = matchPhotosToShots(photos, shots);

  assert.equal(report.matches.length, 1);
  assert.equal(report.missing.length, 0);
  assert.equal(report.summary.matchedCount, 1);
  const match = report.matches[0];
  assert.equal(match.photoIndex, 0);
  assert.equal(match.photoName, 'DJI_0001.JPG');
  assert.equal(match.waypointId, 7);
  assert.equal(match.shot, 'in');
  assert.equal(match.mission, 2);
  assert.equal(match.leg, 4);
  assert.equal(match.pass, 'a');
  assert.ok(match.offsetM <= 1.5);
  assert.ok(match.offsetM > 1);
  assert.equal(report.shots[0].status, 'matched');
  assert.equal(report.shots[0].key.includes('w7'), true);
});

test('a photo past 1.5 m is not a match, and one photo covers only one shot', () => {
  const shots = [
    shotAt(0, 0, { waypointId: 1 }),
    shotAt(1.2, 0, { waypointId: 2 }),
  ];
  const tooFar = matchPhotosToShots([photoAt(1.6, 0, 1)], [shots[0]]);
  assert.equal(tooFar.matches.length, 0);
  assert.equal(tooFar.missing.length, 1);
  assert.equal(tooFar.missing[0].waypointId, 1);
  assert.equal(tooFar.shots[0].status, 'missing');

  const between = matchPhotosToShots([photoAt(0.4, 0, 1)], shots);
  assert.equal(between.summary.matchedCount, 1);
  assert.equal(between.summary.missingCount, 1);
  assert.equal(between.matches[0].waypointId, 1);
  assert.equal(between.missing[0].waypointId, 2);
});

test('one-to-one covers both shots when the closest pair would hide the only photo that reaches the second', () => {
  // Greedy closest-first assigns P to A (0.1 m) and leaves B bare.
  // Q can cover A; P is the only photo within 1.5 m of B.
  const shots = [
    shotAt(0, 0, { waypointId: 1 }),
    shotAt(1.2, 0, { waypointId: 2 }),
  ];
  const photos = [photoAt(0.1, 0, 1), photoAt(-0.4, 0, 2)];
  const report = matchPhotosToShots(photos, shots);
  assert.equal(report.summary.matchedCount, 2);
  assert.equal(report.missing.length, 0);
  const byShot = new Map(
    report.matches.map((m) => [m.waypointId, m.photoName]),
  );
  assert.equal(byShot.get(2), 'DJI_0001.JPG');
  assert.equal(byShot.get(1), 'DJI_0002.JPG');
});

test('co-located shots with different planned pitch and heading match the photo that agrees, not the closer file', () => {
  const shots = [
    shotAt(0, 0, {
      waypointId: 7,
      shot: 'in',
      pitchDeg: -37.5,
      headingDeg: 0,
    }),
    shotAt(0, 0, {
      waypointId: 7,
      shot: 'out',
      pitchDeg: -30,
      headingDeg: 180,
    }),
  ];
  const photos = [
    photoAt(0.1, 0, 1, { gimbalPitchDeg: -30, gimbalYawDeg: 178 }),
    photoAt(0.4, 0, 2, { gimbalPitchDeg: -37.6, gimbalYawDeg: 3 }),
  ];
  const report = matchPhotosToShots(photos, shots);
  assert.equal(report.summary.matchedCount, 2);
  assert.equal(report.missing.length, 0);
  const byShot = Object.fromEntries(
    report.matches.map((m) => [m.shot, m.photoName]),
  );
  assert.equal(byShot.in, 'DJI_0002.JPG');
  assert.equal(byShot.out, 'DJI_0001.JPG');
  assert.equal(new Set(report.matches.map((m) => m.waypointId)).size, 1);
  assert.equal(new Set(report.shots.map((s) => s.key)).size, 2);
});

test('a co-located pair is unknown when the photo has no pitch or heading, and null is not zero', () => {
  const shots = [
    shotAt(0, 0, { waypointId: 7, shot: 'in', pitchDeg: -37.5, headingDeg: 0 }),
    shotAt(0, 0, {
      waypointId: 7,
      shot: 'out',
      pitchDeg: -30,
      headingDeg: 180,
    }),
  ];
  const blank = matchPhotosToShots(
    [photoAt(0.2, 0, 1, { gimbalPitchDeg: null, gimbalYawDeg: null })],
    shots,
  );
  assert.equal(blank.matches.length, 0);
  assert.equal(blank.missing.length, 0);
  assert.equal(blank.retakes.length, 0);
  assert.equal(
    blank.shots.every((s) => s.status === 'unknown'),
    true,
  );
  assert.equal(
    blank.unknown.some(
      (row) => row.kind === 'photo' && row.reason === 'attitude-unknown',
    ),
    true,
  );
  assert.equal(blank.unknown.filter((row) => row.kind === 'shot').length, 2);

  const nullPitch = [
    shotAt(0, 0, { waypointId: 3, shot: 'in', pitchDeg: null, headingDeg: 0 }),
    shotAt(0, 0, {
      waypointId: 3,
      shot: 'out',
      pitchDeg: -30,
      headingDeg: 180,
    }),
  ];
  const zero = matchPhotosToShots(
    [photoAt(0, 0, 9, { gimbalPitchDeg: 0, gimbalYawDeg: 0 })],
    nullPitch,
  );
  assert.equal(
    zero.matches.length,
    0,
    'null planned pitch must not match a photo at 0',
  );
  assert.equal(zero.shots.find((s) => s.shot === 'in').status, 'unknown');
  assert.equal(zero.shots.find((s) => s.shot === 'out').status, 'missing');
});

test('a lone shot still matches when the photo attitude is unknown, and says so', () => {
  const report = matchPhotosToShots(
    [photoAt(0.4, 0, 1, { gimbalPitchDeg: null, gimbalYawDeg: null })],
    [shotAt(0, 0, { waypointId: 4, pitchDeg: -55, headingDeg: 90 })],
  );
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].attitude, 'unknown');
  assert.equal(report.shots[0].status, 'matched');
  assert.equal(report.unknown.length, 0);
});

test('an extra photo is not a waypoint needing a retake, and a bare shot stays missing', () => {
  const shots = [
    shotAt(0, 0, { waypointId: 8, shot: 'in' }),
    shotAt(20, 0, { waypointId: 9, shot: null }),
  ];
  const photos = [photoAt(0.2, 0, 1), photoAt(0.9, 0, 2), photoAt(40, 0, 3)];
  const report = matchPhotosToShots(photos, shots);
  assert.equal(report.summary.matchedCount, 1);
  assert.equal(report.matches[0].photoName, 'DJI_0001.JPG');
  assert.equal(report.matches[0].waypointId, 8);
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].waypointId, 9);
  assert.equal(report.retakes.length, 0);
  assert.equal(report.extraPhotos.length, 1);
  assert.equal(report.extraPhotos[0].photoName, 'DJI_0002.JPG');
  assert.equal(report.extraPhotos[0].photoIndex, 1);
  assert.equal(report.extraPhotos[0].waypointId, 8);
  assert.equal(report.extraPhotos[0].shot, 'in');
  assert.ok(report.extraPhotos[0].offsetM <= 1.5);
  assert.equal(report.unmatchedPhotos.length, 1);
  assert.equal(report.unmatchedPhotos[0].photoName, 'DJI_0003.JPG');
  assert.equal(report.summary.retakeCount, 0);
  assert.equal(report.summary.extraPhotoCount, 1);
  assert.equal(report.summary.missingCount, 1);
});

test('matchPlanPhotos uses the rebuilt result, keeps in/out identity, and lets a suite win', () => {
  const here = at(0, 0);
  const result = {
    missions: [
      {
        index: 1,
        legs: [
          {
            id: 3,
            photoMode: 'waypoint',
            waypoints: [
              {
                id: 7,
                ...here,
                photo: true,
                pitchDeg: -37.5,
                headingDeg: 10,
                shot: 'in',
                aglM: 40,
                relHeightM: 40,
              },
              {
                id: 7,
                ...here,
                photo: true,
                pitchDeg: -30,
                headingDeg: 190,
                shot: 'out',
                aglM: 40,
                relHeightM: 40,
              },
              {
                id: 8,
                ...at(30, 0),
                photo: false,
                pitchDeg: -90,
                headingDeg: 0,
              },
            ],
          },
        ],
      },
    ],
  };
  const report = matchPlanPhotos(
    [photoAt(0.2, 0, 1, { gimbalPitchDeg: -37.5, gimbalYawDeg: 10 })],
    { result },
  );
  assert.equal(report.shots.length, 2);
  assert.equal(report.shots[0].waypointId, 7);
  assert.equal(report.shots[0].shot, 'in');
  assert.equal(report.shots[0].mission, 1);
  assert.equal(report.shots[0].leg, 3);
  assert.equal(report.matches[0].shot, 'in');
  assert.equal(
    report.missing.some((s) => s.shot === 'out'),
    true,
  );
  assert.equal(
    report.shots.some((s) => s.waypointId === 8),
    false,
  );

  const suite = {
    passes: [
      { id: 'hidden', result },
      { id: 'failed', result: null },
    ],
  };
  const fromSuite = matchPlanPhotos([], { suite, result: { missions: [] } });
  assert.equal(fromSuite.shots.length, 2);
  assert.equal(fromSuite.shots[0].pass, 'hidden');
  assert.equal(fromSuite.missing.length, 2);
});

test('a waypoint that still carries both shots is split before matching', () => {
  const here = at(0, 0);
  const report = matchPlanPhotos(
    [photoAt(0.1, 0, 1, { gimbalPitchDeg: -30, gimbalYawDeg: 180 })],
    {
      result: {
        missions: [
          {
            legs: [
              {
                id: 1,
                waypoints: [
                  {
                    id: 4,
                    ...here,
                    photo: true,
                    pitchDeg: -37.5,
                    headingDeg: 0,
                    outwardPitchDeg: -30,
                    outwardHeadingDeg: 180,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  );
  assert.deepEqual(
    report.shots.map((s) => s.shot),
    ['in', 'out'],
  );
  assert.equal(report.matches[0].shot, 'out');
  assert.equal(report.matches[0].waypointId, 4);
  assert.equal(report.missing[0].shot, 'in');
});

test('a saved gevplan has no planned shots, and imported drone files are not treated as photos', () => {
  const saved = {
    schema: 'gevplan',
    version: 1,
    areas: [],
    imports: [
      {
        id: 'import-1',
        waypoints: [{ lon: -96.2, lat: 33.1, headingMode: 'followWayline' }],
      },
    ],
  };
  const report = matchPlanPhotos([photoAt(0, 0, 1)], { plan: saved });
  assert.equal(report.reason, 'plan-has-no-shots');
  assert.equal(report.shots.length, 0);
  assert.equal(report.matches.length, 0);
  assert.equal(report.missing.length, 0);
  assert.equal(report.importsIgnored, 1);
});

test('an interval leg is sampled along the line and keeps a leg identity', () => {
  const result = {
    missions: [
      {
        index: 0,
        legs: [
          {
            id: 2,
            photoMode: 'interval',
            photoSpacingM: 30,
            pitchDeg: -90,
            continued: false,
            waypoints: [
              { ...at(0, 0), aglM: 50, relHeightM: 50 },
              { ...at(90, 0), aglM: 50, relHeightM: 50 },
            ],
          },
        ],
      },
    ],
  };
  const report = matchPlanPhotos([], { result });
  assert.equal(report.shots.length, 4);
  assert.equal(report.shots[0].photoMode, 'interval');
  assert.equal(report.shots[0].leg, 2);
  assert.equal(report.shots[0].waypointId, null);
  assert.equal(report.shots[0].pitchDeg, -90);
  assert.equal(report.shots[0].headingDeg, null);
  assert.equal(report.missing.length, 4);
  const xy = report.shots.map((s) => frame.toXY(s.lon, s.lat));
  assert.ok(Math.abs(xy[1].x - 30) < 0.05);
  assert.ok(Math.abs(xy[3].x - 90) < 0.05);
});
