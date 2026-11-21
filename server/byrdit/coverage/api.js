// Byrd-IT: server-side proxy for the owner-approved GEV photo coverage page.
//
// Browser routes, all behind the same trusted-proxy identity the plan library
// uses (`libraryIdentity`: X-GEV-User only from a GEV_TRUSTED_PROXIES peer):
//
//   GET  /api/byrdit/coverage                 static model list
//   GET  /api/byrdit/coverage/models          static model list
//   GET  /api/byrdit/coverage/:model/model.json
//   GET  /api/byrdit/coverage/:model/photos.json
//   GET  /api/byrdit/coverage/:model/cells.json
//   GET  /api/byrdit/coverage/:model/points.bin
//   GET  /api/byrdit/coverage/:model/thumbs/<name>.jpg
//   GET  /api/byrdit/coverage/:model/keepsets.json
//   GET  /api/byrdit/coverage/:model/keepsets/:id.json|:id.train_exclude.txt
//   POST /api/byrdit/coverage/:model/keepsets
//
// Upstream is the fixed private origin, one credential path segment, then
// `/cov/<model>/...`:
//
//   http://10.10.99.103:8791/<credential>/cov/<model>/...
//
// The credential is read per request from /etc/gods-eye-view/coverage-token
// and is never sent to the browser, written to a log, carried in an error,
// placed in a redirect, or accepted from a request.
// The origin and the upstream paths are built here; a browser can never choose
// an origin, and every 3xx from upstream is refused. Only the fixed upstream
// headers below are sent; no browser header is forwarded.
//
// The upstream denies cov/index.json, so the list is local and explicit:
// s4_today, s6_shop800, nov16plus. `state: 'configured'` says only that this
// proxy knows the model; it is not a claim about upstream health.

import { readFileSync } from 'node:fs';
import { readResponseBytesCapped } from '../../providers/common/http.js';
import { admitsStateChange } from '../planLibrary/api.js';
import { libraryIdentity } from '../planLibrary/identity.js';

export const COVERAGE_API_PREFIX = '/api/byrdit/coverage';
/** The one private origin this proxy may reach. Never configurable. */
export const COVERAGE_ORIGIN = 'http://10.10.99.103:8791';
/** The S4 runtime's credential file. */
export const COVERAGE_TOKEN_PATH = '/etc/gods-eye-view/coverage-token';

/** Only these model directories exist; cov/index.json is denied upstream. */
export const COVERAGE_MODEL_IDS = Object.freeze([
  's4_today',
  's6_shop800',
  'nov16plus',
]);
export const COVERAGE_MODELS = Object.freeze(
  COVERAGE_MODEL_IDS.map((id) => Object.freeze({ id, state: 'configured' })),
);

/** Upstream fetch deadline. */
export const COVERAGE_UPSTREAM_TIMEOUT_MS = 15_000;
/** Largest keepsets POST body this proxy accepts. */
export const COVERAGE_POST_BODY_BYTES = 1024 * 1024;
/** Longest request target this proxy considers. */
export const COVERAGE_MAX_TARGET_BYTES = 1024;


/**
 * Per-asset response caps. These are deliberate, conservative limits, not
 * values learned from the origin: a coverage model that needs a larger
 * points.bin or photos.json should raise the constant (or the handler's
 * `limits` option) rather than removing the cap.
 */
export const COVERAGE_ASSET_LIMITS = Object.freeze({
  'model.json': 2 * 1024 * 1024,
  'photos.json': 16 * 1024 * 1024,
  'cells.json': 16 * 1024 * 1024,

  'points.bin': 64 * 1024 * 1024,
  thumbs: 8 * 1024 * 1024,
  keepsets: 4 * 1024 * 1024,
});

const JSON_ASSETS = new Set([
  'model.json',
  'photos.json',
  'cells.json',

]);

const IMAGE_BY_EXT = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
});
const IMAGE_TYPES = new Set(Object.values(IMAGE_BY_EXT));

