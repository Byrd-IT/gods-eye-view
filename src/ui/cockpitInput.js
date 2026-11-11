/** Route Cockpit keys while preserving the active disclosure and form-control owner. */
import * as Cesium from 'cesium';
import { lookKeyStep } from '../cockpitLook.js';
import { isPointerFree } from '../data/inputOwnership.js';

/** How far from the followed track a double-click may land, CSS pixels. */
export const SUBJECT_DOUBLE_CLICK_RADIUS_PX = 32;

/**
 * A touch screen never sends Cesium a LEFT_DOUBLE_CLICK: its touch path ends
 * in a single LEFT_CLICK, and iPhone Safari does not send `dblclick` for a
 * double-tap on the canvas. The Cockpit therefore recognises the double-tap
 * itself, with the same limits as the Sky view's: two taps within 350 ms and
 * 30 px of each other. The second tap may land a fingertip from the track,
 * wider than the mouse's 32 px.
 */
export const TOUCH_DOUBLE_TAP_MS = 350;
export const TOUCH_DOUBLE_TAP_PX = 30;
export const SUBJECT_TOUCH_RADIUS_PX = 44;
/** A tap is a press that stays put and ends quickly. */
export const TOUCH_TAP_MAX_TRAVEL_PX = 10;
export const TOUCH_TAP_MAX_MS = 400;
/**
 * Some touch devices (Android Chrome, touch laptops) also send `dblclick`
 * after the double-tap. It must not reach Cesium's stock handler, which
 * untracks the aircraft the Cockpit has just entered on.
 */
export const TOUCH_ENTRY_DBLCLICK_GUARD_MS = 700;
/** A press with no matching release for this long is discarded. */
export const TOUCH_PRESS_STALE_MS = 2000;

/**
 * Whether a double-click landed on the followed track's mark.
 * @param {{x: number, y: number}|null} click Canvas position of the click.
 * @param {{x: number, y: number}|null|undefined} subject Canvas position of
 *   the track, or nothing when it is off screen.
 * @param {number} [radiusPx]
 */
export function doubleClickHitsSubject(
  click,
  subject,
  radiusPx = SUBJECT_DOUBLE_CLICK_RADIUS_PX,
) {
  if (!click || !subject) return false;
  const distance = Math.hypot(click.x - subject.x, click.y - subject.y);
  return Number.isFinite(distance) && distance <= radiusPx;
}

/**
 * How long the first press of a double-click keeps its picture of the track,
 * ms: a click on a selected ship re-centres the camera, so the ship can move
 * on screen before the second click lands.
 */
export const DOUBLE_CLICK_MEMORY_MS = 700;

/** Where the track `kind` would ride is drawn now, as a world position. */
function subjectWorldPosition(kind) {
  if (kind === 'aircraft') {
    return (
      this.viewer.trackedEntity?.position?.getValue?.(
        this.viewer.clock?.currentTime,
      ) ?? null
    );
  }
  if (kind === 'satellite')
    return this.services.satellitesLayer?.getCockpitPosition?.() ?? null;
  const info = this.readVesselInfo();
  if (!Number.isFinite(info?.latitude) || !Number.isFinite(info?.longitude))
    return null;
  // The sprite floats on the geoid, not on the ellipsoid (tens of metres
  // apart): project the height it is drawn at.
  const heightM = Number.isFinite(info.markHeightM)
    ? info.markHeightM
    : Number.isFinite(info.seaSurfaceHeightM)
      ? info.seaSurfaceHeightM
      : 0;
  return Cesium.Cartesian3.fromDegrees(info.longitude, info.latitude, heightM);
}

/** The followed track's canvas position now, or null off screen. */
function subjectCanvasPosition() {
  const kind = this.resolveEntryKind();
  const world = kind ? subjectWorldPosition.call(this, kind) : null;
  const scene = this.viewer.scene;
  if (!world || typeof scene?.cartesianToCanvasCoordinates !== 'function')
    return null;
  return (
    scene.cartesianToCanvasCoordinates(world, new Cesium.Cartesian2()) ?? null
  );
}

/**
 * Note where the selected ship is drawn as a press begins, for a
 * double-click whose first click moves it. The second press of the gesture
 * keeps the first one's picture: by then the first click may have moved it.
 * @param {number} [nowMs]
 */
