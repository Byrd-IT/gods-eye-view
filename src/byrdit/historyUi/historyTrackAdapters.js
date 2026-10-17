/**
 * Recorded track of a selected aircraft in history mode (gev-history
 * DESIGN 4.5, card B12e; umbrella decisions D1-D3 on t_5aa880c7).
 *
 * The flights and military layers ask their source for a track when an
 * aircraft is selected (src/layers/{flights,military}/tracking.js
 * _startTrail -> _backfillTrail -> source.getTrack -> /api/flights/track or
 * /api/military/track). While the feed is answered from history, the
 * router (historyRouter.js) answers those two routes from
 *
 *   /api/history/track?feed=aircraft|military&id=<hex>&from=t-6h&to=t
 *
 * adapted here to the EXACT shape the live parser reads:
 *   flights   the OpenSky /tracks shape: {icao24, callsign, startTime,
 *             endTime, path: [[t s, lat, lon, baro alt m, trk, onGround]]}.
 *             The B10 answer already is that shape plus a 7th element per
 *             point, `source` (adsblol | opensky); it is KEPT (the live
 *             parser reads elements 0-5 only), so the merged two-source
 *             track keeps its per-point label.
 *   military  the readsb trace_full shape the military getTrack reads:
 *             {icao, timestamp: base s, trace: [[s after base, lat, lon,
 *             alt ft | 'ground' | null, gs, trk, flags]]}.
 *
 * t is the time of the history frame the layer shows (the router's last
 * served answer for that feed), so the track ends where the icon is. The
 * track's times are REBASED by the same delta as that frame (D2: delta =
 * serve time - t), so "now - point time" is "t - recorded point time" and
 * the layer splices it behind the icon exactly as it does live.
 *
 * Gaps (D3): points more than TRACK_GAP_MS apart are a recorded gap. The
 * layers' trail is ONE polyline (src/data/trailRenderer.js createTrail has
 * no break), so the fork cannot keep it from joining the two sides of a
 * gap without an upstream edit. Nothing is interpolated (no point is
 * added); the chip names every gap with its recorded UTC times and says
 * the line joins across it. Breaking the line is left to review.
 *
 * The request is made only by the layer: on selection, and on every
 * history frame applied while an aircraft stays selected (the one-line
 * seam in src/layers/{flights,military}/snapshotRenderer.js), so the track
 * follows t. No prefetch, no timer.
 */
import { historySourceNames, rebaseSec } from './historyAdapters.js';

/** [t - 6 h, t] (DESIGN 4.5). */
export const TRACK_WINDOW_MS = 6 * 3_600_000;
/** Consecutive recorded points farther apart than this are a gap. */
export const TRACK_GAP_MS = 10 * 60_000;
/**
 * Server thinning (minGapSec): the layers' trail keeps at most
 * TRAIL_MAX_POINTS = 400 points (src/layers/flights/policy.js; flights
 * splices the newest 400 and would silently drop the OLDEST part of a
 * denser track). 6 h with points >= 60 s apart is at most 361 points (the
 * first and last are always kept), so the whole window fits; adsb.lol is
 * recorded in 60 s buckets anyway.
 */
export const TRACK_MIN_GAP_S = 60;
/** Track answers kept (exact URL; re-served paused frames ask the same). */
export const TRACK_CACHE_MAX = 8;
/** Body of the 404 a track route gets when no recorded track can be served. */
export const TRACK_UNAVAILABLE = 'history: recorded track unavailable';
/** Gaps named one by one on the chip; more are counted. */
export const TRACK_GAPS_NAMED = 2;
const FT_PER_M = 1 / 0.3048;

/** Chip text parts (named constants, no lowercase literal in a textContent=). */
export const TRACK_CHIP_PREFIX = 'TRACK';
export const TRACK_CHIP_SAMPLED = 'SAMPLED (not every recorded point)';
export const TRACK_CHIP_TRUNCATED = 'TRUNCATED (read cap reached)';
export const TRACK_CHIP_EMPTY = 'NO RECORDING in [t-6 h, t]';
export const TRACK_CHIP_UNAVAILABLE = 'HISTORY TRACK UNAVAILABLE';
export const TRACK_CHIP_GAP = 'GAP';
export const TRACK_CHIP_GAP_JOINED = 'not recorded; the line joins across';

const HEX = /^[0-9a-f]{6}$/;

/** [t - 6 h, t]. */
export function trackWindow(t) {
  return { from: t - TRACK_WINDOW_MS, to: t };
}

/** /api/history/track URL (path + query). */
export function historyTrackUrl(feed, id, { from, to }, base = '/api/history') {
  const q = new URLSearchParams({
    feed,
    id,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    minGapSec: String(TRACK_MIN_GAP_S),
  });
  return `${base}/track?${q}`;
}

/** The recorded points of a B10 answer (rows with a finite time). */
function rowsOf(body) {
  return (Array.isArray(body?.path) ? body.path : []).filter(
    (r) => Array.isArray(r) && Number.isFinite(r[0]),
  );
}

