/**
 * Feeds the collector bridge can answer (gev-history DESIGN 4.2).
 *
 * Each entry: the GEV route it owns, the collector feed name
 * (GEV_COLLECTOR_URLS/v1/latest/<collectorFeed>), the collector cadence (for
 * the stale rule, must match the collector's feed definition), the
 * X-Feed-Source label and the rollback flag. A bridged feed has NO fall-through
 * to the upstream plugin (D7): when the collector cannot answer, the bridge
 * serves its own last-good copy marked STALE, or 503 when it has none.
 *
 * Later cards add entries here (B7, B8 vessels). B6 added firms (+ its
 * /status sub-route), fire-perimeters and cyclones: `path` is the sub-path
 * under `route` the entry answers (default "/"); every other sub-path goes
 * to the next middleware (e.g. /api/fire-perimeters/inciweb/* stays live:
 * InciWeb catalog links, not a recorded feed). Both firms entries share
 * GEV_BRIDGE_FIRMS, so the FIRMS route can never be half bridged.
 * `terminal: true` makes the whole route namespace terminal while the flag
 * is on: a sub-path or method no entry answers gets 404/405 from the bridge
 * instead of next(). FIRMS needs it because GEV's firmsProxy answers EVERY
 * non-/status sub-path (/api/firms/x, /status/, //) with a full four-source
 * area poll (D7). Routes whose sub-paths are live GEV routes
 * (/api/military/track, /api/fire-perimeters/inciweb/*) stay non-terminal.
 * B8 vessels: /api/vessels and /api/vessels/track share GEV_BRIDGE_VESSELS
 * and the route is terminal: GEV's aisLiveProxy (re)opens the AISStream
 * socket on ANY /api/vessels request (upstream demand), and AISStream allows
 * one connection per key, so no request may ever reach it while the
 * collector holds the socket. `forwardParams` lists the query parameters
 * forwarded to the collector (canonical order; everything else, e.g. the
 * client's lat/lon/radius_km, which GEV ignores too, is dropped). `cache:
 * false` (track): no last-good copy, because a per-vessel answer must never
 * be served for another vessel; `relayStatus` lists collector statuses
 * relayed as-is (track 400 = GEV's "mmsi query param required").
 * `cacheKey(url)` / `cacheEntries` (collectorBridge.js): last-good copies
 * per normalised query. vessels: GEV ais-live.js answers maxRows rows
 * (clampInt(maxRows, 1, 50000, 50000)), so ?maxRows=7 and the full list are
 * different bodies and each keeps its own copy (review t_c4eefd79 R3). The
 * GEV client asks 500 (layer), 12000 (live source default) and the full list
 * (tools), so 4 copies cover real use; the bridge also caps the bytes.
 * Hook for B20: /api/flights is answered from the OpenSky viewport poller's
 * tile cache; that entry sets forwardQuery: true so `view=w,s,e,n` reaches
 * the collector. It is deliberately NOT registered in B4.
 */
/** GEV server/providers/vessels/ais-store.js AISSTREAM_CACHE_MAX. */
export const AIS_MAX_ROWS = 50_000;

/** GEV server/providers/common/query.js clampInt (parity pinned in tests). */
export function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

/** The maxRows GEV's ais-live.js would serve for this request. */
export function vesselsCacheKey(url) {
  return String(
    clampInt(url.searchParams.get('maxRows'), 1, AIS_MAX_ROWS, AIS_MAX_ROWS),
  );
}

export const BRIDGE_FEEDS = Object.freeze({
  military: Object.freeze({
    route: '/api/military',
    collectorFeed: 'military',
    // gev-history src/feeds/military.js cadenceMs (adsb.lol /v2/mil, 60 s).
    cadenceMs: 60_000,
    source: 'adsb.lol',
    flag: 'GEV_BRIDGE_MILITARY',
    forwardQuery: false,
  }),
  // gev-history src/feeds/firms.js (FIRMS area API world/2, 30 min).
  firms: Object.freeze({
    route: '/api/firms',
    path: '/',
    collectorFeed: 'firms',
    cadenceMs: 1_800_000,
    source: 'NASA FIRMS',
    flag: 'GEV_BRIDGE_FIRMS',
    forwardQuery: false,
    terminal: true,
  }),
  // GET /api/firms/status: derived by the collector from the firms snapshot.
  firmsStatus: Object.freeze({
    route: '/api/firms',
    path: '/status',
    collectorFeed: 'firms-status',
    cadenceMs: 1_800_000,
    source: 'NASA FIRMS',
    flag: 'GEV_BRIDGE_FIRMS',
    forwardQuery: false,
    terminal: true,
  }),
  // gev-history src/feeds/perimeters.js (NIFC WFIGS, 15 min).
  firePerimeters: Object.freeze({
    route: '/api/fire-perimeters',
    path: '/',
    collectorFeed: 'fire-perimeters',
    cadenceMs: 900_000,
    source: 'NIFC WFIGS',
    flag: 'GEV_BRIDGE_FIRE_PERIMETERS',
    forwardQuery: false,
  }),
  // gev-history src/feeds/cyclones.js (NOAA NHC CurrentStorms + GIS, 15 min).
  cyclones: Object.freeze({
    route: '/api/cyclones',
    path: '/',
    collectorFeed: 'cyclones',
    cadenceMs: 900_000,
    source: 'NOAA NHC / CPHC',
    flag: 'GEV_BRIDGE_CYCLONES',
    forwardQuery: false,
  }),
  // gev-history src/ais/aisRunner.js (AISStream socket held 24/7; latest
  // snapshot every 10 s, stale rule on a 60 s cadence).
  vessels: Object.freeze({
    route: '/api/vessels',
    path: '/',
    collectorFeed: 'vessels',
    cadenceMs: 60_000,
    source: 'AISStream',
    flag: 'GEV_BRIDGE_VESSELS',
    forwardQuery: false,
    forwardParams: Object.freeze(['maxRows']),
    cacheKey: vesselsCacheKey,
    cacheEntries: 4,
    terminal: true,
  }),
  // GET /api/vessels/track?mmsi=: the collector's accumulated track ring.
  vesselsTrack: Object.freeze({
    route: '/api/vessels',
    path: '/track',
    collectorFeed: 'vessels-track',
    cadenceMs: 60_000,
    source: 'AISStream',
    flag: 'GEV_BRIDGE_VESSELS',
    forwardQuery: false,
    forwardParams: Object.freeze(['mmsi']),
    cache: false,
    relayStatus: Object.freeze([400]),
    terminal: true,
  }),
});

/** Names of the feeds whose rollback flag is exactly "1" in `env`. */
export function enabledBridgeFeeds(env = {}) {
  return Object.entries(BRIDGE_FEEDS)
    .filter(([, feed]) => String(env[feed.flag] ?? '').trim() === '1')
    .map(([name]) => name);
}
