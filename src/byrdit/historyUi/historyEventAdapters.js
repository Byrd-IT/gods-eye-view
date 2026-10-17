/**
 * History adapters for the event feeds and the per-feed transit / bike share
 * routes (gev-history DESIGN 4.5, card B12b; shared decisions D1-D7 on the
 * B12 umbrella t_5aa880c7). The registry fields and the adapt() contract
 * are those of historyAdapters.js (B12a).
 *
 * D2: FIRMS acquisition time, perimeter dates, cyclone advisory / issued
 * times, launch NET and bike share last_reported are EVENT times: they are
 * NOT rebased. Transit is a motion feed: its poll and vehicle report times
 * are rebased by delta = nowMs - t, like flights.
 *
 * D3: an empty slice / recorded gap answers an EMPTY live body (nothing is
 * drawn), never live data and never another time.
 *
 * What each layer can show from a recording (checked against the layer
 * code; see the B12b card):
 *   firms      the live shape, trailing 24 h of t, ALWAYS asked with the
 *              camera bbox (D7: a global 24 h slice is ~143 k rows, over the
 *              15,000 cap). X-History-Truncated is kept for the chip strip.
 *   perimeters {fetchedAt, rows}. The recorder keeps no category, discovery
 *              time, cause, behavior, personnel, cost, complexity or complex
 *              name: they stay null (the card never prints a 0 for them) and
 *              each row names them in `historyUnknown`, which the incident
 *              card prints as one "not recorded" line (one-line touch point
 *              in src/layers/perimeters/cards.js).
 *   cyclones   the envelope passes validateCycloneSnapshot unchanged. Its
 *              projection keeps only track/cone of a 'current' storm, and
 *              'current' needs recorded forecast points the recorder does
 *              not keep, so recordedTrack / recordedCone and the ATCF
 *              bestTrackStorms are NOT drawn: the layer draws the advisory
 *              POSITIONS only ("Track/cone unavailable" on the card). With no
 *              advisory recorded in the window the answer says so
 *              (unavailable + reason) instead of claiming "no active storms".
 *   launches   the LL2 subset; `gevAsOf` = t tells the layer's 30-day NET
 *              window to end at t instead of the browser clock (one-line
 *              touch point in src/layers/launches/ingestion.js), else every
 *              launch older than 30 days before NOW would be dropped.
 */
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';
import {
  HISTORY_ADAPTERS,
  historySourceLabel,
  passHeaders,
  rebaseDelta,
  rebaseMs,
  rebaseSec,
  viewToBboxes,
} from './historyAdapters.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const MIN = 60_000;

/** Perimeter fields the recorder does not keep (null in every row). */
export const PERIMETER_UNRECORDED = Object.freeze([
  ['category', 'category'],
  ['discoveredTime', 'discovery time'],
  ['cause', 'cause'],
  ['behavior', 'behavior'],
  ['personnel', 'personnel'],
  ['costToDate', 'cost'],
  ['complexity', 'complexity'],
  ['complexName', 'complex'],
]);
export const PERIMETER_UNKNOWN_PREFIX = 'Not recorded (unknown): ';
export const CYCLONE_NONE_REASON =
  'No NHC advisory recorded in the 12 h before this time';

// ── FIRMS bbox (D7) ───────────────────────────────────────

const WORLD = [-180, -90, 180, 90];

/**
 * The camera view box ([w, s, e, n] degrees, w > e = crosses the
 * antimeridian; flightView.js cameraViewBox) -> the FIRMS slice bboxes,
 * widened OUTWARD to whole degrees (fewer distinct slice URLs while the
 * camera drifts; the box only ever grows). No view -> the whole globe as
 * an explicit bbox: FIRMS never asks without one.
 */
export function firmsBboxes(box) {
  const ok =
    Array.isArray(box) && box.length === 4 && box.every(Number.isFinite);
  let [w, s, e, n] = ok ? box : WORLD;
  s = Math.max(-90, Math.floor(s));
  n = Math.min(90, Math.ceil(n));
  w = Math.max(-180, Math.floor(w));
  e = Math.min(180, Math.ceil(e));
  if (!(s < n)) [s, n] = [-90, 90];
  if (w === e) [w, e] = [-180, 180];
  const out = viewToBboxes(`${w},${s},${e},${n}`);
  return out[0] === null ? ['-180,-90,180,90'] : out;
}

function viewBoxOf(ctx) {
  try {
    return ctx?.viewBox?.() ?? null;
  } catch {
    return null;
  }
}

