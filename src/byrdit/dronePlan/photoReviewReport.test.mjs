import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoReviewReport } from './photoReviewReport.js';
const shot = { lon: -95, lat: 32, pitchDeg: -45, headingDeg: 0, waypointId: 1 };
const photo = (extra = {}) => ({ name: 'a.jpg', lon: -95, lat: 32, gimbalPitchDeg: -45, gimbalYawDeg: 0, review: { score: 90, reasons: [], sampleCount: 9 }, ...extra });

test('missing shot becomes refly candidate retaining waypoint identity', () => {
  const report = buildPhotoReviewReport([], [shot]);
  assert.equal(report.refly.length, 1);
  assert.equal(report.refly[0].waypointId, 1);
  assert.deepEqual(report.refly[0].reasons, ['missing-photo']);
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

test('unmatched extras are not incorrectly attached as replacement quality', () => {
  const report = buildPhotoReviewReport([
    photo({ review: { sampleCount: 9, score: 20, reasons: ['soft-detail'] } }),
    photo({ lon: -94 }),
  ], [shot]);
  assert.equal(report.refly.length, 1);
  assert.ok(report.photos[1].reasons.includes('off-plan'));
});
