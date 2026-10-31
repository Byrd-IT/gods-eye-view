import path from 'node:path';
import https from 'node:https';
import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';

import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';
import { readResponseTextCapped } from './common/http.js';

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

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * The per-address connection errors behind a fetch failure, or null. Node 24
 * puts the AggregateError directly on `err.cause`; Node 26's fetch wraps it in
 * a ConnectTimeoutError one level deeper.
 * @param {unknown} err
 * @returns {?Array<unknown>}
 */
function connectAttemptErrors(err) {
  let cause = err?.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    if (Array.isArray(cause.errors)) return cause.errors;
    cause = cause.cause;
  }
  return null;
}

/**
 * Describe a fetch failure with its socket-level cause. Node reports every
 * connection failure as `fetch failed`; the cause carries the error code and
 * the address that failed (never the URL, which embeds the MAP_KEY).
 * @param {unknown} err
 * @returns {string}
 */
export function describeFetchError(err) {
  const message = err?.message || String(err);
  const cause = err?.cause;
  if (!cause) return message;
  const attempts = connectAttemptErrors(err);
  const parts = attempts?.length
    ? attempts.map((inner) => inner?.message || inner?.code || String(inner))
    : [cause.message || cause.code || String(cause)];
  return `${message} (${parts.join('; ')})`;
}

/**
 * Whether a fetch failed because every address it tried failed to connect.
 * Node's network-family auto-selection gives each address a short attempt
 * timeout, so a slow IPv4 handshake is abandoned in favour of an unreachable
 * IPv6 address and the whole request fails (#68).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAddressSelectionFailure(err) {
  return err instanceof TypeError && connectAttemptErrors(err)?.length > 0;
}

/**
 * GET over IPv4 only, with one connection attempt bounded by the caller's
 * signal rather than by the auto-selection attempt timeout.
 * @param {string} url
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Response>}
 */
export function fetchIpv4(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        signal,
        family: 4,
        autoSelectFamily: false,
        agent: false,
      },
      (response) => {
        // Nothing thrown here may escape: this callback runs outside the
        // promise, so an exception would be uncaught and crash the server.
        try {
          const status = response.statusCode || 500;
          // A `Response` only represents statuses up to 599; Node never hands
          // this callback a 1xx.
          if (status > 599)
            throw new Error(`FIRMS returned unsupported status ${status}`);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value))
              value.forEach((item) => headers.append(name, item));
            else if (value !== undefined) headers.set(name, String(value));
          }
          const nullBody = NULL_BODY_STATUSES.has(status);
          const upstream = new Response(
            nullBody ? null : Readable.toWeb(response),
            { status, statusText: response.statusMessage || '', headers },
          );
          if (nullBody) response.resume();
          resolve(upstream);
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetch a FIRMS URL, retrying once over IPv4 when address selection fails.
 * Other failures (HTTP status, timeout, DNS) are returned or thrown as is.
 * @param {string} url
 * @param {{signal?: AbortSignal}} options
 * @param {{fetchImpl?: typeof fetch, fetchIpv4Impl?: typeof fetchIpv4, warn?: Function}} [deps]
 * @returns {Promise<Response>}
 */
