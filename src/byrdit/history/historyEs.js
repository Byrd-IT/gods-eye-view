/**
 * Read-only Elasticsearch client for /api/history (gev-history DESIGN 4.3,
 * card B9 item 5).
 *
 * - Reader key ONLY: GEV_HISTORY_ES_API_KEY must be the B1 key
 *   `gev-history-reader` (or the name in GEV_HISTORY_READER_KEY_NAME). Before
 *   the first query the client asks ES who the key is
 *   (/_security/_authenticate) and refuses to run with any other key, e.g.
 *   the collector's write key, so a mis-pasted .env cannot turn the history
 *   API into a writer. The check is repeated after a failure.
 * - Fixed endpoints only: _search, _pit (open/close) on the index names in
 *   HISTORY_INDICES. There is no path or body passthrough from the request.
 * - Errors never leak: every failure (network, timeout, non-2xx, bad JSON,
 *   shard failures) becomes HistoryUnavailableError with a short internal
 *   `reason` for the server log; the HTTP layer answers 503
 *   {error:'history_unavailable'} without it.
 */

export const DEFAULT_ES_TIMEOUT_MS = 10_000;
export const DEFAULT_READER_KEY_NAME = 'gev-history-reader';
export const PIT_KEEP_ALIVE = '30s';
export const PAGE_SIZE = 5_000;
/** Largest ES response body read (bytes); a slice page is ~1-3 MB. */
export const MAX_ES_BODY_BYTES = 48 * 1024 * 1024;

/** Every index expression the history API may read (no others). */
export const HISTORY_INDICES = Object.freeze({
  ingestLog: 'gev-history-ingest-log',
  military: 'gev-history-military',
  adsblol: 'gev-history-aircraft-adsblol,gev-history-aircraft-adsblol-hist',
  opensky: 'gev-history-aircraft-opensky',
  fires: 'gev-history-fires,gev-history-fires-hist-*',
  perimeters: 'gev-history-perimeters,gev-history-perimeters-hist-*',
  cyclones: 'gev-history-cyclones,gev-history-cyclones-hist-*',
  launches: 'gev-history-launches,gev-history-launches-hist-*',
});
const ALLOWED = new Set(Object.values(HISTORY_INDICES));

export class HistoryUnavailableError extends Error {
  constructor(reason) {
    super('history_unavailable');
    this.reason = String(reason).slice(0, 120);
  }
}

/** Client configuration from the environment; null when not configured. */
export function esConfigFromEnv(env = {}) {
  const url = String(env.GEV_HISTORY_ES_URL ?? '').trim();
  const apiKey = String(env.GEV_HISTORY_ES_API_KEY ?? '').trim();
  if (!url || !apiKey) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return null;
  const timeout = Number(env.GEV_HISTORY_ES_TIMEOUT_MS);
  return {
    url: parsed.href.replace(/\/+$/, ''),
    apiKey,
    readerKeyName:
      String(env.GEV_HISTORY_READER_KEY_NAME ?? '').trim() ||
      DEFAULT_READER_KEY_NAME,
    timeoutMs:
      Number.isInteger(timeout) && timeout > 0 && timeout <= 60_000
        ? timeout
        : DEFAULT_ES_TIMEOUT_MS,
  };
}

/**
 * @param {object} options
 * @param {string} options.url ES base URL
 * @param {string} options.apiKey reader API key (encoded form)
 * @param {string} [options.readerKeyName]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createHistoryEsClient({
  url,
  apiKey,
  readerKeyName = DEFAULT_READER_KEY_NAME,
  timeoutMs = DEFAULT_ES_TIMEOUT_MS,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  let verified = null; // Promise<void> while/after the identity check

  async function call(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url + path, {
        method,
        headers: {
          Authorization: `ApiKey ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new HistoryUnavailableError(
        error?.name === 'AbortError' ? 'es_timeout' : 'es_network',
      );
    } finally {
      clearTimeout(timer);
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_ES_BODY_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw new HistoryUnavailableError('es_body_too_large');
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new HistoryUnavailableError('es_read');
    }
    if (text.length > MAX_ES_BODY_BYTES)
      throw new HistoryUnavailableError('es_body_too_large');
    if (!response.ok)
      throw new HistoryUnavailableError(`es_${response.status}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HistoryUnavailableError('es_bad_json');
    }
    return json;
  }

  function verify() {
    verified ??= call('GET', '/_security/_authenticate').then(
      (who) => {
        const name = who?.api_key?.name;
        if (who?.authentication_type !== 'api_key' || name !== readerKeyName)
          throw new HistoryUnavailableError('not_reader_key');
      },
      (error) => {
        throw error;
      },
    );
    return verified.catch((error) => {
      verified = null; // re-check on the next request
      throw error;
    });
  }

  function indexPath(index) {
    if (!ALLOWED.has(index)) throw new HistoryUnavailableError('index_denied');
    return '/' + index;
  }

  function checkShards(json) {
    if (json?.timed_out === true || json?._shards?.failed > 0)
      throw new HistoryUnavailableError('es_partial');
    return json;
  }

  async function search(index, body) {
    await verify();
    return checkShards(
      await call(
        'POST',
        `${indexPath(index)}/_search?allow_no_indices=true&ignore_unavailable=true`,
        body,
      ),
    );
  }

  /**
   * All hits of `query` up to `maxRows`, paged with a point in time and
   * search_after (DESIGN 4.3: PIT + search_after pages internally).
   * @returns {Promise<{hits: object[], total: number, truncated: boolean, pages: number}>}
   */
  async function searchAll(
    index,
    { query, sort, _source, maxRows, pageSize = PAGE_SIZE },
  ) {
    await verify();
    const opened = await call(
      'POST',
      `${indexPath(index)}/_pit?keep_alive=${PIT_KEEP_ALIVE}&allow_no_indices=true&ignore_unavailable=true`,
    );
    let pit = opened?.id;
    if (typeof pit !== 'string' || !pit)
      throw new HistoryUnavailableError('es_pit');
    const hits = [];
    let total = 0;
    let pages = 0;
    let after;
    try {
      for (;;) {
        const size = Math.min(pageSize, maxRows + 1 - hits.length);
        const json = checkShards(
          await call('POST', '/_search', {
            size,
            query,
            _source,
            pit: { id: pit, keep_alive: PIT_KEEP_ALIVE },
            sort: [...(sort ?? []), { _shard_doc: 'asc' }],
            track_total_hits: pages === 0 ? true : false,
            ...(after ? { search_after: after } : {}),
          }),
        );
        pages += 1;
        if (pages === 1) total = json?.hits?.total?.value ?? 0;
        if (typeof json?.pit_id === 'string') pit = json.pit_id;
        const page = json?.hits?.hits ?? [];
        hits.push(...page);
        if (page.length < size || hits.length > maxRows) break;
        after = page.at(-1)?.sort;
        if (!after) break;
      }
    } finally {
      call('DELETE', '/_pit', { id: pit }).catch(() => {});
    }
    const truncated = hits.length > maxRows || total > maxRows;
    return { hits: hits.slice(0, maxRows), total, truncated, pages };
  }

  return { search, searchAll, verify };
}
