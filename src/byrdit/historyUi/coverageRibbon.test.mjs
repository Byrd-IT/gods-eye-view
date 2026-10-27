import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adsblolEndText,
  buildRibbon,
  formatGapRange,
  gapsAt,
  hudLines,
  normalizeSegments,
  openskyTilesAt,
  overlay,
  parseGaps,
  snapBlockedAt,
  toMs,
} from './coverageRibbon.js';
import {
  DAY_MS,
  HISTORY_SPAN_MS,
  MINUTE_MS,
  coverageRange,
  windowAround,
} from './historyTimeline.js';
import {
  TEXAS_TILE,
  coverageFixture,
  fixtureWorld,
} from './fixtures/b11Coverage.mjs';

const NOW = Date.parse('2026-10-14T16:00:00Z');
const W = fixtureWorld(NOW);

function ribbonFor(win, now = NOW) {
  const r = coverageRange(win, now);
  return buildRibbon({
    win,
    now,
    aircraft: coverageFixture(W, { feed: 'aircraft', ...r }),
    military: coverageFixture(W, { feed: 'military', ...r }),
  });
}

test('toMs reads ISO, epoch ms and epoch seconds', () => {
  assert.equal(
    toMs('2026-10-14T14:02:00.000Z'),
    Date.parse('2026-10-14T14:02:00Z'),
  );
  assert.equal(toMs(1791993600000), 1791993600000);
  assert.equal(toMs(1791993600), 1791993600000);
  assert.equal(toMs('1791993600000'), 1791993600000);
  assert.equal(toMs(null), null);
  assert.equal(toMs('nope'), null);
});

test('segments merge, clip and overlay', () => {
  const merged = normalizeSegments(
    [
      { from: 0, to: 10, kind: 'recorded' },
      { from: 10, to: 20, kind: 'recorded' },
      { from: 20, to: 30, kind: 'none' },
      { from: -5, to: 0, kind: 'recorded' },
    ],
    0,
    25,
  );
  assert.deepEqual(merged, [
    { from: 0, to: 20, kind: 'recorded' },
    { from: 20, to: 25, kind: 'none' },
  ]);
  assert.deepEqual(
    overlay(
      [{ from: 0, to: 30, kind: 'recorded' }],
      [{ from: 10, to: 12, kind: 'gap' }],
    ),
    [
      { from: 0, to: 10, kind: 'recorded' },
      { from: 10, to: 12, kind: 'gap' },
      { from: 12, to: 30, kind: 'recorded' },
    ],
  );
});

test('known-gap fixture: military gap is hatched exactly 14:02-14:09 and named by the HUD', () => {
  const win = windowAround(NOW - 2 * 3_600_000, DAY_MS, NOW);
  const ribbon = ribbonFor(win);
  const military = ribbon.lanes.find((l) => l.id === 'military');
  const gap = military.segments.find((s) => s.kind === 'gap');
  assert.equal(new Date(gap.from).toISOString(), '2026-10-14T14:02:00.000Z');
  assert.equal(new Date(gap.to).toISOString(), '2026-10-14T14:09:00.000Z');
  // recorded on both sides
  assert.equal(
    military.segments[military.segments.indexOf(gap) - 1].kind,
    'recorded',
  );
  assert.equal(
    military.segments[military.segments.indexOf(gap) + 1].kind,
    'recorded',
  );

  const inGap = Date.parse('2026-10-14T14:05:00Z');
  assert.deepEqual(
    gapsAt(inGap, ribbon).map((g) => g.lane),
    ['military'],
  );
  const lines = hudLines(inGap, ribbon, NOW);
  assert.ok(
    lines.includes(
      'No recording at this time (gap 14:02-14:09 UTC) - Military',
    ),
    lines.join(' | '),
  );
  // gap end is exclusive; just outside it the HUD has no gap line
  assert.equal(gapsAt(Date.parse('2026-10-14T14:09:00Z'), ribbon).length, 0);
  assert.equal(gapsAt(Date.parse('2026-10-14T14:01:59Z'), ribbon).length, 0);
});

