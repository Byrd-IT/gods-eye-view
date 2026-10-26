import { BASEMAP_AUTO_STACK, BYRDIT_OPEN_STACK_ID } from './stack.js';

/**
 * Google 3D by default, Byrd-IT Open as the base and backup, automatic
 * switching (BASEMAP.md 4.3, owner O4 + O5).
 *
 * createSwitchMachine is the pure hysteresis state machine:
 *   two states, OPEN and GOOGLE; ENTER Google at height <= enterM, LEAVE at
 *   height >= leaveM, at least dwellMs between automatic switches. Modes:
 *   'auto' (default), 'google' / 'open' (pinned with the Google or Open chip),
 *   'other' (the user picked Esri/OSM/Bing: auto-switch off).
 *
 * attachBasemapSwitching drives a map controller with it. It runs on the
 * camera's moveEnd plus a 1 Hz timer while the camera moves, never on every
 * frame.
 */

export const GOOGLE_STACK_ID = 'photoreal';

export function createSwitchMachine({
  enterM = 5_000,
  leaveM = 8_000,
  dwellMs = 5_000,
  auto = true,
  now = Date.now,
} = {}) {
  let state = 'OPEN';
  let mode = auto ? 'auto' : 'open';
  let lastSwitchAt = -Infinity;
  return {
    get state() {
      return state;
    },
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
    },
    /** The state the height asks for (hysteresis applied, dwell not). */
    target(heightM) {
      if (mode === 'google') return 'GOOGLE';
      if (mode === 'open') return 'OPEN';
      if (mode !== 'auto' || !Number.isFinite(heightM)) return state;
      if (state === 'OPEN' && heightM <= enterM) return 'GOOGLE';
      if (state === 'GOOGLE' && heightM >= leaveM) return 'OPEN';
      return state;
    },
    /**
     * @returns {{action: 'GOOGLE'|'OPEN'|null, retryInMs?: number}}
     */
    step(heightM) {
      const want = this.target(heightM);
      if (want === state) return { action: null };
      if (mode === 'auto') {
        const wait = lastSwitchAt + dwellMs - now();
        if (wait > 0) return { action: null, retryInMs: wait };
      }
      return { action: want };
    },
    commit(next) {
      if (next !== state) lastSwitchAt = now();
      state = next;
    },
  };
}

/** Camera height above terrain; falls back to height above the ellipsoid. */
export function cameraHeight(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return NaN;
  let ground;
  try {
    ground = viewer.scene?.globe?.getHeight?.(carto);
  } catch {
    ground = undefined;
  }
  return Number.isFinite(ground) ? carto.height - ground : carto.height;
}

/**
 * `setStack` option a caller passes to say who chose the stack:
 *   'user'    - a chip, the dropdown, voice or the API (src/ui/mapSourceControls.js
 *               passes it for every selection that also updates the share link)
 *   'restore' - a share link, a recipe or scene restore, a lease release
 * Anything without `intent: 'user'` counts as a restore. Transient browser
 * activation (navigator.userActivation) is NOT used: a restore that a click
 * started would look like a user pick.
 */
export const USER_INTENT = 'user';

function hasPrivateOptions(options) {
  return (
    options != null &&
    typeof options === 'object' &&
    Object.getOwnPropertySymbols(options).length > 0
  );
}

/**
 * Frames the no-flash wait needs after a show/hide before it trusts
 * `tilesLoaded`: a hidden tileset keeps the value of the last frame it drew,
 * and the globe's load queues describe the previous imagery layer until the
 * next frame selects tiles again.
 */
const READY_FRAMES = 2;

