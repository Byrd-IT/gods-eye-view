import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeAqhiStations, normalizeAqhiObservations } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;

/** Comfortably above Canada's ~134 stations without inviting a huge page. */
const STATION_LIMIT = 500;
const OBSERVATION_LIMIT = 500;
/** Station geometry is near-static — a few changes a year. Refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A full 500-row GeoJSON page is a few hundred KB; anything past this is not a page. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Positive integer seconds from an HTTP Retry-After header, else null. */
const secondsFrom = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Did the failure come from OUR server answering from its Elasticsearch copy
 * instead of ECCC? The ES-live bridge (the page's provider request is
 * redirected to it) names itself in X-Feed-Source and answers its outages
 * with a JSON `es_live_unavailable` error. Such a failure says nothing about
 * ECCC, so the layer's error must stay neutral and not blame the provider.
 */
const PROVIDER_ORIGIN = new URL(COLLECTIONS_ROOT).origin;

async function isServerFeedFailure(response, signal) {
  if (response.headers?.get?.('X-Feed-Source') === 'elasticsearch') return true;
  // The ES-live bridge redirects the ECCC collections requests to a
  // same-origin /api/es-live/* route and may return its plain 404 (recheck
  // failed or the feed was unlisted) without any marker. A response that did
  // not come from the provider's own origin says nothing about ECCC, so it
  // stays neutral.
  if (response.url) {
    try {
      if (new URL(response.url).origin !== PROVIDER_ORIGIN) return true;
    } catch {
      // An unresolvable response URL falls through to the body check.
    }
  }
  try {
    const body = await readResponseJsonCapped(response, 64 * 1024, signal);
    return body?.error === 'es_live_unavailable';
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/**
 * Request and validate a complete ECCC AQHI snapshot before it can replace
 * displayed readings. The first registered air-quality provider.
 *
 * Two collections are involved. `aqhi-stations` is the catalog — it supplies
 * every reading its coordinates and is cached for twelve hours because it
 * barely changes. `aqhi-observations-realtime` is the hourly reading feed,
 * requested with `latest=true` so the response is current values rather than
 * the full observation history, which is roughly 2,000 rows nationally.
 *
 * The station catalog is only replaced when a refresh actually returns
 * stations, so a transient empty response cannot blank the layer.
 *
 * `getSnapshotDetail` reports the freshness the ES-live bridge declared with
 * X-Data-Stale: a last-good copy served in place of a failing Elasticsearch
 * read must reach the layer status, keeping live narration off old readings.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for each request.
 * @returns {{getSnapshot: Function}}
 */
export function createEcccAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  /** @type {Map<string, object>} */
  let stations = new Map();
  let stationsFetchedAt = 0;
  /** Whether the catalog in `stations` was last served from a stale copy. */
  let stationsStale = false;
  let stationRequestSequence = 0;
  let stationCommittedSequence = 0;

  /** One bounded GeoJSON page: deadline, caller abort, byte cap, row cap. */
  const getJson = async (url, limit, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(msg('ECCC request timed out'))),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (await isServerFeedFailure(response, controller.signal))
          throw new Error(msg('Air quality feed is unavailable'));
        throw new Error(`ECCC HTTP ${response.status}`);
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
      // The server's `limit` is a request, not a guarantee.
      const features = Array.isArray(payload?.features)
        ? payload.features.slice(0, limit)
        : null;
      return {
        payload: { ...payload, ...(features ? { features } : {}) },
        stale: response.headers?.get?.('X-Data-Stale') === 'true',
        retryAfterSec: secondsFrom(response.headers?.get?.('Retry-After')),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  /**
   * The readings with how fresh they are: when the server answers from its
   * last-good Elasticsearch copy, it marks the answer stale (X-Data-Stale),
   * and the layer reports that instead of narrating old readings as live.
   * @returns {Promise<{readings: object[], stale: boolean, retryAfterSec: number|null}>}
   */
  async function getSnapshot({ signal } = {}) {
    const clock = now();
    let feedStale = false;
    let feedRetryAfterSec = null;
    if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
      const sequence = ++stationRequestSequence;
      const stationPage = await getJson(
        `${STATIONS_URL}?f=json&limit=${STATION_LIMIT}`,
        STATION_LIMIT,
        signal,
      );
      const next = normalizeAqhiStations(stationPage.payload);
      if (!next) throw new Error(msg('Malformed AQHI station response'));
      // An empty refresh must not wipe a good catalog.
      if (next.size > 0 && sequence > stationCommittedSequence) {
        stationCommittedSequence = sequence;
        stations = next;
        stationsFetchedAt = clock;
        stationsStale = stationPage.stale === true;
      }
    }
    if (stations.size === 0) throw new Error(msg('No AQHI stations available'));

    const observationPage = await getJson(
      `${OBSERVATIONS_URL}?f=json&latest=true&limit=${OBSERVATION_LIMIT}`,
      OBSERVATION_LIMIT,
      signal,
    );
    const readings = normalizeAqhiObservations(
      observationPage.payload,
      stations,
      clock,
    );
    if (!readings) throw new Error(msg('Malformed AQHI observation response'));
    // The observations are the readings, but a catalog served from the
    // ES-live bridge's last-good copy ages the coordinates the readings are
    // keyed to, so its staleness must be reported alongside the feed's.
    // A refresh that returned nothing keeps the cached catalog and its
    // previously recorded staleness.
    feedStale = stationsStale || observationPage.stale === true;
    feedRetryAfterSec = observationPage.retryAfterSec ?? null;
    return {
      readings,
      stale: feedStale,
      retryAfterSec: feedRetryAfterSec,
    };
  }

  return {
    /** The readings (see getSnapshotDetail for staleness). */
    async getSnapshot({ signal } = {}) {
      return (await getSnapshot({ signal })).readings;
    },
    getSnapshotDetail: getSnapshot,
  };
}
