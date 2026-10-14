/**
 * /api/history/* parameter validation and hard caps (gev-history DESIGN 4.3,
 * card B9). Pure: no I/O, no clock reads (callers pass `now`).
 *
 * Every route accepts ONLY the parameters listed in ROUTE_PARAMS; anything
 * else, a repeated parameter or an over-long query string is a 400. No value
 * is ever forwarded to Elasticsearch as query text: each parameter is parsed
 * into a number, an epoch or a member of a fixed set, and the query builders
 * (historyQueries.js) only ever see those parsed values.
 *
 * Errors are HistoryParamError { status, error, param }:
 *   400 invalid_param   malformed / out of range / unknown / repeated
 *   404 unknown_feed    feed not served by this route
 *   413 too_large       range, window, row or snapshot count above the cap
 */

export const DAY_MS = 86_400_000;
/** Owner R1: 2-year retention (730 d) plus one day of slack for the edge. */
export const RETENTION_MS = 731 * DAY_MS;
/** A request may look at most this far past the server clock (clock skew). */
export const FUTURE_SLACK_MS = 5 * 60_000;
/** DESIGN 4.3: maxRows <= 15,000 for any slice. */
export const MAX_ROWS = 15_000;
export const MAX_SNAPSHOTS = 50;
export const DEFAULT_SNAPSHOTS = 10;
/** Coverage: at most this many buckets per answer. */
export const MAX_COVERAGE_BUCKETS = 2_000;
export const MAX_QUERY_LENGTH = 512;

/** Coverage bucket sizes (fixed set: no free-form ES intervals). */
export const COVERAGE_BUCKETS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '1d': DAY_MS,
});

/**
 * Slice feeds served by B9. `window` is the as-of lookback for event feeds
 * (default / max, ms); fires use the fixed trailing 24 h of the live feed.
 */
export const SLICE_FEEDS = Object.freeze({
  aircraft: { defaultRows: MAX_ROWS },
  military: { defaultRows: MAX_ROWS },
  firms: { defaultRows: MAX_ROWS },
  'fire-perimeters': {
    defaultRows: 5_000,
    window: { def: 90 * DAY_MS, max: 180 * DAY_MS },
  },
  cyclones: {
    defaultRows: 32,
    window: { def: 12 * 3_600_000, max: 3 * DAY_MS },
  },
  launches: {
    defaultRows: 100,
    window: { def: 30 * DAY_MS, max: 30 * DAY_MS },
  },
});

/** Feeds with recorded polls in gev-history-ingest-log (coverage/snapshots). */
export const LOG_FEEDS = Object.freeze([
  'aircraft',
  'military',
  'firms',
  'fire-perimeters',
  'cyclones',
  'launches',
]);

export const ROUTE_PARAMS = Object.freeze({
  slice: ['feed', 't', 'bbox', 'maxRows', 'window'],
  coverage: ['feed', 'from', 'to', 'bucket'],
  snapshots: ['feed', 'around', 'n'],
});

export class HistoryParamError extends Error {
  constructor(status, error, param) {
    super(`${error}${param ? `: ${param}` : ''}`);
    this.status = status;
    this.error = error;
    this.param = param ?? null;
  }
}

const bad = (param) => new HistoryParamError(400, 'invalid_param', param);
const tooLarge = (param) => new HistoryParamError(413, 'too_large', param);

/**
 * Strict ISO 8601 UTC/offset timestamp, or an integer epoch in ms.
 * Rejects date-only strings, natural language and anything Date.parse would
 * guess at.
 */
export function parseInstant(value, param) {
  const text = String(value ?? '').trim();
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return text.length <= 10 ? n * 1000 : n;
  }
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
      text,
    )
  )
    throw bad(param);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw bad(param);
  return ms;
}

/** An instant inside the retention window [now - 731 d, now + 5 min]. */
export function parseRetainedInstant(value, param, now) {
  const ms = parseInstant(value, param);
  if (ms < now - RETENTION_MS || ms > now + FUTURE_SLACK_MS) throw bad(param);
  return Math.min(ms, now);
}

