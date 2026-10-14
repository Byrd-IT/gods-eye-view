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
