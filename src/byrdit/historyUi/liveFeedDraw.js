/**
 * Live-layer drawing of a stopped feed (gev-history DESIGN 2.4b + 4.5,
 * owner N5; card B12f). B11 (feedChips.js) judges each bridged feed and
 * announces window 'gev:feed-state' {feed, state, draw, ...}; it draws only
 * the chip. This module makes the LAYER follow it, in LIVE mode:
 *
 *   live     drawn normally
 *   grey     the last good data stays drawn, GREY (greyPainter.js) - the
 *            state 'grey', or 'paused' while draw is still true
 *   cleared  draw:false (cleared, none, or paused past greyUntil): the
 *            layer shows NOTHING, only the chip remains
 *
 * CLEARED is done with the layer's own parser: a pass-through window.fetch
 * gate, installed BELOW the history router and ABOVE the B11 chip observer
 *
 *   layer source -> history router -> this gate -> feedChips -> browser
 *
 * answers a bridged live request whose bridge answer says draw:false with an
 * EMPTY body of the exact live shape (the B12a/B12b adapters' recorded-gap
 * shape, which every layer already draws as nothing) and the bridge's own
 * X-Feed-* headers. The chips still see the real answer, so the chip and
 * the resume stay right. The layers that would otherwise keep absent items
 * for a grace (flights / military missing-poll fade, transit 2-poll
 * eviction, vessels) get their frame seam armed once (resetForHistoryFrame),
 * bike share its reload seam (reloadForHistoryFrame) once on clearing and
 * once on resuming (its station information is cached for the page life).
 *
 * TIME: grey vs cleared is judged ONLY on the server clock - the answer's
 * own headers (staleness.js feedDisplayState: X-Feed-Grey-Until vs
 * X-Feed-Last-OK + X-Feed-Age-Ms) or the B11 event (server clock + a
 * monotonic elapsed). Nothing here reads the browser wall clock.
 *
 * TRANSITIONS: refreshLayer runs ONCE when a feed becomes cleared (the
 * re-ask is answered empty) and ONCE when it is drawn again (the next real
 * answer passes through). live <-> grey only repaints.
 *
 * HISTORY (D3): a feed that the router answers from history is never
 * touched: its requests never reach this gate, the painter leaves its layer
 * alone and its transitions are only recorded (the LIVE exit refresh, D4,
 * re-asks through this gate).
 *
 * Satellites: its layer keeps the old catalog when every group answers
 * empty (the CelesTrak outage guard), so an empty body cannot clear it and
 * its point collection is not reachable without an upstream line; it gets
 * the chip only (listed on the card).
 */
import { feedDisplayState } from '../history/staleness.js';
import { FEED_STATE_EVENT, feedOfUrl, isBridgeAnswer } from './feedChips.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';

export const MODE_LIVE = 'live';
export const MODE_GREY = 'grey';
export const MODE_CLEARED = 'cleared';

/** The header that marks an answer this gate emptied (QA, tests). */
export const CLEARED_HEADER = 'X-Gev-Feed-Cleared';
/** Cyclones: an empty envelope needs a reason (else "no active storms"). */
export const CYCLONE_CLEARED_REASON =
  'Cyclone feed stopped: no current advisory data';

/**
 * Bridged feed (B11 chip id) -> its layer.
 *   seam   'reset'  arm resetForHistoryFrame once when it is cleared, so
 *                   the empty answer drops every item at once
 *          'reload' reloadForHistoryFrame once on clearing and on resuming
 *   empty  false    an empty body cannot clear the layer (chip only)
 */
export const LIVE_DRAW_FEEDS = Object.freeze({
  flights: Object.freeze({ layerId: 'flights', seam: 'reset', empty: true }),
  military: Object.freeze({ layerId: 'military', seam: 'reset', empty: true }),
  vessels: Object.freeze({
    layerId: 'ais-live-vessels',
    seam: 'reset',
    empty: true,
  }),
  firms: Object.freeze({ layerId: 'local-firms', seam: null, empty: true }),
  'fire-perimeters': Object.freeze({
    layerId: 'fire-perimeters',
    seam: null,
    empty: true,
  }),
  cyclones: Object.freeze({
    layerId: 'weather-cyclones',
    seam: null,
    empty: true,
  }),
  launches: Object.freeze({
    layerId: 'rocket-launches',
    seam: null,
    empty: true,
  }),
  satellites: Object.freeze({
    layerId: 'satellites',
    seam: null,
    empty: false,
  }),
  transit: Object.freeze({ layerId: 'transit', seam: 'reset', empty: true }),
  bikeshare: Object.freeze({
    layerId: 'bikeshare',
    seam: 'reload',
    empty: true,
  }),
});

/** The layer of a feed id, or null. */
export const layerOfFeed = (feed) => LIVE_DRAW_FEEDS[feed]?.layerId ?? null;

/** The feed id of a layer id, or null. */
export function feedOfLayer(layerId) {
  for (const [feed, spec] of Object.entries(LIVE_DRAW_FEEDS))
    if (spec.layerId === layerId) return feed;
  return null;
}

