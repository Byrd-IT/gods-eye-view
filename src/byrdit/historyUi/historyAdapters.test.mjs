import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HISTORY_ADAPTERS,
  adapterForPath,
  areaToBbox,
  historySourceLabel,
  rebaseDelta,
  rebaseIso,
  rebaseMs,
  rebaseSec,
  sliceUrl,
  snapLagSec,
  viewToBboxes,
} from './historyAdapters.js';
import { openSkyState, readsbBody, readsbRow } from '../history/historyRows.js';
import {
  openSkySnapshot,
  readsbSnapshot,
} from '../../sources/live/aircraft.js';
import { vesselSnapshot } from '../../sources/live/vessels.js';

const docs = JSON.parse(
  readFileSync(
    new URL('../history/fixtures/b9-es-docs.json', import.meta.url),
    'utf8',
  ),
);
const liveVessels = JSON.parse(
  readFileSync(
    new URL('../history/fixtures/b8-collector-vessels.body', import.meta.url),
    'utf8',
  ),
);
const src = (list) => list.map((h) => h._source);
const adapter = (id) => HISTORY_ADAPTERS.find((a) => a.id === id);
const answer = (body, headers = {}) => ({
  body,
  headers: Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  ),
});

// a recorded moment and the browser "now" it is shown at
const T = Date.parse('2026-10-13T19:46:40Z');
const NOW = Date.parse('2026-10-14T18:00:00.250Z');
const DELTA = NOW - T;

test('rebase arithmetic: delta = now - t, seconds rounded, non-numbers kept', () => {
  assert.equal(rebaseDelta(T, NOW), NOW - T);
  assert.equal(rebaseMs(1000, 500), 1500);
  assert.equal(rebaseMs(null, 500), null);
  assert.equal(rebaseMs('x', 500), 'x');
  assert.equal(rebaseMs(Number.NaN, 500), Number.NaN);
  // whole seconds: 1499 ms -> 1 s, 1500 ms -> 2 s
  assert.equal(rebaseSec(100, 1499), 101.499);
  assert.equal(rebaseSec(100, 1500), 101.5);
  assert.equal(rebaseSec(100, -1500), 98.5);
  assert.equal(rebaseSec(1_760_000_000, 3_600_000.4), 1_760_003_600); // ms grid
  assert.equal(rebaseSec(undefined, 1500), undefined);
  assert.equal(
    rebaseIso('2026-10-13T19:46:40.000Z', 60_000),
    '2026-10-13T19:47:40.000Z',
  );
  assert.equal(rebaseIso('', 60_000), '');
  assert.equal(rebaseIso('not a time', 60_000), 'not a time');
  assert.equal(rebaseIso(null, 60_000), null);
  // relative ages survive the rebase
  const a = T - 37_000;
  assert.equal(NOW - rebaseMs(a, DELTA), T - a);
});

test('routes: flights/military/vessels map to adapters; track routes do not', () => {
  assert.equal(adapterForPath('/api/flights').id, 'flights');
  assert.equal(adapterForPath('/api/flights/').id, 'flights');
  assert.equal(adapterForPath('/api/military').id, 'military');
  assert.equal(adapterForPath('/api/vessels').id, 'vessels');
  assert.equal(adapterForPath('/api/flights/track'), null);
  assert.equal(adapterForPath('/api/military/track'), null);
  assert.equal(adapterForPath('/api/vessels/track'), null);
  assert.equal(adapterForPath('/api/military-installations'), null);
  assert.equal(adapterForPath('/api/history/slice'), null);
  assert.deepEqual(
    HISTORY_ADAPTERS.map((a) => [a.id, a.layerId, a.sliceFeed]),
    [
      ['flights', 'flights', 'aircraft'],
      ['military', 'military', 'military'],
      ['vessels', 'ais-live-vessels', 'vessels'],
    ],
  );
});

