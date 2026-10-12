/**
 * Sky view (byrdit fork, SKYVIEW.md): a "Sky" button next to the map
 * navigation control. Pick a point on the globe, use the browser location,
 * or type "lat, lon" / a place; the camera drops to eye height there and
 * looks UP. Drag/pinch/wheel/keys look around (zoom = field of view), the
 * horizon is the real terrain (or a flat painted ground), the sky follows the
 * Sun at Sky time, and "Back to map" restores the previous camera, inputs,
 * clock and scene flags exactly.
 *
 * P1 scope: observer, camera, horizon, sky brightness, `sv` URL.
 * P2a: satellites above the horizon (module worker, states, labels, the
 * "Overhead now" panel, element-age rules) drawn into the same overlay.
 * P3b: stars, constellations, Sun/Moon/planets, layer switches and search
 * live in skyContent.js and draw into the same overlay after the P1 pass.
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
  cardinalBoxes,
  createSkyContent,
  overlayPixelRatio,
  PERF_SAMPLES,
} from './skyContent.js';
import {
  applySkyCamera,
  applySkyScene,
  applySkyTime,
  restoreCamera,
  restoreScene,
  snapshotCamera,
  snapshotScene,
} from './skyCamera.js';
import { createSatSky } from './satSky.js';
import {
  drawSatellites,
  geoBeltPoints,
  hitTest,
  lookAtView,
  satelliteModel,
} from './satOverlay.js';
import {
  ageBanner,
  buildSatPanel,
  cardData,
  listIndexFromTarget,
  overheadList,
  renderSatPanel,
} from './satPanel.js';
import { SKY_CLASSES } from './satCore.js';
import { createSkyClock } from './skyClock.js';
import {
  clampEl,
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
import { satelliteSearchProvider } from './skySearch.js';
import { DEFAULT_SKY_FLAGS, readSkyUrl, writeSkyUrl } from './skyUrl.js';

const mounted = new WeakMap();
const PHASE_TEXT = {
  day: 'Day',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
  unknown: '',
};
/** Satellite redraw cap while objects move (frames per second). */
const SAT_FPS = 15;
const LOOK_AT_MS = 600;
/** A press that moves less than this and ends sooner than CLICK_MS is a click. */
const CLICK_PX = 5;
const CLICK_MS = 400;
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
  createSatWorker,
  fetchCelestrak,
  reducedMotion = () =>
    Boolean(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
    ),
  requestFrame = (fn) => globalThis.requestAnimationFrame?.(fn) ?? null,
  cancelFrame = (id) => globalThis.cancelAnimationFrame?.(id),
  /** Test/harness overrides for createSkyContent (data loaders, frames). */
  skyContentOptions = {},
} = {}) {
  if (!viewer?.camera || !viewer?.scene || !doc?.createElement) return null;
  const existing = mounted.get(viewer);
  if (existing && !existing.destroyed) return existing;
  const host = parent || doc.body;
  if (!host) return null;

  const dom = buildDom(doc);
  const satDom = buildSatPanel(doc);
  host.append(dom.button, dom.panel, dom.bar, satDom.root);
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
  let flags = { ...DEFAULT_SKY_FLAGS };
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
  // satellites (P2a)
  const classesOn = new Set(SKY_CLASSES);
  let geoBelt = false;
  let beltPoints = null;
  let selectedIndex = null;
  let satModel = null;
  let satFrame = null;
  let satFrameAt = 0;
  let lookFrame = null;
  let press = null;
  const satSky = createSatSky({
    ...(createSatWorker ? { createWorker: createSatWorker } : {}),
    ...(fetchCelestrak ? { fetchText: fetchCelestrak } : {}),
    timers,
    getTime: () => clock.getTime(),
    onChange: (what) => {
      if (!active) return;
      updateSatPanel();
      if (what === 'tick' && satFrame == null) redraw();
      if (what === 'tick') startSatAnimation();
    },
  });
  /** Satellite objects of the last paint (P2a extrapolated az/el). */
  let satObjects = null;
  const satellitePosition = (id) => {
    const drawn = satObjects?.find((o) => o.index === id);
    if (drawn) return { azDeg: drawn.azDeg, elDeg: drawn.elDeg };
    const row = satSky.lookup(id)?.row;
    return row ? { azDeg: row.azDeg, elDeg: row.elDeg } : null;
  };
  const content = createSkyContent({
    doc,
    getView: () => view,
    applyView: (next) => applyView(next),
    requestRedraw: () => redraw(),
    // `next` holds only the switches that changed (never the whole copy)
    onFlagsChange: (next) => {
      flags = { ...flags, ...next };
      setPressed(dom.buttons.flat, flags.flatHorizon);
      setPressed(dom.buttons.grid, flags.grid);
      redraw();
      scheduleUrl();
    },
    now,
    // search finds satellites by name in the P2a engine; the marker uses
    // the az/el the satellite overlay draws (extrapolated between ticks)
    satellites: satelliteSearchProvider(satSky, {
      positionOf: (id) => satellitePosition(id),
    }),
    ...skyContentOptions,
  });
  if (content.root) host.append(content.root);

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
  // Reading clientWidth/clientHeight forces a synchronous layout whenever
  // anything else (HUD text, URL chip) dirtied the page since the last frame;
  // on the throttled mid-phone profile that was the largest single cost of a
  // redraw. The size is cached and dropped on resize (window event and a
  // ResizeObserver on the globe canvas) and on every entry into the sky.
  let sizeCache = null;
  const canvasSize = () => {
    if (sizeCache) return sizeCache;
    const c = viewer.scene.canvas;
    const size = {
      width: c?.clientWidth || c?.width || 1,
      height: c?.clientHeight || c?.height || 1,
    };
    // a hidden or not-yet-laid-out canvas reports 0: measure again next time
    if (c?.clientWidth > 0 && c?.clientHeight > 0) sizeCache = size;
    return size;
  };
  const dropSize = () => {
    sizeCache = null;
  };

  // Whole overlay redraw timings (P1 horizon/grid/compass + P3b content):
  // the SKYVIEW.md section 8 budget metric ("overlay redraw p95").
  const redrawPerf = [];
  const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

  function redraw() {
    if (!active) return;
    const t0 = perfNow();
    paint();
    redrawPerf.push(perfNow() - t0);
    if (redrawPerf.length > PERF_SAMPLES) redrawPerf.shift();
  }

  function paint() {
    const { width, height } = canvasSize();
    const ratio = overlayPixelRatio(globalThis.devicePixelRatio);
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
    satObjects = satSky.running ? satSky.objectsAt(clock.getTime()) : null;
    content.draw(ctx, {
      view,
      width,
      height,
      sunAltDeg: lastSunAlt,
      occlusion: (azDeg, elDeg) => profileOcclusion(profile, azDeg, elDeg),
      reserved: cardinalBoxes(model.cardinals),
      ratio,
    });
    if (satSky.running) {
      satModel = satelliteModel({
        objects: satObjects,
        view,
        width,
        height,
        occlusion: (az, elDeg) => profileOcclusion(profile, az, elDeg),
        classesOn,
        selectedIndex,
        geoBelt: geoBelt ? beltPoints : null,
        insets: arrowInsets(width, height),
      });
      drawSatellites(ctx, satModel);
    } else satModel = null;
  }

  // ── satellites ───────────────────────────────────────────────────────────
  /**
   * Narrow layouts (skyView.css, max-width 900px) size the satellite panel
   * from the toolbar's real bottom edge, because the toolbar wraps to a
   * different height at every width: --gev-sky-bar-bottom on the panel.
   */
  function syncSkyLayout() {
    if (dom.bar.hidden) return;
    const bar = dom.bar.getBoundingClientRect?.();
    if (!bar || !(bar.height > 0)) return;
    satDom.root.style?.setProperty?.(
      '--gev-sky-bar-bottom',
      `${Math.ceil(bar.bottom)}px`,
    );
  }

  /** Scroll the panel so the newly selected object's card is in view. */
  function revealCard() {
    const { body, card } = satDom;
    if (card.hidden || body.hidden || typeof body.scrollTop !== 'number')
      return;
    const b = body.getBoundingClientRect?.();
    const c = card.getBoundingClientRect?.();
    if (!b || !c) return;
    if (c.bottom > b.bottom)
      body.scrollTop += Math.min(c.bottom - b.bottom, c.top - b.top);
    else if (c.top < b.top) body.scrollTop -= b.top - c.top;
  }

  /** Keep the edge arrow clear of the satellite panel and the toolbar. */
  function arrowInsets(width, height) {
    const pad = 28;
    const insets = {};
    const panel = satDom.root.hidden
      ? null
      : satDom.root.getBoundingClientRect?.();
    if (panel && panel.width > 0 && panel.left < width / 2)
      insets.left = panel.right + pad;
    const bar = dom.bar.hidden ? null : dom.bar.getBoundingClientRect?.();
    if (bar && bar.height > 0 && bar.top < height / 2)
      insets.top = bar.bottom + pad;
    return insets;
  }

  function updateSatPanel() {
    if (!active) return;
    const t = clock.getTime();
    const objects = satSky.objectsAt(t);
    const occlusion = (az, elDeg) => profileOcclusion(profile, az, elDeg);
    const stats = satSky.stats;
    const loads = satSky.loads;
    let statusText = '';
    if (satSky.status === 'unavailable')
      statusText =
        'Satellites need Web Workers, which this browser does not offer.';
    else if (satSky.status === 'loading') statusText = 'Loading satellites...';
    if (loads.get('active') === 'error')
      statusText =
        `${statusText} All-active list unavailable; showing the core groups.`.trim();
    renderSatPanel(satDom, {
      doc,
      list: overheadList(objects, { classesOn, occlusion }),
      banner: ageBanner(stats.age, t),
      card:
        selectedIndex == null
          ? null
          : cardData(satSky.lookup(selectedIndex), t),
      status: satSky.status,
      statusText,
      selectedIndex,
    });
  }

  /** Redraw at <= SAT_FPS while satellites move (extrapolated between ticks). */
  function startSatAnimation() {
    if (satFrame != null || !active || !satSky.running) return;
    const step = () => {
      satFrame = null;
      if (!active || !satSky.running) return;
      const t = now();
      if (t - satFrameAt >= 1000 / SAT_FPS) {
        satFrameAt = t;
        redraw();
      }
      if (clock.mode === 'live') satFrame = requestFrame(step);
    };
    satFrame = requestFrame(step);
  }
  function stopSatAnimation() {
    if (satFrame != null) cancelFrame(satFrame);
    satFrame = null;
  }

  function cancelLook() {
    if (lookFrame != null) cancelFrame(lookFrame);
    lookFrame = null;
  }
  /** Animated look-at (instant with reduced motion). */
  function lookAtSatellite(index) {
    const row = satSky.lookup(index)?.row;
    if (!row || !(row.elDeg > 0)) return false;
    cancelLook();
    cancelInertia();
    const target = { azDeg: row.azDeg, elDeg: clampEl(row.elDeg) };
    if (reducedMotion()) {
      applyView({ ...view, ...target });
      return true;
    }
    const from = view;
    const started = now();
    const step = () => {
      lookFrame = null;
      if (!active) return;
      const f = Math.min(1, (now() - started) / LOOK_AT_MS);
      applyView(lookAtView(from, target, f));
      if (f < 1) lookFrame = requestFrame(step);
    };
    lookFrame = requestFrame(step);
    if (lookFrame == null) applyView({ ...view, ...target });
    return true;
  }
  function selectSatellite(index, { look = false } = {}) {
    const previous = selectedIndex;
    selectedIndex = Number.isInteger(index) ? index : null;
    updateSatPanel();
    if (selectedIndex != null && selectedIndex !== previous) revealCard();
    redraw();
    if (look && selectedIndex != null) lookAtSatellite(selectedIndex);
  }

  function applyTime() {
    if (!active || !observer) return;
    const t = clock.getTime();
    applySkyTime(CesiumApi, viewer, t);
    lastSunAlt = observerSolarElevation(observer.latDeg, observer.lonDeg, t);
    content.update(t, observer);
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
      dropSize();
      dom.canvas.hidden = false;
      dom.bar.hidden = false;
      dom.panel.hidden = true;
      dom.button.setAttribute('aria-expanded', 'false');
      doc.body?.classList?.add('gev-sky-active');
      content.start(observer, clock.getTime());
      applyTime();
      applyView(view);
      startTicking();
      refreshProfile();
      satDom.root.hidden = false;
      syncSkyLayout();
      beltPoints = geoBeltPoints(observer.latDeg, observer.lonDeg);
      satSky.start(observer);
      updateSatPanel();
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
    content.stop();
    cancelLook();
    stopSatAnimation();
    satSky.stop();
    satModel = null;
    satObjects = null;
    selectedIndex = null;
    press = null;
    satDom.root.hidden = true;
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

  function canvasPoint(event) {
    const rect = dom.canvas.getBoundingClientRect?.();
    return {
      x: event.clientX - (rect?.left || 0),
      y: event.clientY - (rect?.top || 0),
    };
  }
  function onPointerDown(event) {
    if (!active) return;
    cancelInertia();
    cancelLook();
    press =
      pointers.size === 0
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, t: now() }
        : null;
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
    if (
      active &&
      press &&
      press.id === event.pointerId &&
      event.type !== 'pointercancel' &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) < CLICK_PX &&
      now() - press.t < CLICK_MS
    ) {
      press = null;
      const { x, y } = canvasPoint(event);
      const hit = hitTest(satModel, x, y);
      if (hit != null || selectedIndex != null) selectSatellite(hit);
      return;
    }
    press = null;
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
    content.setFlags({ flatHorizon: flags.flatHorizon });
    applyTime();
    scheduleUrl();
  });
  listen(dom.buttons.grid, 'click', () => {
    flags = { ...flags, grid: !flags.grid };
    setPressed(dom.buttons.grid, flags.grid);
    content.setFlags({ grid: flags.grid });
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
  // satellite panel
  listen(satDom.fold, 'click', () => {
    const open = satDom.body.hidden;
    satDom.body.hidden = !open;
    satDom.fold.setAttribute('aria-expanded', open ? 'true' : 'false');
    satDom.fold.textContent = open ? '–' : '+';
  });
  for (const [klass, chip] of Object.entries(satDom.chips)) {
    listen(chip, 'click', () => {
      if (classesOn.has(klass)) classesOn.delete(klass);
      else classesOn.add(klass);
      setPressed(chip, classesOn.has(klass));
      updateSatPanel();
      redraw();
    });
  }
  listen(satDom.active, 'click', () => {
    const on = !satSky.sets.active;
    setPressed(satDom.active, on);
    satSky.setSets({ active: on });
  });
  listen(satDom.starlink, 'click', () => {
    const on = !satSky.sets.starlink;
    setPressed(satDom.starlink, on);
    satSky.setSets({ starlink: on });
  });
  listen(satDom.belt, 'click', () => {
    geoBelt = !geoBelt;
    setPressed(satDom.belt, geoBelt);
    redraw();
  });
  listen(satDom.list, 'click', (event) => {
    const index = listIndexFromTarget(
      satDom.list,
      event.target,
      satSky.meta.length,
    );
    if (index != null) selectSatellite(index, { look: true });
  });
  listen(satDom.look, 'click', () => {
    if (selectedIndex != null) lookAtSatellite(selectedIndex);
  });
  listen(satDom.clear, 'click', () => selectSatellite(null));
  clock.subscribe(() => {
    if (active) satSky.timeChanged();
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
  listen(globalThis.window, 'resize', () => {
    dropSize();
    syncSkyLayout();
    redraw();
  });
  if (typeof globalThis.ResizeObserver === 'function') {
    // The toolbar also changes height when its info line rewraps.
    const barObserver = new globalThis.ResizeObserver(() => syncSkyLayout());
    barObserver.observe(dom.bar);
    removers.push(() => barObserver.disconnect());
    if (viewer.scene.canvas) {
      const resizeObserver = new globalThis.ResizeObserver(() => {
        dropSize();
        if (active) redraw();
      });
      resizeObserver.observe(viewer.scene.canvas);
      removers.push(() => resizeObserver.disconnect());
    }
  }

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
    content.setFlags(flags);
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
    /** Stars, constellations, bodies, layers and search (P3b). */
    get content() {
      return content;
    },
    /** Satellites controller (stats, objects, sets) and the last drawn model. */
    get satellites() {
      return satSky;
    },
    get satelliteModel() {
      return satModel;
    },
    get selectedSatellite() {
      return selectedIndex;
    },
    selectSatellite: (index, options) => selectSatellite(index, options),
    lookAtSatellite: (index) => lookAtSatellite(index),
    satelliteElements: satDom,
    elements: dom,
    enterAt,
    exit: () => exit(),
    setView: (next) => applyView({ ...view, ...next }),
    redraw,
    /** Overlay redraw timings (ms): count, p50, p95, max. */
    redrawPerf() {
      const sorted = [...redrawPerf].sort((a, b) => a - b);
      const at = (q) =>
        sorted.length
          ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
          : NaN;
      return {
        count: sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? NaN,
      };
    },
    resetRedrawPerf() {
      redrawPerf.length = 0;
    },
    /** 'clear' | 'terrain' | 'below' for a sky direction (P2/P3 use this). */
    occlusion: (azDeg, elDeg) => profileOcclusion(profile, azDeg, elDeg),
    destroy() {
      if (destroyed) return;
      exit();
      stopPicking();
      content.destroy();
      destroyed = true;
      timers.clearTimeout?.(autoTimer);
      timers.clearTimeout?.(urlTimer);
      for (const remove of removers.splice(0)) remove();
      dom.button.remove?.();
      dom.panel.remove?.();
      dom.bar.remove?.();
      satDom.root.remove?.();
      dom.canvas.remove?.();
      mounted.delete(viewer);
    },
  };
  mounted.set(viewer, handle);
  lifetime?.removers?.add?.(() => handle.destroy());
  return handle;
}

/** The mounted Sky view for a viewer (QA harnesses and later cards). */
export function skyViewFor(viewer) {
  const handle = viewer ? mounted.get(viewer) : null;
  return handle && !handle.destroyed ? handle : null;
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
