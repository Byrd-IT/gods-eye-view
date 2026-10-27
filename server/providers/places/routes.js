import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { haversineKm } from '../common/geo.js';
import { readResponseTextCapped } from '../common/http.js';
import { normalizeOsrmSteps } from '../../../src/data/routeSteps.js';
import {
  normalizeRouteProfile,
  projectRouteResult,
} from '../../../src/data/placeProviderPayloads.js';

/**
 * OSM routing (FOSSGIS OSRM) cache: profile|coords ->
 * { payload, hasSteps, cachedAt }. `hasSteps` records whether the upstream
 * call behind this entry asked for maneuvers, because an entry without them
 * cannot answer a request that wants them.
 */
const ROUTE_CACHE_MS = 600000;

/**
 * Upstream calls currently in flight, keyed by endpoint + route + step shape.
 * Two identical requests that arrive before the first one answers (three rapid
 * reroutes of the same A→B, a second browser tab) await the SAME upstream
 * fetch. The FOSSGIS servers ask for no heavy use; the cheapest way to honour
 * that is not to make the call twice. Module-level, because what it is
 * deduplicating is this process's outbound traffic — the endpoint is part of
 * the key, so two installations pointed at different services never share one.
 * @type {Map<string, Promise<{payload: object|null, error: string|null}>>}
 */
const _routeInflight = new Map();

/** Hard cap on the OSRM route response we will buffer. */
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Minimum gap between two OUTBOUND route requests, across every client and
 * every profile. The FOSSGIS servers publish "one request per second max", and
 * the per-client rate limiter below cannot honour that on its own: two
 * different clients, or one client switching DRIVE to WALK, are two different
 * cache keys and left 48 ms apart upstream. This is the gate that makes the
 * app's outbound rate what the policy says it may be.
 */
export const ROUTE_UPSTREAM_MIN_INTERVAL_MS = 1000;

/**
 * How many requests may be waiting for that gate at once. Past this the answer
 * is an honest 429 rather than a queue that grows until everything times out.
 */
export const ROUTE_UPSTREAM_QUEUE_MAX = 8;

/** The interval actually in force; only a test ever shortens it. */
let _upstreamIntervalMs = ROUTE_UPSTREAM_MIN_INTERVAL_MS;

/** Earliest wall-clock time the next outbound request may leave. */
let _nextUpstreamAt = 0;
/** Requests currently holding or waiting for the outbound slot. */
let _upstreamQueueDepth = 0;

