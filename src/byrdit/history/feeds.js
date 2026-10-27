import {
  GBFS_STATUS_CADENCE_MS,
  TRANSIT_CADENCE_MS,
  WEATHER_CADENCE_MS,
  gbfsHeaders,
  resolveGbfs,
  resolveTransit,
  resolveWeather,
  transitHeaders,
} from './feedsC.js';
import { MILITARY_CADENCE_MS } from './historyMerge.js';
// B20: `view` / `vsid` exactly as the browser helper sends them
import { SID_RE, VIEW_PARAM_RE } from './flightView.js';

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
 * B7 added launches (terminal: GEV's launch proxy polls Launch Library 2 on
 * ANY sub-path) and celestrak, a pattern route: `pathPattern` (one capture
 * group = the CelesTrak GROUP) maps /api/celestrak/<group> to the collector
 * feed `collectorFeedPrefix + group` (lower case). No group list is kept in
 * GEV or the collector: the collector discovers each group from these
 * requests (gev-history src/feeds/celestrak.js); celestrak is terminal too, so
 * an invalid group, an extra path segment or another method can never reach
 * GEV's own CelesTrak proxy (it would fetch and could trip its halt latch).
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
 * B20 flights: /api/flights is answered from the OpenSky viewport poller's
 * tile cache (gev-history src/opensky/viewportRunner.js). `viewLease`: a
 * request with a valid `view=w,s,e,n` is sent to the collector as a view
 * lease, POST /v1/aircraft/view {sid, bbox} (sid = the tab's `vsid`, or a
 * hash of the view when the tab sent none); a request without a view reads
 * the cached tiles (GET /v1/latest/aircraft-opensky) and creates no demand.
 * No query parameter is forwarded otherwise (lat/lon are dropped). Each
 * normalised view keeps its own last-good copy (flightsCacheKey).
 * /api/flights/track stays live (OpenSky /tracks bucket, DESIGN 4.2), so
 * the route is not terminal: GEV's openSkyProxy answers only the exact
 * path '/', which the bridge owns.
 */
/** [w,s,e,n] of a `view` parameter, or null unless valid. */
export function parseFlightView(value) {
  const text = String(value ?? '').trim();
  if (!VIEW_PARAM_RE.test(text)) return null;
  const [w, s, e, n] = text.split(',').map(Number);
  if (w < -180 || w > 180 || e < -180 || e > 180) return null;
  if (s < -90 || n > 90 || !(s < n) || w === e) return null;
  return [w, s, e, n];
}

/** FNV-1a 32-bit (browser-safe; only names an anonymous view lease). */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The collector view lease for a /api/flights request: {sid, bbox} or null
 * (no valid view: read the cached tiles, no demand).
 */
export function flightViewLease(url) {
  const box = parseFlightView(url.searchParams.get('view'));
  if (!box) return null;
  const bbox = box.join(',');
  const vsid = String(url.searchParams.get('vsid') ?? '');
  return { sid: SID_RE.test(vsid) ? vsid : `view-${fnv1a(bbox)}`, bbox };
}

/** Last-good copy key: the normalised view ('' = no view). */
export function flightsCacheKey(url) {
  return parseFlightView(url.searchParams.get('view'))?.join(',') ?? '';
}

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
    // gev-history src/feeds/military.js cadenceMs (adsb.lol /v2/mil, 300 s
    // since t_5ad2b9a4): the last-good copy goes STALE after 3 x = 900 s.
    cadenceMs: MILITARY_CADENCE_MS,
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
  // B15 feeds C (feedsC.js): resolver entries, one collector snapshot per
  // transit feed / GBFS system / weather product. cadenceMs here is the
  // default; each resolved target carries its own.
  transit: Object.freeze({
    route: '/api/transit',
    collectorFeed: null,
    cadenceMs: TRANSIT_CADENCE_MS,
    source: 'GTFS-RT',
    flag: 'GEV_BRIDGE_TRANSIT',
    forwardQuery: false,
    resolve: resolveTransit,
    decorate: transitHeaders,
    trails: true,
  }),
  gbfs: Object.freeze({
    route: '/api/gbfs',
    collectorFeed: null,
    cadenceMs: GBFS_STATUS_CADENCE_MS,
    source: 'GBFS',
    flag: 'GEV_BRIDGE_GBFS',
    forwardQuery: false,
    resolve: resolveGbfs,
    decorate: gbfsHeaders,
  }),
  // /api/weather/manifest from the collector; /tile and /image answered by
  // the bridge (weatherImagery.js) with collector-owned capabilities, only
  // the GetMap image bytes are live (B15 review R4)
  weather: Object.freeze({
    route: '/api/weather',
    collectorFeed: null,
    cadenceMs: WEATHER_CADENCE_MS,
    source: 'NOAA nowCOAST',
    flag: 'GEV_BRIDGE_WEATHER',
    forwardQuery: false,
    resolve: resolveWeather,
    imagery: true,
  }),
  // gev-history src/feeds/launches.js (Launch Library 2, 15 min, <= 6/h).
  launches: Object.freeze({
    route: '/api/launches',
    path: '/',
    collectorFeed: 'launches',
    cadenceMs: 900_000,
    source: 'Launch Library 2',
    flag: 'GEV_BRIDGE_LAUNCHES',
    forwardQuery: false,
    terminal: true,
  }),
  // gev-history src/feeds/celestrak.js (GP CSV per group, 6 h, halt latch).
  celestrak: Object.freeze({
    route: '/api/celestrak',
    pathPattern: '^/([a-z0-9-]{1,40})$',
    collectorFeedPrefix: 'celestrak-',
    cadenceMs: 21_600_000,
    source: 'CelesTrak',
    flag: 'GEV_BRIDGE_CELESTRAK',
    forwardQuery: false,
    terminal: true,
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
  // B20: gev-history src/opensky/viewportRunner.js (demand-driven, cadence
  // 15 s .. ~44 s sustainable; the stale rule here uses 45 s -> 135 s).
  flights: Object.freeze({
    route: '/api/flights',
    path: '/',
    collectorFeed: 'aircraft-opensky',
    cadenceMs: 45_000,
    source: 'OpenSky Network',
    flag: 'GEV_BRIDGE_FLIGHTS',
    forwardQuery: false,
    forwardParams: Object.freeze([]),
    viewLease: flightViewLease,
    cacheKey: flightsCacheKey,
    cacheEntries: 8,
  }),
});

/** Names of the feeds whose rollback flag is exactly "1" in `env`. */
export function enabledBridgeFeeds(env = {}) {
  return Object.entries(BRIDGE_FEEDS)
    .filter(([, feed]) => String(env[feed.flag] ?? '').trim() === '1')
    .map(([name]) => name);
}