test('aircraft: two lanes; adsb.lol day status -> kind (unverified is NOT a gap)', () => {
  const win = { from: NOW - 5 * DAY_MS, to: NOW };
  const ribbon = ribbonFor(win);
  assert.deepEqual(
    ribbon.lanes.map((l) => l.id),
    ['adsblol', 'opensky', 'military'],
  );
  const ads = ribbon.lanes.find((l) => l.id === 'adsblol');
  const kindAt = (t) => ads.segments.find((s) => t >= s.from && t < s.to)?.kind;
  assert.equal(kindAt(W.missingDay + 3_600_000), 'gap');
  assert.equal(kindAt(W.unverifiedDay + 3_600_000), 'unverified');
  assert.equal(kindAt(W.missingDay - 3_600_000), 'recorded');
  assert.equal(
    kindAt(W.today + 3_600_000),
    'pending',
    'today is not a gap yet',
  );
  // the missing day is a named gap
  const lines = hudLines(W.missingDay + 3_600_000, ribbon, NOW);
  assert.ok(
    lines.includes(
      'No recording at this time (gap 2026-10-11 00:00-2026-10-12 00:00 UTC) - adsb.lol',
    ),
    lines.join(' | '),
  );
});

test('a just-ended adsb.lol day stays pending inside the publish grace', () => {
  const now = Date.parse('2026-10-14T02:00:00Z'); // 2 h after the day ended
  const win = { from: now - 2 * DAY_MS, to: now };
  const ribbon = buildRibbon({
    win,
    now,
    aircraft: {
      lanes: [
        {
          source: 'adsblol',
          bucket: '1d',
          latest: null,
          buckets: [
            { t: '2026-10-12T00:00:00.000Z', docs: 10, status: 'unverified' },
            { t: '2026-10-13T00:00:00.000Z', docs: 0, status: 'missing' },
            { t: '2026-10-14T00:00:00.000Z', docs: 0, status: 'missing' },
          ],
        },
      ],
    },
  });
  const ads = ribbon.lanes[0];
  assert.deepEqual(
    [...new Set(ads.segments.map((s) => s.kind))],
    ['unverified', 'pending'],
  );
  assert.equal(ribbon.gaps.length, 0);
});

test('outside retention is blank whatever the answer says', () => {
  const now = NOW;
  const win = {
    from: now - HISTORY_SPAN_MS - 10 * DAY_MS,
    to: now - HISTORY_SPAN_MS + 10 * DAY_MS,
  };
  const ribbon = buildRibbon({
    win,
    now,
    military: {
      lanes: [
        {
          source: 'collector',
          bucket: '1d',
          buckets: Array.from({ length: 20 }, (_, i) => ({
            t: new Date(win.from + i * DAY_MS).toISOString(),
            polls_ok: 1440,
          })),
        },
      ],
      gaps: [],
    },
  });
  const lane = ribbon.lanes[0];
  const first = lane.segments.find((s) => s.from === win.from);
  assert.equal(first.kind, 'none');
  assert.equal(first.to, now - HISTORY_SPAN_MS);
  assert.equal(lane.segments.at(-1).kind, 'recorded');
});

test('OpenSky lane: blank where not polled, tiles at t for the outlines', () => {
  const win = windowAround(NOW - 2 * 3_600_000, DAY_MS, NOW);
  const ribbon = ribbonFor(win);
  const os = ribbon.lanes.find((l) => l.id === 'opensky');
  assert.ok(os.segments.some((s) => s.kind === 'recorded'));
  assert.ok(
    !os.segments.some((s) => s.kind === 'gap'),
    'unpolled OpenSky is blank, not a gap',
  );
  assert.deepEqual(openskyTilesAt(NOW - 3 * 3_600_000, ribbon), [TEXAS_TILE]);
  // 1 h window = 1 min buckets: inside the gap no tile was polled
  const fine = ribbonFor(
    windowAround(Date.parse('2026-10-14T14:05:00Z'), 3_600_000, NOW),
  );
  assert.deepEqual(
    openskyTilesAt(Date.parse('2026-10-14T14:05:30Z'), fine),
    [],
  );
  assert.deepEqual(openskyTilesAt(Date.parse('2026-10-14T14:09:30Z'), fine), [
    TEXAS_TILE,
  ]);
});

test('today: "adsb.lol history ends yesterday 23:59Z; OpenSky only where you looked"', () => {
  const ribbon = ribbonFor({ from: NOW - DAY_MS, to: NOW });
  assert.equal(
    adsblolEndText(NOW - 3_600_000, ribbon, NOW),
    'adsb.lol history ends yesterday 23:59Z; OpenSky only where you looked',
  );
  assert.equal(adsblolEndText(W.unverifiedDay + 3_600_000, ribbon, NOW), null);
  // an import lagging two days names its real end
  const lagging = buildRibbon({
    win: { from: NOW - DAY_MS, to: NOW },
    now: NOW,
    aircraft: {
      lanes: [
        {
          source: 'adsblol',
          bucket: '1d',
          latest: '2026-10-12T23:59:00.000Z',
          buckets: [],
        },
      ],
    },
  });
  assert.equal(
    adsblolEndText(NOW - 3_600_000, lagging, NOW),
    'adsb.lol history ends 2026-10-12 23:59Z; OpenSky only where you looked',
  );
});

