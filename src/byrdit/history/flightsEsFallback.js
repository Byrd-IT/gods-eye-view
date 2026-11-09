/**
 * ES-only fallback for /api/flights (owner-approved Option 1).
 *
 * When the collector (GET /v1/latest/aircraft-opensky, POST view lease) AND
 * the bridge's per-view last-good copy are unavailable, the bridge may serve
 * a bounded read of the recorded OpenSky history index instead of the 503:
 *
 *  - Reader key ONLY (createHistoryEsClient refuses any other key), fixed
 *    endpoints only, the index allowlist entry `HISTORY_INDICES.opensky`.
 *  - Lookback bounded to FLIGHTS_ES_FALLBACK_LOOKBACK_MS (15 min): only
 *    positions recorded in the window count; older history is never shown.
 *  - A valid viewport (`view=w,s,e,n`, parseFlightView) is required; a
 *    request without one is not answered from ES.
 *  - Newest recorded position per aircraft (collapse on icao24,
 *    historyCollapse.latestPerKey), capped at FLIGHTS_ES_FALLBACK_MAX_ROWS.
 *  - The answer is the live envelope itself, {time, states} with OpenSky
 *    18-field state vectors (openSkyState), so the existing flights
 *    renderer and OpenSky parsers read it unchanged.
 *  - STALE + grey: served always as X-Feed-Cache: STALE with
 *    X-Feed-Stale-Since = the newest position time, X-Feed-Reason and the
 *    bridge's X-Feed-Grey-Until, so staleness.js feedDisplayState shows the
 *    GREY chip "No data since HH:MM <tz>" without any client change.
 *  - A fresh-in-memory answer is preferred: one read per view per
 *    FLIGHTS_ES_FALLBACK_CACHE_MS; concurrent same-view reads share one
 *    read. The per-view map is a bounded LRU at
 *    FLIGHTS_ES_FALLBACK_CACHE_MAX_ENTRIES slots whose entries expire
 *    (review): a wandering viewport cannot grow it without bound.
 *    Negative answers (no recent rows) are cached for the shorter
 *    FLIGHTS_ES_FALLBACK_NEGATIVE_CACHE_MS, so a stalled request cannot
 *    hammer ES either.
 *  - Failure never falls through: the reader throws, the bridge serves its
 *    normal 503 no-snapshot, and the upstream OpenSky / adsb.lol plugins
 *    are never reached.
 *  - Review: the ES load the fallback may place is bounded globally, not
 *    just per view: at most FLIGHTS_ES_FALLBACK_MAX_CONCURRENT_READS reads
 *    are in flight across every viewport at once (a further read fails
 *    closed — the bridge then serves the collector's paused relay or 503;
 *    the collector path itself is never blocked or queued); one read runs
 *    at most FLIGHTS_ES_FALLBACK_MAX_QUERIES collapse requests (far below
 *    the COLLAPSE_MAX_QUERIES default of latestPerKey) and has a finite
 *    FLIGHTS_ES_FALLBACK_READ_DEADLINE_MS deadline. A failed read is
 *    cached for FLIGHTS_ES_FALLBACK_FAILURE_CACHE_MS so an outage is not
 *    retried on every poll, and failures are logged at most once a minute
 *    with a short reason only (never an error message: a URL or a key
 *    could ride along in one).
 *
 * Off unless GEV_BRIDGE_FLIGHTS_ES_FALLBACK=1 together with the reader key
 * settings the /api/history routes already use (GEV_HISTORY_ES_URL,
 * GEV_HISTORY_ES_API_KEY) — the deployed behaviour without the flag is
 * byte-identical to a build without this module.
 *
 * Browser-safe: no Node built-ins, no DOM.
 */

import { COLLAPSE_FANOUT, latestPerKey } from './historyCollapse.js';
import {
  HISTORY_INDICES,
  HistoryUnavailableError,
  createHistoryEsClient,
  esConfigFromEnv,
} from './historyEs.js';
import { AIRCRAFT_STATE_DOC_VALUES } from './historyService.js';
import { openSkyState, docTimeMs } from './historyRows.js';
import { parseFlightView } from './feeds.js';

