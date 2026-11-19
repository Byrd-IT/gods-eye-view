/**
 * On-screen map navigation control (Google Earth style): a compass ring that
 * shows and drags the heading, a north-up button, a tilt slider with up/down
 * and top-down buttons, zoom in/out with press-and-hold repeat, and a small
 * look-around pad.
 *
 * The control orbits the camera around the point under the middle of the
 * screen. It reuses the orbit-frame helpers of the existing tilt/north buttons
 * (`readCameraTargetFrame`/`setCameraTargetFrame`), so the target is the picked
 * tile or terrain point and falls back to the ellipsoid. Every action goes
 * through the shell's navigation policy (`runNavigation`), which refuses while
 * the cockpit owns the camera and releases follow/orbit motion first.
 */
import * as Cesium from 'cesium';
import {
  readCameraTargetFrame,
  setCameraTargetFrame,
} from '../../ui/cameraOrientationControls.js';
import {
  TILT_SPAN_DEG,
  clampPitch,
  easeInOut,
  headingDegrees,
  headingFromDrag,
  liftPitchForClearance,
  normalizeHeading,
  planAction,
  planLook,
  pitchToTiltDeg,
  pointerAngle,
  shortestTurn,
  tiltDegToPitch,
  TOP_DOWN_PITCH,
  ZOOM_FRACTION,
} from './navMath.js';
import { cesiumViewerFor } from '../cesiumViewer.js';

const DEG = Math.PI / 180;

/**
 * The voice surface of the navigation control.
 *
 * One thin adapter over the mounted widget. It adds no state of its own and
 * never throws: an unusable request answers {ok:false, error} so the model
 * can say why. Errors never repeat the text the caller sent.
 *
 *   tilt       set the tilt, 0 (straight down) to 79 (near the horizon)
 *   heading    set the heading, 0 to 359 degrees from north
 *   zoom       zoom in or out, one or more steps
 *   top_down   straight down over the target
 *   north      north up
 *   look       look left, right, up or down from where the camera is
 *   status     read-only state, including the camera readback
 *
 * The numbers are the widget's own scales (the tilt slider runs 0..79 and
 * the compass ring shows 0..359), so voice and pointer agree. The maths and
 * the camera moves are the widget's: this only validates the arguments and
 * reads the camera back afterwards.
 */
export const NAV_VOICE_ACTIONS = Object.freeze([
  'tilt',
  'heading',
  'zoom',
  'top_down',
  'north',
  'look',
  'status',
]);

/** Smallest and largest tilt the widget slider accepts. */
export const NAV_TILT_MIN_DEG = 0;
/** Largest tilt the widget slider accepts: the near-horizon end of its span. */
export const NAV_TILT_MAX_DEG = TILT_SPAN_DEG;
/** Heading bounds: whole degrees from north, 0..359. */
export const NAV_HEADING_MIN_DEG = 0;
export const NAV_HEADING_MAX_DEG = 359;
/** Most steps one zoom or look request may chain. */
export const NAV_MAX_STEPS = 10;

const NAV_UNAVAILABLE = 'Map navigation is not available right now';
const NAV_REFUSED = 'The map navigation control refused that move';

const NAV_ZOOM_DIRECTIONS = new Set(['in', 'out']);
const NAV_LOOK_DIRECTIONS = new Set(['left', 'right', 'up', 'down']);

/** A whole number within bounds, or null. */
function navIntegerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * The voice adapter over a mounted navigation widget.
 *
 * @param {object} options
 *   getHandle () => the mounted navigation handle, or null when it is gone
 * @returns {object} one method per action in {@link NAV_VOICE_ACTIONS}
 */