test('D7: the flights view becomes the slice bbox; a crossing view is two boxes', () => {
  assert.deepEqual(viewToBboxes('-106.6,25.8,-93.5,36.5'), [
    '-106.6,25.8,-93.5,36.5',
  ]);
  assert.deepEqual(viewToBboxes('170,-10,-170,10'), [
    '170,-10,180,10',
    '-180,-10,-170,10',
  ]);
  assert.deepEqual(viewToBboxes('-180,-80,180,80'), ['-180,-80,180,80']);
  assert.deepEqual(viewToBboxes(null), [null]);
  assert.deepEqual(viewToBboxes('1,2,3'), [null]);
  assert.deepEqual(viewToBboxes('1,5,3,2'), [null]); // s >= n
  const url = new URL(
    'https://gev.example/api/flights?lat=30&lon=-97&view=-106.6,25.8,-93.5,36.5&vsid=vABCDEFGHIJ',
  );
  assert.deepEqual(adapter('flights').sliceParams(url), [
    { bbox: '-106.6,25.8,-93.5,36.5' },
  ]);
  assert.deepEqual(
    adapter('flights').sliceParams(new URL('https://g/api/flights')),
    [{}],
  );
  assert.equal(
    sliceUrl(adapter('flights'), { bbox: '-1,-2,3,4' }, T),
    '/api/history/slice?feed=aircraft&t=2026-10-13T19%3A46%3A40.000Z&bbox=-1%2C-2%2C3%2C4',
  );
});

test('D7: vessels take maxRows (capped at 15000) and the asked area', () => {
  const v = adapter('vessels');
  assert.deepEqual(
    v.sliceParams(new URL('https://g/api/vessels?maxRows=12000')),
    [{ maxRows: '12000' }],
  );
  assert.deepEqual(
    v.sliceParams(new URL('https://g/api/vessels?maxRows=99999')),
    [{ maxRows: '15000' }],
  );
  assert.deepEqual(v.sliceParams(new URL('https://g/api/vessels')), [
    { maxRows: '12000' },
  ]);
  const [p] = v.sliceParams(
    new URL(
      'https://g/api/vessels?maxRows=500&lat=29.7&lon=-95.3&radius_km=111.3',
    ),
  );
  assert.equal(p.maxRows, '500');
  const [w, s, e, n] = p.bbox.split(',').map(Number);
  assert.ok(Math.abs(s - 28.7) < 0.01 && Math.abs(n - 30.7) < 0.01);
  assert.ok(w < -95.3 && e > -95.3);
  assert.equal(areaToBbox(0, 179.9, 50), null); // crosses the antimeridian
  assert.equal(areaToBbox('x', 1, 1), null);
  assert.deepEqual(
    adapter('military').sliceParams(new URL('https://g/api/military')),
    [{}],
  );
});

test('flights adapter: the live parser reads the slice exactly like an equivalent live answer, times rebased', () => {
  const states = [
    ...src(docs.opensky).map((d) => openSkyState({ ...d, source: 'opensky' })),
    ...src(docs.adsblol).map((d) => openSkyState({ ...d, source: 'adsblol' })),
  ].filter(Boolean);
  assert.ok(states.length >= 6);
  const tSec = Math.round(T / 1000);
  const slice = answer(
    { time: tSec, states },
    {
      'X-History-Source': 'adsblol,opensky',
      'X-History-Rows': String(states.length),
      'X-History-Snap': String(T),
    },
  );
  const out = adapter('flights').adapt([slice], { t: T, nowMs: NOW });
  // what /api/flights would have said had t been now: same rows, times +
  // delta (kept to the millisecond: the motion clock is exact)
  const plus = (sec) => (sec * 1000 + DELTA) / 1000;
  const live = {
    time: plus(tSec),
    states: states.map((r) => {
      const x = r.slice(0, 18);
      x[3] = plus(r[3]);
      x[4] = plus(r[4]);
      return x;
    }),
  };
  const a = openSkySnapshot(out.body, { now: NOW, source: 'x' });
  const b = openSkySnapshot(live, { now: NOW, source: 'x' });
  assert.deepEqual(a, b);
  assert.equal(a.records.length, new Set(states.map((r) => r[0])).size);
  assert.equal(a.freshness, 'current');
  assert.ok(a.ageMs < 1000);
  // relative: each position is as old (vs now) as it was vs t
  for (const [i, r] of a.records.entries()) {
    const rec = states.find((s) => s[0].toLowerCase() === r.id);
    assert.equal(r.positionTimeMs - rec[3] * 1000, DELTA, `row ${i}`);
  }
  // element 18 (source) is kept; the live parser ignores it
  assert.ok(
    out.body.states.every((r) => ['adsblol', 'opensky'].includes(r[18])),
  );
  // D2: no age / stale headers for a rebased feed
  assert.equal(out.headers['X-Feed-Age-Ms'], undefined);
  assert.equal(out.headers['X-Feed-Cache'], undefined);
  assert.equal(out.headers['X-Feed-Source'], 'History: adsb.lol + OpenSky');
  assert.equal(out.headers['X-History-Gap'], undefined);
});