/** Error messages are fixed strings: no path, URL or credential can enter one. */
const MESSAGES = Object.freeze({
  'bad-target': 'The request target is malformed',
  'no-identity': 'No library identity',
  csrf: 'Missing or foreign request origin',
  'not-found': 'No such coverage route',
  method: 'Method not allowed',
  'too-large': 'The request is too large',
  'unsupported-media': 'The request body must be JSON',
  'client-aborted': 'The request was aborted',
  'coverage-unavailable': 'The coverage service is unavailable',
  'upstream-timeout': 'The coverage origin timed out',
  'upstream-redirect': 'The coverage origin redirected',
  'upstream-refused': 'The coverage origin refused the request',
  'upstream-too-large': 'The coverage origin response is too large',
  'upstream-leak': 'The coverage origin response was refused',
  'upstream-error': 'The coverage origin failed',
  internal: 'Internal error',
});

/** The error codes worth a sanitized log line. */
const LOGGABLE = new Set([
  'internal',
  'upstream-error',
  'upstream-redirect',
  'upstream-leak',
  'upstream-timeout',
  'upstream-too-large',
  'upstream-refused',
]);

export class CoverageError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {Record<string, string>} [headers]
   */
  constructor(code, status, headers = undefined) {
    super(MESSAGES[code] ?? MESSAGES.internal);
    this.name = 'CoverageError';
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

/** A credential is one URL-safe path segment; `.`/`..` are not credentials. */
const SAFE_TOKEN = /^[A-Za-z0-9._~+=-]{1,512}$/;
export function isSafeCoverageToken(value) {
  return (
    typeof value === 'string' &&
    SAFE_TOKEN.test(value) &&
    !value.startsWith('.')
  );
}

/** A model/asset/keepset path segment: printable, bounded, no dot-files. */
const SAFE_SEGMENT = /^[A-Za-z0-9._~+=-]{1,128}$/;
export function isSafeCoverageSegment(value) {
  return (
    typeof value === 'string' &&
    SAFE_SEGMENT.test(value) &&
    !value.startsWith('.')
  );
}

/**
 * The credential as read from disk, trimmed. Production always uses the fixed
 * path; the optional argument exists only so a test can point at a synthetic
 * file. The credential value never comes from the environment or a request.
 * @param {string} [file]
 * @returns {string}
 */
export function defaultReadToken(file = COVERAGE_TOKEN_PATH) {
  return readFileSync(file, 'utf8').trim();
}

const PREFIX_SEGMENTS = Object.freeze(
  COVERAGE_API_PREFIX.split('/').filter(Boolean),
);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COVERAGE_TARGET = new RegExp(
  `^(?:[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*)?${escapeRegExp(
    COVERAGE_API_PREFIX,
  )}(?=[/?#]|$)`,
);
const TARGET_PARTS =
  /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?$/;

/** Whether a raw request target names this API (origin-form or absolute-form). */
export function isCoverageTarget(raw) {
  return typeof raw === 'string' && COVERAGE_TARGET.test(raw);
}

/**
 * Parse a raw request target into route segments.
 *
 * Percent escapes, backslashes, fragments, any query and control characters
 * are refused outright. Dot segments (literal or encoded) can therefore never
 * reach the upstream URL: the only accepted characters are the URL-unreserved
 * set plus `+` and `=`, and a segment may not begin with a dot.
 *
 * @param {unknown} raw
 * @returns {{ rest: string[] } | { bad: true } | null} null = not this API
 */
export function parseCoverageTarget(raw) {
  if (!isCoverageTarget(raw)) return null;
  // Reject traversal/encoding tricks before any URL parser can normalize them
  // away (`/a/../b` becomes `/b` in WHATWG URL).
  if (
    raw.length > COVERAGE_MAX_TARGET_BYTES ||
    raw.includes('%') ||
    raw.includes('\\') ||
    raw.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(raw)
  )
    return { bad: true };
  const match = TARGET_PARTS.exec(raw);
  if (!match) return { bad: true };
  if (match[2]) return { bad: true }; // a query string is not part of this API
  const parts = match[1].split('/');
  if (parts[0] !== '') return { bad: true };
  parts.shift();
  if (parts.at(-1) === '') parts.pop();
  if (parts.length < PREFIX_SEGMENTS.length) return { bad: true };
  for (let index = 0; index < PREFIX_SEGMENTS.length; index += 1) {
    if (parts[index] !== PREFIX_SEGMENTS[index]) return { bad: true };
  }
  const rest = parts.slice(PREFIX_SEGMENTS.length);
  if (rest.some((part) => !isSafeCoverageSegment(part))) return { bad: true };
  return { rest };
}

function limitFor(name, overrides) {
  const candidate = Number(overrides?.[name]);
  return Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : COVERAGE_ASSET_LIMITS[name];
}

/**
 * Match the route segments after /api/byrdit/coverage. Unknown paths return
 * null (404); this is a closed allowlist, never a passthrough.
 * @param {string[]} rest
 * @param {Record<string, unknown>} limits
 */
export function matchCoverageRoute(rest, limits = {}) {
  if (!rest.length || (rest.length === 1 && rest[0] === 'models')) {
    return { kind: 'models', allow: ['GET'] };
  }
  const [model, ...tail] = rest;
  if (!COVERAGE_MODEL_IDS.includes(model) || !tail.length) return null;
  const name = tail.join('/');
  if (tail.length === 1 && JSON_ASSETS.has(name)) {
    return {
      kind: 'json',
      model,
      upstream: ['cov', model, name],
      maxBytes: limitFor(name, limits),
      allow: ['GET'],
    };
  }
  if (tail.length === 1 && name === 'points.bin') {
    return {
      kind: 'binary',
      model,
      upstream: ['cov', model, name],
      maxBytes: limitFor(name, limits),
      allow: ['GET'],
    };
  }
  if (tail[0] === 'thumbs') {
    if (tail.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.jpg$/.test(tail[1]))
      return null;
    return {
      kind: 'thumb',
      model,
      upstream: ['cov', model, ...tail],
      maxBytes: limitFor('thumbs', limits),
      allow: ['GET'],
    };
  }
  if (tail.length === 1 && tail[0] === 'keepsets.json') {
    return { kind: 'keepsets', model, upstream: ['cov', model, 'keepsets.json'], maxBytes: limitFor('keepsets', limits), allow: ['GET'] };
  }
  if (tail.length === 1 && tail[0] === 'keepsets') {
    return { kind: 'keepsets', model, upstream: ['cov', model, 'keepsets'], maxBytes: limitFor('keepsets', limits), allow: ['POST'] };
  }
  if (tail.length === 2 && tail[0] === 'keepsets' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:json|train_exclude\.txt)$/.test(tail[1])) {
    return { kind: tail[1].endsWith('.txt') ? 'text' : 'keepset', model, upstream: ['cov', model, 'keepsets', tail[1]], maxBytes: limitFor('keepsets', limits), allow: ['GET'] };
  }
  return null;
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [name, value] of Object.entries(headers))
    res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function sendEmpty(res, status) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end();
}

