/**
 * History time slider: pure time math (gev-history DESIGN.md 4.5, card B11).
 *
 * Everything here is UTC epoch milliseconds and has no DOM, no fetch and no
 * clock of its own (callers pass `now`), so it is unit tested directly.
 *
 *   - span of the slider: now - 2 years .. now (HISTORY_SPAN_MS; the API
 *     itself accepts 731 days, so the slider never asks for a refused time)
 *   - presets 1 h / 24 h / 7 d / 30 d / 90 d / all = the visible window
 *   - coverage bucket per window (the API caps an answer at 2000 buckets)
 *   - snap-to-data and step selection over recorded snapshot times
 *   - the `ht=<ISO UTC>` URL parameter, its OWN parameter (never `l=`)
 */
import { HT_PARAM, isoUtc, parseHistoryTime } from '../skyView/skyUrl.js';

export { HT_PARAM };

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** Slider span: 2 years (owner R1). The API keeps 731 days. */
export const HISTORY_SPAN_MS = 730 * DAY_MS;

/** Visible-window presets, in display order. */
export const PRESETS = Object.freeze([
  Object.freeze({ id: '1h', label: '1 h', spanMs: HOUR_MS }),
  Object.freeze({ id: '24h', label: '24 h', spanMs: DAY_MS }),
  Object.freeze({ id: '7d', label: '7 d', spanMs: 7 * DAY_MS }),
  Object.freeze({ id: '30d', label: '30 d', spanMs: 30 * DAY_MS }),
  Object.freeze({ id: '90d', label: '90 d', spanMs: 90 * DAY_MS }),
  Object.freeze({ id: 'all', label: 'all', spanMs: HISTORY_SPAN_MS }),
]);
export const DEFAULT_PRESET = '24h';

/** Playback speeds (history seconds per wall second). */
export const RATES = Object.freeze([1, 10, 60, 600]);

/** API coverage buckets, smallest first (historyParams COVERAGE_BUCKETS). */
export const COVERAGE_BUCKETS = Object.freeze([
  Object.freeze({ id: '1m', ms: MINUTE_MS }),
  Object.freeze({ id: '5m', ms: 5 * MINUTE_MS }),
  Object.freeze({ id: '15m', ms: 15 * MINUTE_MS }),
  Object.freeze({ id: '1h', ms: HOUR_MS }),
  Object.freeze({ id: '6h', ms: 6 * HOUR_MS }),
  Object.freeze({ id: '1d', ms: DAY_MS }),
]);
/** Ribbon resolution: at most this many buckets per lane (API max 2000). */
export const MAX_RIBBON_BUCKETS = 1000;

/** Step without any recorded snapshot nearby (one adsb.lol bucket). */
export const FALLBACK_STEP_MS = MINUTE_MS;

const isTime = (value) => typeof value === 'number' && Number.isFinite(value);

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** Earliest time the slider offers at `now`. */
export function historyStart(now) {
  return now - HISTORY_SPAN_MS;
}

/** `t` clamped into [now - 2 y, now]. */
export function clampTime(t, now) {
  if (!isTime(t)) return now;
  return Math.min(now, Math.max(historyStart(now), t));
}

/**
 * Visible window of `spanMs` that holds `t`, inside [now - 2 y, now].
 * `anchor` is where t sits in the window (0 = left edge, 1 = right edge).
 */
export function windowAround(t, spanMs, now, anchor = 0.5) {
  const span = Math.min(Math.max(spanMs, MINUTE_MS), HISTORY_SPAN_MS);
  const start = historyStart(now);
  let from = clampTime(t, now) - span * Math.min(1, Math.max(0, anchor));
  from = Math.max(start, Math.min(from, now - span));
  return { from, to: from + span };
}

/**
 * The window to show for `t`: the current one while t stays inside it (with
 * a 5 % margin, or the live edge), else a new window. Playing forward puts t
 * at 10 % so the window moves rarely; otherwise t is centred.
 */
export function followWindow(
  current,
  t,
  spanMs,
  now,
  { playing = false } = {},
) {
  const span = Math.min(Math.max(spanMs, MINUTE_MS), HISTORY_SPAN_MS);
  if (
    current &&
    current.to - current.from === span &&
    t >= current.from &&
    t <= current.to
  ) {
    const margin = span * 0.05;
    // near an edge only matters when the window can still move that way
    const nearLeft =
      t < current.from + margin && current.from > historyStart(now) + margin;
    const nearRight = t > current.to - margin && current.to < now - margin;
    if (!nearLeft && !nearRight) return current;
  }
  return windowAround(t, span, now, playing ? 0.1 : 0.5);
}

/** Position of t in the window, 0..1. */
export function timeToFraction(t, win) {
  const span = win.to - win.from;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (t - win.from) / span));
}

/** Time at fraction f (0..1) of the window, whole seconds. */
export function fractionToTime(f, win) {
  const x = Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0));
  return Math.round((win.from + x * (win.to - win.from)) / 1000) * 1000;
}

/** Smallest API bucket that keeps a window at <= MAX_RIBBON_BUCKETS. */
export function coverageBucketFor(spanMs) {
  for (const bucket of COVERAGE_BUCKETS) {
    if (Math.ceil(spanMs / bucket.ms) <= MAX_RIBBON_BUCKETS) return bucket;
  }
  return COVERAGE_BUCKETS[COVERAGE_BUCKETS.length - 1];
}

