/**
 * History fetch router (gev-history DESIGN 4.5, card B12a, umbrella D1/D3/D6).
 *
 * A pass-through wrapper of window.fetch, installed by mountHistoryForShell
 * AFTER the B11 feed-chip observer, so the chain is
 *
 *   layer source -> router -> feedChips observer -> browser fetch
 *
 * LIVE: every request goes straight through (same promise).
 * HISTORY: a GET on a route with an adapter (historyAdapters.js) is answered
 * from /api/history/slice at the history time, adapted to the exact live
 * body and headers, so the layer's own parser runs unchanged. The slice
 * request goes through the inner fetch: the chip observer sees
 * /api/history/slice (not a bridged route) and keeps judging only real live
 * answers.
 *
 * D3 quiet failure: a slice that fails (network, non-2xx, not JSON, or a
 * 429 that is still busy after one retry) marks that feed FAILED; the
 * request and the next ones pass through to live (the globe is never
 * blanked). The failure is LATCHED: the feed stays failed (not swapped, so
 * its layer keeps a 'LIVE (history unavailable)' chip) until a history
 * answer is actually served to the layer again. Retry eligibility is
 * separate: after `retryMs` (or at once when the control reports history
 * available again) the next layer request tries the slice first; if that
 * fails too it passes through to live and the feed stays failed. A
 * recorded gap / empty slice is a successful, EMPTY answer: nothing is
 * drawn (never live, never another time).
 *
 * D6 cache + prefetch: slice answers are kept in a small LRU keyed by the
 * exact slice URL (raw answer; the rebase is applied when served, so a
 * cached answer is never served with a stale delta). prefetch() fills it
 * with at most `prefetchConcurrency` requests in flight IN TOTAL; a seek,
 * LIVE or a change of the slice parameters (bbox / maxRows) drops the cache
 * and cancels the prefetches.
 *
 * Playback frames: while playing, the slice time of a feed is its recorded
 * snapshot at or before t (setSnaps; B9 /snapshots) or t floored to the
 * adapter's quantum, so the layer's request asks exactly the URL prefetched
 * for that frame. Paused / released, the slice time is t itself (the B11
 * control already snaps a release to a recorded snapshot).
 *
 * A request carrying init.gevLive (the voice tools: they report "current"
 * data) always passes through.
 *
 * Frames (owner decision on t_884fea7d, option A): every answer the router
 * gives a swapped feed's layer request is announced to onServe listeners
 * BEFORE the layer reads it: {adapterId, mode: 'history', t, nowMs} for a
 * history answer, {adapterId, mode: 'live'} for a pass-through while
 * history is on (failure, D3). The refresh driver arms the layer's
 * resetForHistoryFrame() / motion clock from it (historyRefresh.js).
 *
 * Track routes (adapter.trackMatch: /api/flights/track, /api/military/track,
 * /api/vessels/track) are LIVE tracks; no live path is ever drawn behind a
 * history aircraft or vessel (D3). While a feed is answered from history:
 *   flights, military (B12e) -> the RECORDED track [t-6h, t] from
 *        /api/history/track, t = the time of the frame the layer shows,
 *        rebased with that frame's delta and adapted to the live shape
 *        (historyTrackAdapters.js). Answers are kept per exact URL for the
 *        history time (a re-served paused frame asks the same window) and
 *        count against the slice budget. What was served (sources, sampled
 *        / truncated, recorded gaps) is getState().track for the chip; the
 *        chip goes when the aircraft is deselected, on a seek or LIVE;
 *        only the newest request, still on the shown frame and still the
 *        selected aircraft, may publish it (a late answer never does). A
 *        failed track request is a 404 (the layer keeps its frame trail),
 *        never a live track;
 *   vessels -> a 404 (the trail backfill falls back silently to the
 *        history-frame trail).
 * A failed feed passes them through with the rest.
 *
 * B12d (quakes, wind; historyFieldAdapters.js): an adapter may match a
 * browser-direct third-party URL by `host` (the USGS feed); take a B12c
 * 'nothing recorded' 404 as an EMPTY answer (`accept.notRecorded`, D3: the
 * reason goes to the chip, never live) or a binary slice (`accept.bytes`,
 * the wind grid); keep one cache across its request kinds (`paramsKey`)
 * and prefetch every request of a frame (`prefetchParams`). adapted.chip
 * is kept per feed for the chip strip; adapted.refresh (a refused answer)
 * drops the cache and asks the driver for one more refresh of that frame.
 *
 * Multipart frames (wind manifest + grid; review R1 on t_215e62e1): the
 * frame is ONE snapshot decided at its first request. `companionParams`
 * names the slices read together with the manifest; the history manifest
 * is served only when all of them succeed and agree (adapted.inconsistent
 * re-reads once, then fails the whole manifest -> live, D3), and the
 * companion answer is OWED (adapted.owe) to the layer's next dependent
 * request (`boundKey`: the grid id). An owed request is answered from that
 * answer whatever happened in between (seek, history failure, LIVE): a
 * history grid id is never sent to the live provider and the layer never
 * keeps a history field under a LIVE chip. A first request of a frame
 * (the manifest) drops anything owed; a dependent request with nothing
 * owed belongs to a live manifest and passes through to live.
 */