function adaptFirms(answers) {
  const seen = new Set();
  const fires = [];
  const counts = new Map();
  let fetchedAt = null;
  for (const a of answers) {
    const body = a.body ?? {};
    if (Number.isFinite(body.fetchedAt))
      fetchedAt = Math.max(fetchedAt ?? 0, body.fetchedAt);
    for (const f of Array.isArray(body.fires) ? body.fires : []) {
      if (!f || typeof f !== 'object') continue;
      // two boxes of a crossing view meet on the antimeridian only
      const key = [
        f.lat,
        f.lon,
        f.acqDate,
        f.acqTime,
        f.satellite,
        f.instrument,
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      fires.push(f);
    }
    for (const src of Array.isArray(body.sources) ? body.sources : [])
      if (src?.source)
        counts.set(src.source, (counts.get(src.source) ?? 0) + (src.count | 0));
  }
  return {
    body: {
      // the slice time (an event feed: NOT rebased, D2)
      fetchedAt,
      stale: false,
      ttlMs: answers[0]?.body?.ttlMs ?? 1_800_000,
      sources: [...counts.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([source, count]) => ({ source, count, ok: true })),
      count: fires.length,
      fires,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      ...(fires.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

// ── fire perimeters ───────────────────────────────────────

/** The unrecorded fields of one row, as the card's "unknown" line. */
export function perimeterUnknownLine(row) {
  const names = PERIMETER_UNRECORDED.filter(
    ([key]) => row?.[key] === null || row?.[key] === undefined,
  ).map(([, label]) => label);
  return names.length ? `${PERIMETER_UNKNOWN_PREFIX}${names.join(', ')}` : null;
}

function adaptPerimeters(answers) {
  const body = answers[0]?.body ?? {};
  const rows = (Array.isArray(body.rows) ? body.rows : []).map((row) => {
    const line = perimeterUnknownLine(row);
    return line ? { ...row, historyUnknown: line } : row;
  });
  return {
    body: { fetchedAt: body.fetchedAt ?? null, rows },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(rows.length),
      ...(rows.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

// ── cyclones ──────────────────────────────────────────────

function adaptCyclones(answers) {
  const body = answers[0]?.body ?? {};
  const storms = Array.isArray(body.storms) ? body.storms : [];
  const none = storms.length === 0;
  return {
    body: {
      ...body,
      storms,
      stale: false,
      // "no active storms" would be a claim about the ocean; an empty
      // recording only says no advisory was recorded (D3: draw nothing)
      unavailable: none,
      reason: none ? CYCLONE_NONE_REASON : null,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(storms.length),
      ...(none ? { 'X-History-Gap': '1' } : {}),
    },
  };
}

// ── launches ──────────────────────────────────────────────

function adaptLaunches(answers, { t }) {
  const body = answers[0]?.body ?? {};
  const results = Array.isArray(body.results) ? body.results : [];
  return {
    body: {
      count: results.length,
      next: null,
      previous: null,
      results,
      // the layer's 30-day NET window ends here, not at the browser clock
      gevAsOf: t,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(results.length),
      ...(results.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

// ── transit (motion feed, D2 rebase) ──────────────────────

const TRANSIT_RE = /^\/api\/transit\/vehicles\/([^/]+)\/?$/;

/** The registry feed id of a live transit request path, or null. */
export function transitFeedOf(path) {
  const m = TRANSIT_RE.exec(String(path ?? ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function adaptTransit(answers, { t, nowMs, url }) {
  const delta = rebaseDelta(t, nowMs);
  const feedId = transitFeedOf(url?.pathname);
  const body = answers[0]?.body ?? {};
  const feed = (Array.isArray(body.feeds) ? body.feeds : []).find(
    (f) => f?.feedId === feedId,
  );
  const vehicles = (Array.isArray(feed?.vehicles) ? feed.vehicles : []).map(
    (v) =>
      v && typeof v === 'object'
        ? { ...v, timestamp: rebaseSec(v.timestamp, delta) }
        : v,
  );
  return {
    body: {
      feedId,
      name: feed?.name ?? feedId,
      // the poll time is the slice time t, shown as now (D2)
      fetchedAt: rebaseMs(
        Number.isFinite(feed?.fetchedAt) ? feed.fetchedAt : t,
        delta,
      ),
      feedTimestamp: rebaseSec(feed?.feedTimestamp ?? null, delta),
      version: feed?.version ?? null,
      entityCount: feed?.entityCount ?? vehicles.length,
      truncated: Boolean(feed?.truncated),
      count: vehicles.length,
      vehicles,
    },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(vehicles.length),
      ...(vehicles.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

// ── bike share (GBFS 2.x) ─────────────────────────────────

const GBFS_RE = /^\/api\/gbfs\/(.+)$/;

/** Registry upstream URL -> {systemId, kind: 'info' | 'status'}. */
export const GBFS_SYSTEM_BY_URL = new Map(
  GBFS_CITY_REGISTRY.flatMap((e) => [
    [e.stationInformationUrl, { systemId: e.id, kind: 'info' }],
    [e.stationStatusUrl, { systemId: e.id, kind: 'status' }],
  ]),
);

/**
 * /api/gbfs/<encoded upstream url> -> the recorded system and file, or
 * null when the URL is not a registry (recorded) system. Same decoding as
 * the live proxy / collector bridge (feedsC.js resolveGbfs).
 */
export function gbfsTargetOf(path) {
  const m = GBFS_RE.exec(String(path ?? ''));
  if (!m) return null;
  let upstream;
  try {
    upstream = new URL(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
  if (upstream.protocol !== 'https:') return null;
  return GBFS_SYSTEM_BY_URL.get(upstream.toString()) ?? null;
}

function adaptBikeshare(answers, { t, url }) {
  const target = gbfsTargetOf(url?.pathname);
  const body = answers[0]?.body ?? {};
  const system = target
    ? (Array.isArray(body.systems) ? body.systems : []).find(
        (s) => s?.systemId === target.systemId,
      )
    : null;
  const file =
    target?.kind === 'info'
      ? system?.station_information
      : system?.station_status;
  const stations = Array.isArray(file?.data?.stations)
    ? file.data.stations
    : [];
  return {
    body: {
      // event feed (D2): last_updated / last_reported are recorded times
      last_updated: Number.isFinite(file?.last_updated)
        ? file.last_updated
        : Math.floor(t / 1000),
      ttl: 0,
      version: file?.version ?? '2.3',
      data: { stations },
    },
    headers: {
      'Content-Type': JSON_TYPE,
      ...passHeaders(answers),
      'X-History-Rows': String(stations.length),
      ...(stations.length ? {} : { 'X-History-Gap': '1' }),
    },
  };
}

// ── registry entries ──────────────────────────────────────

export const FIRMS_ADAPTER = Object.freeze({
  id: 'firms',
  layerId: 'local-firms',
  sliceFeed: 'firms',
  snapFeed: null,
  // the live poll cadence (B9: firms 30 min)
  quantumMs: 30 * MIN,
  rebased: false,
  // the slice params follow the camera (refresh on a camera move)
  viewDependent: true,
  match: /^\/api\/firms\/?$/,
  sliceParams(_url, ctx) {
    return firmsBboxes(viewBoxOf(ctx)).map((bbox) => ({ bbox }));
  },
  adapt: adaptFirms,
});

export const PERIMETERS_ADAPTER = Object.freeze({
  id: 'fire-perimeters',
  layerId: 'fire-perimeters',
  sliceFeed: 'fire-perimeters',
  snapFeed: null,
  quantumMs: 15 * MIN,
  rebased: false,
  match: /^\/api\/fire-perimeters\/?$/,
  sliceParams() {
    return [{}];
  },
  adapt: adaptPerimeters,
});

export const CYCLONES_ADAPTER = Object.freeze({
  id: 'cyclones',
  layerId: 'weather-cyclones',
  sliceFeed: 'cyclones',
  snapFeed: null,
  quantumMs: 15 * MIN,
  rebased: false,
  match: /^\/api\/cyclones\/?$/,
  sliceParams() {
    return [{}];
  },
  adapt: adaptCyclones,
});

export const LAUNCHES_ADAPTER = Object.freeze({
  id: 'launches',
  layerId: 'rocket-launches',
  sliceFeed: 'launches',
  snapFeed: null,
  quantumMs: 15 * MIN,
  rebased: false,
  match: /^\/api\/launches\/?$/,
  sliceParams() {
    return [{}];
  },
  adapt: adaptLaunches,
});

/**
 * Transit and bike share (owner decision on the B12b card, option A: the
 * upstream frame seams). Transit is a motion feed (D2 rebase): every history
 * answer arms the layer (resetForHistoryFrame, src/layers/transit), so the
 * snapshot replaces the feed's fleet instead of passing the fix-plausibility
 * gate and the 2-poll eviction. Bike share caches station information for
 * the page's life, so the driver asks reloadForHistoryFrame
 * (src/layers/bikeshare) once per frame time and once back on live
 * (reloadOnFrame, historyRefresh.js).
 */
export const TRANSIT_ADAPTER = Object.freeze({
  id: 'transit',
  layerId: 'transit',
  sliceFeed: 'transit',
  snapFeed: null,
  quantumMs: MIN,
  rebased: true,
  match: TRANSIT_RE,
  trackMatch: /^\/api\/transit\/trail\//,
  sliceParams() {
    // one slice answers every feed (shared cache entry per frame)
    return [{}];
  },
  adapt: adaptTransit,
});

export const BIKESHARE_ADAPTER = Object.freeze({
  id: 'bikeshare',
  layerId: 'bikeshare',
  sliceFeed: 'bikeshare',
  snapFeed: null,
  quantumMs: 5 * MIN,
  rebased: false,
  reloadOnFrame: true,
  match: GBFS_RE,
  sliceParams() {
    // the server's default window (B10 R4 window decision t_c2cba35e)
    return [{}];
  },
  adapt: adaptBikeshare,
});

export const EVENT_ADAPTERS = Object.freeze([
  FIRMS_ADAPTER,
  PERIMETERS_ADAPTER,
  CYCLONES_ADAPTER,
  LAUNCHES_ADAPTER,
  TRANSIT_ADAPTER,
  BIKESHARE_ADAPTER,
]);

/** The active registry: B12a motion feeds + the B12b feeds. */
export const ALL_HISTORY_ADAPTERS = Object.freeze([
  ...HISTORY_ADAPTERS,
  ...EVENT_ADAPTERS,
]);

export { historySourceLabel };
