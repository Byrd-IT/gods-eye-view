/**
 * Sky view (byrdit fork, SKYVIEW.md): a "Sky" button next to the map
 * navigation control. Pick a point on the globe, use the browser location,
 * or type "lat, lon" / a place; the camera drops to eye height there and
 * looks UP. Drag/pinch/wheel/keys look around (zoom = field of view), the
 * horizon is the real terrain (or a flat painted ground), the sky follows the
 * Sun at Sky time, and "Back to map" restores the previous camera, inputs,
 * clock and scene flags exactly.
 *
 * P1 scope: observer, camera, horizon, sky brightness, `sv` URL. Stars,
 * planets and satellites are later cards and draw into the same overlay.
 */
import * as Cesium from 'cesium';
import { observerSolarElevation } from '../../data/satellitePass.js';
import { geocodeKeyless } from '../../keylessGeocoder.js';
import {
  computeHorizonProfile,
  occlusion as profileOcclusion,
} from './horizonProfile.js';
import {
  accuracyText,
  createGeolocator,
  createObserver,
  parseLatLon,
  sampleGroundHeight,
} from './observer.js';
import { drawOverlay, overlayModel } from './overlay.js';
import {
  applySkyCamera,
  applySkyScene,
  applySkyTime,
  restoreCamera,
  restoreScene,
  snapshotCamera,
  snapshotScene,
} from './skyCamera.js';
import { createSkyClock } from './skyClock.js';
import {
  dragView,
  inertiaStep,
  keyView,
  limMag,
  makeView,
  pinchView,
  skyBoxVisible,
  twilightPhase,
  wheelZoomFactor,
  zoomView,
} from './skyMath.js';
import { readSkyUrl, writeSkyUrl } from './skyUrl.js';

const mounted = new WeakMap();
const PHASE_TEXT = {
  day: 'Day',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
  unknown: '',
};
/** A pick this far from the ellipsoid is a streaming-tile glitch, not ground. */
const PLAUSIBLE_GROUND_M = [-500, 9000];

const fmt = (value, digits) => Number(value).toFixed(digits);

/** Observer + view caption for the status line. */
export function describeObserver(observer, { sunAltDeg = null } = {}) {
  if (!observer) return '';
  const lat = `${fmt(Math.abs(observer.latDeg), 4)}° ${observer.latDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${fmt(Math.abs(observer.lonDeg), 4)}° ${observer.lonDeg >= 0 ? 'E' : 'W'}`;
  const ground = observer.heightKnown
    ? `ground ${Math.round(observer.groundHeightM)} m`
    : 'ground height unknown (0 m used)';
  const parts = [`${lat} ${lon}`, ground];
  const accuracy = accuracyText(observer.accuracyM);
  if (accuracy) parts.push(accuracy);
  if (Number.isFinite(sunAltDeg)) {
    const phase = PHASE_TEXT[twilightPhase(sunAltDeg)];
    parts.push(`Sun ${fmt(sunAltDeg, 1)}° (${phase})`);
  }
  return parts.join(' · ');
}

