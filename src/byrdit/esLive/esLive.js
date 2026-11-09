import {
  HISTORY_INDICES,
  createHistoryEsClient,
  esConfigFromEnv,
} from '../history/historyEs.js';
import { createHistoryService } from '../history/historyService.js';
import { AQHI_LOOKBACK_MS } from '../history/historyParams.js';

/**
 * Live feeds answered from OUR Elasticsearch copy instead of the upstream
 * provider (card t_a829441f, owner go Brandon 2026-11-09: nothing on the page
 * may call an API the collector already stores).
 *
 *   GEV_ES_LIVE_GNSS=1     /api/gnss-integrity  <- gev-history-gnss-integrity
 *       (replaces the adsb.lol regional proxy; MILITARY aircraft cells only,
 *       that is all the collector records)
 *   GEV_ES_LIVE_QUAKES=1   /api/es-live/earthquakes <- gev-history-quakes
 *       (USGS summary FeatureCollection, the shape all_day.geojson has)
 *   GEV_ES_LIVE_AQHI=1     /api/es-live/aqhi, /api/es-live/aqhi-stations
 *       <- gev-history-aqhi (ECCC collection shapes the layer already parses)
 *
 * A flag that is "1" has NO fall-through to the upstream: when ES cannot
 * answer, or the newest recorded snapshot is older than FRESH_LIMIT_MS (a
 * stalled collector), the last good copy is served marked stale while it is
 * younger than STALE_LIMIT_MS and still within the freshness limit, else 503.
 * An empty answer that carries a reason or a gap marker is "no data", not an
 * empty sky. A flag that is not "1" mounts nothing for that feed and the
 * page behaves exactly as before. The reads go through the existing read-only
 * history service (reader key), never a new ES credential.
 */

export const ES_LIVE_FEEDS = Object.freeze({
  gnss: 'GEV_ES_LIVE_GNSS',
  quakes: 'GEV_ES_LIVE_QUAKES',
  aqhi: 'GEV_ES_LIVE_AQHI',
});
export const ES_LIVE_PREFIX = '/api/es-live';
export const ES_LIVE_CONFIG_ROUTE = '/config';
export const GNSS_ROUTE = '/api/gnss-integrity';

export const TTL_MS = Object.freeze({
  gnss: 30_000,
  quakes: 30_000,
  aqhi: 120_000,
});
/** Longest a last-good copy may stand in for a failing ES read. */
export const STALE_LIMIT_MS = 15 * 60_000;
/**
 * Oldest newest-recorded-snapshot an answer may be built on. GNSS snapshots
 * come every 5 min; quakes and AQHI are change-only (a quiet hour writes
 * nothing), so their limits are hours, not minutes.
 */
export const FRESH_LIMIT_MS = Object.freeze({
  gnss: 15 * 60_000,
  quakes: 3 * 3_600_000,
  aqhi: 3 * 3_600_000,
});
/** The AQHI station catalog looks back this far (the data is change-only; a 6 h window lost stations). */
export const STATION_WINDOW_MS = 30 * 86_400_000;
export const STATION_TTL_MS = 3_600_000;
/** The GNSS layer's regional circle (the adsb.lol call it replaces used the same). */
export const GNSS_RADIUS_NM = 250;
/** After a failed ES read, no new read for this long (an outage costs one question per window, not one per tab poll). */
export const FAIL_BACKOFF_MS = 10_000;
export const QUAKE_MAX_ROWS = 5_000;
export const AQHI_MAX_ROWS = 2_000;
export const GNSS_MAX_ROWS = 20_000;

/** Hard cap on expanded rows (same as historyUi/historyAirGnssAdapters.js). */
export const GNSS_MAX_EXPANDED_ROWS = 60_000;

/**
 * Anonymous aircraft rows of recorded cells: `bad` degraded of `total`. The
 * same expansion the time-travel adapter does (historyAirGnssAdapters.js
 * expandGnssCells; a test pins the two to the same output). Copied, not
 * imported, because the history package may not import the UI adapters.
 */
export function expandGnssCells(cells, cap = GNSS_MAX_EXPANDED_ROWS) {
  const rows = [];
  for (const c of Array.isArray(cells) ? cells : []) {
    const total = Math.floor(Number(c?.total));
    if (!(total >= 1) || !Number.isFinite(c?.lat) || !Number.isFinite(c?.lon))
      continue;
    const bad = Math.min(total, Math.max(0, Math.floor(Number(c.bad) || 0)));
    for (let i = 0; i < total && rows.length < cap; i++)
      rows.push({
        hex: `h${String(c.cell || `${c.lat},${c.lon}`)}-${i}`,
        lat: c.lat,
        lon: c.lon,
        nic: null,
        nacp: null,
        gpsLost: false,
        degraded: i < bad,
      });
  }
  return rows;
}

