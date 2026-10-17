/**
 * LIVE chips for the mixed state (gev-history DESIGN 4.5, card B12a, D5).
 *
 * While history is active, every ENABLED layer that is NOT answered from
 * history gets a visible 'LIVE' chip in the B11 chip strip, so a globe that
 * mixes recorded and live layers never does so silently. Enabled ids come
 * from shell._dataManager.getEnabledLayerIds() (updates via its subscribe);
 * a layer whose swap is not built yet, or whose history feed has failed and
 * passes through to live (D3), shows LIVE too.
 *
 * This wraps the B11 feed-chip provider and is passed to
 * mountHistoryControl({chips}); the control renders every chip whose state
 * is not 'live' even when collapsed. In history mode the live staleness
 * chip of a SWAPPED feed is dropped (its layer shows the recording, not the
 * live feed), and so are the green 'live' feed chips (the layer's LIVE chip
 * says it; grey / cleared / paused staleness chips stay). On LIVE the list
 * is the B11 list unchanged, so the LIVE chips disappear.
 *
 * A swapped layer whose last history answer was truncated by the slice
 * cap gets a 'HISTORY truncated' chip (B12b: FIRMS, X-History-Truncated).
 *
 * B12e: the recorded track of the selected aircraft (router state `track`)
 * gets a chip on its layer: the hex, the point count and the sources of
 * the merged track (adsb.lol / OpenSky), and, never silently, whether the
 * answer was SAMPLED or TRUNCATED, every recorded GAP inside [t-6h, t]
 * (the trail is one polyline and joins across it), no recording at all, or
 * the history track being unavailable.
 */
import { trackChipText, trackNeedsWarning } from './historyTrackAdapters.js';

export const UNSWAPPED_STATE = 'unswapped';
/** Chip text (named constants: no lowercase literal in a textContent=). */
export const LIVE_CHIP = 'LIVE';
export const LIVE_CHIP_UNAVAILABLE = 'LIVE (history unavailable)';
/**
 * B12b: a swapped layer whose last history answer was capped by the slice
 * API (X-History-Truncated: 1, e.g. FIRMS over a wide view) says so.
 */
export const TRUNCATED_STATE = 'truncated';
export const TRUNCATED_CHIP = 'HISTORY truncated (newest 15,000 rows)';
/** B12e: the selected aircraft's recorded track (warn: flagged / none). */
export const TRACK_STATE = 'track';
export const TRACK_WARN_STATE = 'track-warn';

/** B12d: the reason a swapped layer shows nothing at t / a note on it. */
export const EMPTY_NOTE_STATE = 'history-empty';
export const NOTE_STATE = 'history-note';

