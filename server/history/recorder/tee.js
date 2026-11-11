/**
 * Response tee for the history recorder. For a proxy route that already serves
 * a normalised payload, this middleware watches the response on its way out
 * and hands a copy to the recorder. It never fetches anything, never changes a
 * byte or a header of the response, and does its parsing after the response is
 * sent.
 *
 * A route entry (see routes.js) says which path it watches and how to turn the
 * response into the input of the feed's adapter:
 *
 *   feed      history feed name; the route is ignored unless that feed records
 *   match     (url) => context | null     path test; context is passed along
 *   parse     'json' | 'text'
 *   payload   (parsed, context, { res }) => adapter input | SKIP | FAILED
 *   observe   true: the route is read only to learn from (no feed is recorded for it)
 *   isReplay  (res) => true when the proxy marks this answer as a cache replay
 *   pollAt    (parsed, context, { res }) => ms the data was fetched, or null
 *   dedupeKey (context, { res }) => string: which earlier answer this one is compared
 *             with, when that depends on the answer (default: the route and context.key)
 *
 * A response whose pollAt equals the last one seen for the same dedupe key is
 * the same upstream refresh served again from the proxy's cache and is
 * ignored; a route without pollAt falls back to comparing the body. A 429 or
 * 5xx answer, or a payload hook that returns FAILED, is noted as a failed poll
 * (at most one per minute per route), even when the proxy marks it a replay: an
 * outage must read as failed polls, not as a gap.
 */
import { gunzipSync } from 'node:zlib';

export const SKIP = Symbol('history-tee-skip');
export const FAILED = Symbol('history-tee-failed');

const MAX_BODY_BYTES = 32 * 1024 * 1024;
// A gzip stream starts with these two bytes. Some providers (the OpenSky
// snapshot cache) hand a pre-compressed body to writeHead({...}), which
// res.getHeader() cannot see, so the body is checked as well as the header.
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const MAX_REMEMBERED_ROUTES = 128;
const FAILURE_EVERY_MS = 60_000;

const toBuffer = (chunk, encoding) => {
  if (chunk === undefined || chunk === null || typeof chunk === 'function')
    return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string')
    return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  return null;
};

/**
 * @param {{
 *   maxBodyBytes?: number,
 *   recorder: { enabled: boolean, feeds: readonly string[], tap: Function, tapFailure: Function },
 *   routes: Array<object>,
 *   clock?: () => number,
 * }} options
 * @returns {(req: object, res: object, next: Function) => void} connect middleware, mounted at /api
 */
export function createHistoryTee({
  recorder,
  routes,
  clock = Date.now,
  maxBodyBytes = MAX_BODY_BYTES,
}) {
  /** route key -> { pollAt, body } of the last response handed to the recorder */
  const last = new Map();
  /** route key -> time of the last failed poll noted */
  const lastFailure = new Map();
  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_REMEMBERED_ROUTES) map.delete(map.keys().next().value);
  };

  function noteFailure(route, key, t) {
    const now = clock();
    if (now - (lastFailure.get(key) ?? -Infinity) < FAILURE_EVERY_MS) return;
    remember(lastFailure, key, now);
    recorder.tapFailure(route.feed, { t: Number.isSafeInteger(t) ? t : now });
  }

  function handleResponse(route, context, routeKey, chunks, res, encoded) {
    const status = res.statusCode;
    if (route.observe && status !== 200) return;
    if (status === 429 || status >= 500) {
      noteFailure(route, routeKey);
      return;
    }
    if (status !== 200) return;
    // A cache replay was recorded when it was fetched: skip it before the body
    // is copied and parsed.
    if (route.isReplay?.(res)) return;
    const key = route.dedupeKey?.(context, { res }) ?? routeKey;
    let body = Buffer.concat(chunks);
    let parsed;
    try {
      // Upstream compresses cached snapshots for clients that accept gzip; the
      // recorder reads the plain payload (bounded by the same body cap). Any
      // other encoding is not read.
      const gzipped = body.subarray(0, 2).equals(GZIP_MAGIC);
      if (encoded && encoded !== 'identity' && !gzipped) return;
      if (gzipped) body = gunzipSync(body, { maxOutputLength: maxBodyBytes });
      const text = body.toString('utf8');
      parsed = route.parse === 'text' ? text : JSON.parse(text);
    } catch {
      return; // not the payload we know; nothing to record, nothing to say
    }
    const helpers = { res };
    if (route.observe) {
      // Learns something from the response (for example station positions);
      // records nothing itself.
      route.payload(parsed, context, helpers);
      return;
    }
    const input = route.payload
      ? route.payload(parsed, context, helpers)
      : parsed;
    if (input === SKIP) return;
    if (input === FAILED) {
      noteFailure(route, routeKey);
      return;
    }
    const polledAt = route.pollAt
      ? route.pollAt(parsed, context, helpers)
      : null;
    const previous = last.get(key);
    if (Number.isSafeInteger(polledAt)) {
      if (previous?.pollAt === polledAt) return;
    } else if (previous?.body && previous.body.equals(body)) {
      return;
    }
    remember(last, key, {
      pollAt: Number.isSafeInteger(polledAt) ? polledAt : null,
      body: Number.isSafeInteger(polledAt) ? null : body,
    });
    recorder.tap(
      route.feed,
      input,
      Number.isSafeInteger(polledAt) ? { t: polledAt } : {},
    );
  }

  return function historyTee(req, res, next) {
    if (!recorder.enabled || req.method !== 'GET') return next();
    let url;
    let route;
    let context;
    try {
      url = new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost');
      for (const candidate of routes) {
        if (!recorder.feeds.includes(candidate.feed)) continue;
        const found = candidate.match(url);
        if (found) {
          route = candidate;
          context = found;
          break;
        }
      }
    } catch {
      return next();
    }
    if (!route) return next();

    const key = `${route.feed}|${route.name ?? ''}|${context.key ?? ''}`;
    const chunks = [];
    let size = 0;
    let overflow = false;
    const capture = (chunk, encoding) => {
      const buffer = toBuffer(chunk, encoding);
      if (!buffer || overflow) return;
      size += buffer.length;
      if (size > maxBodyBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    };
    const originalWrite = res.write;
    const originalEnd = res.end;
    let finished = false;
    res.write = function write(chunk, encoding, ...rest) {
      try {
        capture(chunk, encoding);
      } catch {
        overflow = true;
      }
      return originalWrite.call(this, chunk, encoding, ...rest);
    };
    res.end = function end(chunk, encoding, ...rest) {
      try {
        capture(chunk, encoding);
      } catch {
        overflow = true;
      }
      const result = originalEnd.call(this, chunk, encoding, ...rest);
      if (!finished) {
        finished = true;
        // After the response is on its way: parsing never delays the client.
        setImmediate(() => {
          try {
            const encoded = res.getHeader?.('content-encoding');
            if (overflow) return;
            handleResponse(route, context, key, chunks, res, encoded);
          } catch {
            // History must never change what a client gets, and the error text
            // can hold payload content, so nothing is logged here.
          }
        });
      }
      return result;
    };
    next();
  };
}

/**
 * Vite plugin: mounts the tee in front of the providers' own routes. It must be
 * listed before them (see server/providers/local.js).
 */
export function historyTeePlugin({ recorder, routes, clock }) {
  const tee = createHistoryTee({ recorder, routes, clock });
  const install = (server) => {
    server.middlewares.use('/api', tee);
  };
  return {
    name: 'history-tee',
    apply: 'serve',
    configureServer: install,
    configurePreviewServer: install,
  };
}