export function createNavVoice({ getHandle } = {}) {
  const handle = () => {
    const nav = getHandle?.();
    return nav && !nav.destroyed ? nav : null;
  };

  /** Run an action against the live widget; never throws. */
  async function guard(fn) {
    try {
      const nav = handle();
      if (!nav) return { ok: false, error: NAV_UNAVAILABLE };
      return await fn(nav);
    } catch {
      return { ok: false, error: NAV_UNAVAILABLE };
    }
  }

  /** The camera readback the widget publishes. */
  const stateOf = (nav) => {
    const state = nav.state?.();
    return state && typeof state === 'object' ? state : {};
  };

  /** A step count the widget accepts, or null. */
  const stepsOf = (value) => {
    if (value == null) return 1;
    return navIntegerIn(value, 1, NAV_MAX_STEPS);
  };

  return {
    async tilt({ tilt } = {}) {
      return guard(async (nav) => {
        const deg = navIntegerIn(tilt, NAV_TILT_MIN_DEG, NAV_TILT_MAX_DEG);
        if (deg == null)
          return {
            ok: false,
            error: `tilt must be a whole number from ${NAV_TILT_MIN_DEG} to ${NAV_TILT_MAX_DEG}`,
          };
        if (nav.setTilt?.(deg) !== true)
          return { ok: false, error: NAV_REFUSED };
        return { ok: true, ...stateOf(nav) };
      });
    },

    async heading({ heading } = {}) {
      return guard(async (nav) => {
        const deg = navIntegerIn(
          heading,
          NAV_HEADING_MIN_DEG,
          NAV_HEADING_MAX_DEG,
        );
        if (deg == null)
          return {
            ok: false,
            error: `heading must be a whole number from ${NAV_HEADING_MIN_DEG} to ${NAV_HEADING_MAX_DEG}`,
          };
        if (nav.setHeading?.(deg) !== true)
          return { ok: false, error: NAV_REFUSED };
        return { ok: true, ...stateOf(nav) };
      });
    },

    async zoom({ direction, steps } = {}) {
      return guard(async (nav) => {
        const dir = NAV_ZOOM_DIRECTIONS.has(direction) ? direction : null;
        if (!dir) return { ok: false, error: 'direction must be in or out' };
        const count = stepsOf(steps);
        if (count == null)
          return {
            ok: false,
            error: `steps must be a whole number from 1 to ${NAV_MAX_STEPS}`,
          };
        if (nav.applySteps?.(`zoom-${dir}`, count) !== true)
          return { ok: false, error: NAV_REFUSED };
        return { ok: true, ...stateOf(nav) };
      });
    },

    async top_down() {
      return guard(async (nav) => {
        if (nav.applySteps?.('top-down', 1) !== true)
          return { ok: false, error: NAV_REFUSED };
        return { ok: true, ...stateOf(nav) };
      });
    },

    async north() {
      return guard(async (nav) => {
        if (nav.applySteps?.('north', 1) !== true)
          return { ok: false, error: NAV_REFUSED };
        return { ok: true, ...stateOf(nav) };
      });
    },

    async look({ direction, steps } = {}) {
      return guard(async (nav) => {
        const dir = NAV_LOOK_DIRECTIONS.has(direction) ? direction : null;
        if (!dir)
          return {
            ok: false,
            error: 'direction must be left, right, up or down',
          };
        const count = stepsOf(steps);
        if (count == null)
          return {
            ok: false,
            error: `steps must be a whole number from 1 to ${NAV_MAX_STEPS}`,
          };
        if (nav.applySteps?.(`look-${dir}`, count) !== true)
          return { ok: false, error: NAV_REFUSED };
        return { ok: true, ...stateOf(nav) };
      });
    },

    async status() {
      return guard(async (nav) => ({ ok: true, ...stateOf(nav) }));
    },
  };
}

/**
 * A centre pick can come back wild while tiles are still streaming (a far
 * tile, a depth glitch): seen 13 km below the ellipsoid at a 27 km range from
 * a camera 600 m up. Zooming a fraction of such a range flies the camera under
 * the ground, so a target outside the plausible surface band is not trusted.
 */
export const MIN_TARGET_HEIGHT_M = -1500;
export const MAX_TARGET_HEIGHT_M = 25_000;

const ROOT_ATTRIBUTE = 'data-gev-nav-control';
const STEP_ANIMATION_MS = 220;
const FIRST_REPEAT_MS = 380;
const REPEAT_MS = 130;
const mounted = new WeakMap();

