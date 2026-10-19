import { normalizeAdsbLolPointResponse } from '../../../src/data/adsbLolFallback.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { requiredFiniteQueryNumber } from '../common/query.js';

// --- Byrd-IT p16: upstream failure log helpers (STANDARD R3, KB SeY7S6EBs9sMHq_KSKLr).
// The same block is copied into every p16 provider file (there is no shared
// runtime module, as in b12); src/byrdit/providerErrorLoggingP16.test.mjs
// checks that the copies stay identical and that redactSnippet equals the b12
// copy. Every helper is log-only and never throws.

/** Longest wait for a failing body's first bytes (ms). */
const P16_BODY_PEEK_MS = 1000;
/** Characters of a failing body read for the log; the rest is cancelled. */
const P16_BODY_PEEK_CHARS = 4096;

/**
 * Read at most P16_BODY_PEEK_CHARS of a failing response body within `ms`,
 * then cancel the body. A stalled body never holds the caller past `ms`.
 * Never throws; returns '' when there is no readable body.
 */
async function p16PeekBody(response, ms = P16_BODY_PEEK_MS) {
  let reader;
  try {
    reader = response?.body?.getReader?.();
  } catch {
    return '[body locked]';
  }
  if (!reader) return '';
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: true, timedOut: true }), ms);
    timer.unref?.();
  });
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < P16_BODY_PEEK_CHARS) {
      const { done, value, timedOut } = await Promise.race([
        reader.read(),
        deadline,
      ]);
      if (timedOut) {
        text += text
          ? ' [body read cut at peek deadline]'
          : '[no body bytes before peek deadline]';
        break;
      }
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    /* body errored: log what we have */
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* a pending read keeps the lock; the cancel above settles it */
    }
  }
  return text;
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

/**
 * Thrown-error classes, as fixed constants (b12 HUD tables). The error's
 * `cause.code`/`code`/`name` are only looked up here, never printed: anything
 * outside these tables is logged as `code=OTHER` / `error`.
 */
const P16_TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);
const P16_DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const P16_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EPROTO',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
  'UND_ERR_ABORTED',
  'UND_ERR_INFO',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const P16_LOCAL_CODES = new Set(['RESPONSE_TOO_LARGE', 'BODY_TOO_LARGE']);
const P16_ERROR_NAMES = new Set([
  'AbortError',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Error',
]);

/** Cause class of a thrown error: constants only, never its message, code or name. */
function p16FailureClass(error) {
  try {
    // String codes only: DOMException carries a numeric legacy `code`.
    const rawCode =
      [error?.cause?.code, error?.code].find((c) => typeof c === 'string') ||
      '';
    const name = typeof error?.name === 'string' ? error.name : '';
    if (name === 'TimeoutError' || P16_TIMEOUT_CODES.has(rawCode))
      return `timeout${P16_TIMEOUT_CODES.has(rawCode) ? ` code=${rawCode}` : ''}`;
    if (P16_DNS_CODES.has(rawCode)) return `dns code=${rawCode}`;
    if (P16_NETWORK_CODES.has(rawCode)) return `network code=${rawCode}`;
    if (P16_LOCAL_CODES.has(rawCode)) return `local code=${rawCode}`;
    if (error instanceof SyntaxError) return 'malformed';
    if (rawCode) return 'error code=OTHER';
    return P16_ERROR_NAMES.has(name) ? name : 'error';
  } catch {
    return 'error';
  }
}

/**
 * `METHOD origin/path` of an upstream URL for a log line: no userinfo, no
 * query, no fragment, and the request's own secrets masked in the path.
 */
function p16Target(method, url, secrets = []) {
  try {
    const parsed = new URL(String(url));
    return `${method} ${redactSnippet(`${parsed.origin}${parsed.pathname}`, secrets, 300)}`;
  } catch {
    return `${method} [unparsable url]`;
  }
}

/**
 * Credential-like parts of a URL (userinfo, query values), so an upstream
 * that echoes them back is masked too. Never throws.
 */
function p16UrlSecrets(url) {
  try {
    const parsed = new URL(String(url));
    return [
      decodeURIComponent(parsed.username),
      decodeURIComponent(parsed.password),
      ...parsed.searchParams.values(),
    ].filter((value) => value.length >= 4);
  } catch {
    return [];
  }
}

