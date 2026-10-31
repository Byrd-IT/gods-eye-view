import assert from 'node:assert/strict';
import test from 'node:test';
import { readPhotoMeta, HEADER_BYTES } from './photoExif.js';
import { makeFrame } from './geo.js';
import {
  analyzePhotos,
  dedupePhotos,
  defaultMatchM,
  focalPx,
  photoGsd,
  plannedPhotoPoints,
  reportCsv,
} from './photoCheck.js';

import { jpeg, tiff, u32, xmpText } from './photoFixtures.mjs';

const HERE = { lat: 33.1, lon: -96.2 };

test('EXIF GPS, XMP heights and the camera numbers are read', () => {
  const r = readPhotoMeta(
    jpeg({
      exif: tiff({ gps: { lat: 33.100123, lon: -96.200456, alt: 175.146 } }),
      xmp: xmpText({
        lat: '+33.100123',
        lon: '-96.200456',
        abs: '+175.146',
        rel: '+79.500',
      }),
    }),
    'a.jpg',
  );
  assert.equal(r.ok, true);
  const p = r.photo;
  assert.equal(p.positionSource, 'exif');
  assert.ok(Math.abs(p.lat - 33.100123) < 1e-5);
  assert.ok(Math.abs(p.lon + 96.200456) < 1e-5);
  assert.equal(p.relAltM, 79.5);
  assert.equal(p.absAltM, 175.146);
  assert.equal(p.focalMm, 8.67);
  assert.equal(p.focal35Mm, 24);
  assert.equal(p.widthPx, 4096);
  assert.equal(p.model, 'FC9313');
  assert.equal(p.gimbalPitchDeg, -90);
  assert.equal(p.timeMs, Date.parse('2026-10-30T13:09:19-05:00'));
});

test('empty EXIF GPS (real DJI files before the fix) falls back to the XMP position', () => {
  const r = readPhotoMeta(
    jpeg({
      exif: tiff({ gps: 'empty' }),
      xmp: xmpText({
        lat: '+33.100123',
        lon: '-96.200456',
        abs: '+175.146',
        rel: '+79.500',
      }),
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.photo.positionSource, 'xmp');
  assert.equal(r.photo.lat, 33.100123);
  assert.equal(r.photo.lon, -96.200456);
});

test('southern and eastern positions get the right sign', () => {
  const r = readPhotoMeta(
    jpeg({ exif: tiff({ gps: { lat: -33.5, lon: 151.25, alt: 10 } }) }),
  );
  assert.ok(Math.abs(r.photo.lat + 33.5) < 1e-4);
  assert.ok(Math.abs(r.photo.lon - 151.25) < 1e-4);
});

test('no position anywhere, 0,0, not a JPEG and junk are refused without throwing', () => {
  assert.equal(
    readPhotoMeta(jpeg({ exif: tiff({ gps: 'empty' }) }), 'x').reason,
    'no-position',
  );
  assert.equal(
    readPhotoMeta(
      jpeg({ xmp: xmpText({ lat: '+0.0', lon: '+0.0', abs: '1', rel: '1' }) }),
    ).reason,
    'no-position',
  );
  assert.equal(
    readPhotoMeta(new Uint8Array([1, 2, 3, 4, 5])).reason,
    'not-jpeg',
  );
  assert.equal(readPhotoMeta(new Uint8Array(0)).reason, 'not-jpeg');
  assert.equal(readPhotoMeta('nope').reason, 'not-jpeg');
  assert.equal(
    readPhotoMeta(
      jpeg({ xmp: xmpText({ lat: '+999', lon: '-96', abs: '1', rel: '1' }) }),
    ).reason,
    'no-position',
  );
});

test('truncated and corrupt EXIF never throws and cannot loop', () => {
  const good = jpeg({
    exif: tiff({ gps: { lat: 33, lon: -96, alt: 1 } }),
    xmp: xmpText({ lat: '+33.2', lon: '-96.3', abs: '1', rel: '2' }),
  });
  for (const cut of [10, 30, 80, 200, 450, 700]) {
    const r = readPhotoMeta(good.slice(0, cut));
    assert.ok(r.ok === true || r.ok === false);
  }
  // an IFD that points at itself
  const t = tiff({ gps: null });
  t.splice(8 + 2 + 3 * 12, 4, ...u32(8));
  assert.doesNotThrow(() => readPhotoMeta(jpeg({ exif: t })));
  // a huge entry count and a length that overruns
  const evil = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0xff,
    0xff,
    ...Buffer.from('Exif\0\0II*\0\x08\0\0\0\xff\xff', 'latin1'),
  ]);
  assert.doesNotThrow(() => readPhotoMeta(evil));
});