function sendBytes(res, status, bytes, contentType) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', String(bytes.length));
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(bytes);
}

/**
 * A thumbs extension decides the type first; only raster upstream types are
 * trusted, so an upstream `image/svg+xml` (or `text/html`) never reaches the
 * browser as itself.
 */
function thumbContentType(route, upstreamType) {
  const last = route.upstream.at(-1);
  const dot = last.lastIndexOf('.');
  const extension = dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  if (IMAGE_BY_EXT[extension]) return IMAGE_BY_EXT[extension];
  const type = String(upstreamType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return IMAGE_TYPES.has(type) ? type : 'application/octet-stream';
}

/** Read a keepsets POST body without ever buffering more than `limit` bytes. */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) {
        // Drain up to one more limit so the 413 can reach the client, then cut
        // an endless body off.
        size += chunk.length;
        if (size > limit * 2) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new CoverageError('too-large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks, size));
    });
    req.on('error', () => reject(new CoverageError('client-aborted', 499)));
    // A client that leaves mid-body must settle the promise; the rejected
    // answer is discarded because its response socket is already gone.
    req.on('close', () => reject(new CoverageError('client-aborted', 499)));
  });
}

/** Drop a response body we will not read; never let that cleanup throw. */
async function discardBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // A body that cannot be cancelled is already unusable to the caller.
  }
}

