import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MERGE_TIE_MS,
  adsblolSnapAtOrBefore,
  boxesIntersect,
  mergeAircraft,
  nearestAdsblolSnaps,
  nearestSnaps,
  pickPollSnap,
  sourcesPresent,
  staleUnion,
} from './historyMerge.js';

/** B9 merge-rule unit tests with synthetic two-source data (DESIGN 1.3 #1c). */

const T = Date.UTC(2026, 9, 13, 19, 46, 40);
const a = (id, dt) => ({ id, tsMs: T - dt, source: 'adsblol' });
const o = (id, dt) => ({ id, tsMs: T - dt, source: 'opensky' });
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('merge: newest sample <= t wins across sources', () => {
  const m = byId(
    mergeAircraft(
      [a('x', 10_000), a('y', 40_000)],
      [o('x', 30_000), o('y', 6_000)],
      T,
    ),
  );
  assert.equal(m.x.source, 'adsblol'); // adsb.lol 20 s newer
  assert.equal(m.y.source, 'opensky'); // opensky 34 s newer
});

test('merge: within 5 s OpenSky wins, either direction', () => {
  const m = byId(
    mergeAircraft(
      [
        a('older', 10_000),
        a('newer', 14_000),
        a('edge', 10_000),
        a('past', 10_000),
      ],
      [
        o('older', 14_000),
        o('newer', 10_000),
        o('edge', 10_000 + MERGE_TIE_MS),
        o('past', 10_000 + MERGE_TIE_MS + 1),
      ],
      T,
    ),
  );
  assert.equal(m.older.source, 'opensky'); // opensky 4 s older: tie
  assert.equal(m.newer.source, 'opensky');
  assert.equal(m.edge.source, 'opensky'); // exactly 5 s
  assert.equal(m.past.source, 'adsblol'); // 5.001 s older: adsb.lol
});

test('merge: one source missing keeps the other; union of ids', () => {
  assert.deepEqual(
    mergeAircraft([a('p', 1), a('q', 1)], [], T).map((r) => r.source),
    ['adsblol', 'adsblol'],
  );
  assert.deepEqual(
    mergeAircraft([], [o('p', 1)], T).map((r) => r.source),
    ['opensky'],
  );
  const m = mergeAircraft([a('p', 1)], [o('q', 1)], T);
  assert.deepEqual(m.map((r) => r.id).sort(), ['p', 'q']);
  assert.equal(sourcesPresent(m), 'adsblol,opensky');
  assert.equal(sourcesPresent([]), '');
});

test('merge: samples after t are never shown; newest per source first', () => {
  const m = byId(
    mergeAircraft(
      [a('x', -1_000), a('x', 50_000)],
      [o('x', -20_000), o('y', -1)],
      T,
    ),
  );
  assert.equal(m.x.source, 'adsblol');
  assert.equal(m.x.tsMs, T - 50_000);
  assert.equal(m.y, undefined);
});

test('adsb.lol snap = largest 60 s bucket end <= t (epoch s)', () => {
  assert.equal(adsblolSnapAtOrBefore(T), Date.UTC(2026, 9, 13, 19, 46) / 1000);
  assert.equal(
    adsblolSnapAtOrBefore(Date.UTC(2026, 9, 13, 19, 46)),
    Date.UTC(2026, 9, 13, 19, 46) / 1000,
  );
  assert.equal(
    adsblolSnapAtOrBefore(Date.UTC(2026, 9, 13, 19, 46) - 1),
    Date.UTC(2026, 9, 13, 19, 45) / 1000,
  );
});

test('snap nearest: military poll = newest snap <= t within 3 x cadence', () => {
  const polls = [T - 200_000, T - 100_000, T - 40_000, T + 5_000];
  assert.equal(pickPollSnap(polls, T), T - 40_000);
  assert.equal(pickPollSnap([T - 180_000], T), T - 180_000);
  assert.equal(pickPollSnap([T - 180_001], T), null); // gap -> fallback
  assert.equal(pickPollSnap([T + 1], T), null); // never a future poll
  assert.equal(pickPollSnap([], T), null);
});

test('snap nearest: n nearest of before/after lists, ascending, deduped', () => {
  assert.deepEqual(
    nearestSnaps([90, 80, 70], [105, 130], 100, 3),
    [90, 105, 80].sort((x, y) => x - y),
  );
  assert.deepEqual(nearestSnaps([100, 90], [110], 100, 2), [90, 100]);
  assert.deepEqual(nearestSnaps([95, 95], [], 100, 5), [95]);
  // equal distance: earlier first
  assert.deepEqual(nearestSnaps([90], [110], 100, 1), [90]);
});

test('snap nearest: adsb.lol bucket ends never after the newest import', () => {
  const m = Date.UTC(2026, 9, 13, 23, 59);
  const latest = Date.UTC(2026, 9, 14, 0, 0);
  assert.deepEqual(nearestAdsblolSnaps(m + 20_000, 3, latest), [
    m - 60_000,
    m,
    latest,
  ]);
  assert.deepEqual(nearestAdsblolSnaps(latest + 3_600_000, 2, latest), [
    latest - 60_000,
    latest,
  ]);
});

test('stale union: unchanged aircraft come from earlier polls, bounded by age', () => {
  const S = T;
  const primary = [{ id: 'live', tsMs: S - 1_000 }];
  const prior = [
    { id: 'live', tsMs: S - 61_000 }, // already in the poll at S
    { id: 'held', tsMs: S - 170_000 }, // unchanged position, still listed
    { id: 'held', tsMs: S - 230_000 },
    { id: 'gone', tsMs: S - 181_000 }, // older than 180 s: left
  ];
  const rows = byId(staleUnion(primary, prior, S));
  assert.deepEqual(Object.keys(rows).sort(), ['held', 'live']);
  assert.equal(rows.live.tsMs, S - 1_000);
  assert.equal(rows.held.tsMs, S - 170_000);
});

test('tile/bbox intersection (closed boxes)', () => {
  const tile = { w: -100, s: 20, e: -80, n: 35 };
  assert.ok(boxesIntersect(tile, { w: -98.5, s: 29, e: -96.5, n: 30.5 }));
  assert.ok(boxesIntersect(tile, { w: -80, s: 35, e: -70, n: 40 })); // corner
  assert.ok(!boxesIntersect(tile, { w: -79.9, s: 20, e: -70, n: 40 }));
});
