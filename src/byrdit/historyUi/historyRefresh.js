/**
 * Refresh driver of the history layer swap (card B12a, umbrella D1/D4/D6).
 *
 * The router (historyRouter.js) answers a layer's request from history, but
 * a layer only asks on its own interval. This driver makes the globe follow
 * the history time:
 *
 *   released time change (seek release, step, ht load, entering history)
 *     -> shell._dataManager.refreshLayer(id) for every ENABLED layer whose
 *        feed is swapped, `settlePolls` times in a row (the slice is cached,
 *        so the extra polls cost no request): flights / military keep an
 *        absent aircraft for MISSING_POLL_LIMIT = 3 polls as STALE, and a
 *        jump to another time must not leave aircraft of the old time (D3)
 *   playback -> one refresh when the feed's frame (its recorded snapshot at
 *        or before t, or t floored to a quantum) changes, never overlapping
 *        (D1), paced to the router's slice budget (the history API allows a
 *        client 60 requests a minute); plus the prefetch of the next 2
 *        frames playback will show (D6)
 *   LIVE -> every layer that was swapped is refreshed again (D4), so live
 *        data comes back straight away (settlePolls: the history aircraft
 *        leave at once instead of lingering as STALE)
 *
 * During a scrub drag nothing is refreshed (the B11 control makes no
 * request while dragging either); the release refreshes once, debounced.
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
  let playTimer = null;
  let dragging = false;
  let destroyed = false;
  let wasSwapped = new Set(); // adapter ids swapped while history was on
  let state = { active: false, timeMs: null, playing: false, rate: 1 };

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

  function refreshTargets({ settle = true } = {}) {
    const list = targets();
    for (const a of list) wasSwapped.add(a.id);
    return Promise.all(
      list.map((a) => {
        lastFrame.set(a.id, router.frameTime(a));
        return refresh(a, settle ? a.settlePolls : 1);
      }),
    );
  }

  function scheduleRelease() {
    if (releaseTimer) timers.clearTimeout(releaseTimer);
    releaseTimer = timers.setTimeout(() => {
      releaseTimer = null;
      if (destroyed || dragging || !state.active) return;
      refreshTargets({ settle: true });
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
      lastFrame.clear();
      planned.clear();
      const enabled = enabledIds();
      const back = adapters.filter(
        (a) => wasSwapped.has(a.id) && enabled.has(a.layerId),
      );
      wasSwapped = new Set();
      // D4: the router passes through now; ask live again at once
      for (const a of back) refresh(a, a.settlePolls);
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
    destroy() {
      destroyed = true;
      stopPlay();
      if (releaseTimer) timers.clearTimeout(releaseTimer);
      releaseTimer = null;
    },
  };
}
