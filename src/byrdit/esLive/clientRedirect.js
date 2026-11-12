/**
 * Browser side of the ES-live feeds (card t_a829441f). The page used to call
 * USGS (earthquakes) and Environment Canada (air quality) directly. The server
 * says which of those it answers from our Elasticsearch copy
 * (GET /api/es-live/config, {feeds: [...]}); for the listed feeds the request
 * is sent to this server's /api/es-live/* routes instead.
 *
 * Installed FIRST in src/main.js, so every other fetch wrapper (the history
 * router, feed chips) sits on top of it: they still see the original provider
 * URL and keep serving time-travel frames; only a live request that reaches
 * this layer is redirected.
 *
 * The answer is asked of the server once per page load, at the first request
 * for one of the two providers (no meta tag and no build step: a flag change
 * needs a restart only, in dev and in preview alike). A server without the
 * plugin answers 404 = nothing is redirected = the old behaviour. If the
 * server cannot be asked (network error, 5xx, a timeout — bounded to a few
 * seconds so a hung config request cannot hang the feed), or answers with
 * something that is not JSON, the caller fails CLOSED: the request is NOT sent
 * to the provider, and instead rejects with a sanitized
 * EsLiveConfigUnavailableError (no raw exception text is forwarded). The same
 * applies to a caller-provided abort signal: a cancelled caller is not
 * redirected and never sent upstream. The question is asked again next time —
 * only a genuine config answer (404, or an explicit feed list) decides
 * fallback behaviour.
 *
 * Each caller's own signal (init.signal, or a Request's signal) also bounds
 * its wait for the shared config answer — but the wait only observes that
 * signal; it never aborts the shared config request on behalf of other
 * concurrent callers, and every abandoned chain stays observed, so nothing
 * surfaces as an unhandled rejection and no listener outlives its request.
 *
 * A 404 from the redirected /api/es-live/* route means the server's flag has
 * turned off since it was asked (e.g. a plugin restart or a config change), so
 * the cached answer is dropped and re-checked for this same request. The
 * re-check NEVER sends the caller upstream (item 6 scope: no new provider
 * calls once a request was redirected): if the re-check fails, times out, is
 * aborted by the caller's signal, or finds the feed unlisted, the original
 * same-origin 404 is returned to the caller unchanged.
 *
 * A non-idempotent request (anything but GET/HEAD) is never replayed: the
 * re-check could not change its outcome (it would return the original 404
 * either way), so such a request gets its same-origin 404 straight away and
 * the config is asked again on the next request. For GET/HEAD the dropped
 * 404's body is cancelled before the retry, and every config harness started
 * by this install is tracked: uninstall aborts all of them, not just the
 * latest.
 */
export const ES_LIVE_CONFIG_URL = '/api/es-live/config';

/** The config request must never hang the feed; a bounded timeout (~3s). */
export const DEFAULT_CONFIG_TIMEOUT_MS = 3000;

/**
 * Thrown to the caller when the redirect could not be resolved (network
 * error, non-ok status, non-JSON body, timeout, or cancellation). The message
 * is a fixed, sanitized string: no raw exception text from the config
 * exchange is ever forwarded to the caller.
 */
export class EsLiveConfigUnavailableError extends Error {
  constructor(cancelled) {
    super(
      cancelled
        ? 'The request was cancelled while the es-live redirect was being resolved; it was not sent.'
        : 'The es-live redirect could not be resolved; the request was not sent.',
    );
    this.name = 'EsLiveConfigUnavailableError';
  }
}

const USGS_HOST = 'earthquake.usgs.gov';
const USGS_PATH = '/earthquakes/feed/v1.0/summary/all_day.geojson';
const ECCC_HOST = 'api.weather.gc.ca';
const AQHI_STATIONS_PATH = '/collections/aqhi-stations/items';
const AQHI_OBSERVATIONS_PATH = '/collections/aqhi-observations-realtime/items';
const ALL = new Set(['quakes', 'aqhi']);