const REPEATING = new Set([
  'zoom-in',
  'zoom-out',
  'tilt-up',
  'tilt-down',
  'look-left',
  'look-right',
  'look-up',
  'look-down',
]);
const LOOK_ACTIONS = new Set([
  'look-left',
  'look-right',
  'look-up',
  'look-down',
]);

const LABELS = {
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'tilt-up': 'Tilt up toward the horizon',
  'tilt-down': 'Tilt down toward top-down view',
  'top-down': 'Top-down view',
  'look-left': 'Look left',
  'look-right': 'Look right',
  'look-up': 'Look up',
  'look-down': 'Look down',
};
const GLYPHS = {
  'zoom-in': '+',
  'zoom-out': '\u2212',
  'tilt-up': '\u25B2',
  'tilt-down': '\u25BC',
  'top-down': 'TOP',
  'look-left': '\u25C0',
  'look-right': '\u25B6',
  'look-up': '\u25B2',
  'look-down': '\u25BC',
};

/** Where the camera sits for an orbit view of `target`. */
export function orbitCameraPosition(target, { heading, pitch, range }) {
  const east = range * -Math.sin(heading) * Math.cos(pitch);
  const north = range * -Math.cos(heading) * Math.cos(pitch);
  const up = range * -Math.sin(pitch);
  return Cesium.Matrix4.multiplyByPoint(
    Cesium.Transforms.eastNorthUpToFixedFrame(target),
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3(),
  );
}

/** Whether a picked world position sits in the band the surface can occupy. */
export function plausibleTarget(target) {
  const carto = target && Cesium.Cartographic.fromCartesian(target);
  return Boolean(
    carto &&
    carto.height >= MIN_TARGET_HEIGHT_M &&
    carto.height <= MAX_TARGET_HEIGHT_M,
  );
}

/** The orbit frame of a camera around `target`, in the same terms as upstream. */
export function frameForTarget(camera, target) {
  const inverse = Cesium.Matrix4.inverseTransformation(
    Cesium.Transforms.eastNorthUpToFixedFrame(target),
    new Cesium.Matrix4(),
  );
  const local = Cesium.Matrix4.multiplyByPoint(
    inverse,
    camera.positionWC,
    new Cesium.Cartesian3(),
  );
  const range = Cesium.Cartesian3.magnitude(local);
  if (!Number.isFinite(range) || range < 1) return null;
  const pitch = -Math.asin(Cesium.Math.clamp(local.z / range, -1, 1));
  const heading =
    pitch < Cesium.Math.toRadians(-88.5)
      ? camera.heading
      : Math.atan2(-local.x, -local.y);
  return { target, range, heading: normalizeHeading(heading), pitch };
}

function tracked(viewer) {
  const entity = viewer.trackedEntity;
  if (!entity) return null;
  return (
    entity.gevDisplayPosition?.() ||
    entity.position?.getValue(viewer.clock?.currentTime) ||
    null
  );
}

/**
 * Ease an orbit view toward a destination, re-aiming from wherever the last
 * step has got to so chained presses accumulate instead of restarting.
 */