/** Whole milliseconds since `startedAt` (a performance.now() value). */
function p16Elapsed(startedAt) {
  const ms = performance.now() - Number(startedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : -1;
}

/**
 * key=value fields for an upstream HTTP failure: target, status, elapsed and
 * a redacted body[:300]. `text` is the already-read body; without it the body
 * is peeked (bounded) and cancelled. Never throws.
 */
async function p16HttpFailure({
  method = 'GET',
  url,
  response,
  startedAt,
  secrets = [],
  text,
  withTarget = true,
}) {
  try {
    const status = Number(response?.status);
    const raw = text === undefined ? await p16PeekBody(response) : text;
    const all = [...secrets, ...p16UrlSecrets(url)];
    return (
      (withTarget
        ? `target=${JSON.stringify(p16Target(method, url, all))} `
        : '') +
      `status=${Number.isInteger(status) ? status : 'none'}` +
      ` elapsed_ms=${p16Elapsed(startedAt)}` +
      ` body=${JSON.stringify(redactSnippet(raw, all))}`
    );
  } catch {
    return 'detail=unavailable';
  }
}

/** key=value fields for a thrown upstream failure (no message). Never throws. */
function p16ThrownFailure({
  method = 'GET',
  url,
  error,
  startedAt,
  timeoutMs,
  secrets = [],
  stage,
  withTarget = true,
}) {
  try {
    const all = [...secrets, ...p16UrlSecrets(url)];
    return (
      (withTarget
        ? `target=${JSON.stringify(p16Target(method, url, all))} `
        : '') +
      (stage === 'body' || stage === 'headers' ? `stage=${stage} ` : '') +
      `class=${p16FailureClass(error)}` +
      ` elapsed_ms=${p16Elapsed(startedAt)}` +
      (Number.isFinite(timeoutMs) ? ` timeout_ms=${timeoutMs}` : '')
    );
  } catch {
    return 'detail=unavailable';
  }
}

/** Attach log fields to an error without changing it otherwise. Never throws. */
function p16Annotate(error, fields) {
  try {
    if (error && typeof error === 'object' && !error.p16Log)
      Object.defineProperty(error, 'p16Log', {
        value: fields,
        enumerable: false,
        configurable: true,
      });
  } catch {
    /* frozen error: the log falls back to its old text */
  }
  return error;
}
// --- end of p16 helpers
// ---------------------------------------------------------------------------
// OpenSky OAuth2 token + response cache state
// ---------------------------------------------------------------------------
/** @type {string|null} Current OAuth2 bearer token. */
let _openskyToken = null;
/** @type {number} Epoch-ms when the current token expires. */
let _openskyTokenExpiry = 0;
/** @type {Promise<string|null>|null} In-flight token refresh promise (coalesces concurrent callers). */
let _openskyTokenPromise = null;
/** @type {string|null} Cached upstream response body (JSON text). */
let _openskyCacheBody = null;
/** @type {number} HTTP status of the cached response. */
let _openskyCacheStatus = 0;
/** @type {number} Epoch-ms when the response was cached. */
let _openskyCacheTime = 0;
/** @type {{requestedMode:string,usedMode:string,reason:string}|null} Auth metadata for the cached response. */
let _openskyCacheMeta = null;
/** @type {number|null} Source snapshot epoch from the cached OpenSky body. */
let _openskyCacheSourceEpochMs = null;
/** TTL for the OpenSky response cache (ms). */
const OPENSKY_CACHE_MS = 9000;
/** Per-attempt limit for the global snapshot; it normally arrives in ~1.5 s. */
const OPENSKY_ATTEMPT_TIMEOUT_MS = 10_000;
const OPENSKY_STATES_URL =
  'https://opensky-network.org/api/states/all?extended=1';
/** states/all?extended=1 measures ~0.8 MB anonymously; bounded, not budgeted. */
const OPENSKY_STATES_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Credit-governor cooldown for a 429: OpenSky's retry-after bounded to
 * 30 s … 30 min, or 2 min when the header is absent.
 * @param {Response} upstream Rate-limited response.
 * @returns {number} Cooldown (ms).
 */
function openSkyRateLimitCooldownMs(upstream) {
  // headers.get() gives null when absent, and Number(null) is 0, not NaN.
  const header = upstream.headers.get('x-rate-limit-retry-after-seconds');
  const retryAfterSec =
    header == null || header.trim() === '' ? NaN : Number(header);
  return Math.min(
    Math.max(
      Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 120_000,
      30_000,
    ),
    30 * 60_000,
  );
}

/**
 * Fetch and read the global snapshot, giving each attempt
 * OPENSKY_ATTEMPT_TIMEOUT_MS and retrying once when an attempt times out or
 * the connection fails. An oversized body is not retried: it would fail again
 * and spend more credits. A second failure throws, which the proxy answers
 * from its stale cache or the regional fallback.
 * @param {Record<string, string>} headers Request headers.
 * @returns {Promise<{upstream: Response, body: string}>}
 */
async function fetchOpenSkyStates(headers) {
  for (let attempt = 1; ; attempt++) {
    const startedAt = performance.now();
    try {
      const signal = AbortSignal.timeout(OPENSKY_ATTEMPT_TIMEOUT_MS);
      const upstream = await fetch(OPENSKY_STATES_URL, { headers, signal });
      if (upstream.status === 429) {
        // Start the cooldown from the headers and drop the rejected body
        // unread, so a stalled or oversized 429 body cannot skip it.
        _openskyCooldownUntil =
          Date.now() + openSkyRateLimitCooldownMs(upstream);
        void upstream.body?.cancel().catch(() => {});
        return {
          upstream,
          body: JSON.stringify({ error: 'OpenSky rate limited.' }),
          startedAt,
          bodyUnread: true,
        };
      }
      const body = await readResponseTextCapped(
        upstream,
        OPENSKY_STATES_MAX_RESPONSE_BYTES,
        signal,
      );
      return { upstream, body, startedAt };
    } catch (error) {
      // Byrd-IT p16 (R3): class/elapsed/timeout instead of the message.
      const fields = p16ThrownFailure({
        url: OPENSKY_STATES_URL,
        error,
        startedAt,
        timeoutMs: OPENSKY_ATTEMPT_TIMEOUT_MS,
      });
      if (attempt >= 2 || error?.code === 'RESPONSE_TOO_LARGE')
        throw p16Annotate(error, fields);
      console.warn(
        '[OpenSky] global snapshot attempt failed, retrying:',
        fields,
      );
    }
  }
}
// --- OpenSky credit governor (field-test fix 2026-07-06) -------------------
// The global /states/all this proxy fetches costs 4 CREDITS per call against
// OpenSky's ~4000/day authenticated budget — a day with the app open burned
// the whole quota in ~8h and the layer then hard-died until the daily reset
// ("rate limited for 48h" owner report; auth itself was fine). Three levers:
//  1. Adaptive TTL: OpenSky returns X-Rate-Limit-Remaining on success; as the
//     budget thins, the proxy stretches its cache TTL so a full day of
//     continuous use never exhausts it.
//  2. 429 cooldown: honor X-Rate-Limit-Retry-After-Seconds — no upstream
//     attempts until it passes (bounded 30 s … 30 min).
//  3. Serve-stale: while rate-limited/cooling, serve the last-good body (200 +
//     X-OpenSky-Stale) so the layer keeps rendering instead of dying.
/** @type {number} Current adaptive TTL (ms) — starts at the base cache TTL. */
let _openskyTtlMs = OPENSKY_CACHE_MS;
/** @type {number} Epoch-ms before which no upstream fetch is attempted. */
let _openskyCooldownUntil = 0;
/**
 * Picks the cache TTL from the remaining daily credit budget.
 * Client polls every 30 s, so tiers ≤30 s cost the same 480 credits/h; the
 * later tiers stretch the day: >2400 → ~3 h of full freshness, then 30 s
 * (~2.5 h), 90 s (~5 h), 300 s (~8 h) ≈ 18+ h of continuous use per day.
 * @param {number} remaining - X-Rate-Limit-Remaining header value.
 * @returns {number} TTL in ms.
 */
function openskyAdaptiveTtlMs(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}
/**
 * Byrd-IT p16: a non-OK /states/all reply was not logged at all. It is now,
 * at most once per status per P16_STATES_LOG_WINDOW_MS (the client polls
 * every 30 s per viewer), with the count of replies not logged since.
 */
const P16_STATES_LOG_WINDOW_MS = 60_000;
/** @type {Map<number, {at: number, suppressed: number}>} */
const _p16StatesLogGate = new Map();
function p16AdmitStatesLog(status, now = Date.now()) {
  const gate = _p16StatesLogGate.get(status);
  if (gate && now - gate.at < P16_STATES_LOG_WINDOW_MS) {
    gate.suppressed += 1;
    return null;
  }
  if (_p16StatesLogGate.size >= 32) _p16StatesLogGate.clear();
  _p16StatesLogGate.set(status, { at: now, suppressed: 0 });
  return { suppressed: gate?.suppressed || 0 };
}

/** Log one non-OK /states/all reply (gated). Never throws. */
async function p16LogStatesFailure(states, usedMode, secrets) {
  try {
    const admitted = p16AdmitStatesLog(states.upstream.status);
    if (!admitted) return;
    const fields = await p16HttpFailure({
      url: OPENSKY_STATES_URL,
      response: states.upstream,
      startedAt: states.startedAt,
      secrets,
      text: states.bodyUnread
        ? '[not read: a 429 starts the cooldown from its headers]'
        : states.body,
    });
    console.warn(
      `[OpenSky] states upstream HTTP ${states.upstream.status} ${fields} auth=${usedMode}` +
        (admitted.suppressed ? ` suppressed=${admitted.suppressed}` : ''),
    );
  } catch {
    /* logging only */
  }
}

/** @type {boolean} Guards duplicate auth-failure warnings in logs. */
let _openskyAuthWarned = false;
/** @type {boolean} Guards duplicate invalid-auth-mode warnings. */
let _openskyAuthModeWarned = false;
/** Default auth mode when OPENSKY_AUTH_MODE env is unset. */
const OPENSKY_AUTH_MODE_DEFAULT = 'oauth';
/** Set of valid OPENSKY_AUTH_MODE values. */
const OPENSKY_AUTH_MODE_SET = new Set(['basic', 'oauth', 'auto', 'anon']);
/** Regional civilian fallback cache, keyed by a coarse 0.25° view anchor. */
const _adsbLolPointCache = new Map();
/** Per-anchor single-flight map for concurrent regional fallback requests. */
const _adsbLolPointInFlight = new Map();
const ADSBLOL_POINT_CACHE_MS = 12000;
const ADSBLOL_POINT_CACHE_MAX = 80;
const ADSBLOL_POINT_RADIUS_NM = 250;
const ADSBLOL_POINT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// A 200 response can still contain an old OpenSky snapshot. Past this point
// the viewport-scoped adsb.lol source is more honest and keeps local motion
// current instead of coasting a stale worldwide frame indefinitely.
const OPENSKY_SOURCE_STALE_MS = 120_000;

/**
 * Obtain a valid OpenSky OAuth2 bearer token, refreshing if needed.
 *
 * Uses the client_credentials grant against the OpenSky Keycloak realm.
 * Concurrent callers share a single in-flight refresh promise so only
 * one token request is issued at a time.
 *
 * @returns {Promise<string|null>} Bearer token string, or null if unavailable.
 */
export async function getOpenSkyToken() {
  const now = Date.now();
  // Return cached token if still valid (with 60 s safety margin)
  if (_openskyToken && now < _openskyTokenExpiry - 60000) return _openskyToken;

  // Coalesce concurrent refresh requests — if a refresh is already in-flight,
  // return the same promise instead of issuing a duplicate token request
  if (_openskyTokenPromise) return _openskyTokenPromise;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Wrap the async token fetch in a shared promise stored in _openskyTokenPromise
  const tokenUrl =
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  const tokenSecrets = [clientId, clientSecret];
  _openskyTokenPromise = (async () => {
    const startedAt = performance.now();
    try {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(OPENSKY_ATTEMPT_TIMEOUT_MS),
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
      });

      // Same result as res.json() (null when unreadable or not JSON), but
      // the text stays available for the failure log.
      let text;
      let data = null;
      try {
        text = await res.text();
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_openskyAuthWarned) {
          // Byrd-IT p16 (R3): status/elapsed/redacted body[:300]; the client
          // id/secret and any token in the reply are masked.
          const detail = await p16HttpFailure({
            method: 'POST',
            url: tokenUrl,
            response: res,
            startedAt,
            secrets: tokenSecrets,
            text: text ?? '[body unreadable]',
          });
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
        return null;
      }

      _openskyToken = accessToken;
      // Default to 1800 s (30 min) if expires_in is missing or non-finite
      _openskyTokenExpiry =
        Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      console.log(
        '[OpenSky] OAuth token refreshed, expires in',
        Number.isFinite(expiresIn) ? expiresIn : 1800,
        's',
      );
      _openskyAuthWarned = false;
      return _openskyToken;
    } catch (err) {
      if (!_openskyAuthWarned) {
        console.warn(
          '[OpenSky] OAuth token request failed:',
          p16ThrownFailure({
            method: 'POST',
            url: tokenUrl,
            error: err,
            startedAt,
            timeoutMs: OPENSKY_ATTEMPT_TIMEOUT_MS,
            secrets: tokenSecrets,
          }),
        );
        _openskyAuthWarned = true;
      }
      _openskyToken = null;
      _openskyTokenExpiry = 0;
      return null;
    } finally {
      // Clear the shared promise so the next caller can start a fresh refresh
      _openskyTokenPromise = null;
    }
  })();

  return _openskyTokenPromise;
}

