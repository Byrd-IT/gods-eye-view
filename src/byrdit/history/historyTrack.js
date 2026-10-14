import { HISTORY_INDICES as IDX } from './historyEs.js';
import { MERGE_TIE_MS } from './historyMerge.js';
import { MAX_TRACK_POINTS } from './historyParams.js';
import { docTimeMs } from './historyRows.js';

/**
 * GET /api/history/track (gev-history DESIGN 4.3; card B10 item 3).
 *
 * Shape = the OpenSky waypoint track GEV's normalizeAircraftTrack consumes:
 *   {icao24, startTime, endTime, path: [[t, lat, lon, alt, trk, onGround], ...]}
 * plus a 7th element per point, `source`, and {feed, id, sources}. t and
 * start/end are epoch SECONDS; alt is barometric metres (null when not
 * recorded, always null for vessels/transit); trk degrees (vessels: course
 * over ground, transit: bearing); onGround boolean for aircraft, null else.
 *
 * Aircraft merge both sources by time (rev 3): every non-OpenSky point
 * within MERGE_TIE_MS (5 s) of ANY OpenSky point collapses into the OpenSky
 * point (B10 review R1: not only the neighbouring one); same-source points
 * are never collapsed with each other.
 *
 * Reads (per source) use PIT + search_after sorted by @timestamp
 * (historyEs searchAll) while the range holds at most TRACK_READ_MAX docs
 * (31 d of 60 s adsb.lol buckets is 44,640). A DENSER range (B10 review
 * R3) is not read as its oldest prefix: one request samples the WHOLE
 * requested range instead, a date_histogram with one bucket per sampling
 * interval (>= range / MAX_TRACK_POINTS, >= minGapSec, aligned to `from`,
 * so at most MAX_TRACK_POINTS buckets) and the first doc of each bucket
 * (top_hits), plus the newest doc of the range (the true last point). The
 * answer then says X-History-Sampled: 1 (not Truncated: the range is
 * covered end to end). Thinning is server side: minGapSec (default:
 * range / 5,000, so a 24 h track keeps every 60 s bucket) drops points
 * closer than the gap to the previous kept point (first and last always
 * kept), then an even stride caps the answer at MAX_TRACK_POINTS.
 */

export const TRACK_READ_MAX = 50_000;

const range = (field, gte, lte) => ({
  range: { [field]: { gte, lte, format: 'epoch_millis' } },
});
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sourceOf = (hit) => hit?._source ?? {};

const AIRCRAFT_FIELDS = [
  '@timestamp',
  'location',
  'baro_alt_m',
  'track_deg',
  'on_ground',
  'source',
];

/**
 * Merge the points of several sources (any order) into one time-sorted
 * list: a point of another source within tieMs of ANY point of the
 * preferred source is dropped (it collapses into the preferred one, DESIGN
 * 4.3 rev 3); preferred points and points of the same source are never
 * dropped for each other. Ties in time sort by source (deterministic).
 * @param {{tMs: number, source: string}[]} points any order
 * @param {string} preferred source that wins a tie (opensky)
 */
export function mergeTrackPoints(
  points,
  preferred = 'opensky',
  tieMs = MERGE_TIE_MS,
) {
  const valid = points.filter((p) => Number.isFinite(p.tMs));
  const pref = valid
    .filter((p) => p.source === preferred)
    .map((p) => p.tMs)
    .sort((a, b) => a - b);
  // is there a preferred point in [t - tieMs, t + tieMs]? (binary search)
  const nearPreferred = (t) => {
    let lo = 0;
    let hi = pref.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pref[mid] < t - tieMs) lo = mid + 1;
      else hi = mid;
    }
    return lo < pref.length && pref[lo] <= t + tieMs;
  };
  return valid
    .filter((p) => p.source === preferred || !nearPreferred(p.tMs))
    .sort(
      (a, b) =>
        a.tMs - b.tMs ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    );
}

/**
 * Sampling interval of a range too dense to read whole: at least
 * range / (maxPoints - 1) (so a `from`-aligned histogram has at most
 * maxPoints buckets) and at least minGapMs; whole milliseconds.
 */
export function sampleIntervalMs(
  from,
  to,
  minGapMs = 0,
  maxPoints = MAX_TRACK_POINTS,
) {
  return Math.max(
    1,
    Math.ceil(minGapMs || 0),
    Math.ceil((to - from) / Math.max(1, maxPoints - 1)),
  );
}

/**
 * Keep points at least minGapMs apart (first and last always kept), then
 * an even stride down to maxPoints.
 */
export function thinTrack(points, minGapMs, maxPoints = MAX_TRACK_POINTS) {
  if (points.length <= 2) return points.slice();
  let kept = [];
  if (minGapMs > 0) {
    let lastT = -Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (i === 0 || p.tMs - lastT >= minGapMs) {
        kept.push(p);
        lastT = p.tMs;
      }
    }
    const end = points.at(-1);
    if (kept.at(-1) !== end) kept.push(end);
  } else kept = points.slice();
  if (kept.length <= maxPoints) return kept;
  const out = [];
  const step = (kept.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) out.push(kept[Math.round(i * step)]);
  return out;
}

