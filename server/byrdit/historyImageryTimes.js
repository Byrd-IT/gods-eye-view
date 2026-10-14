import { parseWeatherCapabilities } from '../providers/weather.js';
import { readResponseTextCapped } from '../providers/common/http.js';
import {
  capsCollectorFeed,
  classifyNowcoastRequest,
} from '../../src/byrdit/history/weatherImagery.js';

/**
 * The frame times GEV's weather PIXEL ROUTE accepts now, for
 * /api/history/slice?feed=imagery (card B12c t_de253a39, review R1).
 *
 * /api/weather/tile|image (server/providers/weather.js, unchanged) renders
 * a time only if it is in `allowedTimes` of its current GetCapabilities read
 * (newest 26 times <= 24 h old), else 400 unknown_weather_time. This reader
 * computes that same set from the SAME capabilities source the serving path
 * uses, with GEV's own parseWeatherCapabilities:
 *  - GEV_BRIDGE_WEATHER=1: the bridge's private weatherProxy reads the
 *    collector snapshot /v1/latest/nowcoast-caps-<service> (weatherImagery.js;
 *    STALE or missing = unavailable, no NOAA fallback), so this does too;
 *  - otherwise GEV's own weatherProxy reads NOAA GetCapabilities at the same
 *    fixed URL, so this does too.
 * The read is cached for the route's own metadata TTL (weather.js PRODUCTS
 * metadataTtlMs: lightning 10 min, else 2 min). marginMs (2 x that TTL)
 * tells pixelAvailability how far the route's read can drift from ours.
 * A failed read throws; the slice then says X-History-Pixels: unknown.
 */

const NOWCOAST_BASE = 'https://nowcoast.noaa.gov/geoserver/observations/';
/** weather.js PRODUCTS[product].service */
export const PRODUCT_SERVICE = Object.freeze({
  radar: 'weather_radar',
  clouds: 'satellite',
  'clouds-regional': 'satellite',
  lightning: 'lightning_detection',
});
/** weather.js PRODUCTS[product].metadataTtlMs ?? 120_000 */
export const PRODUCT_TTL_MS = Object.freeze({
  radar: 120_000,
  clouds: 120_000,
  'clouds-regional': 120_000,
  lightning: 600_000,
});
const MAX_CAPS_BYTES = 512 * 1024; // weather.js metadata cap
const FAILURE_HOLD_MS = 30_000; // weather.js: one metadata attempt per 30 s

/** The NOAA GetCapabilities URL weatherProxy fetches for a service. */
export const nowcoastCapsUrl = (service) =>
  `${NOWCOAST_BASE}${service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;

/**
 * @param {object} [o]
 * @param {boolean} [o.bridged] GEV_BRIDGE_WEATHER=1 (collector-owned caps)
 * @param {string[]} [o.collectorUrls] GEV_COLLECTOR_URLS, tried in order
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs]
 */
export function createWeatherServingTimes({
  bridged = false,
  collectorUrls = [],
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 12_000,
} = {}) {
  const cache = new Map(); // product -> { value, at }
  const failures = new Map(); // product -> at
  const inflight = new Map(); // service -> Promise<string>

  async function fetchText(url) {
    const response = await fetchImpl(url, {
      redirect: 'error',
      headers: { Accept: 'application/xml,text/xml' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false };
    }
    return { ok: true, response };
  }

  async function readCaps(service) {
    if (!bridged) {
      const url = nowcoastCapsUrl(service);
      if (classifyNowcoastRequest(url)?.kind !== 'capabilities')
        throw new Error('weather_caps_url');
      const r = await fetchText(url);
      if (!r.ok) throw new Error('weather_caps_unavailable');
      return readResponseTextCapped(r.response, MAX_CAPS_BYTES);
    }
    for (const base of collectorUrls) {
      try {
        const r = await fetchText(
          `${base}/v1/latest/${capsCollectorFeed(service)}`,
        );
        if (!r.ok) continue;
        const h = r.response.headers;
        if (
          h.get('x-feed-cache') === 'STALE' ||
          h.get('x-feed-stale-since') !== null
        ) {
          // the bridge treats a STALE snapshot as unavailable
          await r.response.body?.cancel();
          throw new Error('weather_caps_stale');
        }
        return await readResponseTextCapped(r.response, MAX_CAPS_BYTES);
      } catch (error) {
        if (error?.message === 'weather_caps_stale') throw error;
        /* unreachable / timeout: next collector */
      }
    }
    throw new Error('weather_caps_unavailable');
  }

  /**
   * @param {'radar'|'clouds'|'clouds-regional'|'lightning'} product
   * @returns {Promise<{allowedTimes: string[], fetchedAt: number,
   *   marginMs: number}>}
   */
  async function read(product) {
    const service = PRODUCT_SERVICE[product];
    if (!service) throw new Error('unknown_weather_product');
    const ttl = PRODUCT_TTL_MS[product];
    const hit = cache.get(product);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (now() - (failures.get(product) ?? -Infinity) < FAILURE_HOLD_MS)
      throw new Error('weather_caps_unavailable');
    try {
      let pending = inflight.get(service);
      if (!pending) {
        pending = readCaps(service).finally(() => inflight.delete(service));
        inflight.set(service, pending);
      }
      const xml = await pending;
      const at = now();
      const { allowedTimes } = parseWeatherCapabilities(xml, product, at);
      const value = { allowedTimes, fetchedAt: at, marginMs: 2 * ttl };
      cache.set(product, { value, at });
      failures.delete(product);
      return value;
    } catch (error) {
      cache.delete(product);
      failures.set(product, now());
      throw error;
    }
  }

  return { read };
}