export function onScenePointerDown(nowMs = performance.now()) {
  if (this.active || this.destroyed) return;
  const start = this.doubleClickStart;
  if (start && nowMs - start.atMs <= DOUBLE_CLICK_MEMORY_MS) return;
  // Only a ship moves under its own click (selecting it re-centres the
  // camera); a followed aircraft stays put, so its hit area stays its own.
  if (this.resolveEntryKind() !== 'vessel') {
    this.doubleClickStart = null;
    return;
  }
  const at = subjectCanvasPosition.call(this);
  const vesselId = this.readVesselInfo()?.id ?? null;
  this.doubleClickStart = at
    ? { x: at.x, y: at.y, atMs: nowMs, vesselId }
    : null;
}

/**
 * Enter first person when the followed track itself is double-clicked: the
 * same entry, and the same gates, as the entry buttons. The click may
 * land where the track is drawn now or where it was as the gesture began. A
 * double-click anywhere else, or one a tool owns (drawing ends a shape with
 * one), is left alone.
 * @param {{x: number, y: number}|null|undefined} position Canvas position.
 * @param {number|{radiusPx?: number, nowMs?: number}} [options] The clock in
 *   ms, or `{ radiusPx, nowMs }`: the hit radius (a touch double-tap passes
 *   {@link SUBJECT_TOUCH_RADIUS_PX}) and the clock.
 * @returns {boolean} True when it landed on the followed track, entered or
 *   refused by the gate: the caller does nothing else with it.
 */
export function onSceneDoubleClick(position, options = {}) {
  // `options` is `{ radiusPx, nowMs }`; a bare number is the clock, as the
  // memory test below has always taken it. Byrd-IT: a touch double-tap passes
  // a fingertip-wide `radiusPx`.
  const nowMs =
    typeof options === 'number'
      ? options
      : Number.isFinite(options?.nowMs)
        ? options.nowMs
        : performance.now();
  const radiusPx = Number.isFinite(options?.radiusPx)
    ? options.radiusPx
    : SUBJECT_DOUBLE_CLICK_RADIUS_PX;
  const start = this.doubleClickStart;
  this.doubleClickStart = null;
  if (this.active || this.destroyed || !isPointerFree()) return false;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y))
    return false;
  const hit =
    doubleClickHitsSubject(
      position,
      subjectCanvasPosition.call(this),
      radiusPx,
    ) ||
    (Boolean(start) &&
      nowMs - start.atMs <= DOUBLE_CLICK_MEMORY_MS &&
      // The memory is the ship's it was taken for: one followed since (an
      // aircraft, another ship) is hit only where it is drawn.
      this.resolveEntryKind() === 'vessel' &&
      start.vesselId === (this.readVesselInfo()?.id ?? null) &&
      doubleClickHitsSubject(position, start, radiusPx));
  if (!hit) return false;
  this.enter();
  return true;
}

/**
 * Take the scene's double-click through the Cockpit first. Cesium's Viewer
 * installs its own (pickAndTrackObject), which untracks whenever the pick is
 * not an Entity: on a followed aircraft's model, a primitive, it would drop
 * the very track the double-click means to ride. A double-click on the
 * followed track is the Cockpit's, as is one on a mapped ground point in
 * orbit (a focus); any other goes on to Cesium's.
 * @returns {() => void} Puts Cesium's handler back, unless another owner
 *   (the draw tool borrows it) has replaced ours since.
 */
export function routeSceneDoubleClick() {
  const handler = this.viewer.screenSpaceEventHandler;
  if (typeof handler?.setInputAction !== 'function') return () => {};
  const type = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
  const stock = handler.getInputAction?.(type) ?? null;
  const routed = (event) => {
    if (this.onSceneDoubleClick(event?.position)) return;
    // The dblclick that follows a touch double-tap which just entered.
    if (
      Number.isFinite(this._touchEnteredAt) &&
      performance.now() - this._touchEnteredAt <= TOUCH_ENTRY_DBLCLICK_GUARD_MS
    )
      return;
    // In orbit, a double-click on a mapped ground point is a focus, never a
    // retarget that would end the view.
    if (this.onOrbitalDoubleClick?.(event?.position)) return;
    stock?.(event);
  };
  handler.setInputAction(routed, type);
  return () => {
    if (handler.isDestroyed?.() || handler.getInputAction?.(type) !== routed)
      return;
    if (stock) handler.setInputAction(stock, type);
    else handler.removeInputAction(type);
  };
}