/**
 * Validate and normalize the OPENSKY_AUTH_MODE env value.
 *
 * @param {string} value - Raw env value (e.g. 'basic', 'oauth', 'auto', 'anon').
 * @returns {string} One of the valid mode strings, or the default ('oauth').
 */
function normalizeOpenSkyAuthMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return OPENSKY_AUTH_MODE_DEFAULT;
  if (OPENSKY_AUTH_MODE_SET.has(raw)) return raw;
  if (!_openskyAuthModeWarned) {
    console.warn(
      `[OpenSky] Invalid OPENSKY_AUTH_MODE="${raw}", defaulting to "${OPENSKY_AUTH_MODE_DEFAULT}"`,
    );
    _openskyAuthModeWarned = true;
  }
  return OPENSKY_AUTH_MODE_DEFAULT;
}

/**
 * Build standard response headers for OpenSky proxy responses.
 *
 * Includes diagnostic X-OpenSky-* headers so the client can inspect
 * cache hit/miss status and which auth mode was actually used.
 *
 * @param {object} opts
 * @param {string} opts.cacheStatus - 'HIT', 'MISS', or 'STALE'.
 * @param {string} opts.requestedMode - The auth mode the config requested.
 * @param {string} opts.usedMode - The auth mode actually used for the upstream call.
 * @param {string} opts.reason - Human-readable reason string for diagnostics.
 * @returns {Record<string,string>} Header object.
 */
