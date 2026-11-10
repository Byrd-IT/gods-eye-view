import { TRANSIT_FEED_REGISTRY } from '../../data/transitFeeds.js';
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';
import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import { flightsEsFallbackFromEnv } from './flightsEsFallback.js';
import { createTransitTrails } from './feedsC.js';
import { createWeatherImagery } from './weatherImagery.js';
import {
  DEFAULT_STALE_GREY_MS,
  parseGreyMs,
  staleThresholdMs,
} from './staleness.js';

/**
 * Collector bridge (gev-history DESIGN 4.1, 4.2, 2.4b; card B4).
 *
 * Vite plugin registered FIRST in server/standalone/vite.config.js, so for a
 * bridged feed it answers GET /api/<feed> before the upstream provider plugin
 * ever sees the request. It reads GEV_COLLECTOR_URLS (in order, S4 then S5)
 * at /v1/latest/<feed> and relays the collector's body byte for byte with its
 * X-Feed-* headers.
 *
 * D7, no fall-through: once a feed is bridged, this handler never calls
 * next() for GET/HEAD on its route and never contacts the upstream. When no
 * collector answers 200 it serves its own last-good copy (memory only),
 * marked X-Feed-Cache: STALE + X-Feed-Stale-Since + X-Feed-Reason once the
 * copy is older than the stale threshold, and 503 {noDataSince} only when it
 * has never had a snapshot. Other methods get 405 (the upstream plugin does
 * not check methods and would otherwise poll the upstream).
 *
 * Sub-paths: a non-terminal route (military, fire-perimeters, cyclones)
 * passes sub-paths it does not own to the next middleware (live GEV routes
 * such as /api/military/track, /api/fire-perimeters/inciweb/*). A terminal
 * route (feed.terminal: FIRMS) is one middleware that answers its exact
 * entry paths and 404s every other sub-path and method itself
 * (createTerminalRoute), because the upstream FIRMS plugin polls on any
 * sub-path.
 *
 * Pattern routes (feed.pathPattern, B7 CelesTrak): one entry answers a family
 * of sub-paths, /api/celestrak/<group> -> /v1/latest/celestrak-<group>; each
 * group has its own last-good copy and state (at most MAX_PATTERN_SLOTS
 * copies, admitted only on a collector 200 and kept for the most recently
 * requested groups).
 * The group set is not listed here: the collector discovers groups from
 * these requests.
 *
 * Last-good copies are kept per collector snapshot and, inside it, per
 * feed.cacheKey(url) (B8; default: one slot), so a query-shaped answer
 * (vessels ?maxRows=) is never served for a different query: the vessels key
 * is GEV's normalised maxRows. At most feed.cacheEntries copies (default 1)
 * and BRIDGE_CACHE_MAX_BYTES in total are kept per snapshot, least recently
 * used evicted first. A query with no copy of its own gets the 503
 * no-snapshot answer, never another query's.
 *
 * Owner N5: the server never clears a layer. It adds X-Feed-Grey-Until
 * (X-Feed-Stale-Since + GEV_STALE_GREY_MS) so the client decides grey vs
 * cleared on the server clock (staleness.js feedDisplayState).
 *
 * Approved Option 1 (`flightsEsFallback.js`): the flights feed can pass an
 * injected ES-only reader. It is asked when the collector is down (no
 * answer) or when its answer would otherwise be served without data — a
 * paused empty envelope or a cache copy that is empty or older than the
 * fallback's lookback; its answer is served marked STALE + grey with
 * X-Flight-Coverage naming the fallback, an old copy is still served when
 * ES has nothing. A reader failure or a null answer keeps the normal 503
 * no-snapshot — no fall-through, the upstream plugins are never reached.
 *
 * Every feed is OFF unless GEV_BRIDGE_<FEED>=1 (rollback flag). With every
 * flag off the plugin installs no middleware: behaviour is byte-identical to
 * a build without it.
 *
 * Quiet failure: no per-request logging; one line per state transition
 * (collector -> cache -> none and back).
 */