/** `datetime-local` value in the browser's zone for a UTC instant. */
export function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildDom(doc) {
  const button = el(
    doc,
    'button',
    {
      type: 'button',
      className: 'gev-sky-btn',
      'data-sky': 'open',
      'aria-label': 'Sky view: look up from a point',
      'aria-expanded': 'false',
      title: 'Sky view: look up from a point',
    },
    'Sky',
  );

  const panel = el(doc, 'div', {
    className: 'gev-sky-panel',
    role: 'dialog',
    'aria-label': 'Sky view',
    'data-sky': 'panel',
  });
  panel.hidden = true;
  const title = el(
    doc,
    'div',
    { className: 'gev-sky-title' },
    'Sky view: where do you stand?',
  );
  const pick = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'pick' },
    'Pick on map',
  );
  const here = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'here' },
    'Screen centre',
  );
  const gps = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'gps' },
    'Use my location',
  );
  const form = el(doc, 'form', {
    className: 'gev-sky-form',
    'data-sky': 'form',
  });
  const input = el(doc, 'input', {
    type: 'text',
    'data-sky': 'query',
    placeholder: 'lat, lon or a place',
    'aria-label': 'Latitude, longitude or place name',
    autocomplete: 'off',
  });
  const go = el(doc, 'button', { type: 'submit', 'data-sky': 'go' }, 'Go');
  form.append(input, go);
  const close = el(
    doc,
    'button',
    {
      type: 'button',
      className: 'gev-sky-close',
      'data-sky': 'close',
      'aria-label': 'Close',
    },
    '×',
  );
  const row = el(doc, 'div', { className: 'gev-sky-row' });
  row.append(pick, here, gps);
  const status = el(doc, 'div', {
    className: 'gev-sky-status',
    'data-sky': 'status',
    role: 'status',
    'aria-live': 'polite',
  });
  panel.append(close, title, row, form, status);

  const bar = el(doc, 'div', {
    className: 'gev-sky-bar',
    role: 'toolbar',
    'aria-label': 'Sky view controls',
    'data-sky': 'bar',
  });
  bar.hidden = true;
  const back = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'back' },
    'Back to map',
  );
  const move = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'move' },
    'Move',
  );
  const flat = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'flat', 'aria-pressed': 'false' },
    'Flat horizon',
  );
  const grid = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'grid', 'aria-pressed': 'false' },
    'Grid',
  );
  const live = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'live', 'aria-pressed': 'true' },
    'Live',
  );
  const time = el(doc, 'input', {
    type: 'datetime-local',
    'data-sky': 'time',
    'aria-label': 'Sky time (your browser time zone)',
  });
  const eyeLabel = el(doc, 'label', { className: 'gev-sky-eye' }, 'Eye m ');
  const eye = el(doc, 'input', {
    type: 'number',
    'data-sky': 'eye',
    min: '0',
    max: '9999',
    step: '0.1',
    value: '1.7',
    'aria-label': 'Eye height above the ground, metres',
  });
  eyeLabel.append(eye);
  const info = el(doc, 'div', {
    className: 'gev-sky-info',
    'data-sky': 'info',
    role: 'status',
    'aria-live': 'polite',
  });
  bar.append(back, move, flat, grid, live, time, eyeLabel, info);

  const canvas = el(doc, 'canvas', {
    className: 'gev-sky-canvas',
    'data-sky': 'canvas',
    tabindex: '0',
    'aria-label':
      'Sky. Drag to look around, wheel or pinch to zoom, arrows and +/- keys, N north, Z zenith',
  });
  canvas.hidden = true;
  return {
    button,
    panel,
    input,
    form,
    status,
    bar,
    info,
    canvas,
    time,
    eye,
    buttons: { pick, here, gps, close, back, move, flat, grid, live, go },
  };
}

/**
 * Mount once per viewer; returns the existing handle on a second call.
 * Never throws for a missing browser environment (returns null).
 */
