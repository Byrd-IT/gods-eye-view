import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { readResponseBytesCapped } from './common/http.js';
import {
  isValidTileCoord as isValidTomTomTile,
  utcDayKey as tomtomUtcDayKey,
  normalizeBudget as normalizeTomTomBudget,
  isOverBudget as isTomTomOverBudget,
} from '../../src/data/tomtomTiles.js';
import { admitSameSite } from './common/same-site.js';

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

/**
 * TomTom traffic-flow vector-tile proxy with a daily budget governor.
 *
 * Upstream: https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf
 * (style `relative`; the response is an UNCOMPRESSED Mapbox Vector Tile, layer
 * "Traffic flow"). The key comes from TOMTOM_API_KEY server-side only — the
 * browser fetches same-origin `/api/tomtom/flow/{z}/{x}/{y}.pbf`.
 *
 * Cache: memory + disk (.gev-cache/tomtom/), TTL 120 s (traffic is fresh
 * data), single-flight per tile, serve-stale-on-failure — the celestrakProxy
 * pattern. Cache hits never count against the budget.
 *
 * Budget governor (mirrors the OpenSky credit-governor philosophy — last-good
 * data beats a dead layer): a persistent counter (.gev-cache/tomtom/budget.json,
 * keyed by UTC date, reset on day change) counts upstream fetch attempts
 * against a soft cap (TOMTOM_DAILY_TILE_BUDGET). Over the cap the proxy
 * serves stale tiles when available, else 429 {error:'budget'}.
 *
 * The default is derived from TomTom's published free allowance, which is
 * granted MONTHLY, not daily: 200,000 Traffic Flow & Incidents tile requests
 * per month (https://docs.tomtom.com/pricing/). The previous 40,000/day
 * default — and the "~50k/day" figure this comment used to cite — exhausted
 * a month's entire allowance in five days, leaving the traffic layer dead
 * for the rest of the billing period. 6,000/day keeps a full 31-day month
 * inside the allowance (186,000) with headroom to spare.
 *
 * Cross-site gate: both routes refuse cross-site browser requests with 403
 * (the gate Mapillary, OpenAI and Places already use). Every uncached tile is
 * a billed upstream attempt counted against the persistent daily budget, so
 * without the gate any web page the user visits could fire `<img>` requests
 * at distinct tiles, spend the TomTom quota and leave the traffic layer on
 * 429 budget for the rest of the UTC day.
 *
 * GET /api/tomtom/status → {hasKey, dailyCount, budget, date}. Keyless mode:
 * status reports hasKey:false and the tile endpoint 503s {error:'no_key'}
 * without touching upstream — the traffic layer then stays in simulation mode.
 *
 * @returns {import('vite').Plugin}
 */
