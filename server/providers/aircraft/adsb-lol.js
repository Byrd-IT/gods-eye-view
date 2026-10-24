import {
  coalesceProxyRequest,
  readResponseTextCapped,
} from '../common/http.js';

const ADSB_LOL_MIL_URL = 'https://api.adsb.lol/v2/mil';
/**
 * Default upstream backstop (ms); bounds the headers AND the body read. The
 * baseline had no timeout. Existing telemetry for this exact upstream
 * (gev-collector polls https://api.adsb.lol/v2/mil once a minute from the
 * same S4/S5 egress; ES gev-history-ingest-log feed=military, 7753 ok polls
 * 2026-10-11..18): whole-poll duration (fetch + parse + ES write, so an upper
 * bound on the fetch) p50 0.7 s, p90 2.0 s, p99 15.1 s, max 29.0 s; 237
 * (3.1 %) took >= 10 s. 30 s covers that maximum. The browser feed has no
 * deadline of its own. Override with GEV_ADSB_LOL_TIMEOUT_MS (1000-600000).
 */
export const ADSB_LOL_TIMEOUT_MS = 30_000;

/** Effective adsb.lol timeout: GEV_ADSB_LOL_TIMEOUT_MS when valid, else the default. */
export function adsbLolTimeoutMs(env = process.env) {
  const ms = Number(env?.GEV_ADSB_LOL_TIMEOUT_MS);
  return Number.isInteger(ms) && ms >= 1000 && ms <= 600_000
    ? ms
    : ADSB_LOL_TIMEOUT_MS;
}

/** Longest wait for a failing body's first bytes once stale data is served (ms). */
const STALE_BODY_PEEK_MS = 1000;

/**
 * Read what a failing body yields within `ms` (at most ~4 KiB) for the log,
 * then cancel it. A stalled body never pins the handler past `ms`.
 */
