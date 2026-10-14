/**
 * Coverage ribbon model (gev-history DESIGN.md 4.5, card B11 item 3).
 *
 * Turns /api/history/coverage answers into lanes of segments for the ribbon
 * under the scrub bar, and answers "is t inside a known gap?" for the HUD.
 * Pure: no DOM, no fetch, `now` passed in.
 *
 * Segment kinds (one CSS class each):
 *   recorded    solid: data was recorded
 *   unverified  solid, lighter: adsb.lol day with data but no importer
 *               completion record yet (B9 contract: NOT a gap)
 *   partial     adsb.lol day whose record says more docs than are stored
 *   gap         hatched: known gap (gap-detector record, or an adsb.lol
 *               day with no data at all)
 *   pending     adsb.lol day not imported yet (today / just ended)
 *   none        blank: nothing recorded / outside retention / not polled
 *
 * Aircraft has two lanes (adsb.lol continuous to yesterday UTC; OpenSky only
 * where an area was polled, with tile outlines); collector feeds (military)
 * have one lane plus the gap list.
 */
import { DAY_MS, historyStart } from './historyTimeline.js';

/** adsb.lol publishes a day 0-3.4 h after it ends; allow 6 h before "gap". */
export const ADSBLOL_PUBLISH_GRACE_MS = 6 * 3_600_000;

export const LANE_LABELS = Object.freeze({
  adsblol: 'adsb.lol',
  opensky: 'OpenSky',
  military: 'Military',
});

const ADSBLOL_KIND = Object.freeze({
  complete: 'recorded',
  unverified: 'unverified',
  partial: 'partial',
  missing: 'gap',
});

/** ISO string or epoch (s or ms) -> ms, else null. */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e11 ? value * 1000 : value; // epoch seconds
  }
  const text = String(value);
  if (/^\d+(\.\d+)?$/.test(text)) return toMs(Number(text));
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const utcDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** Merge touching segments of one kind; clip to [from, to]; drop empties. */
export function normalizeSegments(segments, from, to) {
  const clipped = segments
    .map((s) => ({
      ...s,
      from: Math.max(from, s.from),
      to: Math.min(to, s.to),
    }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const out = [];
  for (const s of clipped) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === s.kind &&
      s.from <= last.to &&
      !s.tiles &&
      !last.tiles
    ) {
      last.to = Math.max(last.to, s.to);
    } else out.push({ ...s });
  }
  return out;
}

/**
 * Paint `over` segments on top of `base` (later wins), result sorted and
 * non-overlapping.
 */
export function overlay(base, over) {
  let result = [...base];
  for (const o of over) {
    const next = [];
    for (const s of result) {
      if (s.to <= o.from || s.from >= o.to) next.push(s);
      else {
        if (s.from < o.from) next.push({ ...s, to: o.from });
        if (s.to > o.to) next.push({ ...s, from: o.to });
      }
    }
    next.push(o);
    result = next.sort((a, b) => a.from - b.from);
  }
  return result;
}

function adsblolLane(lane, win, now) {
  const today = utcDay(now);
  const segments = [];
  for (const b of lane?.buckets ?? []) {
    const from = toMs(b.t);
    if (from === null) continue;
    const to = from + DAY_MS;
    let kind = ADSBLOL_KIND[b.status] ?? (b.docs > 0 ? 'unverified' : 'gap');
    // a day that has not ended + its publish grace is not a gap yet
    if (
      kind === 'gap' &&
      (from >= today || now - to < ADSBLOL_PUBLISH_GRACE_MS)
    )
      kind = 'pending';
    segments.push({
      from,
      to,
      kind,
      status: b.status ?? null,
      docs: b.docs ?? null,
    });
  }
  return {
    id: 'adsblol',
    label: LANE_LABELS.adsblol,
    latest: toMs(lane?.latest),
    segments: normalizeSegments(segments, win.from, win.to),
  };
}

function bucketLane(id, lane, bucketMs, win) {
  const segments = [];
  for (const b of lane?.buckets ?? []) {
    const from = toMs(b.t);
    if (from === null) continue;
    const kind =
      (b.polls_ok ?? 0) > 0 || (b.docs ?? 0) > 0 ? 'recorded' : 'none';
    const seg = { from, to: from + bucketMs, kind };
    if (Array.isArray(b.tiles) && b.tiles.length) seg.tiles = b.tiles;
    segments.push(seg);
  }
  return {
    id,
    label: LANE_LABELS[id] ?? id,
    tilesOmitted: Boolean(lane?.tilesOmitted),
    segments: normalizeSegments(segments, win.from, win.to),
  };
}

/** Gap records -> [{from, to, open}] (to null = still open: up to now). */
export function parseGaps(gaps, now) {
  const out = [];
  for (const g of gaps ?? []) {
    const from = toMs(g?.from);
    if (from === null) continue;
    const to = toMs(g?.to);
    out.push({ from, to: to ?? now, open: to === null });
  }
  return out.filter((g) => g.to > g.from);
}

