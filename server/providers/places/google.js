import {
  googleServerApiKey,
  keylessGooglePlacesResponse,
} from './google-key.js';
import { makeCostRateLimiter, clientKey } from '../common/rate-limit.js';
import { admitSameSite } from '../common/same-site.js';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../../../src/data/placeProviderPayloads.js';

// Construct lazily after the standalone environment has loaded.
// undefined = not built yet; null = the explicit 0 opt-out; fn = active limiter
let _googleRateLimiter;

/**
 * Requests/min/IP applied when GEV_RATELIMIT_GOOGLE_PER_MIN is unset. This is
 * the value the Pinokio build already ships (pinokio/_ENVIRONMENT), so the
 * packaged app keeps behaving exactly as it does today and only an
 * unconfigured server changes — from unlimited to what the product already
 * runs with. Places calls are user-driven (a search, a nearby lookup, an
 * installation probe) rather than polled, so this sits far above what the app
 * generates and bites only a caller enumerating the endpoint. `.env.example`
 * suggests a tighter 60 when the host is not localhost; that still applies.
 */
export const GOOGLE_DEFAULT_PER_MIN = 120;

/** Google cost endpoints (nearby-places + text-search). Null only when set to 0. */
function googleRateLimiter() {
  if (_googleRateLimiter === undefined)
    _googleRateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
      GOOGLE_DEFAULT_PER_MIN,
    );
  return _googleRateLimiter;
}

/**
 * Default upstream backstop for one Google Places call (ms); bounds headers
 * and body. The baseline had no timeout at all. 60 s is the longest explicit
 * per-request deadline an in-app caller puts on a Places request: browser
 * search/geospatial gives up after 5 s (src/search/geospatial.js), MCP
 * globe-panel requests of any app route after 60 s
 * (src/tools/queries/panelRequest.js REQUEST_TIMEOUT_MS). The installations
 * layer has no deadline and other MCP tool calls only the 120 s hung-server
 * backstop; for them an answer slower than 60 s is cut off (no telemetry
 * shows Places that slow). Override with GEV_GOOGLE_PLACES_TIMEOUT_MS
 * (1000-600000).
 */
export const GOOGLE_PLACES_TIMEOUT_MS = 60_000;

/** Effective Places timeout: GEV_GOOGLE_PLACES_TIMEOUT_MS when valid, else the default. */
export function googlePlacesTimeoutMs(env = process.env) {
  const ms = Number(env?.GEV_GOOGLE_PLACES_TIMEOUT_MS);
  return Number.isInteger(ms) && ms >= 1000 && ms <= 600_000
    ? ms
    : GOOGLE_PLACES_TIMEOUT_MS;
}

/** Errors postPlaces already logged (the route catch must not log them twice). */
const loggedPlacesFailures = new WeakSet();

/**
 * URL for a log line. The key travels in X-Goog-Api-Key, but an override
 * endpoint could still carry `?key=`: drop userinfo, mask secret-looking
 * query values.
 */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()])
      if (/key|token|secret|pass|auth|sig/i.test(name))
        url.searchParams.set(name, 'REDACTED');
    return url.href;
  } catch {
    return '(unparseable url)';
  }
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
  if (
    error?.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  )
    return `timeout${code ? ` code=${code}` : ''}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns code=${code}`;
  if (code) return `network code=${code}`;
  return error?.name || 'error';
}

/**
 * POST one Places request with a timeout. Returns { response, data } where
 * data is exactly what the old `response.json().catch(() => ({}))` gave the
 * caller: the parsed JSON value as-is (null, a number, an object ...), or {}
 * when the body could not be read or parsed. Every failure logs one line:
 * route, redacted URL, status or cause class, elapsed and a redacted
 * <=300-byte body snippet (the key and the request's own query text and
 * coordinates masked). A thrown call is re-thrown unchanged so the caller's
 * 502 contract stays as it was.
 */
async function postPlaces(fetchImpl, route, url, init, secrets = []) {
  const startedAt = performance.now();
  const timeoutMs = googlePlacesTimeoutMs();
  const target = `POST ${redactUrl(url)}`;
  const elapsed = () => Math.round(performance.now() - startedAt);
  let status = 0;
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    let raw = '';
    try {
      raw = await response.text();
    } catch (error) {
      console.warn(
        `[Google Places] ${route} upstream body read failed target="${target}" ` +
          `class=${failureClass(error)} status=${response.status} elapsed_ms=${elapsed()} ` +
          `timeout_ms=${timeoutMs}`,
      );
      return { response, data: {} };
    }
    const snippet = () => JSON.stringify(redactSnippet(raw, secrets));
    if (!response.ok)
      console.warn(
        `[Google Places] ${route} upstream HTTP ${response.status} target="${target}" ` +
          `status=${response.status} elapsed_ms=${elapsed()} body=${snippet()}`,
      );
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      if (response.ok)
        console.warn(
          `[Google Places] ${route} upstream body malformed target="${target}" ` +
            `class=malformed status=${response.status} elapsed_ms=${elapsed()} body=${snippet()}`,
        );
      return { response, data: {} };
    }
    if (response.ok && (data === null || typeof data !== 'object'))
      console.warn(
        `[Google Places] ${route} upstream reply is not a JSON object target="${target}" ` +
          `json_type=${data === null ? 'null' : typeof data} status=${response.status} ` +
          `elapsed_ms=${elapsed()} body=${snippet()}`,
      );
    return { response, data };
  } catch (error) {
    console.warn(
      `[Google Places] ${route} request failed target="${target}" class=${failureClass(error)} ` +
        `status=${status || 'none'} elapsed_ms=${elapsed()} timeout_ms=${timeoutMs}`,
    );
    if (error && typeof error === 'object') loggedPlacesFailures.add(error);
    throw error;
  }
}

