import {
  OVERPASS_MAX_RESPONSE_BYTES,
  resolveOverpassUpstreams,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
} from './constants.js';
import { readResponseTextCapped } from '../common/http.js';
import { simplifyOverpassPayloadBody } from './geometry.js';

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('rate_limited') ||
    text.includes('quota of your ip address') ||
    text.includes('dispatcher_client::request_read_and_idx::rate_limited') ||
    text.includes('too many requests')
  );
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('runtime error') ||
    text.includes('timed out') ||
    text.includes('out of memory')
  );
}

/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */
function overpassPayloadIsData(payload) {
  const status = Number(payload?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    !payload.rateLimited &&
    !payload.runtimeError
  );
}

const cooldowns = new Map();

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
 * Cause class of a thrown Overpass failure, so an outage (timeout, DNS,
 * refused) can be told from a bad answer (malformed, too large). Never the
 * error message: it can carry the endpoint.
 */
function overpassFailureClass(error) {
  // String codes only: DOMException carries a numeric legacy `code`.
  const code =
    [error?.cause?.code, error?.code].find((c) => typeof c === 'string') || '';
  // The only abort on this path is the OVERPASS_TIMEOUT_MS timer.
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
  if (code === 'OVERPASS_MALFORMED' || error instanceof SyntaxError)
    return 'malformed';
  if (code) return `network code=${code}`;
  return error?.name || 'error';
}

/** Endpoint for a log line: origin + path only (no userinfo, no query). */
function endpointForLog(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(invalid endpoint)';
  }
}

/** A stable, non-retryable capability response shared by every Overpass route. */
export function overpassNotConfigured() {
  return {
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'Detailed OpenStreetMap queries are not configured',
      code: 'OVERPASS_NOT_CONFIGURED',
      retryable: false,
    }),
  };
}

/** Honor Retry-After dates/seconds; absent values use bounded exponential backoff. */
function retryDelay(value, failures, now) {
  const seconds = Number(value);
  const explicit =
    value && Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - now;
  return Number.isFinite(explicit)
    ? Math.max(1000, explicit)
    : Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4));
}

function refusal(status, retryAfterMs) {
  return {
    status,
    contentType: 'application/json',
    rateLimited: status === 429 || status === 406,
    retryAfterMs,
    body: JSON.stringify({
      error: 'Configured Overpass upstream unavailable',
      code: 'OVERPASS_UNAVAILABLE',
      retryable: true,
      retryAfterMs,
    }),
  };
}

/**
 * Query only the configured chain with capped reads, timeouts and per-endpoint cooldowns.
 * Explicit endpoint/I/O overrides are server-only test seams. Empty data is valid.
 */
async function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = resolveOverpassUpstreams(),
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
    now = Date.now,
  } = {},
) {
  if (!endpoints.length) return overpassNotConfigured();
  let failure = refusal(502, 30_000);
  for (const endpoint of endpoints) {
    const previous = cooldowns.get(endpoint);
    if (previous?.until > now()) {
      failure = refusal(previous.status, previous.until - now());
      continue;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    const startedAt = performance.now();
    let upstreamStatus = 0;
    let responseBody = null;
    // The endpoint's own credentials are masked if a body echoes them.
    const secrets = [];
    try {
      const requestUrl = new URL(endpoint);
      secrets.push(
        decodeURIComponent(requestUrl.username),
        decodeURIComponent(requestUrl.password),
        ...[...requestUrl.searchParams.values()],
      );
      const authorization =
        requestUrl.username || requestUrl.password
          ? 'Basic ' +
            Buffer.from(
              `${decodeURIComponent(requestUrl.username)}:${decodeURIComponent(requestUrl.password)}`,
            ).toString('base64')
          : null;
      if (authorization) secrets.push(authorization.slice('Basic '.length));
      requestUrl.username = '';
      requestUrl.password = '';
      const upstream = await fetchImpl(requestUrl.href, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': OVERPASS_USER_AGENT,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body,
        signal: controller.signal,
      });
      upstreamStatus = upstream.status;
      responseBody = await readBody(upstream, maxResponseBytes);
      const rateLimited =
        upstream.status === 429 ||
        upstream.status === 406 ||
        overpassLooksRateLimited(responseBody);
      if (
        rateLimited ||
        upstream.status < 200 ||
        upstream.status >= 300 ||
        overpassLooksRuntimeError(responseBody)
      ) {
        const failures = (previous?.failures || 0) + 1;
        const delay = retryDelay(
          upstream.headers.get('retry-after'),
          failures - 1,
          now(),
        );
        const status = rateLimited
          ? upstream.status === 406
            ? 406
            : 429
          : 502;
        cooldowns.set(endpoint, { until: now() + delay, failures, status });
        while (cooldowns.size > 64)
          cooldowns.delete(cooldowns.keys().next().value);
        failure = refusal(status, delay);
        console.warn(
          `[Overpass] upstream refused endpoint=${endpointForLog(endpoint)} ` +
            `class=${rateLimited ? 'rate_limited' : upstream.status >= 200 && upstream.status < 300 ? 'runtime_error' : 'http'} ` +
            `status=${upstream.status} elapsed_ms=${Math.round(performance.now() - startedAt)} ` +
            `cooldown_ms=${delay} failures=${failures} body=${JSON.stringify(redactSnippet(responseBody, secrets))}`,
        );
        continue;
      }
      const parsed = JSON.parse(responseBody);
      if (!Array.isArray(parsed?.elements) || parsed.remark)
        throw Object.assign(new Error('Malformed Overpass response'), {
          code: 'OVERPASS_MALFORMED',
        });
      cooldowns.delete(endpoint);
      return {
        status: upstream.status,
        body: simplify(responseBody),
        contentType: 'application/json',
        // Never retain a secret-bearing endpoint in cache or response metadata.
        endpoint: 'configured',
        rateLimited: false,
      };
    } catch (error) {
      const failures = (previous?.failures || 0) + 1;
      const delay = retryDelay(null, failures - 1, now());
      cooldowns.set(endpoint, { until: now() + delay, failures, status: 502 });
      while (cooldowns.size > 64)
        cooldowns.delete(cooldowns.keys().next().value);
      failure = refusal(502, delay);
      console.warn(
        `[Overpass] upstream failed endpoint=${endpointForLog(endpoint)} ` +
          `class=${overpassFailureClass(error)} status=${upstreamStatus || 'none'} ` +
          `elapsed_ms=${Math.round(performance.now() - startedAt)} timeout_ms=${OVERPASS_TIMEOUT_MS} ` +
          `cooldown_ms=${delay} failures=${failures}` +
          // A body that was read but is malformed is the evidence.
          (responseBody !== null
            ? ` body=${JSON.stringify(redactSnippet(responseBody, secrets))}`
            : ''),
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return failure;
}

export { overpassPayloadIsData, fetchOverpassPayload };
