import { CONFIG_BUDGET, DEFAULT_SWITCH } from './config.js';

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
 *     must-revalidate. Terrain and imagery configs are fetched in parallel,
 *     each attempt capped at CONFIG_BUDGET.attemptMs and the whole compose
 *     at CONFIG_BUDGET.composeMs, so a hung primary still fails over to the
 *     standby before the browser's CONFIG_BUDGET.clientMs runs out.
 *   - GET /basemap/v/<ver>/terrain/cesium-mesh/ellipsoid/{layer.json|z/x/y.terrain}
 *     -> GEV_BASEMAP_TERRAIN_URLS (terrain edge, gev-basemap).
 *   - GET /basemap/imagery/<archive>/<z>/<x>/<y>.webp
 *     -> GEV_BASEMAP_IMAGERY_URLS (pmtiles serve; 204 for a missing tile).
 *   - URL lists are tried in order. The next one is tried on a network
 *     error, a timeout, a 5xx or a failure while reading the body
 *     (truncation, reset) - S4 active, then S5 standby. When every URL
 *     fails the answer is 502, no-store.
 *   - Cache-Control is this route's policy, never the upstream's: tiles
 *     (200/304) public 30 d (versioned by archive/terrain version),
 *     layer.json and config.json 60 s must-revalidate, missing tiles
 *     (204/404) 1 d, missing layer.json (204/404) no-store, anything else
 *     no-store. The matched route says what is metadata, not the URL:
 *     layer.json?extensions=...&v=... is still metadata.
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
 *   GEV_BASEMAP_TIMEOUT_MS             per-upstream tile timeout (default 10000;
 *                                      config attempts use the smaller of this
 *                                      and CONFIG_BUDGET.attemptMs)
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
    // Not env-tunable: the browser's timeout is built from the same numbers.
    configAttemptMs: CONFIG_BUDGET.attemptMs,
    configBudgetMs: CONFIG_BUDGET.composeMs,
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
  let pending = null;
  const budgetMs = Math.min(
    settings.configBudgetMs ?? CONFIG_BUDGET.composeMs,
    CONFIG_BUDGET.composeMs,
  );
  const configAttemptMs = Math.min(
    settings.timeoutMs,
    settings.configAttemptMs ?? CONFIG_BUDGET.attemptMs,
  );

  /** One attempt's signal: its own timeout, cut short by a shared deadline. */
  function attemptSignal(ms, deadline) {
    const own = AbortSignal.timeout(Math.max(1, ms));
    return deadline ? AbortSignal.any([own, deadline]) : own;
  }

  /** Reject when the deadline fires (for work that takes no signal). */
  function beforeDeadline(promise, deadline) {
    if (!deadline) return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        const fail = () =>
          reject(deadline.reason ?? new Error('config deadline passed'));
        if (deadline.aborted) fail();
        else deadline.addEventListener('abort', fail, { once: true });
      }),
    ]);
  }

  async function discard(response) {
    try {
      await response?.body?.cancel?.();
    } catch {
      /* already consumed or errored */
    }
  }

  /**
   * Try each base in order and return read(response) from the first that
   * works. read() runs inside the attempt, so a body that fails mid-read
   * (truncated, reset, timed out) moves on to the next base exactly like a
   * connect error, a timeout or a 5xx does. Nothing has been sent to the
   * client yet at that point, so retrying is safe.
   */
  async function upstream(
    bases,
    path,
    { headers = {}, timeoutMs = settings.timeoutMs, deadline = null, read },
  ) {
    let last = null;
    for (const base of bases) {
      if (deadline?.aborted) {
        last = deadline.reason ?? new Error('deadline passed');
        break;
      }
      let response = null;
      try {
        response = await fetchImpl(base + path, {
          headers,
          redirect: 'error',
          signal: attemptSignal(timeoutMs, deadline),
        });
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        return await read(response);
      } catch (error) {
        last = error;
        await discard(response);
      }
    }
    throw last ?? new Error('no upstream configured');
  }

  async function readJson(response) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function terrainConfig(deadline) {
    try {
      return await upstream(settings.terrainUrls, '/config.json', {
        timeoutMs: configAttemptMs,
        deadline,
        read: async (response) => {
          const terrain = composeTerrain(await readJson(response));
          if (!terrain.available) throw new Error('invalid terrain config');
          return terrain;
        },
      });
    } catch (error) {
      log('[basemap] terrain config unavailable:', error?.message || error);
      return { available: false };
    }
  }

  async function imageryConfig(deadline) {
    if (!settings.imageryUrls.length) return { available: false };
    for (const source of settings.imageryConfig) {
      if (deadline.aborted) break;
      try {
        let raw;
        if (/^https?:\/\//i.test(source)) {
          raw = await upstream([source], '', {
            timeoutMs: configAttemptMs,
            deadline,
            read: readJson,
          });
        } else {
          if (!source.startsWith('/'))
            throw new Error('config path must be absolute');
          raw = JSON.parse(
            await beforeDeadline(readFileImpl(source, 'utf8'), deadline),
          );
        }
        const imagery = composeImagery(raw);
        if (imagery.available) return imagery;
        throw new Error('invalid imagery config');
      } catch (error) {
        log('[basemap] imagery config unavailable:', error?.message || error);
      }
    }
    return { available: false };
  }

  async function compose() {
    const deadline = AbortSignal.timeout(budgetMs);
    const [terrain, imagery] = await Promise.all([
      terrainConfig(deadline),
      imageryConfig(deadline),
    ]);
    return {
      schema: 1,
      generated: new Date(now()).toISOString(),
      terrain,
      imagery,
      switch: { ...settings.switch },
    };
  }

  /** Cached 60 s when complete, 10 s when not; concurrent cold misses share one compose. */
  async function config() {
    if (cached && now() < cached.until) return cached.value;
    pending ??= compose()
      .then((value) => {
        const ok = value.terrain.available && value.imagery.available;
        cached = { value, until: now() + (ok ? 60_000 : 10_000) };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  function send(res, status, headers, body, head) {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers))
      if (v !== null && v !== undefined) res.setHeader(k, v);
    res.end(head ? undefined : body);
  }

  async function relay(req, res, bases, path, { kind, meta = false }) {
    const head = req.method === 'HEAD';
    const headers = {};
    for (const name of ['accept', 'if-none-match', 'if-modified-since'])
      if (req.headers?.[name]) headers[name] = req.headers[name];
    let got;
    try {
      got = await upstream(bases, path, {
        headers,
        read: async (response) => {
          const status = response.status;
          if (status !== 200 || head) {
            await discard(response);
            return { status, headers: response.headers, body: undefined };
          }
          // fetch() already decoded any content-encoding; send identity
          // bytes. A truncated or reset body rejects here and the next
          // upstream is tried.
          const body = Buffer.from(await response.arrayBuffer());
          const declared = response.headers.get('content-length');
          if (
            declared !== null &&
            !response.headers.get('content-encoding') &&
            Number(declared) !== body.length
          )
            throw new Error(`short body: ${body.length} of ${declared} bytes`);
          return { status, headers: response.headers, body };
        },
      });
    } catch (error) {
      log(`[basemap] ${kind} upstream failed:`, error?.message || error);
      send(
        res,
        502,
        { 'content-type': 'application/json', 'cache-control': 'no-store' },
        JSON.stringify({ error: `basemap ${kind} unavailable` }),
        head,
      );
      return;
    }
    const { status, body } = got;
    const out = {};
    for (const name of PASS_HEADERS) out[name] = got.headers.get(name);
    // The route decides caching; an upstream no-store/private/max-age is
    // never passed through (BASEMAP.md 4.5).
    // `meta` comes from the matched route, never from the upstream path,
    // which may end in a query. Missing metadata must not stick: no-store.
    if (status === 200 || status === 304)
      out['cache-control'] = meta ? META_CACHE : TILE_CACHE;
    else if ((status === 204 || status === 404) && !meta)
      out['cache-control'] = MISSING_CACHE;
    else out['cache-control'] = 'no-store';
    if (body) out['content-length'] = String(body.length);
    send(res, status, out, body, head);
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
          { kind: 'terrain', meta: terrain[2] === 'layer.json' },
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
