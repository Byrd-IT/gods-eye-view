import { weatherProxy } from '../providers/weather.js';
import { makeCostRateLimiter } from '../providers/common/rate-limit.js';
import { isAllowedHost } from '../../build/allowedHosts.js';
import {
  TRUSTED_PROXIES_ENV,
  normalizeProxyAddress,
  parseTrustedProxies,
} from './trustedProxy.js';
import {
  enabledBridgeFeeds,
  historyPlugins as browserSafeHistoryPlugins,
  parseCollectorUrls,
} from '../../src/byrdit/history/index.js';
import { DEFAULT_HISTORY_PER_MIN } from '../../src/byrdit/history/historyApi.js';
import { createWindHistoryReader } from './historyWind.js';
import { createWeatherServingTimes } from './historyImageryTimes.js';

/**
 * Server-side composition of the Byrd-IT history plugins (gev-history
 * DESIGN 4.1, B15 review t_c057aa83 R4). src/ is the browser graph and may
 * not import server/ (scripts/check-import-directions.mjs), so the server
 * injects GEV's own weatherProxy here: with GEV_BRIDGE_WEATHER=1 the bridge
 * answers /api/weather/tile|image with a private weatherProxy instance whose
 * GetCapabilities reads come from the collector (single consumer of the
 * recorded metadata); only GetMap image bytes are live.
 *
 * B12c: /api/history/slice?feed=wind reads past GFS/IFS cycles with the
 * injected byte-range reader (./historyWind.js, nothing stored).
 * feed=imagery judges pixel availability against the time set GEV's weather
 * pixel route accepts now (./historyImageryTimes.js: the same capabilities
 * source as that route, collector with GEV_BRIDGE_WEATHER=1, else NOAA).
 *
 * B9 (/api/history/*, GEV_HISTORY_API=1): the per-client rate limit is the
 * common cost limiter (server/providers/common/rate-limit.js,
 * GEV_RATELIMIT_HISTORY_PER_MIN, default 60/min; 0 = off), the Host rule is
 * Vite's own (build/allowedHosts.js isAllowedHost with the server's
 * allowedHosts), and the client key is the socket peer, or X-Real-IP when
 * the peer is a GEV_TRUSTED_PROXIES reverse proxy (NPM), so users behind
 * the proxy do not share one bucket.
 *
 * server/standalone/vite.config.js imports historyPlugins from HERE (its one
 * touch-point import line); everything else is in src/byrdit/history.
 *
 * @param {Parameters<typeof browserSafeHistoryPlugins>[0]} [options]
 */
export function historyPlugins(options = {}) {
  const env = options.env ?? process.env;
  const limiter = makeCostRateLimiter(
    env.GEV_RATELIMIT_HISTORY_PER_MIN,
    DEFAULT_HISTORY_PER_MIN,
  );
  return browserSafeHistoryPlugins({
    weatherProxy,
    ...options,
    historyApi: {
      allow: limiter ?? (() => true),
      clientKey: historyClientKey(env),
      hostCheck: (allowed, additional) => (host) =>
        isAllowedHost(host, allowed, additional),
      // B12c: wind at a past cycle through GEV's byte-range reader pieces
      windReader: createWindHistoryReader(),
      weatherTimes: createWeatherServingTimes({
        bridged: enabledBridgeFeeds(env).includes('weather'),
        collectorUrls: collectorUrlsOf(env),
      }),
      ...options.historyApi,
    },
  });
}

/** GEV_COLLECTOR_URLS (an invalid value -> none: imagery pixels 'unknown'). */
function collectorUrlsOf(env) {
  try {
    return parseCollectorUrls(env.GEV_COLLECTOR_URLS);
  } catch {
    return [];
  }
}

/**
 * Rate-limit key: the TCP peer, or its X-Real-IP when the peer is a trusted
 * reverse proxy. A malformed or absent X-Real-IP from the proxy falls back
 * to the peer (one shared bucket, never an unbounded key).
 * @param {Record<string, string|undefined>} env
 */
export function historyClientKey(env) {
  const trusted = parseTrustedProxies(env[TRUSTED_PROXIES_ENV]);
  return (req) => {
    const peer = normalizeProxyAddress(req.socket?.remoteAddress) || 'local';
    if (!trusted.has(peer)) return peer;
    const real = normalizeProxyAddress(req.headers?.['x-real-ip']);
    return /^[0-9a-f:.]{2,45}$/.test(real) ? `proxied:${real}` : peer;
  };
}
