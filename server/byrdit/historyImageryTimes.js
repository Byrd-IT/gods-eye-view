import { Server as TlsServer } from 'node:tls';

/**
 * The EFFECTIVE serving state of GEV's weather pixel route, for
 * /api/history/slice?feed=imagery (card B12c t_de253a39, review R1 / R1b).
 *
 * /api/weather/tile|image (server/providers/weather.js, unchanged) renders a
 * time only if it is in `allowedTimes` of ITS OWN cached GetCapabilities
 * read (newest 26 times <= 24 h old), else 400 unknown_weather_time; while
 * that read is stale (NOAA/collector failed, kept up to 1 h) it refuses any
 * uncached frame (503 weather_metadata_stale). A second, independent
 * capabilities read can disagree with the route for up to that hour (review
 * R1b), so this module does NOT read capabilities itself. It asks the
 * serving route instance for its own manifest (getMetadata on the same
 * cache the tile route uses) and reports exactly that:
 *  - unbridged: a loopback GET /api/weather/manifest?product=<p> to this
 *    server's own listening socket (GEV's weatherProxy instance from
 *    server/providers/local.js answers it);
 *  - GEV_BRIDGE_WEATHER=1: /api/weather/manifest is answered from the
 *    collector, but /tile and /image by the bridge's PRIVATE weatherProxy
 *    instance (src/byrdit/history/weatherImagery.js), so the bridge attaches
 *    that instance's in-process manifest call (attachRoute) and only that is
 *    used; the loopback is never used in bridged mode.
 * The manifest lists `times` = the newest 13 of the route's allowedTimes, so
 * a listed frame is accepted by the tile route at the moment of the check.
 * Anything that cannot be established (no route attached, socket not
 * listening, TLS, timeout, bad answer) throws; the slice then says
 * X-History-Pixels: unknown and claims nothing.
 */

/** weather.js PRODUCTS[product].metadataTtlMs ?? 120_000 */
export const PRODUCT_TTL_MS = Object.freeze({
  radar: 120_000,
  clouds: 120_000,
  'clouds-regional': 120_000,
  lightning: 600_000,
});
const MAX_MANIFEST_BYTES = 64 * 1024;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** A pixel-state failure with a reason the slice puts in a header. */
function unknown(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

/**
 * Validate a weather.js describe() manifest for `product`.
 * @returns {{times: string[], fetchedAt: number|null, stale: boolean,
 *   unavailable: boolean}}
 */
export function servingStateOf(body, product) {
  if (
    !body ||
    typeof body !== 'object' ||
    body.product !== product ||
    !Array.isArray(body.times) ||
    body.times.length > 26 ||
    body.times.some((x) => typeof x !== 'string' || !ISO_RE.test(x)) ||
    typeof body.stale !== 'boolean' ||
    typeof body.unavailable !== 'boolean' ||
    !(body.fetchedAt === null || Number.isFinite(body.fetchedAt))
  )
    throw unknown('serving_route_bad_answer');
  return {
    times: body.times,
    fetchedAt: body.fetchedAt,
    stale: body.stale,
    unavailable: body.unavailable,
  };
}

/** http://host:port of a listening node server for a loopback call, or null. */
export function loopbackBase(httpServer) {
  if (!httpServer?.listening || httpServer instanceof TlsServer) return null;
  const a = httpServer.address();
  if (!a || typeof a !== 'object' || !Number.isInteger(a.port)) return null;
  const host =
    a.address === '0.0.0.0' || a.address === '::' || !a.address
      ? '127.0.0.1'
      : a.address;
  return `http://${host.includes(':') ? `[${host}]` : host}:${a.port}`;
}

/**
 * @param {object} [o]
 * @param {boolean} [o.bridged] GEV_BRIDGE_WEATHER=1
 * @param {typeof fetch} [o.fetchImpl] the loopback call
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs]
 */
export function createWeatherServingState({
  bridged = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 5_000,
} = {}) {
  let httpServer = null;
  let routeManifest = null;

  async function viaLoopback(product) {
    const base = loopbackBase(httpServer);
    if (!base) throw unknown('serving_route_unreachable');
    let response;
    try {
      response = await fetchImpl(
        `${base}/api/weather/manifest?product=${encodeURIComponent(product)}`,
        {
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      throw unknown('serving_route_unreachable');
    }
    if (
      response.status !== 200 ||
      !/json/.test(response.headers.get('content-type') ?? '')
    ) {
      await response.body?.cancel();
      throw unknown('serving_route_unreachable');
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw unknown('serving_route_unreachable');
    }
    if (text.length > MAX_MANIFEST_BYTES)
      throw unknown('serving_route_bad_answer');
    try {
      return JSON.parse(text);
    } catch {
      throw unknown('serving_route_bad_answer');
    }
  }

  return {
    /** historyApiPlugin: this server's own socket (unbridged loopback). */
    attachServer(server) {
      httpServer = server ?? null;
    },
    /** collector bridge: the private weatherProxy instance's manifest. */
    attachRoute(manifest) {
      routeManifest = typeof manifest === 'function' ? manifest : null;
    },
    /**
     * @param {'radar'|'clouds'|'clouds-regional'|'lightning'} product
     * @returns {Promise<{times: string[], fetchedAt: number|null,
     *   stale: boolean, unavailable: boolean, checkedAt: number,
     *   marginMs: number}>}
     */
    async read(product) {
      const ttl = PRODUCT_TTL_MS[product];
      if (!ttl) throw unknown('unknown_weather_product');
      let body;
      if (bridged) {
        if (!routeManifest) throw unknown('serving_route_unreachable');
        try {
          body = await routeManifest(product);
        } catch {
          throw unknown('serving_route_unreachable');
        }
      } else body = await viaLoopback(product);
      return {
        ...servingStateOf(body, product),
        checkedAt: now(),
        marginMs: ttl,
      };
    },
  };
}