/**
 * Coverage request range for a window: bucket-aligned so the same window
 * always asks the same question (cacheable), never past `now` and never
 * before the API's retention edge.
 */
export function coverageRange(win, now) {
  const bucket = coverageBucketFor(win.to - win.from);
  const from = Math.max(
    Math.ceil(historyStart(now) / bucket.ms) * bucket.ms,
    Math.floor(win.from / bucket.ms) * bucket.ms,
  );
  const to = Math.min(now, Math.ceil(win.to / bucket.ms) * bucket.ms);
  return {
    from,
    to: Math.max(to, from + bucket.ms),
    bucket: bucket.id,
    bucketMs: bucket.ms,
  };
}

/**
 * How far snap-to-data may move a released scrub: 0.2 % of the window (about
 * 2 px of a 1000 px bar), at least 1 min (one adsb.lol bucket), at most 10.
 */
export function snapToleranceMs(spanMs) {
  return Math.min(10 * MINUTE_MS, Math.max(MINUTE_MS, spanMs * 0.002));
}

/**
 * Nearest recorded snapshot to t within `toleranceMs`, else null (a gap:
 * the HUD then names it instead of jumping over it).
 */
export function snapTo(t, snaps, toleranceMs) {
  let best = null;
  for (const s of snaps ?? []) {
    if (!isTime(s)) continue;
    const d = Math.abs(s - t);
    if (d <= toleranceMs && (best === null || d < Math.abs(best - t))) best = s;
  }
  return best;
}

/**
 * The `count`-th recorded snapshot strictly after (dir > 0) or before
 * (dir < 0) t. Fewer available -> the farthest one; none -> null.
 */
export function pickStep(snaps, t, dir, count = 1) {
  const eps = 500; // a snapshot at t itself is not a step
  const side = [...new Set((snaps ?? []).filter(isTime))]
    .filter((s) => (dir > 0 ? s > t + eps : s < t - eps))
    .sort((a, b) => (dir > 0 ? a - b : b - a));
  if (!side.length) return null;
  return side[Math.min(count, side.length) - 1];
}

/**
 * Known-snapshot index. A /snapshots answer is the exact n nearest stored
 * snaps to `around`, so every snap within the farthest distance is known:
 * [around - d, around + d] is complete and steps inside it need no fetch.
 */
export function createSnapIndex({ maxEntries = 16 } = {}) {
  let entries = [];
  return {
    add(around, snaps) {
      const list = (snaps ?? []).filter(isTime).sort((a, b) => a - b);
      const d = list.reduce((m, s) => Math.max(m, Math.abs(s - around)), 0);
      entries = [
        { lo: around - d, hi: around + d, snaps: list },
        ...entries,
      ].slice(0, maxEntries);
    },
    /** Steps known without a fetch, or null when the index cannot tell. */
    step(t, dir, count) {
      for (const e of entries) {
        if (t < e.lo || t > e.hi) continue;
        const inside = e.snaps.filter((s) => (dir > 0 ? s <= e.hi : s >= e.lo));
        const pick = pickStep(inside, t, dir, count);
        const ahead = inside.filter((s) =>
          dir > 0 ? s > t + 500 : s < t - 500,
        );
        if (pick !== null && ahead.length >= count) return pick;
      }
      return null;
    },
    clear() {
      entries = [];
    },
    get size() {
      return entries.length;
    },
  };
}

/** Wall step fallback when no snapshot is known: count x 1 min. */
export function fallbackStep(t, dir, count, now) {
  return clampTime(t + Math.sign(dir) * count * FALLBACK_STEP_MS, now);
}

/** Advance a playing clock by `wallMs` at `rate`; stops at now. */
export function advance(t, wallMs, rate, now) {
  const next = t + Math.max(0, wallMs) * rate;
  if (next >= now) return { timeMs: now, reachedNow: true };
  return { timeMs: Math.max(historyStart(now), next), reachedNow: false };
}

/** ms -> `ht` value (ISO UTC, whole seconds, Sky's strict form). */
export function encodeHt(ms) {
  return isoUtc(Math.floor(ms / 1000) * 1000);
}

/** `ht` value -> ms inside [now - 2 y, now], else null. */
export function decodeHt(value, now) {
  const ms = parseHistoryTime(value);
  if (!isTime(ms)) return null;
  if (ms < historyStart(now) || ms > now + 5 * MINUTE_MS) return null;
  return Math.min(ms, now);
}

/** History time from a page address, or null (absent / invalid / old). */
export function readHtFromUrl(href, now) {
  try {
    return decodeHt(new URL(href).searchParams.get(HT_PARAM), now);
  } catch {
    return null;
  }
}

/**
 * Address with `ht` set (ms) or removed (null). Other query parameters and
 * the share hash (`l=` and friends) are kept exactly.
 */
export function writeHtToUrl(href, ms) {
  const url = new URL(href);
  if (isTime(ms)) url.searchParams.set(HT_PARAM, encodeHt(ms));
  else url.searchParams.delete(HT_PARAM);
  // readable like Sky's `sv`: ',' and ':' are legal in a query string
  url.search = url.searchParams
    .toString()
    .replace(/%2C/gi, ',')
    .replace(/%3A/gi, ':');
  return url.href;
}

/** "2026-10-13 14:02:05Z" */
export function formatUtc(ms, { seconds = true } = {}) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, seconds ? 19 : 16)}Z`;
}