/** The same-origin path for a provider URL, or null (not one of ours / not listed). */
export function esLiveTarget(href, feeds) {
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (
    feeds.has('quakes') &&
    url.hostname === USGS_HOST &&
    url.pathname === USGS_PATH
  )
    return '/api/es-live/earthquakes';
  if (feeds.has('aqhi') && url.hostname === ECCC_HOST) {
    if (url.pathname === AQHI_STATIONS_PATH)
      return '/api/es-live/aqhi-stations';
    if (url.pathname === AQHI_OBSERVATIONS_PATH) return '/api/es-live/aqhi';
  }
  return null;
}

/** Whether a URL is one of the two provider requests this module can redirect. */
export const isRedirectable = (href) => esLiveTarget(href, ALL) !== null;

/** Resolve against the document location, never the mutable <base> element. */
function localTarget(path, target) {
  const href = target?.location?.href ?? globalThis.location?.href;
  return href ? new URL(path, href).href : path;
}

const timeoutReason = () =>
  new DOMException('The es-live config request timed out.', 'TimeoutError');

/**
 * An AbortController armed with a (ref'd, so it actually fires) timeout plus
 * any number of observed source signals. `dispose()` clears the timer and
 * detaches every listener, so nothing leaks after the request settles.
 *
 * NOTE: a source signal aborts the combined controller, but the *observed*
 * sources of one request are never shared with another, so disposing one
 * request's harness cannot abort someone else's wait.
 */
function signalHarness(sources, timeoutMs) {
  const controller = new AbortController();
  const listeners = [];
  const timer = setTimeout(() => controller.abort(timeoutReason()), timeoutMs);
  for (const source of sources) {
    if (!source) continue;
    if (source.aborted) controller.abort(source.reason);
    else {
      const on = () => controller.abort(source.reason);
      source.addEventListener('abort', on, { once: true });
      listeners.push([source, on]);
    }
  }
  const signal = controller.signal;
  const dispose = () => {
    clearTimeout(timer);
    for (const [source, on] of listeners.splice(0))
      source.removeEventListener('abort', on);
  };
  if (signal.aborted) dispose(); // an already-aborted source: no timer wanted
  return { signal, dispose, abort: (reason) => controller.abort(reason) };
}

/** Race a shared promise against just this caller's signal (observe, not abort). */
function waitWithSignal(promise, signal) {
  if (!signal) {
    return promise.then(
      (value) => value,
      (error) => {
        promise.catch(() => {}); // keep the shared chain observed either way
        throw error;
      },
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      promise.then(
        () => {},
        () => {},
      ); // the shared chain stays observed
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      promise.then(
        () => {},
        () => {},
      );
      reject(error);
    };
    const onAbort = () =>
      fail(
        signal.reason ??
          new DOMException('The operation was aborted.', 'AbortError'),
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(finish, fail);
  });
}

/**
 * Wrap target.fetch. Returns an uninstall function (which also aborts any
 * config request still in flight — its answer is no longer wanted).
 *
 * Options: `signal` aborts every config request this install makes,
 * `configTimeoutMs` overrides the ~3s default (tests use a smaller bound).
 */