/**
 * Whether `tap` completes a double-tap that began with `previous`.
 * @param {{x: number, y: number, at: number}|null|undefined} previous
 * @param {{x: number, y: number, at: number}|null|undefined} tap
 */
export function isTouchDoubleTap(previous, tap) {
  if (!previous || !tap) return false;
  const dt = tap.at - previous.at;
  if (!(dt >= 0 && dt <= TOUCH_DOUBLE_TAP_MS)) return false;
  const distance = Math.hypot(tap.x - previous.x, tap.y - previous.y);
  return Number.isFinite(distance) && distance <= TOUCH_DOUBLE_TAP_PX;
}

/**
 * Enter first person when the followed track is double-tapped on a touch
 * screen: the touch twin of {@link routeSceneDoubleClick}, with the same
 * entry, gates and refusals. Only touch pointers are read, so a mouse keeps
 * its `dblclick` route and a pen is left alone. A tap that is not a double-tap
 * on the track changes nothing: Cesium still receives every event.
 * @param {() => number} [now] Clock, for tests.
 * @returns {() => void} Removes the listeners.
 */
export function routeTouchDoubleTap(now = () => performance.now()) {
  const canvas = this.viewer?.canvas ?? this.viewer?.scene?.canvas;
  if (typeof canvas?.addEventListener !== 'function') return () => {};
  const pressed = new Map();
  let lastTap = null;
  const local = (event) => {
    const rect = canvas.getBoundingClientRect?.();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };
  const onDown = (event) => {
    if (event.pointerType !== 'touch') return;
    const at = now();
    // A release that never reached the canvas must not hold the route shut.
    for (const [id, press] of pressed)
      if (at - press.at > TOUCH_PRESS_STALE_MS) pressed.delete(id);
    // A second finger makes it a pinch or a pan, never a tap pair.
    if (pressed.size > 0) lastTap = null;
    pressed.set(event.pointerId, { ...local(event), at, travel: 0 });
  };
  const onMove = (event) => {
    const press = pressed.get(event.pointerId);
    if (!press) return;
    const here = local(event);
    press.travel = Math.max(
      press.travel,
      Math.hypot(here.x - press.x, here.y - press.y),
    );
  };
  const onUp = (event) => {
    const press = pressed.get(event.pointerId);
    pressed.delete(event.pointerId);
    if (!press || event.pointerType !== 'touch') return;
    const here = local(event);
    const at = now();
    const isTap =
      press.travel <= TOUCH_TAP_MAX_TRAVEL_PX &&
      Math.hypot(here.x - press.x, here.y - press.y) <=
        TOUCH_TAP_MAX_TRAVEL_PX &&
      at - press.at <= TOUCH_TAP_MAX_MS &&
      pressed.size === 0;
    if (!isTap) {
      lastTap = null;
      return;
    }
    const tap = { ...here, at };
    const doubled = isTouchDoubleTap(lastTap, tap);
    lastTap = doubled ? null : tap;
    if (!doubled) return;
    if (this.onSceneDoubleClick(tap, { radiusPx: SUBJECT_TOUCH_RADIUS_PX }))
      this._touchEnteredAt = performance.now();
  };
  const onCancel = (event) => {
    pressed.delete(event.pointerId);
    lastTap = null;
  };
  const options = { capture: true, passive: true };
  canvas.addEventListener('pointerdown', onDown, options);
  canvas.addEventListener('pointermove', onMove, options);
  canvas.addEventListener('pointerup', onUp, options);
  canvas.addEventListener('pointercancel', onCancel, options);
  return () => {
    canvas.removeEventListener('pointerdown', onDown, options);
    canvas.removeEventListener('pointermove', onMove, options);
    canvas.removeEventListener('pointerup', onUp, options);
    canvas.removeEventListener('pointercancel', onCancel, options);
  };
}

/**
 * Focus inside one of these keeps its arrows (and Home): text entry, sliders,
 * tabs, radio groups, lists and menus all move with them.
 */
