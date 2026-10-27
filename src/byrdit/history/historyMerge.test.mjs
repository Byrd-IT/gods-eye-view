import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MERGE_TIE_MS,
  MILITARY_CADENCE_MS,
  MILITARY_MAX_SNAP_AGE_MS,
  STALE_POSITION_MAX_MS,
  STALE_UNION_SPAN_MS,
  adsblolSnapAtOrBefore,
  boxesIntersect,
  mergeAircraft,
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
  assert.equal(pickPollSnap([T - 900_000], T), T - 900_000);
  assert.equal(pickPollSnap([T - 900_001], T), null); // gap -> fallback
  assert.equal(pickPollSnap([T + 1], T), null); // never a future poll
  assert.equal(pickPollSnap([], T), null);
});

test('military cadence 300 s (t_5ad2b9a4): 3 x rule = 900 s max snap age', () => {
  assert.equal(MILITARY_CADENCE_MS, 300_000);
  assert.equal(MILITARY_MAX_SNAP_AGE_MS, 3 * MILITARY_CADENCE_MS);
  assert.equal(MILITARY_MAX_SNAP_AGE_MS, 900_000);
  // a poll 250 s before t IS the poll at t (under the old 60 s rule, 180 s
  // max age, it was a recording gap and t fell back to the archive)
  assert.equal(pickPollSnap([T - 250_000], T), T - 250_000);
  // polls every 300 s: every instant between two polls maps to the earlier
  // one, never to the archive, and never to the later (future) poll
  const polls = [T - 600_000, T - 300_000, T];
  for (let dt = 0; dt < 300_000; dt += 10_000)
    assert.equal(pickPollSnap(polls, T - 300_000 + dt), T - 300_000, `dt ${dt}`);
  // two missed polls (last poll 900 s back) still serve; a third does not
  assert.equal(pickPollSnap([T - 900_000], T), T - 900_000);
  assert.equal(pickPollSnap([T - 900_001], T), null);
});

test('stale union limits: span covers the position age, independent of cadence', () => {
  // a held position (time F) was first written by the first poll >= F, so a
  // span >= the position-age limit always reaches it (historyMerge.js note)
  assert.ok(STALE_UNION_SPAN_MS >= STALE_POSITION_MAX_MS);
  assert.equal(STALE_POSITION_MAX_MS, 180_000);
  assert.equal(STALE_UNION_SPAN_MS, 300_000);
});

test('stale union at 300 s polls: prior poll rows add only positions <= 180 s old', () => {
  const S = T;
  const primary = [{ id: 'live', tsMs: S - 20_000 }];
  // the previous poll was at S - 300 s: its positions are all <= S - 300 s
  const prior = [
    { id: 'live', tsMs: S - 310_000 }, // also in the poll at S
    { id: 'left', tsMs: S - 305_000 }, // not in the poll at S: gone
    { id: 'jitter', tsMs: S - 179_000 }, // an earlier poll < 300 s back (restart)
  ];
  const rows = byId(staleUnion(primary, prior, S));
  assert.deepEqual(Object.keys(rows).sort(), ['jitter', 'live']);
  assert.equal(rows.live.tsMs, S - 20_000);
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