export function mountSkyView({
  viewer,
  document: doc = globalThis.document,
  parent,
  lifetime,
  runNavigation = (_noun, navigate) => navigate(),
  showToast = () => {},
  geolocation = globalThis.navigator?.geolocation,
  isSecureContext = globalThis.isSecureContext,
  location = globalThis.location,
  history = globalThis.history,
  geocode = (query) => geocodeKeyless(query),
  timers = globalThis,
  now = () => Date.now(),
  CesiumApi = Cesium,
  autoEnterDelayMs = 2500,
} = {}) {
  if (!viewer?.camera || !viewer?.scene || !doc?.createElement) return null;
  const existing = mounted.get(viewer);
  if (existing && !existing.destroyed) return existing;
  const host = parent || doc.body;
  if (!host) return null;

  const dom = buildDom(doc);
  host.append(dom.button, dom.panel, dom.bar);
  const canvasHost = viewer.container || host;
  canvasHost.append(dom.canvas);

  const removers = [];
  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };

  const clock = createSkyClock({ now });
  let active = false;
  let observer = null;
  let view = makeView();
  let flags = { flatHorizon: false, grid: false };
  let cameraSnap = null;
  let sceneSnap = null;
  let profile = null;
  let profileToken = 0;
  let picker = null;
  let tickTimer = null;
  let urlTimer = null;
  let autoTimer = null;
  let inertiaFrame = null;
  let destroyed = false;
  const pointers = new Map();
  let pinch = null;
  let lastSunAlt = null;

  const setStatus = (text) => {
    dom.status.textContent = text || '';
  };
  const setPressed = (button, on) =>
    button.setAttribute('aria-pressed', on ? 'true' : 'false');

  const geolocator = createGeolocator({
    geolocation,
    isSecureContext,
    onChange: async (state, message) => {
      setStatus(message);
      if (state.status !== 'ready') return;
      const { latDeg, lonDeg, accuracyM } = state.coords;
      await enterAt({ latDeg, lonDeg, source: 'gps', accuracyM });
    },
  });

  // ── rendering ────────────────────────────────────────────────────────────
  const canvasSize = () => {
    const c = viewer.scene.canvas;
    return {
      width: c?.clientWidth || c?.width || 1,
      height: c?.clientHeight || c?.height || 1,
    };
  };

  function redraw() {
    if (!active) return;
    const { width, height } = canvasSize();
    const ratio = globalThis.devicePixelRatio || 1;
    if (dom.canvas.width !== Math.round(width * ratio))
      dom.canvas.width = Math.round(width * ratio);
    if (dom.canvas.height !== Math.round(height * ratio))
      dom.canvas.height = Math.round(height * ratio);
    const ctx = dom.canvas.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    const model = overlayModel({
      view,
      width,
      height,
      grid: flags.grid,
      flatHorizon: flags.flatHorizon,
      sunAltDeg: lastSunAlt,
    });
    drawOverlay(ctx, model, { width, height });
  }

  function applyTime() {
    if (!active || !observer) return;
    const t = clock.getTime();
    applySkyTime(CesiumApi, viewer, t);
    lastSunAlt = observerSolarElevation(observer.latDeg, observer.lonDeg, t);
    applySkyScene(viewer, sceneSnap, {
      flatHorizon: flags.flatHorizon,
      skyBox: skyBoxVisible(lastSunAlt),
    });
    if (clock.mode === 'live') dom.time.value = toLocalInputValue(t);
    const lim = limMag(lastSunAlt);
    dom.info.textContent = `${describeObserver(observer, { sunAltDeg: lastSunAlt })} · faintest drawn mag ${fmt(lim, 1)}`;
    redraw();
  }

  function applyView(next) {
    view = makeView(next);
    if (!active || !observer) return;
    applySkyCamera(CesiumApi, viewer.camera, observer, view);
    viewer.scene.requestRender?.();
    redraw();
    scheduleUrl();
  }

  function scheduleUrl() {
    if (!location?.href || !history?.replaceState) return;
    timers.clearTimeout?.(urlTimer);
    urlTimer = timers.setTimeout?.(() => {
      urlTimer = null;
      writeUrlNow();
    }, 400);
  }
  function writeUrlNow() {
    if (!location?.href || !history?.replaceState) return;
    const state =
      active && observer
        ? {
            latDeg: observer.latDeg,
            lonDeg: observer.lonDeg,
            view,
            timeMs: clock.mode === 'fixed' ? clock.getTime() : null,
            flags,
          }
        : null;
    const href = writeSkyUrl(location.href, state);
    if (href !== location.href) history.replaceState(history.state, '', href);
  }

  // ── entering and leaving ─────────────────────────────────────────────────
  async function enterAt({
    latDeg,
    lonDeg,
    source,
    accuracyM = null,
    heightM,
    heightKnown,
  }) {
    let ground = { heightM: heightM ?? 0, known: Boolean(heightKnown) };
    if (!ground.known) {
      setStatus('Reading the ground height...');
      const sampled = await sampleGroundHeight({
        Cesium: CesiumApi,
        viewer,
        latDeg,
        lonDeg,
      });
      ground = { heightM: sampled.heightM, known: sampled.known };
    }
    if (destroyed) return false;
    const next = createObserver({
      latDeg,
      lonDeg,
      groundHeightM: ground.heightM,
      heightKnown: ground.known,
      eyeHeightM: Number(dom.eye.value),
      source,
      accuracyM,
    });
    if (!next) {
      setStatus('That point is not a valid latitude/longitude.');
      return false;
    }
    return enter(next);
  }

  function enter(next) {
    let entered = false;
    runNavigation('sky view', () => {
      if (!active) {
        cameraSnap = snapshotCamera(CesiumApi, viewer.camera);
        sceneSnap = snapshotScene(CesiumApi, viewer, { nowMs: now() });
      }
      observer = next;
      active = true;
      entered = true;
      dom.canvas.hidden = false;
      dom.bar.hidden = false;
      dom.panel.hidden = true;
      dom.button.setAttribute('aria-expanded', 'false');
      doc.body?.classList?.add('gev-sky-active');
      applyTime();
      applyView(view);
      startTicking();
      refreshProfile();
      dom.canvas.focus?.();
    });
    if (!entered) setStatus('Sky view is not available in this mode.');
    return entered;
  }

  /**
   * Leave the sky. `keepCamera` is for when another navigation (a search,
   * a fly-to) already took the camera: put the scene back but do not fight it.
   */
  function exit({ keepCamera = false } = {}) {
    if (!active) return;
    active = false;
    stopTicking();
    cancelInertia();
    if (!keepCamera) restoreCamera(CesiumApi, viewer.camera, cameraSnap);
    restoreScene(CesiumApi, viewer, sceneSnap, { nowMs: now() });
    cameraSnap = null;
    sceneSnap = null;
    profile = null;
    profileToken += 1;
    pointers.clear();
    pinch = null;
    dom.canvas.hidden = true;
    dom.bar.hidden = true;
    doc.body?.classList?.remove('gev-sky-active');
    timers.clearTimeout?.(urlTimer);
    urlTimer = null;
    writeUrlNow();
    viewer.scene.requestRender?.();
  }

  async function refreshProfile() {
    const token = ++profileToken;
    profile = null;
    const result = await computeHorizonProfile({
      Cesium: CesiumApi,
      terrainProvider:
        viewer.terrainProvider ?? viewer.scene.globe?.terrainProvider,
      observer,
    });
    if (token === profileToken && active) {
      profile = result;
      redraw();
    }
  }

  function startTicking() {
    stopTicking();
    tickTimer = timers.setInterval?.(() => {
      if (cameraTakenElsewhere()) {
        exit({ keepCamera: true });
        return;
      }
      if (clock.mode === 'live') applyTime();
    }, 1000);
  }
  /** True when something else (search, fly-to, voice) moved the camera away. */
  function cameraTakenElsewhere() {
    if (!observer) return false;
    const eye = CesiumApi.Cartesian3.fromDegrees(
      observer.lonDeg,
      observer.latDeg,
      observer.groundHeightM + observer.eyeHeightM,
    );
    const at = viewer.camera.positionWC ?? viewer.camera.position;
    return CesiumApi.Cartesian3.distance(eye, at) > 100;
  }
  function stopTicking() {
    if (tickTimer != null) timers.clearInterval?.(tickTimer);
    tickTimer = null;
  }

  // ── picking on the map ───────────────────────────────────────────────────
  function pickAt(position) {
    const scene = viewer.scene;
    let cartesian;
    let known = false;
    if (
      scene.pickPositionSupported &&
      typeof scene.pickPosition === 'function'
    ) {
      try {
        cartesian = scene.pickPosition(position);
        known = Boolean(cartesian);
      } catch {
        cartesian = undefined;
      }
    }
    let carto = cartesian
      ? CesiumApi.Cartographic.fromCartesian(cartesian)
      : undefined;
    if (
      carto &&
      !(
        carto.height > PLAUSIBLE_GROUND_M[0] &&
        carto.height < PLAUSIBLE_GROUND_M[1]
      )
    ) {
      carto = undefined;
      known = false;
    }
    if (!carto) {
      const ellipsoidPoint = viewer.camera.pickEllipsoid?.(position);
      carto = ellipsoidPoint
        ? CesiumApi.Cartographic.fromCartesian(ellipsoidPoint)
        : undefined;
      known = false;
    }
    if (!carto) return null;
    return {
      latDeg: CesiumApi.Math.toDegrees(carto.latitude),
      lonDeg: CesiumApi.Math.toDegrees(carto.longitude),
      heightM: known ? carto.height : 0,
      heightKnown: known,
    };
  }

  function stopPicking() {
    picker?.destroy?.();
    picker = null;
    doc.body?.classList?.remove('gev-sky-picking');
  }

  function startPicking() {
    stopPicking();
    if (!CesiumApi.ScreenSpaceEventHandler || !viewer.scene.canvas) {
      setStatus('Map picking is not available here.');
      return;
    }
    picker = new CesiumApi.ScreenSpaceEventHandler(viewer.scene.canvas);
    doc.body?.classList?.add('gev-sky-picking');
    setStatus('Click a point on the globe to stand there (Esc cancels).');
    picker.setInputAction((event) => {
      const hit = pickAt(event.position);
      stopPicking();
      if (!hit) {
        setStatus('No ground under that point. Try again on the globe.');
        return;
      }
      enterAt({ ...hit, source: 'map' });
    }, CesiumApi.ScreenSpaceEventType.LEFT_CLICK);
  }

  function screenCentre() {
    const { width, height } = canvasSize();
    const hit = pickAt(new CesiumApi.Cartesian2(width / 2, height / 2));
    if (!hit) {
      setStatus(
        'No ground at the screen centre. Pick a point on the map instead.',
      );
      return;
    }
    enterAt({ ...hit, source: 'map' });
  }

  async function submitQuery() {
    const text = String(dom.input.value || '').trim();
    if (!text) return;
    const parsed = parseLatLon(text);
    if (parsed) {
      await enterAt({ ...parsed, source: 'manual' });
      return;
    }
    setStatus(`Searching for "${text}"...`);
    let place = null;
    try {
      place = await geocode(text);
    } catch {
      place = null;
    }
    if (destroyed) return;
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
      setStatus(`No place found for "${text}". Try "lat, lon".`);
      return;
    }
    await enterAt({ latDeg: place.lat, lonDeg: place.lng, source: 'manual' });
  }

  // ── looking around ───────────────────────────────────────────────────────
  function cancelInertia() {
    if (inertiaFrame != null) globalThis.cancelAnimationFrame?.(inertiaFrame);
    inertiaFrame = null;
  }
  function startInertia(velocity) {
    cancelInertia();
    if (!globalThis.requestAnimationFrame) return;
    let v = velocity;
    let last = now();
    const step = () => {
      const t = now();
      const s = inertiaStep(v, t - last);
      last = t;
      v = s.velocity;
      applyView({
        ...view,
        azDeg: view.azDeg + s.dAz,
        elDeg: view.elDeg + s.dEl,
      });
      inertiaFrame =
        Math.abs(v.az) + Math.abs(v.el) > 1e-4
          ? globalThis.requestAnimationFrame(step)
          : null;
    };
    inertiaFrame = globalThis.requestAnimationFrame(step);
  }

  const distance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function onPointerDown(event) {
    if (!active) return;
    cancelInertia();
    dom.canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      t: now(),
      vAz: 0,
      vEl: 0,
    });
    if (pointers.size === 2) pinch = { distance: distance(), view };
  }
  function onPointerMove(event) {
    const p = pointers.get(event.pointerId);
    if (!active || !p) return;
    if (pointers.size >= 2) {
      p.x = event.clientX;
      p.y = event.clientY;
      if (pinch)
        applyView(pinchView(view, pinch.view, pinch.distance, distance()));
      return;
    }
    const { width, height } = canvasSize();
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    const before = view;
    applyView(dragView(view, dx, dy, width, height));
    const t = now();
    const dt = Math.max(1, t - p.t);
    let dAz = view.azDeg - before.azDeg;
    if (dAz > 180) dAz -= 360;
    if (dAz < -180) dAz += 360;
    p.vAz = dAz / dt;
    p.vEl = (view.elDeg - before.elDeg) / dt;
    p.x = event.clientX;
    p.y = event.clientY;
    p.t = t;
  }
  function onPointerUp(event) {
    const p = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!active || !p || pointers.size) return;
    if (now() - p.t < 80 && Math.abs(p.vAz) + Math.abs(p.vEl) > 0.005)
      startInertia({ az: p.vAz, el: p.vEl });
  }
  function onWheel(event) {
    if (!active) return;
    event.preventDefault?.();
    applyView(zoomView(view, wheelZoomFactor(event.deltaY)));
  }
  function onKey(event) {
    if (!active) return;
    if (event.key === 'Escape') {
      exit();
      return;
    }
    const next = keyView(view, event.key);
    if (next) {
      event.preventDefault?.();
      applyView(next);
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  const togglePanel = (open = dom.panel.hidden) => {
    dom.panel.hidden = !open;
    dom.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) stopPicking();
  };
  listen(dom.button, 'click', () => {
    if (active) exit();
    else togglePanel();
  });
  listen(dom.buttons.close, 'click', () => togglePanel(false));
  listen(dom.buttons.pick, 'click', () => startPicking());
  listen(dom.buttons.here, 'click', () => screenCentre());
  listen(dom.buttons.gps, 'click', () => geolocator.request());
  listen(dom.form, 'submit', (event) => {
    event.preventDefault?.();
    submitQuery();
  });
  listen(dom.buttons.back, 'click', () => exit());
  listen(dom.buttons.move, 'click', () => {
    exit();
    togglePanel(true);
    startPicking();
  });
  listen(dom.buttons.flat, 'click', () => {
    flags = { ...flags, flatHorizon: !flags.flatHorizon };
    setPressed(dom.buttons.flat, flags.flatHorizon);
    applyTime();
    scheduleUrl();
  });
  listen(dom.buttons.grid, 'click', () => {
    flags = { ...flags, grid: !flags.grid };
    setPressed(dom.buttons.grid, flags.grid);
    redraw();
    scheduleUrl();
  });
  listen(dom.buttons.live, 'click', () => {
    clock.setLive();
    setPressed(dom.buttons.live, true);
    applyTime();
    scheduleUrl();
  });
  listen(dom.time, 'change', () => {
    const ms = new Date(dom.time.value).getTime();
    if (clock.setFixed(ms)) {
      setPressed(dom.buttons.live, false);
      applyTime();
      scheduleUrl();
    }
  });
  listen(dom.eye, 'change', () => {
    if (!observer) return;
    observer =
      createObserver({ ...observer, eyeHeightM: Number(dom.eye.value) }) ||
      observer;
    dom.eye.value = String(observer.eyeHeightM);
    applyView(view);
    refreshProfile();
  });
  listen(dom.canvas, 'pointerdown', onPointerDown);
  listen(dom.canvas, 'pointermove', onPointerMove);
  listen(dom.canvas, 'pointerup', onPointerUp);
  listen(dom.canvas, 'pointercancel', onPointerUp);
  listen(dom.canvas, 'wheel', onWheel, { passive: false });
  listen(dom.canvas, 'keydown', onKey);
  listen(doc, 'keydown', (event) => {
    if (event.key === 'Escape' && picker) {
      stopPicking();
      setStatus('');
    }
  });
  listen(globalThis.window, 'resize', () => redraw());

  // Hidden while the camera follows an entity (CSS hides it in cockpit,
  // playback, recording and clean-view modes, like the nav control).
  const syncFollowing = () => {
    const following = Boolean(viewer.trackedEntity);
    dom.button.hidden = following && !active;
    if (following) togglePanel(false);
  };
  const removeTracked =
    viewer.trackedEntityChanged?.addEventListener?.(syncFollowing);
  if (typeof removeTracked === 'function') removers.push(removeTracked);
  syncFollowing();

  // A shared `sv` link opens straight into the sky once startup settles.
  const fromUrl = location?.href ? readSkyUrl(location.href) : null;
  if (fromUrl) {
    view = fromUrl.view;
    flags = { ...flags, ...fromUrl.flags };
    setPressed(dom.buttons.flat, flags.flatHorizon);
    setPressed(dom.buttons.grid, flags.grid);
    if (Number.isFinite(fromUrl.timeMs)) {
      clock.setFixed(fromUrl.timeMs);
      setPressed(dom.buttons.live, false);
      dom.time.value = toLocalInputValue(fromUrl.timeMs);
    }
    autoTimer = timers.setTimeout?.(() => {
      autoTimer = null;
      enterAt({
        latDeg: fromUrl.latDeg,
        lonDeg: fromUrl.lonDeg,
        source: 'url',
      });
    }, autoEnterDelayMs);
  }

  const handle = {
    get destroyed() {
      return destroyed;
    },
    get active() {
      return active;
    },
    get observer() {
      return observer;
    },
    get view() {
      return view;
    },
    get flags() {
      return { ...flags };
    },
    get profile() {
      return profile;
    },
    get clock() {
      return clock;
    },
    get geolocator() {
      return geolocator;
    },
    elements: dom,
    enterAt,
    exit: () => exit(),
    setView: (next) => applyView({ ...view, ...next }),
    redraw,
    /** 'clear' | 'terrain' | 'below' for a sky direction (P2/P3 use this). */
    occlusion: (azDeg, elDeg) => profileOcclusion(profile, azDeg, elDeg),
    destroy() {
      if (destroyed) return;
      exit();
      stopPicking();
      destroyed = true;
      timers.clearTimeout?.(autoTimer);
      timers.clearTimeout?.(urlTimer);
      for (const remove of removers.splice(0)) remove();
      dom.button.remove?.();
      dom.panel.remove?.();
      dom.bar.remove?.();
      dom.canvas.remove?.();
      mounted.delete(viewer);
    },
  };
  mounted.set(viewer, handle);
  lifetime?.removers?.add?.(() => handle.destroy());
  return handle;
}

/**
 * The one call the application shell makes (beside its nav control mount):
 * wires the shell's viewer, lifetime, navigation policy and toast.
 */
export function mountSkyViewForShell(shell) {
  return mountSkyView({
    viewer: shell.viewer,
    lifetime: shell._lifetime,
    runNavigation: (noun, navigate) =>
      shell._navigation?.runOrientation
        ? shell._navigation.runOrientation(noun, navigate)
        : navigate(),
    showToast: (message) => shell._showToast?.(message),
  });
}
