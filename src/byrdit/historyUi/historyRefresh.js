/**
 * Refresh driver of the history layer swap (card B12a, umbrella D1/D4/D6).
 *
 * The router (historyRouter.js) answers a layer's request from history, but
 * a layer only asks on its own interval. This driver makes the globe follow
 * the history time:
 *
 *   released time change (seek release, step, ht load, entering history)
 *     -> shell._dataManager.refreshLayer(id) once for every ENABLED layer
 *        whose feed is swapped
 *   playback -> one refresh when the feed's frame (its recorded snapshot at
 *        or before t, or t floored to a quantum) changes, never overlapping
 *        (D1), paced to the router's slice budget (the history API allows a
 *        client 60 requests a minute); plus the prefetch of the next 2
 *        frames playback will show (D6)
 *   LIVE -> every still-enabled layer that was swapped or was served a
 *        history answer by any path (a driver refresh, its own enable or
 *        interval poll) is reset and refreshed once (D4), so live data
 *        comes back straight away
 *
 * Frames (owner decision on t_884fea7d, option A: the upstream layer seams
 * resetForHistoryFrame / setMotionClock in src/layers/flights, military and
 * vessels). Before a layer reads an answer the router gives it
 * (router.onServe):
 *   history answer -> layer.resetForHistoryFrame(): the answer is applied as
 *        one frame (absent records leave at once, selected / tracked ones
 *        included, no position history of another time), and
 *        layer.setMotionClock(): dead reckoning runs on the history time,
 *        frozen at t while paused and rate x wall time while playing:
 *        clock(frameAppliedAtMs) = frameAppliedAtMs + (tau - frameT), tau
 *        the history time now and frameT the slice time of that answer. The
 *        router rebases fix times by the serve time - frameT (D2), and the
 *        layer stamps frameAppliedAtMs when it applies the frame, so the
 *        layer's "now - fix time" is "tau - recorded fix time".
 *   live pass-through after history answers (failure, D3) -> one more
 *        reset and the wall clock, so live data never merges into a frame
 *   LIVE -> reset + wall clock for every layer that had a history frame
 *
 * During a scrub drag nothing is refreshed (the B11 control makes no
 * request while dragging either); the release refreshes once, debounced.
 *
 * Camera (B12b, D7): a view-dependent feed (FIRMS asks its slice with the
 * camera bbox) is refreshed once, debounced, after a camera move that
 * changes its slice box, so the area on screen is answered from history
 * instead of waiting for the layer's own 10-minute poll.
 */
export const RELEASE_DEBOUNCE_MS = 300;
export const PLAY_POLL_MS = 250;
export const PLAY_MIN_REFRESH_MS = 2_000;
export const PREFETCH_FRAMES = 2;
export const SNAPS_N = 30;
const UPCOMING_HORIZON_MS = 6 * 3_600_000;
/** Do not ask /snapshots for one feed more often than this. */
export const SNAPS_MIN_INTERVAL_MS = 2_000;

