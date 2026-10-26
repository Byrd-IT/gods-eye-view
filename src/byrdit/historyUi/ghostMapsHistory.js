/**
 * GhostMaps in History playback (card G1; owner decision 2026-10-26: show the
 * version S2 had published at the slider time).
 *
 * GhostMaps is not a recorded feed: there is no /api/history slice for it.
 * The server keeps a git mirror of the S2 repository (the ghostmaps-archive
 * timer) and answers /api/ghostmaps/at?t= from it (server/providers/
 * ghostMapsArchive.js). This driver only tells the GhostMaps layer the
 * history time, and tells the chip strip what the layer shows:
 *
 *   history on, time changes  ->  layer.setHistoryTime(t)   (debounced after
 *        a seek / drag release; throttled while playing, since a commit
 *        lands every few hours or days)
 *   LIVE                      ->  layer.setHistoryTime(null)  at once
 *   layer enabled in history  ->  the data manager event re-sends the time
 *
 * It uses no /api/history request, so it spends none of the history budget
 * (historyRouter SLICE_BUDGET_PER_MIN). A failure is the layer's: it shows
 * live and reports status 'unavailable' (the LIVE (history unavailable) chip,
 * D3), never a silent mix.
 */

/** The GhostMaps layer id (src/layers/ghostMaps/index.js). */
export const GHOSTMAPS_HISTORY_LAYER_ID = 's2-ghostmaps';
export const GHOSTMAPS_RELEASE_DEBOUNCE_MS = 300;
export const GHOSTMAPS_PLAY_MIN_INTERVAL_MS = 2_000;

/** Chip text (constants: no lowercase literal in a textContent=). */
export const GHOSTMAPS_PUBLISHED_PREFIX = 'As published ';
export const GHOSTMAPS_NOTHING_YET = 'Nothing published yet';

const stamp = (ms) =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;

/**
 * The chip a GhostMaps history state gets: {state: 'published'|'before',
 * text}, or null (no history state / unavailable: the LIVE chip says it).
 */
export function ghostMapsHistoryChip(history) {
  if (history?.status === 'published' && history.committedAt)
    return {
      state: 'published',
      text: `${GHOSTMAPS_PUBLISHED_PREFIX}${stamp(history.committedAt)}${
        history.commit ? ` (GitHub ${history.commit.slice(0, 7)})` : ''
      }`,
    };
  if (history?.status === 'before')
    return {
      state: 'before',
      text: history.firstCommittedAt
        ? `${GHOSTMAPS_NOTHING_YET} (archive starts ${stamp(history.firstCommittedAt)})`
        : GHOSTMAPS_NOTHING_YET,
    };
  return null;
}

export function createGhostMapsHistory({
  getDataManager = () => null,
  layerId = GHOSTMAPS_HISTORY_LAYER_ID,
  timers = globalThis,
  now = () => Date.now(),
  releaseDebounceMs = GHOSTMAPS_RELEASE_DEBOUNCE_MS,
  playMinIntervalMs = GHOSTMAPS_PLAY_MIN_INTERVAL_MS,
} = {}) {
  let state = { active: false, timeMs: null, playing: false, rate: 1 };
  let stateAt = 0;
  let timer = null;
  let lastApplied = -Infinity;
  let destroyed = false;
  let manager = null;
  let offManager = null;
  const hooked = new WeakSet();
  const listeners = new Set();

  const dm = () => {
    try {
      return getDataManager() ?? null;
    } catch {
      return null;
    }
  };

  function layerObject() {
    try {
      return dm()?.layers?.get?.(layerId)?.module ?? null;
    } catch {
      return null;
    }
  }

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* keep going */
      }
    }
  }

  /** The history time now: frozen while paused, rate x wall while playing. */
  function historyNow() {
    if (!state.active || !Number.isFinite(state.timeMs)) return NaN;
    const run = state.playing ? state.rate * Math.max(0, now() - stateAt) : 0;
    return Math.min(state.timeMs + run, now());
  }

  function attach() {
    const layer = layerObject();
    if (layer && !hooked.has(layer) && layer.setHistoryListener) {
      hooked.add(layer);
      layer.setHistoryListener(notify);
    }
    const dataManager = dm();
    if (
      dataManager &&
      dataManager !== manager &&
      typeof dataManager.subscribe === 'function'
    ) {
      offManager?.();
      manager = dataManager;
      // Only this layer turning on while history is already running. A refresh
      // of any layer (refresh-transition, and the rest) must not fetch again
      // or drop the playback throttle.
      offManager = dataManager.subscribe((change) => {
        if (
          !state.active ||
          change?.type !== 'visibility' ||
          change.layerId !== layerId ||
          !change.enabled
        )
          return;
        schedule(state.playing);
      });
    }
    return layer;
  }

  function apply() {
    timer = null;
    if (destroyed || !state.active) return;
    const layer = attach();
    const t = historyNow();
    if (!layer?.setHistoryTime || !Number.isFinite(t)) return;
    lastApplied = now();
    Promise.resolve(layer.setHistoryTime(t)).catch(() => {});
  }

  function schedule(playing) {
    if (destroyed) return;
    if (playing) {
      // throttle: keep a pending call, which reads the time when it fires
      if (timer) return;
      timers.clearTimeout(timer);
      timer = timers.setTimeout(
        apply,
        Math.max(0, lastApplied + playMinIntervalMs - now()),
      );
      return;
    }
    timers.clearTimeout(timer);
    timer = timers.setTimeout(apply, releaseDebounceMs);
  }

  return {
    /** The History control's state ('gev:history-time' detail). */
    onHistory(detail = {}) {
      if (destroyed) return;
      const was = state.active;
      stateAt = now();
      state = {
        active: Boolean(detail.active) && Number.isFinite(detail.timeMs),
        timeMs: detail.timeMs ?? null,
        playing: Boolean(detail.active && detail.playing),
        rate: Number(detail.rate) > 0 ? Number(detail.rate) : 1,
      };
      if (!state.active) {
        timers.clearTimeout(timer);
        timer = null;
        if (was) {
          const layer = attach();
          lastApplied = -Infinity;
          Promise.resolve(layer?.setHistoryTime?.(null)).catch(() => {});
          notify();
        }
        return;
      }
      schedule(state.playing && was);
    },

    /** What the chip strip needs: [{layerId, state, text}] for the layer. */
    historyLayers() {
      if (!state.active) return [];
      const layer = layerObject();
      const history = layer?.getHistoryState?.() ?? null;
      const chip = ghostMapsHistoryChip(history);
      return [
        {
          layerId,
          status: history?.status ?? 'pending',
          ...(chip ?? {}),
        },
      ];
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Run the pending call now (tests / QA). */
    flush() {
      if (timer) {
        timers.clearTimeout(timer);
        apply();
      }
    },

    destroy() {
      destroyed = true;
      timers.clearTimeout(timer);
      timer = null;
      offManager?.();
      offManager = null;
      const layer = layerObject();
      layer?.setHistoryListener?.(null);
      listeners.clear();
    },
  };
}