const LOOK_KEY_OWNERS = [
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role=combobox]',
  '[role=grid]',
  '[role=menubar]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=scrollbar]',
  '[role=searchbox]',
  '[role=slider]',
  '[role=spinbutton]',
  '[role=textbox]',
  '[role=tree]',
  '[role=treeitem]',
  '[role=tab]',
  '[role=tablist]',
  '[role=radio]',
  '[role=radiogroup]',
  '[role=listbox]',
  '[role=menu]',
  '[role=menuitem]',
  '[role=option]',
].join(', ');

/**
 * Turn the bridge view with the arrow keys (Shift for 45° steps) and bring
 * it back over the bow with Home or 0. Only a bridge looks around, and only
 * while focus is on the scene or a plain HUD button.
 * @returns {boolean} True when the key was taken.
 */
function handleLookKey(event) {
  if (!this.active || this.subjectKind !== 'vessel') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const step = lookKeyStep(event.key, event.shiftKey);
  const reset = !event.repeat && (event.key === 'Home' || event.key === '0');
  if (!step && !reset) return false;
  if (event.target?.closest?.(LOOK_KEY_OWNERS)) return false;
  if (this.isUtilityDisclosureOpen?.()) return false;
  event.preventDefault();
  if (step) this.turnLook(step);
  else this.lookAhead();
  return true;
}

/** Zoom keys in orbit: `+` (or `=`, unshifted) in and `-` (or `_`) out. */
const ORBITAL_ZOOM_KEYS = Object.freeze({ '+': 1, '=': 1, '-': -1, _: -1 });

/**
 * In an orbital view: tilt off nadir with the arrows (single 5° steps; Shift
 * does not take the bridge's 45° step), return to nadir with Home or 0, and
 * step the zoom with + and −. The bridge's focus guards apply.
 * @returns {boolean} True when the key was taken.
 */
function handleOrbitalKey(event) {
  if (!this.active || this.subjectKind !== 'satellite') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const step = lookKeyStep(event.key);
  const reset = !event.repeat && (event.key === 'Home' || event.key === '0');
  const zoom = event.repeat ? 0 : ORBITAL_ZOOM_KEYS[event.key] || 0;
  if (!step && !reset && !zoom) return false;
  if (event.target?.closest?.(LOOK_KEY_OWNERS)) return false;
  if (this.isUtilityDisclosureOpen?.()) return false;
  event.preventDefault();
  if (step) this.turnOrbitalLook(step);
  else if (reset) this.orbitalNadir();
  else this.stepOrbitalZoom(zoom);
  return true;
}

/**
 * The Cockpit's capture-phase keydown: Escape, on a bridge the look-around
 * keys and in orbit the tilt and zoom keys. C is left to the app-wide CCTV
 * shortcut; entry is by double-click or the entry buttons.
 * @param {KeyboardEvent} event
 */
export function onKeyDown(event) {
  if (this.destroyed) return false;
  if (event.isComposing) return;
  // Held arrows turn a bridge view smoothly; every other key acts once.
  if (event.repeat && !lookKeyStep(event.key)) return;
  if (event.key === 'Escape' && this.active) {
    // The credit lightbox owns Escape while its Close control or links hold
    // focus. Its target handler closes the overlay and restores attribution
    // focus; Cockpit must stay active behind it.
    if (event.target?.closest?.('.cesium-credit-lightbox')) return;
    // An open Display or Radio popover takes Escape itself.
    if (this.isUtilityDisclosureOpen?.()) return;
    if (this.context?.contains(event.target) && !this.contextCollapsed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setContextCollapsed(true);
      if (
        event.target === this.contextToggle ||
        this.contextToggle?.contains?.(event.target)
      ) {
        this.contextToggle?.blur?.();
      } else {
        this.contextToggle?.focus({ preventScroll: true });
      }
      return;
    }
    if (this.signalStream?.contains(event.target) && !this.signalCollapsed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setSignalCollapsed(true, { user: true });
      if (
        event.target === this.signalToggle ||
        this.signalToggle?.contains?.(event.target)
      ) {
        this.signalToggle?.blur?.();
      } else {
        this.signalToggle?.focus({ preventScroll: true });
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.exit();
    return;
  }
  if (event.target?.closest?.('input, textarea, select, [contenteditable]'))
    return;
  if (handleLookKey.call(this, event)) return;
  handleOrbitalKey.call(this, event);
}