export const DEFAULT_COLLECTOR_URLS = Object.freeze(['http://127.0.0.1:4180']);
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 2_000;
/** Most per-path copies one pattern route keeps (CelesTrak groups). */
export const MAX_PATTERN_SLOTS = 32;
/** Upper bound of the last-good copies one snapshot keeps (all keys together). */
export const BRIDGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** Collector response headers relayed to the browser. */
export const RELAYED_HEADERS = Object.freeze([
  'content-type',
  'cache-control',
  'x-feed-source',
  'x-feed-cache',
  'x-feed-age-ms',
  'x-feed-last-ok',
  'x-feed-stale-since',
  'x-feed-reason',
  'x-collector-role',
  // B20 flights: what the viewport answer covers (GEV's flights source
  // shows it as the layer coverage)
  'x-flight-coverage',
]);

const CANONICAL = Object.freeze({
  'content-type': 'Content-Type',
  'cache-control': 'Cache-Control',
  'x-feed-source': 'X-Feed-Source',
  'x-feed-cache': 'X-Feed-Cache',
  'x-feed-age-ms': 'X-Feed-Age-Ms',
  'x-feed-last-ok': 'X-Feed-Last-OK',
  'x-feed-stale-since': 'X-Feed-Stale-Since',
  'x-feed-reason': 'X-Feed-Reason',
  'x-collector-role': 'X-Collector-Role',
  'x-flight-coverage': 'X-Flight-Coverage',
});

// Collector metadata is untrusted even on successful responses.  Keep the
// formats bounded and consistent with the collector's documented output.
// Keep these labels aligned with collector src/feeds/transit.js and
// src/feeds/gbfs.js; unknown labels are dropped rather than echoed.
const SOURCE_LABELS = new Set([
  // collector.js answers the static transit catalog (/v1/latest/transit-feeds)
  // with this fixed label.
  'collector registry',
  ...Object.values(BRIDGE_FEEDS).map((feed) => feed.source),
  ...TRANSIT_FEED_REGISTRY.map((feed) => `GTFS-RT ${feed.name}`),
  ...GBFS_CITY_REGISTRY.map((city) => `GBFS ${city.provider}`),
]);

const METADATA_FORMATS = Object.freeze({
  'x-feed-source': /^[\p{L}0-9][\p{L}0-9 .\/()_-]{0,63}$/u,
  'x-feed-cache': /^(?:HIT|MISS|STALE)$/,
  'x-feed-age-ms': /^[0-9]{1,15}$/,
  'x-feed-last-ok': /^[0-9]{1,15}$/,
  'x-feed-stale-since': /^[0-9]{1,15}$/,
  'x-feed-reason':
    /^(?:no_snapshot|upstream_error|halted|incomplete_coverage|system_down|collector_down|bridge_error|opensky_paused_until=(?:[01][0-9]|2[0-3]):[0-5][0-9])$/,
  'x-collector-role': /^(?:active|standby)$/,
  'x-flight-coverage':
    /^OpenSky viewport tiles \([0-9]{1,5}\)(?:, cached areas only|, incomplete: (?:100|[0-9]{1,2})% of the view)?$/,
});

function validMetadata(key, value) {
  const format = METADATA_FORMATS[key];
  return (
    !format ||
    (typeof value === 'string' &&
      !/[\r\n]/.test(value) &&
      format.test(value) &&
      (key !== 'x-feed-source' || SOURCE_LABELS.has(value)))
  );
}

