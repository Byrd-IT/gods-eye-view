/**
 * The Drone Flight Plan tool: DISPLAY > Drone Flight Plan opens a right-rail
 * card where you draw a box on the globe, set the camera/flight options and
 * download DJI Fly waypoint-mission KMZ files. Plans are built in the browser;
 * nothing is stored or sent anywhere (terrain heights come from the terrain
 * the globe already loads).
 *
 * Ownership follows Draw and Recent Imagery: the box drag and the takeoff pick
 * each claim the pointer for their session, borrow the viewer's own click
 * actions, and give everything back; Escape cancels; destroy() returns it all.
 */
import * as Cesium from 'cesium';
import { formatNumber, t } from '../../i18n/index.js';
import { initImageryBoxTool } from '../../ui/imageryBoxTool.js';
import { createSlider } from '../../ui/slider.js';
import { assembleAreaPlan, distanceToAreasM, planAreas } from './areas.js';
import { initPolygonTool } from './polygonTool.js';
import { validateDroneBox } from './limits.js';
import { initPointTool } from './pointTool.js';
import { createDronePlanPreview, passStyle } from './preview.js';
import { sampleGround } from './terrain.js';
import {
  AGL_CAP_M,
  FT_PER_M,
  MAX_TAKEOFF_FROM_BOX_M,
  MIN_AGL_M,
  takeoffDistanceFromBoxM,
} from './planner.js';
import {
  DEFAULT_PRESET_ID,
  getPreset,
  kmzStatus,
  listPresets,
} from './presets.js';
import { MODES, modeFor, recommend, recommendedOptions } from './recommend.js';
import {
  DEFAULT_SHUTTER_DENOMINATOR,
  MIN_PLAN_SPEED_MS,
  SHUTTER_DENOMINATORS,
} from './speed.js';
import { buildBundleZip, buildKmz, kmzFileName } from './wpml.js';
import { buildSuiteZip, suiteOptions } from './suite.js';
import {
  distanceText,
  durationText,
  heightText,
  planErrorText,
  warningText,
} from './format.js';

export const PANEL_ID = 'drone-plan-panel';
export const BODY_ID = 'drone-plan-panel-body';
export const ENTRY_ID = 'drone-plan-button';
const BOX_OWNER = 'drone-plan-box';
const REPLAN_DELAY_MS = 160;
const MAX_TERRAIN_CACHE = 30000;

