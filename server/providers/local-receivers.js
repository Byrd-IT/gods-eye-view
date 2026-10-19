import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { coalesceProxyRequest, readResponseTextCapped } from './common/http.js';
import { isLocalIpv4, parseTapAddress } from '../../src/data/tapAddress.js';
import { normalizeDump1090Aircraft } from '../../src/sources/adsbRecords.js';

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
 * Local decoder feeds for the Local ADS-B layer.
 *
 * A user who runs dump1090 / readsb / tar1090 (1090 MHz) or dump978-fa +
 * skyaware978 (978 MHz UAT) exposes an `aircraft.json` over HTTP. This route
 * reads those documents and returns them as Local ADS-B records.
 *
 * The feed list comes only from the operator's `LOCAL_RECEIVER_FEEDS`
 * environment value; the browser never supplies an address. Every host must
 * pass the shared receiver-tap address rule (`src/data/tapAddress.js`:
 * loopback, RFC1918, `localhost`, `*.local`), the scheme must be http(s) and
 * the path must end in `aircraft.json`. Invalid entries are logged at startup,
 * reported as `invalid` and never fetched.
 *
 * A name (`localhost`, `*.local`) is resolved before every read; each address
 * it resolves to must itself be loopback or RFC1918, and the connection is
 * pinned to exactly those validated addresses, so a later re-resolution
 * cannot redirect it anywhere else.
 */

export const LOCAL_RECEIVERS_ROUTE = '/api/local-receivers/aircraft';
export const LOCAL_RECEIVER_FEEDS_ENV = 'LOCAL_RECEIVER_FEEDS';
export const LOCAL_RECEIVER_BANDS = Object.freeze(['1090', '978']);
export const LOCAL_RECEIVER_TIMEOUT_MS = 2_000;
export const LOCAL_RECEIVER_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const LOCAL_RECEIVER_CACHE_MS = 1_000;
/** A feed whose own `now` is older than this is reported stale. */
export const LOCAL_RECEIVER_STALE_MS = 10_000;
const MAX_FEEDS = 8;
const LOG_PREFIX = '[local-receivers]';

const BAND_LABELS = Object.freeze({ 1090: '1090 MHz', 978: '978 MHz UAT' });
/** Statuses whose `Response` must be constructed without a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Validate one `band=url` entry.
 * @param {string} entry Raw entry text.
 * @returns {{band:string, url:string}|{band:string|null, reason:string}}
 */
