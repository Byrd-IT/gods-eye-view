import { getTransitFeed } from '../../data/transitFeeds.js';
import { GBFS_CITY_REGISTRY } from '../../layers/bikeshare/registry.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';
import { createTransitHistory } from '../../sources/transitHistoryStore.js';
import { validTransitIdentifier } from '../../sources/transitHistory.js';
import { makeRateLimiter } from '../../sources/rateLimit.js';

/**
 * Feeds C bridge routes (gev-history DESIGN 1.3 #12-#14, 4.2; card B15).
 *
 * These routes carry an id or a URL in the path, so each entry RESOLVES a
 * request to one collector snapshot instead of naming a single feed:
 *
 *   /api/transit/feeds                  -> transit-feeds (registry catalog)
 *   /api/transit/vehicles/<feedId>      -> transit-<feedId> (enabled feeds only)
 *   /api/transit/trail/<feedId>/<veh>   -> answered HERE from the snapshots the
 *                                          bridge relayed (GEV's own trail
 *                                          store, unchanged limits)
 *   /api/gbfs/<encoded registry URL>    -> gbfs-<systemId>-status | -info
 *   /api/weather/manifest?product=<p>   -> weather-<p>
 *   /api/weather/tile|image?...         -> answered HERE (weatherImagery.js):
 *                                          GEV's weatherProxy validating
 *                                          against collector-owned
 *                                          capabilities; only GetMap image
 *                                          bytes are live (review R4)
 *
 * A resolver answers one of: a collector target, a direct reply (D7: a GBFS
 * URL that is not a recorded registry system gets 404 and is NEVER proxied to
 * the operator), a local handler, or null = "not a bridged sub-route" (next
 * middleware). null is only returned where the upstream plugin itself answers
 * without contacting any operator (unknown transit routes -> its 404, invalid
 * weather manifest queries -> its 400, unknown weather paths -> its 404).
 * Weather /tile and /image are NOT passed on any more (B15 review t_c057aa83
 * R4): GEV's own weatherProxy would read NOAA GetCapabilities, the recorded
 * metadata the collector already consumes (DESIGN 2.1/4.2: one consumer).
 */

export const TRANSIT_CADENCE_MS = 60_000; // gev-history src/feeds/transit.js
export const GBFS_STATUS_CADENCE_MS = 300_000; // src/feeds/gbfs.js
export const GBFS_INFO_CADENCE_MS = 86_400_000;
export const WEATHER_CADENCE_MS = 120_000; // src/feeds/imagery.js nowcoast
export const WEATHER_PRODUCTS = Object.freeze([
  'lightning',
  'radar',
  'clouds',
  'clouds-regional',
]);

const json = (status, body, extra = {}) => ({
  reply: {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extra,
    },
    body: JSON.stringify(body),
  },
});

// ----------------------------------------------------------------- transit
export function resolveTransit(url) {
  const p = url.pathname;
  if (p === '/feeds' || p === '/feeds/')
    return { collectorFeed: 'transit-feeds', cadenceMs: TRANSIT_CADENCE_MS };
  const v = /^\/vehicles\/([^/]+)\/?$/.exec(p);
  if (v) {
    let id;
    try {
      id = decodeURIComponent(v[1]);
    } catch {
      return null;
    }
    const feed = getTransitFeed(id);
    return feed
      ? {
          collectorFeed: `transit-${feed.id}`,
          cadenceMs: TRANSIT_CADENCE_MS,
          transitFeed: feed,
        }
      : null;
  }
  const t = /^\/trail\/([^/]+)\/([^/]+)\/?$/.exec(p);
  if (t) {
    let id, vehicleId;
    try {
      id = decodeURIComponent(t[1]);
      vehicleId = decodeURIComponent(t[2]);
    } catch {
      return null;
    }
    const feed = getTransitFeed(id);
    if (
      feed &&
      feed.historyRetention === true &&
      validTransitIdentifier(vehicleId)
    )
      return { local: 'trail', transitFeed: feed, vehicleId };
  }
  return null;
}