function createOrbitAnimator(viewer, { now, onSettled }) {
  let remove = null;
  let state = null;

  const cancel = () => {
    remove?.();
    remove = null;
    state = null;
  };

  function current() {
    if (!state) return null;
    return state.shown;
  }

  function animate(frame, to, duration = STEP_ANIMATION_MS) {
    const from = state?.shown || {
      heading: frame.heading,
      pitch: frame.pitch,
      range: frame.range,
    };
    const target = state?.frame || frame;
    cancel();
    const entity = viewer.trackedEntity;
    const apply = (view, aim) =>
      setCameraTargetFrame(viewer, { ...target, target: aim, ...view });
    if (duration <= 0 || !viewer.scene?.preUpdate?.addEventListener) {
      const done = apply(to, target.target);
      if (done) onSettled?.(to);
      return done;
    }
    state = {
      frame: target,
      to,
      shown: from,
      lastPosition: null,
    };
    const start = now();
    const turn = shortestTurn(from.heading, to.heading);
    remove = viewer.scene.preUpdate.addEventListener(() => {
      if (viewer.isDestroyed?.() || viewer.trackedEntity !== entity) {
        cancel();
        return;
      }
      // Someone else (a flight, a search, a drag) moved the camera since the
      // last step: they own it now, so stop instead of pulling it back.
      if (state?.lastPosition && !entity) {
        const moved = Cesium.Cartesian3.distance(
          viewer.camera.positionWC,
          state.lastPosition,
        );
        if (moved > Math.max(1, state.shown.range * 1e-3)) {
          cancel();
          return;
        }
      }
      const progress = Math.min(1, Math.max(0, (now() - start) / duration));
      const eased = easeInOut(progress);
      const aim = entity ? tracked(viewer) : target.target;
      const view = {
        heading: normalizeHeading(from.heading + turn * eased),
        pitch: from.pitch + (to.pitch - from.pitch) * eased,
        range: from.range * Math.pow(to.range / from.range, eased),
      };
      if (!aim || !apply(view, aim)) {
        cancel();
        return;
      }
      state.shown = view;
      state.lastPosition = Cesium.Cartesian3.clone(viewer.camera.positionWC);
      if (progress === 1) {
        const settled = state.to;
        cancel();
        onSettled?.(settled);
      }
    });
    viewer.scene.requestRender?.();
    return true;
  }

  return {
    animate,
    cancel,
    get active() {
      return Boolean(state);
    },
    get destination() {
      return state?.to || null;
    },
    get frame() {
      return state?.frame || null;
    },
    current,
  };
}

