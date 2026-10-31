import { readCappedResponseText } from '../../providers/common/http.js';
import {
  DEFAULT_MAX_GAP_MS,
  HistoryStoreError,
  assertFeed,
  decodeRow,
  invalid,
  normalizeBatch,
  normalizeCoverageOptions,
  normalizeLatestBefore,
  normalizeObservation,
  normalizeSliceOptions,
  normalizeSnapshotOptions,
} from '../store/common.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** A request time this far ahead of the clock is treated as "now". */
const FUTURE_SLACK_MS = 5 * 60 * 1000;
/** latestBefore looks back this far (or the feed's widest window if shorter). */
const LATEST_LOOKBACK_MS = DAY;
const USER_AGENT = 'gods-eye-view-history-live-api';

/** True when (lat, lon) is inside bbox. A west > east box crosses the antimeridian. */
export function inBox(bbox, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < bbox.south || lat > bbox.north) return false;
  return bbox.west <= bbox.east
    ? lon >= bbox.west && lon <= bbox.east
    : lon >= bbox.west || lon <= bbox.east;
}

/**
 * Split a bbox into boxes that do not cross the antimeridian, as {west,south,
 * east,north}. No bbox gives one world box.
 */
export function splitBox(bbox) {
  if (!bbox) return [{ west: -180, south: -90, east: 180, north: 90 }];
  if (bbox.west <= bbox.east) return [bbox];
  return [
    { ...bbox, east: 180 },
    { ...bbox, west: -180 },
  ];
}

/**
 * A history store that keeps nothing and asks the source instead.
 *
 * Each feed has an adapter (see ./adapters) that turns "what did the source
 * show in [t - windowMs, t], inside bbox" into one or more HTTP questions and
 * reads the answer into observations. This store adds what every adapter
 * needs and must not do separately:
 *
 *  - one budget of requests per feed per hour, so scrubbing cannot hammer a
 *    source (a request over budget fails; nothing is queued);
 *  - a small answer cache and one in-flight request per identical question;
 *  - a fixed timeout, a response size cap and no redirects, so a slow, huge or
 *    redirecting source cannot hold the server or send a key somewhere else;
 *  - errors that name the feed and what happened, never the URL (a URL can
 *    carry a key) or the source's text.
 *
 * Writing is accepted and ignored (`written: 0`), so a recorder pointed at the
 * feed does no harm. `snapshots` is empty and `coverage` reports one
 * continuous span from the earliest time the source answers to now, flagged
 * `continuous: true`, because a source API has no list of "moments".
 *
 * @param {object} options
 * @param {Record<string, object>} options.adapters feed -> adapter
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxResponseBytes]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.cacheEntries]
 */
