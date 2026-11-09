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
 * server cannot be asked (network error, 5xx), that request goes to the
 * provider as before and the question is asked again next time.
 */
export const ES_LIVE_CONFIG_URL = '/api/es-live/config';

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

/** Absolute base for a Request (a Request needs an absolute URL outside a page). */
function baseOf(target, doc) {
  return (
    doc?.baseURI ??
    target?.location?.href ??
    globalThis.location?.href ??
    'http://localhost/'
  );
}

/**
 * Wrap target.fetch. Returns an uninstall function.
 */
export function installEsLiveFetch({
  target = globalThis,
  doc = globalThis.document,
} = {}) {
  const original = target?.fetch;
  if (typeof original !== 'function') return () => {};
  let asked = null;
  /** The feeds the server answers from ES; cached once known. */
  function feedsOf() {
    asked ??= (async () => {
      const response = await original.call(target, ES_LIVE_CONFIG_URL, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (response.status === 404) return new Set();
      if (!response.ok)
        throw new Error(`es-live config HTTP ${response.status}`);
      const body = await response.json();
      return new Set(
        (Array.isArray(body?.feeds) ? body.feeds : []).filter((f) =>
          ALL.has(f),
        ),
      );
    })().catch((error) => {
      asked = null; // ask again next time
      throw error;
    });
    return asked;
  }
  const wrapped = async function esLiveFetch(input, init) {
    const href =
      typeof input === 'string' ? input : (input?.url ?? input?.href);
    if (!href || !isRedirectable(href)) return original.call(this, input, init);
    let feeds;
    try {
      feeds = await feedsOf();
    } catch {
      return original.call(this, input, init);
    }
    const to = esLiveTarget(href, feeds);
    if (!to) return original.call(this, input, init);
    const next =
      typeof input === 'string' || input instanceof URL
        ? to
        : new Request(new URL(to, baseOf(target, doc)).href, input);
    return original.call(this, next, init);
  };
  target.fetch = wrapped;
  return () => {
    if (target.fetch === wrapped) target.fetch = original;
  };
}