test('gap records: epoch or ISO, open gap runs to now', () => {
  const g = parseGaps(
    [
      { from: 1791990000000, to: null },
      { from: '2026-10-14T14:02:00Z', to: '2026-10-14T14:09:00Z' },
      { from: null },
    ],
    NOW,
  );
  assert.equal(g.length, 2);
  assert.equal(g[0].open, true);
  assert.equal(g[0].to, NOW);
  assert.equal(
    formatGapRange(g[0].from, g[0].to, g[0]),
    '2026-10-14 15:00-now UTC',
  );
  assert.equal(formatGapRange(g[1].from, g[1].to), '14:02-14:09 UTC');
  assert.equal(
    formatGapRange(
      Date.parse('2026-10-13T23:50:00Z'),
      Date.parse('2026-10-14T00:10:00Z'),
    ),
    '2026-10-13 23:50-2026-10-14 00:10 UTC',
  );
  assert.equal(MINUTE_MS, 60_000);
});

test("snap is blocked per feed: only that feed's gap, and only with no other lane recorded (review R3)", () => {
  const at = Date.parse('2026-10-14T14:05:25Z');
  const day = ribbonFor({ from: NOW - DAY_MS, to: NOW });
  assert.equal(gapsAt(at, day).length, 1, 'the Military gap');
  assert.equal(snapBlockedAt('military', at, day), true);
  assert.equal(snapBlockedAt('aircraft', at, day), false, 'not a Military gap');
  assert.equal(snapBlockedAt('aircraft', at, null), false, 'no coverage yet');
  // adsb.lol missing day: OpenSky polled that day -> aircraft still snaps
  const week = ribbonFor({ from: NOW - 5 * DAY_MS, to: NOW });
  const inMissing = W.missingDay + 3_600_000;
  assert.equal(snapBlockedAt('aircraft', inMissing, week), false);
  // ... and with OpenSky blank too, the aircraft feed is blocked
  const blank = {
    ...week,
    lanes: week.lanes.map((l) =>
      l.id === 'opensky'
        ? {
            ...l,
            segments: [
              { from: week.lanes[0].segments[0].from, to: NOW, kind: 'none' },
            ],
          }
        : l,
    ),
  };
  assert.equal(snapBlockedAt('aircraft', inMissing, blank), true);
  assert.equal(snapBlockedAt('military', inMissing, blank), false);
});

// ---------- buckets shorter than the cadence (review t_77c13cca F1)
// Military polls every 300 s; the ribbon uses 1m buckets for windows up to
// ~16.6 h, so 4 of 5 buckets hold no poll. Each poll is painted ONE cadence
// forward (lane cadence_ms); a missed poll still leaves a hole.
const H0 = Date.parse('2026-10-14T13:00:00Z');
const HOUR = 60 * MINUTE_MS;
function militaryAnswer({
  bucketMs = MINUTE_MS,
  cadenceMs = 300_000, // lane cadence_ms (null: field absent)
  pollMs = cadenceMs ?? 300_000, // the recorder polls at every multiple
  skip = [], // missed poll offsets from H0
  gaps = [],
  extra = {},
} = {}) {
  const buckets = [];
  for (let t = H0; t < H0 + HOUR; t += bucketMs) {
    let polls = 0;
    for (let off = 0; off < HOUR; off += pollMs)
      if (off >= t - H0 && off < t - H0 + bucketMs && !skip.includes(off))
        polls++;
    buckets.push({
      t: new Date(t).toISOString(),
      polls_ok: polls,
      polls_expected: cadenceMs ? Math.floor(bucketMs / cadenceMs) : null,
      docs: polls * 300,
    });
  }
  const bucket = { [MINUTE_MS]: '1m', [5 * MINUTE_MS]: '5m' }[bucketMs];
  const lane = { source: 'collector', bucket, buckets, ...extra };
  if (cadenceMs !== null) lane.cadence_ms = cadenceMs;
  return { feed: 'military', bucket, lanes: [lane], gaps };
}
const milSegments = (military, now = H0 + 2 * HOUR) =>
  buildRibbon({ win: { from: H0, to: H0 + HOUR }, now, military })
    .lanes.find((l) => l.id === 'military')
    .segments.map((s) => [
      (s.from - H0) / MINUTE_MS,
      (s.to - H0) / MINUTE_MS,
      s.kind,
    ]);

