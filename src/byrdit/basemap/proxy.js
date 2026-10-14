import { DEFAULT_SWITCH } from './config.js';

/**
 * Same-origin /basemap/* for the Byrd-IT Open map (BASEMAP.md 3.2, 4.2, 4.5).
 *
 * Off unless GEV_BASEMAP=1: basemapPlugins() then returns [] and the vite
 * plugin list is exactly what it was without this module.
 *
 * With the flag on, this module:
 *   - marks index.html with <meta name="gev-basemap" content="1"> (the
 *     browser's only signal to use the stack).
 *   - GET /basemap/config.json: a config composed from the terrain edge's
 *     /config.json and the imagery publish config. It is built field by field
 *     from validated numbers and same-origin paths, so no upstream URL,
 *     header or credential can pass through. Cache-Control is 60 s,
 *     must-revalidate.
 *   - GET /basemap/v/<ver>/terrain/cesium-mesh/ellipsoid/{layer.json|z/x/y.terrain}
 *     -> GEV_BASEMAP_TERRAIN_URLS (terrain edge, gev-basemap).
 *   - GET /basemap/imagery/<archive>/<z>/<x>/<y>.webp
 *     -> GEV_BASEMAP_IMAGERY_URLS (pmtiles serve; 204 for a missing tile).
 *   - URL lists are tried in order. The next one is tried on a network
 *     error, a timeout or a 5xx (S4 active, then S5 standby).
 *   - Strict path patterns only, so no open proxy; GET/HEAD only; no keys,
 *     no cookies forwarded.
 *
 * Environment:
 *   GEV_BASEMAP=1                      flag (default OFF)
 *   GEV_BASEMAP_TERRAIN_URLS=a,b       terrain edge base URLs
 *   GEV_BASEMAP_IMAGERY_URLS=a,b       imagery server base URLs
 *   GEV_BASEMAP_IMAGERY_CONFIG=x[,y]   imagery config.json: http(s) URL or absolute file path
 *   GEV_BASEMAP_AUTO=0|1               auto-switch (default 1)
 *   GEV_BASEMAP_ENTER_M, GEV_BASEMAP_LEAVE_M, GEV_BASEMAP_DWELL_MS
 *   GEV_BASEMAP_TIMEOUT_MS             per-upstream timeout (default 10000)
 */

export const BASEMAP_PLUGIN_NAME = 'byrdit-basemap';

const TERRAIN_ROUTE =
  /^\/basemap\/v\/([A-Za-z0-9._-]{1,64})\/terrain\/cesium-mesh\/ellipsoid\/(layer\.json|\d{1,2}\/\d{1,8}\/\d{1,8}\.terrain)$/;
const IMAGERY_ROUTE =
  /^\/basemap\/imagery\/([A-Za-z0-9._-]{1,64})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.webp$/;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const TERRAIN_QUERY = new Set(['extensions', 'v']);
const TILE_CACHE = 'public, max-age=2592000';
const META_CACHE = 'max-age=60, must-revalidate';
const MISSING_CACHE = 'public, max-age=86400';
const PASS_HEADERS = ['content-type', 'etag', 'last-modified'];

export function basemapEnabled(env = process.env) {
  return String(env.GEV_BASEMAP ?? '').trim() === '1';
}

function urlList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\/[^\s/]+/i.test(s));
}

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0
    ? n
    : fallback;
}

export function basemapSettingsFromEnv(env = process.env) {
  return {
    terrainUrls: urlList(env.GEV_BASEMAP_TERRAIN_URLS),
    imageryUrls: urlList(env.GEV_BASEMAP_IMAGERY_URLS),
    imageryConfig: String(env.GEV_BASEMAP_IMAGERY_CONFIG ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: num(env.GEV_BASEMAP_TIMEOUT_MS, 10_000),
    switch: {
      auto: String(env.GEV_BASEMAP_AUTO ?? '1').trim() !== '0',
      enterM: num(env.GEV_BASEMAP_ENTER_M, DEFAULT_SWITCH.enterM),
      leaveM: num(env.GEV_BASEMAP_LEAVE_M, DEFAULT_SWITCH.leaveM),
      dwellMs: num(env.GEV_BASEMAP_DWELL_MS, DEFAULT_SWITCH.dwellMs),
      reRootAgeMs: DEFAULT_SWITCH.reRootAgeMs,
      rootAttemptsPerHour: DEFAULT_SWITCH.rootAttemptsPerHour,
    },
  };
}

const int = (v, lo, hi) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : null;

function bbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const b = value.map(Number);
  if (b.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, n] = b;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return b;
}