test('XMP values that are not plain numbers are ignored', () => {
  const r = readPhotoMeta(
    jpeg({
      xmp: xmpText({ lat: '+33.2', lon: '-96.3', abs: '<script>', rel: 'NaN' }),
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.photo.relAltM, null);
  assert.equal(r.photo.absAltM, null);
});

test('HEADER_BYTES covers a real DJI header (the EXIF block is about 36 KB)', () => {
  assert.ok(HEADER_BYTES >= 128 * 1024);
});

// ------------------------------------------------------------ the maths --
const frame = makeFrame(HERE.lon, HERE.lat);
const at = (x, y) => frame.toLonLat(x, y);
const photoAt = (x, y, i, extra = {}) => ({
  name: `p${i}.jpg`,
  ...at(x, y),
  timeMs: 1_000_000 + i * 5000,
  relAltM: 50,
  focal35Mm: 24,
  widthPx: 4096,
  heightPx: 3072,
  ...extra,
});
const plannedAt = (x, y, extra = {}) => ({
  ...at(x, y),
  aglM: 50,
  relHeightM: 50,
  pitchDeg: -90,
  mission: 0,
  leg: 0,
  pass: '',
  ...extra,
});

test('GSD from EXIF: 50 m with 24 mm equivalent on a 4096 px image is 1.83 cm', () => {
  const g = photoGsd({ focal35Mm: 24, widthPx: 4096, heightPx: 3072 }, 50);
  assert.ok(Math.abs(g.gsdCm - 1.8311) < 0.001);
  assert.ok(Math.abs(g.acrossM - 75) < 0.01);
  assert.ok(Math.abs(g.alongM - 56.25) < 0.01);
});

test('GSD prefers the camera calibrated focal length, and is null without any', () => {
  assert.equal(
    focalPx({
      calibratedFocalPx: 3051.613,
      focal35Mm: 24,
      widthPx: 4000,
      heightPx: 3000,
    }),
    3051.613,
  );
  assert.equal(focalPx({ widthPx: 4000, heightPx: 3000 }), null);
  assert.equal(photoGsd({ widthPx: 4000, heightPx: 3000 }, 50), null);
  assert.equal(
    photoGsd({ focal35Mm: 24, widthPx: 4096, heightPx: 3072 }, 0),
    null,
  );
  assert.equal(
    photoGsd({ focal35Mm: 24, widthPx: 4096, heightPx: 3072 }, NaN),
    null,
  );
});

test('copied files (same time and place) are counted once', () => {
  const a = photoAt(0, 0, 1);
  const out = dedupePhotos([
    a,
    { ...a, name: 'p1 (1).jpg' },
    photoAt(10, 0, 2),
  ]);
  assert.equal(out.photos.length, 2);
  assert.equal(out.duplicates, 1);
});

test('planned points: waypoint legs give one per photo waypoint, and none for plain stops', () => {
  const result = {
    missions: [
      {
        index: 2,
        legs: [
          {
            id: 5,
            photoMode: 'waypoint',
            waypoints: [
              {
                lon: -96.2,
                lat: 33.1,
                aglM: 50,
                relHeightM: 50,
                photo: true,
                pitchDeg: -90,
              },
              {
                lon: -96.2001,
                lat: 33.1,
                aglM: 50,
                relHeightM: 50,
                photo: false,
              },
              {
                lon: -96.2002,
                lat: 33.1,
                aglM: 50,
                relHeightM: 52,
                photo: true,
              },
            ],
          },
        ],
      },
    ],
  };
  const pts = plannedPhotoPoints({ result });
  assert.equal(pts.length, 2);
  assert.equal(pts[0].mission, 2);
  assert.equal(pts[0].leg, 5);
  assert.equal(pts[1].relHeightM, 52);
});

test('planned points: an interval leg takes a photo every photoSpacingM along its line', () => {
  const a = at(0, 0);
  const b = at(100, 0);
  const c = at(100, 60);
  const result = {
    missions: [
      {
        legs: [
          {
            photoMode: 'interval',
            photoSpacingM: 30,
            waypoints: [
              { ...a, aglM: 50, relHeightM: 50 },
              { ...b, aglM: 50, relHeightM: 60 },
              { ...c, aglM: 50, relHeightM: 60 },
            ],
          },
        ],
      },
    ],
  };
  const pts = plannedPhotoPoints({ result });
  // 160 m of line at 30 m: 0, 30, 60, 90 ... 150 -> 6 photos
  assert.equal(pts.length, 6);
  const xy = pts.map((p) => frame.toXY(p.lon, p.lat));
  assert.ok(Math.abs(xy[1].x - 30) < 0.01);
  // the spacing carries round the corner: 90 then 100 m is the corner, so 120 m = 20 m up
  assert.ok(
    Math.abs(xy[4].x - 100) < 0.01 && Math.abs(xy[4].y - 20) < 0.01,
    JSON.stringify(xy[4]),
  );
  assert.ok(pts[3].relHeightM > 50 && pts[3].relHeightM <= 60);
  assert.equal(
    plannedPhotoPoints({
      result: {
        missions: [
          {
            legs: [
              {
                photoMode: 'interval',
                photoSpacingM: 0,
                waypoints: [{ ...a }, { ...b }],
              },
            ],
          },
        ],
      },
    }).length,
    0,
  );
});

test('planned points: an all-passes plan wins and counts hidden and failed passes correctly', () => {
  const leg = {
    photoMode: 'waypoint',
    waypoints: [{ lon: -96.2, lat: 33.1, photo: true, aglM: 40 }],
  };
  const res = { missions: [{ legs: [leg] }] };
  const suite = {
    passes: [
      { id: 'a', result: res },
      { id: 'b', result: null },
      { id: 'c', result: res },
    ],
  };
  const pts = plannedPhotoPoints({ suite, result: { missions: [] } });
  assert.deepEqual(
    pts.map((p) => p.pass),
    ['a', 'c'],
  );
  assert.deepEqual(plannedPhotoPoints({}), []);
});

test('coverage: all planned points photographed gives no missing and no gaps', () => {
  const planned = [0, 1, 2, 3, 4].map((i) => plannedAt(i * 30, 0));
  const photos = [0, 1, 2, 3, 4].map((i) => photoAt(i * 30 + 2, 1, i));
  const a = analyzePhotos(photos, planned, { matchM: 10 });
  assert.equal(a.summary.coveredCount, 5);
  assert.equal(a.summary.missingCount, 0);
  assert.equal(a.summary.offPlanCount, 0);
  assert.equal(a.summary.gapCount, 0);
  assert.ok(a.summary.medianOffsetM > 2 && a.summary.medianOffsetM < 3);
});

test('coverage: a planned point with no photo near it is missing, and the spacing gap is flagged', () => {
  const planned = [0, 1, 2, 3, 4].map((i) => plannedAt(i * 30, 0));
  // photo 2 was never taken; the aircraft kept the same pace (so no break)
  const photos = [0, 1, 3, 4].map((i, k) =>
    photoAt(i * 30, 0, k + (i > 2 ? 1 : 0)),
  );
  const a = analyzePhotos(photos, planned, { matchM: 10 });
  assert.equal(a.summary.missingCount, 1);
  assert.equal(
    a.planned.findIndex((p) => !p.covered),
    2,
  );
  assert.equal(a.gaps.length, 1);
  assert.equal(a.summary.gapCount, 1);
  assert.equal(a.breaks.length, 0);
});

test('a long pause between photos is a break (leg change, battery swap), not a gap', () => {
  const photos = [
    photoAt(0, 0, 0),
    photoAt(30, 0, 1),
    photoAt(60, 0, 2),
    photoAt(300, 0, 3, { timeMs: 1_000_000 + 3 * 5000 + 600_000 }),
    photoAt(330, 0, 4, { timeMs: 1_000_000 + 4 * 5000 + 600_000 }),
  ];
  const a = analyzePhotos(photos, []);
  assert.equal(a.gaps.length, 0);
  assert.equal(a.breaks.length, 1);
});

test('photos away from every planned point are off the plan', () => {
  const planned = [plannedAt(0, 0), plannedAt(30, 0)];
  const photos = [photoAt(0, 0, 0), photoAt(30, 0, 1), photoAt(500, 500, 2)];
  const a = analyzePhotos(photos, planned, { matchM: 10 });
  assert.equal(a.summary.offPlanCount, 1);
  assert.equal(a.photos.find((p) => p.name === 'p2.jpg').onPlan, false);
});

test('no plan: nothing is off plan or missing, gaps and GSD still work', () => {
  const photos = [0, 1, 2].map((i) => photoAt(i * 30, 0, i));
  const a = analyzePhotos(photos, []);
  assert.equal(a.summary.plannedCount, 0);
  assert.equal(a.summary.offPlanCount, 0);
  assert.equal(a.summary.missingCount, 0);
  assert.ok(a.summary.gsdMedianCm > 1.8 && a.summary.gsdMedianCm < 1.9);
  assert.equal(a.summary.gsdFromTakeoff, 3);
});

test('height above ground comes from the plan: planned height plus how far off the aircraft was', () => {
  // terrain: the planned point is 50 m above ground at 80 m above takeoff
  const planned = [plannedAt(0, 0, { aglM: 50, relHeightM: 80 })];
  const photos = [photoAt(0, 0, 0, { relAltM: 83 })];
  const a = analyzePhotos(photos, planned, { matchM: 10 });
  assert.equal(a.photos[0].heightM, 53);
  assert.equal(a.photos[0].heightBasis, 'plan');
  assert.ok(Math.abs(a.photos[0].gsdCm - (53 / 2730.6667) * 100) < 0.001);
  // an off-plan photo only knows its height above takeoff
  const b = analyzePhotos([photoAt(900, 0, 0, { relAltM: 40 })], planned, {
    matchM: 10,
  });
  assert.equal(b.photos[0].heightBasis, 'takeoff');
  assert.equal(b.photos[0].heightM, 40);
});

test('a photo without a height has no GSD and is counted', () => {
  const a = analyzePhotos([photoAt(0, 0, 0, { relAltM: null })], []);
  assert.equal(a.summary.gsdMissing, 1);
  assert.equal(a.summary.gsdMedianCm, null);
});

test('the match distance is clamped and defaults from the planned spacing', () => {
  const planned = [0, 1, 2, 3].map((i) => plannedAt(i * 30, 0));
  assert.equal(defaultMatchM(planned), 10);
  assert.equal(defaultMatchM([plannedAt(0, 0)]), 10);
  assert.equal(defaultMatchM([plannedAt(0, 0), plannedAt(5, 0)]), 5);
  assert.equal(
    analyzePhotos([photoAt(0, 0, 0)], planned, { matchM: 0 }).matchM,
    2,
  );
  assert.equal(
    analyzePhotos([photoAt(0, 0, 0)], planned, { matchM: 9999 }).matchM,
    100,
  );
});

test('no photos gives an empty analysis, and many photos stay fast', () => {
  assert.equal(analyzePhotos([], [plannedAt(0, 0)]).summary, null);
  const planned = [];
  const photos = [];
  for (let i = 0; i < 70; i += 1)
    for (let j = 0; j < 70; j += 1) {
      planned.push(plannedAt(i * 20, j * 20));
      photos.push(photoAt(i * 20 + 1, j * 20, i * 70 + j));
    }
  const t0 = Date.now();
  const a = analyzePhotos(photos, planned, { matchM: 8 });
  assert.equal(a.summary.coveredCount, 4900);
  assert.ok(Date.now() - t0 < 5000);
});

test('the CSV has one row per photo and per planned point, and a file name cannot start a formula', () => {
  const planned = [plannedAt(0, 0), plannedAt(60, 0)];
  const a = analyzePhotos(
    [photoAt(0, 0, 0, { name: '=HYPERLINK("x")' })],
    planned,
    { matchM: 10 },
  );
  const rows = reportCsv(a).split('\n');
  assert.equal(rows.length, 1 + 1 + 2);
  assert.match(rows[1], /^photo,"'=HYPERLINK/);
  assert.match(rows[3], /missing$/);
});