function buildOpenSkyHeaders({
  cacheStatus,
  requestedMode,
  usedMode,
  reason,
  staleSeconds,
  retryAfterSeconds,
}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Mode-Requested': requestedMode,
    'X-OpenSky-Auth-Mode-Used': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
  // Credit-governor extras (field-test fix 2026-07-06): the client can show a
  // STALE cue / countdown without parsing the body.
  if (Number.isFinite(staleSeconds))
    headers['X-OpenSky-Stale-Seconds'] = String(Math.round(staleSeconds));
  if (Number.isFinite(retryAfterSeconds))
    headers['X-OpenSky-Retry-After-Seconds'] = String(
      Math.round(retryAfterSeconds),
    );
  return headers;
}

export function adsbLolFallbackAnchor(req) {
  const incoming = new URL(req?.url || '', 'http://localhost');
  const latitude = requiredFiniteQueryNumber(incoming.searchParams, 'lat');
  const longitude = requiredFiniteQueryNumber(incoming.searchParams, 'lon');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
    return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    return null;
  return { latitude, longitude };
}

async function fetchAdsbLolPointFallback(req) {
  const anchor = adsbLolFallbackAnchor(req);
  if (!anchor) return null;
  const roundedLat = Math.round(anchor.latitude * 4) / 4;
  const roundedLon = Math.round(anchor.longitude * 4) / 4;
  const cacheKey = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
  const cached = _adsbLolPointCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < ADSBLOL_POINT_CACHE_MS) {
    return { ...cached, cacheStatus: 'HIT' };
  }

  const request = coalesceProxyRequest(
    _adsbLolPointInFlight,
    cacheKey,
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      // Byrd-IT p16 (R3): the log target hides the view anchor coordinates.
      const logUrl = `https://api.adsb.lol/v2/lat/_/lon/_/dist/${ADSBLOL_POINT_RADIUS_NM}`;
      const startedAt = performance.now();
      const thrown = (error, stage) =>
        p16Annotate(
          error,
          p16ThrownFailure({
            url: logUrl,
            error,
            startedAt,
            timeoutMs: 10000,
            stage,
          }),
        );
      try {
        let upstream;
        try {
          upstream = await fetch(
            `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
            {
              headers: {
                Accept: 'application/json',
                'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0',
              },
              signal: controller.signal,
            },
          );
        } catch (error) {
          throw thrown(error, 'headers');
        }
        if (!upstream.ok)
          throw p16Annotate(
            new Error(`upstream HTTP ${upstream.status}`),
            await p16HttpFailure({
              url: logUrl,
              response: upstream,
              startedAt,
            }),
          );
        let payload;
        try {
          payload = await readResponseJsonCapped(
            upstream,
            ADSBLOL_POINT_MAX_RESPONSE_BYTES,
          );
        } catch (error) {
          throw thrown(error, 'body');
        }
        const normalized = normalizeAdsbLolPointResponse(payload);
        const record = {
          body: JSON.stringify(normalized),
          cachedAt: Date.now(),
          count: normalized.states.length,
        };
        _adsbLolPointCache.delete(cacheKey);
        _adsbLolPointCache.set(cacheKey, record);
        while (_adsbLolPointCache.size > ADSBLOL_POINT_CACHE_MAX) {
          _adsbLolPointCache.delete(_adsbLolPointCache.keys().next().value);
        }
        return record;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );
  try {
    const record = await request.promise;
    return { ...record, cacheStatus: request.shared ? 'INFLIGHT' : 'MISS' };
  } catch (error) {
    if (!request.shared && error?.name !== 'AbortError') {
      console.warn(
        '[adsb.lol Flights Fallback]',
        error?.p16Log || error?.message || error,
      );
    }
    return cached ? { ...cached, cacheStatus: 'STALE' } : null;
  }
}

async function serveAdsbLolPointFallback(req, res, requestedMode, reason) {
  const fallback = await fetchAdsbLolPointFallback(req);
  if (!fallback) return false;
  res.writeHead(200, {
    ...buildOpenSkyHeaders({
      cacheStatus: fallback.cacheStatus,
      requestedMode,
      usedMode: 'adsblol-regional',
      reason,
    }),
    'X-Flight-Source': 'adsb.lol',
    'X-Flight-Coverage': `${ADSBLOL_POINT_RADIUS_NM}nm regional fallback`,
    'X-Flight-Count': String(fallback.count),
  });
  res.end(fallback.body);
  return true;
}

function openSkySourceEpochMs(body) {
  try {
    const seconds = Number(JSON.parse(body)?.time);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function openSkySourceIsStale(sourceEpochMs, now = Date.now()) {
  return (
    Number.isFinite(sourceEpochMs) &&
    now - sourceEpochMs > OPENSKY_SOURCE_STALE_MS
  );
}

/**
 * Vite plugin: OpenSky Network proxy with multi-mode auth and response caching.
 *
 * Supports four auth modes controlled by OPENSKY_AUTH_MODE env:
 *   - 'oauth'  (default) — client_credentials bearer token
 *   - 'basic'  — HTTP Basic with OPENSKY_USERNAME / OPENSKY_PASSWORD
 *   - 'auto'   — try OAuth first, fall back to Basic, then anon
 *   - 'anon'   — no credentials
 *
 * Successful responses are cached for OPENSKY_CACHE_MS (~9 s). On
 * upstream failure the proxy serves a stale cached response if available, or
 * a bounded 250 nm adsb.lol point snapshot around the current view anchor.
 *
 * @returns {import('vite').Plugin}
 */
export function openSkyProxy() {
  const installMiddleware = (server) => {
    server.middlewares.use('/api/flights', async (req, res, next) => {
      try {
        // This mount also matches its /track route, served by its own handler.
        if (new URL(req.url || '/', 'http://localhost').pathname !== '/')
          return next();
        res.setHeader('X-Feed-Source', 'OpenSky Network');
        const requestedMode = normalizeOpenSkyAuthMode(
          process.env.OPENSKY_AUTH_MODE,
        );
        const now = Date.now();
        const inCooldown = now < _openskyCooldownUntil;
        // Fresh-enough cache (adaptive TTL) OR any cache during a 429
        // cooldown: serve it without touching upstream. Stale-during-cooldown
        // is deliberate (credit governor): last-good planes beat a dead layer.
        if (
          _openskyCacheBody &&
          (now - _openskyCacheTime < _openskyTtlMs || inCooldown)
        ) {
          if (
            openSkySourceIsStale(_openskyCacheSourceEpochMs, now) &&
            (await serveAdsbLolPointFallback(
              req,
              res,
              requestedMode,
              'opensky_snapshot_stale_regional_fallback',
            ))
          ) {
            return;
          }
          const cachedMeta = _openskyCacheMeta || {
            requestedMode,
            usedMode: 'unknown',
            reason: 'cached',
          };
          const isStale = now - _openskyCacheTime >= _openskyTtlMs;
          res.writeHead(
            _openskyCacheStatus || 200,
            buildOpenSkyHeaders({
              cacheStatus: isStale ? 'STALE' : 'HIT',
              requestedMode: cachedMeta.requestedMode || requestedMode,
              usedMode: cachedMeta.usedMode || 'unknown',
              reason: isStale
                ? 'rate_limited_serving_stale'
                : cachedMeta.reason || 'cached',
              staleSeconds: isStale
                ? (now - _openskyCacheTime) / 1000
                : undefined,
              retryAfterSeconds: inCooldown
                ? (_openskyCooldownUntil - now) / 1000
                : undefined,
            }),
          );
          res.end(_openskyCacheBody);
          return;
        }
        // Cooling down with nothing cached (cold start into a rate limit):
        // synthesize the 429 locally — hammering upstream mid-cooldown can't
        // succeed and just burns goodwill.
        if (inCooldown) {
          if (
            await serveAdsbLolPointFallback(
              req,
              res,
              requestedMode,
              'opensky_cooldown_regional_fallback',
            )
          )
            return;
          res.writeHead(
            429,
            buildOpenSkyHeaders({
              cacheStatus: 'COOLDOWN',
              requestedMode,
              usedMode: 'none',
              reason: 'rate_limited',
              retryAfterSeconds: (_openskyCooldownUntil - now) / 1000,
            }),
          );
          res.end(
            JSON.stringify({
              error: 'OpenSky rate limited; proxy cooling down.',
            }),
          );
          return;
        }

        const basicUser = process.env.OPENSKY_USERNAME || '';
        const basicPass = process.env.OPENSKY_PASSWORD || '';
        const hasBasicCreds = Boolean(basicUser && basicPass);
        const headers = { Accept: 'application/json' };
        let usedMode = 'anon';
        let reason = 'forced_anonymous';

        if (requestedMode === 'basic') {
          if (hasBasicCreds) {
            headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
            usedMode = 'basic';
            reason = 'basic_credentials';
          } else {
            reason = 'missing_basic_creds';
          }
        } else if (requestedMode === 'oauth') {
          const token = await getOpenSkyToken();
          if (token) {
            headers.Authorization = `Bearer ${token}`;
            usedMode = 'oauth';
            reason = 'oauth_token';
          } else {
            reason = 'oauth_invalid_or_missing';
          }
        } else if (requestedMode === 'auto') {
          const token = await getOpenSkyToken();
          if (token) {
            headers.Authorization = `Bearer ${token}`;
            usedMode = 'oauth';
            reason = 'oauth_token';
          } else if (hasBasicCreds) {
            headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
            usedMode = 'basic';
            reason = 'oauth_unavailable_fallback_basic';
          } else {
            reason = 'missing_oauth_and_basic_creds';
          }
        }

        let states = await fetchOpenSkyStates(headers);
        let { upstream, body } = states;
        // Auto-mode fallback: if OAuth was rejected, retry with Basic credentials
        if (
          (upstream.status === 401 || upstream.status === 403) &&
          requestedMode === 'auto' &&
          usedMode === 'oauth' &&
          hasBasicCreds
        ) {
          const retryHeaders = {
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`,
          };
          states = await fetchOpenSkyStates(retryHeaders);
          ({ upstream, body } = states);
          usedMode = 'basic';
          reason = 'oauth_rejected_fallback_basic';
        }
        if (!upstream.ok)
          await p16LogStatesFailure(states, usedMode, [
            _openskyToken,
            basicUser,
            basicPass,
            hasBasicCreds
              ? Buffer.from(`${basicUser}:${basicPass}`).toString('base64')
              : '',
            process.env.OPENSKY_CLIENT_ID,
            process.env.OPENSKY_CLIENT_SECRET,
          ]);

        const sourceEpochMs = upstream.ok ? openSkySourceEpochMs(body) : null;
        if (
          upstream.ok &&
          openSkySourceIsStale(sourceEpochMs, now) &&
          (await serveAdsbLolPointFallback(
            req,
            res,
            requestedMode,
            'opensky_snapshot_stale_regional_fallback',
          ))
        ) {
          // Keep the last global snapshot available as a fail-soft cache,
          // but do not label or render it as a fresh live result.
          _openskyCacheBody = body;
          _openskyCacheStatus = upstream.status;
          _openskyCacheTime = now;
          _openskyCacheSourceEpochMs = sourceEpochMs;
          _openskyCacheMeta = { requestedMode, usedMode, reason };
          return;
        }
        if (upstream.status === 429) {
          reason = 'rate_limited';
          // Credit governor: fetchOpenSkyStates already started the cooldown
          // from OpenSky's retry-after — no upstream attempts until then.
          const cooldownMs = openSkyRateLimitCooldownMs(upstream);
          // Serve the last-good body instead of the 429 when we have one —
          // the layer keeps rendering (STALE-cued) instead of dying.
          if (_openskyCacheBody && _openskyCacheStatus === 200) {
            res.writeHead(
              200,
              buildOpenSkyHeaders({
                cacheStatus: 'STALE',
                requestedMode,
                usedMode,
                reason: 'rate_limited_serving_stale',
                staleSeconds: (now - _openskyCacheTime) / 1000,
                retryAfterSeconds: cooldownMs / 1000,
              }),
            );
            res.end(_openskyCacheBody);
            return;
          }
        }

        if (!upstream.ok && !_openskyCacheBody) {
          const servedFallback = await serveAdsbLolPointFallback(
            req,
            res,
            requestedMode,
            `opensky_http_${upstream.status}_regional_fallback`,
          );
          if (servedFallback) return;
        }

        if (upstream.status === 401 || upstream.status === 403) {
          if (requestedMode === 'basic' && !hasBasicCreds) {
            body = JSON.stringify({
              error:
                'OpenSky auth missing. Basic mode requires OPENSKY_USERNAME and OPENSKY_PASSWORD.',
            });
            reason = 'missing_basic_creds';
          } else if (requestedMode === 'oauth' && usedMode !== 'oauth') {
            body = JSON.stringify({
              error:
                'OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.',
            });
            reason = 'oauth_invalid_or_missing';
          } else if (usedMode === 'basic') {
            body = JSON.stringify({
              error: 'OpenSky auth invalid. Username/password were rejected.',
            });
            reason = 'basic_invalid_credentials';
          } else if (usedMode === 'oauth') {
            body = JSON.stringify({
              error:
                'OpenSky auth invalid. OAuth client credentials were rejected.',
            });
            reason = 'oauth_invalid_credentials';
          } else if (requestedMode === 'auto' && !hasBasicCreds) {
            body = JSON.stringify({
              error:
                'OpenSky auth missing. Provide basic credentials or valid OAuth client credentials.',
            });
            reason = 'missing_oauth_and_basic_creds';
          } else {
            body = JSON.stringify({
              error: 'OpenSky auth required.',
            });
            reason = 'auth_required';
          }
        }

        // Refine the reason string to reflect the actual outcome
        if (upstream.ok && reason === 'forced_anonymous') {
          reason = 'anonymous_ok';
        } else if (
          upstream.ok &&
          usedMode === 'basic' &&
          reason === 'basic_credentials'
        ) {
          reason = 'basic_ok';
        } else if (
          upstream.ok &&
          usedMode === 'oauth' &&
          reason === 'oauth_token'
        ) {
          reason = 'oauth_ok';
        }

        // Only cache successful responses — error responses (401/403/429/5xx)
        // should not be served from cache on subsequent requests
        if (upstream.ok) {
          _openskyCacheBody = body;
          _openskyCacheStatus = upstream.status;
          _openskyCacheTime = now;
          _openskyCacheSourceEpochMs = sourceEpochMs;
          _openskyCacheMeta = {
            requestedMode,
            usedMode,
            reason,
          };
          // Credit governor: adapt the cache TTL to the remaining daily
          // budget so a continuously-open app stretches its polls instead of
          // exhausting the quota mid-day. Success also clears any cooldown.
          const remaining = Number(
            upstream.headers.get('x-rate-limit-remaining'),
          );
          _openskyTtlMs = openskyAdaptiveTtlMs(remaining);
          _openskyCooldownUntil = 0;
        }

        res.writeHead(
          upstream.status,
          buildOpenSkyHeaders({
            cacheStatus: 'MISS',
            requestedMode,
            usedMode,
            reason,
          }),
        );
        res.end(body);
      } catch (e) {
        console.error('[OpenSky Proxy]', e?.p16Log || p16FailureClass(e));
        if (_openskyCacheBody) {
          const cachedMeta = _openskyCacheMeta || {
            requestedMode: normalizeOpenSkyAuthMode(
              process.env.OPENSKY_AUTH_MODE,
            ),
            usedMode: 'unknown',
            reason: 'cached_stale',
          };
          res.writeHead(
            _openskyCacheStatus || 200,
            buildOpenSkyHeaders({
              cacheStatus: 'STALE',
              requestedMode:
                cachedMeta.requestedMode || OPENSKY_AUTH_MODE_DEFAULT,
              usedMode: cachedMeta.usedMode || 'unknown',
              reason: cachedMeta.reason || 'cached_stale',
            }),
          );
          res.end(_openskyCacheBody);
          return;
        }
        const requestedMode = normalizeOpenSkyAuthMode(
          process.env.OPENSKY_AUTH_MODE,
        );
        if (
          await serveAdsbLolPointFallback(
            req,
            res,
            requestedMode,
            'opensky_proxy_error_regional_fallback',
          )
        )
          return;
        res.writeHead(
          502,
          buildOpenSkyHeaders({
            cacheStatus: 'MISS',
            requestedMode,
            usedMode: 'error',
            reason: 'proxy_error',
          }),
        );
        res.end(JSON.stringify({ error: 'OpenSky proxy error' }));
      }
    });
  };
  return {
    name: 'opensky-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