function point(doc, source, { altitude = true, ground = true } = {}) {
  const tMs = docTimeMs(doc);
  const la = num(doc?.location?.lat);
  const lo = num(doc?.location?.lon);
  if (tMs === null || la === null || lo === null) return null;
  return {
    tMs,
    lat: la,
    lon: lo,
    alt: altitude ? num(doc.baro_alt_m) : null,
    trk: num(doc.track_deg ?? doc.cog_deg ?? doc.bearing_deg),
    onGround: ground ? doc.on_ground === true : null,
    source,
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./historyEs.js').createHistoryEsClient>} options.es
 */
export function createTrackService({ es }) {
  /**
   * Docs of one source in [from, to], time ascending. Up to TRACK_READ_MAX
   * docs: all of them. Denser: a representative sample of the WHOLE range
   * (first doc per sampling interval + the newest doc), never a prefix.
   */
  async function read(index, filter, _source, { from, to, minGapMs }) {
    const query = { bool: { filter } };
    const all = await es.searchAll(index, {
      query,
      sort: [{ '@timestamp': 'asc' }],
      _source,
      maxRows: TRACK_READ_MAX,
      stopWhenOver: true,
    });
    if (!all.truncated) return { ...all, sampled: false };
    const interval = sampleIntervalMs(from, to, minGapMs);
    const json = await es.search(index, {
      size: 1,
      track_total_hits: true,
      query,
      sort: [{ '@timestamp': 'desc' }],
      _source,
      aggs: {
        t: {
          date_histogram: {
            field: '@timestamp',
            fixed_interval: `${interval}ms`,
            offset: `${((from % interval) + interval) % interval}ms`,
            min_doc_count: 1,
          },
          aggs: {
            first: {
              top_hits: {
                size: 1,
                sort: [{ '@timestamp': 'asc' }],
                _source,
              },
            },
          },
        },
      },
    });
    const hits = (json?.aggregations?.t?.buckets ?? [])
      .map((b) => b?.first?.hits?.hits?.[0])
      .filter(Boolean);
    const last = json?.hits?.hits?.[0];
    if (
      last &&
      !hits.some(
        (h) =>
          (h._id !== undefined && h._id === last._id) ||
          docTimeMs(sourceOf(h)) === docTimeMs(sourceOf(last)),
      )
    )
      hits.push(last);
    return {
      hits,
      total: json?.hits?.total?.value ?? all.total,
      truncated: false,
      sampled: true,
    };
  }

  async function points({ feed, id, feedId, vehicleId, from, to, minGapMs }) {
    const window = range('@timestamp', from, to);
    const span = { from, to, minGapMs };
    if (feed === 'aircraft') {
      const [a, o] = await Promise.all([
        read(
          IDX.adsblol,
          [{ term: { icao24: id } }, window],
          AIRCRAFT_FIELDS,
          span,
        ),
        read(
          IDX.opensky,
          [{ term: { icao24: id } }, window],
          AIRCRAFT_FIELDS,
          span,
        ),
      ]);
      const pts = [
        ...a.hits.map((h) => point(sourceOf(h), 'adsblol')),
        ...o.hits.map((h) => point(sourceOf(h), 'opensky')),
      ].filter(Boolean);
      return {
        points: mergeTrackPoints(pts, 'opensky'),
        read: a.hits.length + o.hits.length,
        truncated: a.truncated || o.truncated,
        sampled: a.sampled || o.sampled,
      };
    }
    if (feed === 'military') {
      const r = await read(
        IDX.military,
        [{ term: { hex: id } }, window],
        AIRCRAFT_FIELDS,
        span,
      );
      return {
        points: r.hits
          .map((h) => point(sourceOf(h), sourceOf(h).source ?? 'adsb.lol'))
          .filter(Boolean),
        read: r.hits.length,
        truncated: r.truncated,
        sampled: r.sampled,
      };
    }
    if (feed === 'vessels') {
      const r = await read(
        IDX.vessels,
        [{ term: { mmsi: id } }, window],
        ['@timestamp', 'location', 'cog_deg', 'source'],
        span,
      );
      return {
        points: r.hits
          .map((h) =>
            point(sourceOf(h), sourceOf(h).source ?? 'aisstream', {
              altitude: false,
              ground: false,
            }),
          )
          .filter(Boolean),
        read: r.hits.length,
        truncated: r.truncated,
        sampled: r.sampled,
      };
    }
    const r = await read(
      IDX.transit,
      [
        { term: { feed_id: feedId } },
        { term: { vehicle_id: vehicleId } },
        window,
      ],
      ['@timestamp', 'location', 'bearing_deg', 'source'],
      span,
    );
    return {
      points: r.hits
        .map((h) =>
          point(sourceOf(h), sourceOf(h).source ?? 'gtfs-rt', {
            altitude: false,
            ground: false,
          }),
        )
        .filter(Boolean),
      read: r.hits.length,
      truncated: r.truncated,
      sampled: r.sampled,
    };
  }

  async function track(params) {
    const { feed, id, from, to, minGapSec } = params;
    const minGapMs =
      minGapSec > 0
        ? minGapSec * 1000
        : Math.floor((to - from) / MAX_TRACK_POINTS / 1000) * 1000;
    const got = await points({ ...params, minGapMs });
    const thinned = thinTrack(got.points, minGapMs);
    const path = thinned.map((p) => [
      Math.round(p.tMs / 1000),
      p.lat,
      p.lon,
      p.alt,
      p.trk,
      p.onGround,
      p.source,
    ]);
    const sources = [...new Set(thinned.map((p) => p.source))].sort();
    return {
      body: {
        feed,
        id,
        icao24: feed === 'aircraft' || feed === 'military' ? id : null,
        callsign: null,
        startTime: path.length ? path[0][0] : null,
        endTime: path.length ? path.at(-1)[0] : null,
        path,
        sources,
      },
      headers: {
        'X-History-Source': sources.join(',') || 'none',
        'X-History-Rows': String(path.length),
        'X-History-Read': String(got.read),
        'X-History-Min-Gap-Sec': String(minGapMs / 1000),
        ...(got.truncated ? { 'X-History-Truncated': '1' } : {}),
        ...(got.sampled ? { 'X-History-Sampled': '1' } : {}),
        ...(path.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  return { track };
}
