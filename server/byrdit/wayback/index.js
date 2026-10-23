import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  createReleaseStore,
  WaybackConfigError,
  WAYBACK_USER_AGENT,
} from './releases.js';
import {
  createLimiter,
  createTileCache,
  TileError,
  validTile,
} from './tileCache.js';

/**
 * Esri Wayback routes (GEV_BYRDIT_WAYBACK=1; everything is 404 otherwise
 * because no plugin is mounted):
 *   GET /api/byrdit/wayback/releases         [{release,date,label}] newest first
 *   GET /api/byrdit/wayback/tile/<release>/<z>/<row>/<col>
 *                                            same-origin view-through tile cache
 *   GET /api/byrdit/wayback/cache-status     counters + disk guard (no paths)
 *   GET /api/byrdit/wayback/info?release=&lat=&lon=&z=     (GEV_BYRDIT_WAYBACK_INFO=1)
 *                                            real capture date at one point
 *
 * Not an open proxy: the tile route takes five integers; the release must
 * be in the cached Wayback list (unknown = 404, no upstream request); the
 * upstream URL is rebuilt from our template; no cookie or caller header is
 * forwarded; GET/HEAD only.
 */

export const WAYBACK_PLUGIN_NAME = 'byrdit-wayback';
export const WAYBACK_META_NAME = 'gev-wayback';
export const ROUTE_PREFIX = '/api/byrdit/wayback/';
const TILE_ROUTE =
  /^\/api\/byrdit\/wayback\/tile\/(\d{1,10})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/;
export const TILE_CACHE_CONTROL = 'public, max-age=2592000';
export const DEFAULT_CACHE_DIR = '/srv/gev-wayback-cache';
export const ATTRIBUTION =
  'Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const flag = (v) => String(v ?? '').trim() === '1';
export const waybackEnabled = (env = process.env) =>
  flag(env.GEV_BYRDIT_WAYBACK);
export const waybackInfoEnabled = (env = process.env) =>
  waybackEnabled(env) && flag(env.GEV_BYRDIT_WAYBACK_INFO);

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function waybackSettingsFromEnv(env = process.env) {
  return {
    cacheDir:
      String(env.GEV_BYRDIT_WAYBACK_CACHE_DIR || '').trim() ||
      DEFAULT_CACHE_DIR,
    maxBytes: Math.floor(
      positive(env.GEV_BYRDIT_WAYBACK_CACHE_MAX_GB, 500) * 1024 ** 3,
    ),
    concurrency: Math.floor(positive(env.GEV_BYRDIT_WAYBACK_CONCURRENCY, 8)),
    perSecond: positive(env.GEV_BYRDIT_WAYBACK_RPS, 20),
    info: waybackInfoEnabled(env),
  };
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.statusCode = status;
  res.setHeader(
    'content-type',
    isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
  );
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload ?? '');
}

/** Metadata layer index for a web zoom (Esri's own mapping: 23 - z, 0..13). */
export const metadataLayerFor = (z) => Math.max(0, Math.min(13, 23 - z));

const finite = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/**
 * @param {ReturnType<typeof waybackSettingsFromEnv>} settings
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, fs?: typeof fsp, log?: Function,
 *   releases?: ReturnType<typeof createReleaseStore>, tiles?: ReturnType<typeof createTileCache> }} [deps]
 */
