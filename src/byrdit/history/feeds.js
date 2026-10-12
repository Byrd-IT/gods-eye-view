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
 * Hook for B20: /api/flights is answered from the OpenSky viewport poller's
 * tile cache; that entry sets forwardQuery: true so `view=w,s,e,n` reaches
 * the collector. It is deliberately NOT registered in B4.
 */
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
});

/** Names of the feeds whose rollback flag is exactly "1" in `env`. */
export function enabledBridgeFeeds(env = {}) {
  return Object.entries(BRIDGE_FEEDS)
    .filter(([, feed]) => String(env[feed.flag] ?? '').trim() === '1')
    .map(([name]) => name);
}