/** Only recently recorded positions are served (owner decision). */
export const FLIGHTS_ES_FALLBACK_LOOKBACK_MS = 15 * 60_000;
/** Upper bound of aircraft in one answer. */
export const FLIGHTS_ES_FALLBACK_MAX_ROWS = 5_000;
/** A fresh answer is reused from memory for this long. */
export const FLIGHTS_ES_FALLBACK_CACHE_MS = 30_000;
/** Most per-view answers one reader keeps in memory (an LRU, oldest evicted). */
export const FLIGHTS_ES_FALLBACK_CACHE_MAX_ENTRIES = 64;
/** A negative answer (no recent rows) is reused from memory for this long. */
export const FLIGHTS_ES_FALLBACK_NEGATIVE_CACHE_MS = 10_000;
/** Most collapse requests ONE read may make (review: below COLLAPSE_MAX_QUERIES). */
export const FLIGHTS_ES_FALLBACK_MAX_QUERIES = 24;
/** Most ES reads in flight at once across EVERY viewport (review; fail closed). */
export const FLIGHTS_ES_FALLBACK_MAX_CONCURRENT_READS = 2;
/** A whole read (probe + partitions) is deadlined at this. */
export const FLIGHTS_ES_FALLBACK_READ_DEADLINE_MS = 8_000;
/** An ES failure is remembered for this long (no retry storm; review). */
export const FLIGHTS_ES_FALLBACK_FAILURE_CACHE_MS = 10_000;
/** Rollback / opt-in flag (GEV convention: default OFF). */
export const FLIGHTS_ES_FALLBACK_FLAG = 'GEV_BRIDGE_FLIGHTS_ES_FALLBACK';

/** Reader configuration; null unless the flag and reader-key settings are set. */
export function flightsEsFallbackConfigFromEnv(env = {}) {
  if (String(env[FLIGHTS_ES_FALLBACK_FLAG] ?? '').trim() !== '1') return null;
  const es = esConfigFromEnv(env);
  return es ? { es } : null;
}

function rangeMs(gte, lte) {
  return {
    range: { '@timestamp': { gte, lte, format: 'epoch_millis' } },
  };
}