test('1h window, 1m buckets, 300 s polls: 100 % recorded (was 20 % stripes)', () => {
  assert.deepEqual(milSegments(militaryAnswer()), [[0, 60, 'recorded']]);
  // without cadence_ms (pre-fix server answer, the reviewer's probe shape)
  // the lane keeps the old 1-min recorded / 4-min blank stripes
  const old = milSegments(militaryAnswer({ cadenceMs: null, pollMs: 300_000 }));
  assert.equal(old.length, 24);
  assert.deepEqual(old.slice(0, 2), [
    [0, 1, 'recorded'],
    [1, 5, 'none'],
  ]);
});

test('1m buckets, 300 s polls: one missed poll leaves exactly a 5-min none hole', () => {
  assert.deepEqual(milSegments(militaryAnswer({ skip: [20 * MINUTE_MS] })), [
    [0, 20, 'recorded'],
    [20, 25, 'none'],
    [25, 60, 'recorded'],
  ]);
  // two missed polls: 10 min, still not bridged by the 900 s snap age
  assert.deepEqual(
    milSegments(militaryAnswer({ skip: [20 * MINUTE_MS, 25 * MINUTE_MS] })),
    [
      [0, 20, 'recorded'],
      [20, 30, 'none'],
      [30, 60, 'recorded'],
    ],
  );
});

test('1m buckets: the hold runs one cadence from last_ok and prev_ok covers the left edge', () => {
  const ans = militaryAnswer({
    skip: [0, 20 * MINUTE_MS],
    extra: { prev_ok: new Date(H0 - 4 * MINUTE_MS - 30_000).toISOString() },
  });
  // polls land 50 s into their minute
  for (const b of ans.lanes[0].buckets)
    if (b.polls_ok)
      b.last_ok = new Date(Date.parse(b.t) + 50_000).toISOString();
  const segs = buildRibbon({
    win: { from: H0, to: H0 + HOUR },
    now: H0 + 2 * HOUR,
    military: ans,
  }).lanes.find((l) => l.id === 'military').segments;
  assert.deepEqual(
    segs.map((s) => [s.from - H0, s.to - H0, s.kind]),
    [
      // prev poll at -4:30 holds to 0:30; poll at 0:00 missed; 5:50 next
      [0, 30_000, 'recorded'],
      [30_000, 5 * MINUTE_MS, 'none'],
      // 15:50 holds to 20:50; the 20 min poll missed; 25:50 next
      [5 * MINUTE_MS, 20 * MINUTE_MS + 50_000, 'recorded'],
      [20 * MINUTE_MS + 50_000, 25 * MINUTE_MS, 'none'],
      [25 * MINUTE_MS, HOUR, 'recorded'],
    ],
  );
});

test('1m buckets, 60 s cadence: identical to the answer without a hold', () => {
  const sixty = militaryAnswer({ cadenceMs: 60_000, skip: [20 * MINUTE_MS] });
  const plain = structuredClone(sixty);
  delete plain.lanes[0].cadence_ms;
  assert.deepEqual(milSegments(sixty), milSegments(plain));
  assert.deepEqual(milSegments(sixty), [
    [0, 20, 'recorded'],
    [20, 21, 'none'],
    [21, 60, 'recorded'],
  ]);
});

test('5m buckets, 300 s polls: unchanged (bucket = cadence, no hold)', () => {
  const five = militaryAnswer({
    bucketMs: 5 * MINUTE_MS,
    skip: [20 * MINUTE_MS],
  });
  const plain = structuredClone(five);
  delete plain.lanes[0].cadence_ms;
  assert.deepEqual(milSegments(five), milSegments(plain));
  assert.deepEqual(milSegments(five), [
    [0, 20, 'recorded'],
    [20, 25, 'none'],
    [25, 60, 'recorded'],
  ]);
});

test('1m buckets: a recorded gap still wins over a held poll; never held past now', () => {
  const gap = {
    from: new Date(H0 + 31 * MINUTE_MS).toISOString(),
    to: new Date(H0 + 33 * MINUTE_MS).toISOString(),
  };
  assert.deepEqual(milSegments(militaryAnswer({ gaps: [gap] })), [
    [0, 31, 'recorded'],
    [31, 33, 'gap'],
    [33, 60, 'recorded'],
  ]);
  // now = 32:00: the 30 min poll is held to now only, not to 35:00
  const ans = militaryAnswer();
  for (const b of ans.lanes[0].buckets)
    if (Date.parse(b.t) >= H0 + 32 * MINUTE_MS) {
      b.polls_ok = 0;
      b.docs = 0;
    }
  assert.deepEqual(milSegments(ans, H0 + 32 * MINUTE_MS), [
    [0, 32, 'recorded'],
    [32, 60, 'none'],
  ]);
});