/**
 * Wire the switch to a MapSourceController (decorates THIS instance only).
 *
 * setStack routing (chips, share links, scenes, leases):
 *   'basemap-auto'                      -> auto mode
 *   'photoreal' / 'byrdit-open', intent 'user' -> pin Google / Open
 *     (an unavailable one is passed through: the controller reports why and
 *     the mode does not change)
 *   'photoreal' / 'byrdit-open' / unknown id, no user intent (share-link
 *     restore, whose parser defaults to 'photoreal'; recipe restore; an
 *     imagery-comparison lease release) -> leaves Esri/OSM/Bing back to the
 *     mode a restore-driven switch suspended (a lease from a pinned Google
 *     or Open comes back pinned), otherwise to auto; keeps a pin;
 *     re-evaluates. It never pins on its own.
 *   any other available stack          -> passed through, auto off ('other');
 *     the switch is tracked like a job, so a later selection waits for it
 *     and then reconciles: the latest pick wins
 *   any other unavailable stack         -> passed through, mode unchanged
 *   controller-internal calls (fallbacks carry a private symbol option)
 *                                        -> passed through untouched
 *
 * Every selection reconciles the machine with the stack the controller
 * really shows: when they disagree (back from Esri, a lease, a superseded
 * switch) the stack the mode asks for is applied at once, without dwell.
 *
 * @returns {() => void} detach
 */