/** Log a route-side failure (e.g. a null reply the projection cannot read) once. */
function logPlacesRouteFailure(route, error) {
  if (error && typeof error === 'object' && loggedPlacesFailures.has(error))
    return;
  console.warn(
    `[Google Places] ${route} reply processing failed class=${failureClass(error)} ` +
      `response=502`,
  );
}

/** Validate raw lat/lon presence and WGS84 bounds before consuming request quota. */
export function validatePlacesCoordinates(searchParams) {
  const rawLat = searchParams.get('lat');
  const rawLon = searchParams.get('lon');
  if (rawLat === null || rawLon === null || !rawLat.trim() || !rawLon.trim()) {
    return { ok: false, error: 'lat and lon are required' };
  }
  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid lat and lon are required' };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return {
      ok: false,
      error: 'lat must be within [-90, 90] and lon within [-180, 180]',
    };
  }
  return { ok: true, latitude, longitude };
}

/** Nearby place labels and view-biased text search, with request-time key resolution. */
export function googlePlacesContextProxy({
  resolveApiKey = googleServerApiKey,
  fetchImpl = (...args) => fetch(...args),
  endpoints = {},
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/google/nearby-places', async (req, res) => {
      // Gate first, like the OpenAI routes: a cross-site caller learns nothing
      // about this endpoint's method surface.
      if (admitSameSite(req, res)) return;
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). On by default; 0 disables.
      // Inlined (not the shared helper) so the 429 body keeps this endpoint's
      // `places: []` contract that the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        25,
        Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250),
      );

      try {
        const { response, data } = await postPlaces(
          fetchImpl,
          'nearby-places',
          endpoints.nearby ||
            'https://places.googleapis.com/v1/places:searchNearby',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.displayName',
                'places.formattedAddress',
                'places.shortFormattedAddress',
                'places.location',
                'places.primaryType',
                'places.primaryTypeDisplayName',
                'places.types',
              ].join(','),
            },
            body: JSON.stringify({
              maxResultCount: 20,
              rankPreference: 'DISTANCE',
              locationRestriction: {
                circle: {
                  center: { latitude, longitude },
                  radius: radiusM,
                },
              },
            }),
          },
          [apiKey, String(latitude), String(longitude)],
        );
        const places = projectNearbyPlaces(data, latitude, longitude);

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(
          JSON.stringify({
            places,
            error: response.ok
              ? null
              : data.error?.message || 'Google Places request failed',
          }),
        );
      } catch (error) {
        logPlacesRouteFailure('nearby-places', error);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: error?.message || 'Google Places request failed',
            places: [],
          }),
        );
      }
    });

    // Text Search: resolve a named landmark/POI to a real coordinate, biased to
    // the view. Geocoding scatters obscure monument/POI names across the city;
    // a view-biased Text Search lands on the actual feature. Same key, field
    // mask, throttle, and `places: []` error contract as nearby-places above.
    middlewares.use('/api/google/text-search', async (req, res) => {
      // Paid like nearby-places, so gated the same way, first.
      if (admitSameSite(req, res)) return;
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      if (!textQuery) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'q, lat and lon are required', places: [] }),
        );
        return;
      }
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). On by default; 0 disables.
      // Inlined (like nearby-places) so the 429 body keeps the `places: []`
      // contract the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        50,
        Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000),
      );

      try {
        const { response, data } = await postPlaces(
          fetchImpl,
          'text-search',
          endpoints.textSearch ||
            'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.displayName',
                'places.formattedAddress',
                'places.location',
                'places.viewport',
                'places.primaryType',
                'places.types',
              ].join(','),
            },
            body: JSON.stringify({
              textQuery,
              locationBias: {
                circle: {
                  center: { latitude, longitude },
                  radius: radiusM,
                },
              },
              maxResultCount: 5,
            }),
          },
          [apiKey, textQuery, String(latitude), String(longitude)],
        );
        const places = projectTextSearchPlaces(data, latitude, longitude);

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(
          JSON.stringify({
            places,
            error: response.ok
              ? null
              : data.error?.message || 'Google Places request failed',
          }),
        );
      } catch (error) {
        logPlacesRouteFailure('text-search', error);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: error?.message || 'Google Places request failed',
            places: [],
          }),
        );
      }
    });
  }

  return {
    name: 'google-places-context-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