function parseEntry(entry) {
  const separator = entry.indexOf('=');
  if (separator <= 0) return { band: null, reason: 'expected band=url' };
  const band = entry.slice(0, separator).trim();
  const rawUrl = entry.slice(separator + 1).trim();
  if (!LOCAL_RECEIVER_BANDS.includes(band))
    return { band: null, reason: 'band must be 1090 or 978' };
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { band, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { band, reason: 'scheme must be http or https' };
  if (url.username || url.password)
    return { band, reason: 'credentials are not allowed in the URL' };
  if (url.search || url.hash || rawUrl.includes('?') || rawUrl.includes('#'))
    return { band, reason: 'query and fragment are not allowed' };
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  const address = parseTapAddress(`${url.hostname}:${port}`);
  if (!address)
    return {
      band,
      reason: 'host must be loopback, RFC1918, localhost or *.local',
    };
  if (!/(?:^|\/)aircraft\.json$/.test(url.pathname))
    return { band, reason: 'path must end in aircraft.json' };
  return {
    band,
    url: `${url.protocol}//${address.host}:${address.port}${url.pathname}`,
  };
}

/**
 * Parse `LOCAL_RECEIVER_FEEDS` (`band=url[,band=url…]`).
 *
 * Labels name the band only (plus an ordinal when a band repeats), so feed
 * addresses never reach the browser.
 * @param {string|undefined} value Environment value.
 * @returns {{configured:boolean, feeds:object[]}} Each feed is
 *   `{ id, band, label, url }` when valid or `{ id, band, label, reason }`
 *   when invalid (never fetched).
 */
export function parseLocalReceiverFeeds(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const feeds = [];
  const perBand = new Map();
  entries.forEach((entry, index) => {
    const parsed =
      index < MAX_FEEDS
        ? parseEntry(entry)
        : { band: null, reason: `at most ${MAX_FEEDS} feeds are read` };
    const band = parsed.band;
    const ordinal = (perBand.get(band) || 0) + 1;
    perBand.set(band, ordinal);
    const base = band ? BAND_LABELS[band] : `entry ${index + 1}`;
    const label = band && ordinal > 1 ? `${base} #${ordinal}` : base;
    feeds.push({
      id: `feed-${index + 1}`,
      band,
      label,
      ...(parsed.url ? { url: parsed.url } : { reason: parsed.reason }),
    });
  });
  // Ordinals are only needed when a band actually repeats.
  for (const feed of feeds) {
    if (feed.band && perBand.get(feed.band) > 1 && !feed.label.includes('#'))
      feed.label = `${feed.label} #1`;
  }
  return { configured: feeds.length > 0, feeds };
}

class FeedError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Whether a resolved address satisfies the receiver-tap rule: loopback or
 * RFC1918 IPv4, the IPv6 loopback, or an IPv4-mapped form of the former.
 * @param {string} address Resolved IP address.
 * @returns {boolean}
 */
export function isLocalReceiverAddress(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return isLocalIpv4(mapped ? mapped[1] : value);
}

/**
 * Resolve a feed host name and require every address to be local.
 * @param {string} hostname `localhost` or a `*.local` name.
 * @param {typeof dnsLookup} lookupImpl `dns.promises.lookup`-compatible.
 * @returns {Promise<Array<{address:string, family:number}>>}
 */
export async function resolveLocalReceiverAddresses(hostname, lookupImpl) {
  let resolved;
  try {
    resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new FeedError('UNRESOLVED');
  }
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((row) => ({
      address: String(row?.address || ''),
      family:
        Number(row?.family) || (String(row?.address).includes(':') ? 6 : 4),
    }))
    .filter((row) => row.address);
  if (!addresses.length) throw new FeedError('UNRESOLVED');
  if (addresses.some((row) => !isLocalReceiverAddress(row.address)))
    throw new FeedError('FORBIDDEN_ADDRESS');
  return addresses;
}

/**
 * Settle with `promise`, or reject with an AbortError as soon as `signal`
 * aborts; a later settlement of `promise` is ignored.
 */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    // Handlers are attached first so a late rejection is never unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A `net`-style lookup that only ever answers the validated addresses. */
function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options?.all)
      done(
        null,
        addresses.map((row) => ({ ...row })),
      );
    else done(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * Default transport. With `options.lookup` (a pinned feed name) the request
 * is made with node:http(s) so the socket connects only to the validated
 * addresses (TLS still verifies the name); otherwise it is a plain fetch of
 * an IP-literal URL. Redirects are never followed either way.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
function fetchLocalReceiverFeed(url, options) {
  if (typeof options?.lookup !== 'function') return fetch(url, options);
  const client = new URL(url).protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup: options.lookup,
        // A fresh socket per read: a pooled one could outlive the pin.
        agent: false,
      },
      (response) => {
        // Nothing thrown here may escape: this callback runs outside the
        // promise, so an exception would be uncaught and crash the server.
        try {
          const status = response.statusCode;
          // A `Response` only represents final statuses 200–599.
          if (!Number.isInteger(status) || status < 200 || status > 599)
            throw new FeedError('HTTP_STATUS');
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
          if (nullBody) response.destroy();
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
 * Fetch one validated feed document without following redirects and with the
 * body cap enforced while it streams.
 * @param {string} url Validated feed URL.
 * @param {object} options
 * @returns {Promise<object>} Parsed JSON document.
 */
export async function fetchLocalReceiverDocument(
  url,
  {
    fetchImpl = fetchLocalReceiverFeed,
    lookupImpl = dnsLookup,
    timeoutMs = LOCAL_RECEIVER_TIMEOUT_MS,
    maxBytes = LOCAL_RECEIVER_MAX_BODY_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  let startedAt = 0;
  try {
    const { hostname } = new URL(url);
    // IP literals were validated when the feed list was parsed; a name is
    // validated by what it resolves to now, and the socket is pinned there.
    // Resolution runs against the same deadline as the read: a stalled
    // lookup fails this feed instead of holding the whole snapshot.
    const lookup = isLocalIpv4(hostname)
      ? undefined
      : pinnedLookup(
          await untilAborted(
            resolveLocalReceiverAddresses(hostname, lookupImpl),
            controller.signal,
          ),
        );
    startedAt = performance.now();
    upstream = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
      ...(lookup ? { lookup } : {}),
    });
    if (upstream.status >= 300 && upstream.status < 400)
      throw new FeedError('REDIRECT_REFUSED');
    // Opaque redirect responses from `redirect: 'manual'` report status 0.
    if (upstream.type === 'opaqueredirect')
      throw new FeedError('REDIRECT_REFUSED');
    if (!upstream.ok)
      // Byrd-IT p16 (R3): status/elapsed/redacted body[:300] for the
      // status-change line. No target: the feed is logged by its label only.
      throw p16Annotate(
        new FeedError('HTTP_STATUS'),
        await p16HttpFailure({
          url,
          response: upstream,
          startedAt,
          withTarget: false,
        }),
      );
    const text = await readResponseTextCapped(
      upstream,
      maxBytes,
      controller.signal,
    );
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw p16Annotate(
        new FeedError('BAD_JSON'),
        await p16HttpFailure({
          url,
          response: upstream,
          startedAt,
          text,
          withTarget: false,
        }),
      );
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.aircraft))
      throw new FeedError('BAD_DOCUMENT');
    return json;
  } catch (error) {
    controller.abort();
    if (upstream?.body && !upstream.body.locked)
      void upstream.body.cancel().catch(() => {});
    if (error instanceof FeedError) throw error;
    if (error?.code === 'RESPONSE_TOO_LARGE')
      throw new FeedError('RESPONSE_TOO_LARGE');
    if (error?.name === 'AbortError' || controller.signal.aborted)
      throw new FeedError('TIMEOUT');
    throw new FeedError('UNREACHABLE');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read one feed and describe it.
 * @returns {Promise<{status:object, records:object[]}>}
 */
async function readFeed(
  feed,
  { fetchImpl, lookupImpl, now, timeoutMs, maxBytes, log },
) {
  const summary = { band: feed.band, label: feed.label };
  if (!feed.url)
    return {
      status: { ...summary, status: 'invalid', aircraft: 0, ageMs: null },
      records: [],
    };
  let json;
  try {
    json = await fetchLocalReceiverDocument(feed.url, {
      fetchImpl,
      lookupImpl,
      timeoutMs,
      maxBytes,
    });
  } catch (error) {
    log(feed, 'unreachable', error.code, error.p16Log);
    return {
      status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null },
      records: [],
    };
  }
  const receivedAt = now();
  const feedNowS = Number(json.now);
  // The feed's own clock decides staleness. A clock ahead of ours reads as
  // age 0; a document without `now` is treated as current.
  const ageMs = Number.isFinite(feedNowS)
    ? Math.max(0, Math.round(receivedAt - feedNowS * 1000))
    : 0;
  const status = ageMs > LOCAL_RECEIVER_STALE_MS ? 'stale' : 'live';
  log(feed, status);
  // Anchor record ages at the document time so a stale feed ages out
  // naturally, without trusting a receiver clock that runs ahead of ours.
  const records = normalizeDump1090Aircraft(json, receivedAt - ageMs, {
    band: feed.band,
  });
  return {
    status: { ...summary, status, aircraft: records.length, ageMs },
    records,
  };
}

/**
 * Build the route handler. Exposed for tests; the plugin wraps it.
 * @param {object} [options]
 * @param {string} [options.feedsValue] `LOCAL_RECEIVER_FEEDS` value.
 * @param {typeof fetch} [options.fetchImpl] Receives `options.lookup` when
 *   the feed host is a name; the connection must resolve only through it.
 * @param {Function} [options.lookupImpl] `dns.promises.lookup`-compatible.
 * @param {() => number} [options.now]
 * @param {{warn:Function, info?:Function}} [options.logger]
 * @returns {{handle:Function, config:object}}
 */
export function createLocalReceiversHandler({
  feedsValue = process.env[LOCAL_RECEIVER_FEEDS_ENV],
  fetchImpl = fetchLocalReceiverFeed,
  lookupImpl = dnsLookup,
  now = Date.now,
  logger = console,
  timeoutMs = LOCAL_RECEIVER_TIMEOUT_MS,
  maxBytes = LOCAL_RECEIVER_MAX_BODY_BYTES,
  cacheMs = LOCAL_RECEIVER_CACHE_MS,
} = {}) {
  const config = parseLocalReceiverFeeds(feedsValue);
  for (const feed of config.feeds) {
    if (feed.reason)
      logger.warn(
        `${LOG_PREFIX} ${LOCAL_RECEIVER_FEEDS_ENV} ${feed.id} (${feed.label}) rejected: ${feed.reason}. It will not be fetched.`,
      );
  }
  const lastStatus = new Map();
  // Log a feed only when its status changes, so a feed that is down does not
  // write a line every second.
  const log = (feed, status, code, detail) => {
    if (lastStatus.get(feed.id) === status) return;
    lastStatus.set(feed.id, status);
    if (status === 'live') logger.info?.(`${LOG_PREFIX} ${feed.label} live`);
    else
      logger.warn(
        `${LOG_PREFIX} ${feed.label} ${status}${code ? ` (${code})` : ''}${
          typeof detail === 'string' && detail ? ` ${detail}` : ''
        }`,
      );
  };
  const inFlight = new Map();
  let cached = null;

  async function snapshot() {
    const results = await Promise.all(
      config.feeds.map((feed) =>
        readFeed(feed, {
          fetchImpl,
          lookupImpl,
          now,
          timeoutMs,
          maxBytes,
          log,
        }),
      ),
    );
    return {
      configured: true,
      generatedAt: now(),
      feeds: results.map((result) => result.status),
      records: results.flatMap((result) => result.records),
    };
  }

  async function payload() {
    if (!config.configured)
      return { configured: false, feeds: [], records: [] };
    if (cached && now() - cached.at < cacheMs) return cached.payload;
    const { promise } = coalesceProxyRequest(inFlight, 'all', snapshot);
    const result = await promise;
    cached = { at: now(), payload: result };
    return result;
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    try {
      const body = await payload();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    } catch {
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Local receiver feeds unavailable' }));
    }
  }

  return { handle, config };
}

/**
 * Vite plugin mounting `GET /api/local-receivers/aircraft`.
 *
 * The environment is read when the server starts, so construction alone
 * neither parses configuration nor fetches anything.
 * @param {object} [options] Passed to {@link createLocalReceiversHandler}.
 * @returns {import('vite').Plugin}
 */
export function localReceiversProxy(options = {}) {
  const install = (server) => {
    const { handle } = createLocalReceiversHandler(options);
    server.middlewares.use(LOCAL_RECEIVERS_ROUTE, (req, res, next) => {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path !== '/' && path !== '') {
        if (typeof next === 'function') return next();
        return undefined;
      }
      return handle(req, res);
    });
  };
  return {
    name: 'local-receivers-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
