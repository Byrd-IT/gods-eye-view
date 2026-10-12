import { BRIDGE_FEEDS, enabledBridgeFeeds } from './feeds.js';
import { createTransitTrails } from './feedsC.js';
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
 * Owner N5: the server never clears a layer. It adds X-Feed-Grey-Until
 * (X-Feed-Stale-Since + GEV_STALE_GREY_MS) so the client decides grey vs
 * cleared on the server clock (staleness.js feedDisplayState).
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
});

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
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log] state transitions only
 */
export function createCollectorBridge({
  name,
  urls = DEFAULT_COLLECTOR_URLS,
  timeoutMs = DEFAULT_COLLECTOR_TIMEOUT_MS,
  greyMs = DEFAULT_STALE_GREY_MS,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = (line) => console.warn(line),
}) {
  const feed = BRIDGE_FEEDS[name];
  if (!feed) throw new Error(`unknown bridge feed: ${name}`);
  /**
   * Per collector snapshot (B15: one route can resolve to many, e.g. one per
   * transit feed or GBFS system): last good copy { body: Uint8Array,
   * contentType, lastOkAt } and the last served answer ('collector' |
   * 'cache' | 'none') for transition logging. Keys are bounded by the
   * resolvers (registry ids only).
   */
  const caches = new Map();
  const states = new Map();
  /** In-flight collector read shared by concurrent requests, keyed by feed+query. */
  const inflight = new Map();
  const trails = feed.trails ? createTransitTrails({ now }) : null;

  function transition(key, next, detail) {
    const state = states.get(key) ?? null;
    if (next === state) return;
    const previous = state ?? 'start';
    states.set(key, next);
    const label = key === feed.collectorFeed ? name : `${name}/${key}`;
    log(
      `[gev-history bridge] ${label}: ${previous} -> ${next}${detail ? ` (${detail})` : ''}`,
    );
  }

  async function readCollector(collectorFeed, search) {
    let reason = 'collector_down';
    for (const base of urls) {
      try {
        const response = await fetchImpl(
          `${base}/v1/latest/${collectorFeed}${search}`,
          {
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        const body = new Uint8Array(await response.arrayBuffer());
        if (response.status === 200) {
          const headers = {};
          for (const key of RELAYED_HEADERS) {
            const value = response.headers.get(key);
            if (value !== null) headers[CANONICAL[key]] = value;
          }
          return { ok: true, body, headers };
        }
        // Standby (503, no X-Feed-Reason) or an active collector with no
        // snapshot yet: keep its reason, try the next collector.
        const r = response.headers.get('x-feed-reason');
        if (r && /^[a-z0-9_=:.-]{1,64}$/i.test(r)) reason = r;
      } catch {
        /* unreachable / timeout: next collector */
      }
    }
    return { ok: false, reason };
  }

  function sharedRead(collectorFeed, search) {
    const key = `${collectorFeed}${search}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = readCollector(collectorFeed, search).finally(() =>
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

  function serveCache(req, res, reason, target) {
    const key = target.collectorFeed;
    const cache = caches.get(key);
    const t = now();
    const age = Math.max(0, t - cache.lastOkAt);
    const stale = age > staleThresholdMs(target.cadenceMs);
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
      headers['X-Feed-Stale-Since'] = String(
        cache.lastOkAt + staleThresholdMs(target.cadenceMs),
      );
      headers['X-Feed-Reason'] = reason;
    }
    transition(key, 'cache', reason);
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

  return async function collectorBridge(req, res, next) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return next();
    }
    // The mount also matches sub-routes (/api/military/track,
    // /api/fire-perimeters/inciweb/*): only the entry's own path is bridged.
    // Resolver entries (B15) map the path to one collector snapshot.
    let target;
    if (feed.resolve) {
      target = feed.resolve(url);
      if (!target) return next();
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
    const key = target.collectorFeed;
    try {
      const result = await sharedRead(key, feed.forwardQuery ? url.search : '');
      if (result.ok) {
        const headers = withGrey({ ...result.headers });
        headers['X-Feed-Bridge'] = 'collector';
        const lastOk = epoch(headers['X-Feed-Last-OK']);
        const age = epoch(headers['X-Feed-Age-Ms']);
        caches.set(key, {
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
      if (caches.has(key)) serveCache(req, res, result.reason, target);
      else serveNone(req, res, result.reason, target);
    } catch {
      // Never fall through to the upstream plugin, whatever failed here.
      if (res.headersSent) {
        res.end();
        return;
      }
      if (caches.has(key)) serveCache(req, res, 'bridge_error', target);
      else serveNone(req, res, 'bridge_error', target);
    }
  };
}

/**
 * Vite plugin. `env` is read once when the plugin is created (Vite loads .env
 * into process.env before vite.config.js builds the plugin list).
 */
export function collectorBridgePlugin({
  env = globalThis.process?.env ?? {},
  fetchImpl,
  now,
  log,
} = {}) {
  const config = bridgeConfigFromEnv(env);
  const install = (server) => {
    for (const name of config.feeds) {
      server.middlewares.use(
        BRIDGE_FEEDS[name].route,
        createCollectorBridge({
          name,
          urls: config.urls,
          timeoutMs: config.timeoutMs,
          greyMs: config.greyMs,
          fetchImpl,
          now,
          log,
        }),
      );
    }
  };
  return {
    name: 'byrdit-history-bridge',
    configureServer: install,
    configurePreviewServer: install,
  };
}
