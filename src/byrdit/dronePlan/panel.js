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
import { validateDroneBox } from './limits.js';
import { initPointTool } from './pointTool.js';
import { createDronePlanPreview } from './preview.js';
import { sampleGround } from './terrain.js';
import {
  AGL_CAP_M,
  FT_PER_M,
  MAX_TAKEOFF_FROM_BOX_M,
  MIN_AGL_M,
  assembleMissions,
  planFlight,
  takeoffDistanceFromBoxM,
} from './planner.js';
import { DEFAULT_PRESET_ID, getPreset, listPresets } from './presets.js';
import { buildBundleZip, buildKmz, kmzFileName } from './wpml.js';
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
      batteryMin: 25,
      orbitRadiusM: null,
      orbitHeightsM: null,
    },
    wpml: { droneEnumValue: null, droneSubEnumValue: null },
    result: null,
    error: null,
    busy: false,
    open: false,
    ack: false,
    dirty: false,
  };
  const terrainCache = new Map();
  let cachedProvider = null;
  let planToken = 0;
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
    onBox: (box) => {
      state.box = box;
      state.takeoff = null;
      preview.showBox(box);
      status('');
      schedule(0);
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
    if (state.box) {
      const away = takeoffDistanceFromBoxM(state.box, point);
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
    }
    state.takeoff = point;
    status('');
    schedule(0);
    return true;
  }

  async function replan() {
    if (destroyed) return;
    const token = ++planToken;
    state.dirty = false;
    if (!state.box) {
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
    };
    const plan = planFlight(state.box, options);
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
    state.result = assembleMissions(plan, { ...ground, wpM: byId });
    state.error = null;
    state.busy = false;
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
        'aria-pressed': 'false',
        title: t('Drag a box over the area to map'),
      },
    });
    ui.closeButton = el(doc, 'button', bar, {
      cls: 'data-toggle-chip',
      text: t('CLOSE'),
      attrs: {
        type: 'button',
        title: t('Close the Drone Flight Plan and clear it from the globe'),
      },
    });
    ui.status = el(doc, 'p', body, {
      cls: 'gev-dp-status',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });

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
    field(t('Photos'), ui.photoMode, { value: false });
    ui.speed = slider(t('Speed'), 1, 15, 0.5);
    ({ out: ui.speedOut } = field(t('Speed'), ui.speed));
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
    ui.status.after(ui.stats, ui.warnings, ui.missions);

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
    onInput(ui.agl, () => (o.aglM = Number(ui.agl.value)));
    onInput(ui.front, () => (o.frontOverlap = Number(ui.front.value)));
    onInput(ui.side, () => (o.sideOverlap = Number(ui.side.value)));
    ui.pattern.addEventListener('change', () => {
      o.pattern = ui.pattern.value;
      syncControls();
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
      syncControls();
    });
    ui.drawButton.addEventListener('click', () => drawBox());
    ui.closeButton.addEventListener('click', () => close());
    ui.takeoffButton.addEventListener('click', () => {
      if (!state.box) return status(t('Draw a box on the globe first'), 'warn');
      boxTool?.cancel('switch');
      if (takeoffTool?.isActive()) takeoffTool.cancel('cancel');
      else takeoffTool?.start();
    });
    ui.takeoffReset.addEventListener('click', () => {
      state.takeoff = null;
      schedule(0);
    });
  }

  function syncControls() {
    const o = state.options;
    const preset = getPreset(o.presetId);
    ui.preset.value = o.presetId;
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
      state.wpml.droneEnumValue ?? preset.wpml.droneEnumValue,
    );
    const orbit = o.pattern === 'orbit';
    ui.directionRow.hidden = orbit;
    ui.tiltRow.hidden = o.pattern !== 'double';
    ui.radiusRow.hidden = !orbit;
    ui.ringsRow.hidden = !orbit;
    const t0 = state.result?.plan?.takeoff ?? state.takeoff;
    const where = state.takeoff ? '' : ` · ${t('centre')}`;
    ui.takeoffText.textContent = t0
      ? `${num(t0.lat, 5)}, ${num(t0.lon, 5)}${where}`
      : '';
    ui.takeoffReset.disabled = !state.takeoff;
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
    panel.dataset.state = state.busy ? 'busy' : state.result ? 'ready' : 'idle';
    if (state.error) {
      status(planErrorText(state.error), 'warn');
    } else if (state.busy) {
      status(t('Reading terrain heights'), 'info');
      reading = true;
    } else if (!state.box && !boxTool?.isActive()) {
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
    stat(t('Waypoints'), missions.map((m) => num(m.waypointCount)).join(' / '));
    if (plan.speedLimitedBy) stat(t('Speed'), `${num(plan.speedMs, 1)} m/s`);
    stat(
      t('Terrain range'),
      result.ground.known ? `${num(totals.terrainRangeM)} m` : t('unknown'),
    );
    for (const w of warnings) {
      const text = warningText(w);
      if (text)
        el(doc, 'li', ui.warnings, { text, attrs: { 'data-code': w.code } });
    }
    const list = ui.missions;
    const when = new Date();
    missions.forEach((m, i) => {
      const row = el(doc, 'div', list, { cls: 'gev-dp-mission' });
      el(doc, 'span', row, {
        cls: 'gev-dp-mission-label',
        text: t('Mission {n}: {wp} waypoints, {photos} photos, {time}', {
          n: num(i + 1),
          wp: num(m.waypointCount),
          photos: num(m.photoCount),
          time: durationText(m.durationS),
        }),
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

  const wpmlOverride = () => ({
    droneEnumValue: state.wpml.droneEnumValue ?? undefined,
  });

  /** Files only come from a finished plan whose heights are read or owned. */
  function downloadsAllowed() {
    const result = state.result;
    if (!result || state.busy || state.dirty) return false;
    // A mission over the battery time, or a plan cut off at the mission cap,
    // is never offered: a warning alone is too easy to miss.
    if (
      result.warnings.some(
        (w) =>
          w.code === 'mission-over-budget' || w.code === 'too-many-missions',
      )
    ) {
      return false;
    }
    return result.terrainComplete || state.ack;
  }

  function downloadMission(index, when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed() || !result.missions[index]) return;
    const bytes = buildKmz(result.missions[index], result.plan, {
      when,
      wpml: wpmlOverride(),
      name: `GEV Drone Flight Plan ${index + 1}/${result.missions.length}`,
    });
    downloadFile(
      kmzFileName(index, result.missions.length, when),
      bytes,
      'application/vnd.google-earth.kmz',
    );
  }

  function downloadAll(when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed()) return;
    const bytes = buildBundleZip(result, { when, wpml: wpmlOverride() });
    const stamp = kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
    downloadFile(`${stamp}-all.zip`, bytes, 'application/zip');
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

  function drawBox() {
    takeoffTool?.cancel('switch');
    if (boxTool?.isActive()) {
      boxTool.cancel('cancel');
      return;
    }
    if (!boxTool?.start()) {
      status(t('Another tool is using the pointer. Close it first'), 'warn');
    }
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
    takeoffTool?.cancel('close');
    state.box = null;
    state.takeoff = null;
    state.result = null;
    state.error = null;
    state.busy = false;
    state.dirty = false;
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
      state.box = checked.box;
      state.takeoff = null;
      preview.showBox(checked.box);
      schedule(0);
      return true;
    },
    downloadMission,
    downloadAll,
    setTakeoff: acceptTakeoff,
    replan,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      entry?.removeEventListener('click', onEntry);
      boxTool?.destroy();
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