/**
 * Lanes for the ribbon.
 * @param {object} input
 *   win       {from, to} visible window
 *   now       ms
 *   aircraft  /coverage?feed=aircraft answer (or null: failed / not asked)
 *   military  /coverage?feed=military answer (or null)
 * @returns {{lanes: Array, gaps: Array, retentionStart: number}}
 */
export function buildRibbon({ win, now, aircraft = null, military = null }) {
  const lanes = [];
  const gaps = [];
  const retentionStart = historyStart(now);
  const blankBefore = (lane) => {
    // outside retention = blank, whatever an answer says
    if (win.from < retentionStart)
      lane.segments = overlay(lane.segments, [
        { from: win.from, to: retentionStart, kind: 'none' },
      ]);
    lane.segments = normalizeSegments(lane.segments, win.from, win.to);
    return lane;
  };
  if (aircraft) {
    const byId = Object.fromEntries(
      (aircraft.lanes ?? []).map((l) => [l.source, l]),
    );
    const ads = adsblolLane(byId.adsblol, win, now);
    lanes.push(blankBefore(ads));
    for (const s of ads.segments)
      if (s.kind === 'gap')
        gaps.push({ lane: 'adsblol', from: s.from, to: s.to, open: false });
    const bucketMs = msOfBucket(byId.opensky?.bucket ?? aircraft.bucket);
    lanes.push(blankBefore(bucketLane('opensky', byId.opensky, bucketMs, win)));
  }
  if (military) {
    const lane = (military.lanes ?? [])[0];
    const bucketMs = msOfBucket(lane?.bucket ?? military.bucket);
    const built = bucketLane('military', lane, bucketMs, win);
    const recorded = parseGaps(military.gaps, now);
    built.segments = overlay(
      built.segments,
      recorded.map((g) => ({ from: g.from, to: g.to, kind: 'gap' })),
    );
    lanes.push(blankBefore(built));
    for (const g of recorded) gaps.push({ lane: 'military', ...g });
  }
  return { lanes, gaps, retentionStart };
}

const BUCKET_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '1d': DAY_MS,
};
function msOfBucket(id) {
  return BUCKET_MS[id] ?? 3_600_000;
}

/** Known gaps that contain t (end exclusive). */
export function gapsAt(t, ribbon) {
  return (ribbon?.gaps ?? []).filter((g) => t >= g.from && t < g.to);
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** "14:02-14:09 UTC" (same UTC day) or "2026-05-06 00:00-2026-05-07 00:00 UTC". */
export function formatGapRange(from, to, { open = false } = {}) {
  const end = open ? 'now' : null;
  if (!open && utcDay(from) === utcDay(to - 1) && to - from < DAY_MS)
    return `${hhmm(from)}-${hhmm(to)} UTC`;
  return `${ymd(from)} ${hhmm(from)}-${end ?? `${ymd(to)} ${hhmm(to)}`} UTC`;
}

/** HUD line for one gap (DESIGN 4.5 wording). */
export function gapText(gap) {
  const lane = LANE_LABELS[gap.lane] ?? gap.lane;
  return `No recording at this time (gap ${formatGapRange(gap.from, gap.to, gap)}) - ${lane}`;
}

/**
 * The "today" note (DESIGN 4.5): after the last imported adsb.lol bucket the
 * aircraft history comes only from OpenSky polls of watched areas.
 */
export function adsblolEndText(t, ribbon, now) {
  const lane = ribbon?.lanes?.find((l) => l.id === 'adsblol');
  if (!lane) return null;
  const latest = lane.latest ?? null;
  const edge = latest ?? utcDay(now);
  if (t <= edge) return null;
  const yesterdayEnd = utcDay(now);
  const when =
    latest !== null && latest >= yesterdayEnd - DAY_MS && latest <= yesterdayEnd
      ? 'yesterday 23:59Z'
      : latest !== null
        ? `${ymd(latest)} ${hhmm(latest)}Z`
        : 'before today';
  return `adsb.lol history ends ${when}; OpenSky only where you looked`;
}

/** Every HUD line for history time t (gaps first, then the today note). */
export function hudLines(t, ribbon, now) {
  const lines = gapsAt(t, ribbon).map(gapText);
  const end = adsblolEndText(t, ribbon, now);
  if (end) lines.push(end);
  return lines;
}

/** OpenSky tile bboxes [w,s,e,n] polled in the bucket holding t. */
export function openskyTilesAt(t, ribbon) {
  const lane = ribbon?.lanes?.find((l) => l.id === 'opensky');
  const seg = lane?.segments?.find((s) => t >= s.from && t < s.to && s.tiles);
  return seg?.tiles ?? [];
}
