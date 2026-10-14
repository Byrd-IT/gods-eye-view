/**
 * Per-layer feed chips from the collector-bridge headers (gev-history
 * DESIGN.md 2.4b + 4.5, owner N5; card B11 item 6).
 *
 * The live layers already fetch /api/<feed>; this module only LOOKS at those
 * responses (status + headers, never the body) through a pass-through
 * wrapper of window.fetch: the caller gets the very same Response promise,
 * so no layer request or answer changes. Each bridged feed then has a state
 * from staleness.js feedDisplayState (server clock, never the browser's):
 *
 *   live     green LIVE
 *   grey     "No data since HH:MM <tz>" + age; the layer keeps its last good
 *            data for GEV_STALE_GREY_MS (1 h) from X-Feed-Stale-Since
 *   cleared  same chip after the grey hour: the layer must show nothing
 *   none     no snapshot at all (503): chip only
 *   paused   "OpenSky paused until HH:MM UTC" (X-Feed-Reason)
 *
 * Grey -> cleared between two polls is judged on the server clock of the
 * last answer plus the monotonic time elapsed since it (performance.now),
 * so a slow feed (FIRMS, 30 min) still clears on time. A page opened after
 * the window is cleared at its first answer.
 *
 * Every change is also announced as window CustomEvent 'gev:feed-state'
 * {feed, label, state, draw, chip, lastOkAt, staleSince, greyUntil} - the
 * hook B12 uses to grey / clear the layer drawings themselves (B11 adds no
 * layer code: DESIGN 4.1 one-touch-point rule).
 */
import {
  DEFAULT_STALE_GREY_MS,
  feedDisplayState,
  formatClock,
} from '../history/staleness.js';

export const FEED_STATE_EVENT = 'gev:feed-state';

/** Bridged live routes (DESIGN 4.2) -> chip feed. Track routes are on demand. */
export const BRIDGED_FEEDS = Object.freeze([
  Object.freeze({
    id: 'flights',
    label: 'Flights',
    match: /^\/api\/flights\/?$/,
  }),
  Object.freeze({
    id: 'military',
    label: 'Military',
    match: /^\/api\/military\/?$/,
  }),
  Object.freeze({
    id: 'vessels',
    label: 'Vessels',
    match: /^\/api\/vessels\/?$/,
  }),
  Object.freeze({ id: 'firms', label: 'Fires', match: /^\/api\/firms\/?$/ }),
  Object.freeze({
    id: 'fire-perimeters',
    label: 'Perimeters',
    match: /^\/api\/fire-perimeters\/?$/,
  }),
  Object.freeze({
    id: 'cyclones',
    label: 'Cyclones',
    match: /^\/api\/cyclones\/?$/,
  }),
  Object.freeze({
    id: 'launches',
    label: 'Launches',
    match: /^\/api\/launches\/?$/,
  }),
  Object.freeze({
    id: 'satellites',
    label: 'Satellites',
    match: /^\/api\/celestrak\/.+/,
  }),
  Object.freeze({
    id: 'transit',
    label: 'Transit',
    match: /^\/api\/transit\/vehicles\/.+/,
  }),
  Object.freeze({
    id: 'bikeshare',
    label: 'Bike share',
    match: /^\/api\/gbfs\/.+/,
  }),
]);

/** Severity: a layer group shows its worst member. */
const RANK = { live: 0, grey: 1, paused: 2, none: 3, cleared: 4 };

/** The feed of a request URL (path only), or null. */
export function feedOfUrl(url, origin = 'http://localhost') {
  let path;
  try {
    path = new URL(String(url), origin).pathname;
  } catch {
    return null;
  }
  return BRIDGED_FEEDS.find((f) => f.match.test(path)) ?? null;
}

