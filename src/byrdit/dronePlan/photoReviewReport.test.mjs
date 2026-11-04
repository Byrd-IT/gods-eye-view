import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoReviewReport } from './photoReviewReport.js';
import { plannedShots } from './photoQualityMatch.js';
import { makeFrame } from './geo.js';

test('headed interval captures retain circular heading and do not force refly', () => {
  const frame = makeFrame(-95, 32);
  const sources = { result: { missions: [{ legs: [{
    photoMode: 'interval', photoSpacingM: 10, pitchDeg: -45,
    waypoints: [
      { ...frame.toLonLat(0, 0), headingDeg: 350 },
      { ...frame.toLonLat(20, 0), headingDeg: 10 },
    ],
  }] }] } };
  const shots = plannedShots(sources);
  assert.equal(shots.length, 3);
  for (const [i, expected] of [350, 0, 10].entries()) {
    assert.ok(Math.abs(((shots[i].headingDeg - expected + 540) % 360) - 180) < 1e-6);
    assert.notEqual(shots[i].headingDeg, null);
  }
  const photos = shots.map((s, i) => photo({ name: `${i}.jpg`, lon: s.lon, lat: s.lat, gimbalYawDeg: [350, 0, 10][i] }));
  const report = buildPhotoReviewReport(photos, shots);
  assert.equal(report.matches.matches.length, 3);
  assert.equal(report.refly.length, 0);
});

test('interval heading gaps remain unknown rather than inheriting a distant angle', () => {
  const frame = makeFrame(-95, 32);
  const shots = plannedShots({ result: { missions: [{ legs: [{
    photoMode: 'interval', photoSpacingM: 10, pitchDeg: -45,
    waypoints: [
      { ...frame.toLonLat(0, 0), headingDeg: 20 },
      { ...frame.toLonLat(20, 0), headingDeg: null },
    ],
  }] }] } });
  assert.equal(shots[0].headingDeg, 20);
  assert.equal(shots[1].headingDeg, null);
  assert.equal(shots[2].headingDeg, null);
});
test('interval heights use known endpoints but never bridge an unknown span', () => {
  const frame = makeFrame(-95, 32);
  for (const values of [[50, null], [null, 70]]) {
    const shots = plannedShots({ result: { missions: [{ legs: [{
      photoMode: 'interval', photoSpacingM: 10, pitchDeg: -45,
      waypoints: values.map((v, i) => ({ ...frame.toLonLat(i * 20, 0), aglM: v, relHeightM: v })),
    }] }] } });
    for (const key of ['aglM', 'relHeightM']) {
      assert.deepEqual(shots.map(s => s[key]), [values[0], null, values[1]]);
    }
  }
});

test('nearby capture with neither co-located attitude remains linked inspection evidence', () => {
  const shots = [shot, { ...shot, headingDeg: 180, waypointId: 2 }];
  const report = buildPhotoReviewReport([photo({ gimbalYawDeg: 90 })], shots);
  assert.equal(report.matches.matches.length, 0);
  assert.equal(report.refly.length, 2);
  for (const row of report.refly) {
    assert.equal(row.decision, 'inspect-before-refly');
    assert.equal(row.photoIndex, 0);
    assert.ok(row.reasons.includes('attitude-disagreed'));
    assert.ok(!row.reasons.includes('missing-photo'));
  }
  assert.ok(report.photos[0].reasons.includes('attitude-disagreed'));
  assert.ok(!report.photos[0].reasons.includes('off-plan'));
});

test('ambiguous disagreement evidence keeps original indexes after dedupe', () => {
  const unrelated = photo({ lon: -94, digest: 'a'.repeat(64) });
  const wrong = photo({ gimbalYawDeg: 90 });
  const report = buildPhotoReviewReport([unrelated, { ...unrelated }, wrong], [shot, { ...shot, headingDeg: 180, waypointId: 2 }]);
  assert.ok(report.refly.every(r => r.photoIndex === 2 && r.status === 'unknown'));
  assert.ok(report.matches.shots.every(r => r.photoIndex === 2));
  assert.equal(report.matches.matches.length, 0);
});

test('mixed unknown and disagreed co-located shots retain nearby evidence for both', () => {
  const shots = [{ ...shot, pitchDeg: null }, { ...shot, headingDeg: 180, waypointId: 2 }];
  const report = buildPhotoReviewReport([photo()], shots);
  assert.equal(report.matches.matches.length, 0);
  assert.equal(report.refly.length, 2);
  assert.deepEqual(report.refly.map(r => r.reasons), [['attitude-unknown'], ['attitude-disagreed']]);
  assert.ok(report.refly.every(r => r.photoIndex === 0 && r.decision === 'inspect-before-refly'));
  assert.ok(report.photos[0].reasons.includes('attitude-unknown'));
  assert.ok(report.photos[0].reasons.includes('attitude-disagreed'));
  assert.equal(report.matches.unknown.filter(r => r.kind === 'photo').length, 2);
});

