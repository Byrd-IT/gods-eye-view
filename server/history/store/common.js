/**
 * Shared pieces of the history store contract: error type, input validation and
 * the span builder every backend uses, so backends cannot disagree on them.
 *
 * Messages never echo observation payloads, file paths or connection strings;
 * they name the field that was wrong and the limit that applies.
 */

export const MAX_APPEND_BATCH = 50_000;
export const MAX_KEY_LENGTH = 256;
export const MAX_DATA_BYTES = 64 * 1024;
export const MAX_SLICE_ROWS = 100_000;
export const DEFAULT_SLICE_ROWS = 20_000;
export const MAX_SNAPSHOTS = 20_000;
export const DEFAULT_SNAPSHOTS = 5_000;
export const DEFAULT_MAX_GAP_MS = 60 * 60 * 1000;
export const MAX_INGEST_ROWS = 50_000;
export const DEFAULT_INGEST_ROWS = 20_000;
export const MAX_INGEST_COUNT = 1_000_000_000;

export const DEFAULT_SQLITE_PATH = './data/history.sqlite';

export const FEED_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export class HistoryStoreError extends Error {
  /** @param {'INVALID_ARGUMENT'|'CLOSED'|'BACKEND'|'CONFIG'} code */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'HistoryStoreError';
    this.code = code;
  }
}

export function invalid(message) {
  return new HistoryStoreError('INVALID_ARGUMENT', message);
}

export function assertFeed(feed) {
  if (typeof feed !== 'string' || !FEED_ID_PATTERN.test(feed)) {
    throw invalid(
      'feed must be a lowercase identifier (a-z, 0-9, _; starts with a letter; at most 32 characters)',
    );
  }
  return feed;
}

export function assertTime(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(
      `${name} must be a non-negative integer number of milliseconds since the epoch`,
    );
  }
  return value;
}

function optionalTime(value, name) {
  return value === undefined || value === null
    ? undefined
    : assertTime(value, name);
}