/** bbox=w,s,e,n in degrees; absent = the whole globe. */
export function parseBbox(value) {
  if (value === undefined) return null;
  const parts = String(value).split(',');
  if (parts.length !== 4) throw bad('bbox');
  const nums = parts.map((p) =>
    /^\s*-?\d{1,3}(?:\.\d{1,8})?\s*$/.test(p) ? Number(p) : NaN,
  );
  if (nums.some((n) => !Number.isFinite(n))) throw bad('bbox');
  const [w, s, e, n] = nums;
  if (w < -180 || e > 180 || s < -90 || n > 90) throw bad('bbox');
  // antimeridian-crossing boxes are not supported in v1: ask for two
  if (!(w < e) || !(s < n)) throw bad('bbox');
  return { w, s, e, n };
}

function parseIntParam(value, param, { min, max, def }) {
  if (value === undefined) return def;
  const text = String(value).trim();
  if (!/^\d{1,9}$/.test(text)) throw bad(param);
  const n = Number(text);
  if (n < min) throw bad(param);
  if (n > max) throw tooLarge(param);
  return n;
}

/** window=<n>(m|h|d), e.g. 30d, 12h. */
export function parseDuration(value, param) {
  const m = /^(\d{1,5})(m|h|d)$/.exec(String(value ?? '').trim());
  if (!m) throw bad(param);
  const unit = { m: 60_000, h: 3_600_000, d: DAY_MS }[m[2]];
  const ms = Number(m[1]) * unit;
  if (ms <= 0) throw bad(param);
  return ms;
}

/**
 * URLSearchParams -> plain object, enforcing the route's allowlist.
 * @param {URLSearchParams} search
 * @param {string} route slice | coverage | snapshots
 * @param {string} rawQuery the query text (length cap)
 */
export function readQuery(search, route, rawQuery = '') {
  if (rawQuery.length > MAX_QUERY_LENGTH) throw bad('query');
  const allowed = ROUTE_PARAMS[route];
  const out = {};
  for (const [key, value] of search) {
    if (!allowed.includes(key)) throw bad(key.slice(0, 32));
    if (Object.hasOwn(out, key)) throw bad(key);
    out[key] = value;
  }
  return out;
}

function feedOf(q, list) {
  if (q.feed === undefined || q.feed === '') throw bad('feed');
  if (!list.includes(q.feed))
    throw new HistoryParamError(404, 'unknown_feed', 'feed');
  return q.feed;
}

/** GET /api/history/slice */
export function parseSliceParams(search, rawQuery, now) {
  const q = readQuery(search, 'slice', rawQuery);
  const feed = feedOf(q, Object.keys(SLICE_FEEDS));
  const spec = SLICE_FEEDS[feed];
  if (q.t === undefined) throw bad('t');
  const t = parseRetainedInstant(q.t, 't', now);
  const bbox = parseBbox(q.bbox);
  const maxRows = parseIntParam(q.maxRows, 'maxRows', {
    min: 1,
    max: MAX_ROWS,
    def: spec.defaultRows,
  });
  let windowMs = spec.window?.def ?? null;
  if (q.window !== undefined) {
    if (!spec.window) throw bad('window');
    windowMs = parseDuration(q.window, 'window');
    if (windowMs > spec.window.max) throw tooLarge('window');
  }
  return { feed, t, bbox, maxRows, windowMs };
}

/** GET /api/history/coverage */
export function parseCoverageParams(search, rawQuery, now) {
  const q = readQuery(search, 'coverage', rawQuery);
  const feed = feedOf(q, LOG_FEEDS);
  if (q.from === undefined) throw bad('from');
  if (q.to === undefined) throw bad('to');
  const from = parseRetainedInstant(q.from, 'from', now);
  const to = parseRetainedInstant(q.to, 'to', now);
  if (!(from < to)) throw bad('to');
  const bucketName = q.bucket ?? '1h';
  const bucketMs = COVERAGE_BUCKETS[bucketName];
  if (!bucketMs) throw bad('bucket');
  if (Math.ceil((to - from) / bucketMs) > MAX_COVERAGE_BUCKETS)
    throw tooLarge('bucket');
  return { feed, from, to, bucket: bucketName, bucketMs };
}

/** GET /api/history/snapshots */
export function parseSnapshotParams(search, rawQuery, now) {
  const q = readQuery(search, 'snapshots', rawQuery);
  const feed = feedOf(q, LOG_FEEDS);
  if (q.around === undefined) throw bad('around');
  const around = parseRetainedInstant(q.around, 'around', now);
  const n = parseIntParam(q.n, 'n', {
    min: 1,
    max: MAX_SNAPSHOTS,
    def: DEFAULT_SNAPSHOTS,
  });
  return { feed, around, n };
}