async function peekAndCancel(response, ms = STALE_BODY_PEEK_MS) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: true, timedOut: true }), ms);
    timer.unref?.();
  });
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < 4096) {
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

/** Cause class of a thrown fetch/read error: never its message (it can carry URLs). */
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
 * Vite plugin: adsb.lol military aircraft proxy with 12 s response cache.
 *
 * Serves GET /api/military from https://api.adsb.lol/v2/mil. When upstream
 * fails — a thrown fetch OR a non-OK status such as 429 — the proxy serves its
 * cached body as STALE instead of relaying the failure, and it backs off from
 * upstream for the Retry-After period (bounded) so a rate limit is never
 * hammered mid-cooldown. A failure with nothing cached is relayed as-is.
 *
 * Why the non-OK case matters: the browser layer treats a relayed 429 as a
 * 45 s cooldown during which EVERY refresh (the 15 s poll and any tracking
 * resolve) reports "adsb.lol rate limited", which the global status chip
 * renders as LOAD FAILED while the map is still fully populated.
 *
 * Every upstream call carries a timeout; every failure logs one line with the
 * target, status or cause class, elapsed time and a redacted 300-byte body
 * snippet (STANDARD R3). Responses to the browser are unchanged.
 *
 * @returns {import('vite').Plugin}
 */
export function adsbLolProxy() {
  /** @type {string|null} Cached upstream JSON body. */
  let _cache = null;
  const inFlight = new Map();
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** @type {number} Epoch-ms until which upstream is not contacted. */
  let _cooldownUntil = 0;
  /** @type {number} Upstream status that started the current cooldown. */
  let _cooldownStatus = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  /** Upstream deadline: adsbLolTimeoutMs() (Byrd-IT, telemetry-sized; see top of file). */
  /** /v2/mil measures ~67 KB; a relayed error page is bounded by the same cap. */
  const ADSBLOL_MIL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  /** Cooldown after a 429 when upstream sends no usable Retry-After (ms). */
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  /** Cooldown after a 5xx (ms). */
  const SERVER_ERROR_COOLDOWN_MS = 15000;
  /** Bounds for an upstream-supplied Retry-After (ms). */
  const COOLDOWN_MIN_MS = 5000;
  const COOLDOWN_MAX_MS = 120000;

  const clampCooldown = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));

  /** Cooldown (ms) an upstream failure earns, honouring Retry-After when sane. */
  function cooldownFor(upstream, now) {
    const raw = upstream.headers?.get?.('retry-after');
    if (raw) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0)
        return clampCooldown(seconds * 1000);
      const at = Date.parse(raw);
      if (Number.isFinite(at) && at > now) return clampCooldown(at - now);
    }
    return upstream.status === 429
      ? RATE_LIMIT_COOLDOWN_MS
      : SERVER_ERROR_COOLDOWN_MS;
  }

  function serve(res, status, body, cacheStatus, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Source': 'adsb.lol',
      'X-Feed-Cache': cacheStatus,
      ...(['HIT', 'STALE'].includes(cacheStatus)
        ? {
            'X-Feed-Age-Ms': String(Math.max(0, Date.now() - _cacheAt)),
          }
        : {}),
      ...extra,
    });
    res.end(body);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/military', async (req, res, next) => {
      const timeoutMs = adsbLolTimeoutMs();
      try {
        // This mount also matches its /track route, served by its own handler.
        if (new URL(req.url || '/', 'http://localhost').pathname !== '/')
          return next();
        const now = Date.now();
        if (_cache && now - _cacheAt < CACHE_MS) {
          serve(res, 200, _cache, 'HIT');
          return;
        }
        if (now < _cooldownUntil) {
          const retryAfter = String(
            Math.ceil((_cooldownUntil - Date.now()) / 1000),
          );
          if (_cache) {
            serve(res, 200, _cache, 'STALE', {
              'X-ADS-B-Upstream-Status': String(_cooldownStatus),
              'X-ADS-B-Retry-After-Seconds': retryAfter,
            });
            return;
          }
          serve(
            res,
            _cooldownStatus || 503,
            JSON.stringify({ error: 'adsb.lol upstream cooling down' }),
            'NONE',
            { 'Retry-After': retryAfter },
          );
          return;
        }
        // Coalesce concurrent refreshes (upstream) into one upstream request.
        // The closure never throws: failures are logged once (Byrd-IT) and
        // returned as a stale/502 result shared by every waiter.
        const refresh = coalesceProxyRequest(inFlight, 'global', async () => {
          const result = (status, body, cacheStatus, extra = {}) => ({
            status,
            body,
            cacheStatus,
            extra,
          });
          let startedAt = 0;
          let upstreamStatus = 0;
          try {
            startedAt = performance.now();
            // Byrd-IT: one deadline (GEV_ADSB_LOL_TIMEOUT_MS, default 30 s)
            // bounds the headers AND the capped body read.
            const signal = AbortSignal.timeout(timeoutMs);
            const upstream = await fetch(ADSB_LOL_MIL_URL, {
              headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
              signal,
            });
            upstreamStatus = upstream.status;
            if (upstream.ok) {
              const body = await readResponseTextCapped(
                upstream,
                ADSBLOL_MIL_MAX_RESPONSE_BYTES,
                signal,
              );
              _cache = body;
              _cacheAt = Date.now();
              _cooldownUntil = 0;
              _cooldownStatus = 0;
              return result(200, body, 'MISS');
            }
            const elapsedMs = () => Math.round(performance.now() - startedAt);
            const failureLine = (body, extra = '') =>
              `[adsb.lol Proxy] upstream ${upstream.status}${extra} target="GET ${ADSB_LOL_MIL_URL}" ` +
              `status=${upstream.status} elapsed_ms=${elapsedMs()} body=${JSON.stringify(redactSnippet(body))}`;
            if (upstream.status === 429 || upstream.status >= 500) {
              const failedAt = Date.now();
              _cooldownUntil = failedAt + cooldownFor(upstream, failedAt);
              _cooldownStatus = upstream.status;
              const cooling = `; cooling down ${Math.round((_cooldownUntil - Date.now()) / 1000)} s${_cache ? ', serving stale' : ''}`;
              if (_cache) {
                // Do not wait for a failing response body before serving
                // usable data: return stale now, then peek the body (bounded)
                // for the log and cancel it.
                peekAndCancel(upstream)
                  .then((snippet) => console.warn(failureLine(snippet, cooling)))
                  .catch(() => {});
                return result(200, _cache, 'STALE', {
                  'X-ADS-B-Upstream-Status': String(upstream.status),
                  'X-ADS-B-Retry-After-Seconds': String(
                    Math.ceil((_cooldownUntil - Date.now()) / 1000),
                  ),
                });
              }
            }
            const body = await readResponseTextCapped(
              upstream,
              ADSBLOL_MIL_MAX_RESPONSE_BYTES,
              signal,
            );
            console.warn(
              failureLine(
                body,
                upstream.status === 429 || upstream.status >= 500
                  ? `; cooling down ${Math.round((_cooldownUntil - Date.now()) / 1000)} s`
                  : '; relayed (no cooldown)',
              ),
            );
            return result(
              upstream.status,
              body,
              'MISS',
              _cooldownUntil > Date.now()
                ? {
                    'Retry-After': String(
                      Math.ceil((_cooldownUntil - Date.now()) / 1000),
                    ),
                  }
                : {},
            );
          } catch (e) {
            console.error(
              `[adsb.lol Proxy] upstream request failed target="GET ${ADSB_LOL_MIL_URL}" ` +
                `class=${failureClass(e)} status=${upstreamStatus || 'none'} ` +
                `elapsed_ms=${startedAt ? Math.round(performance.now() - startedAt) : 0} ` +
                `timeout_ms=${timeoutMs}${_cache ? '; serving stale' : '; relaying 502'}`,
            );
            if (_cache) return result(200, _cache, 'STALE');
            return {
              status: 502,
              body: JSON.stringify({ error: 'ADS-B proxy error' }),
              cacheStatus: 'NONE',
              extra: {},
              plainJson: true,
            };
          }
        });
        const response = await refresh.promise;
        if (response.plainJson) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(response.body);
          return;
        }
        serve(
          res,
          response.status,
          response.body,
          response.cacheStatus,
          response.extra,
        );
      } catch (e) {
        console.error(
          `[adsb.lol Proxy] handler failed class=${failureClass(e)}`,
        );
        if (_cache) {
          serve(res, 200, _cache, 'STALE');
          return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
      }
    });
  };
  return {
    name: 'adsblol-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