export function createRefreshDriver({
  router,
  getDataManager = () => null,
  client = null,
  timers = globalThis,
  monotonic = () => globalThis.performance?.now?.() ?? Date.now(),
  now = () => Date.now(),
  releaseDebounceMs = RELEASE_DEBOUNCE_MS,
  playPollMs = PLAY_POLL_MS,
  playMinRefreshMs = PLAY_MIN_REFRESH_MS,
} = {}) {
  const adapters = router.adapters;
  const jobs = new Map(); // adapter id -> {running, pending}
  const lastFrame = new Map(); // adapter id -> frame time refreshed
  const planned = new Map(); // adapter id -> prefetched upcoming frames
  const lastRefreshAt = new Map(); // adapter id -> monotonic ms
  const snapAsk = new Map(); // snap feed -> {at, pending}
  const calls = []; // refreshLayer log (tests / QA): {layerId, at}
  let releaseTimer = null;
  let viewTimer = null;
  let playTimer = null;
  let dragging = false;
  let destroyed = false;
  let wasSwapped = new Set(); // adapter ids swapped while history was on
  let state = { active: false, timeMs: null, playing: false, rate: 1 };
  let stateAt = 0; // wall ms the control state was received
  const frameT = new Map(); // adapter id -> slice time of its last answer
  const lastMode = new Map(); // adapter id -> 'history' | 'live'
  const clocks = new Map(); // adapter id -> motion clock function

  const dm = () => {
    try {
      return getDataManager() ?? null;
    } catch {
      return null;
    }
  };

  function enabledIds() {
    try {
      const ids = dm()?.getEnabledLayerIds?.();
      return ids instanceof Set ? ids : new Set(ids ?? []);
    } catch {
      return new Set();
    }
  }

  /** The layer object of an adapter (data-manager registry), or null. */
  function layerOf(adapter) {
    try {
      return dm()?.layers?.get?.(adapter.layerId)?.module ?? null;
    } catch {
      return null;
    }
  }

  /** The history time now: frozen while paused, rate x wall while playing. */
  function historyNow() {
    if (!state.active || !Number.isFinite(state.timeMs)) return NaN;
    const run = state.playing ? state.rate * Math.max(0, now() - stateAt) : 0;
    return Math.min(state.timeMs + run, now());
  }

  function clockOf(adapter) {
    let clock = clocks.get(adapter.id);
    if (!clock) {
      clock = (appliedAtMs) => {
        const t = frameT.get(adapter.id);
        const tau = historyNow();
        if (!(appliedAtMs > 0) || !Number.isFinite(t) || !Number.isFinite(tau))
          return NaN; // the layer falls back to the wall clock
        return appliedAtMs + (tau - t);
      };
      clocks.set(adapter.id, clock);
    }
    return clock;
  }

  function resetLayer(adapter, clock) {
    const layer = layerOf(adapter);
    try {
      layer?.resetForHistoryFrame?.();
      layer?.setMotionClock?.(clock);
    } catch {
      /* a layer without the seam keeps its own behaviour */
    }
  }

  /** router.onServe: arm the frame before the layer reads the answer. */
  function onServe(event = {}) {
    if (destroyed) return;
    const adapter = adapters.find((a) => a.id === event.adapterId);
    if (!adapter) return;
    if (event.mode === 'history') {
      frameT.set(adapter.id, event.t);
      lastMode.set(adapter.id, 'history');
      // D4: every layer actually served history (a driver refresh, or its
      // own enable / interval poll) is refreshed once on LIVE
      wasSwapped.add(adapter.id);
      resetLayer(adapter, clockOf(adapter));
    } else if (lastMode.get(adapter.id) === 'history') {
      lastMode.set(adapter.id, 'live');
      resetLayer(adapter, null);
    }
  }
  const offServe = router.onServe?.(onServe) ?? null;

  /** Enabled layers whose feed is answered from history now. */
  function targets() {
    const enabled = enabledIds();
    return adapters.filter(
      (a) => enabled.has(a.layerId) && router.isSwapped(a.id),
    );
  }

  /**
   * Refresh one layer `polls` times; a call while it runs only raises the
   * pending count (no overlapping refresh of one layer).
   */
  function refresh(adapter, polls = 1) {
    let job = jobs.get(adapter.id);
    if (!job) {
      job = { running: null, pending: 0 };
      jobs.set(adapter.id, job);
    }
    if (job.running) {
      job.pending = Math.max(job.pending, polls);
      return job.running;
    }
    job.pending = polls;
    job.running = (async () => {
      while (job.pending > 0 && !destroyed) {
        const n = job.pending;
        job.pending = 0;
        for (let i = 0; i < n && !destroyed; i++) {
          const manager = dm();
          if (!manager?.refreshLayer) return;
          calls.push({ layerId: adapter.layerId, at: monotonic() });
          lastRefreshAt.set(adapter.id, monotonic());
          try {
            await manager.refreshLayer(adapter.layerId);
          } catch {
            /* the layer reports its own error */
          }
        }
      }
    })().finally(() => {
      job.running = null;
    });
    return job.running;
  }

  function refreshTargets() {
    const list = targets();
    for (const a of list) wasSwapped.add(a.id);
    return Promise.all(
      list.map((a) => {
        lastFrame.set(a.id, router.frameTime(a));
        return refresh(a, 1);
      }),
    );
  }

  function scheduleRelease() {
    if (releaseTimer) timers.clearTimeout(releaseTimer);
    releaseTimer = timers.setTimeout(() => {
      releaseTimer = null;
      if (destroyed || dragging || !state.active) return;
      refreshTargets();
    }, releaseDebounceMs);
  }

  /** The camera stopped moving (shell: viewer.camera.moveEnd). */
  function viewChanged() {
    if (destroyed || !state.active) return;
    if (viewTimer) timers.clearTimeout(viewTimer);
    viewTimer = timers.setTimeout(() => {
      viewTimer = null;
      if (destroyed || dragging || !state.active) return;
      for (const a of targets())
        if (a.viewDependent && router.viewMoved?.(a.id)) {
          wasSwapped.add(a.id);
          refresh(a, 1);
        }
    }, releaseDebounceMs);
  }

  // ── playback ────────────────────────────────────────────

  async function askSnaps(adapter, t) {
    const feed = adapter.snapFeed;
    if (!feed || !client?.snapshots) return;
    if (router.snapsAfter(feed, t).length > PREFETCH_FRAMES) return;
    const ask = snapAsk.get(feed) ?? { at: -Infinity, pending: false };
    if (ask.pending || monotonic() - ask.at < SNAPS_MIN_INTERVAL_MS) return;
    ask.pending = true;
    ask.at = monotonic();
    snapAsk.set(feed, ask);
    try {
      const list = await client.snapshots({ feed, around: t, n: SNAPS_N });
      router.setSnaps(feed, list);
    } catch {
      // history unavailable (the control shows it) or aborted: the frames
      // fall back to the quantum until a later ask succeeds
    } finally {
      ask.pending = false;
    }
  }

  /**
   * Wall ms between two frames of one layer: at least playMinRefreshMs and
   * slow enough that all swapped layers together stay inside the router's
   * slice budget (one slice per shown frame per layer; the API allows a
   * client 60 history requests a minute).
   */
  function frameInterval(layers) {
    // frames spend the budget minus the prefetch reserve: a planned frame
    // that playback overtakes costs one more request now and then
    const budget = router.frameBudgetPerMin ?? router.budgetPerMin ?? Infinity;
    return Math.max(playMinRefreshMs, (60_000 * Math.max(1, layers)) / budget);
  }

  /**
   * D6: the next PREFETCH_FRAMES frames playback will SHOW for an adapter,
   * the frames at t + k * interval * rate (k = 1, 2). While snapshots are
   * further apart than that pace these are simply the next snapshots; when
   * playback outruns them (60x, 600x) they are the snapshots that will be
   * asked, not the skipped ones in between.
   */
  function upcomingFrames(adapter, t, frame, interval) {
    const step = interval * state.rate;
    const out = [];
    if (!(step > 0)) return out;
    // the wall ticks between are slower than snapshots at 1x: walk until
    // two later frames are found (bounded: 6 h of history ahead)
    for (let k = 1; out.length < PREFETCH_FRAMES; k++) {
      const at = t + k * step;
      if (at > now() || at - t > UPCOMING_HORIZON_MS) break;
      const f = router.frameTime(adapter, at);
      if (Number.isFinite(f) && f > frame && !out.includes(f)) out.push(f);
    }
    return out;
  }

  function tick() {
    if (destroyed || !state.active || !state.playing || dragging) return;
    const t = state.timeMs;
    const list = targets();
    const interval = frameInterval(list.length);
    for (const a of list) {
      wasSwapped.add(a.id);
      askSnaps(a, t);
      // show the newest PREFETCHED frame that is due (at or before t) so
      // the request is a cache hit; else the recorded frame of t
      const prev = lastFrame.get(a.id) ?? -Infinity;
      const due = (planned.get(a.id) ?? []).filter((f) => f <= t && f > prev);
      const frame = due.length ? due[due.length - 1] : router.frameTime(a, t);
      const job = jobs.get(a.id);
      if (
        frame > prev &&
        !job?.running &&
        monotonic() - (lastRefreshAt.get(a.id) ?? -Infinity) >= interval
      ) {
        lastFrame.set(a.id, frame);
        router.pinFrame(a.id, frame);
        refresh(a, 1);
        // keep frames already planned (and maybe fetched) that are still
        // ahead, then the newly predicted ones
        const next = [
          ...new Set([
            ...(planned.get(a.id) ?? []).filter((f) => f > frame),
            ...upcomingFrames(a, t, frame, interval),
          ]),
        ]
          .sort((x, y) => x - y)
          .slice(0, PREFETCH_FRAMES);
        planned.set(a.id, next);
        router.prefetch(a.id, next);
      }
    }
  }

  function startPlay() {
    if (playTimer) return;
    playTimer = timers.setInterval(tick, playPollMs);
  }

  function stopPlay() {
    if (playTimer) timers.clearInterval(playTimer);
    playTimer = null;
  }

  // ── inputs ──────────────────────────────────────────────

  /** The control state (handle.subscribe detail / getState()). */
  function onHistory(detail = {}) {
    if (destroyed) return;
    const change = router.setHistory(detail);
    stateAt = now();
    state = {
      active: Boolean(detail.active) && Number.isFinite(detail.timeMs),
      timeMs: detail.timeMs ?? null,
      playing: Boolean(detail.active && detail.playing),
      rate: Number(detail.rate) > 0 ? Number(detail.rate) : 1,
    };
    if (change.left) {
      stopPlay();
      if (releaseTimer) timers.clearTimeout(releaseTimer);
      releaseTimer = null;
      if (viewTimer) timers.clearTimeout(viewTimer);
      viewTimer = null;
      lastFrame.clear();
      planned.clear();
      const enabled = enabledIds();
      const back = adapters.filter(
        (a) => wasSwapped.has(a.id) && enabled.has(a.layerId),
      );
      wasSwapped = new Set();
      // D4: no history frame survives LIVE, dead reckoning is back on the
      // wall clock, and the router passes through: ask live once at once
      for (const a of adapters)
        if (lastMode.has(a.id) || back.includes(a)) resetLayer(a, null);
      lastMode.clear();
      frameT.clear();
      for (const a of back) refresh(a, 1);
      return;
    }
    if (!state.active) return;
    if (state.playing) startPlay();
    else stopPlay();
    if (change.seeked || change.entered || !state.playing) {
      planned.clear();
      if (change.seeked || change.entered) lastFrame.clear();
    }
    if (change.entered || change.seeked || (change.moved && !state.playing))
      scheduleRelease();
  }

  /** The scrub is being dragged (no refresh until it is released). */
  function setDragging(on) {
    const was = dragging;
    dragging = Boolean(on);
    if (was && !dragging && state.active) scheduleRelease();
    if (dragging && releaseTimer) {
      timers.clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  }

  return {
    onHistory,
    setDragging,
    viewChanged,
    tick,
    refreshTargets,
    targets,
    calls,
    /** Wait for running refreshes (tests / QA). */
    async settle() {
      for (;;) {
        const running = [...jobs.values()]
          .map((j) => j.running)
          .filter(Boolean);
        if (!running.length) return;
        await Promise.all(running);
      }
    },
    historyNow,
    destroy() {
      destroyed = true;
      offServe?.();
      for (const a of adapters) if (lastMode.has(a.id)) resetLayer(a, null);
      lastMode.clear();
      stopPlay();
      if (releaseTimer) timers.clearTimeout(releaseTimer);
      releaseTimer = null;
      if (viewTimer) timers.clearTimeout(viewTimer);
      viewTimer = null;
    },
  };
}
