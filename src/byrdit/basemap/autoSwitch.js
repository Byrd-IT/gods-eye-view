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

/** Transient user activation: a click/tap/key within the last few seconds. */
export function userGestureActive(nav = globalThis.navigator) {
  return nav?.userActivation?.isActive === true;
}

function hasPrivateOptions(options) {
  return (
    options != null &&
    typeof options === 'object' &&
    Object.getOwnPropertySymbols(options).length > 0
  );
}

/**
 * Wire the switch to a MapSourceController (decorates THIS instance only).
 *
 * setStack routing (chips, share links, scenes):
 *   'basemap-auto'           -> auto mode
 *   'photoreal' / 'byrdit-open' from a user gesture -> pin Google / Open
 *   'photoreal' / 'byrdit-open' without a gesture (share-link restore, whose
 *     parser defaults to 'photoreal') -> stays in auto, re-evaluates
 *   anything else            -> passed through, auto off ('other')
 *   controller-internal calls (fallbacks carry a private symbol option)
 *                            -> passed through untouched
 *
 * @returns {() => void} detach
 */
export function attachBasemapSwitching({
  controller,
  viewer,
  session,
  machine,
  heightOf = () => cameraHeight(viewer),
  isUserGesture = () => userGestureActive(),
  notify = () => {},
  timers = globalThis,
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
  let seq = 0;
  let busy = null;
  let again = false;
  let dwellTimer = null;
  let pollTimer = null;
  let detached = false;
  const removers = [];

  const openTarget = () =>
    controller.isStackAvailable(BYRDIT_OPEN_STACK_ID)
      ? BYRDIT_OPEN_STACK_ID
      : 'esri-imagery';

  function waitUntil(test) {
    return new Promise((resolve) => {
      if (test()) return resolve(true);
      const started = Date.now();
      const id = timers.setInterval(() => {
        if (detached || test() || Date.now() - started >= revealTimeoutMs) {
          timers.clearInterval(id);
          resolve(test());
        }
      }, 100);
    });
  }

  async function enterGoogle(my) {
    let tileset;
    try {
      tileset = await session.ensure();
    } catch (error) {
      if (my !== seq || detached) return controller.getState();
      machine.commit('OPEN');
      notify(
        `${error?.message || 'Google 3D unavailable'}; showing Byrd-IT Open`,
      );
      if (controller.getActiveId() === GOOGLE_STACK_ID)
        return original(openTarget());
      return controller.getState();
    }
    if (my !== seq || detached) return controller.getState();
    // No flash: Google first, the globe goes once its tiles are in (<= 3 s).
    if (controller.getActiveId() !== GOOGLE_STACK_ID) {
      tileset.show = true;
      await waitUntil(() => tileset.tilesLoaded === true);
      if (my !== seq || detached) {
        if (controller.getActiveId() !== GOOGLE_STACK_ID) tileset.show = false;
        return controller.getState();
      }
    }
    const state = await original(GOOGLE_STACK_ID);
    if (state?.activeId === GOOGLE_STACK_ID) machine.commit('GOOGLE');
    return state;
  }

  async function leaveGoogle(my) {
    const tileset = session.tileset;
    const state = await original(openTarget());
    if (my !== seq || detached) return state;
    if (state?.activeId !== GOOGLE_STACK_ID) machine.commit('OPEN');
    // No flash: keep Google drawn until the globe has its tiles (<= 3 s).
    if (tileset && controller.getActiveId() !== GOOGLE_STACK_ID) {
      tileset.show = true;
      await waitUntil(() => viewer?.scene?.globe?.tilesLoaded === true);
      if (controller.getActiveId() !== GOOGLE_STACK_ID) tileset.show = false;
    }
    return state;
  }

  function run(action) {
    const my = ++seq;
    const job = (action === 'GOOGLE' ? enterGoogle(my) : leaveGoogle(my))
      .catch((error) => {
        notify(error?.message || String(error));
        return controller.getState();
      })
      .finally(() => {
        if (busy === job) busy = null;
        if (again && !detached) {
          again = false;
          evaluate();
        }
      });
    busy = job;
    return job;
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

  async function pin(mode) {
    machine.setMode(mode);
    seq++;
    if (busy) await busy.catch(() => {});
    return (await evaluate()) ?? controller.getState();
  }

  controller.setStack = (id, options = {}) => {
    if (detached || hasPrivateOptions(options)) return original(id, options);
    if (id === BASEMAP_AUTO_STACK.id) return pin('auto');
    if (id === GOOGLE_STACK_ID || id === BYRDIT_OPEN_STACK_ID) {
      if (!isUserGesture()) {
        if (machine.mode === 'other') machine.setMode('auto');
        return Promise.resolve(evaluate()).then(() => controller.getState());
      }
      return pin(id === GOOGLE_STACK_ID ? 'google' : 'open');
    }
    machine.setMode('other');
    seq++;
    return original(id, options);
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