export function installEsLiveFetch({
  target = globalThis,
  doc = globalThis.document,
  signal = null,
  configTimeoutMs = DEFAULT_CONFIG_TIMEOUT_MS,
} = {}) {
  const original = target?.fetch;
  if (typeof original !== 'function') return () => {};
  let asked = null;
  /** Every config harness of this install, so uninstall aborts them all. */
  const inFlight = new Set();
  /** The feeds the server answers from ES; cached until proven stale. */
  function feedsOf() {
    asked ??= (async () => {
      const harness = signalHarness([signal], configTimeoutMs);
      inFlight.add(harness);
      try {
        const response = await original.call(
          target,
          localTarget(ES_LIVE_CONFIG_URL, target),
          {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: harness.signal,
          },
        );
        if (response.status === 404) return new Set();
        if (!response.ok)
          throw new Error(`es-live config HTTP ${response.status}`);
        const body = await response.json(); // a non-JSON 200 throws here
        if (
          !Array.isArray(body?.feeds) ||
          body.feeds.some((feed) => typeof feed !== 'string')
        )
          throw new Error('Invalid es-live config');
        return new Set(body.feeds.filter((f) => ALL.has(f)));
      } finally {
        inFlight.delete(harness);
        harness.dispose(); // timer cleared and listeners detached on settle
      }
    })();
    // the shared chain must stay observed even when every waiter departs
    const current = asked;
    current.catch(() => {
      if (asked === current) asked = null; // ask again next time
    });
    return asked;
  }
  const wrapped = async function esLiveFetch(input, init) {
    const href =
      typeof input === 'string' ? input : (input?.url ?? input?.href);
    if (!href || !isRedirectable(href)) return original.call(this, input, init);
    // this request's own signal bounds its config wait: init.signal, or a
    // Request's built-in signal
    const ownSignal = init?.signal ?? input?.signal ?? null;
    if (ownSignal?.aborted || signal?.aborted)
      // fail closed: a cancelled caller is never sent anywhere, upstream
      // included (the config answer is unknown; a provider call is unsafe)
      throw new EsLiveConfigUnavailableError(true);
    let feeds;
    const generation = feedsOf();
    try {
      feeds = await waitWithSignal(generation, ownSignal);
    } catch {
      // fail closed: network error, non-ok status, non-JSON body, timeout or
      // cancellation — never fall through to the provider. The raw reason
      // (which may carry internal details) is swallowed in favour of a
      // sanitized error.
      throw new EsLiveConfigUnavailableError(Boolean(ownSignal?.aborted));
    }
    const to = esLiveTarget(href, feeds);
    if (!to) return original.call(this, input, init);
    const next =
      typeof input === 'string' || input instanceof URL
        ? localTarget(to, target)
        : new Request(
            localTarget(to, target) === to
              ? new URL(to, 'http://localhost/').href
              : localTarget(to, target),
            input,
          );
    const response = await original.call(this, next, init);
    if (response.status === 404) {
      // the served answer was a 404: the cached config may be stale, so drop
      // it and re-check this very request once. NO new provider call may be
      // made from this path: on re-check failure, timeout, caller abort, or
      // an unlisted feed, the original 404 is returned unchanged.
      //
      // A non-idempotent request is never replayed, so the re-check outcome
      // could not change its answer (the original 404 either way): return it
      // straight away instead of re-asking. The config is asked again on the
      // next request.
      const method = String(
        init?.method ?? input?.method ?? 'GET',
      ).toUpperCase();
      if (asked === generation) asked = null;
      if (method !== 'GET' && method !== 'HEAD') return response;
      try {
        feeds = await waitWithSignal(feedsOf(), ownSignal);
      } catch {
        return response;
      }
      const retry = esLiveTarget(href, feeds);
      if (!retry) return response;
      // Only cancel when the original response will actually be discarded.
      void response.body?.cancel().catch(() => {});
      const again =
        typeof input === 'string' || input instanceof URL
          ? localTarget(retry, target)
          : new Request(
              localTarget(retry, target) === retry
                ? new URL(retry, 'http://localhost/').href
                : localTarget(retry, target),
              input,
            );
      return original.call(this, again, init);
    }
    return response;
  };
  target.fetch = wrapped;
  return () => {
    if (target.fetch === wrapped) target.fetch = original;
    // the question is no longer wanted: stop every config still in flight
    asked = null;
    for (const harness of [...inFlight]) {
      harness.abort('es-live fetch uninstalled');
      harness.dispose();
    }
    inFlight.clear();
  };
}