test('flights adapter: two boxes of a crossing view merge to one row per aircraft (newest contact)', () => {
  const row = (id, t) => [
    id,
    'CS',
    'X',
    t,
    t,
    179.9,
    0,
    1000,
    false,
    200,
    90,
    0,
    null,
    1000,
    null,
    false,
    0,
    0,
    'opensky',
  ];
  const out = adapter('flights').adapt(
    [
      answer({ time: 100, states: [row('a', 90), row('b', 95)] }),
      answer({ time: 101, states: [row('a', 99), row('c', 80)] }),
    ],
    { t: 101_000, nowMs: 101_000 },
  );
  assert.deepEqual(out.body.states.map((r) => [r[0], r[4]]).sort(), [
    ['a', 99],
    ['b', 95],
    ['c', 80],
  ]);
  assert.equal(out.body.time, 101);
});

test('military adapter: readsb rows parse like live; poll times rebased, seen_pos kept', () => {
  const snap = Date.parse('2026-10-14T14:21:08.500Z');
  const rows = src(docs.military)
    .map((d) => readsbRow(d, snap))
    .filter(Boolean);
  assert.ok(rows.length >= 4);
  const body = readsbBody(rows, snap);
  const out = adapter('military').adapt(
    [
      answer(body, {
        'X-History-Source': 'adsb.lol',
        'X-History-Snap': String(snap),
      }),
    ],
    { t: snap, nowMs: NOW },
  );
  assert.equal(out.body.now, snap + (NOW - snap));
  assert.equal(out.body.ctime, snap + (NOW - snap));
  assert.deepEqual(out.body.ac, rows);
  // the source passes observedAtMs = now() - X-Feed-Age-Ms (none sent here)
  assert.equal(out.headers['X-Feed-Age-Ms'], undefined);
  assert.equal(out.headers['X-Feed-Cache'], undefined);
  const a = readsbSnapshot(out.body, { observedAtMs: NOW, now: NOW });
  const live = { ...body, now: NOW, ctime: NOW };
  const b = readsbSnapshot(live, { observedAtMs: NOW, now: NOW });
  assert.deepEqual(a, b);
  for (const r of a.records) {
    const row = rows.find((x) => x.hex === r.id);
    assert.equal(NOW - r.positionTimeMs, Math.round(row.seen_pos * 1000));
  }
  assert.equal(out.headers['X-Feed-Source'], 'History: adsb.lol');
  // archive fallback is named
  const fb = adapter('military').adapt(
    [
      answer(body, {
        'X-History-Source': 'adsblol',
        'X-History-Fallback': 'adsblol-dbflags',
      }),
    ],
    { t: snap, nowMs: NOW },
  );
  assert.equal(fb.headers['X-Feed-Source'], 'History: adsb.lol archive');
  assert.equal(fb.headers['X-History-Fallback'], 'adsblol-dbflags');
});

test('R2 military: a snapshot older than t keeps its true age at t (live + archive)', () => {
  const snap = Date.parse('2026-10-14T14:21:08.500Z');
  const t = snap + 150_000; // the slice answers the snap 150 s before t
  assert.equal(snapLagSec(t, snap), 150);
  assert.equal(snapLagSec(snap, snap), 0);
  assert.equal(snapLagSec(t, Number.NaN), 0);
  assert.equal(snapLagSec(snap - 1, snap), 0); // never negative
  const rows = src(docs.military)
    .map((d) => readsbRow(d, snap))
    .filter(Boolean);
  // one fix exactly 4 s before the snap
  rows[0] = { ...rows[0], seen_pos: 4, seen: 2 };
  for (const extra of [{}, { 'X-History-Fallback': 'adsblol-dbflags' }]) {
    const out = adapter('military').adapt(
      [
        answer(readsbBody(rows, snap), {
          'X-History-Source': 'adsb.lol',
          ...extra,
        }),
      ],
      { t, nowMs: NOW },
    );
    assert.equal(out.body.now, NOW);
    assert.equal(out.body.ctime, NOW);
    // the real live source: observedAtMs = receipt now, no age header (D2)
    const a = readsbSnapshot(out.body, { observedAtMs: NOW, now: NOW });
    const r0 = a.records.find((r) => r.id === rows[0].hex);
    assert.equal(NOW - r0.positionTimeMs, 154_000); // 4 s + 150 s, not 4 s
    assert.equal(NOW - r0.contactTimeMs, 152_000);
    for (const r of a.records) {
      const row = rows.find((x) => x.hex === r.id);
      assert.equal(
        NOW - r.positionTimeMs,
        Math.round((row.seen_pos + 150) * 1000),
      );
    }
    assert.equal(out.headers['X-Feed-Age-Ms'], undefined);
  }
});

