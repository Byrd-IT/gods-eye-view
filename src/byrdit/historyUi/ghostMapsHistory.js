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
 *   same time again           ->  nothing. The History control repeats its
 *        state every 2 s. Re-applying that time restarts the debounce and
 *        bumps the layer sequence, so a slow archive answer never lands.
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
/** After an unavailable answer, the archive (and the live catalog fallback)
 * is asked again at most this often by the History heartbeat. */
export const GHOSTMAPS_UNAVAILABLE_RETRY_MS = 30_000;

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
  unavailableRetryMs = GHOSTMAPS_UNAVAILABLE_RETRY_MS,
} = {}) {
  let state = { active: false, timeMs: null, playing: false, rate: 1 };
  let stateAt = 0;
  let timer = null;
  let lastApplied = -Infinity;
  /** The history time last passed to setHistoryTime, or NaN if none. */
  let lastRequested = NaN;
  /** A setHistoryTime call has not settled. A resend must not bump its seq. */
  let inFlight = false;
  let flightGen = 0;
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

  /**
   * The history time now: a paused time is sent as the control gave it (no
   * now() cap, so a future paused time is stable across the 2 s heartbeat);
   * while playing it is rate x wall, capped at the present.
   */
  function historyNow() {
    if (!state.active || !Number.isFinite(state.timeMs)) return NaN;
    if (!state.playing) return state.timeMs;
    const run = state.rate * Math.max(0, now() - stateAt);
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

  function appliedStatus() {
    try {
      return layerObject()?.getHistoryState?.()?.status ?? null;
    } catch {
      return null;
    }
  }

  function apply() {
    timer = null;
    if (destroyed || !state.active) return;
    const layer = attach();
    const t = historyNow();
    if (!layer?.setHistoryTime || !Number.isFinite(t)) return;
    lastRequested = t;
    lastApplied = now();
    let pending;
    try {
      pending = layer.setHistoryTime(t);
    } catch {
      return;
    }
    inFlight = true;
    const mine = ++flightGen;
    Promise.resolve(pending)
      .catch(() => {})
      .finally(() => {
        if (mine === flightGen) inFlight = false;
      });
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
      const wasPlaying = state.playing;
      const wasRate = state.rate;
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
          lastRequested = NaN;
          flightGen += 1;
          inFlight = false;
          Promise.resolve(layer?.setHistoryTime?.(null)).catch(() => {});
          notify();
        }
        return;
      }
      const t = historyNow();
      const sameMode = state.playing === wasPlaying && state.rate === wasRate;
      // Heartbeat (and any other identical resend): do not restart the
      // debounce or call setHistoryTime again. Retry only after a settled
      // unavailable answer, so a slow archive call can still land, and then
      // at most once per unavailableRetryMs.
      const unavailable = !inFlight && appliedStatus() === 'unavailable';
      if (
        was &&
        t === lastRequested &&
        sameMode &&
        (inFlight || !unavailable || now() - lastApplied < unavailableRetryMs)
      ) {
        return;
      }
      // Playing on while the archive is down: the time moves by itself, so
      // "same time" never matches. A jump (seek) still goes through at once.
      // The expected time is capped at the present (playing runs into it and
      // stops there), and the tolerance is a fixed wall-clock slack: it does
      // not grow with the rate, so a short seek at 60x is not swallowed.
      if (
        was &&
        unavailable &&
        sameMode &&
        state.playing &&
        now() - lastApplied < unavailableRetryMs
      ) {
        const expected = Math.min(
          lastRequested + state.rate * (now() - lastApplied),
          now(),
        );
        if (Math.abs(t - expected) < playMinIntervalMs * 2) return;
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