/** Names of the feeds whose flag is exactly "1" in `env`. */
export function enabledEsLive(env = {}) {
  return Object.entries(ES_LIVE_FEEDS)
    .filter(([, flag]) => String(env[flag] ?? '').trim() === '1')
    .map(([name]) => name);
}

/**
 * GEV_ES_LIVE_WATER=1: the river-gauge history slider answers from the recorded
 * usgs-water-levels copy only. Times before the first recorded reading are an
 * explained empty slice and an ES failure is an error; USGS NWIS is never asked
 * (server/byrdit/history.js passes no NWIS reader).
 */
export const ES_LIVE_WATER_FLAG = 'GEV_ES_LIVE_WATER';
export const esLiveWaterOnly = (env = {}) =>
  String(env[ES_LIVE_WATER_FLAG] ?? '').trim() === '1';

const JSON_TYPE = 'application/json; charset=utf-8';

function send(res, status, body, headers = {}) {
  if (res.destroyed || res.headersSent) return;
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_TYPE);
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

const EARTH_NM = 3440.065;
/** Great-circle distance in nautical miles. */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) *
      Math.cos(lat2 * r) *
      Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * One cached, coalesced ES read per feed. `load()` resolves to
 * { data, observedAt } (observedAt = the newest recorded snapshot the answer
 * rests on, ms); concurrent callers share one read, so ES sees at most one
 * question per feed per TTL however many tabs are open. After a failure no
 * new read starts for FAIL_BACKOFF_MS.
 */
