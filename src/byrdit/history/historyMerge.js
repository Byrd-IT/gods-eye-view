/**
 * Pure snap and two-source merge helpers for /api/history (gev-history
 * DESIGN 1.3 #1c, 4.3; card B9 item 3).
 */

/** adsb.lol archive: 60 s buckets, snap = bucket end in epoch SECONDS. */
export const ADSBLOL_BUCKET_S = 60;
/** DESIGN 1.3 #1c: samples of the two sources within 5 s -> OpenSky wins. */
export const MERGE_TIE_MS = 5_000;
/**
 * Military recorder cadence: the ONE app-side copy of the collector's
 * military poll interval (gev-history src/feeds/military.js
 * MILITARY_CADENCE_MS / GEV_COLLECTOR_MILITARY_CADENCE_MS, default 300 s
 * since t_5ad2b9a4: adsb.lol allows 500 requests / 24 h per IP). The history
 * merge (below), the coverage lane's polls_expected (historyService.js
 * CADENCE_MS.military) and the bridge's last-good staleness (feeds.js
 * BRIDGE_FEEDS.military) all read this constant.
 */
export const MILITARY_CADENCE_MS = 300_000;
/**
 * A military poll is "the poll at t" when its snap is in [t - 3 x cadence, t]
 * (the collector's own stale threshold, DESIGN 2.4b): 900 s at 300 s polls.
 * Older = recording gap -> the adsb.lol archive fallback.
 */
export const MILITARY_MAX_SNAP_AGE_MS = 3 * MILITARY_CADENCE_MS;
/**
 * Stale union (TSDS duplicate rule): an aircraft whose position did not
 * change is not re-written, so the poll at S misses it. It is taken from the
 * polls of the previous STALE_UNION_SPAN_MS when its newest position is not
 * older than STALE_POSITION_MAX_MS before S. MEASURED 2026-10-14 on six
 * military polls: term(snap) + this union = 358-382 rows vs the live poll's
 * 358-381 positioned rows (docs_received), i.e. within -0/+3 %.
 *
 * Both limits are NOT cadence multiples, so they stay as measured at 300 s
 * polls (t_a6faec15):
 * - STALE_POSITION_MAX_MS is a limit on the POSITION age (upstream
 *   seen_pos), an upstream property. In the captured /v2/mil answers every
 *   current position is < 60 s old; only lastPosition fallbacks are older
 *   (in the 3 captures 8-14 % of positioned rows are > 300 s old, up to
 *   ~53 min; collector test/fixtures/military-v2-mil*.json). Keeping 180 s
 *   keeps the measured row match and the same rows for the same instant in
 *   the 60 s era (history before the cutover) and the 300 s era.
 * - A held position with time F was first written by the first poll at or
 *   after F, so its snap is >= F >= S - STALE_POSITION_MAX_MS. Any span >=
 *   STALE_POSITION_MAX_MS therefore finds it, whatever the cadence; 300 s
 *   covers 180 s. At 300 s polls the prior poll S - 300 s cannot hold a
 *   position newer than S - 300 s, so the union adds rows only around poll
 *   jitter; at 60 s polls (older history) it still does the measured work.
 */
export const STALE_UNION_SPAN_MS = 300_000;
export const STALE_POSITION_MAX_MS = 180_000;

/** Largest adsb.lol bucket end <= t, in epoch seconds. */
export function adsblolSnapAtOrBefore(tMs) {
  return Math.floor(tMs / 1000 / ADSBLOL_BUCKET_S) * ADSBLOL_BUCKET_S;
}

/**
 * Pick the n entries nearest to `around` from two sorted lists (before:
 * descending <= around; after: ascending > around). Returns ascending.
 * @param {number[]} before
 * @param {number[]} after
 */
export function nearestSnaps(before, after, around, n) {
  const merged = [...before, ...after]
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => Math.abs(a - around) - Math.abs(b - around) || a - b);
  return [...new Set(merged)].slice(0, n).sort((a, b) => a - b);
}

/**
 * Choose the military poll for t: newest snap <= t not older than
 * MILITARY_MAX_SNAP_AGE_MS. `snaps` = candidate poll snaps (ms).
 * @returns {number|null}
 */
export function pickPollSnap(snaps, tMs, maxAgeMs = MILITARY_MAX_SNAP_AGE_MS) {
  let best = null;
  for (const s of snaps) {
    if (!Number.isFinite(s) || s > tMs || s < tMs - maxAgeMs) continue;
    if (best === null || s > best) best = s;
  }
  return best;
}

/**
 * Newest sample per id (ties keep the first seen). Used for the stale union
 * and to collapse duplicate versions.
 * @template T
 * @param {T[]} samples
 * @param {(s: T) => string} idOf
 * @param {(s: T) => number} timeOf
 */
export function newestPerId(samples, idOf, timeOf) {
  const best = new Map();
  for (const s of samples) {
    const id = idOf(s);
    if (!id) continue;
    const prev = best.get(id);
    if (!prev || timeOf(s) > timeOf(prev)) best.set(id, s);
  }
  return best;
}

/**
 * Primary rows of the poll at S plus stale-union rows: an id absent from the
 * primary set is added from `prior` when its newest sample is not older than
 * S - STALE_POSITION_MAX_MS.
 * @param {{id: string, tsMs: number}[]} primary
 * @param {{id: string, tsMs: number}[]} prior
 */
export function staleUnion(
  primary,
  prior,
  snapMs,
  maxAgeMs = STALE_POSITION_MAX_MS,
) {
  const have = newestPerId(
    primary,
    (s) => s.id,
    (s) => s.tsMs,
  );
  const extra = newestPerId(
    prior.filter((s) => !have.has(s.id) && s.tsMs >= snapMs - maxAgeMs),
    (s) => s.id,
    (s) => s.tsMs,
  );
  return [...have.values(), ...extra.values()];
}

/**
 * DESIGN 1.3 #1c merge rule. Per icao24: the newest sample at or before t
 * from either source wins; if the newest adsb.lol and the newest OpenSky
 * samples are within MERGE_TIE_MS of each other, OpenSky wins. Samples
 * after t are ignored (never shown in a past view). Each output sample keeps
 * its `source`.
 * @param {{id: string, tsMs: number, source: string}[]} adsblol
 * @param {{id: string, tsMs: number, source: string}[]} opensky
 * @param {number} tMs
 */
export function mergeAircraft(adsblol, opensky, tMs) {
  const notAfter = (s) => Number.isFinite(s.tsMs) && s.tsMs <= tMs;
  const a = newestPerId(
    adsblol.filter(notAfter),
    (s) => s.id,
    (s) => s.tsMs,
  );
  const o = newestPerId(
    opensky.filter(notAfter),
    (s) => s.id,
    (s) => s.tsMs,
  );
  const out = [];
  for (const [id, sa] of a) {
    const so = o.get(id);
    if (!so) out.push(sa);
    else if (so.tsMs >= sa.tsMs - MERGE_TIE_MS) out.push(so);
    else out.push(sa);
  }
  for (const [id, so] of o) if (!a.has(id)) out.push(so);
  return out;
}

/** Which sources are present in a merged answer (X-History-Source). */
export function sourcesPresent(samples) {
  const set = new Set(samples.map((s) => s.source).filter(Boolean));
  return [...set].sort().join(',');
}

/** [w,s,e,n] tile vs bbox intersection (both closed boxes, degrees). */
export function boxesIntersect(a, b) {
  return a.w <= b.e && b.w <= a.e && a.s <= b.n && b.s <= a.n;
}