export async function fetchFirms(
  url,
  options,
  { fetchImpl = fetch, fetchIpv4Impl = fetchIpv4, warn = console.warn } = {},
) {
  try {
    return await fetchImpl(url, options);
  } catch (err) {
    if (!isAddressSelectionFailure(err) || options?.signal?.aborted) throw err;
    warn(`[firms-proxy] ${describeFetchError(err)} — retrying over IPv4`);
    return fetchIpv4Impl(url, options);
  }
}

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) plus MODIS_NRT (combined Terra+Aqua,
 * ~1 km, numeric 0-100 confidence), fetched sequentially (quota courtesy)
 * with `days=2` (`days=1` means "current UTC day", nearly empty just after
 * 00:00Z) and clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS
 * quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): /api/firms → 503 {error:'no_key'}; status →
 * {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function firmsProxy() {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = [
    'VIIRS_NOAA20_NRT',
    'VIIRS_NOAA21_NRT',
    'VIIRS_SNPP_NRT',
    'MODIS_NRT',
  ];
  /**
   * Per-source body cap. A VIIRS world/2 pull is ~130k rows x ~100 B, about
   * 13 MB per satellite in heavy fire season (MODIS runs smaller), so this is a
   * bound, not a budget.
   */
  const FIRMS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** @type {?{at: number, sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, sources: Array<object>, fires: Array<object>}>} single-flight refresh */
  let inflight = null;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
      ) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Never log the URL —
   * it embeds the MAP_KEY.
   */
  async function fetchSource(key, source) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
    const signal = AbortSignal.timeout(60_000);
    // Byrd-IT p16 (R3): failures carry target (MAP_KEY masked), status,
    // elapsed and a redacted body[:300] for the existing per-source line.
    const secrets = [key];
    const startedAt = performance.now();
    const thrown = (error, stage) =>
      p16Annotate(
        error,
        p16ThrownFailure({
          url,
          error,
          startedAt,
          timeoutMs: 60_000,
          secrets,
          stage,
        }),
      );
    let res;
    try {
      res = await fetchFirms(url, { signal });
    } catch (error) {
      throw thrown(error, 'headers');
    }
    if (!res.ok)
      throw p16Annotate(
        new Error(`HTTP ${res.status}`),
        await p16HttpFailure({ url, response: res, startedAt, secrets }),
      );
    let text;
    try {
      text = await readResponseTextCapped(
        res,
        FIRMS_MAX_RESPONSE_BYTES,
        signal,
      );
    } catch (error) {
      throw thrown(error, 'body');
    }
    const records = parseFirmsCsv(text);
    if (records === null)
      // FIRMS reports errors (bad MAP_KEY, quota) as a 200 text/HTML body.
      throw p16Annotate(
        new Error('non-CSV upstream response'),
        `reason=non_csv ${await p16HttpFailure({ url, response: res, startedAt, secrets, text })}`,
      );
    return records;
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(await fetchSource(key, source), now);
        // NOT fires.push(...records): spread passes each record as an argument,
        // and a world/2 VIIRS pull exceeds V8's argument limit (~125k) at
        // ~131k records — RangeError, and the whole source is silently dropped.
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${source} fetch failed:`,
          err?.p16Log || describeFetchError(err),
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: fires.length,
      fires,
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const secrets = [key];
          const startedAt = performance.now();
          let res;
          try {
            res = await fetchFirms(url, {
              signal: AbortSignal.timeout(10_000),
            });
          } catch (error) {
            throw p16Annotate(
              error,
              p16ThrownFailure({
                url,
                error,
                startedAt,
                timeoutMs: 10_000,
                secrets,
                stage: 'headers',
              }),
            );
          }
          if (!res.ok)
            throw p16Annotate(
              new Error(`HTTP ${res.status}`),
              await p16HttpFailure({ url, response: res, startedAt, secrets }),
            );
          // Same result as res.json(), but the text stays for the log when
          // it is not JSON (a parse error message can quote the body).
          let text;
          try {
            text = await res.text();
          } catch (error) {
            throw p16Annotate(
              error,
              p16ThrownFailure({
                url,
                error,
                startedAt,
                timeoutMs: 10_000,
                secrets,
                stage: 'body',
              }),
            );
          }
          let body;
          try {
            body = JSON.parse(text);
          } catch (error) {
            throw p16Annotate(
              error,
              `reason=malformed ${await p16HttpFailure({ url, response: res, startedAt, secrets, text })}`,
            );
          }
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit)
            ? { used, limit }
            : null;
        } catch (err) {
          console.warn(
            '[firms-proxy] mapkey status failed:',
            err?.p16Log || describeFetchError(err),
          );
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => {
          statusInflight = null;
        });
    }
    return statusInflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/firms', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const key = mapKey();
        await readDiskOnce();

        if (subPath === '/status') {
          if (!key) {
            sendJson(200, {
              hasKey: false,
              lastFetch: null,
              count: null,
              stale: false,
              ttlMs: TTL_MS,
              transactions: null,
            });
            return;
          }
          const transactions = await getTransactions(key);
          sendJson(200, {
            hasKey: true,
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.fires.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            transactions,
          });
          return;
        }

        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = mem;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight (concurrent requests
        // share one upstream pass). Capture the promise locally BEFORE
        // awaiting: the .finally() nulls `inflight` the moment it settles.
        if (!inflight) {
          inflight = refreshUpstream(key)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const pending = inflight;
        const fresh = await pending;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'firms fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[firms-proxy] error:', err?.message || err);
        sendJson(500, { error: 'firms proxy error' });
      }
    });
  };
  return {
    name: 'firms-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