/** Parse GEV_COLLECTOR_URLS (comma separated http(s) base URLs). */
export function parseCollectorUrls(value) {
  const text = String(value ?? '').trim();
  if (!text) return [...DEFAULT_COLLECTOR_URLS];
  const urls = [];
  for (const raw of text.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    let url;
    try {
      url = new URL(item);
    } catch {
      throw new Error('GEV_COLLECTOR_URLS has an invalid URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username) {
      throw new Error('GEV_COLLECTOR_URLS must be plain http(s) base URLs');
    }
    urls.push(url.href.replace(/\/+$/, ''));
  }
  if (!urls.length) return [...DEFAULT_COLLECTOR_URLS];
  return urls;
}

function parseTimeoutMs(value) {
  const text = String(value ?? '').trim();
  const n = Number(text);
  return /^[0-9]+$/.test(text) && n > 0 && n <= 30_000
    ? n
    : DEFAULT_COLLECTOR_TIMEOUT_MS;
}

/** Bridge configuration from the environment (read once at plugin creation). */
export function bridgeConfigFromEnv(env = {}) {
  return {
    feeds: enabledBridgeFeeds(env),
    urls: parseCollectorUrls(env.GEV_COLLECTOR_URLS),
    timeoutMs: parseTimeoutMs(env.GEV_COLLECTOR_TIMEOUT_MS),
    greyMs: parseGreyMs(env.GEV_STALE_GREY_MS),
  };
}

function epoch(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Request handler for one bridged feed.
 *
 * @param {object} options
 * @param {string} options.name feed key in BRIDGE_FEEDS
 * @param {string[]} [options.urls] collector base URLs, tried in order
 * @param {number} [options.timeoutMs] per collector attempt
 * @param {number} [options.greyMs] GEV_STALE_GREY_MS
 * @param {typeof fetch} [options.fetchImpl] collector reads
 * @param {typeof fetch} [options.liveFetchImpl] live image bytes only
 *   (weather GetMap, feed.imagery)
 * @param {Function} [options.weatherProxy] GEV's weatherProxy factory,
 *   injected server-side (server/byrdit/history.js); absent = weather
 *   tile/image fail closed (503)
 * @param {{attachRoute?: Function}} [options.weatherServing] B12c R1b:
 *   history imagery is told this bridge's private weather route manifest
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log] state transitions only
 */
export function createCollectorBridge({
  name,
  urls = DEFAULT_COLLECTOR_URLS,
  timeoutMs = DEFAULT_COLLECTOR_TIMEOUT_MS,
  greyMs = DEFAULT_STALE_GREY_MS,
  fetchImpl = (...args) => globalThis.fetch(...args),
  liveFetchImpl = (...args) => globalThis.fetch(...args),
  weatherProxy,
  weatherServing,
  now = () => Date.now(),
  log = (line) => console.warn(line),
  /**
   * Approved Option 1 (flights): ES-only fallback reader
   * (createFlightsEsFallback). read(url) -> {body, lastOkAt, coverage,
   * truncated} | null with .lookbackMs; asked when the collector is down
   * or its answer would not be data (paused empty, empty/over-lookback
   * cached copy).
   */
  esFallback = null,
}) {
  const feed = BRIDGE_FEEDS[name];
  if (!feed) throw new Error(`unknown bridge feed: ${name}`);
  /**
   * Per collector snapshot (B15: one route can resolve to many, e.g. one per
   * transit feed or GBFS system): last good copies and the last served answer
   * ('collector' | 'cache' | 'none') for transition logging. Keys are bounded
   * by the resolvers (registry ids only) or MAX_PATTERN_SLOTS.
   * caches: snapshot -> Map(cache key -> { body: Uint8Array, contentType,
   * lastOkAt }), Map order = least recently used first (B8 R3).
   */
  const caches = new Map();
  const states = new Map();
  const cacheKeyOf = feed.cacheKey ?? (() => '');
  const cacheEntries = Math.max(1, feed.cacheEntries ?? 1);

  function cacheGet(key, ck) {
    const slots = caches.get(key);
    const entry = slots?.get(ck);
    if (entry) {
      slots.delete(ck);
      slots.set(ck, entry);
    }
    return entry ?? null;
  }

  function cacheSet(key, ck, entry) {
    let slots = caches.get(key);
    if (!slots) {
      slots = new Map();
      caches.set(key, slots);
    }
    slots.delete(ck);
    slots.set(ck, entry);
    let bytes = 0;
    for (const e of slots.values()) bytes += e.body.byteLength;
    for (const [k, e] of slots) {
      if (k === ck) break; // the newest copy is always kept
      if (slots.size <= cacheEntries && bytes <= BRIDGE_CACHE_MAX_BYTES) break;
      slots.delete(k);
      bytes -= e.body.byteLength;
    }
    if (!pattern) return;
    // pattern route (t_eb2c4e10): admitted only here (collector 200), newest
    // group last; the least recently requested group's copies are dropped
    caches.delete(key);
    caches.set(key, slots);
    while (caches.size > MAX_PATTERN_SLOTS) {
      caches.delete(caches.keys().next().value);
    }
    trimStates();
  }
  /** In-flight collector read shared by concurrent requests, keyed by feed+query. */
  const inflight = new Map();
  const trails = feed.trails ? createTransitTrails({ now }) : null;
  // B15 R4: weather tile/image validated against collector-owned metadata
  const imagery = feed.imagery
    ? createWeatherImagery({
        readCollector: (collectorFeed) => sharedRead(collectorFeed, ''),
        liveFetch: liveFetchImpl,
        weatherProxy,
        now,
      })
    : null;
  if (imagery) weatherServing?.attachRoute?.(imagery.manifest);

  // B7 pattern route (CelesTrak): one entry, one collector snapshot per
  // group (/api/celestrak/<group> -> celestrak-<group>)
  const pattern = feed.pathPattern ? new RegExp(feed.pathPattern) : null;

  /**
   * Pattern-route bounds (t_eb2c4e10). The group set comes from requests, so
   * both Maps are bounded and kept in recency order (Map insertion order,
   * re-inserted on every request for the key):
   * - caches: at most MAX_PATTERN_SLOTS last-good copies. Only a group the
   *   collector answered 200 for is admitted; when full, the copy whose group
   *   was requested least recently is dropped. A group the collector never
   *   had (no snapshot) never takes a copy slot, so it cannot keep a useful
   *   group from keeping its last-good copy.
   * - states: every group with a copy, plus at most MAX_PATTERN_SLOTS groups
   *   without one (least recently requested dropped first). A repeated
   *   request keeps its group's state, so it logs only real transitions.
   * Resolver/plain entries (B15, B6, ...) are unchanged: their keys are
   * registry ids, bounded by the registry, and nothing is ever dropped.
   */
  function touch(map, key) {
    if (!pattern || !map.has(key)) return;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
  }

  function trimStates() {
    let extra = -MAX_PATTERN_SLOTS;
    for (const key of states.keys()) if (!caches.has(key)) extra += 1;
    for (const key of states.keys()) {
      if (extra <= 0) break;
      if (caches.has(key)) continue;
      states.delete(key);
      extra -= 1;
    }
  }

  function transition(key, next, detail) {
    const state = states.get(key) ?? null;
    touch(states, key);
    if (next === state) return;
    const previous = state ?? 'start';
    states.set(key, next);
    if (pattern) trimStates();
    const label = key === feed.collectorFeed ? name : `${name}/${key}`;
    log(
      `[gev-history bridge] ${label}: ${previous} -> ${next}${detail ? ` (${detail})` : ''}`,
    );
  }

  /**
   * One collector read, collectors tried in order. `lease` (B20 flights):
   * POST /v1/aircraft/view {sid, bbox} instead of GET /v1/latest/<feed>;
   * the answer has the same contract (body + X-Feed-* headers).
   */
  async function readCollector(collectorFeed, search, lease = null) {
    let reason = 'collector_down';
    for (const base of urls) {
      try {
        const response = await fetchImpl(
          lease
            ? `${base}/v1/aircraft/view`
            : `${base}/v1/latest/${collectorFeed}${search}`,
          lease
            ? {
                method: 'POST',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(lease),
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
              }
            : {
                headers: { Accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
              },
        );
        const body = new Uint8Array(await response.arrayBuffer());
        if (
          response.status === 200 ||
          (feed.relayStatus ?? []).includes(response.status)
        ) {
          const headers = {};
          for (const key of RELAYED_HEADERS) {
            const value = response.headers.get(key);
            if (value !== null && validMetadata(key, value))
              headers[CANONICAL[key]] = value;
          }
          return { ok: true, status: response.status, body, headers };
        }
        // Standby (503, no X-Feed-Reason) or an active collector with no
        // snapshot yet: keep its reason, try the next collector.
        const r = response.headers.get('x-feed-reason');
        if (r && validMetadata('x-feed-reason', r)) reason = r;
      } catch {
        /* unreachable / timeout: next collector */
      }
    }
    return { ok: false, reason };
  }

  /**
   * Query string sent to the collector: the raw one (forwardQuery), only
   * the allow-listed parameters in a canonical order (forwardParams, B8), or
   * nothing.
   */
  function forwardedSearch(url) {
    if (feed.forwardParams) {
      const out = new URLSearchParams();
      for (const key of feed.forwardParams) {
        const value = url.searchParams.get(key);
        if (value !== null) out.set(key, value);
      }
      const text = out.toString();
      return text ? `?${text}` : '';
    }
    return feed.forwardQuery ? url.search : '';
  }

  /**
   * An envelope with zero states (the paused body): not useful data.
   */
  function emptyFlightStates(body) {
    try {
      const parsed = JSON.parse(new TextDecoder('utf8').decode(body));
      return Array.isArray(parsed.states) && parsed.states.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Review: relay the collector's paused 200 (existing behaviour). The
   * paused body is an EMPTY states envelope — HTTP-clean but not data —
   * so it is NEVER cached: a paused empty copy would later be served as
   * last-good data (a false green with no snapshot behind it — the empty
   * pause cannot be told apart from real data in the last-good map) and
   * would shadow the ES fallback.
   */
  function finishPaused(req, res, target, headers, result) {
    transition(target.collectorFeed, 'collector');
    send(req, res, 200, decorate(headers, target), result.body);
  }

  function sharedRead(collectorFeed, search, lease = null) {
    const key = lease
      ? `${collectorFeed} view ${lease.sid} ${lease.bbox}`
      : `${collectorFeed}${search}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = readCollector(collectorFeed, search, lease).finally(() =>
        inflight.delete(key),
      );
      inflight.set(key, pending);
    }
    return pending;
  }

  function withGrey(headers) {
    const since = epoch(headers['X-Feed-Stale-Since']);
    if (since !== null) headers['X-Feed-Grey-Until'] = String(since + greyMs);
    return headers;
  }

  function send(req, res, status, headers, body) {
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function decorate(headers, target) {
    return feed.decorate ? feed.decorate(headers, target) : headers;
  }

  function serveCache(req, res, reason, target, cache, degraded = null) {
    const key = target.collectorFeed;
    touch(caches, key);
    const t = now();
    const age = Math.max(0, t - cache.lastOkAt);
    // `degraded` (t_9e0ff678, paused collector): the layer cannot improve
    // while the collector is paused, so even a fresh copy is marked STALE
    // and the degraded reason (e.g. opensky_paused_until=..) is preserved.
    const stale = degraded !== null || age > staleThresholdMs(target.cadenceMs);
    const headers = {
      'Content-Type': cache.contentType,
      'Cache-Control': 'no-store',
      'X-Feed-Source': feed.source,
      'X-Feed-Cache': stale ? 'STALE' : 'HIT',
      'X-Feed-Age-Ms': String(age),
      'X-Feed-Last-OK': String(cache.lastOkAt),
      'X-Feed-Bridge': 'cache',
    };
    if (stale) {
      // never point Stale-Since into the future (review)
      headers['X-Feed-Stale-Since'] = String(
        Math.max(
          0,
          Math.min(cache.lastOkAt + staleThresholdMs(target.cadenceMs), t),
        ),
      );
      headers['X-Feed-Reason'] = degraded ?? reason;
    }
    transition(key, 'cache', degraded ?? reason);
    send(req, res, 200, decorate(withGrey(headers), target), cache.body);
  }

  function serveNone(req, res, reason, target) {
    transition(target.collectorFeed, 'none', reason);
    send(
      req,
      res,
      503,
      {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Feed-Source': feed.source,
        'X-Feed-Reason': reason,
        'X-Feed-Bridge': 'none',
      },
      JSON.stringify({ error: 'no snapshot', noDataSince: null }),
    );
  }

  /**
   * Approved Option 1 (flights): a bounded ES read, always marked STALE +
   * grey with Stale-Since = the newest position time: the collector is
   * down, so the layer is degraded even when a recorded position is
   * recent. `reason` names why the layer is degraded (review: a paused
   * collector keeps its actual reason, e.g. opensky_paused_until=.., so
   * the chip still says "OpenSky paused until ...").
   */
  function serveEs(req, res, answer, target, reason = 'es_fallback') {
    const t = now();
    // review: never advertise a future timestamp after the server clock
    const lastOkAt = Math.min(answer.lastOkAt, t);
    const age = Math.max(0, t - lastOkAt);
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': feed.source,
      'X-Feed-Cache': 'STALE',
      'X-Feed-Age-Ms': String(age),
      'X-Feed-Last-OK': String(lastOkAt),
      'X-Feed-Stale-Since': String(lastOkAt),
      'X-Feed-Reason': reason,
      'X-Feed-Bridge': 'es-fallback',
      'X-Flight-Coverage': answer.coverage,
    };
    transition(target.collectorFeed, 'es-fallback', 'es_fallback');
    send(req, res, 200, decorate(withGrey(headers), target), answer.body);
  }

  /** The OpenSky-budget pause reason, `opensky_paused_until=HH:MM`. */
  const OPENSKY_PAUSED_REASON = /^opensky_paused_until=([0-9]{2}:[0-9]{2})$/;

  /**
   * Review: a paused collector (OpenSky budget exhausted) answers 200 with
   * its own STALE headers and an EMPTY states envelope — HTTP-clean but not
   * data. Returns the paused reason when `result` is such an answer, null
   * when it is a real snapshot (a body that does not parse counts as real:
   * collector bodies are relayed byte for byte, whatever they are).
   */
  function pausedEmptyReason(result) {
    if (result.status !== 200) return null;
    const reason = result.headers['X-Feed-Reason'];
    if (!reason || !OPENSKY_PAUSED_REASON.test(reason)) return null;
    try {
      const parsed = JSON.parse(new TextDecoder('utf8').decode(result.body));
      return Array.isArray(parsed.states) && parsed.states.length === 0
        ? reason
        : null;
    } catch {
      return null;
    }
  }

  return async function collectorBridge(req, res, next) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return next();
    }
    // The mount also matches sub-routes (/api/military/track,
    // /api/fire-perimeters/inciweb/*): only the entry's own path (or, for a
    // pattern route, the paths its pattern matches) is bridged. Resolver
    // entries (B15) map the path to one collector snapshot.
    let target;
    if (feed.resolve) {
      target = feed.resolve(url);
      if (!target) return next();
    } else if (pattern) {
      // B7 pattern route: the paths its pattern matches
      const m = pattern.exec(url.pathname);
      if (!m) return next();
      target = {
        collectorFeed: `${feed.collectorFeedPrefix}${m[1].toLowerCase()}`,
        cadenceMs: feed.cadenceMs,
      };
    } else {
      if (url.pathname !== (feed.path ?? '/')) return next();
      target = { collectorFeed: feed.collectorFeed, cadenceMs: feed.cadenceMs };
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        Allow: 'GET, HEAD',
      });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (target.reply) {
      send(
        req,
        res,
        target.reply.status,
        target.reply.headers,
        target.reply.body,
      );
      return;
    }
    if (target.local === 'trail') {
      const r = trails.answer(target.transitFeed, target.vehicleId);
      send(req, res, r.status, r.headers, r.body);
      return;
    }
    if (target.local === 'weatherImagery') {
      // never next(): GEV's live plugin would read NOAA GetCapabilities
      await imagery.handle(req, res);
      return;
    }
    const key = target.collectorFeed;
    /**
     * Review: when the ES fallback is configured, the cached copy
     * qualifies only when it is worth showing before ES is asked: not an
     * empty states envelope (never useful data) and not older than the
     * fallback's lookback (a copy that would report as cleared while
     * recorded positions exist in the last 15 minutes). A usable copy
     * wins straight away; otherwise ES is asked once, and an old or
     * empty copy is still the answer when ES has nothing left.
     * Flag-off and other feeds strictly keep the plain last-good rule:
     * the empty-states and lookback qualifications are ES-fallback
     * reasoning and never leak into a reader-less bridge.
     */
    const usableCopy = (entry) => {
      if (!entry) return false;
      if (emptyFlightStates(entry.body)) return false;
      const lookbackMs = esFallback?.lookbackMs;
      if (typeof lookbackMs === 'number' && lookbackMs > 0) {
        return now() - entry.lastOkAt <= lookbackMs;
      }
      return true;
    };
    /** Ask the ES fallback once; true when its answer was served. */
    async function tryServeEs(reason) {
      if (!esFallback) return false;
      try {
        const answer = await esFallback.read(url);
        if (answer) {
          serveEs(req, res, answer, target, reason);
          return true;
        }
      } catch {
        /* ES unavailable or throttled: below, never the upstream plugin */
      }
      return false;
    }
    const fallback = async (reason) => {
      const entry = cacheGet(key, cacheKeyOf(url));
      // The qualification above (empty states, lookback) is ES-fallback
      // reasoning: a reader-less bridge (flag-off or another feed) keeps
      // the plain last-good rule, byte for byte.
      if (esFallback ? usableCopy(entry) : entry) {
        return serveCache(req, res, reason, target, entry);
      }
      const esServed = await tryServeEs();
      if (esServed) return;
      if (entry) return serveCache(req, res, reason, target, entry);
      serveNone(req, res, reason, target);
    };
    try {
      const lease = feed.viewLease ? feed.viewLease(url) : null;
      const result = await sharedRead(
        key,
        lease ? '' : forwardedSearch(url),
        lease,
      );
      if (result.ok && result.status !== 200) {
        // relayed client error (vessels track 400): never cached
        transition(key, 'collector');
        send(
          req,
          res,
          result.status,
          { ...result.headers, 'X-Feed-Bridge': 'collector' },
          result.body,
        );
        return;
      }
      if (result.ok) {
        const headers = withGrey({ ...result.headers });
        headers['X-Feed-Bridge'] = 'collector';
        if (feed.cache === false) {
          // per-request answer (vessels track): no last-good copy
          transition(key, 'collector');
          send(req, res, 200, decorate(headers, target), result.body);
          return;
        }
        // Review (t_9e0ff678): a paused collector's empty 200 is not data. A
        // useful per-view copy is preferred (marked STALE, the paused reason
        // preserved), then the ES fallback if configured; with neither, the
        // paused answer itself is relayed unchanged — and never cached, so
        // a paused empty body can never show false green or shadow the ES
        // fallback later. This handling is enabled only with the ES reader;
        // flag-off and unrelated feeds retain their original behavior.
        const pausedReason = esFallback ? pausedEmptyReason(result) : null;
        if (pausedReason) {
          const entry = cacheGet(key, cacheKeyOf(url));
          // Review: the same qualification as the down path — a useful,
          // not-too-old copy wins, then ES, then an old copy if it has
          // one, else the paused answer relayed unchanged
          if (esFallback ? usableCopy(entry) : entry) {
            return serveCache(
              req,
              res,
              'collector_down',
              target,
              entry,
              pausedReason,
            );
          }
          if (await tryServeEs(pausedReason)) return;
          if (entry) {
            return serveCache(
              req,
              res,
              'collector_down',
              target,
              entry,
              pausedReason,
            );
          }
          return finishPaused(req, res, target, headers, result);
        }
        const lastOk = epoch(headers['X-Feed-Last-OK']);
        const age = epoch(headers['X-Feed-Age-Ms']);
        cacheSet(key, cacheKeyOf(url), {
          body: result.body,
          contentType: headers['Content-Type'] ?? 'application/json',
          lastOkAt: lastOk ?? now() - (age ?? 0),
        });
        if (trails && target.transitFeed)
          trails.ingest(target.transitFeed, result.body);
        transition(key, 'collector');
        send(req, res, 200, decorate(headers, target), result.body);
        return;
      }
      await fallback(result.reason);
    } catch {
      // Never fall through to the upstream plugin, whatever failed here.
      if (res.headersSent) {
        res.end();
        return;
      }
      await fallback('bridge_error');
    }
  };
}

/**
 * One middleware for a terminal route namespace (feed.terminal, e.g.
 * /api/firms): the exact entry paths go to their bridge handlers; every other
 * sub-path, whatever the method, is answered 404 here and NEVER reaches the
 * upstream plugin (D7). The raw sub-path (before `?`) must equal an entry's
 * path byte for byte, so /status/, //, /%73tatus and /./status are not
 * aliases. A bridge handler that would call next() is answered 404 too.
 *
 * @param {object} options
 * @param {string} options.source X-Feed-Source of the namespace
 * @param {{path?: string, pattern?: RegExp, handler: Function}[]} options.entries
 *   an entry with `pattern` (pattern route, B7) owns every raw sub-path the
 *   pattern matches
 */
export function createTerminalRoute({ source, entries }) {
  const notFound = (req, res) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': source,
      'X-Feed-Bridge': 'unrouted',
    });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : JSON.stringify({ error: 'not found' }),
    );
  };
  return function terminalRoute(req, res) {
    const subPath = String(req.url || '/').split('?')[0];
    const entry = entries.find((e) =>
      e.pattern ? e.pattern.test(subPath) : e.path === subPath,
    );
    if (!entry) {
      notFound(req, res);
      return undefined;
    }
    return entry.handler(req, res, () => notFound(req, res));
  };
}

/**
 * Vite plugin. `env` is read once when the plugin is created (Vite loads .env
 * into process.env before vite.config.js builds the plugin list).
 */
export function collectorBridgePlugin({
  env = globalThis.process?.env ?? {},
  fetchImpl,
  liveFetchImpl,
  weatherProxy,
  weatherServing,
  now,
  log,
} = {}) {
  const config = bridgeConfigFromEnv(env);
  // Approved Option 1 (flights): the ES-only reader when its flag + reader
  // key are set; feeds without feed.esFallback never receive it.
  const flightsFallback = flightsEsFallbackFromEnv(env, { now, log });
  const install = (server) => {
    /** Terminal routes already mounted in this install (one middleware each). */
    const terminalMounted = new Set();
    const make = (name) =>
      createCollectorBridge({
        name,
        urls: config.urls,
        timeoutMs: config.timeoutMs,
        greyMs: config.greyMs,
        fetchImpl,
        liveFetchImpl,
        weatherProxy,
        weatherServing,
        now,
        log,
        esFallback: BRIDGE_FEEDS[name].esFallback ? flightsFallback : undefined,
      });
    for (const name of config.feeds) {
      const { route, terminal } = BRIDGE_FEEDS[name];
      if (!terminal) {
        server.middlewares.use(route, make(name));
        continue;
      }
      if (terminalMounted.has(route)) continue;
      terminalMounted.add(route);
      const entries = config.feeds
        .filter((other) => BRIDGE_FEEDS[other].route === route)
        .map((other) => ({
          path: BRIDGE_FEEDS[other].path ?? '/',
          pattern: BRIDGE_FEEDS[other].pathPattern
            ? new RegExp(BRIDGE_FEEDS[other].pathPattern)
            : null,
          handler: make(other),
        }));
      server.middlewares.use(
        route,
        createTerminalRoute({ source: BRIDGE_FEEDS[name].source, entries }),
      );
    }
  };
  return {
    name: 'byrdit-history-bridge',
    configureServer: install,
    configurePreviewServer: install,
  };
}