/**
 * Fetch one fixed-origin upstream path. Never follows redirects, never copies
 * an upstream header, and refuses any success body that contains the
 * credential. Every credential `isSafeCoverageToken` accepts is scanned,
 * including short values: a reflection is refused closed rather than risk
 * forwarding one to the browser.
 */
async function callUpstream({
  res,
  method,
  token,
  segments,
  body,
  maxBytes,
  json,
  fetchImpl,
  timeoutMs,
}) {
  const url = `${COVERAGE_ORIGIN}/${token}/${segments.join('/')}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on?.('close', onClose);
  const headers = {
    Accept: json ? 'application/json' : '*/*',
    'User-Agent': 'gods-eye-view-coverage-proxy/1.0',
  };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(method === 'POST' ? { body } : {}),
      });
    } catch (error) {
      if (timedOut) throw new CoverageError('upstream-timeout', 504);
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
        throw new CoverageError('upstream-timeout', 504);
      throw new CoverageError('upstream-error', 502);
    }

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw new CoverageError('upstream-redirect', 502);
    }
    if (response.redirected) {
      await discardBody(response);
      throw new CoverageError('upstream-redirect', 502);
    }
    if (response.url) {
      let origin = null;
      try {
        origin = new URL(response.url).origin;
      } catch {
        origin = null;
      }
      if (origin !== COVERAGE_ORIGIN) {
        await discardBody(response);
        throw new CoverageError('upstream-redirect', 502);
      }
    }
    if (response.status === 404) {
      await discardBody(response);
      throw new CoverageError('not-found', 404);
    }
    // 206 would hand the browser a partial object as if it were whole; other
    // non-2xx statuses are refusals whose body must never reach the browser.
    if (response.status === 206 || !response.ok) {
      await discardBody(response);
      throw new CoverageError('upstream-refused', 502);
    }
    if (method === 'GET' && response.status !== 200) {
      await discardBody(response);
      throw new CoverageError('upstream-refused', 502);
    }

    const bytes = await readResponseBytesCapped(
      response,
      maxBytes,
      controller.signal,
    );
    const bodyBytes = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    // Scan for every accepted credential, however short. A token is a
    // credential regardless of length, and a false positive is a refused
    // response (fail closed), never a leaked one.
    if (bodyBytes.includes(Buffer.from(token, 'utf8'))) {
      throw new CoverageError('upstream-leak', 502);
    }
    return {
      status: response.status,
      bytes,
      contentType: response.headers.get('content-type'),
    };
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    if (error?.code === 'RESPONSE_TOO_LARGE')
      throw new CoverageError('upstream-too-large', 502);
    if (timedOut) throw new CoverageError('upstream-timeout', 504);
    throw new CoverageError('upstream-error', 502);
  } finally {
    clearTimeout(timer);
    res.off?.('close', onClose);
  }
}

async function route(req, res, rest, options) {
  const matched = matchCoverageRoute(rest, options.limits);
  if (!matched) throw new CoverageError('not-found', 404);
  const method = req.method;
  if (!matched.allow.includes(method)) {
    throw new CoverageError('method', 405, {
      Allow: matched.allow.join(', '),
    });
  }
  const write = method === 'POST';
  if (write && !admitsStateChange(req))
    throw new CoverageError('csrf', 403);

  if (matched.kind === 'models') {
    return sendJson(res, 200, {
      source: 'static',
      models: COVERAGE_MODELS,
    });
  }

  // Validate what can be validated without touching the credential file.
  if (write) {
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json')
      throw new CoverageError('unsupported-media', 415);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > options.postBodyLimit)
      throw new CoverageError('too-large', 413);
  }

  let token;
  try {
    token = String(await options.readToken()).trim();
  } catch {
    // The reader's error can name the file or contain anything else; it is
    // deliberately discarded.
    throw new CoverageError('coverage-unavailable', 503);
  }
  if (!isSafeCoverageToken(token))
    throw new CoverageError('coverage-unavailable', 503);

  const body = write
    ? await readRequestBody(req, options.postBodyLimit)
    : undefined;
  const upstream = await callUpstream({
    res,
    method,
    token,
    segments: matched.upstream,
    body,
    maxBytes: matched.maxBytes,
    json:
      matched.kind === 'json' ||
      matched.kind === 'keepsets' ||
      matched.kind === 'keepset',
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  if (write && upstream.status === 204) return sendEmpty(res, 204);
  if (
    matched.kind === 'json' ||
    matched.kind === 'keepsets' ||
    matched.kind === 'keepset'
  )
    return sendBytes(
      res,
      upstream.status,
      upstream.bytes,
      'application/json; charset=utf-8',
    );
  if (matched.kind === 'text')
    return sendBytes(res, upstream.status, upstream.bytes, 'text/plain; charset=utf-8');
  if (matched.kind === 'binary')
    return sendBytes(
      res,
      upstream.status,
      upstream.bytes,
      'application/octet-stream',
    );
  return sendBytes(
    res,
    upstream.status,
    upstream.bytes,
    thumbContentType(matched, upstream.contentType),
  );
}

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetchImpl?: typeof fetch,
 *   readToken?: () => string|Promise<string>,
 *   logger?: { error: (...args: unknown[]) => void },
 *   timeoutMs?: number,
 *   postBodyLimit?: number,
 *   limits?: Record<string, number>,
 * }} [options]
 * @returns {(req, res, next?) => void}
 */
export function createCoverageHandler({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  readToken = () => defaultReadToken(),
  logger = console,
  timeoutMs = COVERAGE_UPSTREAM_TIMEOUT_MS,
  postBodyLimit = COVERAGE_POST_BODY_BYTES,
  limits = {},
} = {}) {
  const options = {
    env,
    fetchImpl,
    readToken,
    // An invalid override must not turn a limit off.
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : COVERAGE_UPSTREAM_TIMEOUT_MS,
    postBodyLimit:
      Number.isSafeInteger(postBodyLimit) && postBodyLimit > 0
        ? postBodyLimit
        : COVERAGE_POST_BODY_BYTES,
    limits,
  };
  return function coverageHandler(req, res, next) {
    const target = parseCoverageTarget(req?.url);
    if (target === null)
      return typeof next === 'function'
        ? next()
        : sendJson(res, 404, { error: 'not-found' });
    if (target.bad)
      return sendJson(res, 400, {
        error: 'bad-target',
        message: MESSAGES['bad-target'],
      });
    if (!libraryIdentity(req, env))
      return sendJson(res, 401, { error: 'no-identity' });

    route(req, res, target.rest, options).catch((error) => {
      const safe =
        error instanceof CoverageError
          ? error
          : new CoverageError('internal', 500);
      if (LOGGABLE.has(safe.code)) {
        try {
          // A fixed code only: never an upstream message, URL or credential.
          logger.error(`coverage proxy: ${safe.code}`);
        } catch {
          // Logging must never change the answer.
        }
      }
      return sendJson(
        res,
        safe.status,
        { error: safe.code, message: safe.message },
        safe.headers,
      );
    });
  };
}

export function coveragePlugins(options = {}) {
  const handler = createCoverageHandler(options);
  // A block body on purpose: Vite calls whatever configureServer returns as a
  // post hook, and connect's `use` returns the app itself, so an arrow that
  // returned it would have Vite call the app with no request at startup.
  const install = (server) => {
    server.middlewares.use(handler);
  };
  return [
    {
      name: 'byrdit-coverage',
      configureServer: install,
      configurePreviewServer: install,
    },
  ];
}