function createFeedCache({ ttlMs, freshLimitMs, now }) {
  let value = null;
  let at = 0;
  let failedAt = null;
  let pending = null;
  const usable = () =>
    value !== null &&
    now() - at <= STALE_LIMIT_MS &&
    (value.observedAt === null || now() - value.observedAt <= freshLimitMs);
  const fallback = (error) => {
    if (usable()) return { value, stale: true };
    throw error;
  };
  async function get(load) {
    if (
      value !== null &&
      now() - at < ttlMs &&
      (value.observedAt === null || now() - value.observedAt <= freshLimitMs)
    )
      return { value, stale: false };
    if (failedAt !== null && now() - failedAt < FAIL_BACKOFF_MS)
      return fallback(new Error('es_backoff'));
    pending ??= load()
      .then((v) => {
        value = v;
        at = now();
        failedAt = null;
      })
      .catch((error) => {
        failedAt = now();
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    try {
      await pending;
      return { value, stale: false };
    } catch (error) {
      return fallback(error);
    }
  }
  return { get };
}

const unavailable = (res, retryAfterS = 30) =>
  send(
    res,
    503,
    { error: 'es_live_unavailable' },
    { 'Retry-After': String(retryAfterS) },
  );

/** Short, secret-free reason for the log line. */
function reasonOf(error) {
  if (typeof error?.reason === 'string') return error.reason.slice(0, 120);
  if (/^es_[a-z_]{1,40}$/.test(String(error?.message ?? '')))
    return error.message;
  return String(error?.name ?? 'error').slice(0, 40);
}

const EMPTY_MARKERS = ['X-History-Empty-Reason', 'X-History-Gap'];

/**
 * @param {object} options
 * @param {{slice: Function}|null} options.service history service (null = ES not configured)
 * @param {string[]} options.enabled feed names to serve
 * @param {(feed: 'gnss'|'quakes'|'aqhi') => Promise<number|null>} [options.freshness]
 *   newest recorded snapshot of the feed's stream (ms); omitted = no check
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 */
export function createEsLive({
  service,
  enabled,
  freshness = null,
  now = () => Date.now(),
  log = (line) => console.warn(line),
}) {
  const on = new Set(enabled);
  const caches = {
    gnss: createFeedCache({
      ttlMs: TTL_MS.gnss,
      freshLimitMs: FRESH_LIMIT_MS.gnss,
      now,
    }),
    quakes: createFeedCache({
      ttlMs: TTL_MS.quakes,
      freshLimitMs: FRESH_LIMIT_MS.quakes,
      now,
    }),
    aqhi: createFeedCache({
      ttlMs: TTL_MS.aqhi,
      freshLimitMs: FRESH_LIMIT_MS.aqhi,
      now,
    }),
    stations: createFeedCache({
      ttlMs: STATION_TTL_MS,
      freshLimitMs: FRESH_LIMIT_MS.aqhi,
      now,
    }),
  };
  const lastLog = new Map();
  function logFailure(feed, error) {
    const t = now();
    // one line per minute per feed at most (a failing feed must not hide another)
    if (t - (lastLog.get(feed) ?? -Infinity) < 60_000) return;
    lastLog.set(feed, t);
    log(`[es-live] ${feed} unavailable: ${reasonOf(error)}`);
  }

  async function sliceOf(params) {
    if (!service) throw new Error('es_not_configured');
    const out = await service.slice(params);
    // 404 "not recorded", an explained empty slice or a gap are not data
    if (out?.status || !out?.body) throw new Error('es_no_data');
    for (const h of EMPTY_MARKERS)
      if (out.headers?.[h] !== undefined) throw new Error('es_no_data');
    return out;
  }

  /** Newest recorded snapshot; refuses a stalled collector. */
  async function observedAtOf(feed) {
    if (!freshness) return null;
    const snap = await freshness(feed);
    if (!Number.isFinite(snap)) throw new Error('es_no_snapshot');
    if (now() - snap > FRESH_LIMIT_MS[feed]) throw new Error('es_stale_source');
    return snap;
  }

  async function loadQuakes() {
    const [out, observedAt] = await Promise.all([
      sliceOf({
        feed: 'quakes',
        t: now(),
        bbox: null,
        maxRows: QUAKE_MAX_ROWS,
        windowMs: null,
      }),
      observedAtOf('quakes'),
    ]);
    return { data: out.body, observedAt };
  }

  async function loadAqhi(windowMs) {
    const [out, observedAt] = await Promise.all([
      sliceOf({
        feed: 'aqhi',
        t: now(),
        bbox: null,
        maxRows: AQHI_MAX_ROWS,
        windowMs,
      }),
      observedAtOf('aqhi'),
    ]);
    return { data: out.body, observedAt };
  }

  async function loadGnss() {
    const out = await sliceOf({
      feed: 'gnss',
      t: now(),
      bbox: null,
      maxRows: GNSS_MAX_ROWS,
      windowMs: null,
    });
    const { snap, cells } = out.body;
    // no recorded snapshot in the last 15 min: not an empty sky, no data
    if (!Number.isFinite(snap) || !Array.isArray(cells))
      throw new Error('es_no_snapshot');
    if (now() - snap > FRESH_LIMIT_MS.gnss) throw new Error('es_stale_source');
    return { data: { snap, cells }, observedAt: snap };
  }

  async function serve(res, feed, load, shape) {
    try {
      const { value, stale } = await caches[feed].get(load);
      const { body, headers } = shape(value.data, stale);
      send(res, 200, body, {
        'X-Feed-Source': 'elasticsearch',
        ...headers,
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
    } catch (error) {
      logFailure(feed, error);
      unavailable(res);
    }
  }

  const stationsOf = (collection) => ({
    type: 'FeatureCollection',
    features: (collection.features ?? []).map((f) => ({
      type: 'Feature',
      id: f.id,
      geometry: f.geometry,
      properties: {
        location_id: f.properties?.location_id,
        location_name_en: f.properties?.location_name_en,
      },
    })),
  });

  /** {lat, lon} of a valid anchor query, else null. */
  function anchorOf(url) {
    const num = /^-?\d{1,3}(?:\.\d{1,8})?$/;
    const rawLat = url.searchParams.get('lat');
    const rawLon = url.searchParams.get('lon');
    if (!num.test(rawLat ?? '') || !num.test(rawLon ?? '')) return null;
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }

  /**
   * Connect's own mount rule (case-insensitive, then end of path, "/" or
   * "."), so no spelling of a flagged route can reach the provider proxy.
   */
  const mounted = (lower, prefix) =>
    lower.startsWith(prefix) &&
    [undefined, '/', '.'].includes(lower[prefix.length]);

  /** Connect middleware; calls next() for every path it does not own. */
  return async function esLiveMiddleware(req, res, next) {
    let path;
    try {
      path = new URL(String(req.url ?? '/'), 'http://localhost');
    } catch {
      return next?.();
    }
    const lower = path.pathname.toLowerCase();
    let route = null;
    if (on.has('gnss') && mounted(lower, GNSS_ROUTE)) {
      const rest = lower.slice(GNSS_ROUTE.length);
      if (rest !== '' && rest !== '/')
        return send(res, 404, { error: 'unknown_route' });
      route = 'gnss';
    } else if (mounted(lower, ES_LIVE_PREFIX)) {
      const sub = lower.slice(ES_LIVE_PREFIX.length).replace(/\/$/, '');
      if (sub === ES_LIVE_CONFIG_ROUTE) route = 'config';
      else if (sub === '/earthquakes' && on.has('quakes')) route = 'quakes';
      else if (sub === '/aqhi' && on.has('aqhi')) route = 'aqhi';
      else if (sub === '/aqhi-stations' && on.has('aqhi'))
        route = 'aqhi-stations';
      // an unknown or disabled es-live route is a 404 here, never a fall-through
      else return send(res, 404, { error: 'unknown_route' });
    }
    if (!route) return next?.();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(
        res,
        405,
        { error: 'method_not_allowed' },
        { Allow: 'GET, HEAD' },
      );
    }
    if (route === 'config') {
      // which feeds this server answers from ES; the page asks once, so a flag
      // change needs only a restart, never a rebuild (vite preview serves a
      // built index.html)
      return send(res, 200, { feeds: [...on].sort() });
    }
    if (route === 'gnss') {
      const anchor = anchorOf(path);
      if (!anchor) return send(res, 400, { error: 'invalid_anchor' });
      return serve(res, 'gnss', loadGnss, ({ snap, cells }, stale) => {
        // the layer says "250 nm radius around the view": answer exactly that
        const near = cells.filter(
          (c) =>
            distanceNm(anchor.lat, anchor.lon, c.lat, c.lon) <= GNSS_RADIUS_NM,
        );
        return {
          body: {
            fetchedAt: snap,
            classifier: null,
            anchor,
            radiusNm: GNSS_RADIUS_NM,
            // what the rows describe: the collector records military aircraft only
            population: 'military-aircraft',
            rows: expandGnssCells(near),
            // the age is measured on this server's clock, as the adsb.lol proxy did
            ageMs: Math.max(0, now() - snap),
            ...(stale ? { stale: true } : {}),
          },
          headers: { 'X-Gnss-Population': 'military-aircraft' },
        };
      });
    }
    if (route === 'quakes')
      return serve(res, 'quakes', loadQuakes, (data) => ({
        body: data,
        headers: {},
      }));
    if (route === 'aqhi')
      return serve(
        res,
        'aqhi',
        () => loadAqhi(AQHI_LOOKBACK_MS),
        (data) => ({ body: data, headers: {} }),
      );
    return serve(
      res,
      'stations',
      () => loadAqhi(STATION_WINDOW_MS),
      (data) => ({
        body: stationsOf(data),
        headers: {},
      }),
    );
  };
}

const FRESH_INDEX = {
  gnss: HISTORY_INDICES.gnss,
  quakes: HISTORY_INDICES.quakesLive,
  aqhi: HISTORY_INDICES.aqhi,
};

/**
 * Vite plugin: the middleware (dev and preview). The page learns which feeds
 * to redirect from GET /api/es-live/config. No plugin at all (no change to the
 * plugin list) when no flag is "1".
 */
export function esLivePlugins({
  env = {},
  service,
  freshness,
  fetchImpl,
  now,
  log,
} = {}) {
  const enabled = enabledEsLive(env);
  if (!enabled.length) return [];
  let svc = service;
  let fresh = freshness;
  if (svc === undefined) {
    const config = esConfigFromEnv(env);
    if (config) {
      const es = createHistoryEsClient({
        ...config,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      svc = createHistoryService({ es, ...(now ? { now } : {}) });
      fresh ??= async (feed) => {
        const json = await es.search(FRESH_INDEX[feed], {
          size: 0,
          aggs: { newest: { max: { field: 'snap' } } },
        });
        const v = json?.aggregations?.newest?.value;
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      };
    } else {
      svc = null;
    }
  }
  const middleware = createEsLive({
    service: svc,
    enabled,
    freshness: fresh ?? null,
    ...(now ? { now } : {}),
    ...(log ? { log } : {}),
  });
  return [
    {
      name: 'byrdit-es-live',
      configureServer(server) {
        server.middlewares.use(middleware);
      },
      configurePreviewServer(server) {
        server.middlewares.use(middleware);
      },
    },
  ];
}
