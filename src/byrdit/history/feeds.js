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
 * Later cards add entries here (B6 FIRMS/perimeters/cyclones, B7, B8 vessels).
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
});

/** Names of the feeds whose rollback flag is exactly "1" in `env`. */
export function enabledBridgeFeeds(env = {}) {
  return Object.entries(BRIDGE_FEEDS)
    .filter(([, feed]) => String(env[feed.flag] ?? '').trim() === '1')
    .map(([name]) => name);
}