/** Thrown when the outbound queue is full; answered as a 429. */
class RouteBusyError extends Error {
  constructor(retryAfterMs) {
    super('routing busy');
    this.name = 'RouteBusyError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when the routing service itself rate-limited us. */
class UpstreamRateLimitError extends Error {
  constructor(retryAfterSec) {
    super('routing service is rate limited');
    this.name = 'UpstreamRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Run one outbound request no sooner than the shared gate allows.
 * @template T
 * @param {() => Promise<T>} run The request.
 * @returns {Promise<T>}
 */
async function throughUpstreamGate(run) {
  if (_upstreamQueueDepth >= ROUTE_UPSTREAM_QUEUE_MAX) {
    throw new RouteBusyError(
      Math.max(0, _nextUpstreamAt - Date.now()) + _upstreamIntervalMs,
    );
  }
  _upstreamQueueDepth += 1;
  try {
    const now = Date.now();
    const slot = Math.max(now, _nextUpstreamAt);
    _nextUpstreamAt = slot + _upstreamIntervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return await run();
  } finally {
    _upstreamQueueDepth -= 1;
  }
}

/** Reject routes whose straight-line spans are obviously abusive (km). */
const ROUTE_MAX_LEG_KM = 600;

const ROUTE_MAX_TOTAL_KM = 2500;

const _routeRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 60,
  globalMax: 200,
});

/** Test seam: forget the outbound state this module keeps between requests. */
export function _resetRouteUpstreamForTest() {
  _routeInflight.clear();
  _nextUpstreamAt = 0;
  _upstreamQueueDepth = 0;
  _upstreamIntervalMs = ROUTE_UPSTREAM_MIN_INTERVAL_MS;
}

/**
 * Test seam: shorten the outbound gate so a queue-overflow test does not have
 * to wait out the real one-per-second policy. The policy value itself is
 * asserted separately.
 * @param {number} ms
 */
export function _setRouteUpstreamIntervalForTest(ms) {
  _upstreamIntervalMs =
    Number.isFinite(ms) && ms >= 0 ? ms : ROUTE_UPSTREAM_MIN_INTERVAL_MS;
}

/** Test seam: how many upstream calls are coalescing right now. */
export function _routeInflightCountForTest() {
  return _routeInflight.size;
}

/**
 * Log-safe upstream body snippet (b12, STANDARD R3). In order:
 * 1. the request's own secrets/inputs (`secrets`) are masked literally, in
 *    raw, JSON-escaped and URL-encoded form, wherever the upstream echoed them;
 * 2. markup is stripped, `\/` is unescaped, and URL userinfo, Bearer/Basic
 *    credentials, JSON / query / header style secret fields (key, token,
 *    secret, password, auth, credential, sig, session, cookie ...) in plain or
 *    escaped JSON, and well-known key shapes (sk-, AIza, ghp_, xox?-, JWT) are
 *    masked;
 * 3. whitespace is collapsed and the result is cut to at most `maxBytes`
 *    UTF-8 bytes without splitting a code point.
 * The same text is copied into every b12 provider file (there is no shared
 * runtime module); src/byrdit/providerErrorLogging.test.mjs checks that the
 * copies stay identical and attacks each one.
 */
function redactSnippet(text, secrets = [], maxBytes = 300) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    const raw = String(secret ?? '');
    if (raw.length < 4) continue;
    const forms = new Set([raw, JSON.stringify(raw).slice(1, -1)]);
    try {
      forms.add(encodeURIComponent(raw));
    } catch {
      /* lone surrogate: raw + JSON forms only */
    }
    for (const form of forms) s = s.split(form).join('REDACTED');
  }
  s = s
    .slice(0, 65536)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\+\//g, '/')
    .replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#@"'<>]*@/gi, '$1REDACTED@')
    .replace(/\b(Bearer|Basic|Token)\s+[^\s"'\\,;]+/gi, '$1 REDACTED')
    .replace(
      /((?:\\*["'])?(?<![\w.-])[\w.-]{0,40}(?:key|token|secret|passw(?:or)?d|pwd|pass|auth|credential|signature|sig|session|cookie)[\w.-]{0,40}(?:\\*["'])?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"?|\\+"[\s\S]*?(?:\\+"(?=\s*[,}\]])|$)|'[^']*'?|[^\s,&;}\]"'<>]+)/gi,
      '$1REDACTED',
    )
    .replace(
      /\b(?:sk-[\w*.-]{4,}|AIza[\w-]{10,}|gh[pousr]_\w{10,}|xox[abprs]-[\w-]{10,}|eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*)/g,
      'REDACTED',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const size = encoder.encode(ch).length;
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/** Cause class of a thrown error: never its message. */
function failureClass(error) {
  // String codes only: DOMException carries a numeric legacy `code`.
  const code =
    [error?.cause?.code, error?.code].find((c) => typeof c === 'string') || '';
  // The only abort on this path is fetchRoute's 12 s timer.
  if (
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  )
    return `timeout${code ? ` code=${code}` : ''}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns code=${code}`;
  if (code === 'RESPONSE_TOO_LARGE') return 'too_large';
  if (error instanceof SyntaxError) return 'malformed';
  if (code) return `network code=${code}`;
  return error?.name || 'error';
}

/**
 * Routing target for a log line: endpoint origin/path and profile, with the
 * coordinates (a user's start/end points) reduced to a count and no userinfo.
 */
function routeTargetForLog(base, osrmProfile, coords) {
  let shown = '(invalid endpoint)';
  try {
    const url = new URL(base);
    shown = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    /* keep the placeholder */
  }
  return `GET ${shown}/route/v1/${osrmProfile}/<${String(coords).split(';').length} coords>`;
}

/** Read at most ~4 KiB of a body we are about to discard, for the log. */
async function peekAndCancel(response) {
  try {
    const reader = response.body?.getReader?.();
    if (!reader) return await response.text();
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text;
  } catch {
    return '';
  }
}

/**
 * Fetch one route from the routing service and project it.
 * @param {object} request
 * @param {string} request.profile foot | car | bike
 * @param {string} request.osrmProfile Upstream profile name.
 * @param {string} request.base Endpoint base for this profile.
 * @param {string} request.coords `lon,lat;lon,lat[;...]`
 * @param {boolean} request.withSteps Ask upstream for maneuvers.
 * @param {Function} request.fetchImpl Injected request function.
 * @returns {Promise<{payload: object|null, error: string|null}>}
 */
async function fetchRoute({
  profile,
  osrmProfile,
  base,
  coords,
  withSteps,
  fetchImpl,
}) {
  // `steps` is opt-in per request. Asking for maneuvers on every call made the
  // response several times larger for the callers that never read them (the
  // voice route annotation, fly_route), on someone else's bandwidth.
  const upstream =
    `${base.replace(/\/$/, '')}/route/v1/${osrmProfile}/${coords}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=${withSteps ? 'true' : 'false'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const target = routeTargetForLog(base, osrmProfile, coords);
  let startedAt = 0;
  let upstreamStatus = 0;
  const elapsed = () =>
    startedAt ? Math.round(performance.now() - startedAt) : 0;
  // The request's own coordinates (a user's start/end points) and any
  // endpoint userinfo are masked if the upstream echoes them in a body.
  const secrets = String(coords).split(/[;,]/);
  try {
    const url = new URL(base);
    secrets.push(
      decodeURIComponent(url.username),
      decodeURIComponent(url.password),
    );
  } catch {
    /* invalid endpoint: nothing to add */
  }
  const snippet = (body) => JSON.stringify(redactSnippet(body, secrets));
  const logRefusal = (reason, body) =>
    console.warn(
      `[Route Proxy] upstream ${reason} target="${target}" status=${upstreamStatus} ` +
        `elapsed_ms=${elapsed()} body=${snippet(body)}`,
    );
  let osrm;
  let text = null;
  try {
    const upstreamRes = await throughUpstreamGate(() => {
      startedAt = performance.now();
      return fetchImpl(upstream, {
        signal: controller.signal,
        // The endpoint is configured above; a redirect is the one way out of
        // it, so it is refused rather than followed.
        redirect: 'error',
        headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
      });
    });
    upstreamStatus = upstreamRes.status;
    if (upstreamRes.status === 429) {
      logRefusal('rate limited', await peekAndCancel(upstreamRes));
      const retryAfter = Number(upstreamRes.headers.get('retry-after'));
      throw new UpstreamRateLimitError(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
      );
    }
    if (!upstreamRes.ok) {
      logRefusal('non-OK', await peekAndCancel(upstreamRes));
      return { payload: null, error: 'no route found' };
    }
    const ctype = upstreamRes.headers.get('content-type') || '';
    if (!ctype.includes('json')) {
      logRefusal(
        `non-JSON content-type=${JSON.stringify(ctype.slice(0, 80))}`,
        await peekAndCancel(upstreamRes),
      );
      return { payload: null, error: 'no route found' };
    }
    text = await readResponseTextCapped(upstreamRes, ROUTE_MAX_RESPONSE_BYTES);
    osrm = JSON.parse(text);
  } catch (error) {
    // Local refusals (queue full) and the 429 above are not upstream faults
    // and are reported by the middleware / logRefusal already.
    if (
      !(error instanceof RouteBusyError) &&
      !(error instanceof UpstreamRateLimitError)
    )
      console.warn(
        `[Route Proxy] upstream request failed target="${target}" class=${failureClass(error)} ` +
          `status=${upstreamStatus || 'none'} elapsed_ms=${elapsed()} timeout_ms=12000` +
          // A body that was read but did not parse is the evidence.
          (text !== null ? ` body=${snippet(text)}` : ''),
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const route = osrm?.routes?.[0];
  if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length)
    return { payload: null, error: 'no route found' };
  const payload = projectRouteResult(route, profile);
  if (withSteps) {
    const { steps, truncated } = normalizeOsrmSteps(route);
    payload.steps = steps;
    if (truncated) payload.stepsTruncated = true;
  }
  return { payload, error: null };
}

export function installRouteMiddleware(
  middlewares,
  { endpoints = {}, fetchImpl = (...args) => fetch(...args) } = {},
) {
  const _routeCache = new Map();

  // Real OSM routing via the public FOSSGIS OSRM servers (foot/car/bike).
  // GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...][&steps=1]
  // `steps=1` adds turn-by-turn maneuvers (src/data/routeSteps.js) and is the
  // only shape that asks the upstream for them. A response WITHOUT steps is
  // byte for byte what this endpoint has always returned.
  middlewares.use('/api/route', async (req, res) => {
    const fail = (msg) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    };
    const rateLimited = (msg, retryAfterSec) => {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, Math.round(retryAfterSec || 5))),
      });
      res.end(JSON.stringify({ ok: false, error: msg }));
    };
    try {
      if (!_routeRateLimiter(clientKey(req))) {
        rateLimited('rate limited', 5);
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const raw = (url.searchParams.get('profile') || 'foot').toLowerCase();
      const profile = normalizeRouteProfile(raw);
      if (!profile) return fail('invalid profile');
      const osrmProfile = profile === 'car' ? 'driving' : profile;
      const pairs = (url.searchParams.get('coords') || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      if (pairs.length < 2 || pairs.length > 12)
        return fail('need 2-12 coordinates');
      const clean = [];
      const pts = [];
      for (const pr of pairs) {
        const parts = pr.split(',');
        if (parts.length !== 2) return fail('invalid coordinate');
        const lon = Number(parts[0]);
        const lat = Number(parts[1]);
        if (
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        ) {
          return fail('invalid coordinate');
        }
        clean.push(`${lon},${lat}`);
        pts.push([lon, lat]);
      }
      // Reject obviously-abusive spans — a real walking/driving route is local,
      // so a cross-continent request is either a bug or an attempt to drive
      // heavy upstream OSRM work.
      let totalKm = 0;
      for (let i = 1; i < pts.length; i += 1) {
        // pts are [lon, lat]; existing haversineKm takes (lat1, lon1, lat2, lon2).
        const legKm = haversineKm(
          pts[i - 1][1],
          pts[i - 1][0],
          pts[i][1],
          pts[i][0],
        );
        if (legKm > ROUTE_MAX_LEG_KM) return fail('route leg too long');
        totalKm += legKm;
      }
      if (totalKm > ROUTE_MAX_TOTAL_KM) return fail('route too long');
      const coords = clean.join(';');
      const cacheKey = `${profile}|${coords}`;
      const base =
        endpoints[profile] ||
        `https://routing.openstreetmap.de/routed-${profile}`;
      const now = Date.now();
      const wantSteps = url.searchParams.get('steps') === '1';
      // A caller that did not ask for maneuvers never sees them, even when the
      // cached entry carries them for someone else.
      const shapePayload = (payload) =>
        wantSteps ? payload : { ...payload, steps: undefined };
      const cached = _routeCache.get(cacheKey);
      if (
        cached &&
        now - cached.cachedAt <= ROUTE_CACHE_MS &&
        (!wantSteps || cached.hasSteps)
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(shapePayload(cached.payload)));
        return;
      }
      const inflightKey = `${base}|${cacheKey}|${wantSteps ? 's' : 'n'}`;
      // A stepless request can also ride a stepful call already in flight —
      // it just drops the maneuvers on the way out.
      let pending =
        _routeInflight.get(inflightKey) ||
        (wantSteps ? null : _routeInflight.get(`${base}|${cacheKey}|s`));
      if (!pending) {
        pending = fetchRoute({
          profile,
          osrmProfile,
          base,
          coords,
          withSteps: wantSteps,
          fetchImpl,
        });
        _routeInflight.set(inflightKey, pending);
        const settle = () => {
          if (_routeInflight.get(inflightKey) === pending)
            _routeInflight.delete(inflightKey);
        };
        pending.then(settle, settle);
      }
      let payload;
      let error;
      try {
        ({ payload, error } = await pending);
      } catch (upstreamError) {
        if (upstreamError instanceof RouteBusyError) {
          return rateLimited(
            'routing busy — too many routes at once',
            Math.ceil(upstreamError.retryAfterMs / 1000),
          );
        }
        if (upstreamError instanceof UpstreamRateLimitError) {
          // Reporting this as "no route found" would blame the map for
          // something the routing service said about us.
          return rateLimited(
            'routing service is rate limited',
            upstreamError.retryAfterSec,
          );
        }
        throw upstreamError;
      }
      if (error || !payload) return fail(error || 'no route found');
      _routeCache.set(cacheKey, {
        payload,
        hasSteps: Array.isArray(payload.steps),
        cachedAt: Date.now(),
      });
      if (_routeCache.size > 200)
        _routeCache.delete(_routeCache.keys().next().value);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(shapePayload(payload)));
    } catch (e) {
      // The upstream cause (class/status/elapsed/body) was logged in
      // fetchRoute; this line names the client-facing outcome.
      const code = [e?.cause?.code, e?.code].find((c) => typeof c === 'string');
      console.error(
        `[Route Proxy] request failed class=${e?.name || 'error'}${code ? ` code=${code}` : ''} ` +
          `response="route proxy error"`,
      );
      fail('route proxy error');
    }
  });
}
