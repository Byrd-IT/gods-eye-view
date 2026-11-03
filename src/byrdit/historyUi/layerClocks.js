/**
 * History menu clocks (card t_73beacfb): the pure model behind the
 * per-layer sliders and the ONE lock group.
 *
 *   shared   the time of the main History slider (ms), or null = LIVE
 *   row      a time-capable layer: {id, label, adapterIds, releases?, earliest?}
 *   locked   the row follows `shared` (the lock group). Default: every row
 *            is locked, which is exactly the old single-slider behaviour
 *            (an old `ht=` link = all locked).
 *   own      the time of an UNLOCKED row (ms), or null = LIVE
 *
 * Locking rules (owner choice, 2026-11-01): ONE group. A ticked row moves
 * with the shared time; an unticked row keeps its own time. Lock all ticks
 * every row, Unlock all unticks every row.
 *   - unticking a row freezes it at the time it shows now (no jump)
 *   - ticking a row joins the shared time
 *   - Unlock all freezes every row at what it shows now
 * Release-based rows (Wayback, NAIP: `releases` = sorted release times)
 * show the nearest release at or before the time asked.
 *
 * URL: `ht=` stays the shared time (owned by the main control). Unlocked rows
 * are `hl=<row>:<ISO UTC|live>,...`; no `hl` = all locked.
 *
 * No DOM, no clock reads other than `now` (injectable).
 */
import { HISTORY_FLOOR_MS } from './historyTimeline.js';

export const HL_PARAM = 'hl';

const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/** Latest release at or before t, or null when t precedes them all. */
export function snapToRelease(releases, t) {
  if (!Array.isArray(releases) || !releases.length || !isTime(t)) return null;
  let best = null;
  for (const r of releases)
    if (isTime(r) && r <= t && (best === null || r > best)) best = r;
  return best;
}

const iso = (ms) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** `hl` value -> Map(rowId -> ms | null), ignoring malformed entries. */
export function decodeHl(value, now = Date.now()) {
  const out = new Map();
  if (typeof value !== 'string' || !value) return out;
  for (const part of value.split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const id = part.slice(0, i);
    const v = part.slice(i + 1);
    if (!/^[\w-]{1,40}$/.test(id)) continue;
    if (v === 'live') {
      out.set(id, null);
      continue;
    }
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)) continue;
    const ms = Date.parse(v);
    if (isTime(ms) && ms >= HISTORY_FLOOR_MS && ms <= now + 300_000)
      out.set(id, Math.min(ms, now));
  }
  return out;
}

/** Unlocked rows -> `hl` value ('' when none). */
export function encodeHl(entries) {
  return entries
    .map(([id, ms]) => `${id}:${isTime(ms) ? iso(ms) : 'live'}`)
    .join(',');
}

/**
 * @param {object} options
 * @param {Array} options.rows
 * @param {() => number} [options.now]
 */
