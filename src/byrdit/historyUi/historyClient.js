/**
 * Browser client for /api/history/coverage and /api/history/snapshots
 * (B9 routes, DESIGN.md 4.3) used by the History control (card B11).
 *
 * Quiet failure (DESIGN 4.5): any failure - network, non-2xx, a non-JSON
 * answer (the history plugin is off and the SPA fallback answers HTML), a
 * malformed body - becomes HistoryUnavailableError. The control then shows
 * "history unavailable"; nothing here touches a live layer.
 *
 * Coverage answers are cached per exact question (the control asks
 * bucket-aligned ranges, so moving inside one window costs no request) and
 * concurrent identical questions share one request. The API allows 60
 * requests/min per client; the control never fetches while a scrub drags.
 */
export const HISTORY_UNAVAILABLE = 'history unavailable';

export class HistoryUnavailableError extends Error {
  constructor(reason, status = null) {
    super(HISTORY_UNAVAILABLE);
    this.name = 'HistoryUnavailableError';
    this.reason = reason;
    this.status = status;
  }
}

const COVERAGE_CACHE_MAX = 32;
/** Coverage that ends within this long of now is re-asked after it. */
const LIVE_EDGE_TTL_MS = 60_000;

export function createHistoryClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  base = '/api/history',
} = {}) {
  const cache = new Map(); // key -> {at, edge, value}
  const inflight = new Map(); // key -> promise

  async function getJson(path, params, signal) {
    const query = new URLSearchParams(params).toString();
    let response;
    try {
      response = await fetchImpl(`${base}/${path}?${query}`, {
        signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new HistoryUnavailableError('network');
    }
    if (!response?.ok)
      throw new HistoryUnavailableError('status', response?.status ?? null);
    const type = String(response.headers?.get?.('content-type') ?? '');
    if (!/\bjson\b/i.test(type))
      throw new HistoryUnavailableError('not_json', response.status);
    try {
      return await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new HistoryUnavailableError('bad_body', response.status);
    }
  }

  function remember(key, value, edge) {
    cache.delete(key);
    cache.set(key, { at: now(), edge, value });
    while (cache.size > COVERAGE_CACHE_MAX)
      cache.delete(cache.keys().next().value);
  }

  /**
   * @param {{feed: string, from: number, to: number, bucket: string}} q
   * @returns {Promise<object>} the coverage answer
   */
  async function coverage({ feed, from, to, bucket }) {
    // no AbortSignal: one request may serve several callers (inflight), so
    // the control drops stale answers by generation instead of aborting
    const signal = undefined;
    const key = `${feed}|${from}|${to}|${bucket}`;
    const hit = cache.get(key);
    const t = now();
    if (hit && !(hit.edge && t - hit.at > LIVE_EDGE_TTL_MS)) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const promise = getJson(
      'coverage',
      {
        feed,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucket,
      },
      signal,
    )
      .then((value) => {
        if (!value || !Array.isArray(value.lanes))
          throw new HistoryUnavailableError('bad_body');
        remember(key, value, to >= t - LIVE_EDGE_TTL_MS);
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /**
   * Nearest stored snapshot times (exact n nearest, B9).
   * @returns {Promise<number[]>} epoch ms, ascending
   */
  async function snapshots({ feed, around, n = 10 }, { signal } = {}) {
    const value = await getJson(
      'snapshots',
      { feed, around: new Date(around).toISOString(), n: String(n) },
      signal,
    );
    if (!value || !Array.isArray(value.snaps))
      throw new HistoryUnavailableError('bad_body');
    return value.snaps
      .map((s) => (Number.isFinite(s?.epochMs) ? s.epochMs : Date.parse(s?.t)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  }

  return {
    coverage,
    snapshots,
    clearCache() {
      cache.clear();
    },
  };
}
