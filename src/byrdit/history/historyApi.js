import { makeRateLimiter } from '../../sources/rateLimit.js';
import {
  HistoryParamError,
  parseCoverageParams,
  parseHealthParams,
  parseSliceParams,
  parseSnapshotParams,
  parseTrackParams,
} from './historyParams.js';
import {
  HistoryUnavailableError,
  createHistoryEsClient,
  esConfigFromEnv,
} from './historyEs.js';
import { createHistoryService } from './historyService.js';
import {
  CACHE_MAX_AGE_S,
  LIVE_EDGE_MS,
  aboutInstant,
  bodyEtag,
  cacheKey,
  createHistoryCache,
  etagMatches,
} from './historyCache.js';
import { createHealthService } from './historyHealth.js';
import { parseCollectorUrls } from './collectorBridge.js';

/**
 * /api/history/* routes (gev-history DESIGN 4.3; card B9 item 1).
 *
 * Read-only, same origin, behind the S3 Basic Auth. Safeguards, in order:
 *   1. Host allowlist: the same rule as Vite's allowedHosts (injected by
 *      server/byrdit/history.js; build/allowedHosts.js hostCheckPlugin also
 *      runs first for every route) -> 403.
 *   2. GET only (DESIGN 4.3; HEAD too) -> 405 Allow: GET.
 *   3. Known route only (/slice, /coverage, /snapshots, /track, /health)
 *      -> 404.
 *   4. Per-client rate limit (server/providers/common/rate-limit.js,
 *      GEV_RATELIMIT_HISTORY_PER_MIN, default 60/min) -> 429.
 *   5. Parameter allowlist + hard caps (historyParams.js) -> 400/404/413.
 *   6. At most MAX_IN_FLIGHT ES-backed answers at once -> 429 busy.
 *   7. Store errors never leak: 503 {error:'history_unavailable'}.
 * Disabled (no middleware at all) unless GEV_HISTORY_API=1; enabled without
 * a reader key configured -> every store route answers 503 (/health still
 * answers from the collector, historyStore: 'not_configured').
 *
 * B10 caching (DESIGN 4.4, historyCache.js): an answer about a moment older
 * than 5 min is kept in a 64 MB in-process LRU and sent with an ETag and
 * `Cache-Control: private, max-age=300`; If-None-Match -> 304. The live edge
 * and /health are `no-store`, never cached, no ETag. Errors are never
 * cached.
 */

export const HISTORY_PREFIX = '/api/history';
export const DEFAULT_HISTORY_PER_MIN = 60;
export const MAX_IN_FLIGHT = 4;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...JSON_HEADERS, ...headers }))
    res.setHeader(k, v);
  res.setHeader('Content-Length', new TextEncoder().encode(text).length);
  res.end(text);
}

/**
 * A cacheable answer (DESIGN 4.4): ETag + private max-age=300, 304 when
 * If-None-Match matches. X-History-Cache says HIT/MISS (in-process LRU).
 */
function sendCached(req, res, entry, state) {
  const headers = {
    ...JSON_HEADERS,
    ...entry.headers,
    'Cache-Control': `private, max-age=${CACHE_MAX_AGE_S}`,
    ETag: entry.etag,
    'X-History-Cache': state,
  };
  if (etagMatches(req.headers?.['if-none-match'], entry.etag)) {
    res.statusCode = 304;
    for (const [k, v] of Object.entries(headers)) {
      if (k === 'Content-Type' || k === 'Content-Length') continue;
      res.setHeader(k, v);
    }
    return res.end();
  }
  res.statusCode = 200;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Length', new TextEncoder().encode(entry.text).length);
  return res.end(entry.text);
}