import { adapterForUrl, sliceUrl } from './historyAdapters.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';
import {
  TRACK_CACHE_MAX,
  TRACK_SPECS,
  TRACK_UNAVAILABLE,
  historyTrackUrl,
  trackIdOf,
  trackSummary,
  trackWindow,
} from './historyTrackAdapters.js';

export const LIVE_ONLY_FLAG = 'gevLive';
/** A playback move larger than this (or backwards) is a seek. */
export const PLAY_JUMP_MS = 10 * 60_000;
/** A known snapshot farther back than this is not the frame of t. */
export const MAX_FRAME_LAG_MS = 10 * 60_000;
const SNAPS_KEEP = 2_000;
/**
 * Slice requests per minute this tab allows itself. The history API limits
 * a client to 60 /api/history/* requests per minute (historyApi.js,
 * GEV_RATELIMIT_HISTORY_PER_MIN); the rest is left for the control's
 * coverage / snapshots questions. Playback paces its frames to this budget
 * (historyRefresh.js) and a prefetch never spends the last PREFETCH_RESERVE.
 */
export const SLICE_BUDGET_PER_MIN = 40;
/** Body of the 404 a live track route gets while its feed is in history. */
export const TRACK_IN_HISTORY = 'history: no live track at the history time';
export const PREFETCH_RESERVE = 6;