export function createLayerClocks({ rows, now = () => Date.now() } = {}) {
  const list = rows.map((r) => ({ ...r }));
  const byId = new Map(list.map((r) => [r.id, r]));
  const st = new Map(list.map((r) => [r.id, { locked: true, own: null }]));
  let shared = null;
  const listeners = new Set();

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(api.getState());
      } catch {
        /* a listener must never break the model */
      }
    }
  };
  const floorOf = (row) =>
    isTime(row.earliest)
      ? Math.max(row.earliest, HISTORY_FLOOR_MS)
      : HISTORY_FLOOR_MS;
  // own = a row's own slider stops at the row's coverage start; a locked row
  // follows the shared time exactly (it has no data before its start: a gap,
  // which the menu says, not a different time)
  const place = (row, ms, own = true) => {
    if (!isTime(ms)) return null;
    const t = Math.min(
      now(),
      Math.max(own ? floorOf(row) : HISTORY_FLOOR_MS, ms),
    );
    if (row.releases?.length) return snapToRelease(row.releases, t);
    return t;
  };

  /** The time a row shows (ms), or null = LIVE. */
  function effective(id) {
    const row = byId.get(id);
    const s = st.get(id);
    if (!row || !s) return null;
    return s.locked ? place(row, shared, false) : s.own;
  }

  const api = {
    rows: list,
    row: (id) => byId.get(id) ?? null,
    isLocked: (id) => st.get(id)?.locked ?? false,
    effective,
    getShared: () => shared,
    /** Shared (locked group) time from the main slider; null = LIVE. */
    setShared(ms) {
      const next = isTime(ms)
        ? Math.min(now(), Math.max(HISTORY_FLOOR_MS, ms))
        : null;
      if (next === shared) return;
      shared = next;
      emit();
    },
    /** Move one row on its own: it leaves the lock group. */
    setOwn(id, ms) {
      const row = byId.get(id);
      const s = st.get(id);
      if (!row || !s) return;
      s.locked = false;
      s.own = place(row, ms);
      emit();
    },
    setLocked(id, locked) {
      const row = byId.get(id);
      const s = st.get(id);
      if (!row || !s || s.locked === Boolean(locked)) return;
      if (locked) {
        s.locked = true;
        s.own = null;
      } else {
        // freeze at what it shows now: no jump
        s.own = effective(id);
        s.locked = false;
      }
      emit();
    },
    toggleLock(id) {
      api.setLocked(id, !api.isLocked(id));
    },
    lockAll() {
      let changed = false;
      for (const [, s] of st)
        if (!s.locked) {
          s.locked = true;
          s.own = null;
          changed = true;
        }
      if (changed) emit();
    },
    unlockAll() {
      let changed = false;
      for (const row of list) {
        const s = st.get(row.id);
        if (s.locked) {
          s.own = effective(row.id);
          s.locked = false;
          changed = true;
        }
      }
      if (changed) emit();
    },
    /** A row to LIVE on its own (unlocks it). */
    setLive(id) {
      const s = st.get(id);
      if (!s) return;
      s.locked = false;
      s.own = null;
      emit();
    },
    /** adapterId -> ms | null for every UNLOCKED row (locked rows follow shared). */
    layerTimes() {
      const out = {};
      for (const row of list) {
        const s = st.get(row.id);
        if (s.locked) continue;
        for (const a of row.adapterIds ?? []) out[a] = s.own;
      }
      return out;
    },
    /** Unlocked rows for the URL, in row order. */
    urlEntries() {
      return list
        .filter((r) => !st.get(r.id).locked)
        .map((r) => [r.id, st.get(r.id).own]);
    },
    /** Apply an `hl` map (a shared link): listed rows unlocked. */
    applyHl(map) {
      let changed = false;
      for (const [id, ms] of map) {
        const row = byId.get(id);
        const s = st.get(id);
        if (!row || !s) continue;
        s.locked = false;
        s.own = place(row, ms);
        changed = true;
      }
      if (changed) emit();
    },
    /** Replace a row's releases / earliest once they are known. */
    setRowInfo(id, info = {}) {
      const row = byId.get(id);
      if (!row) return;
      if ('releases' in info) row.releases = info.releases;
      if ('earliest' in info) row.earliest = info.earliest;
      emit();
    },
    getState() {
      return {
        shared,
        rows: list.map((r) => {
          const timeMs = effective(r.id);
          return {
            id: r.id,
            locked: st.get(r.id).locked,
            timeMs,
            // in history by the group but nothing at or before the time
            // (before the first release): not LIVE, a gap
            gap: timeMs === null && st.get(r.id).locked && isTime(shared),
          };
        }),
        allLocked: list.every((r) => st.get(r.id).locked),
        noneLocked: list.every((r) => !st.get(r.id).locked),
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}

/**
 * The address with `hl` set from unlocked entries, or removed when none.
 * Only the hl pair is edited; every other parameter keeps its encoding.
 */
export function writeHlToUrl(href, entries) {
  const url = new URL(href);
  const value = encodeHl(entries);
  const kept = url.search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => pair && pair.split('=')[0] !== HL_PARAM);
  if (value) kept.push(`${HL_PARAM}=${value}`);
  url.search = kept.length ? `?${kept.join('&')}` : '';
  return url.href;
}

export function readHlFromUrl(href, now = Date.now()) {
  try {
    return decodeHl(new URL(href).searchParams.get(HL_PARAM), now);
  } catch {
    return new Map();
  }
}
