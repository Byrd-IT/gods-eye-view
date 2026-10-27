import { CONFIG_BUDGET, DEFAULT_BUILDINGS, DEFAULT_SWITCH } from './config.js';
import { composeNaip, naipEnabled, resolveNaipTile } from './naipProxy.js';

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
 *   - GET /basemap/v/<ver>/buildings/tileset.json,
 *         /basemap/v/<ver>/buildings/<impl>/sub/<z>/<x>/<y>/tileset.json,
 *         /basemap/v/<ver>/buildings/<impl>/<z>/<x>/<y>.glb
 *     -> GEV_BASEMAP_BUILDINGS_URLS (gev-buildings edge, P5; optional: without
 *     it the config says buildings.available:false and the stack runs without
 *     the buildings layer). The root tileset.json is metadata (60 s); the
 *     sub-tilesets and glb tiles sit under the versioned path (30 d); the
 *     edge's 410 for a stale implementation version is never cached.
 *   - GET /basemap/health.json: the edge health report (P9 gb-refresh.py
 *     health.json) reduced to state, chip text, up to 5 sanitized warnings
 *     and the generated time. Nothing else (host, disk, jobs, info) passes,
 *     URLs and key=value secrets inside warnings are redacted. Without
 *     GEV_BASEMAP_HEALTH_URLS, or when every health URL fails, the answer is
 *     200 {available:false, state:'unknown'}: health is advice and never
 *     changes whether the stack is offered (that is config.json's job).
 *     Cached 30 s (10 s when unknown); Cache-Control max-age=30.
 *   - GET /basemap/naip/<year>/<z>/<x>/<y>.webp and
 *         /basemap/naip/regional/<id>/<z>/<x>/<y>.webp (N6 NAIP time slider,
 *     only with GEV_BASEMAP_NAIP=1; see naipProxy.js). The year or id must be
 *     in the composed naip block, else 404 without an upstream request. Tiles
 *     follow the imagery cache policy (30 d, missing 1 d).
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
 *   GEV_BASEMAP_BUILDINGS_URLS=a,b     buildings edge base URLs (P6, optional)
 *   GEV_BASEMAP_HEALTH_URLS=a,b        full health.json URLs (P9, optional), e.g.
 *                                      http://127.0.0.1:12355/health.json
 *   GEV_BASEMAP_BUILDINGS_BELOW_M      show buildings at or below this camera
 *                                      height (default 8000; hidden again
 *                                      above 1.25x)
 *   GEV_BASEMAP_NAIP=1                 NAIP time slider (default OFF), with
 *   GEV_BASEMAP_NAIP_CONFIG=x[,y]      NAIP config.json (URL or absolute path)
 *   GEV_BASEMAP_NAIP_URLS=a,b          statewide NAIP tile servers
 *   GEV_BASEMAP_HIRES_URLS=a,b         regional (Wood+Upshur) tile servers
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
const BUILDINGS_ROUTE =
  /^\/basemap\/v\/([A-Za-z0-9._-]{1,64})\/buildings\/(tileset\.json|[A-Za-z0-9._-]{1,32}\/sub\/\d{1,2}\/\d{1,8}\/\d{1,8}\/tileset\.json|[A-Za-z0-9._-]{1,32}\/\d{1,2}\/\d{1,8}\/\d{1,8}\.glb)$/;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const TERRAIN_QUERY = new Set(['extensions', 'v']);
const TILE_CACHE = 'public, max-age=2592000';
const META_CACHE = 'max-age=60, must-revalidate';
const MISSING_CACHE = 'public, max-age=86400';
const PASS_HEADERS = ['content-type', 'etag', 'last-modified'];
const HEALTH_CACHE = 'max-age=30, must-revalidate';
const HEALTH_STATES = new Set(['ok', 'degraded', 'down']);
const HEALTH_CHIPS = {
  ok: 'OPEN',
  degraded: 'OPEN (degraded)',
  down: 'UNAVAILABLE',
};
export const HEALTH_BUDGET = Object.freeze({
  attemptMs: 3_000,
  composeMs: 3_500,
});
const MAX_HEALTH_WARNINGS = 5;
const MAX_HEALTH_TEXT = 200;

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
    buildingsUrls: urlList(env.GEV_BASEMAP_BUILDINGS_URLS),
    healthUrls: urlList(env.GEV_BASEMAP_HEALTH_URLS),
    naip: naipEnabled(env),
    naipConfig: String(env.GEV_BASEMAP_NAIP_CONFIG ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    naipUrls: urlList(env.GEV_BASEMAP_NAIP_URLS),
    hiresUrls: urlList(env.GEV_BASEMAP_HIRES_URLS),
    buildings: buildingsSettings(env),
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

function buildingsSettings(env) {
  const showBelowM = num(
    env.GEV_BASEMAP_BUILDINGS_BELOW_M,
    DEFAULT_BUILDINGS.showBelowM,
  );
  return {
    showBelowM,
    hideAboveM:
      showBelowM === DEFAULT_BUILDINGS.showBelowM
        ? DEFAULT_BUILDINGS.hideAboveM
        : showBelowM * 1.25,
    maximumScreenSpaceError: DEFAULT_BUILDINGS.maximumScreenSpaceError,
    cacheBytes: DEFAULT_BUILDINGS.cacheBytes,
    maximumCacheOverflowBytes: DEFAULT_BUILDINGS.maximumCacheOverflowBytes,
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

/**
 * Buildings edge /config.json (P5) -> browser buildings block. Field by
 * field: the edge's copyright markup and anything else it sends stay
 * server-side (the browser carries its own credit, credits.js).
 */
export function composeBuildings(raw, layer = buildingsSettings({})) {
  const version = raw?.version;
  const path = String(raw?.buildings?.path ?? '');
  if (
    typeof version !== 'string' ||
    !NAME.test(version) ||
    path !== `/v/${version}/buildings/tileset.json`
  )
    return { available: false };
  return {
    available: true,
    version,
    url: `/basemap/v/${version}/buildings/tileset.json`,
    minzoom: int(raw?.buildings?.minzoom, 0, 22) ?? 0,
    maxzoom: int(raw?.buildings?.maxzoom, 0, 22) ?? 0,
    bounds: bbox(raw?.buildings?.bounds),
    ...layer,
  };
}

/**
 * Secret-bearing names. Matched as a whole word, optionally with a prefix
 * (x-api-key, client_secret, refresh_token, aws_secret_access_key ...).
 */
const SECRET_KEY = String.raw`[\w-]*?(?:api[-_]?key|apikey|key|access[-_]?token|token|secret|passw\w*|passphrase|pass|pwd|auth\w*|sig|signature|cookie|credentials?|session[-_]?id)`;
/** HTTP authentication schemes (RFC 9110 11.4 plus common vendor ones). */
const AUTH_SCHEME_NAMES = [
  'Basic',
  'Bearer',
  'Digest',
  'Negotiate',
  'NTLM',
  'Token',
  'ApiKey',
  'HOBA',
  'Mutual',
  'AWS4-HMAC-SHA256',
];
const AUTH_SCHEME = `(?:${AUTH_SCHEME_NAMES.join('|')}|SCRAM-SHA-\\d+)`;
/** Scheme names are case-insensitive (RFC 9110 11.1); show the usual spelling. */
const AUTH_SCHEME_CANONICAL = new Map(
  AUTH_SCHEME_NAMES.map((name) => [name.toLowerCase(), name]),
);
function canonicalAuthScheme(scheme) {
  return (
    AUTH_SCHEME_CANONICAL.get(scheme.toLowerCase()) ?? scheme.toUpperCase()
  );
}
/**
 * Backslashes in front of a quote that are parsed exactly: 0 plain JSON,
 * 1 JSON in a JSON string, 3 and 7 the next two levels (JSON depths 1-4).
 * Any other run (15 or more, or a malformed one) is UNSUPPORTED_QUOTED.
 */
const ESCAPE_DEPTHS = [7, 3, 1, 0];
/**
 * A double-quoted string whose quotes carry `depth` backslashes. Inside, a
 * quote closes the string only when the backslash run before it decodes,
 * level by level, to that same depth: run length = depth modulo
 * 2 * (depth + 1). Shorter or longer runs are embedded (escaped) quotes or
 * escaped backslashes and stay inside the value, so a value never ends
 * early and leaves its tail behind. Unterminated runs to the end of text.
 */
function quotedAtDepth(depth) {
  const run = (n) => (n ? String.raw`\\{${n}}` : '');
  const close = String.raw`(?:${run(2 * depth + 2)})*${run(depth)}"`;
  const token = [
    String.raw`[^\\"]`,
    String.raw`\\+(?![\\"])`,
    String.raw`(?!${close})\\*"`,
    String.raw`\\+$`,
  ].join('|');
  return String.raw`${run(depth)}"(?:${token})*(?:${close}|$)`;
}
const DOUBLE_QUOTED = ESCAPE_DEPTHS.map(quotedAtDepth).join('|');
const SINGLE_QUOTED = String.raw`'(?:[^'\\]|\\.|\\$)*(?:'|$)`;
/**
 * Fail closed: a value that opens with a quote (any backslashes before it)
 * that DOUBLE_QUOTED and SINGLE_QUOTED do not take, such as JSON nested 5
 * or more levels deep, is redacted to the end of the text. Where it ends
 * cannot be told safely, so no tail of it is kept.
 */
const UNSUPPORTED_QUOTED = String.raw`\\*["'][\s\S]*`;
const QUOTED = `${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${UNSUPPORTED_QUOTED}`;
const AUTH_PARAM = String.raw`[\w-]+\s*=\s*(?:${QUOTED}|[^\s,;]+)`;
/**
 * A scheme's credentials: a token68 (Basic, Bearer) or an auth-param list
 * (Digest username="..", response=".."), every param included.
 */
const AUTH_CREDENTIALS = `(?:${AUTH_PARAM}|[^\\s,;"')\\]}]+)(?:\\s*,\\s*${AUTH_PARAM})*`;
/**
 * One secret value: a quoted string (double, single or backslash-escaped
 * JSON quotes for JSON depths 1-4, embedded escaped quotes, backslashes and
 * spaces included), an unterminated quote (to the end of the text), any
 * other quoted encoding such as deeper JSON (to the end of the text), an
 * authentication scheme with its credentials, or a bare token.
 */
const SECRET_VALUE = [
  QUOTED,
  `${AUTH_SCHEME}\\s+${AUTH_CREDENTIALS}`,
  String.raw`\S+`,
].join('|');
/**
 * key=value, key: value, "key": "value", 'key'='value', \"key\":\"value\"
 * (and deeper JSON escaping). Group 1 keeps the name and separator (quotes
 * included), the value goes.
 */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`((?:\\*["'])?\b${SECRET_KEY}\b(?:\\*["'])?\s*[=:]\s*)(?:${SECRET_VALUE})`,
  'gi',
);
/**
 * A scheme with credentials outside any key (log line "... Basic dXNl...",
 * "basic ...", "BASIC ..."): any case, as RFC 9110 11.1 makes schemes.
 */
const AUTH_SCHEME_CREDENTIALS = new RegExp(
  String.raw`\b(${AUTH_SCHEME})\s+(?!\[redacted\])${AUTH_CREDENTIALS}`,
  'gi',
);

/**
 * One health text for the browser: control characters removed, every
 * absolute URL replaced by [url], secret-named values (quoted or not, JSON
 * included), authentication schemes with their credentials and key-shaped
 * tokens redacted, at most MAX_HEALTH_TEXT characters. Redaction runs
 * before truncation, so a cut never exposes part of a secret.
 */
export function sanitizeHealthText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
    .replace(/\/\/[^\s/@]+@\S*/g, '[url]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]')
    .replace(
      AUTH_SCHEME_CREDENTIALS,
      (_, scheme) => `${canonicalAuthScheme(scheme)} [redacted]`,
    )
    .replace(/\bBearer\s+(?!\[redacted\])\S+/gi, 'Bearer [redacted]')
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, '[redacted]')
    .replace(
      /eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}(\.[0-9A-Za-z_-]*)?/g,
      '[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HEALTH_TEXT);
}

export const UNKNOWN_HEALTH_REPORT = Object.freeze({
  schema: 1,
  available: false,
  state: 'unknown',
  chip: null,
  warnings: [],
  generated: null,
});

/**
 * Edge health.json (P9 gb-refresh.py) -> browser health block. Field by
 * field: host, disk, checks, jobs, info and anything else stay server-side.
 */
export function composeHealth(raw) {
  const state = raw?.state;
  if (!HEALTH_STATES.has(state))
    return { ...UNKNOWN_HEALTH_REPORT, warnings: [] };
  const chipText = sanitizeHealthText(raw?.gev_chip);
  // ok/degraded chips are fixed strings; down may carry its explanation.
  const chip =
    state === 'down' && chipText.startsWith(HEALTH_CHIPS.down)
      ? chipText
      : HEALTH_CHIPS[state];
  const warnings = (Array.isArray(raw?.warnings) ? raw.warnings : [])
    .map(sanitizeHealthText)
    .filter(Boolean)
    .slice(0, MAX_HEALTH_WARNINGS);
  const generated =
    typeof raw?.generated === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(raw.generated)
      ? raw.generated
      : null;
  return { schema: 1, available: true, state, chip, warnings, generated };
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

  const buildingsUrls = settings.buildingsUrls ?? [];
  const healthUrls = settings.healthUrls ?? [];
  let healthCached = null;
  let healthPending = null;

  /**
   * Health: each URL is a full health.json URL (S4 local, S5, S1), tried in
   * order inside HEALTH_BUDGET. Never throws; any failure is "unknown".
   */
  async function composeHealthReport() {
    if (!healthUrls.length) return { ...UNKNOWN_HEALTH_REPORT, warnings: [] };
    const deadline = AbortSignal.timeout(HEALTH_BUDGET.composeMs);
    try {
      return await upstream(healthUrls, '', {
        timeoutMs: Math.min(settings.timeoutMs, HEALTH_BUDGET.attemptMs),
        deadline,
        read: async (response) => {
          const health = composeHealth(await readJson(response));
          if (!health.available) throw new Error('invalid health report');
          return health;
        },
      });
    } catch (error) {
      log('[basemap] health unavailable:', error?.message || error);
      return { ...UNKNOWN_HEALTH_REPORT, warnings: [] };
    }
  }

  /** Cached 30 s when known, 10 s when not; concurrent misses share one fetch. */
  async function health() {
    if (healthCached && now() < healthCached.until) return healthCached.value;
    healthPending ??= composeHealthReport()
      .then((value) => {
        healthCached = {
          value,
          until: now() + (value.available ? 30_000 : 10_000),
        };
        return value;
      })
      .finally(() => {
        healthPending = null;
      });
    return healthPending;
  }

  async function buildingsConfig(deadline) {
    if (!buildingsUrls.length) return { available: false };
    try {
      return await upstream(buildingsUrls, '/config.json', {
        timeoutMs: configAttemptMs,
        deadline,
        read: async (response) => {
          const buildings = composeBuildings(
            await readJson(response),
            settings.buildings,
          );
          if (!buildings.available) throw new Error('invalid buildings config');
          return buildings;
        },
      });
    } catch (error) {
      log('[basemap] buildings config unavailable:', error?.message || error);
      return { available: false };
    }
  }

  const naipOn = settings.naip === true;
  const naipUrls = settings.naipUrls ?? [];
  const hiresUrls = settings.hiresUrls ?? [];
  /** Routes of the config the browser was last given (naipProxy.js). */
  let naipRoutes = null;

  /**
   * NAIP config.json (N1 schema) -> {browser, routes}. Sources are tried in
   * order like the imagery publish config; any failure is "unavailable"
   * and never touches the rest of the stack.
   */
  async function naipConfig(deadline) {
    const none = { browser: { available: false }, routes: null };
    if (!naipUrls.length && !hiresUrls.length) return none;
    for (const source of settings.naipConfig ?? []) {
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
        const naip = composeNaip(raw, {
          statewide: naipUrls.length > 0,
          regional: hiresUrls.length > 0,
        });
        if (naip.browser.available) return naip;
        throw new Error('invalid naip config');
      } catch (error) {
        log('[basemap] naip config unavailable:', error?.message || error);
      }
    }
    return none;
  }

  async function compose() {
    const deadline = AbortSignal.timeout(budgetMs);
    const [terrain, imagery, buildings, naip] = await Promise.all([
      terrainConfig(deadline),
      imageryConfig(deadline),
      buildingsConfig(deadline),
      naipOn ? naipConfig(deadline) : null,
    ]);
    const value = {
      schema: 1,
      generated: new Date(now()).toISOString(),
      terrain,
      imagery,
      buildings,
      switch: { ...settings.switch },
    };
    // Flag off: no naip key at all (the P3 config, byte for byte).
    if (naip) {
      value.naip = naip.browser;
      naipRoutes = naip.routes;
    }
    return value;
  }

  /** Cached 60 s when complete, 10 s when not; concurrent cold misses share one compose. */
  async function config() {
    if (cached && now() < cached.until) return cached.value;
    pending ??= compose()
      .then((value) => {
        const ok =
          value.terrain.available &&
          value.imagery.available &&
          (value.buildings.available || !buildingsUrls.length) &&
          (!naipOn || value.naip?.available === true);
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
      if (url.pathname === '/basemap/health.json') {
        const body = JSON.stringify(await health());
        send(
          res,
          200,
          {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': HEALTH_CACHE,
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
      if (naipOn && url.pathname.startsWith('/basemap/naip/')) {
        // The composed (cached) config says which years and ids exist.
        await config();
        const tile = resolveNaipTile(url.pathname, naipRoutes, {
          naipUrls,
          hiresUrls,
        });
        if (tile) {
          await relay(req, res, tile.bases, tile.path, { kind: 'naip' });
          return;
        }
      }
      const buildings = BUILDINGS_ROUTE.exec(url.pathname);
      if (buildings) {
        await relay(
          req,
          res,
          buildingsUrls,
          `/v/${buildings[1]}/buildings/${buildings[2]}`,
          { kind: 'buildings', meta: buildings[2] === 'tileset.json' },
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