export function createLayerChips({
  feedChips,
  getRouter = () => null,
  getDataManager = () => null,
} = {}) {
  const listeners = new Set();
  let lastSig = '';
  let offManager = null;
  let offRouter = null;
  let offBase = null;
  let manager = null;

  function attach() {
    const dm = safeGet(getDataManager);
    if (dm && dm !== manager && typeof dm.subscribe === 'function') {
      offManager?.();
      manager = dm;
      offManager = dm.subscribe((change) => {
        // enabled set / names move on lifecycle changes; refresh events are
        // cheap to compare (the signature drops unchanged lists)
        if (change?.type === 'refresh') return;
        refresh({ base: false });
      });
    }
    const router = safeGet(getRouter);
    if (router && !offRouter && typeof router.subscribe === 'function')
      offRouter = router.subscribe(() => refresh({ base: false }));
  }

  function states() {
    attach();
    const base = feedChips?.states?.() ?? [];
    const router = safeGet(getRouter);
    const rs = router?.getState?.();
    if (!rs?.active) return base;
    const dm = safeGet(getDataManager);
    let enabled;
    let all;
    try {
      enabled = dm?.getEnabledLayerIds?.() ?? new Set();
      all = dm?.getAll?.() ?? [];
    } catch {
      enabled = new Set();
      all = [];
    }
    const adapters = router.adapters ?? [];
    const swappedFeeds = new Set(
      adapters.filter((a) => router.isSwapped(a.id)).map((a) => a.id),
    );
    const swappedLayers = new Set(
      adapters.filter((a) => swappedFeeds.has(a.id)).map((a) => a.layerId),
    );
    const failedLayers = new Set(
      adapters.filter((a) => router.isFailed?.(a.id)).map((a) => a.layerId),
    );
    // a swapped feed's live staleness chip is not about what it shows now;
    // a green live chip would only repeat the LIVE chip of its layer
    const out = base.filter(
      (c) => !swappedFeeds.has(c.feed) && c.state !== 'live',
    );
    const ids = [
      ...all.map((l) => l.id).filter((id) => enabled.has(id)),
      ...[...enabled].filter((id) => !all.some((l) => l.id === id)),
    ];
    for (const a of adapters) {
      if (!swappedFeeds.has(a.id) || !enabled.has(a.layerId)) continue;
      // B12d: a swapped layer's empty answer says why (D3: nothing is
      // drawn, never silently), or a note on what is drawn
      const note = rs.served?.[a.id]?.chip;
      if (note?.text)
        out.push({
          feed: `history-note:${a.id}`,
          layerId: a.layerId,
          label: all.find((l) => l.id === a.layerId)?.name || a.layerId,
          state:
            note.state === EMPTY_NOTE_STATE ? EMPTY_NOTE_STATE : NOTE_STATE,
          draw: note.state !== EMPTY_NOTE_STATE,
          chip: note.text,
          age: null,
          lastOkAt: null,
          staleSince: null,
          greyUntil: null,
          reason: note.reason ?? null,
        });
      if (!rs.served?.[a.id]?.truncated) continue;
      out.push({
        feed: `history:${a.id}`,
        layerId: a.layerId,
        label: all.find((l) => l.id === a.layerId)?.name || a.layerId,
        state: TRUNCATED_STATE,
        draw: true,
        chip: TRUNCATED_CHIP,
        age: null,
        lastOkAt: null,
        staleSince: null,
        greyUntil: null,
        reason: null,
      });
    }
    const tr = rs.track;
    if (tr && swappedFeeds.has(tr.adapterId) && enabled.has(tr.layerId))
      out.push({
        feed: `history-track:${tr.adapterId}`,
        layerId: tr.layerId,
        label: all.find((l) => l.id === tr.layerId)?.name || tr.layerId,
        state: trackNeedsWarning(tr) ? TRACK_WARN_STATE : TRACK_STATE,
        draw: true,
        chip: trackChipText(tr),
        age: null,
        lastOkAt: null,
        staleSince: null,
        greyUntil: null,
        reason: null,
      });
    for (const id of ids) {
      if (swappedLayers.has(id)) continue;
      const label = all.find((l) => l.id === id)?.name || id;
      out.push({
        feed: `layer:${id}`,
        layerId: id,
        label,
        state: UNSWAPPED_STATE,
        draw: true,
        chip: failedLayers.has(id) ? LIVE_CHIP_UNAVAILABLE : LIVE_CHIP,
        age: null,
        lastOkAt: null,
        staleSince: null,
        greyUntil: null,
        reason: null,
      });
    }
    return out;
  }

  /** Recompute; tell the control only when the list changed. */
  function refresh({ base = true } = {}) {
    if (base) feedChips?.refresh?.();
    const list = states();
    const sig = JSON.stringify(
      list.map((c) => [c.feed, c.state, c.chip, c.age, c.label]),
    );
    if (sig !== lastSig) {
      lastSig = sig;
      for (const fn of [...listeners]) {
        try {
          fn(list);
        } catch {
          /* keep going */
        }
      }
    }
    return list;
  }

  return {
    install() {
      feedChips?.install?.();
      offBase = feedChips?.subscribe?.(() => refresh({ base: false })) ?? null;
      attach();
    },
    observe: (...args) => feedChips?.observe?.(...args),
    /** Hook the router / data manager once they exist (shell order). */
    connect() {
      attach();
      return refresh({ base: false });
    },
    states,
    refresh,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      offBase?.();
      offManager?.();
      offRouter?.();
      offBase = offManager = offRouter = null;
      listeners.clear();
      feedChips?.destroy?.();
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
