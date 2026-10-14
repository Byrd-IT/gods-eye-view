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
 * Aircraft merge both sources by time (rev 3): all points sorted by time; a
 * point of the other source within MERGE_TIE_MS (5 s) of the previously kept
 * point collapses into ONE point, the OpenSky one.
 *
 * Reads use PIT + search_after sorted by @timestamp (historyEs searchAll),
 * at most TRACK_READ_MAX docs per source (31 d of 60 s adsb.lol buckets is
 * 44,640). Thinning is server side: minGapSec (default: range / 5,000, so
 * a 24 h track keeps every 60 s bucket) drops points closer than the gap to
 * the previous kept point (first and last always kept), then an even stride
 * caps the answer at MAX_TRACK_POINTS.
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
 * Merge two time-sorted point lists; points of DIFFERENT sources within
 * tieMs collapse into the preferred source's point. Same-source points are
 * never collapsed.
 * @param {{tMs: number, source: string}[]} points any order
 * @param {string} preferred source that wins a tie (opensky)
 */
export function mergeTrackPoints(
  points,
  preferred = 'opensky',
  tieMs = MERGE_TIE_MS,
) {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.tMs))
    .sort(
      (a, b) =>
        a.tMs - b.tMs ||
        Number(a.source === preferred) - Number(b.source === preferred),
    );
  const out = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (last && last.source !== p.source && p.tMs - last.tMs <= tieMs) {
      if (p.source === preferred) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
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
  async function read(index, filter, _source) {
    return es.searchAll(index, {
      query: { bool: { filter } },
      sort: [{ '@timestamp': 'asc' }],
      _source,
      maxRows: TRACK_READ_MAX,
    });
  }

  async function points({ feed, id, feedId, vehicleId, from, to }) {
    const window = range('@timestamp', from, to);
    if (feed === 'aircraft') {
      const [a, o] = await Promise.all([
        read(IDX.adsblol, [{ term: { icao24: id } }, window], AIRCRAFT_FIELDS),
        read(IDX.opensky, [{ term: { icao24: id } }, window], AIRCRAFT_FIELDS),
      ]);
      const pts = [
        ...a.hits.map((h) => point(sourceOf(h), 'adsblol')),
        ...o.hits.map((h) => point(sourceOf(h), 'opensky')),
      ].filter(Boolean);
      return {
        points: mergeTrackPoints(pts, 'opensky'),
        read: a.hits.length + o.hits.length,
        truncated: a.truncated || o.truncated,
      };
    }
    if (feed === 'military') {
      const r = await read(
        IDX.military,
        [{ term: { hex: id } }, window],
        AIRCRAFT_FIELDS,
      );
      return {
        points: r.hits
          .map((h) => point(sourceOf(h), sourceOf(h).source ?? 'adsb.lol'))
          .filter(Boolean),
        read: r.hits.length,
        truncated: r.truncated,
      };
    }
    if (feed === 'vessels') {
      const r = await read(
        IDX.vessels,
        [{ term: { mmsi: id } }, window],
        ['@timestamp', 'location', 'cog_deg', 'source'],
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
    };
  }

  async function track(params) {
    const { feed, id, from, to, minGapSec } = params;
    const got = await points(params);
    const minGapMs =
      minGapSec > 0
        ? minGapSec * 1000
        : Math.floor((to - from) / MAX_TRACK_POINTS / 1000) * 1000;
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
        ...(path.length ? {} : { 'X-History-Gap': '1' }),
      },
    };
  }

  return { track };
}