/** Terrain edge /config.json -> browser terrain block (or unavailable). */
export function composeTerrain(raw) {
  const version = raw?.version;
  if (typeof version !== 'string' || !NAME.test(version))
    return { available: false };
  return {
    available: true,
    version,
    url: `/basemap/v/${version}/terrain/cesium-mesh/ellipsoid`,
    minzoom: int(raw?.terrain?.minzoom, 0, 22) ?? 0,
    maxzoom: int(raw?.terrain?.maxzoom, 0, 22) ?? 0,
    waterMask: /(^|[-_.])wm/.test(version),
  };
}

/** Imagery publish config (P2 schema 1) -> browser imagery block. */
export function composeImagery(raw) {
  const match = /^\/([A-Za-z0-9._-]{1,64})\/\{z\}\/\{x\}\/\{y\}\.webp$/.exec(
    String(raw?.tile_url ?? ''),
  );
  const layers = Array.isArray(raw?.layers) ? raw.layers : [];
  if (!match || !layers.length) return { available: false };
  const base = layers.find(
    (l) => l?.minzoom === 0 && !Array.isArray(l?.regions),
  );
  const baseMaxzoom = int(base?.maxzoom, 0, 22);
  if (baseMaxzoom === null) return { available: false };
  const regions = [];
  for (const layer of layers) {
    if (!Array.isArray(layer?.regions)) continue;
    for (const region of layer.regions) {
      const bounds = bbox(region?.bounds);
      const maxzoom = int(region?.maxzoom ?? layer.maxzoom, 0, 22);
      if (bounds && maxzoom !== null) regions.push({ bounds, maxzoom });
    }
  }
  const year =
    int(raw?.credit?.year, 1900, 2999) ?? int(raw?.archive?.year, 1900, 2999);
  return {
    available: true,
    archive: match[1],
    url: `/basemap/imagery/${match[1]}/{z}/{x}/{y}.webp`,
    baseMaxzoom,
    maxzoom: Math.max(baseMaxzoom, ...regions.map((r) => r.maxzoom)),
    year,
    regions,
  };
}

/**
 * @param {ReturnType<typeof basemapSettingsFromEnv>} settings
 * @param {{fetchImpl?: typeof fetch, readFileImpl?: Function, now?: () => number, log?: Function}} [deps]
 */