const el = (doc, tag, parent, { text, cls, attrs } = {}) => {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};
const num = (v, d = 0) =>
  formatNumber(v, { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Wire the Drone Flight Plan tool. Returns null when the page has no card.
 * @param {{ viewer: object, cesium?: object, document?: Document,
 *   downloadFile?: (name: string, bytes: Uint8Array, type: string) => void }} deps
 */
export function initDronePlan({
  viewer,
  cesium = Cesium,
  document: doc = globalThis.document,
  downloadFile = browserDownload,
} = {}) {
  const panel = doc?.getElementById?.(PANEL_ID);
  const body = doc?.getElementById?.(BODY_ID);
  if (!viewer?.scene || !panel || !body) return null;
  const entry = doc.getElementById(ENTRY_ID);

  const state = {
    box: null,
    areas: [],
    jobGrouping: 'per-area',
    nextArea: 1,
    takeoff: null,
    options: {
      presetId: DEFAULT_PRESET_ID,
      aglM: 80,
      frontOverlap: 80,
      sideOverlap: 70,
      pattern: 'grid',
      direction: 'auto',
      tiltPitchDeg: -60,
      speedMs: getPreset(DEFAULT_PRESET_ID).defaultSpeedMs,
      photoMode: 'waypoint',
      shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
      batteryMin: 25,
      orbitRadiusM: null,
      orbitHeightsM: null,
    },
    wpml: { droneEnumValue: null, droneSubEnumValue: null },
    result: null,
    suite: null,
    suiteHidden: new Set(),
    suiteBusy: false,
    error: null,
    busy: false,
    open: false,
    ack: false,
    dirty: false,
  };
  const terrainCache = new Map();
  let cachedProvider = null;
  let planToken = 0;
  let suiteToken = 0;
  // Bumps only when a new plan is committed, not when the panel is merely
  // ready. A fast replan can be ready again before the first poll, so the
  // QA script waits for this number instead of waiting for "ready" to leave.
  let planNonce = 0;
  let reading = false;
  let timer = null;
  let destroyed = false;

  const preview = createDronePlanPreview({ viewer, cesium });
  const ui = {};

  // ---------------------------------------------------------------- tools --
  const status = (text, tone = '') => {
    ui.status.textContent = text;
    ui.status.dataset.tone = tone;
  };
  const boxTool = initImageryBoxTool({
    viewer,
    cesium,
    owner: BOX_OWNER,
    previewName: 'gev-drone-plan-box-preview',
    bodyClass: 'gev-drone-box',
    validate: validateDroneBox,
    shorterArc: true,
    onBox: (box) => {
      addRect(box, { replace: false });
    },
    onCancel: (reason, message) => {
      if (message) status(message, 'warn');
      else if (reason === 'escape') status(t('Box drawing cancelled'));
    },
    onActive: (active) => {
      ui.drawButton.setAttribute('aria-pressed', String(active));
      if (active) status(t('Press on the ground and drag a box'), 'info');
    },
  });
  const takeoffTool = initPointTool({
    viewer,
    cesium,
    onPoint: (point) => acceptTakeoff(point),
    onCancel: (reason) => {
      if (reason === 'sky')
        status(t('Click on the ground, not the sky'), 'warn');
      else if (reason === 'escape') status(t('Takeoff pick cancelled'));
      else if (reason === 'pointer-busy')
        status(t('Another tool is using the pointer. Close it first'), 'warn');
    },
    onActive: (active) => {
      ui.takeoffButton.setAttribute('aria-pressed', String(active));
      if (active) status(t('Click the ground where you will take off'), 'info');
    },
  });

  function areaId() {
    const id = `area-${state.nextArea}`;
    state.nextArea += 1;
    return id;
  }

  function showCommitted() {
    const onlyRect = state.areas.length === 1 && state.areas[0].kind === 'rect';
    if (onlyRect) {
      preview.showBox(state.areas[0].box);
      preview.showAreas(null);
    } else {
      preview.showBox(null);
      preview.showAreas(state.areas);
    }
  }

  function addRect(box, { replace = false, clearTakeoff = replace } = {}) {
    const id = replace ? 'area-1' : areaId();
    const area = {
      id,
      name: replace ? 'Area 1' : `Area ${id.slice('area-'.length)}`,
      kind: 'rect',
      box,
    };
    if (replace) {
      state.nextArea = 2;
      state.areas = [area];
    } else {
      state.areas.push(area);
    }
    state.box = box;
    if (clearTakeoff) state.takeoff = null;
    else if (
      state.takeoff &&
      distanceToAreasM(state.areas, state.takeoff) > MAX_TAKEOFF_FROM_BOX_M
    ) {
      state.takeoff = null;
    }
    showCommitted();
    status('');
    schedule(0);
    return true;
  }

  function addPolygon(ring) {
    const probe = planAreas(
      [{ id: 'probe', name: 'probe', kind: 'polygon', ring }],
      state.options,
    );
    if (probe.error) {
      status(probe.message || planErrorText(probe.error), 'warn');
      return false;
    }
    const id = areaId();
    state.areas.push({
      id,
      name: `Area ${id.slice('area-'.length)}`,
      kind: 'polygon',
      ring,
      box: probe.box,
    });
    state.box = probe.box;
    showCommitted();
    status('');
    schedule(0);
    return true;
  }

  const polygonTool = initPolygonTool({
    viewer,
    cesium,
    documentRef: doc,
    onRing: (ring) => addPolygon(ring),
    onCancel: (reason) => {
      if (reason === 'escape') status(t('Polygon drawing cancelled'));
      else if (reason === 'sky')
        status(t('Click on the ground, not the sky'), 'warn');
      else if (reason === 'pointer-busy')
        status(t('Another tool is using the pointer. Close it first'), 'warn');
    },
    onActive: (active) => {
      ui.polygonButton?.setAttribute('aria-pressed', String(active));
      if (active) {
        status(
          t(
            'Click corners on the ground. Double-click or click the first corner to close. Esc cancels. Backspace removes the last corner.',
          ),
          'info',
        );
      }
    },
  });

  // ------------------------------------------------------------- planning --
  function schedule(delay = REPLAN_DELAY_MS) {
    // The plan on screen is out of date from this moment: no file may come
    // from it while the new one is waiting to be built.
    state.dirty = true;
    render();
    clearTimeout(timer);
    timer = setTimeout(replan, delay);
  }

  /** Take a picked takeoff point, or say why not (too far from the box). */
  function acceptTakeoff(point) {
    const away = state.areas.length
      ? distanceToAreasM(state.areas, point)
      : state.box
        ? takeoffDistanceFromBoxM(state.box, point)
        : 0;
    if (away > MAX_TAKEOFF_FROM_BOX_M) {
      status(
        warningText({
          code: 'takeoff-too-far',
          params: {
            distanceM: Math.round(away),
            limitM: MAX_TAKEOFF_FROM_BOX_M,
          },
        }),
        'warn',
      );
      return false;
    }
    state.takeoff = point;
    status('');
    schedule(0);
    return true;
  }

  // The globe shows the all-passes plan when there is one, otherwise the
  // single plan: a suite replaces the single plan while it exists.
  function syncGlobe() {
    if (state.suite) {
      preview.showPlan(null);
      preview.showSuite(state.suite.passes, state.suiteHidden);
    } else {
      preview.showSuite(null);
      preview.showPlan(state.result);
    }
  }

  async function replan() {
    if (destroyed) return;
    // A voice call waits for this plan. Drop the pending timer so it cannot
    // start a second plan and discard the one the caller is waiting on.
    clearTimeout(timer);
    const token = ++planToken;
    state.dirty = false;
    // Any change to the areas or settings makes the all-passes plan stale.
    suiteToken += 1;
    const hadSuite = Boolean(state.suite);
    state.suite = null;
    state.suiteBusy = false;
    if (hadSuite) syncGlobe();
    if (!state.areas.length) {
      state.result = null;
      state.error = null;
      state.busy = false;
      preview.showPlan(null);
      render();
      return;
    }
    state.ack = false;
    const options = {
      ...state.options,
      takeoff: state.takeoff,
      jobGrouping: state.jobGrouping,
    };
    const plan = planAreas(state.areas, options);
    if (plan.error) {
      state.result = null;
      state.error = plan.error;
      state.busy = false;
      preview.showPlan(null);
      render();
      return;
    }
    state.busy = true;
    render();
    // Bounded: a long session of plans must not grow the cache for ever. It
    // also belongs to one terrain provider: a different one means different
    // heights, so nothing read from the old one is reused.
    const provider =
      viewer.terrainProvider ?? viewer.scene?.globe?.terrainProvider;
    if (terrainCache.size > MAX_TERRAIN_CACHE || provider !== cachedProvider) {
      terrainCache.clear();
    }
    cachedProvider = provider;
    const points = plan.legs.flatMap((leg) => leg.waypoints);
    const ground = await sampleGround({
      viewer,
      cesium,
      points,
      takeoff: plan.takeoff,
      cache: terrainCache,
    });
    if (destroyed || token !== planToken) return;
    // wpM is indexed by waypoint id, which is the order points were listed in.
    const byId = [];
    points.forEach((w, i) => {
      byId[w.id] = ground.wpM[i];
    });
    state.result = assembleAreaPlan(plan, { ...ground, wpM: byId });
    state.error = null;
    state.busy = false;
    planNonce += 1;
    panel.dataset.planNonce = String(planNonce);
    preview.showPlan(state.result);
    render();
  }

  // ------------------------------------------------------------------ UI --
  function build() {
    body.replaceChildren();
    body.classList.add('gev-dp-body');
    const bar = el(doc, 'div', body, { cls: 'gev-dp-bar' });
    ui.bar = bar;
    ui.drawButton = el(doc, 'button', bar, {
      cls: 'data-toggle-chip',
      text: t('DRAW BOX'),
      attrs: {
        type: 'button',
        'data-action': 'draw-box',
        'aria-pressed': 'false',
        title: t('Drag a box over the area to map'),
      },
    });
    ui.closeButton = el(doc, 'button', bar, {
      cls: 'data-toggle-chip',
      text: t('CLOSE'),
      attrs: {
        type: 'button',
        'data-action': 'close',
        title: t('Close the Drone Flight Plan and clear it from the globe'),
      },
    });
    ui.polygonButton = el(doc, 'button', bar, {
      cls: 'data-toggle-chip',
      text: t('DRAW POLYGON'),
      attrs: {
        type: 'button',
        'data-action': 'draw-polygon',
        'aria-pressed': 'false',
        title: t(
          'Click corners on the ground. Double-click or click the first corner to close. Esc cancels. Backspace removes the last corner.',
        ),
      },
    });
    ui.status = el(doc, 'p', body, {
      cls: 'gev-dp-status',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    ui.areas = el(doc, 'div', body, { cls: 'gev-dp-areas' });

    const field = (label, control, { value } = {}) => {
      const row = el(doc, 'label', body, { cls: 'gev-dp-row' });
      el(doc, 'span', row, { cls: 'gev-dp-label', text: label });
      const wrap = el(doc, 'span', row, { cls: 'gev-dp-control' });
      wrap.append(control);
      let out = null;
      if (value !== false)
        out = el(doc, 'output', wrap, { cls: 'gev-slider-value' });
      return { row, out };
    };
    const select = (items, label) => {
      const s = el(doc, 'select', null, {
        cls: 'pp-select gev-field gev-field--compact',
        attrs: { 'aria-label': label },
      });
      for (const [value, text] of items) {
        el(doc, 'option', s, { text, attrs: { value } });
      }
      return s;
    };
    const slider = (label, min, max, step) =>
      createSlider({ documentRef: doc, min, max, step, ariaLabel: label });

    ui.preset = select(
      listPresets().map((p) => [p.id, p.name]),
      t('Aircraft'),
    );
    field(t('Aircraft'), ui.preset, { value: false });
    ui.presetInfo = el(doc, 'p', body, {
      cls: 'gev-dp-note gev-dp-preset-info',
      attrs: { 'data-role': 'preset-info' },
    });
    ui.mode = select(
      MODES.map((m) => [m, modeLabel(m)]),
      t('Mode'),
    );
    field(t('Mode'), ui.mode, { value: false });
    ui.useRecommended = el(doc, 'button', body, {
      cls: 'data-toggle-chip gev-dp-recommend',
      text: t('USE RECOMMENDED'),
      attrs: {
        type: 'button',
        'data-action': 'use-recommended',
        title: t(
          'Set speed, height, overlap and shutter to the recommended values for this aircraft and mode',
        ),
      },
    });
    ui.suiteButton = el(doc, 'button', body, {
      cls: 'data-toggle-chip gev-dp-suite-button',
      text: t('PLAN ALL RECOMMENDED PASSES'),
      attrs: {
        type: 'button',
        'data-action': 'plan-suite',
        title: t(
          'Plan every recommended capture pass for a Gaussian splat over your areas at once: nadir grid, two oblique grids and orbits',
        ),
      },
    });
    ui.suiteButton.disabled = true;
    ui.suite = el(doc, 'div', body, {
      cls: 'gev-dp-missions gev-dp-suite',
      attrs: { 'data-role': 'suite' },
    });
    ui.recommended = el(doc, 'dl', body, {
      cls: 'gev-dp-stats gev-dp-recommended',
      attrs: { 'data-role': 'recommended' },
    });

    ui.agl = slider(t('Height above ground'), MIN_AGL_M, AGL_CAP_M, 5);
    ({ row: ui.aglRow, out: ui.aglOut } = field(
      t('Height above ground'),
      ui.agl,
    ));
    ui.front = slider(t('Front overlap'), 50, 95, 1);
    ({ out: ui.frontOut } = field(t('Front overlap'), ui.front));
    ui.side = slider(t('Side overlap'), 40, 95, 1);
    ({ out: ui.sideOut } = field(t('Side overlap'), ui.side));

    ui.pattern = select(
      [
        ['grid', t('Grid, straight down')],
        ['double', t('Double grid, tilted')],
        ['orbit', t('Orbit the centre')],
      ],
      t('Pattern'),
    );
    field(t('Pattern'), ui.pattern, { value: false });
    ui.jobs = select(
      [
        ['per-area', t('One job per area')],
        ['whole', t('One job for the whole plan')],
      ],
      t('Processing jobs'),
    );
    field(t('Processing jobs'), ui.jobs, { value: false });
    ui.jobNote = el(doc, 'p', body, { cls: 'gev-dp-note gev-dp-job-note' });
    ui.direction = select(
      [
        ['auto', t('Along the long side')],
        ['ew', t('East to west')],
        ['ns', t('North to south')],
      ],
      t('Flight direction'),
    );
    ({ row: ui.directionRow } = field(t('Flight direction'), ui.direction, {
      value: false,
    }));
    ui.tilt = slider(t('Camera tilt'), -80, -45, 5);
    ({ row: ui.tiltRow, out: ui.tiltOut } = field(t('Camera tilt'), ui.tilt));
    ui.radius = slider(t('Orbit radius'), 10, 300, 5);
    ({ row: ui.radiusRow, out: ui.radiusOut } = field(
      t('Orbit radius'),
      ui.radius,
    ));
    ui.rings = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': t('Orbit heights'),
        placeholder: '40, 80',
      },
    });
    ({ row: ui.ringsRow } = field(t('Orbit heights (m)'), ui.rings, {
      value: false,
    }));

    ui.photoMode = select(
      [
        ['waypoint', t('At every waypoint')],
        ['interval', t('By distance, fewer waypoints')],
      ],
      t('Photos'),
    );
    ({ row: ui.photoRow } = field(t('Photos'), ui.photoMode, { value: false }));
    ui.speed = slider(t('Speed'), MIN_PLAN_SPEED_MS, 15, 0.1);
    ({ out: ui.speedOut } = field(t('Speed'), ui.speed));
    ui.shutter = select(
      SHUTTER_DENOMINATORS.map((n) => [String(n), `1/${n} s`]),
      t('Shutter speed'),
    );
    field(t('Shutter speed'), ui.shutter, { value: false });
    ui.battery = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'number',
        min: '5',
        max: '60',
        step: '1',
        'aria-label': t('Usable flight time per battery (minutes)'),
      },
    });
    field(t('Battery (min)'), ui.battery, { value: false });

    const takeoffRow = el(doc, 'div', body, { cls: 'gev-dp-row' });
    el(doc, 'span', takeoffRow, { cls: 'gev-dp-label', text: t('Takeoff') });
    const takeoffWrap = el(doc, 'span', takeoffRow, {
      cls: 'gev-dp-control gev-dp-takeoff',
    });
    ui.takeoffButton = el(doc, 'button', takeoffWrap, {
      cls: 'data-toggle-chip',
      text: t('SET'),
      attrs: {
        type: 'button',
        'aria-pressed': 'false',
        title: t('Click the globe to place the takeoff point'),
      },
    });
    ui.takeoffReset = el(doc, 'button', takeoffWrap, {
      cls: 'data-toggle-chip',
      text: t('BOX CENTRE'),
      attrs: {
        type: 'button',
        title: t('Take off from the middle of the box'),
      },
    });
    ui.takeoffText = el(doc, 'output', takeoffWrap, {
      cls: 'gev-slider-value gev-dp-coords',
    });

    const advanced = el(doc, 'details', body, { cls: 'gev-dp-advanced' });
    el(doc, 'summary', advanced, { text: t('DJI model code') });
    ui.enum = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'number',
        min: '0',
        max: '999',
        step: '1',
        'aria-label': t('DJI aircraft code in the mission file'),
      },
    });
    const enumRow = el(doc, 'label', advanced, { cls: 'gev-dp-row' });
    el(doc, 'span', enumRow, { cls: 'gev-dp-label', text: t('Aircraft code') });
    el(doc, 'span', enumRow, { cls: 'gev-dp-control' }).append(ui.enum);
    ui.enumNote = el(doc, 'p', advanced, {
      cls: 'gev-dp-note',
      text: t(
        'Taken from the community-checked DJI Fly value for this aircraft. If DJI Fly refuses a file, compare with one DJI Fly made and change it here.',
      ),
    });

    ui.stats = el(doc, 'dl', body, { cls: 'gev-dp-stats' });
    ui.warnings = el(doc, 'ul', body, { cls: 'gev-dp-warnings' });
    ui.missions = el(doc, 'div', body, { cls: 'gev-dp-missions' });
    ui.note = el(doc, 'p', body, {
      cls: 'gev-dp-note',
      text: t(
        'NOT FLIGHT-TESTED: check airspace and local rules, keep the aircraft in sight, and fly the first mission short and supervised.',
      ),
    });

    // The answer comes first: stats, warnings and downloads sit right under
    // the status line, so they stay in view while the options scroll below.
    ui.status.after(ui.areas, ui.stats, ui.warnings, ui.missions);

    // ------------------------------------------------------ wiring --
    const o = state.options;
    const onInput = (control, apply) =>
      control.addEventListener('input', () => {
        apply();
        syncControls();
        schedule();
      });
    ui.preset.addEventListener('change', () => {
      o.presetId = ui.preset.value;
      o.speedMs = getPreset(o.presetId).defaultSpeedMs;
      state.wpml = { droneEnumValue: null, droneSubEnumValue: null };
      syncControls();
      schedule();
    });
    ui.mode.addEventListener('change', () => {
      // Picking a mode only selects the pattern and photo mode; the values
      // change when the person presses USE RECOMMENDED.
      // A pattern that already belongs to the chosen mode (for example
      // `double` in Mapping grid) is kept.
      if (modeFor(o) !== ui.mode.value) {
        const next = recommend(getPreset(o.presetId), ui.mode.value);
        o.pattern = next.pattern;
        o.photoMode = next.photoMode;
      }
      syncControls();
      schedule();
    });
    ui.shutter.addEventListener('change', () => {
      o.shutterDenominator = Number(ui.shutter.value);
      syncControls();
      schedule();
    });
    ui.suiteButton.addEventListener('click', () => planSuite());
    ui.useRecommended.addEventListener('click', () => {
      useRecommended();
    });
    onInput(ui.agl, () => (o.aglM = Number(ui.agl.value)));
    onInput(ui.front, () => (o.frontOverlap = Number(ui.front.value)));
    onInput(ui.side, () => (o.sideOverlap = Number(ui.side.value)));
    ui.pattern.addEventListener('change', () => {
      o.pattern = ui.pattern.value;
      syncControls();
      schedule();
    });
    ui.jobs.addEventListener('change', () => {
      state.jobGrouping = ui.jobs.value === 'whole' ? 'whole' : 'per-area';
      schedule();
    });
    ui.direction.addEventListener('change', () => {
      o.direction = ui.direction.value;
      schedule();
    });
    onInput(ui.tilt, () => (o.tiltPitchDeg = Number(ui.tilt.value)));
    onInput(ui.radius, () => (o.orbitRadiusM = Number(ui.radius.value)));
    ui.rings.addEventListener('change', () => {
      const list = ui.rings.value
        .split(/[\s,;]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      o.orbitHeightsM = list.length ? list : null;
      syncControls();
      schedule();
    });
    ui.photoMode.addEventListener('change', () => {
      o.photoMode = ui.photoMode.value;
      schedule();
    });
    onInput(ui.speed, () => (o.speedMs = Number(ui.speed.value)));
    ui.battery.addEventListener('change', () => {
      o.batteryMin = Number(ui.battery.value) || 25;
      syncControls();
      schedule();
    });
    ui.enum.addEventListener('change', () => {
      // An empty or non-integer field goes back to the preset's own code.
      const raw = ui.enum.value.trim();
      const v = raw === '' ? null : Number(raw);
      state.wpml.droneEnumValue =
        Number.isInteger(v) && v >= 0 && v <= 999 ? v : null;
      // The KMZ buttons and the reason text depend on the code: redraw them.
      if (state.result) render();
      else syncControls();
    });
    ui.drawButton.addEventListener('click', () => drawBox());
    ui.polygonButton.addEventListener('click', () => drawPolygon());
    ui.closeButton.addEventListener('click', () => close());
    ui.takeoffButton.addEventListener('click', () => {
      startTakeoffPick();
    });
    ui.takeoffReset.addEventListener('click', () => {
      clearTakeoff();
    });
  }

  function modeLabel(mode) {
    switch (mode) {
      case 'splat-orbit':
        return t('Splat orbit');
      case 'fast-survey':
        return t('Fast survey');
      default:
        return t('Mapping grid');
    }
  }

  function presetSummary(preset) {
    const facts = [
      preset.sensorText,
      t('{shutter} shutter', { shutter: preset.shutterType }),
      t('photo every {s} s at best', { s: num(preset.minPhotoIntervalS) }),
      t('up to {v} m/s', { v: num(preset.maxSpeedMs) }),
      t('app: {app}', { app: preset.app }),
      t('data: {v}', { v: preset.verified }),
    ];
    return facts.join(' · ');
  }

  function renderRecommended(preset, mode) {
    const rec = recommend(preset, mode, {
      orbitRadiusM:
        state.options.orbitRadiusM ??
        state.result?.plan?.options?.orbitRadiusM ??
        undefined,
    });
    ui.recommended.replaceChildren();
    const row = (label, value) => {
      el(doc, 'dt', ui.recommended, { text: label });
      el(doc, 'dd', ui.recommended, { text: value });
    };
    row(t('Speed'), `${num(rec.speedMs, 1)} m/s`);
    if (rec.pattern !== 'orbit') row(t('Height'), heightText(rec.aglM));
    else row(t('Orbit heights (m)'), rec.orbitHeightsM.join(', '));
    row(
      t('Overlap'),
      rec.sideOverlap === null
        ? `${num(rec.frontOverlap)}%`
        : `${num(rec.frontOverlap)}% / ${num(rec.sideOverlap)}%`,
    );
    row(
      t('Gimbal'),
      rec.gimbalPitchDeg === null
        ? t('on the centre')
        : `${num(rec.gimbalPitchDeg)}°`,
    );
    row(
      t('Camera'),
      t(
        '1/{n} s or faster, ISO {lo}-{hi}, locked white balance and focus, {format}',
        {
          n: num(rec.camera.minShutterDenominator),
          lo: num(rec.camera.isoRange[0]),
          hi: num(rec.camera.isoRange[1]),
          format: rec.camera.format,
        },
      ),
    );
  }

  function syncControls() {
    const o = state.options;
    const preset = getPreset(o.presetId);
    ui.preset.value = o.presetId;
    ui.mode.value = modeFor(o);
    ui.shutter.value = String(o.shutterDenominator);
    ui.presetInfo.textContent = presetSummary(preset);
    renderRecommended(preset, modeFor(o));
    ui.agl.value = String(o.aglM);
    ui.aglOut.textContent = heightText(Math.min(o.aglM, AGL_CAP_M));
    ui.aglRow.title = t('Hard cap {m} m / {ft} ft above ground', {
      m: num(AGL_CAP_M),
      ft: num(AGL_CAP_M * FT_PER_M),
    });
    ui.front.value = String(o.frontOverlap);
    ui.frontOut.textContent = `${num(o.frontOverlap)}%`;
    ui.side.value = String(o.sideOverlap);
    ui.sideOut.textContent = `${num(o.sideOverlap)}%`;
    ui.pattern.value = o.pattern;
    ui.direction.value = String(o.direction);
    ui.tilt.value = String(o.tiltPitchDeg);
    ui.tiltOut.textContent = `${num(o.tiltPitchDeg)}°`;
    const radius =
      o.orbitRadiusM ?? state.result?.plan?.options?.orbitRadiusM ?? 40;
    ui.radius.value = String(radius);
    ui.radiusOut.textContent = `${num(radius)} m`;
    ui.rings.value = (o.orbitHeightsM ?? []).join(', ');
    ui.photoMode.value = o.photoMode;
    ui.speed.value = String(o.speedMs);
    ui.speedOut.textContent = `${num(o.speedMs, 1)} m/s`;
    ui.battery.value = String(o.batteryMin);
    ui.enum.value = String(
      state.wpml.droneEnumValue ?? preset.wpml?.droneEnumValue ?? '',
    );
    const orbit = o.pattern === 'orbit';
    ui.directionRow.hidden = orbit;
    // An orbit shoots by the ring's own spacing: the photo-mode choice only
    // applies to the grid patterns.
    ui.photoRow.hidden = orbit;
    ui.tiltRow.hidden = o.pattern !== 'double';
    ui.radiusRow.hidden = !orbit;
    ui.ringsRow.hidden = !orbit;
    const t0 = state.result?.plan?.takeoff ?? state.takeoff;
    const where = state.takeoff ? '' : ` · ${t('centre')}`;
    ui.takeoffText.textContent = t0
      ? `${num(t0.lat, 5)}, ${num(t0.lon, 5)}${where}`
      : '';
    ui.takeoffReset.disabled = !state.takeoff;
    ui.jobs.value = state.jobGrouping;
    const jobNote = orbit
      ? t(
          'Orbit stays on the centre of each area. It is not merged with other areas.',
        )
      : state.jobGrouping === 'whole'
        ? t(
            'Overlapping areas are flown once. All flights are one processing job.',
          )
        : t(
            'Overlapping areas are flown once. Each area is its own processing job. Overlap photos stay in the first area only.',
          );
    ui.jobNote.textContent = jobNote;
    renderAreas();
  }

  function renderAreas() {
    ui.areas.replaceChildren();
    if (!state.areas.length) return;
    const heading = el(doc, 'p', ui.areas, { cls: 'gev-dp-areas-label' });
    heading.textContent = t('Areas');
    for (const area of state.areas) {
      const row = el(doc, 'div', ui.areas, {
        cls: 'gev-dp-area',
        attrs: { 'data-area': area.id },
      });
      const name = el(doc, 'input', row, {
        attrs: {
          type: 'text',
          value: area.name,
          'aria-label': t('Area name'),
          maxlength: '40',
        },
      });
      name.addEventListener('change', () => {
        const next = name.value.trim();
        area.name = next || area.name;
        name.value = area.name;
        schedule();
      });
      const kind = el(doc, 'span', row, { cls: 'gev-dp-area-kind' });
      kind.textContent =
        area.kind === 'polygon' ? t('Polygon') : t('Rectangle');
      const remove = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('Remove'),
        attrs: { type: 'button', 'data-remove-area': area.id },
      });
      remove.addEventListener('click', () => {
        removeArea(area.id);
      });
    }
  }

  const stat = (label, value) => {
    el(doc, 'dt', ui.stats, { text: label });
    el(doc, 'dd', ui.stats, { text: value });
  };

  function render() {
    syncControls();
    ui.stats.replaceChildren();
    ui.warnings.replaceChildren();
    ui.missions.replaceChildren();
    renderSuite();
    panel.dataset.state = state.busy ? 'busy' : state.result ? 'ready' : 'idle';
    if (state.error) {
      status(planErrorText(state.error), 'warn');
    } else if (state.busy) {
      status(t('Reading terrain heights'), 'info');
      reading = true;
    } else if (
      !state.areas.length &&
      !boxTool?.isActive() &&
      !polygonTool?.isActive()
    ) {
      status(t('Draw a box over the area to map'), 'info');
    } else if (reading) {
      // The "reading terrain" line must not outlive the reading.
      status('');
    }
    if (!state.busy) reading = false;
    const result = state.result;
    if (!result) return;
    const { totals, missions, warnings, plan } = result;
    stat(t('Photos'), num(totals.photoCount));
    stat(t('Ground detail'), `${num(totals.gsdCm, 2)} cm/px`);
    stat(t('Route'), distanceText(totals.distanceM));
    stat(t('Flight time'), durationText(totals.durationS));
    stat(t('Missions'), num(totals.missionCount));
    if (result.areaStats?.length > 1) {
      for (const area of result.areaStats) {
        if (area.shared) continue;
        stat(
          area.name,
          t('{photos} photos, {time}', {
            photos: num(area.photoCount),
            time: durationText(area.durationS),
          }),
        );
      }
    }
    stat(t('Waypoints'), missions.map((m) => num(m.waypointCount)).join(' / '));
    stat(t('Speed'), `${num(plan.speedMs, 1)} m/s`);
    stat(
      t('Terrain range'),
      result.ground.known ? `${num(totals.terrainRangeM)} m` : t('unknown'),
    );
    for (const w of warnings) {
      const text = warningText(w);
      if (text)
        el(doc, 'li', ui.warnings, { text, attrs: { 'data-code': w.code } });
    }
    const kmz = kmzOk();
    if (!kmz.ok) {
      el(doc, 'li', ui.warnings, {
        text: kmzReasonText(kmz.reason),
        attrs: { 'data-code': 'kmz-unavailable' },
      });
    }
    const list = ui.missions;
    const when = new Date();
    missions.forEach((m, i) => {
      const row = el(doc, 'div', list, { cls: 'gev-dp-mission' });
      el(doc, 'span', row, {
        cls: 'gev-dp-mission-label',
        text:
          t('Mission {n}: {wp} waypoints, {photos} photos, {time}', {
            n: num(i + 1),
            wp: num(m.waypointCount),
            photos: num(m.photoCount),
            time: durationText(m.durationS),
          }) + (m.jobName && result.jobs?.length > 1 ? ` · ${m.jobName}` : ''),
      });
      const button = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('KMZ'),
        attrs: {
          type: 'button',
          'data-mission': String(i),
          title: t('Download mission {n} as a DJI Fly KMZ', { n: num(i + 1) }),
        },
      });
      button.disabled = !downloadsAllowed();
      button.addEventListener('click', () => downloadMission(i, when));
    });
    const all = el(doc, 'button', list, {
      cls: 'data-toggle-chip gev-dp-all',
      text: t('DOWNLOAD ALL (.ZIP)'),
      attrs: {
        type: 'button',
        'data-download': 'all',
        title: t('Every mission plus a README in one zip'),
      },
    });
    all.disabled = !downloadsAllowed();
    all.addEventListener('click', () => downloadAll(when));
    if (!result.terrainComplete) {
      // Heights that were not read from the terrain can put the aircraft far
      // above the ground, so the files stay locked until the person says they
      // will check them, or the terrain is read again.
      const lock = el(doc, 'div', list, { cls: 'gev-dp-lock' });
      const label = el(doc, 'label', lock, { cls: 'gev-dp-ack' });
      const box = el(doc, 'input', label, {
        attrs: { type: 'checkbox', 'data-ack': 'terrain' },
      });
      box.checked = state.ack;
      el(doc, 'span', label, {
        text: t('Download anyway: I will check the heights myself'),
      });
      box.addEventListener('change', () => {
        state.ack = Boolean(box.checked);
        render();
      });
      const again = el(doc, 'button', lock, {
        cls: 'data-toggle-chip',
        text: t('READ TERRAIN AGAIN'),
        attrs: {
          type: 'button',
          'data-retry': 'terrain',
          title: t('Read the terrain heights again'),
        },
      });
      again.addEventListener('click', () => schedule(0));
    }
    if (result.truncated)
      status(t('Too many missions to download safely'), 'warn');
  }

  async function planSuite() {
    if (
      destroyed ||
      !state.areas.length ||
      state.suiteBusy ||
      state.busy ||
      state.dirty
    )
      return;
    const token = ++suiteToken;
    state.suiteBusy = true;
    state.suite = null;
    syncGlobe();
    render();
    const provider =
      viewer.terrainProvider ?? viewer.scene?.globe?.terrainProvider;
    if (terrainCache.size > MAX_TERRAIN_CACHE || provider !== cachedProvider) {
      terrainCache.clear();
    }
    cachedProvider = provider;
    const passes = [];
    try {
      for (const pass of suiteOptions(state.options)) {
        const plan = planAreas(state.areas, {
          ...pass.options,
          takeoff: state.takeoff,
          jobGrouping: state.jobGrouping,
        });
        if (plan.error) {
          passes.push({
            id: pass.id,
            label: pass.label,
            result: null,
            error: plan.error,
          });
          continue;
        }
        const points = plan.legs.flatMap((leg) => leg.waypoints);
        const ground = await sampleGround({
          viewer,
          cesium,
          points,
          takeoff: plan.takeoff,
          cache: terrainCache,
        });
        if (destroyed || token !== suiteToken) return;
        const byId = [];
        points.forEach((w, i) => {
          byId[w.id] = ground.wpM[i];
        });
        passes.push({
          id: pass.id,
          label: pass.label,
          result: assembleAreaPlan(plan, { ...ground, wpM: byId }),
          error: null,
        });
      }
    } catch (err) {
      if (token === suiteToken) {
        state.suiteBusy = false;
        state.suite = null;
        syncGlobe();
        status(t('Could not plan all passes'), 'warn');
        render();
      }
      return;
    }
    if (destroyed || token !== suiteToken) return;
    state.suite = { passes, when: new Date() };
    state.suiteHidden = new Set();
    state.suiteBusy = false;
    syncGlobe();
    panel.dataset.suiteNonce = String(
      (Number(panel.dataset.suiteNonce) || 0) + 1,
    );
    render();
  }

  function resultAllowed(result) {
    if (!result || !kmzOk().ok) return false;
    if (
      result.warnings.some(
        (w) =>
          w.code === 'mission-over-budget' ||
          w.code === 'too-many-missions' ||
          w.code === 'speed-below-minimum',
      )
    ) {
      return false;
    }
    return result.terrainComplete || state.ack;
  }

  function suiteAllowed() {
    const passes = state.suite?.passes ?? [];
    return (
      !state.suiteBusy &&
      !state.busy &&
      !state.dirty &&
      passes.length > 0 &&
      passes.every((pass) => pass.result && resultAllowed(pass.result))
    );
  }

  function renderSuite() {
    ui.suite.replaceChildren();
    ui.suiteButton.disabled =
      !state.areas.length || state.suiteBusy || state.busy;
    if (state.suiteBusy) {
      el(doc, 'p', ui.suite, {
        cls: 'gev-dp-note',
        text: t('Planning all passes and reading terrain heights'),
      });
      return;
    }
    const suite = state.suite;
    if (!suite) return;
    for (const pass of suite.passes) {
      const row = el(doc, 'div', ui.suite, {
        cls: 'gev-dp-mission',
        attrs: { 'data-pass': pass.id },
      });
      let text;
      if (!pass.result) {
        text = `${pass.label}: ${t('not planned')} (${planErrorText(pass.error)})`;
      } else {
        const tot = pass.result.totals;
        text = `${pass.label}: ${t(
          '{missions} missions, {photos} photos, {time}',
          {
            missions: num(tot.missionCount),
            photos: num(tot.photoCount),
            time: durationText(tot.durationS),
          },
        )}`;
        const bad = pass.result.warnings
          .map((w) => warningText(w))
          .filter(Boolean);
        if (bad.length) text += ` - ${bad.join('; ')}`;
      }
      const toggle = el(doc, 'input', row, {
        cls: 'gev-dp-pass-visible',
        attrs: {
          type: 'checkbox',
          'data-pass-visible': pass.id,
          'aria-label': `${t('Show on the globe')}: ${pass.label}`,
        },
      });
      toggle.checked = Boolean(pass.result) && !state.suiteHidden.has(pass.id);
      toggle.disabled = !pass.result;
      toggle.addEventListener('change', () => {
        if (toggle.checked) state.suiteHidden.delete(pass.id);
        else state.suiteHidden.add(pass.id);
        preview.setSuiteHidden(state.suiteHidden);
      });
      const swatch = el(doc, 'span', row, { cls: 'gev-dp-swatch' });
      swatch.style.backgroundColor = passStyle(
        pass.id,
        suite.passes.indexOf(pass),
      ).color;
      el(doc, 'span', row, { cls: 'gev-dp-mission-label', text });
    }
    const all = el(doc, 'button', ui.suite, {
      cls: 'data-toggle-chip gev-dp-all',
      text: t('DOWNLOAD ALL PASSES (.ZIP)'),
      attrs: {
        type: 'button',
        'data-download': 'suite',
        title: t('Every pass in its own folder, plus a README, in one zip'),
      },
    });
    all.disabled = !suiteAllowed();
    all.addEventListener('click', () => downloadSuite());
    if (suite.passes.some((p) => p.result && !p.result.terrainComplete)) {
      const label = el(doc, 'label', ui.suite, { cls: 'gev-dp-ack' });
      const box = el(doc, 'input', label, {
        attrs: { type: 'checkbox', 'data-ack': 'suite-terrain' },
      });
      box.checked = state.ack;
      el(doc, 'span', label, {
        text: t('Download anyway: I will check the heights myself'),
      });
      box.addEventListener('change', () => {
        state.ack = Boolean(box.checked);
        render();
      });
    }
  }

  function downloadSuite(when = new Date()) {
    if (!suiteAllowed()) return false;
    const bytes = buildSuiteZip(state.suite.passes, {
      when,
      wpml: wpmlOverride(),
    });
    const stamp = kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
    downloadFile(`${stamp}-all-passes.zip`, bytes, 'application/zip');
    return true;
  }

  const kmzOk = () =>
    kmzStatus(getPreset(state.options.presetId), state.wpml.droneEnumValue);

  function kmzReasonText(reason) {
    return reason === 'no-fly-waypoints'
      ? t(
          'No KMZ for this aircraft: DJI GO 4 has no waypoint-file import (it records a flown path), so use a third-party app such as Litchi or Map Pilot Pro with the preview and settings shown here',
        )
      : t(
          'No DJI Fly aircraft code is known for this aircraft yet. Enter one in the "Aircraft code" field under "DJI model code" to enable the KMZ',
        );
  }

  const wpmlOverride = () => ({
    droneEnumValue: state.wpml.droneEnumValue ?? undefined,
  });

  /** Files only come from a finished plan whose heights are read or owned. */
  function downloadsAllowed() {
    const result = state.result;
    if (!result || state.busy || state.dirty) return false;
    if (!kmzOk().ok) return false;
    // A mission over the battery time, or a plan cut off at the mission cap,
    // is never offered: a warning alone is too easy to miss.
    if (
      result.warnings.some(
        (w) =>
          w.code === 'mission-over-budget' ||
          w.code === 'too-many-missions' ||
          w.code === 'speed-below-minimum',
      )
    ) {
      return false;
    }
    return result.terrainComplete || state.ack;
  }

  function downloadMission(index, when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed() || !result.missions[index]) return false;
    const bytes = buildKmz(result.missions[index], result.plan, {
      when,
      wpml: wpmlOverride(),
      name: `GEV Drone Flight Plan ${index + 1}/${result.missions.length}`,
    });
    const named = (result.jobs ?? []).length > 1;
    const mission = result.missions[index];
    const same = named
      ? result.missions.filter((item) => item.jobId === mission.jobId)
      : result.missions;
    downloadFile(
      kmzFileName(
        same.indexOf(mission),
        same.length,
        when,
        named ? mission.jobName : '',
      ),
      bytes,
      'application/vnd.google-earth.kmz',
    );
    return true;
  }

  function downloadAll(when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed()) return false;
    const bytes = buildBundleZip(result, { when, wpml: wpmlOverride() });
    const stamp = kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
    downloadFile(`${stamp}-all.zip`, bytes, 'application/zip');
    return true;
  }

  // --------------------------------------------------------- open/close --
  function setPanelOpen(open) {
    panel.hidden = !open;
    if (!open) return;
    if (panel.classList.contains('collapsed')) {
      panel.querySelector('.panel-collapse-btn')?.click();
      if (panel.classList.contains('collapsed'))
        panel.classList.remove('collapsed');
    }
    if (doc.body?.classList?.contains('mobile-shell')) {
      doc.querySelector('.mobile-tab[data-mobile-sheet="context"]')?.click();
    }
  }

  function drawBox({ toggle = true } = {}) {
    takeoffTool?.cancel('switch');
    polygonTool?.cancel('switch');
    if (boxTool?.isActive()) {
      if (!toggle) return true;
      boxTool.cancel('cancel');
      return false;
    }
    if (!boxTool?.start()) {
      status(t('Another tool is using the pointer. Close it first'), 'warn');
      return false;
    }
    return true;
  }

  function drawPolygon({ toggle = true } = {}) {
    takeoffTool?.cancel('switch');
    boxTool?.cancel('switch');
    if (polygonTool?.isActive()) {
      if (!toggle) return true;
      polygonTool.cancel('cancel');
      return false;
    }
    if (!polygonTool?.start()) {
      status(t('Another tool is using the pointer. Close it first'), 'warn');
      return false;
    }
    return true;
  }

  function open({ draw = true } = {}) {
    state.open = true;
    setPanelOpen(true);
    entry?.setAttribute('aria-pressed', 'true');
    render();
    if (draw && !state.box) drawBox();
  }

  function close() {
    state.open = false;
    clearTimeout(timer);
    planToken += 1;
    boxTool?.cancel('close');
    polygonTool?.cancel('close');
    takeoffTool?.cancel('close');
    state.box = null;
    state.areas = [];
    state.nextArea = 1;
    state.takeoff = null;
    state.result = null;
    state.error = null;
    state.busy = false;
    state.dirty = false;
    suiteToken += 1;
    state.suite = null;
    state.suiteHidden = new Set();
    state.suiteBusy = false;
    state.ack = false;
    terrainCache.clear();
    preview.clear();
    panel.hidden = true;
    entry?.setAttribute('aria-pressed', 'false');
    status('');
  }

  const onEntry = () => (state.open ? close() : open());
  entry?.addEventListener('click', onEntry);

  build();
  syncControls();
  panel.hidden = true;

  function useRecommended(mode, { planNow = false } = {}) {
    const o = state.options;
    const selected =
      typeof mode === 'string' && MODES.includes(mode) ? mode : ui.mode.value;
    if (modeFor(o) !== selected) {
      const next = recommend(getPreset(o.presetId), selected);
      o.pattern = next.pattern;
      o.photoMode = next.photoMode;
    }
    const rec = recommend(getPreset(o.presetId), selected, {
      orbitRadiusM:
        o.orbitRadiusM ??
        state.result?.plan?.options?.orbitRadiusM ??
        undefined,
    });
    Object.assign(o, recommendedOptions(rec));
    syncControls();
    if (planNow) {
      state.dirty = true;
      clearTimeout(timer);
    } else schedule();
    return true;
  }

  function applyOptions(patch = {}, { planNow = false } = {}) {
    const o = state.options;
    let plan = false;
    if (Object.hasOwn(patch, 'presetId')) {
      const preset = getPreset(patch.presetId);
      if (!preset) return false;
      o.presetId = preset.id;
      if (!Object.hasOwn(patch, 'speedMs')) o.speedMs = preset.defaultSpeedMs;
      state.wpml = { droneEnumValue: null, droneSubEnumValue: null };
      plan = true;
    }
    if (Object.hasOwn(patch, 'mode') && modeFor(o) !== patch.mode) {
      const next = recommend(getPreset(o.presetId), patch.mode);
      if (!Object.hasOwn(patch, 'pattern')) o.pattern = next.pattern;
      if (!Object.hasOwn(patch, 'photoMode')) o.photoMode = next.photoMode;
      plan = true;
    }
    if (Object.hasOwn(patch, 'pattern')) {
      o.pattern = patch.pattern;
      plan = true;
    }
    if (Object.hasOwn(patch, 'photoMode')) {
      o.photoMode = patch.photoMode;
      plan = true;
    }
    if (Object.hasOwn(patch, 'direction')) {
      o.direction = patch.direction;
      plan = true;
    }
    if (Object.hasOwn(patch, 'aglM')) {
      o.aglM = patch.aglM;
      plan = true;
    }
    if (Object.hasOwn(patch, 'frontOverlap')) {
      o.frontOverlap = patch.frontOverlap;
      plan = true;
    }
    if (Object.hasOwn(patch, 'sideOverlap')) {
      o.sideOverlap = patch.sideOverlap;
      plan = true;
    }
    if (Object.hasOwn(patch, 'tiltPitchDeg')) {
      o.tiltPitchDeg = patch.tiltPitchDeg;
      plan = true;
    }
    if (Object.hasOwn(patch, 'orbitRadiusM')) {
      o.orbitRadiusM = patch.orbitRadiusM;
      plan = true;
    }
    if (Object.hasOwn(patch, 'orbitHeightsM')) {
      o.orbitHeightsM = patch.orbitHeightsM;
      plan = true;
    }
    if (Object.hasOwn(patch, 'speedMs')) {
      o.speedMs = patch.speedMs;
      plan = true;
    }
    if (Object.hasOwn(patch, 'shutterDenominator')) {
      o.shutterDenominator = patch.shutterDenominator;
      plan = true;
    }
    if (Object.hasOwn(patch, 'batteryMin')) {
      o.batteryMin = patch.batteryMin;
      plan = true;
    }
    if (Object.hasOwn(patch, 'jobs')) {
      state.jobGrouping = patch.jobs === 'whole' ? 'whole' : 'per-area';
      plan = true;
    }
    if (patch.clearDroneCode === true) state.wpml.droneEnumValue = null;
    else if (Object.hasOwn(patch, 'droneEnumValue'))
      state.wpml.droneEnumValue = patch.droneEnumValue;
    syncControls();
    if (plan && planNow) {
      state.dirty = true;
      clearTimeout(timer);
    } else if (plan) schedule();
    else if (
      state.result &&
      (patch.clearDroneCode === true || Object.hasOwn(patch, 'droneEnumValue'))
    )
      render();
    return true;
  }

  function clearTakeoff() {
    state.takeoff = null;
    schedule(0);
    return true;
  }

  function startTakeoffPick({ toggle = true } = {}) {
    if (!state.areas.length) {
      status(t('Draw a box on the globe first'), 'warn');
      return false;
    }
    boxTool?.cancel('switch');
    polygonTool?.cancel('switch');
    if (takeoffTool?.isActive()) {
      if (!toggle) return true;
      takeoffTool.cancel('cancel');
      return false;
    }
    return Boolean(takeoffTool?.start());
  }

  function removeArea(id) {
    if (!state.areas.some((item) => item.id === id)) return false;
    state.areas = state.areas.filter((item) => item.id !== id);
    state.box = state.areas.at(-1)?.box ?? null;
    if (
      state.takeoff &&
      (!state.areas.length ||
        distanceToAreasM(state.areas, state.takeoff) > MAX_TAKEOFF_FROM_BOX_M)
    ) {
      state.takeoff = null;
    }
    showCommitted();
    schedule(0);
    return true;
  }

  const handle = {
    open,
    close,
    isOpen: () => state.open,
    getResult: () => state.result,
    getState: () => state,
    setBox(box) {
      const checked = validateDroneBox(box);
      if (!checked.ok) {
        status(checked.message, 'warn');
        return false;
      }
      addRect(checked.box, { replace: true, clearTakeoff: true });
      return true;
    },
    setPolygon(ring) {
      return addPolygon(ring);
    },
    downloadMission,
    downloadAll,
    planSuite,
    downloadSuite,
    setTakeoff: acceptTakeoff,
    replan,
    drawBox,
    drawPolygon,
    useRecommended,
    applyOptions,
    clearTakeoff,
    startTakeoffPick,
    removeArea,
    downloadsAllowed,
    suiteAllowed,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      entry?.removeEventListener('click', onEntry);
      boxTool?.destroy();
      polygonTool?.destroy();
      takeoffTool?.destroy();
      preview.destroy();
      panel.hidden = true;
      body.replaceChildren();
      entry?.setAttribute('aria-pressed', 'false');
    },
  };
  return handle;
}

/** Save bytes as a file through a temporary link. */
function browserDownload(name, bytes, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