export function createWaybackHandler(settings, deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    now = Date.now,
    fs = fsp,
    log = (...a) => console.warn(...a),
  } = deps;
  const lastGood = path.join(settings.cacheDir, 'releases-last-good.json');
  const releases =
    deps.releases ??
    createReleaseStore({
      fetchImpl,
      now,
      log,
      readLastGood: async () => {
        try {
          return JSON.parse(await fs.readFile(lastGood, 'utf8'));
        } catch {
          return null;
        }
      },
      writeLastGood: async (doc) => {
        await fs.mkdir(settings.cacheDir, { recursive: true });
        await fs.writeFile(`${lastGood}.tmp`, JSON.stringify(doc));
        await fs.rename(`${lastGood}.tmp`, lastGood);
      },
    });
  const tiles =
    deps.tiles ??
    createTileCache({
      dir: settings.cacheDir,
      fetchImpl,
      now,
      fs,
      log,
      maxBytes: settings.maxBytes,
      limiter: createLimiter({
        concurrency: settings.concurrency,
        perSecond: settings.perSecond,
        now,
      }),
    });
  const infoCache = new Map();

  async function listReleases(res, req) {
    try {
      const list = await releases.get();
      send(
        res,
        200,
        {
          releases: list.releases,
          stale: list.stale,
          fetchedAt: new Date(list.fetchedAt).toISOString(),
          attribution: ATTRIBUTION,
          info: Boolean(settings.info),
        },
        { 'cache-control': 'public, max-age=300' },
      );
    } catch (error) {
      if (!(error instanceof WaybackConfigError)) throw error;
      send(
        res,
        502,
        { error: 'wayback release list unavailable' },
        { 'cache-control': 'no-store' },
      );
    }
  }

  async function tile(req, res, match) {
    const [release, z, row, col] = match.slice(1).map(Number);
    if (!validTile(release, z, row, col)) {
      return send(
        res,
        404,
        { error: 'not found' },
        { 'cache-control': 'no-store' },
      );
    }
    let list;
    try {
      list = await releases.get();
    } catch {
      return send(
        res,
        502,
        { error: 'wayback release list unavailable' },
        { 'cache-control': 'no-store' },
      );
    }
    if (!list.releases.some((r) => r.release === release))
      return send(
        res,
        404,
        { error: 'unknown release' },
        { 'cache-control': 'public, max-age=3600' },
      );
    try {
      const out = await tiles.getTile(release, z, row, col);
      if (out.none)
        return send(
          res,
          404,
          { error: 'no imagery here' },
          {
            'cache-control': 'public, max-age=86400',
            'x-wayback-cache': out.cache ?? 'MISS',
          },
        );
      const headers = {
        'cache-control': TILE_CACHE_CONTROL,
        'x-wayback-cache': out.cache,
        'x-content-type-options': 'nosniff',
        'content-length': String(out.body.length),
      };
      if (out.etag) headers.etag = out.etag;
      if (out.etag && req.headers['if-none-match'] === out.etag) {
        res.statusCode = 304;
        for (const [k, v] of Object.entries(headers))
          if (k !== 'content-length') res.setHeader(k, v);
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader('content-type', out.contentType);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.end(req.method === 'HEAD' ? undefined : out.body);
    } catch (error) {
      if (error instanceof TileError) {
        const status =
          error.code === 'breaker'
            ? 503
            : error.code === 'bad-tile'
              ? 404
              : 502;
        const headers = { 'cache-control': 'no-store' };
        if (error.retryAfter) headers['retry-after'] = String(error.retryAfter);
        return send(
          res,
          status,
          { error: 'wayback tile unavailable' },
          headers,
        );
      }
      throw error;
    }
  }

  async function info(url, res) {
    if (!settings.info) return send(res, 404, { error: 'not found' });
    const release = Number(url.searchParams.get('release'));
    const lat = finite(url.searchParams.get('lat'), -85.06, 85.06);
    const lon = finite(url.searchParams.get('lon'), -180, 180);
    const z = Math.round(finite(url.searchParams.get('z'), 0, 23) ?? -1);
    if (!Number.isSafeInteger(release) || lat === null || lon === null || z < 0)
      return send(
        res,
        400,
        { error: 'bad request' },
        { 'cache-control': 'no-store' },
      );
    let list;
    try {
      list = await releases.get();
    } catch {
      return send(
        res,
        502,
        { error: 'wayback release list unavailable' },
        { 'cache-control': 'no-store' },
      );
    }
    const base = list.metadata.get(release);
    if (!base) return send(res, 404, { error: 'unknown release' });
    const layer = metadataLayerFor(z);
    const key = `${release}/${layer}/${lat.toFixed(3)}/${lon.toFixed(3)}`;
    const cached = infoCache.get(key);
    if (cached && now() - cached.at < 24 * 3600_000)
      return send(res, 200, cached.body, {
        'cache-control': 'public, max-age=3600',
      });
    const query = new URLSearchParams({
      f: 'json',
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'SRC_DATE,SRC_RES,NICE_NAME,NICE_DESC',
      returnGeometry: 'false',
    });
    try {
      const response = await fetchImpl(`${base}/${layer}/query?${query}`, {
        headers: {
          'user-agent': WAYBACK_USER_AGENT,
          accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await response.json();
      const a = doc?.features?.[0]?.attributes ?? null;
      const d = String(a?.SRC_DATE ?? '');
      const body = {
        captured: /^\d{8}$/.test(d)
          ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
          : null,
        resolutionM: Number.isFinite(a?.SRC_RES) ? a.SRC_RES : null,
        source:
          typeof a?.NICE_NAME === 'string' ? a.NICE_NAME.slice(0, 50) : null,
        provider:
          typeof a?.NICE_DESC === 'string' ? a.NICE_DESC.slice(0, 25) : null,
      };
      if (infoCache.size > 2000)
        infoCache.delete(infoCache.keys().next().value);
      infoCache.set(key, { at: now(), body });
      return send(res, 200, body, { 'cache-control': 'public, max-age=3600' });
    } catch {
      return send(
        res,
        502,
        { error: 'wayback info unavailable' },
        { 'cache-control': 'no-store' },
      );
    }
  }

  /** Connect-style middleware. */
  async function handler(req, res, next) {
    const raw = req.url ?? '';
    if (!raw.startsWith(ROUTE_PREFIX)) return next();
    let url;
    try {
      url = new URL(raw, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad request' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(
        res,
        405,
        { error: 'method not allowed' },
        { allow: 'GET, HEAD' },
      );
    try {
      if (url.pathname === `${ROUTE_PREFIX}releases`)
        return await listReleases(res, req);
      if (url.pathname === `${ROUTE_PREFIX}cache-status`)
        return send(res, 200, await tiles.status(), {
          'cache-control': 'no-store',
        });
      if (url.pathname === `${ROUTE_PREFIX}info`) return await info(url, res);
      const match = TILE_ROUTE.exec(url.pathname);
      if (match) return await tile(req, res, match);
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      log('[wayback] unexpected error:', error?.name ?? 'Error');
      return send(
        res,
        500,
        { error: 'internal error' },
        { 'cache-control': 'no-store' },
      );
    }
  }
  handler.releases = releases;
  handler.tiles = tiles;
  return handler;
}

/**
 * Vite plugins: [] unless GEV_BYRDIT_WAYBACK=1. server/standalone/vite.config.js
 * spreads this in (one import line + one plugin line).
 */
export function waybackPlugins({ env = process.env, ...deps } = {}) {
  if (!waybackEnabled(env)) return [];
  const handler = createWaybackHandler(waybackSettingsFromEnv(env), deps);
  return [
    {
      name: WAYBACK_PLUGIN_NAME,
      configureServer(server) {
        server.middlewares.use(handler);
      },
      configurePreviewServer(server) {
        server.middlewares.use(handler);
      },
      transformIndexHtml() {
        return [
          {
            tag: 'meta',
            attrs: { name: WAYBACK_META_NAME, content: '1' },
            injectTo: 'head',
          },
        ];
      },
    },
  ];
}
