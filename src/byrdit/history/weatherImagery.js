/**
 * Bridged /api/weather tile and image routes (gev-history DESIGN 2.1, 4.2;
 * B15 review t_c057aa83 R4).
 *
 * nowCOAST GetCapabilities is RECORDED metadata: the collector is its single
 * consumer (feed `nowcoast`, every 2 min). Before this repair the bridge
 * answered only /api/weather/manifest and let /tile and /image fall through
 * to GEV's weatherProxy, which validates the requested time/bounds against
 * its OWN GetCapabilities read: a second consumer of the recorded endpoint,
 * also while the collector was down.
 *
 * With GEV_BRIDGE_WEATHER=1 the bridge answers /tile and /image here with a
 * PRIVATE instance of GEV's unchanged weatherProxy (same validation, image
 * cache, stale-frame and expiry rules, same response codes) whose metadata
 * reads are routed to the collector:
 *
 *   ...<service>/ows?...request=GetCapabilities
 *       -> collector /v1/latest/nowcoast-caps-<service, _ -> -> (raw capabilities
 *          XML the collector fetched; byte-identical upstream document)
 *   ...<service>/ows?...request=GetMap
 *       -> live nowCOAST (image bytes are not recorded, DESIGN 1.5 #14)
 *   anything else -> refused locally, never sent
 *
 * A collector that is down, has no snapshot, or whose snapshot is STALE
 * answers the proxy like an unavailable upstream: weatherProxy then serves
 * only frames it already cached, marks its metadata stale (no new GetMap for
 * a stale manifest: "never ask nearestValue=1 WMS to silently replace an
 * expired frame"), and 503s without metadata. There is NO fallback to NOAA
 * GetCapabilities in any case. Flag off: this module is never constructed and
 * GEV's own provider is untouched (rollback).
 *
 * weatherProxy is INJECTED (src/ is the browser graph and may not import
 * server/, scripts/check-import-directions.mjs): server/byrdit/history.js
 * passes GEV's server/providers/weather.js weatherProxy into historyPlugins.
 * Without it the bridge fails CLOSED (503, no request of any kind).
 */

export const NOWCOAST_ORIGIN = 'https://nowcoast.noaa.gov';
export const NOWCOAST_SERVICES = Object.freeze([
  'lightning_detection',
  'weather_radar',
  'satellite',
]);
/** Collector snapshot name (names are [a-z0-9-]: weather_radar -> weather-radar). */
export const capsCollectorFeed = (service) =>
  `nowcoast-caps-${service.replace(/_/g, '-')}`;

/** 'capabilities' | 'map' | null for a URL weatherProxy wants to fetch. */
export function classifyNowcoastRequest(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.origin !== NOWCOAST_ORIGIN) return null;
  const service = /^\/geoserver\/observations\/([a-z_]+)\/ows$/.exec(
    u.pathname,
  )?.[1];
  if (!service || !NOWCOAST_SERVICES.includes(service)) return null;
  const request = [...u.searchParams]
    .find(([k]) => k.toLowerCase() === 'request')?.[1]
    ?.toLowerCase();
  if (request === 'getcapabilities') return { kind: 'capabilities', service };
  if (request === 'getmap') return { kind: 'map', service };
  return null;
}

/**
 * @param {object} o
 * @param {(collectorFeed: string) => Promise<{ok: boolean, body?: Uint8Array,
 *   headers?: Record<string,string>}>} o.readCollector shared collector read
 *   (failover over GEV_COLLECTOR_URLS)
 * @param {typeof fetch} o.liveFetch GetMap image bytes only
 * @param {() => number} o.now
 * @param {Function} [o.weatherProxy] GEV's weatherProxy factory (injected)
 */
export function createWeatherImagery({
  readCollector,
  liveFetch,
  now,
  weatherProxy,
}) {
  const stats = { capabilities: 0, capabilitiesUnavailable: 0, getMap: 0 };
  const routedFetch = async (url, init) => {
    const target = classifyNowcoastRequest(url);
    if (target?.kind === 'map') {
      stats.getMap += 1;
      return liveFetch(url, init);
    }
    if (target?.kind !== 'capabilities') {
      // weatherProxy only builds the two URL kinds above; refuse anything
      // else locally rather than sending it
      return new Response('', { status: 403 });
    }
    let r;
    try {
      r = await readCollector(capsCollectorFeed(target.service));
    } catch {
      r = { ok: false };
    }
    const stale =
      r.ok &&
      (r.headers?.['X-Feed-Cache'] === 'STALE' ||
        r.headers?.['X-Feed-Stale-Since'] !== undefined);
    if (!r.ok || stale) {
      stats.capabilitiesUnavailable += 1;
      return new Response('', { status: 503 });
    }
    stats.capabilities += 1;
    return new Response(r.body, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  };
  let handler = null;
  if (typeof weatherProxy === 'function') {
    weatherProxy({ fetchImpl: routedFetch, now }).configureServer({
      middlewares: {
        use: (_route, h) => {
          handler = h;
        },
      },
    });
  } else {
    // not composed with GEV's provider: fail closed, never pass the request
    // on (the live plugin would read NOAA GetCapabilities)
    handler = (req, res) => {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Feed-Bridge': 'unavailable',
      });
      res.end(JSON.stringify({ error: 'weather_upstream_unavailable' }));
    };
  }
  return {
    /** Handle a /tile or /image request (req.url relative to /api/weather). */
    handle: (req, res) => handler(req, res),
    /**
     * B12c R1b: this private instance's OWN /manifest (its getMetadata, the
     * cache /tile and /image judge with), called in-process, so history
     * imagery reports what this route serves now. Resolves the JSON body.
     * @param {string} product
     */
    manifest: (product) =>
      new Promise((resolve, reject) => {
        const res = {
          statusCode: 0,
          writeHead(status) {
            this.statusCode = status;
          },
          once() {},
          removeListener() {},
          end(body) {
            if (this.statusCode !== 200) return reject(new Error('manifest'));
            try {
              resolve(JSON.parse(String(body)));
            } catch (error) {
              reject(error);
            }
          },
        };
        Promise.resolve(
          handler(
            {
              method: 'GET',
              url: `/manifest?product=${encodeURIComponent(product)}`,
            },
            res,
          ),
        ).catch(reject);
      }),
    stats,
  };
}