const shot = { lon: -95, lat: 32, pitchDeg: -45, headingDeg: 0, waypointId: 1 };
const photo = (extra = {}) => ({ name: 'a.jpg', lon: -95, lat: 32, gimbalPitchDeg: -45, gimbalYawDeg: 0, review: { score: 90, reasons: [], sampleCount: 9 }, ...extra });

test('missing shot becomes refly candidate retaining waypoint identity', () => {
  const report = buildPhotoReviewReport([], [shot]);
  assert.equal(report.refly.length, 1);
  assert.equal(report.refly[0].waypointId, 1);
  assert.deepEqual(report.refly[0].reasons, ['missing-photo']);
});

test('incomplete batches cannot confirm missing captures in any exported view', () => {
  for (const incomplete of [
    { skippedOver: 1 },
    { rejected: [{ name: 'unread.jpg', reason: 'header-unavailable' }] },
    { rejected: [{ name: 'bad.jpg', reason: 'not-jpeg' }] },
    { cancelled: true },
  ]) {
    const report = buildPhotoReviewReport([photo()], [shot, { ...shot, lon: -94, waypointId: 2 }], incomplete);
    assert.equal(report.coverageIncomplete, true);
    assert.equal(report.matches.matches.length, 1);
    assert.equal(report.matches.shots[0].status, 'matched');
    assert.equal(report.matches.missing.length, 0);
    assert.equal(report.matches.shots[1].status, 'unknown');
    assert.equal(report.matches.shots[1].reason, 'coverage-unknown');
    assert.ok(report.matches.unknown.some(r => r.kind === 'shot' && r.shotKey === report.matches.shots[1].key));
    assert.equal(report.refly.length, 1);
    assert.equal(report.refly[0].decision, 'inspect-before-refly');
    assert.deepEqual(report.refly[0].reasons, ['coverage-unknown']);
    assert.equal(report.refly[0].photoIndex, null);
  }
});

test('unlocated captures also prevent confirming missing captures', () => {
  const report = buildPhotoReviewReport([photo({ lon: null, lat: null })], [shot]);
  assert.equal(report.refly[0].decision, 'inspect-before-refly');
  assert.deepEqual(report.refly[0].reasons, ['coverage-unknown']);
  assert.equal(report.matches.missing.length, 0);
  assert.ok(report.photos[0].reasons.includes('no-position'));
});

test('complete empty batch can report missing and incomplete no-plan invents no shots', () => {
  const complete = buildPhotoReviewReport([], [shot], { rejected: [], skippedOver: 0 });
  assert.equal(complete.coverageIncomplete, false);
  assert.equal(complete.refly[0].decision, 'missing-capture');
  const noPlan = buildPhotoReviewReport([], [], { skippedOver: 1 });
  assert.equal(noPlan.coverageIncomplete, true);
  assert.equal(noPlan.refly.length, 0);
});

test('quality cues and attitude disagreement produce inspect-before-refly reasons', () => {
  const p = photo({ gimbalPitchDeg: -20, review: { score: 30, sampleCount: 9, reasons: ['soft-detail', 'flat-blocks-noisy'] } });
  const report = buildPhotoReviewReport([p], [shot]);
  assert.equal(report.refly.length, 1);
  assert.equal(report.refly[0].decision, 'inspect-before-refly');
  assert.deepEqual(report.refly[0].reasons, ['attitude-disagreed', 'soft-detail', 'flat-blocks-noisy']);
  assert.equal(report.photos[0].score, 30);
});

test('unknown quality and angles never count as verified coverage', () => {
  const report = buildPhotoReviewReport([photo({ review: undefined, gimbalYawDeg: null })], [shot]);
  assert.equal(report.refly[0].decision, 'inspect-before-refly');
  assert.ok(report.refly[0].reasons.includes('quality-unknown'));
  assert.ok(report.refly[0].reasons.includes('attitude-unknown'));
});

test('sampled images with unknown score remain inspection candidates', () => {
  const report = buildPhotoReviewReport([photo({ review: { score: null, reasons: [], sampleCount: 9 } })], [shot]);
  assert.ok(report.photos[0].reasons.includes('quality-unknown'));
  assert.equal(report.refly.length, 1);
  assert.ok(report.refly[0].reasons.includes('quality-unknown'));
});

test('no plan preserves per-photo findings but does not invent refly waypoints', () => {
  const report = buildPhotoReviewReport([photo({ lon: null, lat: null, review: { score: null, reasons: ['no-position'], sampleCount: 0 } })]);
  assert.equal(report.photos.length, 1);
  assert.equal(report.refly.length, 0);
  assert.ok(report.photos[0].reasons.includes('no-position'));
});

