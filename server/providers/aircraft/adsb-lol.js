const ADSB_LOL_MIL_URL = 'https://api.adsb.lol/v2/mil';
/** Upstream request timeout (ms); bounds the headers AND the body read. */
export const ADSB_LOL_TIMEOUT_MS = 10_000;

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

/** First 300 bytes of an upstream body for a log line, markup and secrets removed. */
function redactSnippet(text, max = 300) {
  return String(text ?? '')
    .slice(0, 4096)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 REDACTED')
    .replace(
      /([?&](?:key|api_?key|token|access_token|secret|password|sig|signature)=)[^&\s"']*/gi,
      '$1REDACTED',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** @type {number} Epoch-ms until which upstream is not contacted. */
  let _cooldownUntil = 0;
  /** @type {number} Upstream status that started the current cooldown. */
  let _cooldownStatus = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
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
      let startedAt = 0;
      let upstreamStatus = 0;
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
        startedAt = performance.now();
        const upstream = await fetch(ADSB_LOL_MIL_URL, {
          headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
          signal: AbortSignal.timeout(ADSB_LOL_TIMEOUT_MS),
        });
        upstreamStatus = upstream.status;
        if (upstream.ok) {
          const body = await upstream.text();
          _cache = body;
          _cacheAt = Date.now();
          _cooldownUntil = 0;
          _cooldownStatus = 0;
          serve(res, 200, body, 'MISS');
          return;
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
            // Do not wait for a failing response body before serving usable data:
            // serve stale first, then peek the body (bounded) for the log and
            // cancel it.
            serve(res, 200, _cache, 'STALE', {
              'X-ADS-B-Upstream-Status': String(upstream.status),
              'X-ADS-B-Retry-After-Seconds': String(
                Math.ceil((_cooldownUntil - Date.now()) / 1000),
              ),
            });
            const snippet = await peekAndCancel(upstream);
            console.warn(failureLine(snippet, cooling));
            return;
          }
          const body = await upstream.text();
          console.warn(failureLine(body, cooling));
          serve(res, upstream.status, body, 'MISS', {
            'Retry-After': String(
              Math.ceil((_cooldownUntil - Date.now()) / 1000),
            ),
          });
          return;
        }
        const body = await upstream.text();
        console.warn(failureLine(body, '; relayed (no cooldown)'));
        serve(
          res,
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
            `timeout_ms=${ADSB_LOL_TIMEOUT_MS}${_cache ? '; serving stale' : '; relaying 502'}`,
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