const read = (headers, name) => {
  try {
    return headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
};

/** Only answers that carry the bridge contract headers make a chip. */
export function isBridgeAnswer(response) {
  const h = response?.headers;
  return Boolean(
    read(h, 'x-feed-last-ok') ||
    read(h, 'x-feed-reason') ||
    read(h, 'x-feed-stale-since'),
  );
}

const minutes = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

/**
 * One feed's state, re-evaluated at `elapsedMs` after its answer. The base
 * comes from feedDisplayState; only the grey -> cleared edge and the age
 * move with elapsed time.
 */
export function chipState(entry, elapsedMs, { timeZone, locale } = {}) {
  const base = entry.base;
  let state = base.state;
  const serverNow =
    entry.serverNow === null ? null : entry.serverNow + Math.max(0, elapsedMs);
  if (
    state === 'grey' &&
    serverNow !== null &&
    base.greyUntil !== null &&
    serverNow >= base.greyUntil
  )
    state = 'cleared';
  const paused =
    state !== 'live' && /^opensky_paused_until=/.test(base.reason ?? '');
  const draw = state === 'live' || state === 'grey';
  const ageMs =
    serverNow !== null && base.lastOkAt !== null
      ? serverNow - base.lastOkAt
      : null;
  let chip = 'LIVE';
  if (paused) chip = base.chip;
  else if (state !== 'live')
    chip =
      base.lastOkAt === null
        ? 'No data'
        : `No data since ${formatClock(base.lastOkAt, { timeZone, locale })}`;
  return {
    state: paused ? 'paused' : state,
    // paused keeps the grey/cleared drawing rule of the underlying state
    draw,
    chip,
    age: state === 'live' || ageMs === null ? null : minutes(ageMs),
    lastOkAt: base.lastOkAt,
    staleSince: base.staleSince,
    greyUntil: base.greyUntil,
    reason: base.reason,
  };
}

/**
 * @param {object} options
 *   target     the window (fetch owner + event target)
 *   monotonic  () => ms, default performance.now
 *   greyMs     fallback grey window when an answer has no X-Feed-Grey-Until
 *   timeZone, locale  for "HH:MM <tz>"
 */
export function createFeedChips({
  target = globalThis.window,
  monotonic = () => globalThis.performance?.now?.() ?? Date.now(),
  greyMs = DEFAULT_STALE_GREY_MS,
  timeZone,
  locale,
} = {}) {
  const entries = new Map(); // key (url path) -> {feed, base, serverNow, at}
  const listeners = new Set();
  let last = new Map(); // feed id -> signature
  let restore = null;

  function serverNowOf(response) {
    const lastOk = Number(read(response.headers, 'x-feed-last-ok'));
    const age = Number(read(response.headers, 'x-feed-age-ms'));
    return Number.isFinite(lastOk) &&
      lastOk > 0 &&
      Number.isFinite(age) &&
      age >= 0
      ? lastOk + age
      : null;
  }

  function observe(url, response) {
    const feed = feedOfUrl(url, target?.location?.origin);
    if (!feed || !response || !isBridgeAnswer(response)) return;
    const base = feedDisplayState(response, { greyMs, timeZone, locale });
    let key;
    try {
      key = new URL(String(url), target?.location?.origin ?? 'http://localhost')
        .pathname;
    } catch {
      key = feed.id;
    }
    entries.set(key, {
      feed,
      base,
      serverNow: serverNowOf(response),
      at: monotonic(),
    });
    refresh();
  }

  /** Worst state per feed id, at the current monotonic time. */
  function states() {
    const out = new Map();
    const t = monotonic();
    for (const entry of entries.values()) {
      const s = {
        feed: entry.feed.id,
        label: entry.feed.label,
        ...chipState(entry, t - entry.at, { timeZone, locale }),
      };
      const prev = out.get(entry.feed.id);
      if (!prev || RANK[s.state] > RANK[prev.state]) out.set(entry.feed.id, s);
    }
    return BRIDGED_FEEDS.map((f) => out.get(f.id)).filter(Boolean);
  }

  /** Re-evaluate (call on a timer); announces each feed whose state moved. */
  function refresh() {
    const list = states();
    const next = new Map(
      list.map((s) => [s.feed, `${s.state}|${s.chip}|${s.age}`]),
    );
    for (const s of list) {
      if (last.get(s.feed)?.split('|')[0] !== s.state) announce(s);
    }
    const changed =
      list.length !== last.size ||
      list.some((s) => last.get(s.feed) !== next.get(s.feed));
    last = next;
    if (changed) for (const fn of [...listeners]) safe(() => fn(list));
    return list;
  }

  function announce(s) {
    if (
      typeof target?.dispatchEvent !== 'function' ||
      typeof globalThis.CustomEvent !== 'function'
    )
      return;
    safe(() =>
      target.dispatchEvent(
        new globalThis.CustomEvent(FEED_STATE_EVENT, { detail: { ...s } }),
      ),
    );
  }

  /** Wrap target.fetch: same promise back, response looked at, never read. */
  function install() {
    if (restore || typeof target?.fetch !== 'function') return;
    const original = target.fetch;
    const wrapped = function historyChipFetch(input, init) {
      const promise = original.call(target, input, init);
      try {
        const url =
          typeof input === 'string' || input instanceof URL
            ? input
            : input?.url;
        if (feedOfUrl(url, target?.location?.origin))
          Promise.resolve(promise).then(
            (response) => safe(() => observe(url, response)),
            () => {},
          );
      } catch {
        /* observation must never break a request */
      }
      return promise;
    };
    target.fetch = wrapped;
    restore = () => {
      if (target.fetch === wrapped) target.fetch = original;
    };
  }

  return {
    install,
    observe,
    states,
    refresh,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      restore?.();
      restore = null;
      listeners.clear();
      entries.clear();
    },
  };
}

function safe(fn) {
  try {
    fn();
  } catch {
    /* keep going */
  }
}