/**
 * 'gev:feed-state' detail -> live | grey | cleared. draw:false always
 * clears (cleared, none, a pause past greyUntil); a feed that is not live
 * but still drawn (grey, paused) is grey. Pure: no clock at all.
 */
export function drawModeOf(detail) {
  if (!detail || typeof detail !== 'object') return MODE_LIVE;
  if (detail.draw === false) return MODE_CLEARED;
  if (!detail.state || detail.state === 'live') return MODE_LIVE;
  return MODE_GREY;
}

/**
 * Does one bridge answer still draw? Its own headers on the server clock
 * (staleness.js); an answer without the bridge headers always draws.
 */
export function answerDraws(response, { greyMs } = {}) {
  if (!response || !isBridgeAnswer(response)) return true;
  try {
    return feedDisplayState(response, greyMs ? { greyMs } : {}).draw;
  } catch {
    return true;
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';
/** Cyclone envelope fields kept from the real answer (static texts). */
const CYCLONE_ENVELOPE = ['source', 'attribution', 'coverage', 'fetchedAt'];
/** Feeds whose emptied body keeps envelope fields of the real answer. */
const READS_ENVELOPE = new Set(['cyclones']);

function lastOkOf(response) {
  const n = Number(response?.headers?.get?.('x-feed-last-ok'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The EMPTY live body of a feed, from its history adapter's recorded-gap
 * shape (the layers' own parsers draw it as nothing). Every time in it is
 * the bridge's X-Feed-Last-OK (server clock: when the data was last good),
 * never the browser clock; nothing is rebased.
 */
export function clearedBody(feed, url, lastOkMs = 0, live = null) {
  const adapter = ALL_HISTORY_ADAPTERS.find((a) => a.id === feed);
  if (!adapter) return null;
  const t = Number.isFinite(lastOkMs) ? lastOkMs : 0;
  const out = adapter.adapt([{ body: {}, headers: {} }], {
    t,
    nowMs: t,
    url,
  });
  const body = { ...out.body };
  if (feed === 'cyclones') {
    // the live envelope texts (validateCycloneSnapshot) come from the real
    // answer; only its storms are dropped
    for (const k of CYCLONE_ENVELOPE) if (live && k in live) body[k] = live[k];
    Object.assign(body, {
      schemaVersion: 1,
      stale: true,
      reason: CYCLONE_CLEARED_REASON,
    });
  }
  if (feed === 'launches') delete body.gevAsOf;
  if (feed === 'vessels') delete body.source;
  if (feed === 'firms' || feed === 'fire-perimeters') {
    body.fetchedAt = t || null;
    if (feed === 'firms') body.stale = true;
  }
  return body;
}

/** The emptied answer: live body shape + the bridge's X-Feed-* headers. */
export function clearedResponse(feed, url, response, live = null) {
  const body = clearedBody(feed, url, lastOkOf(response), live);
  if (!body) return response;
  const headers = { 'Content-Type': JSON_TYPE, [CLEARED_HEADER]: '1' };
  try {
    response.headers.forEach((v, k) => {
      if (/^x-feed-/i.test(k)) headers[k] = v;
    });
  } catch {
    /* no headers to keep */
  }
  try {
    response.body?.cancel?.()?.catch?.(() => {});
  } catch {
    /* already used or locked */
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/**
 * @param {object} options
 *   target          the window (fetch owner + 'gev:feed-state' target)
 *   getRouter       () => the history router (isSwapped), or null
 *   getDataManager  () => shell._dataManager (refreshLayer, layers)
 *   greyMs          fallback grey window for answers without Grey-Until
 */
export function createLiveFeedDraw({
  target = globalThis.window,
  getRouter = () => null,
  getDataManager = () => null,
  greyMs,
} = {}) {
  const modes = new Map(); // feed -> live | grey | cleared (events)
  const blanked = new Set(); // url paths answered empty right now
  const listeners = new Set();
  const stats = { emptied: 0, refreshes: 0, seams: 0 };
  let inner = null;
  let restore = null;
  let destroyed = false;

  const origin = () => target?.location?.origin ?? 'http://localhost';
  const dm = () => safeGet(getDataManager);

  /** The router answers this feed from history now (D3: hands off). */
  function isSwapped(feed) {
    try {
      return Boolean(safeGet(getRouter)?.isSwapped?.(feed));
    } catch {
      return false;
    }
  }

  function layerModule(layerId) {
    try {
      return dm()?.layers?.get?.(layerId)?.module ?? null;
    } catch {
      return null;
    }
  }

  function isEnabled(layerId) {
    try {
      const ids = dm()?.getEnabledLayerIds?.();
      return ids instanceof Set
        ? ids.has(layerId)
        : [...(ids ?? [])].includes(layerId);
    } catch {
      return false;
    }
  }

  function seam(feed, kind) {
    const spec = LIVE_DRAW_FEEDS[feed];
    if (!spec || spec.seam !== kind) return;
    const layer = layerModule(spec.layerId);
    try {
      if (kind === 'reset') layer?.resetForHistoryFrame?.();
      else layer?.reloadForHistoryFrame?.();
      stats.seams++;
    } catch {
      /* a layer without the seam keeps its own behaviour */
    }
  }

  function refreshOnce(feed) {
    const layerId = layerOfFeed(feed);
    if (!layerId || !isEnabled(layerId)) return;
    const manager = dm();
    if (typeof manager?.refreshLayer !== 'function') return;
    stats.refreshes++;
    try {
      Promise.resolve(manager.refreshLayer(layerId)).catch(() => {});
    } catch {
      /* the layer's own interval asks again */
    }
  }

  function notify() {
    for (const fn of [...listeners]) safe(() => fn(getState()));
  }

  /** One bridged answer: pass it, or empty it (draw:false). */
  function gate(feed, url, response) {
    const spec = LIVE_DRAW_FEEDS[feed];
    if (!spec || !response || !isBridgeAnswer(response)) return response;
    // per url (transit / bike share ask one url per system); the seams run
    // per FEED edge, so a reload that re-asks every url runs once
    const key = `${feed} ${url.pathname}`;
    const feedBlank = () => [...blanked].some((k) => k.startsWith(`${feed} `));
    if (answerDraws(response, { greyMs })) {
      if (blanked.delete(key)) {
        // drawn again: bike share drops its emptied station cache
        if (!feedBlank()) seam(feed, 'reload');
        notify();
      }
      return response;
    }
    if (!spec.empty) return response; // chip only (see module note)
    if (!blanked.has(key)) {
      const first = !feedBlank();
      blanked.add(key);
      // the empty answer must drop what is drawn at once (no grace); the
      // frame arm is per url (over-arming is harmless), the reload per feed
      seam(feed, 'reset');
      if (first) seam(feed, 'reload');
      notify();
    }
    stats.emptied++;
    if (!READS_ENVELOPE.has(feed)) return clearedResponse(feed, url, response);
    return response.json().then(
      (live) => clearedResponse(feed, url, response, live),
      () => clearedResponse(feed, url, response),
    );
  }

  function onFeedState(event) {
    if (destroyed) return;
    const d = event?.detail;
    const feed = d?.feed;
    if (!LIVE_DRAW_FEEDS[feed]) return;
    const mode = drawModeOf(d);
    const prev = modes.get(feed) ?? MODE_LIVE;
    modes.set(feed, mode);
    if (mode === prev) return;
    notify();
    // history shows this layer: only remember the live state (D3)
    if (isSwapped(feed)) return;
    // drawn <-> not drawn: ask the layer once; the gate answers the re-ask
    if ((prev === MODE_CLEARED) !== (mode === MODE_CLEARED)) refreshOnce(feed);
  }

  /** What the painter does with a layer now: live | grey | cleared. */
  function paintModeOf(layerId) {
    const feed = feedOfLayer(layerId);
    if (!feed || isSwapped(feed)) return MODE_LIVE;
    return modes.get(feed) ?? MODE_LIVE;
  }

  function getState() {
    return {
      modes: Object.fromEntries(modes),
      blanked: [...blanked],
      stats: { ...stats },
    };
  }

  function install() {
    if (restore || typeof target?.fetch !== 'function') return;
    inner = target.fetch;
    const wrapped = function liveFeedDrawFetch(input, init) {
      const promise = inner.call(target, input, init);
      let feed = null;
      let url = null;
      try {
        const isRequest =
          input && typeof input === 'object' && !(input instanceof URL);
        const method = String(
          init?.method ?? (isRequest ? input.method : 'GET') ?? 'GET',
        ).toUpperCase();
        url = new URL(isRequest ? input.url : String(input), origin());
        feed = method === 'GET' ? feedOfUrl(url.href, origin())?.id : null;
      } catch {
        feed = null;
      }
      if (!feed || !LIVE_DRAW_FEEDS[feed]) return promise;
      return Promise.resolve(promise).then((response) => {
        try {
          return gate(feed, url, response);
        } catch {
          return response; // the gate must never break a request
        }
      });
    };
    target.fetch = wrapped;
    target.addEventListener?.(FEED_STATE_EVENT, onFeedState);
    restore = () => {
      if (target.fetch === wrapped) target.fetch = inner;
      target.removeEventListener?.(FEED_STATE_EVENT, onFeedState);
    };
  }

  return {
    install,
    gate,
    paintModeOf,
    modeOf: (feed) => modes.get(feed) ?? MODE_LIVE,
    getState,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      restore?.();
      restore = null;
      listeners.clear();
      modes.clear();
      blanked.clear();
    },
  };
}

function safeGet(fn) {
  try {
    return fn?.() ?? null;
  } catch {
    return null;
  }
}

function safe(fn) {
  try {
    fn();
  } catch {
    /* keep going */
  }
}