export class SliceError extends Error {
  constructor(kind, status = null) {
    super(`history slice ${kind}`);
    this.name = 'SliceError';
    this.kind = kind; // 'busy' | 'failed'
    this.status = status;
  }
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const isAbort = (e) => e?.name === 'AbortError';

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function requestOf(input, init) {
  const isRequest =
    input && typeof input === 'object' && !(input instanceof URL);
  const url = isRequest ? input.url : String(input);
  const method = String(
    init?.method ?? (isRequest ? input.method : 'GET') ?? 'GET',
  ).toUpperCase();
  const signal = init?.signal ?? (isRequest ? input.signal : null) ?? null;
  return { url, method, signal };
}

/** Lower-cased header object of a Response. */
function headerObject(response) {
  const out = {};
  try {
    response.headers?.forEach?.((v, k) => {
      out[String(k).toLowerCase()] = v;
    });
  } catch {
    /* none */
  }
  return out;
}

/** Sorted unique numbers. */
function mergeTimes(list, more) {
  const set = new Set(list);
  for (const x of more) if (Number.isFinite(x)) set.add(x);
  const out = [...set].sort((a, b) => a - b);
  return out.length > SNAPS_KEEP ? out.slice(out.length - SNAPS_KEEP) : out;
}

/** Largest value <= t (binary search), or null. */
function floorOf(sorted, t) {
  let lo = 0,
    hi = sorted.length - 1,
    out = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) {
      out = sorted[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return out;
}

/**
 * @param {object} options
 *   target               window (fetch owner)
 *   adapters             adapter registry (historyEventAdapters.js)
 *   getViewBox           camera view box [w, s, e, n] or null (FIRMS, D7)
 *   now                  wall clock ms (the rebase "now")
 *   retryMs              how long a failed feed passes through before retry
 *   busyRetryMs          one retry of a 429 (rate limit / busy) after this
 *   cacheMax             slice answers kept (LRU)
 *   prefetchConcurrency  prefetches in flight in total
 *   timers               {setTimeout, clearTimeout}
 */
export function createHistoryRouter({
  target = globalThis.window,
  adapters = ALL_HISTORY_ADAPTERS,
  getViewBox = () => null,
  now = () => Date.now(),
  base = '/api/history',
  retryMs = 15_000,
  busyRetryMs = 1_500,
  cacheMax = 32,
  prefetchConcurrency = 2,
  budgetPerMin = SLICE_BUDGET_PER_MIN,
  prefetchReserve = PREFETCH_RESERVE,
  timers = globalThis,
  monotonic = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  let inner = null; // the fetch below the router (feedChips -> browser)
  let restore = null;
  const s = { active: false, timeMs: null, playing: false, error: false };
  let gen = 0;
  const cache = new Map(); // slice url -> {promise, value}
  const snaps = new Map(); // snap feed -> sorted epoch ms
  const lastLive = new Map(); // adapter id -> {url, key}
  const failed = new Map(); // adapter id -> {retryAt} (latched, D3)
  const served = new Map(); // adapter id -> {t, rows, gap}
  const pinned = new Map(); // adapter id -> playback frame (driver)
  // R1: adapter id -> {key, t, answers}: the companion answer of the
  // history frame the layer is reading (the wind grid of the manifest it
  // was served), owed to its dependent request
  const owed = new Map();
  const listeners = new Set();
  const serveListeners = new Set(); // onServe (driver: frame reset / clock)
  const queue = []; // prefetch slice urls
  const running = new Map(); // prefetch url -> AbortController
  const stats = {
    slices: 0,
    cacheHits: 0,
    prefetches: 0,
    maxInFlight: 0,
    tracks: 0,
    trackCacheHits: 0,
  };
  const trackCache = new Map(); // track url -> {gen, promise, value}
  let track = null; // summary of the last served track (chip), or null
  // The newest track request ({seq, layerId, id}); only it may publish the
  // chip, and only while its frame is still the one shown (R1, see
  // answerTrack). A deselect / other selection / seek / LIVE bumps trackSeq.
  let trackSeq = 0;
  let trackWant = null;
  const spent = []; // monotonic ms of slice network requests (last minute)

  /** Slice requests left in the rolling minute. */
  function budgetLeft() {
    const floor = monotonic() - 60_000;
    while (spent.length && spent[0] <= floor) spent.shift();
    return budgetPerMin - spent.length;
  }

  const origin = () => target?.location?.origin ?? 'http://localhost';
  /** What an adapter's sliceParams may read besides the live URL. */
  const ctx = Object.freeze({ viewBox: () => getViewBox() });

  /** The slice questions of a live request (never throws). */
  function paramsOf(adapter, url) {
    try {
      return adapter.sliceParams(url, ctx);
    } catch {
      return [{}];
    }
  }

  function notify() {
    const st = getState();
    for (const fn of [...listeners]) {
      try {
        fn(st);
      } catch {
        /* keep going */
      }
    }
  }

  /** Announce an answer to a swapped feed's layer request (see module note). */
  function announce(event) {
    for (const fn of [...serveListeners]) {
      try {
        fn(event);
      } catch {
        /* a listener must never break the answer */
      }
    }
  }

  function getState() {
    return {
      active: s.active,
      timeMs: s.timeMs,
      playing: s.playing,
      swapped: adapters.filter((a) => isSwapped(a.id)).map((a) => a.id),
      failed: adapters.filter((a) => isFailed(a.id)).map((a) => a.id),
      served: Object.fromEntries(served),
      track,
      cacheSize: cache.size,
      prefetchInFlight: running.size,
      prefetchQueued: queue.length,
      budgetLeft: budgetLeft(),
      stats: { ...stats },
    };
  }

  /** The feed failed and no history answer was served since (latched). */
  function isFailed(id) {
    return failed.has(id);
  }

  /** A failed feed may try the slice again (retry eligibility, not state). */
  function retryDue(id) {
    const f = failed.get(id);
    return !f || f.retryAt <= now();
  }

  function markFailed(adapter) {
    const was = failed.has(adapter.id);
    failed.set(adapter.id, { retryAt: now() + retryMs });
    served.delete(adapter.id);
    if (!was) notify();
  }

  /** History is active and this feed is answered from history. */
  function isSwapped(id) {
    return s.active && adapters.some((a) => a.id === id) && !isFailed(id);
  }

  // ── cache ───────────────────────────────────────────────

  function clearCache() {
    cancelPrefetch();
    cache.clear();
  }

  function remember(url, entry) {
    cache.delete(url);
    cache.set(url, entry);
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      if (running.has(oldest)) break;
      cache.delete(oldest);
    }
  }

  async function fetchSlice(url, signal, accept = {}) {
    let response;
    try {
      response = await inner.call(target, url, {
        signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new SliceError('failed');
    }
    if (response?.status === 429) throw new SliceError('busy', 429);
    const type = String(response?.headers?.get?.('content-type') ?? '');
    // B12d: an adapter that takes it gets a B12c 'nothing recorded' 404
    // (D3: an empty answer + reason, never a failure that goes live)
    const notRecorded = accept.notRecorded && response?.status === 404;
    if (!response?.ok && !notRecorded)
      throw new SliceError('failed', response?.status ?? null);
    // B12d: a binary slice (the wind grid) for an adapter that takes it
    if (response.ok && accept.bytes && /octet-stream/i.test(type)) {
      let buffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new SliceError('failed', response.status);
      }
      return {
        body: null,
        bytes: new Uint8Array(buffer),
        status: response.status,
        headers: headerObject(response),
      };
    }
    if (!/\bjson\b/i.test(type))
      throw new SliceError('failed', response.status);
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new SliceError('failed', response.status);
    }
    if (!body || typeof body !== 'object')
      throw new SliceError('failed', response.status);
    if (notRecorded && body.error !== 'not_recorded')
      throw new SliceError('failed', response.status);
    return {
      body,
      ...(notRecorded ? { status: 404 } : {}),
      headers: headerObject(response),
    };
  }

  /** One slice answer, from the cache or the network (shared in flight). */
  function getSlice(url, { signal = null, prefetch = false, accept } = {}) {
    const hit = cache.get(url);
    if (hit) {
      if (!prefetch) stats.cacheHits++;
      // touch: keep the frame being shown
      cache.delete(url);
      cache.set(url, hit);
      return hit.promise;
    }
    stats.slices++;
    spent.push(monotonic());
    const entry = {};
    entry.promise = fetchSlice(url, signal, accept).then(
      (value) => {
        entry.value = value;
        return value;
      },
      (error) => {
        if (cache.get(url) === entry) cache.delete(url);
        throw error;
      },
    );
    remember(url, entry);
    return entry.promise;
  }

  // ── prefetch (D6) ───────────────────────────────────────

  function cancelPrefetch() {
    queue.length = 0;
    for (const [url, controller] of running) {
      controller.abort();
      running.delete(url);
    }
  }

  function pump() {
    while (running.size < prefetchConcurrency && queue.length) {
      // a prefetch never spends the budget the layers' own requests need
      if (budgetLeft() <= prefetchReserve) {
        queue.length = 0;
        return;
      }
      const { url, accept } = queue.shift();
      if (cache.has(url) || running.has(url)) continue;
      const controller = new AbortController();
      running.set(url, controller);
      stats.prefetches++;
      stats.maxInFlight = Math.max(stats.maxInFlight, running.size);
      getSlice(url, { signal: controller.signal, prefetch: true, accept })
        .catch(() => {})
        .finally(() => {
          if (running.get(url) === controller) running.delete(url);
          pump();
        });
    }
  }

  /** Slice URLs of an adapter's last live request at time t. */
  function urlsAt(adapter, t) {
    const last = lastLive.get(adapter.id);
    if (!last) return [];
    let url;
    try {
      url = new URL(last.url, origin());
    } catch {
      return [];
    }
    // B12d: an adapter whose frame is more than one request (the wind
    // manifest + grid) names every slice of the frame
    let params;
    try {
      params = adapter.prefetchParams?.(url) ?? paramsOf(adapter, url);
    } catch {
      params = paramsOf(adapter, url);
    }
    return params.map((p) => sliceUrl(adapter, p, t, base));
  }

  /** Queue the slices of `times` for a swapped adapter (cache fill). */
  function prefetch(adapterId, times) {
    const adapter = adapters.find((a) => a.id === adapterId);
    if (!adapter || !isSwapped(adapterId)) return [];
    const urls = [];
    for (const t of times)
      for (const url of urlsAt(adapter, t))
        if (
          !cache.has(url) &&
          !running.has(url) &&
          !queue.some((q) => q.url === url)
        ) {
          queue.push({ url, accept: adapter.accept });
          urls.push(url);
        }
    pump();
    return urls;
  }

  // ── frames ──────────────────────────────────────────────

  function setSnaps(feed, list) {
    snaps.set(feed, mergeTimes(snaps.get(feed) ?? [], list));
  }

  /** The slice time of an adapter at t (see the module note). */
  function frameTime(adapter, t = s.timeMs) {
    if (!Number.isFinite(t)) return t;
    if (!s.playing) return t;
    const list = adapter.snapFeed ? snaps.get(adapter.snapFeed) : null;
    if (list?.length) {
      const floor = floorOf(list, t);
      if (floor !== null && t - floor <= MAX_FRAME_LAG_MS) return floor;
    }
    const q = adapter.quantumMs;
    return q ? Math.floor(t / q) * q : t;
  }

  /**
   * Playback: the frame the driver chose to show for an adapter (a
   * prefetched recorded frame at or before t). Layer requests during
   * playback ask it, so a shown frame is the one prefetched for it.
   */
  function pinFrame(adapterId, frame) {
    if (Number.isFinite(frame)) pinned.set(adapterId, frame);
    else pinned.delete(adapterId);
  }

  /** The slice time a layer request asks now (pinned frame or frameTime). */
  function requestTime(adapter) {
    const t = s.timeMs;
    const pin = pinned.get(adapter.id);
    if (
      s.playing &&
      Number.isFinite(pin) &&
      pin <= t &&
      t - pin <= MAX_FRAME_LAG_MS
    )
      return pin;
    return frameTime(adapter, t);
  }

  /** The next `count` frame times after `frame` (known snapshots / quanta). */
  function nextFrames(adapter, frame, count = 2, limit = now()) {
    const out = [];
    const list = adapter.snapFeed ? snaps.get(adapter.snapFeed) : null;
    if (list?.length) {
      for (const x of list) {
        if (x > frame && x <= limit) out.push(x);
        if (out.length >= count) break;
      }
      return out;
    }
    const q = adapter.quantumMs;
    if (!q) return out;
    for (let x = frame + q; out.length < count && x <= limit; x += q)
      out.push(x);
    return out;
  }

  /** Known snapshot times after t (playback asks for more when short). */
  function snapsAfter(feed, t) {
    return (snaps.get(feed) ?? []).filter((x) => x > t);
  }

  // ── the history time ────────────────────────────────────

  /**
   * Feed the control state ('gev:history-time' detail / handle.getState()).
   * @returns {{entered, left, seeked, moved}}
   */
  function setHistory(detail = {}) {
    const active = Boolean(detail.active) && Number.isFinite(detail.timeMs);
    const timeMs = active ? detail.timeMs : null;
    const playing = active && Boolean(detail.playing);
    const error = Boolean(detail.error);
    const out = { entered: false, left: false, seeked: false, moved: false };
    // history is back (D3): failed feeds may retry at once; they stay
    // failed (LIVE chip) until a history answer is actually served
    if (s.error && !error) for (const f of failed.values()) f.retryAt = 0;
    s.error = error;
    if (!active) {
      if (s.active) {
        out.left = true;
        gen++;
        s.active = false;
        s.timeMs = null;
        s.playing = false;
        clearCache();
        failed.clear();
        served.clear();
        pinned.clear();
        // owed answers are NOT dropped: a layer between the halves of a
        // history frame completes that frame, then D4 refreshes it live
        clearTrack();
        notify();
      }
      return out;
    }
    const prev = s.timeMs;
    const wasPlaying = s.playing;
    if (!s.active) {
      out.entered = true;
      gen++;
      clearCache();
      clearTrack();
    } else if (timeMs !== prev) {
      out.moved = true;
      const jump =
        timeMs < prev ||
        timeMs - prev > PLAY_JUMP_MS ||
        !(wasPlaying && playing);
      if (jump) {
        out.seeked = true;
        gen++;
        clearCache();
        if (clearTrack()) notify();
      }
    }
    s.active = true;
    s.timeMs = timeMs;
    s.playing = playing;
    if (!playing || out.seeked || out.entered) pinned.clear();
    if (out.entered) notify();
    return out;
  }

  // ── the fetch wrapper ───────────────────────────────────

  function liveParamsKey(adapter, url) {
    if (typeof adapter.paramsKey === 'function') {
      try {
        return String(adapter.paramsKey(url));
      } catch {
        /* fall back to the slice params */
      }
    }
    return JSON.stringify(paramsOf(adapter, url));
  }

  /**
   * A view-dependent feed (FIRMS) would now ask other slice params than its
   * last request (the camera moved past its whole-degree box): the driver
   * refreshes its layer so the shown area is answered from history.
   */
  function viewMoved(adapterId) {
    const adapter = adapters.find((a) => a.id === adapterId);
    const last = lastLive.get(adapterId);
    if (!adapter?.viewDependent || !last) return false;
    try {
      return liveParamsKey(adapter, new URL(last.url, origin())) !== last.key;
    } catch {
      return false;
    }
  }

  /** Companion slice params of a request (never throws). */
  function companionsOf(adapter, url, answers) {
    try {
      return adapter.companionParams?.(url, answers) ?? [];
    } catch {
      return [];
    }
  }

  /** The dependent-request key of a URL (the wind grid id), or null. */
  function boundKeyOf(adapter, url) {
    try {
      return adapter.boundKey?.(url) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * R1: a dependent request (the wind grid) is answered from what its
   * history frame owes it, in any mode; with nothing owed it belongs to a
   * live manifest and goes to live. A first request of a frame drops what
   * was owed (a new read supersedes it). Returns a Response promise, or
   * null when the request is not a multipart request.
   */
  function multipart(adapter, url, input, init, signal) {
    if (typeof adapter?.boundKey !== 'function') return null;
    const key = boundKeyOf(adapter, url);
    if (key === null) {
      owed.delete(adapter.id);
      return null;
    }
    const due = owed.get(adapter.id);
    owed.delete(adapter.id);
    if (!due || due.key !== key) return inner.call(target, input, init);
    if (signal?.aborted) return Promise.reject(abortError());
    let adapted;
    try {
      adapted = adapter.adapt(due.answers, { t: due.t, nowMs: now(), url });
    } catch {
      adapted = null;
    }
    if (!adapted || adapted.refresh || adapted.inconsistent) {
      // cannot happen for a verified frame; never live, ask the layer again
      if (s.active) {
        clearCache();
        announce({ adapterId: adapter.id, mode: 'refresh', t: due.t });
      }
      return Promise.resolve(
        new Response(JSON.stringify(adapted?.body ?? {}), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(adapted.raw ?? JSON.stringify(adapted.body), {
        status: adapted.status ?? 200,
        headers: {
          ...adapted.headers,
          'X-History-T': new Date(due.t).toISOString(),
        },
      }),
    );
  }

  const sleep = (ms) =>
    new Promise((resolve) => timers.setTimeout(resolve, ms));

  async function answer(adapter, url, input, init, signal) {
    let busyRetried = false;
    const accept = adapter.accept ?? {};
    let reread = false; // R1: one re-read of an inconsistent frame
    // loops only when a seek / LIVE happened while the slice was pending
    for (;;) {
      const myGen = gen;
      const t = requestTime(adapter);
      const urls = paramsOf(adapter, url).map((params) =>
        sliceUrl(adapter, params, t, base),
      );
      let answers;
      let adapted = null;
      try {
        answers = await withSignal(
          Promise.all(urls.map((u) => getSlice(u, { accept }))),
          signal,
        );
        // R1: the slices read with this request (the wind grid of the
        // manifest): the frame is served only when all of them are there
        const more = companionsOf(adapter, url, answers).map((params) =>
          sliceUrl(adapter, params, t, base),
        );
        if (more.length) {
          urls.push(...more);
          answers = [
            ...answers,
            ...(await withSignal(
              Promise.all(more.map((u) => getSlice(u, { accept }))),
              signal,
            )),
          ];
        }
        if (s.active && gen === myGen) {
          adapted = adapter.adapt(answers, { t, nowMs: now(), url });
          if (adapted?.inconsistent) {
            // the halves do not belong together (the server re-read
            // another field in between): read the frame once more, then
            // the whole request fails (live, D3)
            for (const u of urls) cache.delete(u);
            if (!reread) {
              reread = true;
              continue;
            }
            throw new SliceError('failed');
          }
        }
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (!s.active) return inner.call(target, input, init);
        if (isAbort(error) || gen !== myGen) continue; // a seek: ask again
        if (
          error instanceof SliceError &&
          error.kind === 'busy' &&
          !busyRetried
        ) {
          busyRetried = true;
          await withSignal(sleep(busyRetryMs), signal);
          if (!s.active) return inner.call(target, input, init);
          continue;
        }
        // D3: any failure, a repeated 429 included -> live + unavailable
        markFailed(adapter);
        announce({ adapterId: adapter.id, mode: 'live' });
        return inner.call(target, input, init);
      }
      if (!s.active) return inner.call(target, input, init); // LIVE meanwhile
      if (gen !== myGen) continue; // a seek meanwhile: answer the new t
      const wasFailed = failed.delete(adapter.id);
      const nowMs = now();
      adapted ??= adapter.adapt(answers, { t, nowMs, url });
      const rows = Number(adapted.headers['X-History-Rows']) || 0;
      const prevServed = served.get(adapter.id);
      const truncated = adapted.headers['X-History-Truncated'] === '1';
      const chip = adapted.chip ?? null;
      served.set(adapter.id, {
        t,
        nowMs,
        rows,
        gap: adapted.headers['X-History-Gap'] === '1',
        truncated,
        chip,
      });
      // R1: the dependent request of this frame is answered from these
      if (adapted.owe?.key)
        owed.set(adapter.id, {
          key: adapted.owe.key,
          t,
          answers: adapted.owe.answers,
        });
      // the chip strip shows a truncated answer and a B12d reason / note
      // (layerChips.js)
      if (
        wasFailed ||
        !prevServed ||
        prevServed.truncated !== truncated ||
        JSON.stringify(prevServed.chip ?? null) !== JSON.stringify(chip)
      )
        notify();
      announce({ adapterId: adapter.id, mode: 'history', t, nowMs });
      // B12d: an answer the layer must not combine (a wind grid of another
      // read): the layer is asked again
      if (adapted.refresh) {
        // never the same pair again from the cache
        clearCache();
        announce({ adapterId: adapter.id, mode: 'refresh', t });
      }
      return new Response(adapted.raw ?? JSON.stringify(adapted.body), {
        status: adapted.status ?? 200,
        headers: {
          ...adapted.headers,
          'X-History-T': new Date(t).toISOString(),
        },
      });
    }
  }

  // ── recorded tracks (B12e) ──────────────────────────────

  /** Drop the track chip and the cached tracks; true if a chip was shown. */
  function clearTrack() {
    trackCache.clear();
    dropPendingTrack();
    const had = track !== null;
    track = null;
    return had;
  }

  /** No pending track request may publish its chip any more. */
  function dropPendingTrack() {
    trackSeq++;
    trackWant = null;
  }

  /** The time of the frame the layer shows (the track ends there). */
  function shownFrameT(adapter) {
    const frame = served.get(adapter.id);
    return Number.isFinite(frame?.t) ? frame.t : requestTime(adapter);
  }

  function setTrack(summary) {
    track = summary;
    notify();
  }

  async function fetchTrack(url) {
    let response;
    try {
      response = await inner.call(target, url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch {
      throw new SliceError('failed');
    }
    if (!response?.ok) throw new SliceError('failed', response?.status ?? null);
    const type = String(response.headers?.get?.('content-type') ?? '');
    if (!/\bjson\b/i.test(type))
      throw new SliceError('failed', response.status);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new SliceError('failed', response.status);
    }
    if (!body || typeof body !== 'object')
      throw new SliceError('failed', response.status);
    return { body, headers: headerObject(response) };
  }

  /** One track answer: cached for this history time, or the network. */
  function getTrack(url) {
    const hit = trackCache.get(url);
    if (hit && hit.gen === gen) {
      stats.trackCacheHits++;
      return { promise: hit.promise, cached: true };
    }
    stats.tracks++;
    spent.push(monotonic());
    const entry = { gen };
    entry.promise = fetchTrack(url).catch((error) => {
      if (trackCache.get(url) === entry) trackCache.delete(url);
      throw error;
    });
    trackCache.delete(url);
    trackCache.set(url, entry);
    while (trackCache.size > TRACK_CACHE_MAX)
      trackCache.delete(trackCache.keys().next().value);
    return { promise: entry.promise, cached: false };
  }

  const refuseTrack = (error) =>
    new Response(JSON.stringify({ error }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

  /** A selected aircraft's track route answered from history (B12e). */
  async function answerTrack(adapter, spec, url, signal) {
    const id = trackIdOf(spec, url);
    if (!id) return refuseTrack(TRACK_UNAVAILABLE);
    // the frame the layer shows: the track ends at its icon, same rebase
    const frame = served.get(adapter.id);
    const to = Number.isFinite(frame?.t) ? frame.t : requestTime(adapter);
    const deltaMs = Number.isFinite(frame?.nowMs)
      ? frame.nowMs - frame.t
      : now() - to;
    const { from } = trackWindow(to);
    const turl = historyTrackUrl(spec.feed, id, { from, to }, base);
    const myGen = gen;
    // R1: this is now the newest track request. A deselect, another
    // aircraft (either layer), a newer frame, a seek or LIVE while it is
    // pending means its answer (success or failure) must not publish the
    // chip: an old aircraft or an old frame would describe what is drawn.
    const mySeq = ++trackSeq;
    trackWant = { seq: mySeq, layerId: adapter.layerId, id };
    const current = () =>
      s.active &&
      gen === myGen &&
      trackSeq === mySeq &&
      shownFrameT(adapter) === to;
    const base0 = {
      adapterId: adapter.id,
      layerId: adapter.layerId,
      id,
      from,
      to,
    };
    const started = monotonic();
    const { promise, cached } = getTrack(turl);
    let got;
    try {
      got = await withSignal(promise, signal);
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw abortError();
      if (current())
        setTrack(trackSummary({ ...base0, status: 'unavailable' }));
      return refuseTrack(TRACK_UNAVAILABLE);
    }
    // a seek / LIVE meanwhile: never a track of another time (the new
    // frame asks again)
    if (!s.active || gen !== myGen) return refuseTrack(TRACK_UNAVAILABLE);
    const ms = Math.round(monotonic() - started);
    // a superseded answer still goes to its caller (the layer's own
    // backfill token drops it); it never becomes the chip
    if (current())
      setTrack(
        trackSummary({
          ...base0,
          body: got.body,
          headers: got.headers,
          ms,
          cached,
        }),
      );
    const out = spec.adapt(got.body, { deltaMs });
    const headers = {
      'Content-Type': 'application/json',
      'X-History-T': new Date(to).toISOString(),
      'X-History-From': new Date(from).toISOString(),
      'X-History-Rows': got.headers['x-history-rows'] ?? '0',
    };
    for (const h of ['sampled', 'truncated', 'gap', 'source'])
      if (got.headers[`x-history-${h}`])
        headers[`X-History-${h[0].toUpperCase()}${h.slice(1)}`] =
          got.headers[`x-history-${h}`];
    return new Response(JSON.stringify(out), { status: 200, headers });
  }

  const subjectOf = (event) => {
    const d = event?.detail ?? {};
    return {
      layerId: d.layerId,
      id: d.id == null ? '' : String(d.id).trim().toLowerCase(),
    };
  };
  const sameSubject = (d, x) =>
    Boolean(x) && d.layerId === x.layerId && (!d.id || d.id === x.id);

  /**
   * Deselecting the aircraft removes its track chip and drops its pending
   * track request (R1: a late answer never brings the chip back).
   */
  function onSubjectCleared(event) {
    const d = subjectOf(event);
    if (sameSubject(d, trackWant)) dropPendingTrack();
    if (sameSubject(d, track)) {
      track = null;
      notify();
    }
  }

  /** Selecting anything else (any layer) does the same for the old one. */
  function onSubjectSelected(event) {
    const d = subjectOf(event);
    if (!d.layerId || !d.id) return;
    const other = (x) => Boolean(x) && !sameSubject(d, x);
    if (other(trackWant)) dropPendingTrack();
    if (other(track)) {
      track = null;
      notify();
    }
  }

  function install() {
    if (restore || typeof target?.fetch !== 'function') return;
    inner = target.fetch;
    const wrapped = function historyRouterFetch(input, init) {
      // LIVE: straight through, unless a history frame still owes its
      // dependent request an answer (R1: LIVE between the wind halves)
      if (!s.active && !owed.size) return inner.call(target, input, init);
      let req;
      let url;
      let adapter;
      let trackAdapter = null;
      try {
        req = requestOf(input, init);
        url = new URL(req.url, origin());
        const asked = req.method === 'GET' && !init?.[LIVE_ONLY_FLAG];
        adapter = asked ? adapterForUrl(url, adapters) : null;
        trackAdapter = asked
          ? (adapters.find((a) => a.trackMatch?.test(url.pathname)) ?? null)
          : null;
      } catch {
        adapter = null;
      }
      // R1: the dependent half of a multipart frame (any mode)
      const part = adapter
        ? multipart(adapter, url, input, init, req.signal)
        : null;
      if (part) return part;
      if (!s.active) return inner.call(target, input, init);
      // a live track of a feed shown from history (see module note)
      if (trackAdapter && isSwapped(trackAdapter.id)) {
        const spec = TRACK_SPECS[trackAdapter.id];
        if (spec) return answerTrack(trackAdapter, spec, url, req.signal);
        return Promise.resolve(refuseTrack(TRACK_IN_HISTORY));
      }
      if (!adapter) return inner.call(target, input, init);
      // a failed feed passes through until its retry is due (D3)
      if (!retryDue(adapter.id)) {
        announce({ adapterId: adapter.id, mode: 'live' });
        return inner.call(target, input, init);
      }
      // D6: a new bbox / maxRows drops the prefetched frames
      const key = liveParamsKey(adapter, url);
      const last = lastLive.get(adapter.id);
      if (last && last.key !== key) clearCache();
      lastLive.set(adapter.id, { url: url.href, key });
      return answer(adapter, url, input, init, req.signal);
    };
    target.fetch = wrapped;
    target.addEventListener?.(
      'gev:awareness-subject-cleared',
      onSubjectCleared,
    );
    target.addEventListener?.(
      'gev:awareness-subject-selected',
      onSubjectSelected,
    );
    restore = () => {
      if (target.fetch === wrapped) target.fetch = inner;
      target.removeEventListener?.(
        'gev:awareness-subject-cleared',
        onSubjectCleared,
      );
      target.removeEventListener?.(
        'gev:awareness-subject-selected',
        onSubjectSelected,
      );
    };
  }

  return {
    install,
    setHistory,
    frameTime,
    requestTime,
    pinFrame,
    nextFrames,
    viewMoved,
    setSnaps,
    snapsAfter,
    prefetch,
    cancelPrefetch,
    clearCache,
    isSwapped,
    isFailed,
    getState,
    adapters,
    /** The fetch below the router (history requests of the driver). */
    innerFetch: (...args) => (inner ?? target.fetch).call(target, ...args),
    hasCached: (url) => cache.has(url),
    budgetLeft,
    budgetPerMin,
    frameBudgetPerMin: Math.max(1, budgetPerMin - prefetchReserve),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Answers to swapped feeds' layer requests (see module note). */
    onServe(fn) {
      serveListeners.add(fn);
      return () => serveListeners.delete(fn);
    },
    destroy() {
      restore?.();
      restore = null;
      clearCache();
      clearTrack();
      owed.clear();
      listeners.clear();
      serveListeners.clear();
      s.active = false;
    },
  };
}