test('vessels adapter: rows parse like live; per-row times stay recorded (shown as clock), poll times rebased', () => {
  const hist = {
    ...liveVessels,
    rows: liveVessels.rows.map((r) => ({ ...r, source: 'aisstream' })),
    source: 'history',
    status: 'history',
    lastMessageAt: null,
    silentForMs: null,
    reconnectAttempt: null,
    staleAfterMs: 35 * 60_000,
    watchdog: null,
  };
  const t = Date.parse(liveVessels.newestPositionAt) + 30_000;
  const out = adapter('vessels').adapt(
    [
      answer(hist, {
        'X-History-Source': 'aisstream',
        'X-History-Rows': '300',
      }),
    ],
    { t, nowMs: NOW },
  );
  const a = vesselSnapshot(out.body, { source: 'x' });
  const b = vesselSnapshot(liveVessels, { source: 'x' });
  assert.deepEqual(a.records, b.records); // recorded position times, unchanged
  assert.equal(a.observedAtMs, b.observedAtMs + (NOW - t)); // poll time rebased
  assert.equal(a.freshness, 'current');
  assert.equal(a.stale, false);
  assert.equal(a.transportStatus, 'live');
  assert.equal(out.headers['X-Feed-Source'], 'History: AISStream');
  assert.equal(out.body.lastMessageAt, a.observedAtMs);
});

test('D3: a gap / empty slice is an empty live answer for every feed', () => {
  const t = T;
  const f = adapter('flights').adapt(
    [
      answer(
        { time: Math.round(t / 1000), states: [] },
        { 'X-History-Gap': '1', 'X-History-Source': 'none' },
      ),
    ],
    { t, nowMs: NOW },
  );
  assert.deepEqual(f.body.states, []);
  assert.equal(f.headers['X-History-Gap'], '1');
  assert.equal(openSkySnapshot(f.body, { now: NOW }).records.length, 0);

  const m = adapter('military').adapt([answer(readsbBody([], t))], {
    t,
    nowMs: NOW,
  });
  assert.deepEqual(m.body.ac, []);
  assert.equal(m.headers['X-History-Gap'], '1');
  assert.equal(
    readsbSnapshot(m.body, { observedAtMs: NOW, now: NOW }).records.length,
    0,
  );

  const v = adapter('vessels').adapt(
    [
      answer({
        rows: [],
        source: 'history',
        status: 'history',
        newestPositionAt: null,
      }),
    ],
    { t, nowMs: NOW },
  );
  const snap = vesselSnapshot(v.body);
  assert.equal(snap.records.length, 0);
  assert.equal(v.headers['X-History-Gap'], '1');
  // the vessels layer clears on an empty answer only for a healthy, current,
  // complete feed with a message time (queries.js classifyAisFeedSnapshot
  // emptyCoverage); otherwise it KEEPS the rows of the previous time
  assert.equal(snap.rawRowCount, 0);
  assert.equal(snap.complete, true);
  assert.equal(snap.freshness, 'current');
  assert.ok(['live', 'open'].includes(snap.transportStatus));
  assert.ok(Number(snap.lastMessageAt) > 0);
});

test('history source labels', () => {
  assert.equal(historySourceLabel('none'), 'History');
  assert.equal(historySourceLabel(''), 'History');
  assert.equal(
    historySourceLabel('opensky,adsblol,opensky'),
    'History: OpenSky + adsb.lol',
  );
  assert.ok(historySourceLabel('x'.repeat(200)).length <= 80);
});