function positiveInt(value, name, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw invalid(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

/** Validate and normalise one observation. Returns a fresh plain object. */
export function normalizeObservation(raw, index = 0) {
  const where = `observations[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`${where} must be an object`);
  }
  const t = assertTime(raw.t, `${where}.t`);
  const key = raw.key;
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH
  ) {
    throw invalid(
      `${where}.key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`,
    );
  }
  const hasLat = raw.lat !== undefined && raw.lat !== null;
  const hasLon = raw.lon !== undefined && raw.lon !== null;
  if (hasLat !== hasLon)
    throw invalid(`${where} must give both lat and lon, or neither`);
  let lat = null;
  let lon = null;
  if (hasLat) {
    if (!Number.isFinite(raw.lat) || raw.lat < -90 || raw.lat > 90) {
      throw invalid(`${where}.lat must be a number from -90 to 90`);
    }
    if (!Number.isFinite(raw.lon) || raw.lon < -180 || raw.lon > 180) {
      throw invalid(`${where}.lon must be a number from -180 to 180`);
    }
    lat = raw.lat;
    lon = raw.lon;
  }
  const data = raw.data === undefined ? {} : raw.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid(`${where}.data must be a plain object`);
  }
  let json;
  try {
    json = JSON.stringify(data);
  } catch {
    throw invalid(`${where}.data must be JSON-serialisable`);
  }
  if (json === undefined || Buffer.byteLength(json) > MAX_DATA_BYTES) {
    throw invalid(
      `${where}.data must serialise to at most ${MAX_DATA_BYTES} bytes`,
    );
  }
  return { t, key, lat, lon, json };
}

export function normalizeBatch(observations) {
  if (!Array.isArray(observations))
    throw invalid('observations must be an array');
  if (observations.length > MAX_APPEND_BATCH) {
    throw invalid(
      `observations may hold at most ${MAX_APPEND_BATCH} entries per call`,
    );
  }
  return observations.map((item, index) => normalizeObservation(item, index));
}

/**
 * Validate slice options. `bbox` is {west,south,east,north}; west > east means
 * the box crosses the antimeridian.
 */
export function normalizeSliceOptions(options) {
  if (options === null || typeof options !== 'object')
    throw invalid('slice options must be an object');
  const t = assertTime(options.t, 't');
  const windowMs = positiveInt(
    options.windowMs,
    'windowMs',
    15 * 60 * 1000,
    366 * 24 * 3600 * 1000,
  );
  const limit = positiveInt(
    options.limit,
    'limit',
    DEFAULT_SLICE_ROWS,
    MAX_SLICE_ROWS,
  );
  let bbox = null;
  if (options.bbox !== undefined && options.bbox !== null) {
    const { west, south, east, north } = options.bbox;
    for (const [name, value, bound] of [
      ['west', west, 180],
      ['east', east, 180],
      ['south', south, 90],
      ['north', north, 90],
    ]) {
      if (!Number.isFinite(value) || value < -bound || value > bound) {
        throw invalid(
          `bbox.${name} must be a number from -${bound} to ${bound}`,
        );
      }
    }
    if (south > north) throw invalid('bbox.south must not exceed bbox.north');
    bbox = { west, south, east, north };
  }
  return { t, windowMs, limit, bbox };
}

export function normalizeRange(options, name = 'options') {
  const o = options ?? {};
  if (typeof o !== 'object') throw invalid(`${name} must be an object`);
  const from = optionalTime(o.from, 'from');
  const to = optionalTime(o.to, 'to');
  if (from !== undefined && to !== undefined && from > to)
    throw invalid('from must not exceed to');
  return { from, to };
}

export function normalizeSnapshotOptions(options) {
  const range = normalizeRange(options);
  const order = options?.order === undefined ? 'asc' : options.order;
  if (order !== 'asc' && order !== 'desc')
    throw invalid("order must be 'asc' or 'desc'");
  return {
    ...range,
    order,
    limit: positiveInt(
      options?.limit,
      'limit',
      DEFAULT_SNAPSHOTS,
      MAX_SNAPSHOTS,
    ),
  };
}

/**
 * One poll of a source: { t, ok, count }. ok says the source answered; count is
 * how many observations that answer held (0 is a real, empty answer). The text
 * of a failure is never stored.
 */
export function normalizeIngestRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw invalid('ingest record must be an object');
  const t = assertTime(raw.t, 't');
  if (typeof raw.ok !== 'boolean') throw invalid('ok must be true or false');
  let count = 0;
  if (raw.count !== undefined && raw.count !== null) {
    if (
      !Number.isSafeInteger(raw.count) ||
      raw.count < 0 ||
      raw.count > MAX_INGEST_COUNT
    )
      throw invalid(
        `count must be an integer from 0 to ${MAX_INGEST_COUNT}`,
      );
    count = raw.count;
  }
  if (!raw.ok && count !== 0)
    throw invalid('a failed poll cannot have observations');
  return { t, ok: raw.ok, count };
}

export function normalizeIngestQuery(options) {
  const range = normalizeRange(options);
  return {
    ...range,
    limit: positiveInt(
      options?.limit,
      'limit',
      DEFAULT_INGEST_ROWS,
      MAX_INGEST_ROWS,
    ),
  };
}

export function normalizeCoverageOptions(options) {
  const range = normalizeRange(options);
  return {
    ...range,
    maxGapMs: positiveInt(
      options?.maxGapMs,
      'maxGapMs',
      DEFAULT_MAX_GAP_MS,
      366 * 24 * 3600 * 1000,
    ),
  };
}

export function normalizeLatestBefore(options) {
  if (options === null || typeof options !== 'object')
    throw invalid('latestBefore options must be an object');
  const t = assertTime(options.t, 't');
  const key = options.key;
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH
  ) {
    throw invalid(
      `key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`,
    );
  }
  return { t, key };
}

/**
 * Merge ascending snapshot times into spans: consecutive snapshots no more than
 * `maxGapMs` apart belong to one span. Returns [{from,to,snapshots}].
 */
export function buildSpans(times, maxGapMs) {
  const spans = [];
  let current = null;
  for (const t of times) {
    if (current && t - current.to <= maxGapMs) {
      current.to = t;
      current.snapshots += 1;
    } else {
      current = { from: t, to: t, snapshots: 1 };
      spans.push(current);
    }
  }
  return spans;
}

export function decodeRow(row) {
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    data = {};
  }
  return {
    t: Number(row.t),
    key: row.key,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    data,
  };
}