export function tomtomProxy() {
  const TILE_TTL_MS = 120_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'tomtom');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');
  // 200,000/month free tier / 31 days = 6,451. Rounded down for headroom.
  const DEFAULT_DAILY_BUDGET = 6000;
  const MEM_MAX_ENTRIES = 256;
  const UPSTREAM_TIMEOUT_MS = 15000;
  /** Flow tiles are well under 1 MB; this bounds a runaway body, not a budget. */
  const TOMTOM_TILE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  /** @type {Map<string, {at:number, buf:Buffer}>} tile key `z/x/y` -> cached tile (kept past TTL for serve-stale). */
  const mem = new Map();
  /** @type {Map<string, Promise<{at:number, buf:Buffer}|null>>} single-flight per tile. */
  const inflight = new Map();

  /** @type {{date:string, count:number}|null} lazily-loaded persistent counter. */
  let budget = null;
  let budgetLoaded = false;

  function dailyBudgetLimit() {
    const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
  }

  async function loadBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
      if (
        parsed &&
        typeof parsed.date === 'string' &&
        Number.isFinite(parsed.count)
      ) {
        budget = parsed;
      }
    } catch {
      /* no budget file yet */
    }
  }

  async function persistBudget() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    } catch (err) {
      console.warn('[tomtom-proxy] budget write failed:', err?.message || err);
    }
  }

  /** Roll the counter to today (UTC) and return it. */
  function currentBudget() {
    budget = normalizeTomTomBudget(budget, tomtomUtcDayKey());
    return budget;
  }

  /** Count one upstream fetch attempt against today's budget (async persist). */
  function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
  }

  const tilePath = (key) =>
    path.join(CACHE_DIR, `flow-${key.replaceAll('/', '-')}.pbf`);

  /** Disk-cache read; tile age comes from the file's mtime. */
  async function readDiskTile(key) {
    try {
      const [stat, buf] = await Promise.all([
        fsp.stat(tilePath(key)),
        fsp.readFile(tilePath(key)),
      ]);
      return { at: stat.mtimeMs, buf };
    } catch {
      return null;
    }
  }

  async function writeDiskTile(key, buf) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(tilePath(key), buf);
    } catch (err) {
      console.warn(
        `[tomtom-proxy] tile cache write failed for ${key}:`,
        err?.message || err,
      );
    }
  }

  /** LRU-ish memory insert (Map preserves insertion order; evict the oldest). */
  function memSet(key, entry) {
    if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
      const oldest = mem.keys().next().value;
      mem.delete(oldest);
    }
    mem.set(key, entry);
  }

  async function fetchUpstream(z, x, y) {
    const url =
      'https://api.tomtom.com/traffic/map/4/tile/flow/relative/' +
      `${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
    recordUpstreamFetch(); // attempts count — upstream bills the request either way
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    // Byrd-IT p16 (R3): failures carry target/status/elapsed/body[:300] for
    // the existing "fetch failed" line. The key is masked (query dropped,
    // echoes redacted).
    const secrets = [String(process.env.TOMTOM_API_KEY || '')];
    const startedAt = performance.now();
    const thrown = (error, stage) =>
      p16Annotate(
        error,
        p16ThrownFailure({
          url,
          error,
          startedAt,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          secrets,
          stage,
        }),
      );
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (error) {
      throw thrown(error, 'headers');
    }
    if (!res.ok)
      throw p16Annotate(
        new Error(`HTTP ${res.status}`),
        await p16HttpFailure({ url, response: res, startedAt, secrets }),
      );
    let bytes;
    try {
      bytes = await readResponseBytesCapped(
        res,
        TOMTOM_TILE_MAX_RESPONSE_BYTES,
        signal,
      );
    } catch (error) {
      throw thrown(error, 'body');
    }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length === 0) throw new Error('empty tile body');
    return buf;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/tomtom', async (req, res) => {
      // Gate first: a cross-site <img>/fetch must not reach the budget counter.
      if (admitSameSite(req, res)) return;
      // Sanitized responses only (proxy/security baseline): no upstream
      // error details, and never echo the key or the upstream URL.
      const sendJson = (status, obj, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(obj));
      };
      const sendTile = (buf, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'application/x-protobuf',
          'Cache-Control': 'no-store',
          'x-tomtom-cache': cacheStatus,
        });
        res.end(buf);
      };

      try {
        await loadBudgetOnce();
        const urlPath = String(req.url || '').split('?')[0];

        if (urlPath === '/status') {
          const hasKey = Boolean(process.env.TOMTOM_API_KEY);
          const b = currentBudget();
          sendJson(200, {
            hasKey,
            dailyCount: b.count,
            budget: dailyBudgetLimit(),
            date: b.date,
          });
          return;
        }

        const m = urlPath.match(/^\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        if (!isValidTomTomTile(z, x, y)) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }
        if (!process.env.TOMTOM_API_KEY) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const key = `${z}/${x}/${y}`;
        const now = Date.now();

        let entry = mem.get(key);
        if (!entry) {
          entry = await readDiskTile(key);
          if (entry) memSet(key, entry);
        }
        // Fresh cache hit — never counts against the budget.
        if (entry && now - entry.at < TILE_TTL_MS) {
          sendTile(entry.buf, 'HIT');
          return;
        }

        // Budget governor: over the soft cap, last-good data beats a dead layer.
        if (isTomTomOverBudget(currentBudget(), dailyBudgetLimit())) {
          if (entry) {
            sendTile(entry.buf, 'STALE-BUDGET');
          } else {
            sendJson(429, { error: 'budget' });
          }
          return;
        }

        // Stale or missing → refresh, single-flight per tile.
        if (!inflight.has(key)) {
          inflight.set(
            key,
            fetchUpstream(z, x, y)
              .then(async (buf) => {
                const fresh = { at: Date.now(), buf };
                memSet(key, fresh);
                await writeDiskTile(key, buf);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[tomtom-proxy] ${key} fetch failed (${err?.p16Log || err?.message || err}) — serving stale if any`,
                );
                return null;
              })
              .finally(() => inflight.delete(key)),
          );
        }
        const fresh = await inflight.get(key);
        if (fresh) {
          sendTile(fresh.buf, 'MISS');
        } else if (entry) {
          sendTile(entry.buf, 'STALE-ERROR'); // upstream down — stale beats empty
        } else {
          sendJson(502, { error: 'upstream' });
        }
      } catch (err) {
        console.warn('[tomtom-proxy] error:', err?.message || err);
        sendJson(500, { error: 'proxy' });
      }
    });
  };
  return {
    name: 'tomtom-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