export function createBasemapHandler(
  settings,
  {
    fetchImpl = globalThis.fetch,
    // src/ may not import node builtins (check-import-directions); the server
    // entry server/byrdit/basemap.js injects node:fs/promises readFile.
    readFileImpl = async () => {
      throw new Error('file configs need the server entry (readFileImpl)');
    },
    now = Date.now,
    log = (...args) => console.warn(...args),
  } = {},
) {
  let cached = null;

  async function upstream(bases, path, headers = {}) {
    let last = null;
    for (const base of bases) {
      try {
        const response = await fetchImpl(base + path, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
        if (response.status >= 500) {
          last = new Error(`HTTP ${response.status}`);
          await response.body?.cancel?.();
          continue;
        }
        return response;
      } catch (error) {
        last = error;
      }
    }
    throw last ?? new Error('no upstream configured');
  }

  async function readJsonSource(source) {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetchImpl(source, {
        redirect: 'error',
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }
    if (!source.startsWith('/'))
      throw new Error('config path must be absolute');
    return JSON.parse(await readFileImpl(source, 'utf8'));
  }

  async function compose() {
    let terrain = { available: false };
    try {
      const response = await upstream(settings.terrainUrls, '/config.json');
      if (response.ok) terrain = composeTerrain(await response.json());
      else await response.body?.cancel?.();
    } catch (error) {
      log('[basemap] terrain config unavailable:', error?.message || error);
    }
    let imagery = { available: false };
    if (settings.imageryUrls.length)
      for (const source of settings.imageryConfig) {
        try {
          imagery = composeImagery(await readJsonSource(source));
          if (imagery.available) break;
        } catch (error) {
          log('[basemap] imagery config unavailable:', error?.message || error);
        }
      }
    return {
      schema: 1,
      generated: new Date(now()).toISOString(),
      terrain,
      imagery,
      switch: { ...settings.switch },
    };
  }

  async function config() {
    const t = now();
    if (cached && t < cached.until) return cached.value;
    const value = await compose();
    const ok = value.terrain.available && value.imagery.available;
    cached = { value, until: t + (ok ? 60_000 : 10_000) };
    return value;
  }

  function send(res, status, headers, body, head) {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers))
      if (v !== null && v !== undefined) res.setHeader(k, v);
    res.end(head ? undefined : body);
  }

  async function relay(req, res, bases, path, { kind }) {
    const headers = {};
    for (const name of ['accept', 'if-none-match', 'if-modified-since'])
      if (req.headers?.[name]) headers[name] = req.headers[name];
    let response;
    try {
      response = await upstream(bases, path, headers);
    } catch (error) {
      log(`[basemap] ${kind} upstream failed:`, error?.message || error);
      send(
        res,
        502,
        { 'content-type': 'application/json', 'cache-control': 'no-store' },
        JSON.stringify({ error: `basemap ${kind} unavailable` }),
        req.method === 'HEAD',
      );
      return;
    }
    const out = {};
    for (const name of PASS_HEADERS) out[name] = response.headers.get(name);
    const status = response.status;
    const meta = path.endsWith('layer.json');
    if (status === 200 || status === 304)
      out['cache-control'] =
        response.headers.get('cache-control') ??
        (meta ? META_CACHE : TILE_CACHE);
    else if (status === 204 || status === 404)
      out['cache-control'] = MISSING_CACHE;
    else out['cache-control'] = 'no-store';
    // fetch() already decoded any content-encoding; send identity bytes.
    const body =
      status === 200 && req.method !== 'HEAD'
        ? Buffer.from(await response.arrayBuffer())
        : (await response.body?.cancel?.(), undefined);
    if (body) out['content-length'] = String(body.length);
    send(res, status, out, body, req.method === 'HEAD');
  }

  return async function basemapMiddleware(req, res, next) {
    // Route on the raw path: URL parsing would resolve "..", so a request
    // like /basemap/../x is refused here instead of leaving the prefix.
    const raw = String(req.url ?? '/');
    const rawPath = raw.split('?')[0];
    if (rawPath !== '/basemap' && !rawPath.startsWith('/basemap/'))
      return next?.();
    const url = new URL(raw, 'http://local');
    if (url.pathname !== rawPath) url.pathname = '/basemap/-invalid-';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { allow: 'GET, HEAD' }, '', false);
      return;
    }
    try {
      if (url.pathname === '/basemap/config.json') {
        const body = JSON.stringify(await config());
        send(
          res,
          200,
          {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': META_CACHE,
            'content-length': String(Buffer.byteLength(body)),
          },
          body,
          req.method === 'HEAD',
        );
        return;
      }
      const terrain = TERRAIN_ROUTE.exec(url.pathname);
      if (terrain) {
        const query = new URLSearchParams();
        for (const [k, v] of url.searchParams)
          if (TERRAIN_QUERY.has(k) && /^[A-Za-z0-9.,_-]{0,64}$/.test(v))
            query.append(k, v);
        const qs = query.toString();
        await relay(
          req,
          res,
          settings.terrainUrls,
          `/v/${terrain[1]}/terrain/cesium-mesh/ellipsoid/${terrain[2]}${qs ? `?${qs}` : ''}`,
          { kind: 'terrain' },
        );
        return;
      }
      const imagery = IMAGERY_ROUTE.exec(url.pathname);
      if (imagery) {
        const [, archive, z, x, y] = imagery;
        await relay(
          req,
          res,
          settings.imageryUrls,
          `/${archive}/${z}/${x}/${y}.webp`,
          {
            kind: 'imagery',
          },
        );
        return;
      }
      send(
        res,
        404,
        { 'content-type': 'application/json', 'cache-control': 'no-store' },
        JSON.stringify({ error: 'not found' }),
        req.method === 'HEAD',
      );
    } catch (error) {
      log('[basemap] handler error:', error?.message || error);
      if (!res.headersSent)
        send(
          res,
          500,
          { 'content-type': 'application/json', 'cache-control': 'no-store' },
          JSON.stringify({ error: 'basemap error' }),
          false,
        );
    }
  };
}

/**
 * Vite plugins for /basemap. [] unless GEV_BASEMAP=1.
 * @param {{env?: Record<string, string|undefined>} & Parameters<typeof createBasemapHandler>[1]} [options]
 */
export function basemapPlugins({ env = process.env, ...deps } = {}) {
  if (!basemapEnabled(env)) return [];
  const handler = createBasemapHandler(basemapSettingsFromEnv(env), deps);
  return [
    {
      name: BASEMAP_PLUGIN_NAME,
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
            attrs: { name: 'gev-basemap', content: '1' },
            injectTo: 'head',
          },
        ];
      },
    },
  ];
}