export function attachBasemapSwitching({
  controller,
  viewer,
  session,
  machine,
  heightOf = () => cameraHeight(viewer),
  notify = () => {},
  timers = globalThis,
  now = Date.now,
  revealTimeoutMs = 3_000,
  pollMs = 1_000,
}) {
  const original = controller.setStack.bind(controller);
  const originalGetStacks = controller.getStacks.bind(controller);
  const ownSetStack = Object.hasOwn(controller, 'setStack')
    ? controller.setStack
    : null;
  const ownGetStacks = Object.hasOwn(controller, 'getStacks')
    ? controller.getStacks
    : null;
  /** Invalidates in-flight switch jobs. */
  let seq = 0;
  /** Invalidates older selections still waiting for a job to finish. */
  let selection = 0;
  let busy = null;
  let again = false;
  /**
   * The mode a restore-driven switch to another map (an imagery-comparison
   * lease, a recipe) suspended; a restore of Google/Open resumes it. Any
   * user pick or mode selection clears it: the newer choice wins.
   */
  let suspendedMode = null;
  let dwellTimer = null;
  let pollTimer = null;
  let detached = false;
  const removers = [];

  const openTarget = () =>
    controller.isStackAvailable(BYRDIT_OPEN_STACK_ID)
      ? BYRDIT_OPEN_STACK_ID
      : 'esri-imagery';
  const stackFor = (state) =>
    state === 'GOOGLE' ? GOOGLE_STACK_ID : openTarget();

  /** The machine follows what the controller actually shows. */
  function syncState() {
    if (detached) return;
    machine.commit(
      controller.getActiveId() === GOOGLE_STACK_ID ? 'GOOGLE' : 'OPEN',
    );
  }

  /**
   * Resolve once `test()` holds for a frame drawn AFTER this call (at least
   * READY_FRAMES postRender events), or after revealTimeoutMs, or when the
   * job is superseded. Keeps frames coming while it waits (the render
   * governor may have the scene in requestRenderMode).
   */
  function waitRendered(test, my) {
    const scene = viewer?.scene;
    return new Promise((resolve) => {
      let frames = 0;
      let done = false;
      let interval = null;
      let removeFrame = null;
      const started = now();
      const finish = () => {
        if (done) return;
        done = true;
        timers.clearInterval(interval);
        removeFrame?.();
        resolve(frames >= READY_FRAMES && test());
      };
      const check = () => {
        if (detached || my !== seq) return finish();
        if (frames >= READY_FRAMES && test()) return finish();
        if (now() - started >= revealTimeoutMs) return finish();
        scene?.requestRender?.();
      };
      removeFrame =
        scene?.postRender?.addEventListener?.(() => {
          frames += 1;
          check();
        }) ?? null;
      interval = timers.setInterval(check, 100);
      scene?.requestRender?.();
    });
  }

  async function enterGoogle(my, { reconcile = false } = {}) {
    let tileset;
    try {
      tileset = await session.ensure();
    } catch (error) {
      if (my !== seq || detached) return controller.getState();
      notify(
        `${error?.message || 'Google 3D unavailable'}; showing Byrd-IT Open`,
      );
      const active = controller.getActiveId();
      // Leaving Google, or a selection that must land on the base map (from
      // Esri/OSM/Bing): show the open stack. An automatic entry from the base
      // map (or its own tile-failure fallback) stays where it is.
      if (
        active === GOOGLE_STACK_ID ||
        (reconcile && active !== openTarget())
      ) {
        const state = await original(openTarget());
        syncState();
        return state;
      }
      syncState();
      return controller.getState();
    }
    if (my !== seq || detached) return controller.getState();
    // No flash: Google first; the base goes once Google has drawn the
    // current view (<= 3 s).
    if (controller.getActiveId() !== GOOGLE_STACK_ID) {
      tileset.show = true;
      await waitRendered(() => tileset.tilesLoaded === true, my);
      if (my !== seq || detached) {
        if (controller.getActiveId() !== GOOGLE_STACK_ID) tileset.show = false;
        return controller.getState();
      }
    }
    const state = await original(GOOGLE_STACK_ID);
    syncState();
    return state;
  }

  async function leaveGoogle(my) {
    const tileset = session.tileset;
    const wasGoogle = controller.getActiveId() === GOOGLE_STACK_ID;
    const state = await original(openTarget());
    // Commit whatever landed even when superseded: the controller has
    // switched, and the machine must not keep saying GOOGLE.
    syncState();
    if (my !== seq || detached) return state;
    // No flash: keep Google drawn until the globe has drawn the current view
    // with its new imagery (<= 3 s). Only when Google was what showed.
    if (wasGoogle && tileset && controller.getActiveId() !== GOOGLE_STACK_ID) {
      tileset.show = true;
      await waitRendered(() => viewer?.scene?.globe?.tilesLoaded === true, my);
      if (controller.getActiveId() !== GOOGLE_STACK_ID) tileset.show = false;
    }
    return state;
  }

  /**
   * Make `job` the in-flight switch: selections wait for it, and an
   * evaluation asked for meanwhile runs once it settles.
   */
  function track(job) {
    const tracked = job.finally(() => {
      if (busy === tracked) busy = null;
      if (!busy && again && !detached) {
        again = false;
        evaluate();
      }
    });
    busy = tracked;
    return tracked;
  }

  function run(action, options) {
    const my = ++seq;
    return track(
      (action === 'GOOGLE' ? enterGoogle(my, options) : leaveGoogle(my)).catch(
        (error) => {
          const message = error?.message || String(error);
          // Record it where getState().lastError reads it, so a caller of
          // setMapStack('basemap-auto') sees the failed auto switch. Only
          // while this job is still the current one: a superseded job must
          // not overwrite what a newer pick reported. (The write emits no
          // change event; the notice below is what the user sees.)
          if (my === seq && !detached) controller._lastError = message;
          notify(message);
          return controller.getState();
        },
      ),
    );
  }

  function evaluate() {
    if (detached) return null;
    if (busy) {
      again = true;
      return busy;
    }
    if (machine.mode === 'other') return null;
    const { action, retryInMs } = machine.step(heightOf());
    if (retryInMs > 0) {
      timers.clearTimeout(dwellTimer);
      dwellTimer = timers.setTimeout(evaluate, retryInMs + 10);
    }
    return action ? run(action) : null;
  }

  /** The base map counts as shown (machine OPEN) for this selection. */
  function showsOpen(active, explicit) {
    if (active === openTarget()) return true;
    // A restore keeps the controller's own tile-failure fallback to Esri; an
    // explicit pick of Open/Auto retries the open stack.
    return (
      !explicit &&
      active === 'esri-imagery' &&
      controller.getSwitchOrigin?.() === 'automatic'
    );
  }

  /**
   * Apply a mode and make the controller show what it asks for. Waits for an
   * in-flight switch first; a newer selection or pick wins.
   */
  async function select(mode, { explicit }) {
    suspendedMode = null;
    machine.setMode(mode);
    const mine = ++selection;
    seq++;
    timers.clearTimeout(dwellTimer);
    while (busy) await busy.catch(() => {});
    if (detached || mine !== selection) return controller.getState();
    // A new selection starts clean: an error from an earlier background
    // switch must not be reported as this selection's.
    controller._lastError = null;
    const active = controller.getActiveId();
    const inStep =
      active === GOOGLE_STACK_ID
        ? machine.state === 'GOOGLE'
        : machine.state === 'OPEN' && showsOpen(active, explicit);
    if (inStep && !(explicit && mode !== 'auto')) {
      // The controller shows what the machine thinks: the normal rules
      // (hysteresis, dwell) decide.
      return (await evaluate()) ?? controller.getState();
    }
    // Out of step (back from another map, a lease, a superseded switch) or a
    // pin: apply the wanted state now, without dwell.
    const want = machine.target(heightOf());
    if (
      want === 'GOOGLE'
        ? active === GOOGLE_STACK_ID
        : showsOpen(active, explicit)
    ) {
      machine.commit(want);
      return controller.getState();
    }
    return run(want, { reconcile: true });
  }

  controller.setStack = (id, options = {}) => {
    if (detached || hasPrivateOptions(options)) return original(id, options);
    const explicit = options?.intent === USER_INTENT;
    if (id === BASEMAP_AUTO_STACK.id) return select('auto', { explicit });
    const known = controller.getStack ? Boolean(controller.getStack(id)) : true;
    if ((id === GOOGLE_STACK_ID || id === BYRDIT_OPEN_STACK_ID) && explicit) {
      // Validate before touching the mode: the controller reports why.
      if (!controller.isStackAvailable(id)) return original(id, options);
      return select(id === GOOGLE_STACK_ID ? 'google' : 'open', {
        explicit,
      });
    }
    if (id === GOOGLE_STACK_ID || id === BYRDIT_OPEN_STACK_ID || !known) {
      // A restore (or an unknown id, which the controller would map to
      // Google): no pin, no root at global view; leaves another map.
      const resume =
        machine.mode === 'other' ? (suspendedMode ?? 'auto') : machine.mode;
      return select(resume, { explicit: false });
    }
    // Unavailable: the controller reports it and nothing switches, so the
    // auto switch stays on.
    if (!controller.isStackAvailable(id)) return original(id, options);
    // A user pick of another map is the newest choice; a restore-driven one
    // (a lease, a recipe) suspends the current mode until a restore of
    // Google/Open resumes it.
    if (explicit) suspendedMode = null;
    else if (machine.mode !== 'other') suspendedMode = machine.mode;
    machine.setMode('other');
    const mine = ++selection;
    seq++;
    timers.clearTimeout(dwellTimer);
    // Issued now (synchronously: a lease reads the switch generation right
    // after this call) and tracked: a selection made while it is pending
    // waits for it, then reconciles with what it showed. Otherwise a slow
    // provider could land after a newer pick and win.
    let pending;
    try {
      pending = Promise.resolve(original(id, options));
    } catch (error) {
      pending = Promise.reject(error);
    }
    // A switch job this pick superseded may have committed the stack it left;
    // once the pick settles the machine follows what is actually shown.
    return track(
      pending.then((state) => {
        if (mine === selection) syncState();
        return state;
      }),
    );
  };

  controller.getStacks = () => [
    ...originalGetStacks(),
    { ...BASEMAP_AUTO_STACK, available: true, unavailableReason: null },
  ];

  const camera = viewer?.camera;
  if (camera?.moveEnd?.addEventListener) {
    removers.push(
      camera.moveStart.addEventListener(() => {
        if (pollTimer === null)
          pollTimer = timers.setInterval(evaluate, pollMs);
      }),
      camera.moveEnd.addEventListener(() => {
        timers.clearInterval(pollTimer);
        pollTimer = null;
        evaluate();
      }),
    );
  }
  // A share link that opens close in enters Google here (1 root); a global
  // view stays OPEN (0 roots).
  evaluate();

  const detach = () => {
    if (detached) return;
    detached = true;
    seq++;
    selection++;
    timers.clearTimeout(dwellTimer);
    timers.clearInterval(pollTimer);
    for (const remove of removers) remove?.();
    if (ownSetStack) controller.setStack = ownSetStack;
    else delete controller.setStack;
    if (ownGetStacks) controller.getStacks = ownGetStacks;
    else delete controller.getStacks;
  };
  detach.evaluate = evaluate;
  return detach;
}