/** GEV's client reads X-Transit-Contact and X-GEV-Cache: STALE-ERROR. */
export function transitHeaders(headers) {
  const lastOk = headers['X-Feed-Last-OK'];
  if (lastOk !== undefined) headers['X-Transit-Contact'] = lastOk;
  headers['X-GEV-Cache'] =
    headers['X-Feed-Cache'] === 'STALE' ? 'STALE-ERROR' : 'HIT';
  return headers;
}

/**
 * The /trail/ store: GEV's own bounded process-local history, fed with every
 * NEW vehicles snapshot the bridge relays (GEV fed it on every refresh), and
 * the same read limiter (30/min per feed, 120 global).
 */
export function createTransitTrails({ now = () => Date.now() } = {}) {
  const history = createTransitHistory();
  const admit = makeRateLimiter({
    windowMs: 60000,
    max: 30,
    globalMax: 120,
  });
  const seen = new Map(); // feedId -> fetchedAt of the last ingested body
  return {
    ingest(feed, body) {
      if (feed?.historyRetention !== true) return;
      let snapshot;
      try {
        snapshot = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return;
      }
      if (!Array.isArray(snapshot?.vehicles)) return;
      if (seen.get(feed.id) === snapshot.fetchedAt) return;
      seen.set(feed.id, snapshot.fetchedAt);
      history.ingest(feed, snapshot.vehicles, now());
    },
    answer(feed, vehicleId) {
      if (!admit(feed.id))
        return json(
          429,
          { error: 'Transit history read limit reached' },
          { 'Retry-After': '60' },
        ).reply;
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(history.get(feed.id, vehicleId, now())),
      };
    },
    close() {
      history.clear();
    },
  };
}

// -------------------------------------------------------------------- gbfs
const GBFS_BY_URL = new Map(
  GBFS_CITY_REGISTRY.flatMap((e) => [
    [e.stationStatusUrl, { id: e.id, kind: 'status' }],
    [e.stationInformationUrl, { id: e.id, kind: 'info' }],
  ]),
);

/** Same validation order and messages as GEV server/providers/gbfs.js. */
export function resolveGbfs(url) {
  const encoded = url.pathname.replace(/^\/+/, '');
  if (!encoded) return json(400, { error: 'Missing GBFS upstream target' });
  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return json(400, { error: 'Invalid GBFS target encoding' });
  }
  let upstream;
  try {
    upstream = new URL(decoded);
  } catch {
    return json(400, { error: 'Invalid GBFS upstream URL' });
  }
  if (upstream.protocol !== 'https:')
    return json(400, { error: 'Only https GBFS targets are allowed' });
  if (!isAllowedGbfsHost(upstream.hostname))
    return json(403, { error: 'GBFS host not allowed' });
  if (!isAllowedGbfsPath(upstream.pathname))
    return json(400, {
      error: 'Only station_information/station_status endpoints are allowed',
    });
  const hit = GBFS_BY_URL.get(upstream.toString());
  // D7: a URL that is not a recorded registry system is never proxied live
  if (!hit) return json(404, { error: 'GBFS target is not a recorded system' });
  return {
    collectorFeed: `gbfs-${hit.id}-${hit.kind}`,
    cadenceMs:
      hit.kind === 'status' ? GBFS_STATUS_CADENCE_MS : GBFS_INFO_CADENCE_MS,
    gbfsHost: upstream.hostname,
  };
}

export function gbfsHeaders(headers, target) {
  if (target?.gbfsHost) headers['X-GBFS-Upstream'] = target.gbfsHost;
  headers['X-GBFS-Cache'] = headers['X-Feed-Cache'] ?? 'HIT';
  return headers;
}

// ----------------------------------------------------------------- weather
/**
 * Manifest: the collector snapshot, exactly GEV's accepted query shape.
 * Tile/image: the bridge's local weather imagery handler (R4).
 */
export function resolveWeather(url) {
  if (url.pathname === '/tile' || url.pathname === '/image')
    return { local: 'weatherImagery' };
  if (url.pathname !== '/manifest') return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'product') return null;
  const product = url.searchParams.get('product');
  if (!WEATHER_PRODUCTS.includes(product)) return null;
  return {
    collectorFeed: `weather-${product}`,
    cadenceMs: WEATHER_CADENCE_MS,
  };
}