/**
 * B10 answer -> the OpenSky /tracks shape (flights getTrack). Times move by
 * deltaMs (D2); the 7th element (source) is kept.
 */
export function adaptAircraftTrack(body, { deltaMs }) {
  const path = rowsOf(body).map((r) => {
    const out = r.slice();
    out[0] = rebaseSec(r[0], deltaMs);
    return out;
  });
  return {
    icao24: body?.icao24 ?? body?.id ?? null,
    callsign: body?.callsign ?? null,
    startTime: path.length ? path[0][0] : null,
    endTime: path.length ? path.at(-1)[0] : null,
    path,
  };
}

/**
 * B10 answer -> the readsb trace_full shape (military getTrack): a base
 * timestamp (s) and per-point seconds after it; altitude in feet or
 * 'ground'. Times move by deltaMs (D2). A recorded gap of the whole window
 * is {timestamp: null, trace: []} (the parser draws nothing).
 */
export function adaptMilitaryTrack(body, { deltaMs }) {
  const rows = rowsOf(body);
  const base = rows.length ? rebaseSec(rows[0][0], deltaMs) : null;
  const trace = rows.map((r) => {
    const at = rebaseSec(r[0], deltaMs);
    const alt =
      r[5] === true
        ? 'ground'
        : Number.isFinite(r[3])
          ? Math.round(r[3] * FT_PER_M * 1000) / 1000
          : null;
    return [
      Math.round((at - base) * 1000) / 1000,
      r[1],
      r[2],
      alt,
      null,
      Number.isFinite(r[4]) ? r[4] : null,
      0,
    ];
  });
  return {
    icao: body?.icao24 ?? body?.id ?? null,
    timestamp: base,
    trace,
  };
}

/** Per-adapter (router adapter id) track spec. */
export const TRACK_SPECS = Object.freeze({
  flights: Object.freeze({
    feed: 'aircraft',
    param: 'icao24',
    adapt: adaptAircraftTrack,
  }),
  military: Object.freeze({
    feed: 'military',
    param: 'hex',
    adapt: adaptMilitaryTrack,
  }),
});

/** The hex a live track request asks for, or null (the API takes 6 hex). */
export function trackIdOf(spec, url) {
  const id = String(url.searchParams.get(spec.param) ?? '')
    .trim()
    .toLowerCase();
  return HEX.test(id) ? id : null;
}

/** Recorded gaps (epoch ms, NOT rebased) between consecutive points. */
export function trackGaps(body, gapMs = TRACK_GAP_MS) {
  const rows = rowsOf(body);
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1][0] * 1000;
    const b = rows[i][0] * 1000;
    if (b - a > gapMs) out.push({ from: a, to: b });
  }
  return out;
}

/** What the chip says about one served track (router state `track`). */
export function trackSummary({
  adapterId,
  layerId,
  id,
  from,
  to,
  body = null,
  headers = {},
  status = 'ok',
  ms = null,
  cached = false,
}) {
  const rows = rowsOf(body);
  const sources = historySourceNames(
    headers['x-history-source'] ??
      (Array.isArray(body?.sources) ? body.sources.join(',') : ''),
  );
  return {
    adapterId,
    layerId,
    id,
    from,
    to,
    status,
    rows: rows.length,
    sources,
    sampled: headers['x-history-sampled'] === '1',
    truncated: headers['x-history-truncated'] === '1',
    empty: status === 'ok' && rows.length === 0,
    gaps: status === 'ok' ? trackGaps(body) : [],
    ms,
    cached,
  };
}

/** A UTC clock time of a RECORDED time (never a rebased one, D2). */
function utcClock(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

/** The chip text of a track summary. */
export function trackChipText(sum) {
  const head = `${TRACK_CHIP_PREFIX} ${String(sum.id).toUpperCase()}`;
  if (sum.status !== 'ok') return `${head}: ${TRACK_CHIP_UNAVAILABLE}`;
  if (sum.empty) return `${head}: ${TRACK_CHIP_EMPTY}`;
  const parts = [
    `${head}, last 6 h: ${sum.rows} points${sum.sources.length ? ` (${sum.sources.join(' + ')})` : ''}`,
  ];
  if (sum.sampled) parts.push(TRACK_CHIP_SAMPLED);
  if (sum.truncated) parts.push(TRACK_CHIP_TRUNCATED);
  if (sum.gaps.length) {
    const named = sum.gaps
      .slice(0, TRACK_GAPS_NAMED)
      .map((g) => `${utcClock(g.from)}-${utcClock(g.to)}`);
    const more = sum.gaps.length - named.length;
    parts.push(
      `${TRACK_CHIP_GAP} ${named.join(', ')}${more > 0 ? ` +${more}` : ''} (${TRACK_CHIP_GAP_JOINED})`,
    );
  }
  return parts.join(' · ');
}

/** The track needs a warning colour (sampled / truncated / gap / none). */
export function trackNeedsWarning(sum) {
  return (
    sum.status !== 'ok' ||
    sum.empty ||
    sum.sampled ||
    sum.truncated ||
    sum.gaps.length > 0
  );
}
