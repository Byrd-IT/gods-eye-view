import { makeRateLimiter } from '../../sources/rateLimit.js';
import {
  HistoryParamError,
  parseCoverageParams,
  parseSliceParams,
  parseSnapshotParams,
} from './historyParams.js';
import {
  HistoryUnavailableError,
  createHistoryEsClient,
  esConfigFromEnv,
} from './historyEs.js';
import { createHistoryService } from './historyService.js';

/**
 * /api/history/* routes (gev-history DESIGN 4.3; card B9 item 1).
 *
 * Read-only, same origin, behind the S3 Basic Auth. Safeguards, in order:
 *   1. Host allowlist: the same rule as Vite's allowedHosts (injected by
 *      server/byrdit/history.js; build/allowedHosts.js hostCheckPlugin also
 *      runs first for every route) -> 403.
 *   2. GET/HEAD only -> 405.
 *   3. Known route only (/slice, /coverage, /snapshots) -> 404.
 *   4. Per-client rate limit (server/providers/common/rate-limit.js,
 *      GEV_RATELIMIT_HISTORY_PER_MIN, default 60/min) -> 429.
 *   5. Parameter allowlist + hard caps (historyParams.js) -> 400/404/413.
 *   6. At most MAX_IN_FLIGHT ES-backed answers at once -> 429 busy.
 *   7. Store errors never leak: 503 {error:'history_unavailable'}.
 * Disabled (no middleware at all) unless GEV_HISTORY_API=1; enabled without
 * a reader key configured -> every route answers 503.
 */

export const HISTORY_PREFIX = '/api/history';
export const DEFAULT_HISTORY_PER_MIN = 60;
export const MAX_IN_FLIGHT = 4;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, body, headers = {}, head = false) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...JSON_HEADERS, ...headers }))
    res.setHeader(k, v);
  res.setHeader('Content-Length', new TextEncoder().encode(text).length);
  res.end(head ? undefined : text);
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
    const head = req.method === 'HEAD';
    if (!isAllowedHost(req.headers?.host))
      return send(res, 403, { error: 'host_not_allowed' });
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, { error: 'method_not_allowed' });
    }
    const route = path.slice(HISTORY_PREFIX.length + 1);
    const parsers = {
      slice: parseSliceParams,
      coverage: parseCoverageParams,
      snapshots: parseSnapshotParams,
    };
    const parse = Object.hasOwn(parsers, route) ? parsers[route] : null;
    if (!parse) return send(res, 404, { error: 'not_found' }, {}, head);
    if (!allow(clientKey(req)))
      return send(
        res,
        429,
        { error: 'rate_limited' },
        { 'Retry-After': '60' },
        head,
      );
    const rawQuery = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);
    let params;
    try {
      params = parse(new URLSearchParams(rawQuery), rawQuery, now());
    } catch (error) {
      if (error instanceof HistoryParamError)
        return send(
          res,
          error.status,
          { error: error.error, param: error.param },
          {},
          head,
        );
      return send(res, 400, { error: 'invalid_param', param: null }, {}, head);
    }
    if (!service)
      return send(res, 503, { error: 'history_unavailable' }, {}, head);
    if (inFlight >= MAX_IN_FLIGHT)
      return send(res, 429, { error: 'busy' }, { 'Retry-After': '1' }, head);
    inFlight += 1;
    try {
      if (route === 'slice') {
        const { body, headers } = await service.slice(params);
        return send(res, 200, body, headers, head);
      }
      const body = await service[route](params);
      return send(res, 200, body, {}, head);
    } catch (error) {
      logFailure(
        error instanceof HistoryUnavailableError
          ? error.reason
          : `internal ${error?.name ?? 'error'}`,
      );
      return send(res, 503, { error: 'history_unavailable' }, {}, head);
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
