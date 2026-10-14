import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS,
  HISTORY_SPAN_MS,
  HOUR_MS,
  HT_PARAM,
  MINUTE_MS,
  PRESETS,
  RATES,
  advance,
  clampTime,
  coverageBucketFor,
  coverageRange,
  createSnapIndex,
  decodeHt,
  encodeHt,
  fallbackStep,
  followWindow,
  fractionToTime,
  pickStep,
  readHtFromUrl,
  snapTo,
  snapToleranceMs,
  timeToFraction,
  windowAround,
  writeHtToUrl,
} from './historyTimeline.js';
import { readSkyUrl, writeSkyUrl } from '../skyView/skyUrl.js';
import {
  COVERAGE_BUCKETS as API_BUCKETS,
  MAX_COVERAGE_BUCKETS,
  RETENTION_MS,
} from '../history/historyParams.js';

const NOW = Date.parse('2026-10-14T16:00:00Z');

test('presets, speeds and the 2-year span match DESIGN 4.5', () => {
  assert.deepEqual(
    PRESETS.map((p) => p.id),
    ['1h', '24h', '7d', '30d', '90d', 'all'],
  );
  assert.deepEqual([...RATES], [1, 10, 60, 600]);
  assert.equal(HISTORY_SPAN_MS, 730 * DAY_MS);
  // the API keeps 731 days: the slider never asks for a refused time
  assert.ok(HISTORY_SPAN_MS < RETENTION_MS);
});

test('every preset window maps to an API bucket under the 2000-bucket cap', () => {
  for (const p of PRESETS) {
    const b = coverageBucketFor(p.spanMs);
    assert.ok(API_BUCKETS[b.id], `${p.id} -> ${b.id} is an API bucket`);
    assert.equal(API_BUCKETS[b.id], b.ms);
    assert.ok(Math.ceil(p.spanMs / b.ms) + 1 <= MAX_COVERAGE_BUCKETS, p.id);
  }
  assert.equal(coverageBucketFor(HOUR_MS).id, '1m');
  assert.equal(coverageBucketFor(DAY_MS).id, '5m');
  assert.equal(coverageBucketFor(HISTORY_SPAN_MS).id, '1d');
});

test('coverageRange is bucket aligned, inside retention and never past now', () => {
  const win = windowAround(NOW - 3 * HOUR_MS, DAY_MS, NOW);
  const r = coverageRange(win, NOW);
  assert.equal(r.bucket, '5m');
  assert.equal(r.from % r.bucketMs, 0);
  assert.ok(r.to <= NOW);
  const all = coverageRange(windowAround(NOW, HISTORY_SPAN_MS, NOW), NOW);
  assert.ok(all.from >= NOW - HISTORY_SPAN_MS);
  assert.ok(
    Math.ceil((all.to - all.from) / all.bucketMs) <= MAX_COVERAGE_BUCKETS,
  );
});

test('windows stay inside [now - 2 y, now]', () => {
  const w1 = windowAround(NOW, DAY_MS, NOW);
  assert.deepEqual(w1, { from: NOW - DAY_MS, to: NOW });
  const w2 = windowAround(NOW - HISTORY_SPAN_MS - DAY_MS, 7 * DAY_MS, NOW);
  assert.equal(w2.from, NOW - HISTORY_SPAN_MS);
  assert.equal(w2.to - w2.from, 7 * DAY_MS);
  const w3 = windowAround(NOW - 10 * DAY_MS, DAY_MS, NOW);
  assert.equal(w3.from, NOW - 10 * DAY_MS - DAY_MS / 2);
  assert.equal(windowAround(NOW, HOUR_MS, NOW, 1).to, NOW);
});

test('followWindow keeps the window until t reaches a movable edge', () => {
  const win = windowAround(NOW - 2 * DAY_MS, DAY_MS, NOW);
  assert.equal(followWindow(win, NOW - 2 * DAY_MS + HOUR_MS, DAY_MS, NOW), win);
  const moved = followWindow(win, win.to - 10_000, DAY_MS, NOW, {
    playing: true,
  });
  assert.notEqual(moved, win);
  // playing forward: t near the left (10 %) so the window moves rarely
  assert.equal(moved.from, win.to - 10_000 - DAY_MS * 0.1);
  // at the live edge the window cannot move right: it stays
  const live = windowAround(NOW, DAY_MS, NOW, 1);
  assert.equal(followWindow(live, NOW - 1000, DAY_MS, NOW), live);
  // another span -> a new window
  assert.notEqual(followWindow(win, NOW - 2 * DAY_MS, HOUR_MS, NOW), win);
});

test('fraction <-> time round trip (whole seconds)', () => {
  const win = { from: NOW - DAY_MS, to: NOW };
  for (const f of [0, 0.25, 0.5, 0.999, 1]) {
    const t = fractionToTime(f, win);
    assert.equal(t % 1000, 0);
    assert.ok(Math.abs(timeToFraction(t, win) - f) < 1e-4);
  }
  assert.equal(fractionToTime(-1, win), win.from);
  assert.equal(fractionToTime(9, win), win.to);
  assert.equal(timeToFraction(win.from - 5, win), 0);
});

test('snap-to-data: nearest recorded snapshot within tolerance, never across a gap', () => {
  const snaps = [
    NOW - 3 * MINUTE_MS,
    NOW - 2 * MINUTE_MS,
    NOW + 20 * MINUTE_MS,
  ];
  assert.equal(
    snapTo(NOW - 2 * MINUTE_MS - 20_000, snaps, 60_000),
    NOW - 2 * MINUTE_MS,
  );
  // 10 minutes from any snapshot: in a gap -> no jump (HUD names the gap)
  assert.equal(snapTo(NOW + 9 * MINUTE_MS, snaps, 60_000), null);
  assert.equal(snapToleranceMs(HOUR_MS), MINUTE_MS);
  assert.equal(snapToleranceMs(DAY_MS), 172_800);
  assert.equal(snapToleranceMs(HISTORY_SPAN_MS), 10 * MINUTE_MS);
});

