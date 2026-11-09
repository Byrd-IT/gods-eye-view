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
 *    historyCollapse.latestPerKey), capped at FLIGHTS_FALLBACK_MAX_ROWS.
 *  - The answer is the live envelope itself, {time, states} with OpenSky
 *    18-field state vectors (openSkyState), so the existing flights
 *    renderer and OpenSky parsers read it unchanged.
 *  - STALE + grey: served always as X-Feed-Cache: STALE with
 *    X-Feed-Stale-Since = the newest position time, X-Feed-Reason and the
 *    bridge's X-Feed-Grey-Until, so staleness.js feedDisplayState shows the
 *    GREY chip "No data since HH:MM <tz>" without any client change.
 *  - A fresh-in-memory answer is preferred: one read per view per
 *    FLIGHTS_ES_FALLBACK_CACHE_MS; concurrent same-view reads share one
 *    read. Negative answers (no recent rows) are not cached.
 *  - Failure never falls through: the reader throws, the bridge serves its
 *    normal 503 no-snapshot, and the upstream OpenSky / adsb.lol plugins
 *    are never reached.
 *
 * Off unless GEV_BRIDGE_FLIGHTS_ES_FALLBACK=1 together with the reader key
 * settings the /api/history routes already use (GEV_HISTORY_ES_URL,
 * GEV_HISTORY_ES_API_KEY) — the deployed behaviour without the flag is
 * byte-identical to a build without this module.
 *
 * Browser-safe: no Node built-ins, no DOM.
 */

import { COLLAPSE_FANOUT, latestPerKey } from './historyCollapse.js';
import { HISTORY_INDICES, createHistoryEsClient, esConfigFromEnv } from './historyEs.js';
import { AIRCRAFT_STATE_DOC_VALUES } from './historyService.js';
import { openSkyState, docTimeMs } from './historyRows.js';
import { parseFlightView } from './feeds.js';

/** Only recently recorded positions are served (owner decision). */
export const FLIGHTS_ES_FALLBACK_LOOKBACK_MS = 15 * 60_000;
/** Upper bound of aircraft in one answer. */
export const FLIGHTS_ES_FALLBACK_MAX_ROWS = 5_000;
/** A fresh answer is reused from memory for this long. */
export const FLIGHTS_ES_FALLBACK_CACHE_MS = 30_000;
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
} = {}) {
  /** Per-view in-memory answers (w,s,e,n -> {expiresAt, answer}). */
  const cache = new Map();
  /** Same-view reads in flight share one ES read. */
  const inflight = new Map();

  async function readEs(bbox, requestT) {
    const from = requestT - lookbackMs;
    const read = await latestPerKey(es, HISTORY_INDICES.opensky, {
      filter: [rangeMs(from, requestT), viewBoxClause(bbox)],
      field: 'icao24',
      order: 'desc',
      docValues: AIRCRAFT_STATE_DOC_VALUES,
      probe: true,
      concurrency: COLLAPSE_FANOUT,
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
    states.sort((x, y) => y[3] - x[3] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
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
    if (cached && t < cached.expiresAt) return cached.answer;
    let pending = inflight.get(key);
    if (!pending) {
      pending = readEs(bbox, t)
        .catch((error) => {
          inflight.delete(key);
          throw error;
        })
        .then((answer) => {
          inflight.delete(key);
          if (answer)
            cache.set(key, { expiresAt: now() + cacheMs, answer });
          return answer;
        });
      inflight.set(key, pending);
    }
    return pending;
  }

  return { read };
}

/**
 * The bridge's injected `esFallback` reader from the environment (the real
 * plugin initialization path), or null: not configured.
 */
export function flightsEsFallbackFromEnv(env = {}, { now, fetchImpl } = {}) {
  const config = flightsEsFallbackConfigFromEnv(env);
  if (!config) return null;
  const es = createHistoryEsClient({ ...config.es, ...(fetchImpl ? { fetchImpl } : {}) });
  return createFlightsEsFallback({ es, ...(now ? { now } : {}) });
}
