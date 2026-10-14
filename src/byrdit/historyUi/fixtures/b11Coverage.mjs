/**
 * Known-gap coverage + snapshot fixture for the History control (card B11
 * acceptance: "known-gap fixture renders hatched + HUD text"). Shapes follow
 * the B9 routes exactly (historyService.js coverage() / snapshots()):
 *
 *   aircraft  lanes [{source:'adsblol', bucket:'1d', latest, buckets:[{t,
 *             docs, verifiedDocs, status, complete}]}, {source:'opensky',
 *             bucket, buckets:[{t, polls_ok, polls_expected:null, docs,
 *             tiles?}], tilesOmitted}], gaps: []
 *   military  lanes [{source:'collector', bucket, buckets:[{t, polls_ok,
 *             polls_expected, docs}]}], gaps:[{from, to}]
 *   snapshots {feed, around, snaps:[{t, epochMs, source}]}
 *
 * The recorded world, relative to `now` (minute-aligned):
 *   - adsb.lol days: complete up to 3 days ago, the 2nd-before-yesterday day
 *     MISSING (a known gap), yesterday unverified, today pending
 *   - military + OpenSky polls every 60 s, except the gap
 *     [now - 2 h + 2 min, now - 2 h + 9 min) where nothing was recorded and
 *     the gap detector wrote {from, to}
 *   - OpenSky tiles: one Texas tile + one world tile at each polled bucket
 *
 * Options (review R1/R3 regressions):
 *   aircraftContinuous  aircraft (OpenSky) recorded straight through the
 *                       military gap: only the Military lane has the gap
 *   mixedSources        aircraft /snapshots lists every time TWICE (as
 *                       'adsblol' and 'opensky'), like B9 historyService
 *                       snapshots(): per-source n nearest merged, sliced to n
 */
const MIN = 60_000;
const DAY = 86_400_000;
const BUCKETS = {
  '1m': MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '1h': 60 * MIN,
  '6h': 360 * MIN,
  '1d': DAY,
};
export const TEXAS_TILE = [-106.6, 25.8, -93.5, 36.5];

export function fixtureWorld(
  now,
  { aircraftContinuous = false, mixedSources = false } = {},
) {
  const base = Math.floor(now / MIN) * MIN;
  const gapFrom = base - 2 * 60 * MIN + 2 * MIN;
  const gapTo = base - 2 * 60 * MIN + 9 * MIN;
  const today = Math.floor(now / DAY) * DAY;
  return {
    now,
    gap: { from: gapFrom, to: gapTo },
    missingDay: today - 3 * DAY,
    unverifiedDay: today - DAY,
    today,
    firstPoll: today - 30 * DAY,
    aircraftContinuous,
    mixedSources,
  };
}

const iso = (ms) => new Date(ms).toISOString();
const recordedAt = (w, t, feed = 'military') =>
  t >= w.firstPoll &&
  t <= w.now &&
  ((feed === 'aircraft' && w.aircraftContinuous) ||
    !(t >= w.gap.from && t < w.gap.to));

function adsblolDays(w, from, to) {
  const out = [];
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
    let status = 'complete';
    if (d === w.missingDay || d >= w.today) status = 'missing';
    else if (d === w.unverifiedDay) status = 'unverified';
    const docs = status === 'missing' ? 0 : 3_300_000;
    out.push({
      t: iso(d),
      docs,
      verifiedDocs: status === 'complete' ? docs : null,
      status,
      complete: status === 'complete',
    });
  }
  return out;
}

function pollBuckets(
  w,
  from,
  to,
  bucketMs,
  { tiles = false, expected = true, feed = 'military' } = {},
) {
  const out = [];
  for (let b = from; b < to; b += bucketMs) {
    let polls = 0;
    for (let t = b; t < b + bucketMs; t += MIN)
      if (recordedAt(w, t, feed)) polls++;
    const bucket = {
      t: iso(b),
      polls_ok: polls,
      polls_expected: expected ? Math.floor(bucketMs / MIN) : null,
      docs: polls * 400,
    };
    if (tiles && polls > 0 && to - from <= 7 * DAY) bucket.tiles = [TEXAS_TILE];
    out.push(bucket);
  }
  return out;
}

/** /api/history/coverage answer for the fixture world. */
export function coverageFixture(w, { feed, from, to, bucket }) {
  const bucketMs = BUCKETS[bucket];
  const head = { feed, from: iso(from), to: iso(to), bucket };
  if (feed === 'aircraft') {
    const latest = w.today - MIN; // yesterday 23:59Z bucket end
    return {
      ...head,
      lanes: [
        {
          source: 'adsblol',
          bucket: '1d',
          latest: iso(latest),
          buckets: adsblolDays(w, from, to),
        },
        {
          source: 'opensky',
          bucket,
          buckets: pollBuckets(w, from, to, bucketMs, {
            tiles: true,
            expected: false,
            feed: 'aircraft',
          }),
          tilesOmitted: to - from > 7 * DAY,
        },
      ],
      gaps: [],
    };
  }
  return {
    ...head,
    lanes: [
      {
        source: 'collector',
        bucket,
        buckets: pollBuckets(w, from, to, bucketMs),
      },
    ],
    gaps:
      w.gap.to > from && w.gap.from < to
        ? [{ from: iso(w.gap.from), to: iso(w.gap.to) }]
        : [],
  };
}

/** /api/history/snapshots answer: exact n nearest recorded minutes. */
export function snapshotsFixture(w, { feed, around, n }) {
  const out = [];
  const start = Math.floor(around / MIN) * MIN;
  let lo = start;
  let hi = start + MIN;
  const limit = (3 * DAY) / MIN;
  for (let i = 0; out.length < n && i < limit; i++) {
    const dLo = around - lo;
    const dHi = hi - around;
    if (dLo <= dHi) {
      if (recordedAt(w, lo, feed)) out.push(lo);
      lo -= MIN;
    } else {
      if (recordedAt(w, hi, feed)) out.push(hi);
      hi += MIN;
    }
  }
  const source = feed === 'aircraft' ? 'opensky' : 'collector';
  let snaps = out.map((ms) => ({ t: iso(ms), epochMs: ms, source }));
  if (feed === 'aircraft' && w.mixedSources)
    snaps = out
      .flatMap((ms) => [
        { t: iso(ms), epochMs: ms, source: 'adsblol' },
        { t: iso(ms), epochMs: ms, source: 'opensky' },
      ])
      .sort(
        (a, b) =>
          Math.abs(a.epochMs - around) - Math.abs(b.epochMs - around) ||
          a.epochMs - b.epochMs,
      )
      .slice(0, n);
  return {
    feed,
    around: iso(around),
    snaps: snaps.sort((a, b) => a.epochMs - b.epochMs),
  };
}

/** A fetch(url) for /api/history/* answering from the fixture world. */
export function fixtureFetch(w, { calls = [] } = {}) {
  return async (input) => {
    const url = new URL(
      String(typeof input === 'string' ? input : input.url),
      'http://localhost',
    );
    calls.push(url.pathname + url.search);
    const q = Object.fromEntries(url.searchParams);
    const json = (body) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    if (url.pathname === '/api/history/coverage')
      return json(
        coverageFixture(w, {
          feed: q.feed,
          from: Date.parse(q.from),
          to: Date.parse(q.to),
          bucket: q.bucket,
        }),
      );
    if (url.pathname === '/api/history/snapshots')
      return json(
        snapshotsFixture(w, {
          feed: q.feed,
          around: Date.parse(q.around),
          n: Number(q.n),
        }),
      );
    return new Response('not found', { status: 404 });
  };
}