/** Socket peer only (a localhost/LAN fallback; the server injects its own). */
export function socketClientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/** Minimal Host rule for tests/standalone use: loopback names only. */
export function loopbackHostOnly(hostHeader) {
  const host = String(hostHeader ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

export function historyApiEnabled(env = {}) {
  return String(env.GEV_HISTORY_API ?? '').trim() === '1';
}

/**
 * Request handler for /api/history/*.
 * @param {object} options
 * @param {object} [options.env]
 * @param {ReturnType<typeof createHistoryService>|null} [options.service]
 *   injected service (tests); default = from the env reader key
 * @param {(key: string) => boolean} [options.allow] rate limiter
 * @param {(req: any) => string} [options.clientKey]
 * @param {(host: string|undefined) => boolean} [options.isAllowedHost]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 */
export function createHistoryApi({
  env = {},
  service,
  allow,
  clientKey = socketClientKey,
  isAllowedHost = loopbackHostOnly,
  now = () => Date.now(),
  log = (line) => console.warn(line),
  fetchImpl,
  cache = createHistoryCache({ now }),
  healthService,
} = {}) {
  if (service === undefined) {
    const config = esConfigFromEnv(env);
    service = config
      ? createHistoryService({
          es: createHistoryEsClient({
            ...config,
            ...(fetchImpl ? { fetchImpl } : {}),
          }),
          now,
        })
      : null;
  }
  if (healthService === undefined) {
    const config = esConfigFromEnv(env);
    let urls;
    try {
      urls = parseCollectorUrls(env.GEV_COLLECTOR_URLS);
    } catch {
      urls = [];
    }
    healthService = createHealthService({
      es:
        service && config
          ? createHistoryEsClient({
              ...config,
              ...(fetchImpl ? { fetchImpl } : {}),
            })
          : null,
      collectorUrls: urls,
      ...(fetchImpl ? { fetchImpl } : {}),
      now,
    });
  }
  allow ??= makeRateLimiter({
    windowMs: 60_000,
    max: DEFAULT_HISTORY_PER_MIN,
    globalMax: DEFAULT_HISTORY_PER_MIN * 20,
  });
  let inFlight = 0;
  let lastLog = 0;

  function logFailure(reason) {
    const t = now();
    if (t - lastLog < 60_000) return; // one line per minute at most
    lastLog = t;
    log(`[history] store unavailable: ${reason}`);
  }

  return async function historyApi(req, res, next) {
    const rawUrl = String(req.url ?? '');
    const qIndex = rawUrl.indexOf('?');
    const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    if (path !== HISTORY_PREFIX && !path.startsWith(HISTORY_PREFIX + '/'))
      return next?.();
    if (!isAllowedHost(req.headers?.host))
      return send(res, 403, { error: 'host_not_allowed' });
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, { error: 'method_not_allowed' });
    }
    const route = path.slice(HISTORY_PREFIX.length + 1);
    const parsers = {
      slice: parseSliceParams,
      coverage: parseCoverageParams,
      snapshots: parseSnapshotParams,
      track: parseTrackParams,
      health: parseHealthParams,
    };
    const parse = Object.hasOwn(parsers, route) ? parsers[route] : null;
    if (!parse) return send(res, 404, { error: 'not_found' });
    if (!allow(clientKey(req)))
      return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    const rawQuery = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);
    let params;
    try {
      params = parse(new URLSearchParams(rawQuery), rawQuery, now());
    } catch (error) {
      if (error instanceof HistoryParamError)
        return send(res, error.status, {
          error: error.error,
          param: error.param,
        });
      return send(res, 400, { error: 'invalid_param', param: null });
    }
    if (route === 'health') {
      // collector + coverage summary; never cached, never a 503 for the
      // store (its own field says so)
      try {
        return send(res, 200, await healthService.health());
      } catch {
        return send(res, 503, { error: 'history_unavailable' });
      }
    }
    if (!service) return send(res, 503, { error: 'history_unavailable' });
    const about = aboutInstant(route, params);
    const cacheable =
      cache !== null && about !== null && about < now() - LIVE_EDGE_MS;
    const key = cacheable ? cacheKey(route, params) : null;
    const hit = key ? cache.get(key) : null;
    if (hit) return sendCached(req, res, hit, 'HIT');
    if (inFlight >= MAX_IN_FLIGHT)
      return send(res, 429, { error: 'busy' }, { 'Retry-After': '1' });
    inFlight += 1;
    try {
      const out =
        route === 'slice' || route === 'track'
          ? await service[route](params)
          : { body: await service[route](params), headers: {} };
      if (!cacheable) return send(res, 200, out.body, out.headers);
      const text = JSON.stringify(out.body);
      const entry = { text, etag: bodyEtag(text), headers: out.headers };
      cache.set(key, entry);
      return sendCached(req, res, entry, 'MISS');
    } catch (error) {
      logFailure(
        error instanceof HistoryUnavailableError
          ? error.reason
          : `internal ${error?.name ?? 'error'}`,
      );
      return send(res, 503, { error: 'history_unavailable' });
    } finally {
      inFlight -= 1;
    }
  };
}

/**
 * Vite plugin: /api/history/* middleware, dev and preview servers.
 * @param {Parameters<typeof createHistoryApi>[0] & {
 *   hostCheck?: (allowed: string[]|true, additional: string[]) =>
 *     (host: string|undefined) => boolean }} [options]
 */
export function historyApiPlugin(options = {}) {
  const install = (server, preview) => {
    const config = server.config;
    let isAllowedHost = options.isAllowedHost;
    if (!isAllowedHost && options.hostCheck) {
      const allowed = preview
        ? config.preview.allowedHosts
        : config.server.allowedHosts;
      const additional = [config.server.host, config.preview.host].filter(
        (v) => typeof v === 'string' && v,
      );
      isAllowedHost = options.hostCheck(allowed, additional);
    }
    server.middlewares.use(createHistoryApi({ ...options, isAllowedHost }));
  };
  return {
    name: 'byrdit-history-api',
    configureServer(server) {
      install(server, false);
    },
    configurePreviewServer(server) {
      install(server, true);
    },
  };
}
