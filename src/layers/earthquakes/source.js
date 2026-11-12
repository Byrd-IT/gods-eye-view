import { normalizeEarthquakeSnapshot } from './records.js';
const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Positive integer seconds from an HTTP Retry-After header, else null. */
const secondsFrom = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Did the failure come from OUR server answering from its Elasticsearch copy
 * instead of USGS? The ES-live bridge (clientRedirect.js sends the request
 * there) names itself in X-Feed-Source and answers its outages with a JSON
 * `es_live_unavailable` error. Such a failure says nothing about USGS, so the
 * layer's error must stay neutral and not blame the provider.
 */
const PROVIDER_ORIGIN = new URL(API_URL).origin;

async function isServerFeedFailure(response, signal) {
  if (response.headers?.get?.('X-Feed-Source') === 'elasticsearch') return true;
  // The ES-live bridge redirects listed provider requests to a same-origin
  // /api/es-live/* route and may return its plain 404 (recheck failed or the
  // feed was unlisted) without any marker. A response that did not come from
  // the provider's own origin says nothing about USGS, so it stays neutral.
  if (response.url) {
    try {
      if (new URL(response.url).origin !== PROVIDER_ORIGIN) return true;
    } catch {
      // An unresolvable response URL falls through to the body check.
    }
  }
  try {
    // This is a portable package, so do not import the app's i18n-bound
    // response helper. Bound the error body without changing its contents.
    const limit = 64 * 1024;
    if (Number(response.headers?.get?.('content-length')) > limit) {
      void response.body?.cancel().catch(() => {});
      return false;
    }
    const reader = response.body?.getReader?.();
    if (!reader) return false;
    const chunks = [];
    let size = 0;
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          cancel();
          return false;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return (
        JSON.parse(new TextDecoder().decode(bytes))?.error ===
        'es_live_unavailable'
      );
    } finally {
      signal?.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * The rows with how fresh they are: when the server answers from its own
   * last-good Elasticsearch copy, it marks the answer stale (X-Data-Stale),
   * and the layer reports that instead of narrating an old quake as live.
   * @returns {Promise<{rows: object[], stale: boolean, retryAfterSec: number|null}>}
   */
  async function getSnapshotDetail({ signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(API_URL, { signal });
    if (!response.ok) {
      if (await isServerFeedFailure(response, signal))
        throw new Error(msg('Live earthquake feed is unavailable'));
      throw new Error(`USGS HTTP ${response.status}`);
    }
    const payload = await response.json();
    signal?.throwIfAborted();
    const rows = normalizeEarthquakeSnapshot(payload);
    if (!rows) throw new Error('Malformed USGS response');
    return {
      rows,
      stale: response.headers?.get?.('X-Data-Stale') === 'true',
      retryAfterSec: secondsFrom(response.headers?.get?.('Retry-After')),
    };
  }

  return {
    /** The earthquake rows (see getSnapshotDetail for staleness). */
    async getSnapshot({ signal } = {}) {
      return (await getSnapshotDetail({ signal })).rows;
    },
    getSnapshotDetail,
  };
}