function build(doc) {
  const make = (tag, className, attributes = {}, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (action, className) =>
    make(
      'button',
      `gev-nav-btn ${className}`,
      {
        type: 'button',
        'data-nav': action,
        'aria-label': LABELS[action],
        title: LABELS[action],
      },
      GLYPHS[action],
    );

  const root = make('section', 'gev-nav', {
    [ROOT_ATTRIBUTE]: '',
    id: 'gev-nav-control',
    role: 'group',
    'aria-label': 'Map navigation',
  });

  const tilt = make('div', 'gev-nav-tilt');
  const tiltUp = button('tilt-up', 'gev-nav-tilt-up');
  const slider = make('input', 'gev-nav-slider', {
    type: 'range',
    min: 0,
    max: TILT_SPAN_DEG,
    step: 1,
    value: 0,
    'data-nav': 'tilt-slider',
    'aria-label': 'Tilt',
    'aria-orientation': 'vertical',
    title: 'Tilt: top-down (bottom) to near horizon (top)',
  });
  const tiltDown = button('tilt-down', 'gev-nav-tilt-down');
  tilt.append(tiltUp, slider, tiltDown);

  const compass = make('div', 'gev-nav-compass');
  const dial = make('div', 'gev-nav-dial', {
    'data-nav': 'ring',
    role: 'slider',
    tabindex: 0,
    'aria-label':
      'Map heading. Drag to rotate, arrow keys turn, Home for north',
    'aria-valuemin': 0,
    'aria-valuemax': 359,
    'aria-valuenow': 0,
    'aria-valuetext': 'North, 0 degrees',
  });
  const mark = make('span', 'gev-nav-dial-mark', { 'aria-hidden': 'true' });
  dial.append(mark);
  const north = make(
    'button',
    'gev-nav-btn gev-nav-north',
    {
      type: 'button',
      'data-nav': 'north',
      'aria-label': 'Reset map to north up. Current heading 0 degrees',
      title: 'North up',
    },
    'N',
  );
  const look = make('div', 'gev-nav-look', {
    role: 'group',
    'aria-label': 'Look around',
  });
  look.append(
    button('look-up', 'gev-nav-look-up'),
    button('look-left', 'gev-nav-look-left'),
    button('look-right', 'gev-nav-look-right'),
    button('look-down', 'gev-nav-look-down'),
  );
  compass.append(dial, look, north);

  const zoom = make('div', 'gev-nav-zoom');
  zoom.append(
    button('zoom-in', 'gev-nav-zoom-in'),
    button('zoom-out', 'gev-nav-zoom-out'),
    button('top-down', 'gev-nav-top-down'),
  );

  root.append(tilt, compass, zoom);
  return { root, dial, north, slider, look };
}

/**
 * Mount the control once per viewer.
 * @param {Object} options
 * @param {Cesium.Viewer} options.viewer Live viewer.
 * @param {HTMLElement} [options.parent] Mount point (default `document.body`).
 * @param {Document} [options.document] Document used to build the DOM.
 * @param {Function} [options.runNavigation] `(noun, navigate) => result`; the
 *   shell's explicit-navigation policy. Defaults to calling `navigate()`.
 * @param {Function} [options.showToast] Operator-visible message.
 * @param {Function} [options.now] Millisecond clock (tests inject one).
 * @param {Object} [options.timers] `{setTimeout, clearTimeout}` (tests inject).
 * @param {Object} [options.hookWindow] Window that receives `__gevNav`.
 */
export function mountNavControl({
  viewer: sceneViewer,
  parent,
  document: doc = globalThis.document,
  runNavigation = (_noun, navigate) => navigate(),
  showToast,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  timers = globalThis,
  hookWindow = globalThis.window,
} = {}) {
  const viewer = cesiumViewerFor(sceneViewer);
  if (!viewer?.camera || !viewer?.scene)
    throw new TypeError('A viewer with a camera and scene is required');
  const existing = mounted.get(viewer);
  if (existing && !existing.destroyed) return existing;

  const host = parent || doc?.body;
  if (!host || !doc) throw new TypeError('A document and parent are required');
  const { root, dial, north, slider } = build(doc);
  host.append(root);

  const removers = [];
  let destroyed = false;
  let applied = null;
  let sliderDragging = false;
  let hold = null;
  let drag = null;

  const camera = viewer.camera;
  const animator = createOrbitAnimator(viewer, {
    now,
    onSettled: () => refreshTilt(),
  });

  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const subscribe = (event, handler) => {
    const remove = event?.addEventListener?.(handler);
    if (typeof remove === 'function') removers.push(remove);
  };

  /** Height of the camera over the surface for an orbit pitch, or NaN. */
  const clearanceProbe = (frame, view) => (pitch) => {
    try {
      const position = orbitCameraPosition(frame.target, { ...view, pitch });
      const carto = Cesium.Cartographic.fromCartesian(position);
      if (!carto) return Number.NaN;
      let ground = viewer.scene.sampleHeight?.(carto);
      if (!Number.isFinite(ground))
        ground = viewer.scene.globe?.getHeight?.(carto);
      return Number.isFinite(ground) ? carto.height - ground : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };

  /**
   * Put the camera on an orbit frame, keeping it clear of the ground.
   * `view` carries the heading, pitch and range to apply.
   */
  const applyFrame = (frame, view) => {
    let pitch = clampPitch(view.pitch, view.range);
    if (pitch > TOP_DOWN_PITCH)
      pitch = liftPitchForClearance(
        pitch,
        clearanceProbe(frame, { ...view, pitch }),
      );
    return setCameraTargetFrame(viewer, { ...frame, ...view, pitch });
  };

  /**
   * Orbit frame around the screen centre. A followed entity is trusted as is;
   * otherwise a wild pick falls back to the ellipsoid under the centre, and
   * a view with no ground in it (the sky) has no frame.
   */
  const readFrame = () => {
    const frame = readCameraTargetFrame(viewer);
    if (frame && (viewer.trackedEntity || plausibleTarget(frame.target)))
      return frame;
    try {
      const canvas = viewer.scene.canvas;
      const centre = new Cesium.Cartesian2(
        (canvas.clientWidth || canvas.width) / 2,
        (canvas.clientHeight || canvas.height) / 2,
      );
      const ground = camera.pickEllipsoid(centre, Cesium.Ellipsoid.WGS84);
      return ground ? frameForTarget(camera, ground) : null;
    } catch {
      return null;
    }
  };

  /** Keep the camera in place and change where it looks (also the no-target fallback). */
  const lookInPlace = (heading, pitch) => {
    try {
      camera.setView({
        destination: Cesium.Cartesian3.clone(camera.positionWC),
        orientation: { heading, pitch, roll: 0 },
      });
      viewer.scene.requestRender?.();
      return true;
    } catch {
      return false;
    }
  };

  /** One discrete action; returns whether the camera accepted it. */
  function perform(action) {
    const result = runNavigation('camera', () => {
      if (LOOK_ACTIONS.has(action)) {
        if (viewer.trackedEntity) return false;
        animator.cancel();
        const next = planLook(
          { heading: camera.heading, pitch: camera.pitch },
          action,
        );
        return lookInPlace(next.heading, next.pitch);
      }
      const pending = animator.active ? animator.destination : null;
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return performWithoutTarget(action);
      const base = pending || frame;
      const plan = planAction(base, action);
      if (plan.pitch > TOP_DOWN_PITCH) {
        plan.pitch = liftPitchForClearance(
          plan.pitch,
          clearanceProbe(frame, plan),
        );
      }
      return animator.animate(
        frame,
        { heading: plan.heading, pitch: plan.pitch, range: plan.range },
        action === 'top-down' || action === 'north' ? 650 : STEP_ANIMATION_MS,
      );
    });
    refreshHeading();
    return Boolean(result);
  }

  /**
   * Apply `count` steps of one action at once, the way a held button repeats
   * but without the easing: the plan is computed step by step (each step
   * plans from where the last one got to) and the camera is put on the last
   * frame straight away, so the camera reads back what was asked for.
   */
  function applySteps(action, count = 1) {
    const times = Math.max(1, Math.min(NAV_MAX_STEPS, Math.trunc(count) || 1));
    const result = runNavigation('camera', () => {
      if (LOOK_ACTIONS.has(action)) {
        if (viewer.trackedEntity) return false;
        animator.cancel();
        let look = { heading: camera.heading, pitch: camera.pitch };
        for (let i = 0; i < times; i++) look = planLook(look, action);
        return lookInPlace(look.heading, look.pitch);
      }
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) {
        // No target under the camera: zoom works in place, the rest has no
        // meaning without one.
        if (action === 'zoom-in' || action === 'zoom-out') {
          for (let i = 0; i < times; i++) performWithoutTarget(action);
          return true;
        }
        return performWithoutTarget(action);
      }
      let base = animator.destination || frame;
      for (let i = 0; i < times; i++) base = planAction(base, action);
      animator.cancel();
      return applyFrame(frame, base);
    });
    refreshHeading();
    refreshTilt();
    return Boolean(result);
  }

  /**
   * Set the tilt in whole degrees from top-down (0) to near-horizon
   * (TILT_SPAN_DEG). This is the slider's own maths, so voice and the slider
   * always agree.
   */
  function setTilt(deg) {
    const value = Math.round(Number(deg));
    if (!Number.isFinite(value)) return false;
    const tilt = Math.min(TILT_SPAN_DEG, Math.max(0, value));
    const pitchWanted = tiltDegToPitch(tilt);
    const result = runNavigation('camera', () => {
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return lookInPlace(camera.heading, pitchWanted);
      const heading = animator.destination?.heading ?? frame.heading;
      const range = animator.destination?.range ?? frame.range;
      animator.cancel();
      return applyFrame(frame, { heading, pitch: pitchWanted, range });
    });
    refreshHeading();
    refreshTilt();
    return Boolean(result);
  }

  /**
   * Set the heading in whole degrees from north (0..359). The camera turns
   * straight to the new bearing, the way the compass ring does.
   */
  function setHeading(deg) {
    const value = Number(deg);
    if (!Number.isFinite(value)) return false;
    const wanted = normalizeHeading((((value % 360) + 360) % 360) * DEG);
    const result = runNavigation('camera', () => {
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return lookInPlace(wanted, camera.pitch);
      const base = animator.destination || frame;
      animator.cancel();
      return applyFrame(frame, {
        heading: wanted,
        pitch: base.pitch,
        range: base.range,
      });
    });
    refreshHeading();
    refreshTilt();
    return Boolean(result);
  }

  /** What the camera shows right now, for the voice readback. */
  function state() {
    const frame = readFrame();
    const pitch = frame ? frame.pitch : camera.pitch;
    const heading = headingDegrees(camera.heading);
    const tilt = pitchToTiltDeg(pitch);
    return {
      heading,
      tilt,
      rangeM: frame ? Math.round(frame.range) : null,
      northUp: heading === 0,
      topDown: tilt === 0,
      following: Boolean(viewer.trackedEntity),
    };
  }

  /** No pick, no ellipsoid hit (looking at the sky): turn or move in place. */
  function performWithoutTarget(action) {
    const heading = camera.heading;
    const pitch = Number.isFinite(camera.pitch) ? camera.pitch : TOP_DOWN_PITCH;
    switch (action) {
      case 'zoom-in':
      case 'zoom-out': {
        const height = Math.max(
          1,
          Number(camera.positionCartographic?.height) || 1_000,
        );
        const amount = height * ZOOM_FRACTION;
        if (action === 'zoom-in') camera.zoomIn?.(amount);
        else camera.zoomOut?.(amount);
        viewer.scene.requestRender?.();
        return true;
      }
      case 'north':
        return lookInPlace(0, pitch);
      case 'top-down':
        return lookInPlace(heading, -Math.PI / 2);
      case 'tilt-up':
      case 'tilt-down':
      case 'rotate-left':
      case 'rotate-right': {
        const next = planAction({ heading, pitch, range: 1_000 }, action);
        return lookInPlace(next.heading, next.pitch);
      }
      default:
        return false;
    }
  }

  // ── press-and-hold ───────────────────────────────────────────────────
  function stopHold() {
    if (!hold) return;
    timers.clearTimeout(hold.timeout);
    timers.clearInterval?.(hold.interval);
    hold = null;
  }
  function startHold(action) {
    stopHold();
    perform(action);
    if (!REPEATING.has(action)) return;
    const token = {};
    hold = token;
    token.timeout = timers.setTimeout(() => {
      if (hold !== token) return;
      token.interval = timers.setInterval(() => {
        if (hold !== token || destroyed) return;
        perform(action);
      }, REPEAT_MS);
    }, FIRST_REPEAT_MS);
  }

  for (const node of root.querySelectorAll?.('[data-nav]') || []) {
    const action = node.getAttribute('data-nav');
    if (action === 'ring' || action === 'tilt-slider') continue;
    const act = action === 'north' ? 'north' : action;
    listen(node, 'pointerdown', (event) => {
      if (event.button > 0) return;
      startHold(act);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
      listen(node, type, stopHold);
    // Keyboard activation arrives as a click with no pointer (detail 0).
    // Pointer clicks were already handled on pointerdown.
    listen(node, 'click', (event) => {
      if (event.detail) return;
      perform(act);
    });
  }
  listen(globalThis, 'blur', stopHold);

  // ── compass ring: drag to rotate, arrows turn, Home is north ───────────
  listen(dial, 'pointerdown', (event) => {
    if (event.button > 0) return;
    const rect = dial.getBoundingClientRect?.();
    if (!rect || !rect.width) return;
    const result = runNavigation('camera', () => {
      animator.cancel();
      return readFrame() || { fallback: true, heading: camera.heading };
    });
    if (!result) return;
    drag = {
      frame: result.fallback ? null : result,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      startHeading: result.heading,
      pitch: result.fallback ? camera.pitch : result.pitch,
      startAngle: pointerAngle(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        event.clientX,
        event.clientY,
      ),
    };
    try {
      dial.setPointerCapture?.(event.pointerId);
    } catch {
      /* synthetic pointer */
    }
    root.setAttribute('data-dragging', 'ring');
  });
  listen(dial, 'pointermove', (event) => {
    if (!drag) return;
    const heading = headingFromDrag({
      startHeading: drag.startHeading,
      startAngle: drag.startAngle,
      angle: pointerAngle(
        drag.centerX,
        drag.centerY,
        event.clientX,
        event.clientY,
      ),
    });
    if (drag.frame) setCameraTargetFrame(viewer, { ...drag.frame, heading });
    else lookInPlace(heading, drag.pitch);
    refreshHeading();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    root.removeAttribute('data-dragging');
    refreshTilt();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    listen(dial, type, endDrag);
  listen(dial, 'keydown', (event) => {
    const map = {
      ArrowLeft: 'rotate-left',
      ArrowDown: 'rotate-left',
      ArrowRight: 'rotate-right',
      ArrowUp: 'rotate-right',
      Home: 'north',
    };
    const action = map[event.key];
    if (!action) return;
    event.preventDefault?.();
    perform(action);
  });

  // ── tilt slider ──────────────────────────────────────────────────────
  listen(slider, 'pointerdown', () => {
    sliderDragging = true;
  });
  for (const type of ['pointerup', 'pointercancel', 'blur'])
    listen(slider, type, () => {
      sliderDragging = false;
      refreshTilt();
    });
  listen(slider, 'input', () => {
    const pitchWanted = tiltDegToPitch(Number(slider.value));
    runNavigation('camera', () => {
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return lookInPlace(camera.heading, pitchWanted);
      const heading = animator.destination?.heading ?? frame.heading;
      const range = animator.destination?.range ?? frame.range;
      animator.cancel();
      return applyFrame(frame, { heading, pitch: pitchWanted, range });
    });
    refreshHeading();
  });

  // ── state shown on the control ───────────────────────────────────────
  function refreshHeading() {
    if (destroyed) return;
    const heading = headingDegrees(camera.heading);
    if (applied?.heading === heading) return;
    applied = { ...applied, heading };
    root.style.setProperty('--gev-nav-heading', `${heading}deg`);
    root.setAttribute('data-north-up', String(heading === 0));
    dial.setAttribute('aria-valuenow', String(heading));
    dial.setAttribute(
      'aria-valuetext',
      heading === 0 ? 'North, 0 degrees' : `${heading} degrees from north`,
    );
    north.setAttribute(
      'aria-label',
      `Reset map to north up. Current heading ${heading} degrees`,
    );
  }
  /** Exact tilt costs one depth read, so it refreshes once per gesture. */
  function refreshTilt() {
    if (destroyed || sliderDragging) return;
    const frame = animator.active ? null : readFrame();
    const pitch = frame ? frame.pitch : camera.pitch;
    const tilt = pitchToTiltDeg(pitch);
    if (applied?.tilt !== tilt) {
      applied = { ...applied, tilt };
      slider.value = String(tilt);
      slider.setAttribute('aria-valuetext', `${tilt} degrees from top-down`);
    }
    const following = Boolean(viewer.trackedEntity);
    if (applied.following !== following) {
      applied = { ...applied, following };
      root.setAttribute('data-following', String(following));
      for (const node of root.querySelectorAll?.('[data-nav^="look-"]') || []) {
        if (following) node.setAttribute('disabled', '');
        else node.removeAttribute('disabled');
      }
    }
  }
  subscribe(viewer.scene.preRender, refreshHeading);
  subscribe(camera.moveEnd, refreshTilt);
  subscribe(viewer.trackedEntityChanged, () => {
    animator.cancel();
    refreshTilt();
  });
  // A physical gesture on the globe supersedes any step still easing.
  for (const type of ['pointerdown', 'wheel'])
    listen(viewer.scene.canvas, type, animator.cancel, { passive: true });
  refreshHeading();
  refreshTilt();

  const voice = createNavVoice({
    getHandle: () => (destroyed ? null : handle),
  });

  const handle = {
    root,
    perform,
    applySteps,
    setTilt,
    setHeading,
    state,
    voice,
    refresh() {
      refreshHeading();
      refreshTilt();
    },
    get destroyed() {
      return destroyed;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // The voice surface goes with the widget: a later mount publishes a
      // fresh one, and this destroy never takes that one down.
      if (hookWindow?.__gevNav?.voice === voice) delete hookWindow.__gevNav;
      stopHold();
      animator.cancel();
      for (const remove of removers.splice(0)) remove();
      root.remove?.();
      mounted.delete(viewer);
    },
  };
  mounted.set(viewer, handle);
  if (hookWindow) hookWindow.__gevNav = { voice };
  return handle;
}