test('step picks the n-th recorded snapshot; Shift = 10 steps; farthest when fewer', () => {
  const snaps = Array.from(
    { length: 30 },
    (_, i) => NOW - (30 - i) * MINUTE_MS,
  );
  const t = snaps[15];
  assert.equal(pickStep(snaps, t, 1, 1), snaps[16]);
  assert.equal(pickStep(snaps, t, -1, 1), snaps[14]);
  assert.equal(pickStep(snaps, t, 1, 10), snaps[25]);
  assert.equal(pickStep(snaps, t, -1, 10), snaps[5]);
  assert.equal(pickStep(snaps, t, 1, 99), snaps[29]);
  assert.equal(pickStep([t], t, 1, 1), null);
  assert.equal(
    fallbackStep(NOW - HOUR_MS, -1, 10, NOW),
    NOW - HOUR_MS - 10 * MINUTE_MS,
  );
  assert.equal(fallbackStep(NOW - 10_000, 1, 1, NOW), NOW);
});

test('snap index answers steps inside the known interval without a fetch', () => {
  const idx = createSnapIndex();
  const around = NOW - HOUR_MS;
  // exact 5 nearest: -2..+2 minutes
  const snaps = [-2, -1, 0, 1, 2].map((m) => around + m * MINUTE_MS);
  idx.add(around, snaps);
  assert.equal(idx.step(around, 1, 1), around + MINUTE_MS);
  assert.equal(idx.step(around, -1, 2), around - 2 * MINUTE_MS);
  // 3 ahead is beyond what the index knows -> null (caller fetches)
  assert.equal(idx.step(around, 1, 3), null);
  assert.equal(idx.step(NOW - 5 * HOUR_MS, 1, 1), null);
});

test('playback advances rate x wall time and stops at now', () => {
  assert.deepEqual(advance(NOW - HOUR_MS, 1000, 60, NOW), {
    timeMs: NOW - HOUR_MS + 60_000,
    reachedNow: false,
  });
  assert.deepEqual(advance(NOW - 1000, 1000, 600, NOW), {
    timeMs: NOW,
    reachedNow: true,
  });
  assert.equal(clampTime(NOW + DAY_MS, NOW), NOW);
  assert.equal(clampTime(0, NOW), NOW - HISTORY_SPAN_MS);
});

test('ht round trip: own query parameter, hash (l=) and sv untouched', () => {
  const href =
    'https://gev.example/?sv=29.76,-95.37,180,45,60&svf=2#lat=29.7&lon=-95.3&l=abcDEF';
  const t = Date.parse('2026-10-13T14:05:30Z');
  const written = writeHtToUrl(href, t);
  const url = new URL(written);
  assert.equal(HT_PARAM, 'ht');
  assert.equal(url.searchParams.get('ht'), '2026-10-13T14:05:30Z');
  assert.ok(
    written.includes('ht=2026-10-13T14:05:30Z'),
    'readable, not %3A-escaped',
  );
  assert.equal(url.hash, '#lat=29.7&lon=-95.3&l=abcDEF');
  assert.equal(url.searchParams.get('sv'), '29.76,-95.37,180,45,60');
  assert.equal(readHtFromUrl(written, NOW), t);
  // leaving history clears it, nothing else
  const cleared = writeHtToUrl(written, null);
  assert.equal(new URL(cleared).searchParams.has('ht'), false);
  assert.equal(new URL(cleared).hash, '#lat=29.7&lon=-95.3&l=abcDEF');
  assert.equal(
    new URL(cleared).searchParams.get('sv'),
    '29.76,-95.37,180,45,60',
  );
});

test('ht: share-link hash rewrite keeps it; Sky reads the same time and keeps it on write', () => {
  const t = Date.parse('2026-10-13T14:05:30Z');
  const withHt = writeHtToUrl(
    'https://gev.example/?sv=29.76,-95.37,180,45,60,2026-01-01T00:00:00Z',
    t,
  );
  // ShareLinkManager._updateHash: new URL(`#${params}`, location.href)
  const shared = new URL('#lat=1&l=XYZ', withHt).href;
  assert.equal(readHtFromUrl(shared, NOW), t);
  // Sky: ht wins over the sv time, and Sky never removes ht
  const sky = readSkyUrl(shared);
  assert.equal(sky.timeMs, t);
  assert.equal(sky.timeSource, 'ht');
  const skyWritten = writeSkyUrl(shared, sky);
  assert.equal(readHtFromUrl(skyWritten, NOW), t);
});

test('ht: strict ISO UTC inside the 2-year window, else ignored', () => {
  assert.equal(
    encodeHt(Date.parse('2026-10-13T14:05:30.250Z')),
    '2026-10-13T14:05:30Z',
  );
  assert.equal(
    decodeHt('2026-10-13T14:05:30Z', NOW),
    Date.parse('2026-10-13T14:05:30Z'),
  );
  for (const bad of [
    '',
    'yesterday',
    '2026-10-13 14:05:30Z',
    '2026-10-13T14:05:30+02:00',
    '2020-01-01T00:00:00Z',
    '2027-01-01T00:00:00Z',
  ])
    assert.equal(decodeHt(bad, NOW), null, bad);
  assert.equal(readHtFromUrl('not a url', NOW), null);
  assert.equal(
    readHtFromUrl('https://gev.example/#ht=2026-10-13T14:05:30Z', NOW),
    null,
    'hash is not the ht',
  );
});