function viewBoxClause([w, s, e, n]) {
  return {
    geo_bounding_box: {
      location: {
        top_left: { lat: n, lon: w },
        bottom_right: { lat: s, lon: e },
      },
    },
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./historyEs.js').createHistoryEsClient>} options.es
 * @param {() => number} [options.now]
 * @param {number} [options.lookbackMs]
 * @param {number} [options.maxRows]
 * @param {number} [options.cacheMs]
 * @returns {{read: (url: URL|{searchParams: URLSearchParams}) => Promise<null|{body: string, lastOkAt: number, coverage: string, truncated: boolean}>}}
 */
export function createFlightsEsFallback({
  es,
  now = () => Date.now(),
  lookbackMs = FLIGHTS_ES_FALLBACK_LOOKBACK_MS,
  maxRows = FLIGHTS_ES_FALLBACK_MAX_ROWS,
  cacheMs = FLIGHTS_ES_FALLBACK_CACHE_MS,
  cacheMaxEntries = FLIGHTS_ES_FALLBACK_CACHE_MAX_ENTRIES,
  negativeMs = FLIGHTS_ES_FALLBACK_NEGATIVE_CACHE_MS,
  maxQueries = FLIGHTS_ES_FALLBACK_MAX_QUERIES,
  maxConcurrentReads = FLIGHTS_ES_FALLBACK_MAX_CONCURRENT_READS,
  readDeadlineMs = FLIGHTS_ES_FALLBACK_READ_DEADLINE_MS,
  failureMs = FLIGHTS_ES_FALLBACK_FAILURE_CACHE_MS,
  log = null,
} = {}) {
  /**
   * Per-view in-memory answers (w,s,e,n -> {expiresAt, answer}). A bounded
   * LRU (review): the least recently used slot is evicted once
   * `cacheMaxEntries` is exceeded, and expired slots are dropped on sight,
   * so a wandering viewport can never grow the map without bound.
   * Negative answers (no recent rows) get the shorter `negativeMs`.
   */
  const cache = new Map();

  function cacheSet(key, answer, ttlMs) {
    if (!(ttlMs > 0)) return;
    // re-insert = most recently used
    cache.delete(key);
    cache.set(key, { expiresAt: now() + ttlMs, answer });
    // drop anything already expired, then the oldest slots over the cap
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= now()) cache.delete(k);
    }
    let over = cache.size - Math.max(1, cacheMaxEntries);
    for (const k of cache.keys()) {
      if (over <= 0) break;
      cache.delete(k);
      over -= 1;
    }
  }
  /** Recent ES failures, key -> {expiresAt, error}: bounded like `cache`. */
  const failures = new Map();

  function cacheSetFailure(key, error, ttlMs) {
    if (!(ttlMs > 0)) return;
    failures.delete(key);
    failures.set(key, { expiresAt: now() + ttlMs, error });
    for (const [k, entry] of failures) {
      if (entry.expiresAt <= now()) failures.delete(k);
    }
    let over = failures.size - Math.max(1, cacheMaxEntries);
    for (const k of failures.keys()) {
      if (over <= 0) break;
      failures.delete(k);
      over -= 1;
    }
  }
  /** Same-view reads in flight share one ES read. */
  const inflight = new Map();
  /**
   * Review: the GLOBAL number of ES reads in flight, across every viewport
   * (same-view reads already share one). A read past this fails closed: the
   * bridge serves the paused relay or 503 — the collector path is untouched.
   */
  let activeReads = 0;
  /** A failure is logged at most once a minute (review; HistoryApi parity). */
  let lastFailureLog = 0;

  function logFailure(error) {
    if (typeof log !== 'function') return;
    const t = now();
    if (t - lastFailureLog < 60_000) return;
    lastFailureLog = t;
    // a short internal reason only: an error message may carry a URL or key
    const reason =
      error instanceof HistoryUnavailableError && error.reason
        ? error.reason
        : 'flights_es_error';
    try {
      log(`[gev-history bridge] flights ES fallback unavailable (${reason})`);
    } catch {
      /* a broken logger must not break the fail-closed path */
    }
  }

  async function readEsBounded(bbox, requestT) {
    if (activeReads >= maxConcurrentReads) {
      throw new HistoryUnavailableError('flights_read_limit');
    }
    activeReads += 1;
    let deadline = null;
    const read = readEs(bbox, requestT);
    const timedOut = Symbol('deadline');
    try {
      return await Promise.race([
        read,
        new Promise((_, reject) => {
          // NOT unref'd: the deadline must fire even on an otherwise idle
          // loop, or a stuck read would hang the poll forever
          deadline = setTimeout(() => reject(timedOut), readDeadlineMs);
        }),
      ]);
    } catch (error) {
      // fail closed on the deadline as well; the read's own failure (if it
      // lands later) is swallowed here so nothing becomes an unhandled
      // rejection.
      read.catch(() => {});
      logFailure(error);
      throw new HistoryUnavailableError(
        error === timedOut ? 'flights_read_deadline' : 'flights_es_unavailable',
      );
    } finally {
      clearTimeout(deadline);
      activeReads -= 1;
    }
  }

  async function readEs(bbox, requestT) {
    const from = requestT - lookbackMs;
    const read = await latestPerKey(es, HISTORY_INDICES.opensky, {
      filter: [rangeMs(from, requestT), viewBoxClause(bbox)],
      field: 'icao24',
      order: 'desc',
      docValues: AIRCRAFT_STATE_DOC_VALUES,
      probe: true,
      concurrency: COLLAPSE_FANOUT,
      // review: the fallback is one of many consumers; it gets a small
      // slice and is marked truncated when it cannot finish within it
      maxQueries,
    });
    let latest = null; // epoch ms of the newest doc, the STALE header anchor
    const states = [];
    for (const hit of read.hits) {
      const source = hit?._source ?? hit?.fields ?? {};
      const state = openSkyState(source);
      if (!state) continue;
      const tsMs = docTimeMs(source);
      if (tsMs === null) continue;
      if (latest === null || tsMs > latest) latest = tsMs;
      states.push(state);
    }
    if (!states.length || latest === null) return null;
    // determinism: newest first, then ICAO (partitions complete out of order)
    states.sort(
      (x, y) => y[3] - x[3] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0),
    );
    const kept = states.slice(0, maxRows);
    const truncated = read.truncated || states.length > maxRows;
    return {
      body: JSON.stringify({ time: Math.round(latest / 1000), states: kept }),
      lastOkAt: latest,
      coverage: `recorded history ES fallback (${Math.round(lookbackMs / 60_000)} min${truncated ? ', truncated' : ''})`,
      truncated,
    };
  }

  async function read(url) {
    const bbox = parseFlightView(url.searchParams.get('view'));
    if (!bbox) return null;
    const key = bbox.join(',');
    const t = now();
    const cached = cache.get(key);
    if (cached && t < cached.expiresAt) {
      // re-insert: the slot just served is the most recently used
      cache.delete(key);
      cache.set(key, cached);
      return cached.answer;
    }
    const failed = failures.get(key);
    if (failed && t < failed.expiresAt) {
      // review: an outage is retried only after `failureMs`, not on
      // every poll — fail closed again from memory
      logFailure(failed.error);
      throw new HistoryUnavailableError('flights_es_unavailable');
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = readEsBounded(bbox, t)
        .then(
          (answer) => {
            inflight.delete(key);
            failures.delete(key);
            cacheSet(key, answer, answer ? cacheMs : negativeMs);
            return answer;
          },
          (error) => {
            inflight.delete(key);
            cacheSetFailure(key, error, failureMs);
            throw error;
          },
        )
        .catch((error) => {
          logFailure(error);
          throw error instanceof HistoryUnavailableError
            ? error
            : new HistoryUnavailableError('flights_es_unavailable');
        });
      inflight.set(key, pending);
    }
    return pending;
  }

  return { read, lookbackMs };
}

/**
 * The bridge's injected `esFallback` reader from the environment (the real
 * plugin initialization path), or null: not configured.
 */
export function flightsEsFallbackFromEnv(env = {}, { now, fetchImpl, log } = {}) {
  const config = flightsEsFallbackConfigFromEnv(env);
  if (!config) return null;
  const es = createHistoryEsClient({
    ...config.es,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return createFlightsEsFallback({
    es,
    ...(now ? { now } : {}),
    ...(log ? { log } : {}),
  });
}