test('same copy names alone do not erase independent shots', () => {
  const report = buildPhotoReviewReport([photo(), photo({ name: 'a (1).jpg' })], [shot, { ...shot, waypointId: 2 }]);
  assert.equal(report.photos.length, 2);
  assert.equal(report.matches.matches.length, 2);
});

test('exact fingerprints count once and cannot fill two planned shots', () => {
  const digest = 'a'.repeat(64);
  const report = buildPhotoReviewReport([photo({ digest }), photo({ name: 'copy.jpg', digest })], [shot, { ...shot, waypointId: 2 }]);
  assert.equal(report.photos.length, 2);
  assert.equal(report.photos[1].duplicateOf, 0);
  assert.equal(report.matches.matches.length, 1);
  assert.equal(report.refly.length, 1);
});

test('useful alternative capture avoids unnecessary refly candidate', () => {
  const report = buildPhotoReviewReport([
    photo({ review: { sampleCount: 9, score: 20, reasons: ['soft-detail'] } }),
    photo({ name: 'better.jpg', lon: -95 + 0.000005 }),
  ], [shot]);
  assert.equal(report.matches.shots[0].photoIndex, 1);
  assert.equal(report.refly.length, 0);
  assert.ok(report.photos[0].reasons.includes('soft-detail'));
});

test('useful preference does not sacrifice cardinality for an isolated shot', () => {
  const east = 0.0000106; // approximately one metre here
  const report = buildPhotoReviewReport([
    photo({ lon: -95 + east }), // can serve both shots
    photo({ lon: -95 - east, review: { sampleCount: 9, score: 20, reasons: ['soft-detail'] } }),
  ], [shot, { ...shot, lon: -95 + 2 * east, waypointId: 2 }]);
  assert.equal(report.matches.matches.length, 2);
  assert.equal(report.matches.shots[1].photoIndex, 0);
  assert.equal(report.matches.shots[0].photoIndex, 1);
});

test('a wrong-angle alternative never clears a quality retake candidate', () => {
  const report = buildPhotoReviewReport([
    photo({ review: { sampleCount: 9, score: 20, reasons: ['soft-detail'] } }),
    photo({ gimbalPitchDeg: 0 }),
  ], [shot]);
  assert.equal(report.refly.length, 1);
});

test('export retains local measurement evidence and planned height for KMZ input', () => {
  const samples = [{ code: 'measured', score: 90, metrics: { blur: { score: 90 } } }];
  const report = buildPhotoReviewReport([photo({ review: { score: 90, sampleCount: 1, reasons: ['soft-detail'], samples } })], [{ ...shot, relHeightM: 80, aglM: 60 }]);
  assert.deepEqual(report.photos[0].evidence.samples, samples);
  assert.equal(report.photos[0].evidence.sampleCount, 1);
  assert.equal(report.refly[0].relHeightM, 80);
  assert.equal(report.refly[0].aglM, 60);
});

test('modeled overlap gaps retain both waypoints as inspection candidates', () => {
  const geometry = { widthPx: 4096, heightPx: 3072, focal35Mm: 24, relAltM: 80, gimbalPitchDeg: -90 };
  const photos = [photo(geometry), photo({ ...geometry, lon: -94.99 })];
  const shots = [{ ...shot, pitchDeg: -90, relHeightM: 80, aglM: 80 }, { ...shot, lon: -94.99, pitchDeg: -90, relHeightM: 80, aglM: 80, waypointId: 2 }];
  const report = buildPhotoReviewReport(photos, shots);
  assert.equal(report.refly.length, 2);
  assert.ok(report.refly.every((s) => s.reasons.includes('modeled-overlap-gap')));
  assert.equal(report.overlap.verified, false);
});

test('all exported match photo indexes refer to original rows after duplicates', () => {
  const first = photo({ digest: 'a'.repeat(64) });
  const report = buildPhotoReviewReport([first, { ...first, name: 'copy.jpg' }, photo({ name: 'next.jpg', lon: -94.99 })], [shot, { ...shot, lon: -94.99, waypointId: 2 }]);
  assert.equal(report.matches.shots[1].photoIndex, 2);
  assert.equal(report.matches.matches[1].photoIndex, 2);
});

test('unmatched extras are not incorrectly attached as replacement quality', () => {
  const report = buildPhotoReviewReport([
    photo({ review: { sampleCount: 9, score: 20, reasons: ['soft-detail'] } }),
    photo({ lon: -94 }),
  ], [shot]);
  assert.equal(report.refly.length, 1);
  assert.ok(report.photos[1].reasons.includes('off-plan'));
});