export function createLiveApiStore({
  adapters,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 20_000,
  maxResponseBytes = 16 * 1024 * 1024,
  cacheTtlMs = 5 * 60 * 1000,
  cacheEntries = 64,
}) {
  let closed = false;
  const state = new Map();
  const stateOf = (feed) => {
    let entry = state.get(feed);
    if (!entry) {
      entry = {
        hits: [],
        cache: new Map(),
        inflight: new Map(),
        lastError: null,
      };
      state.set(feed, entry);
    }
    return entry;
  };

  const open = () => {
    if (closed)
      throw new HistoryStoreError('CLOSED', 'history store is closed');
  };
  const adapterFor = (feed) => {
    assertFeed(feed);
    if (!Object.hasOwn(adapters, feed))
      throw invalid('feed has no live history source');
    return adapters[feed];
  };

  function failure(feed, message) {
    const error = new HistoryStoreError(
      'BACKEND',
      `${feed} history source: ${message}`,
    );
    stateOf(feed).lastError = message;
    return error;
  }

  function spend(feed, adapter) {
    const entry = stateOf(feed);
    const t = now();
    entry.hits = entry.hits.filter((at) => at > t - HOUR);
    if (entry.hits.length >= adapter.maxPerHour)
      throw failure(
        feed,
        'the hourly request budget for this source is used up; try again later',
      );
    entry.hits.push(t);
  }

  /** The only way an adapter reaches the network. */
  function makeContext(feed, adapter) {
    return {
      fail: (message) => failure(feed, message),
      async http(url, accept) {
        open();
        spend(feed, adapter);
        let response;
        try {
          response = await fetchImpl(url, {
            headers: { accept, 'user-agent': USER_AGENT },
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          throw failure(
            feed,
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
              ? 'timed out'
              : 'could not be reached',
          );
        }
        let body;
        try {
          body = await readCappedResponseText(response, maxResponseBytes);
        } catch {
          throw failure(feed, 'the response could not be read');
        }
        if (body.tooLarge)
          throw failure(
            feed,
            'the response was too large; ask for a smaller area or window',
          );
        if (response.status === 429)
          throw failure(
            feed,
            'the source is rate limiting requests; try again later',
          );
        return { status: response.status, text: body.text };
      },
    };
  }

  function finish(rows, { from, t, bbox, limit }) {
    const newest = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      let row;
      try {
        row = normalizeObservation(rows[index], index);
      } catch {
        continue; // a source record that does not fit is skipped, not fatal
      }
      if (row.t < from || row.t > t) continue;
      if (bbox && !inBox(bbox, row.lat, row.lon)) continue;
      const seen = newest.get(row.key);
      if (!seen || row.t > seen.t) newest.set(row.key, row);
    }
    const ordered = [...newest.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((row) => decodeRow({ ...row, data: row.json }));
    return {
      observations: ordered.slice(0, limit),
      truncated: ordered.length > limit,
    };
  }

  async function ask(feed, adapter, query) {
    const entry = stateOf(feed);
    const nowMs = now();
    const cacheKey = JSON.stringify([
      query.t,
      query.windowMs,
      query.limit,
      query.bbox && [
        query.bbox.west,
        query.bbox.south,
        query.bbox.east,
        query.bbox.north,
      ],
    ]);
    const cached = entry.cache.get(cacheKey);
    if (cached && nowMs - cached.at < cacheTtlMs) return cached.value;
    if (entry.inflight.has(cacheKey)) return entry.inflight.get(cacheKey);
    const job = (async () => {
      let raw;
      try {
        raw = await adapter.query({
          ...query,
          ctx: makeContext(feed, adapter),
        });
      } catch (error) {
        if (error instanceof HistoryStoreError) throw error;
        throw failure(feed, 'the response was not understood');
      }
      const from = Math.max(
        query.t - query.windowMs,
        adapter.earliestMs(nowMs),
      );
      const value = finish(raw.observations, {
        from,
        t: query.t,
        bbox: query.bbox,
        limit: query.limit,
      });
      value.truncated = value.truncated || Boolean(raw.truncated);
      entry.cache.set(cacheKey, { at: now(), value });
      while (entry.cache.size > cacheEntries)
        entry.cache.delete(entry.cache.keys().next().value);
      entry.lastError = null;
      return value;
    })();
    entry.inflight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      entry.inflight.delete(cacheKey);
    }
  }

  async function slice(feed, options) {
    open();
    const adapter = adapterFor(feed);
    const query = normalizeSliceOptions(options);
    const nowMs = now();
    if (query.t > nowMs + FUTURE_SLACK_MS)
      throw invalid('t must not be in the future');
    query.t = Math.min(query.t, nowMs);
    if (query.windowMs > adapter.maxWindowMs)
      throw invalid(
        `windowMs may be at most ${adapter.maxWindowMs} for this feed's live history source`,
      );
    if (query.t < adapter.earliestMs(nowMs))
      return { observations: [], truncated: false };
    if (typeof adapter.check === 'function') adapter.check(query);
    const answer = await ask(feed, adapter, query);
    // The cached answer is shared, so hand out copies the caller may change.
    return {
      observations: answer.observations.map((row) => ({
        ...row,
        data: { ...row.data },
      })),
      truncated: answer.truncated,
    };
  }

  return {
    backend: 'live-api',

    async append(feed, observations) {
      open();
      adapterFor(feed);
      normalizeBatch(observations);
      return { written: 0 };
    },

    slice,

    async latestBefore(feed, options) {
      open();
      const adapter = adapterFor(feed);
      const { t, key } = normalizeLatestBefore(options);
      const windowMs = Math.min(adapter.maxWindowMs, LATEST_LOOKBACK_MS);
      const { observations } = await slice(feed, {
        t,
        windowMs,
        limit: 100_000,
      });
      return observations.find((row) => row.key === key) ?? null;
    },

    async snapshots(feed, options) {
      open();
      adapterFor(feed);
      normalizeSnapshotOptions(options);
      return { snapshots: [], truncated: false, continuous: true };
    },

    async coverage(feed, options) {
      open();
      const adapter = adapterFor(feed);
      const { from, to, maxGapMs } = normalizeCoverageOptions(options);
      const nowMs = now();
      const earliest = adapter.earliestMs(nowMs);
      const start = Math.max(from ?? earliest, earliest);
      const end = Math.min(to ?? nowMs, nowMs);
      return {
        feed,
        count: 0,
        snapshots: 0,
        firstT: earliest,
        lastT: nowMs,
        maxGapMs: maxGapMs ?? DEFAULT_MAX_GAP_MS,
        // The source can answer any time between these; it holds no list of moments.
        continuous: true,
        spans: start <= end ? [{ from: start, to: end, snapshots: 0 }] : [],
      };
    },

    async prune(feed) {
      open();
      adapterFor(feed);
      return { deleted: 0 };
    },

    async health() {
      if (closed)
        return { backend: 'live-api', ok: false, reason: 'closed', feeds: {} };
      const t = now();
      const feeds = {};
      for (const [feed, adapter] of Object.entries(adapters)) {
        const entry = stateOf(feed);
        feeds[feed] = {
          source: adapter.source,
          requestsLastHour: entry.hits.filter((at) => at > t - HOUR).length,
          maxPerHour: adapter.maxPerHour,
          lastError: entry.lastError,
        };
      }
      return { backend: 'live-api', ok: true, keepsHistory: false, feeds };
    },

    async close() {
      closed = true;
      state.clear();
    },
  };
}
