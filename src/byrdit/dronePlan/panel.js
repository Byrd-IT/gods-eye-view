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
import { checkConflicts } from './conflicts.js';
import { initPointTool } from './pointTool.js';
import {
  DEFAULT_OUTWARD_PITCH_DEG,
  DEFAULT_RING_ANGLES_DEG,
  MAX_OUTWARD_PITCH_DEG,
  MIN_OUTWARD_PITCH_DEG,
  normalizeRingAngles,
} from './orbitRings.js';
import {
  DEFAULT_ZONE_HALF_WIDTH_M,
  MAX_ZONE_HALF_WIDTH_M,
  MIN_ZONE_HALF_WIDTH_M,
} from './checkGeometry.js';
import { createDronePlanPreview, passStyle } from './preview.js';
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../../overlays/worldOverlay.js';
import { areasBox } from './buildingFootprints.js';
import { OBSTACLE_OVERLAY_SOURCE, pickTerrainLonLat } from './obstacleLayer.js';
import { buildingObstacles, SOURCE_NAMES } from './obstacleData.js';
import {
  createObstacleStore,
  OBSTACLE_KINDS,
  MAX_OBSTACLE_HEIGHT_M,
  MAX_OBSTACLES,
} from './obstacles.js';
import { sampleGround } from './terrain.js';
import { recommendOrbitTargets, targetInsideAreas } from './orbitTargets.js';
import {
  AGL_CAP_M,
  DEFAULT_OBSTACLE_HEIGHT_M,
  MAX_ORBIT_TARGETS,
  MAX_TAKEOFF_FROM_BOX_M,
  MIN_AGL_M,
  OBSTACLE_MARGIN_M,
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
import { readPlan, serializePlan } from './planDoc.js';
import { mountLibrary } from './libraryPanel.js';
import {
  distanceText,
  durationText,
  heightText,
  lengthText,
  planErrorText,
  speedText,
  warningText,
} from './format.js';
import {
  browserStorage,
  lengthFromM,
  lengthToM,
  lengthUnit,
  readUnitSystem,
  setUnitSystem,
  sliderRange,
  speedFromMs,
  speedToMs,
  speedUnit,
  writeUnitSystem,
} from './units.js';
import { ALPHA_RANGE, DEFAULT_ALPHA, clampAlpha } from './checkLayer.js';
import {
  STEP_KEYS,
  readAlpha,
  readStepsOpen,
  writeAlpha,
  writeStepsOpen,
} from './prefs.js';

export const PANEL_ID = 'drone-plan-panel';
export const BODY_ID = 'drone-plan-panel-body';
/** The card's own header button is the launcher: there is no DISPLAY entry. */
export const ENTRY_SELECTOR = '.panel-collapse-btn';
export const TARGET_POINTER_OWNER = 'drone-plan-orbit-target';
export const PATH_POINTER_OWNER = 'drone-plan-lookat-path';
export const OBSTACLE_ADD_POINTER_OWNER = 'drone-plan-obstacle-add';
const BOX_OWNER = 'drone-plan-box';
const REPLAN_DELAY_MS = 160;
const MAX_TERRAIN_CACHE = 30000;
const CHECK_SLIDER_DELAY_MS = 150;

const el = (doc, tag, parent, { text, cls, attrs } = {}) => {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};
/**
 * Totals for the one-line plan summary: a single plan, or the grand total
 * over every pass that planned (hidden passes are still in the plan).
 * Batteries = ceil(air time / battery time), at least 1. One KMZ = one flight.
 * @returns {null | { durationS: number, flights: number, batteries: number,
 *   minutes: number, failed: string[], sharedBatteries: boolean }}
 */
export function planSummary({ suite, result, batteryMin }) {
  let durationS = 0;
  let flights = 0;
  let failed = [];
  if (suite) {
    const planned = suite.passes.filter((p) => p.result);
    failed = suite.passes.filter((p) => !p.result).map((p) => p.label);
    if (!planned.length) return null;
    for (const pass of planned) {
      durationS += pass.result.totals.durationS;
      flights += pass.result.totals.missionCount;
    }
  } else if (result?.totals) {
    durationS = result.totals.durationS;
    flights = result.totals.missionCount;
  } else {
    return null;
  }
  // The planner clamps the battery time to 5-60 min: the totals must agree.
  const minutes = Math.min(60, Math.max(5, Number(batteryMin) || 25));
  const batteries = Math.max(1, Math.ceil(durationS / (minutes * 60)));
  return {
    durationS,
    flights,
    batteries,
    minutes,
    failed,
    sharedBatteries: batteries < flights,
  };
}

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
  libraryClient,
  getBuildingFootprints = null,
  fetchObstacles = null,
  unitStorage = browserStorage(doc?.defaultView ?? globalThis),
  overlay = {
    set: (entries) => setOverlayEntries(OBSTACLE_OVERLAY_SOURCE, entries),
    clear: () => clearOverlaySource(OBSTACLE_OVERLAY_SOURCE),
  },
} = {}) {
  const panel = doc?.getElementById?.(PANEL_ID);
  const body = doc?.getElementById?.(BODY_ID);
  if (!viewer?.scene || !panel || !body) return null;
  const entry = panel.querySelector?.(ENTRY_SELECTOR) ?? null;
  // Feet or metres, as this browser last chose. Only what is shown and typed
  // changes: the plan and the KMZ stay in metres.
  setUnitSystem(readUnitSystem(unitStorage));
  const stepsOpen = readStepsOpen(unitStorage);

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
      orbitRingMode: 'angles',
      orbitAnglesDeg: null,
      orbitOutward: true,
      orbitOutwardPitchDeg: DEFAULT_OUTWARD_PITCH_DEG,
      lookAtPaths: [],
      orbitTargetHeightM: 3,
      obstacleHeightM: DEFAULT_OBSTACLE_HEIGHT_M,
      orbitTargets: [],
      obstacles: [],
    },
    // True once the person adds, removes or switches a target: from then on
    // the list is theirs and is no longer rebuilt from the areas.
    orbitTargetsTouched: false,
    // True once PLAN ALL ran: its orbit pass uses the orbit targets, so the
    // list stays in view (and in step with the areas) even for a grid pattern.
    orbitsPlanned: false,
    wpml: { droneEnumValue: null, droneSubEnumValue: null },
    result: null,
    suite: null,
    suiteHidden: new Set(),
    // Controller mission ids (one per flight) and imported drone files.
    controllerIds: [],
    imports: [],
    // The 3D check on the globe: a visual aid, it detects nothing.
    check: {
      enabled: true,
      zone: true,
      halfWidthM: DEFAULT_ZONE_HALF_WIDTH_M,
      curtain: true,
      footprints: true,
      frustum: 'one',
      index: 0,
      // How see-through each layer is (0 = invisible): the sliders.
      alpha: readAlpha(unitStorage),
    },
    suiteBusy: false,
    pathDraft: null,
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

  // Per-obstacle heights: first guesses from open data, then the operator's
  // own numbers (typed or dragged). Estimates only, never surveyed.
  let obstacleMuted = false;
  let obstacleTyping = false;
  let obstacleKey = null;
  // The look-up in flight: PLAN ALL waits for it (it feeds the planner).
  let obstaclePending = null;
  let suiteSettling = false;
  let obstacleToken = 0;
  let obstacleAbort = null;
  let groundHintM = 0;
  let obstacleStatusText = '';
  const kindName = (kind) =>
    ({
      tree: t('tree'),
      tower: t('tower'),
      building: t('building'),
      other: t('other'),
    })[kind] ?? kind;
  const obstacleStore = createObstacleStore({
    onChange: (list) => {
      state.options.obstacles = list;
      state.options.obstaclesDropped = obstacleStore.dropped();
      preview.setObstacles(list);
      if (obstacleMuted || destroyed) return;
      renderObstacles();
      schedule();
    },
  });
  const preview = createDronePlanPreview({
    viewer,
    cesium,
    overlay,
    kindText: kindName,
    onObstacleHeight: (id, h) => obstacleStore.setHeight(id, h),
  });
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

  const targetTool = initPointTool({
    viewer,
    cesium,
    owner: TARGET_POINTER_OWNER,
    onPoint: (point) => addOrbitTarget(point),
    onCancel: (reason) => {
      if (reason === 'sky')
        status(t('Click on the ground, not the sky'), 'warn');
      else if (reason === 'escape') status(t('Target pick cancelled'));
      else if (reason === 'pointer-busy')
        status(t('Another tool is using the pointer. Close it first'), 'warn');
    },
    onActive: (active) => {
      ui.targetAdd?.setAttribute('aria-pressed', String(active));
      if (active)
        status(t('Click the structure or tree you want to orbit'), 'info');
    },
  });

  const pathTool = initPointTool({
    viewer,
    cesium,
    owner: PATH_POINTER_OWNER,
    onPoint: (point) => {
      if (!state.pathDraft) return;
      state.pathDraft.push(point);
      status(
        t('Path: {n} points. Click more, or press DRAW PATH again to finish', {
          n: num(state.pathDraft.length),
        }),
        'info',
      );
      // The point tool stops after each click: pick up the next one.
      pathTool?.start();
    },
    onCancel: (reason) => {
      if (reason === 'sky') {
        status(t('Click on the ground, not the sky'), 'warn');
        return;
      }
      if (reason === 'done') return;
      if (reason === 'escape') status(t('Path drawing cancelled'));
      else if (reason === 'pointer-busy')
        status(t('Another tool is using the pointer. Close it first'), 'warn');
      state.pathDraft = null;
    },
    onActive: (active) => {
      ui.pathAdd?.setAttribute(
        'aria-pressed',
        String(Boolean(state.pathDraft)),
      );
      if (active && !state.pathDraft?.length)
        status(t('Click points along the route to fly'), 'info');
    },
  });

  const obstacleTool = initPointTool({
    viewer,
    cesium,
    owner: OBSTACLE_ADD_POINTER_OWNER,
    pickWorld: (v, nx, ny) => pickTerrainLonLat(v, nx, ny, cesium, groundHintM),
    onPoint: (point) => addObstacle(point),
    onCancel: (reason) => {
      if (reason === 'sky')
        status(t('Click on the ground, not the sky'), 'warn');
      else if (reason === 'escape') status(t('Obstacle pick cancelled'));
      else if (reason === 'pointer-busy')
        status(t('Another tool is using the pointer. Close it first'), 'warn');
    },
    onActive: (active) => {
      ui.obstacleAdd?.setAttribute('aria-pressed', String(active));
      if (active)
        status(
          t('Click the tree, tower or building to mark as an obstacle'),
          'info',
        );
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
  // ------------------------------------------------------ orbit targets --
  const footprintCache = new Map();
  const footprintPromises = new Map();

  function areasKey() {
    return JSON.stringify(
      state.areas.map((a) => (a.kind === 'polygon' ? a.ring : a.box)),
    );
  }

  /** The plan has orbits: the Orbit pattern, or an all-passes plan (it has an orbit pass). */
  function orbitsShown() {
    return state.options.pattern === 'orbit' || state.orbitsPlanned;
  }

  /**
   * Untouched targets follow the areas: building footprints when a source
   * has them, otherwise each area's centre. Touched ones only lose targets
   * that no longer lie inside an area.
   */
  function syncOrbitTargets() {
    const o = state.options;
    if (!orbitsShown()) return;
    if (!state.areas.length) {
      o.orbitTargets = [];
      return;
    }
    if (!state.orbitTargetsTouched) {
      const key = areasKey();
      o.orbitTargets = recommendOrbitTargets(state.areas, {
        footprints: footprintCache.get(key) ?? [],
      });
      if (getBuildingFootprints && !footprintCache.has(key)) {
        footprintCache.set(key, []);
        const pending = Promise.resolve().then(() =>
          getBuildingFootprints(state.areas),
        );
        footprintPromises.set(key, pending);
        pending
          .then((found) => {
            if (destroyed || !Array.isArray(found) || !found.length) return;
            footprintCache.set(key, found);
            // PLAN ALL settles the targets itself: a replan now would drop
            // the suite it is building.
            if (
              areasKey() === key &&
              !state.orbitTargetsTouched &&
              !state.suiteBusy
            )
              schedule(0);
          })
          .catch(() => {});
      }
      return;
    }
    o.orbitTargets = (o.orbitTargets ?? []).filter((target) =>
      targetInsideAreas(state.areas, target.lon, target.lat),
    );
  }

  function touchTargets() {
    state.orbitTargetsTouched = true;
    state.options.orbitTargets = [...(state.options.orbitTargets ?? [])];
    return state.options.orbitTargets;
  }

  function nextTargetId() {
    const taken = new Set((state.options.orbitTargets ?? []).map((x) => x.id));
    let n = (state.options.orbitTargets ?? []).length + 1;
    while (taken.has(`target-${n}`)) n += 1;
    return `target-${n}`;
  }

  /** Add a custom orbit target (a map click), inside the survey areas. */
  function addOrbitTarget(point) {
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (!state.areas.length) {
      status(t('Draw a box on the globe first'), 'warn');
      return false;
    }
    if (!targetInsideAreas(state.areas, lon, lat)) {
      status(t('Pick a spot inside the survey area'), 'warn');
      return false;
    }
    if (!orbitsShown()) state.options.pattern = 'orbit';
    syncOrbitTargets();
    const list = touchTargets();
    if (list.length >= MAX_ORBIT_TARGETS) {
      status(
        t('At most {count} orbit targets', { count: MAX_ORBIT_TARGETS }),
        'warn',
      );
      return false;
    }
    list.push({
      id: nextTargetId(),
      lon,
      lat,
      label: `${t('Target')} ${list.length + 1}`,
      source: 'custom',
      active: true,
      heightM: null,
    });
    status('');
    schedule(0);
    return true;
  }

  function removeOrbitTarget(id) {
    const list = state.options.orbitTargets ?? [];
    if (!list.some((x) => x.id === id)) return false;
    touchTargets();
    state.options.orbitTargets = list.filter((x) => x.id !== id);
    schedule(0);
    return true;
  }

  /** Change one target's own settings (size, blocked sector, ...). */
  function updateOrbitTarget(id, patch) {
    const target = (state.options.orbitTargets ?? []).find((x) => x.id === id);
    if (!target) return false;
    touchTargets();
    state.options.orbitTargets = state.options.orbitTargets.map((x) => {
      if (x.id !== id) return x;
      const next = { ...x, ...patch };
      for (const key of Object.keys(next)) {
        if (next[key] === undefined) delete next[key];
      }
      return next;
    });
    schedule(0);
    return true;
  }

  // ---------------------------------------------------------- look-at paths --
  function nextPathId() {
    const list = state.options.lookAtPaths ?? [];
    const taken = new Set(list.map((x) => x.id));
    let n = list.length + 1;
    while (taken.has(`path-${n}`)) n += 1;
    return `path-${n}`;
  }

  function nearestTargetId(point) {
    const list = (state.options.orbitTargets ?? []).filter(
      (x) => x.active !== false,
    );
    let best = null;
    for (const tg of list) {
      const d = Math.hypot(tg.lon - point.lon, tg.lat - point.lat);
      if (!best || d < best.d) best = { id: tg.id, d };
    }
    return best?.id ?? '';
  }

  function finishPathDraft() {
    const draft = state.pathDraft;
    state.pathDraft = null;
    pathTool?.cancel('done');
    ui.pathAdd?.setAttribute('aria-pressed', 'false');
    if (!draft || draft.length < 2) {
      if (draft) status(t('A path needs at least two points'), 'warn');
      render();
      return false;
    }
    const list = [...(state.options.lookAtPaths ?? [])];
    return addLookAtPath(draft);
  }

  /** Add a look-at path from two or more points (also used by tests). */
  function addLookAtPath(points, targetId) {
    const pts = (Array.isArray(points) ? points : [])
      .map((q) => ({ lon: Number(q?.lon), lat: Number(q?.lat) }))
      .filter((q) => Number.isFinite(q.lon) && Number.isFinite(q.lat));
    if (pts.length < 2) return false;
    const list = [...(state.options.lookAtPaths ?? [])];
    list.push({
      id: nextPathId(),
      label: `${t('Path')} ${list.length + 1}`,
      active: true,
      targetId: targetId ?? nearestTargetId(pts[0]),
      aglM: null,
      points: pts,
    });
    state.options.lookAtPaths = list;
    if (!orbitsShown()) state.options.pattern = 'orbit';
    status('');
    schedule(0);
    return true;
  }

  function toggleDrawPath() {
    if (state.pathDraft) return finishPathDraft();
    if (!state.areas.length) {
      status(t('Draw a box on the globe first'), 'warn');
      return false;
    }
    if (!(state.options.orbitTargets ?? []).some((x) => x.active !== false)) {
      status(t('Add an orbit target to look at first'), 'warn');
      return false;
    }
    boxTool?.cancel('switch');
    polygonTool?.cancel('switch');
    takeoffTool?.cancel('switch');
    targetTool?.cancel('switch');
    pathTool?.cancel('switch');
    state.pathDraft = [];
    if (!pathTool?.start()) {
      state.pathDraft = null;
      return false;
    }
    return true;
  }

  function updateLookAtPath(id, patch) {
    const list = state.options.lookAtPaths ?? [];
    if (!list.some((x) => x.id === id)) return false;
    state.options.lookAtPaths = list.map((x) =>
      x.id === id ? { ...x, ...patch } : x,
    );
    schedule(0);
    return true;
  }

  function removeLookAtPath(id) {
    const list = state.options.lookAtPaths ?? [];
    if (!list.some((x) => x.id === id)) return false;
    state.options.lookAtPaths = list.filter((x) => x.id !== id);
    schedule(0);
    return true;
  }

  function setOrbitTargetActive(id, active) {
    const target = (state.options.orbitTargets ?? []).find((x) => x.id === id);
    if (!target) return false;
    touchTargets();
    state.options.orbitTargets = state.options.orbitTargets.map((x) =>
      x.id === id ? { ...x, active: active !== false } : x,
    );
    schedule(0);
    return true;
  }

  /** Rebuild the list from the areas, dropping any hand edits. */
  function recommendTargets() {
    state.orbitTargetsTouched = false;
    if (!orbitsShown()) state.options.pattern = 'orbit';
    footprintCache.delete(areasKey());
    syncOrbitTargets();
    schedule(0);
    return state.options.orbitTargets.length;
  }

  // ------------------------------------------------------------ obstacles --
  /** Ground under each obstacle, from the terrain model (never the 3D tiles). */
  async function sampleObstacleGround(plan) {
    const list = obstacleStore.list();
    if (!list.length) return {};
    try {
      const g = await sampleGround({
        viewer,
        cesium,
        points: list.map((o) => ({ lon: o.lon, lat: o.lat })),
        takeoff: plan.takeoff,
        cache: terrainCache,
      });
      if (!g.known) return {};
      const out = {};
      list.forEach((o, i) => {
        if (typeof g.wpM[i] === 'number') out[o.id] = g.wpM[i];
      });
      return out;
    } catch {
      return {};
    }
  }

  function resetObstacles() {
    obstacleAbort?.abort();
    obstacleAbort = null;
    obstacleToken += 1;
    obstacleKey = null;
    obstacleStatusText = '';
    obstacleMuted = true;
    obstacleStore.clear();
    obstacleMuted = false;
    state.options.obstacles = [];
    preview.setObstacles([]);
  }

  function buildingsFor(key) {
    if (!getBuildingFootprints) return Promise.resolve([]);
    if (!footprintPromises.has(key)) {
      if (!footprintCache.has(key)) footprintCache.set(key, []);
      const pending = Promise.resolve().then(() =>
        getBuildingFootprints(state.areas),
      );
      footprintPromises.set(key, pending);
      pending.then(
        (found) => {
          if (Array.isArray(found) && found.length)
            footprintCache.set(key, found);
        },
        () => {},
      );
    }
    return footprintPromises.get(key).catch(() => []);
  }

  /** Look up open-data estimates once per area set; fail soft. */
  function syncObstacles({ force = false } = {}) {
    if (!state.areas.length) {
      obstacleKey = null;
      return;
    }
    const key = areasKey();
    if (!force && key === obstacleKey) return;
    if (!fetchObstacles && !getBuildingFootprints) return;
    obstacleKey = key;
    obstacleAbort?.abort();
    obstacleAbort = new AbortController();
    const abort = obstacleAbort;
    const token = ++obstacleToken;
    obstacleStatusText = t('Looking up open-data heights…');
    renderObstacleStatus();
    obstaclePending = Promise.resolve()
      .then(async () => {
        const [open, buildings] = await Promise.all([
          fetchObstacles
            ? fetchObstacles(state.areas, { signal: abort.signal })
            : { obstacles: [], status: {} },
          buildingsFor(key),
        ]);
        if (destroyed || token !== obstacleToken) return;
        const osm = buildingObstacles(buildings);
        const found = open?.obstacles ?? [];
        const towers = found.filter((x) => x.source === 'faa');
        const trees = found.filter((x) => x.source !== 'faa');
        const failed = Object.entries(open?.status ?? {})
          .filter(([, v]) => v === 'failed' || v === 'partial')
          .map(([k]) => t(SOURCE_NAMES[k] ?? k));
        obstacleMuted = false;
        const unread = Object.entries(open?.status ?? {})
          .filter(([, v]) => v === 'failed' || v === 'partial')
          .map(([k]) => k);
        const area = areasBox(state.areas);
        obstacleStore.replaceEstimates([...towers, ...osm, ...trees], {
          keepSources: unread,
          // Old rows from a source that failed only stay when they are still
          // inside the area being planned.
          within: area
            ? (o) =>
                o.lon >= area.west - 0.05 &&
                o.lon <= area.east + 0.05 &&
                o.lat >= area.south - 0.05 &&
                o.lat <= area.north + 0.05
            : () => false,
        });
        // After replaceEstimates, so the dropped count is this lookup's.
        obstacleStatusText =
          t(
            'Open data: {towers} towers, {trees} tree patches, {buildings} buildings.',
            {
              towers: num(towers.length),
              trees: num(trees.length),
              buildings: num(osm.length),
            },
          ) +
          (failed.length
            ? ` ${t('Could not read: {names}. The plan uses the default height there.', { names: failed.join(', ') })}`
            : '') +
          (obstacleStore.dropped()
            ? ` ${t('{count} more not planned (too many).', { count: num(obstacleStore.dropped()) })}`
            : '');
        renderObstacleStatus();
      })
      .catch(() => {
        if (destroyed || token !== obstacleToken) return;
        obstacleStatusText = t(
          'Open-data heights are unavailable. The plan uses the default height.',
        );
        renderObstacleStatus();
      });
  }

  function addObstacle(point) {
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const made = obstacleStore.add({
      lon,
      lat,
      kind: point.kind ?? 'tree',
      heightM: point.heightM ?? state.options.obstacleHeightM,
    });
    if (!made) {
      status(t('At most {count} obstacles', { count: MAX_OBSTACLES }), 'warn');
      return null;
    }
    status('');
    return made;
  }

  function startObstaclePick({ toggle = true } = {}) {
    boxTool?.cancel('switch');
    polygonTool?.cancel('switch');
    takeoffTool?.cancel('switch');
    targetTool?.cancel('switch');
    pathTool?.cancel('switch');
    if (obstacleTool?.isActive()) {
      if (!toggle) return true;
      obstacleTool.cancel('cancel');
      return false;
    }
    return Boolean(obstacleTool?.start());
  }

  function renderObstacleStatus() {
    if (ui.obstacleStatus) ui.obstacleStatus.textContent = obstacleStatusText;
  }

  function renderObstacles() {
    if (!ui.obstacleList) return;
    // Typing in a height box must not rebuild the box under the caret.
    const active = doc.activeElement;
    const typing =
      active &&
      ui.obstacleList.contains?.(active) &&
      active.getAttribute?.('data-obstacle-height') !== null &&
      active.getAttribute?.('data-obstacle-height') !== undefined;
    if (obstacleTyping || typing) return;
    ui.obstacleList.replaceChildren();
    const list = obstacleStore.list();
    if (!list.length) {
      el(doc, 'p', ui.obstacleList, {
        cls: 'gev-dp-note',
        text: state.areas.length
          ? t('No obstacles found. ADD places one on the globe.')
          : t('Draw a box on the globe first'),
      });
      return;
    }
    for (const o of list) {
      const row = el(doc, 'div', ui.obstacleList, {
        cls: 'gev-dp-area gev-dp-obstacle',
        attrs: { 'data-obstacle': o.id },
      });
      const where = `${num(o.lat, 5)}, ${num(o.lon, 5)} · r ${lengthText(o.radiusM)}`;
      if (o.source === 'user') {
        // The operator placed it: they say what it is.
        const kind = el(doc, 'select', row, {
          cls: 'pp-select gev-field gev-field--compact gev-dp-area-kind',
          attrs: {
            title: where,
            'aria-label': t('Obstacle kind'),
            'data-obstacle-kind': o.id,
          },
        });
        for (const k of OBSTACLE_KINDS) {
          el(doc, 'option', kind, { text: kindName(k), attrs: { value: k } });
        }
        kind.value = o.kind;
        kind.addEventListener('change', () => {
          obstacleStore.setKind(o.id, kind.value);
        });
      } else {
        el(doc, 'span', row, {
          cls: 'gev-dp-area-kind',
          text: kindName(o.kind),
          attrs: { title: where },
        });
      }
      const height = el(doc, 'input', row, {
        cls: 'pp-text-input gev-dp-obstacle-height',
        attrs: {
          type: 'number',
          min: '0',
          max: lengthField(MAX_OBSTACLE_HEIGHT_M),
          step: '1',
          'aria-label': t('Obstacle height'),
          'data-obstacle-height': o.id,
        },
      });
      height.value = lengthField(o.heightM, 1);
      el(doc, 'span', row, {
        cls: 'gev-dp-obstacle-source',
        text:
          o.estimatedHeightM === null
            ? t('Set by you')
            : `${t(SOURCE_NAMES[o.source] ?? o.source)}: ${lengthText(o.estimatedHeightM)}`,
      });
      const reset = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('Reset'),
        attrs: {
          type: 'button',
          'data-reset-obstacle': o.id,
          title: t('Back to the open-data estimate'),
        },
      });
      reset.disabled = !(o.userEdited && o.estimatedHeightM !== null);
      reset.addEventListener('click', () => obstacleStore.reset(o.id));
      // The list is not rebuilt while this box has focus (the caret, the
      // keyboard focus and a click on Reset or x would be lost). So the row
      // follows an edit in place: Reset wakes up as soon as the value is
      // an edit, and the box shows the stored (clamped) number once committed.
      const syncRow = (commit) => {
        const now = obstacleStore.list().find((x) => x.id === o.id);
        if (!now) return;
        reset.disabled = !(now.userEdited && now.estimatedHeightM !== null);
        if (commit) height.value = lengthField(now.heightM, 1);
      };
      height.addEventListener('input', () => {
        obstacleTyping = true;
        try {
          obstacleStore.setHeight(
            o.id,
            height.value.trim() === '' ? '' : lengthToM(height.value),
          );
        } finally {
          obstacleTyping = false;
        }
        syncRow(false);
      });
      height.addEventListener('change', () => syncRow(true));
      const remove = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: '×',
        attrs: {
          type: 'button',
          'data-remove-obstacle': o.id,
          'aria-label': t('Remove'),
        },
      });
      remove.addEventListener('click', () => obstacleStore.remove(o.id));
    }
  }

  function startTargetPick({ toggle = true } = {}) {
    if (!state.areas.length) {
      status(t('Draw a box on the globe first'), 'warn');
      return false;
    }
    boxTool?.cancel('switch');
    polygonTool?.cancel('switch');
    takeoffTool?.cancel('switch');
    if (targetTool?.isActive()) {
      if (!toggle) return true;
      targetTool.cancel('cancel');
      return false;
    }
    return Boolean(targetTool?.start());
  }

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
    pushCheck();
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
      state.orbitsPlanned = false;
      state.result = null;
      state.error = null;
      state.busy = false;
      preview.showPlan(null);
      render();
      return;
    }
    state.ack = false;
    syncOrbitTargets();
    syncObstacles();
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
    const obstacleM = await sampleObstacleGround(plan);
    if (destroyed || token !== planToken) return;
    // wpM is indexed by waypoint id, which is the order points were listed in.
    const byId = [];
    points.forEach((w, i) => {
      byId[w.id] = ground.wpM[i];
    });
    state.result = assembleAreaPlan(plan, { ...ground, wpM: byId, obstacleM });
    state.error = null;
    state.busy = false;
    planNonce += 1;
    panel.dataset.planNonce = String(planNonce);
    pushCheck();
    groundHintM = ground.known ? ground.takeoffM : 0;
    preview.setObstacleGround(groundHintM);
    preview.showPlan(state.result);
    render();
  }

  // ------------------------------------------------------------------ UI --
  function build() {
    body.replaceChildren();
    body.classList.add('gev-dp-body');
    const bar = el(doc, 'div', body, { cls: 'gev-dp-bar' });
    ui.bar = bar;
    ui.closeButton = el(doc, 'button', bar, {
      cls: 'data-toggle-chip',
      text: t('CLOSE'),
      attrs: {
        type: 'button',
        'data-action': 'close',
        title: t('Close the Drone Flight Plan and clear it from the globe'),
      },
    });
    // Feet or metres: what the panel shows and accepts. The KMZ stays metres.
    const unitBox = el(doc, 'span', bar, {
      cls: 'gev-dp-units',
      attrs: { role: 'group', 'aria-label': t('Units') },
    });
    ui.unitButtons = {};
    for (const [system, label] of [
      ['ft', t('FT')],
      ['m', t('M')],
    ]) {
      ui.unitButtons[system] = el(doc, 'button', unitBox, {
        cls: 'data-toggle-chip',
        text: label,
        attrs: {
          type: 'button',
          'data-action': `units-${system}`,
          'aria-pressed': 'false',
          title:
            system === 'ft'
              ? t('Show feet and ft/s. The mission file always stays in metres')
              : t(
                  'Show metres and m/s. The mission file always stays in metres',
                ),
        },
      });
    }
    ui.status = el(doc, 'p', body, {
      cls: 'gev-dp-status',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });

    // ---- The nine numbered steps: <details>, each with a one-line summary
    // of its current values while collapsed. Open or closed is remembered.
    ui.steps = {};
    const stepTitles = {
      area: t('Area'),
      aircraft: t('Aircraft & camera'),
      shots: t('Shots'),
      orbits: t('Orbits'),
      obstacles: t('Obstacles & safety'),
      flight: t('Flight & battery'),
      plan: t('Plan'),
      check: t('Check (3D)'),
      export: t('Save & export'),
    };
    const makeStep = (key) => {
      const n = STEP_KEYS.indexOf(key) + 1;
      const details = el(doc, 'details', body, {
        cls: 'gev-dp-step',
        attrs: { 'data-step': key },
      });
      if (stepsOpen[key]) details.setAttribute('open', '');
      const head = el(doc, 'summary', details, { cls: 'gev-dp-step-head' });
      el(doc, 'span', head, { cls: 'gev-dp-step-num', text: String(n) });
      el(doc, 'span', head, {
        cls: 'gev-dp-step-title',
        text: stepTitles[key],
      });
      const line = el(doc, 'span', head, {
        cls: 'gev-dp-step-line',
        attrs: { 'data-step-line': key },
      });
      const inner = el(doc, 'div', details, { cls: 'gev-dp-step-body' });
      details.addEventListener('toggle', () => {
        stepsOpen[key] = Boolean(
          details.open ?? details.getAttribute('open') !== null,
        );
        writeStepsOpen(unitStorage, stepsOpen);
      });
      ui.steps[key] = { details, line, body: inner, head };
    };
    for (const key of STEP_KEYS) makeStep(key);
    // Where the controls built below go: the body of the step being built.
    let host = body;
    const into = (key) => {
      host = ui.steps[key].body;
    };

    into('area');
    ui.drawButton = el(doc, 'button', host, {
      cls: 'data-toggle-chip',
      text: t('DRAW BOX'),
      attrs: {
        type: 'button',
        'data-action': 'draw-box',
        'aria-pressed': 'false',
        title: t('Drag a box over the area to map'),
      },
    });
    ui.polygonButton = el(doc, 'button', host, {
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
    ui.areas = el(doc, 'div', host, { cls: 'gev-dp-areas' });
    ui.library = el(doc, 'div', ui.steps.export.body, {
      cls: 'gev-dp-library-host',
    });

    const field = (label, control, { value } = {}) => {
      const row = el(doc, 'label', host, { cls: 'gev-dp-row' });
      const labelEl = el(doc, 'span', row, {
        cls: 'gev-dp-label',
        text: label,
      });
      const wrap = el(doc, 'span', row, { cls: 'gev-dp-control' });
      wrap.append(control);
      let out = null;
      if (value !== false)
        out = el(doc, 'output', wrap, { cls: 'gev-slider-value' });
      return { row, out, labelEl };
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
    // A slider over a length or a speed: its range is kept in metres (m/s)
    // and turned into the chosen unit by applyUnitRanges().
    const unitSliders = [];
    const lslider = (label, spec) => {
      const control = slider(label, spec.minM, spec.maxM, spec.stepM);
      unitSliders.push({ control, spec });
      return control;
    };
    ui.applyUnitRanges = () => {
      for (const { control, spec } of unitSliders) {
        const range = sliderRange(spec);
        control.min = String(range.min);
        control.max = String(range.max);
        control.step = String(range.step);
      }
    };

    into('aircraft');
    ui.preset = select(
      listPresets().map((p) => [p.id, p.name]),
      t('Aircraft'),
    );
    field(t('Aircraft'), ui.preset, { value: false });
    ui.presetInfo = el(doc, 'p', host, {
      cls: 'gev-dp-note gev-dp-preset-info',
      attrs: { 'data-role': 'preset-info' },
    });
    ui.shutter = select(
      SHUTTER_DENOMINATORS.map((n) => [String(n), `1/${n} s`]),
      t('Shutter speed'),
    );
    field(t('Shutter speed'), ui.shutter, { value: false });
    into('shots');
    ui.mode = select(
      MODES.map((m) => [m, modeLabel(m)]),
      t('Mode'),
    );
    field(t('Mode'), ui.mode, { value: false });
    ui.useRecommended = el(doc, 'button', host, {
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
    ui.recommended = el(doc, 'dl', host, {
      cls: 'gev-dp-stats gev-dp-recommended',
      attrs: { 'data-role': 'recommended' },
    });
    into('plan');
    ui.suiteButton = el(doc, 'button', host, {
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
    ui.suite = el(doc, 'div', host, {
      cls: 'gev-dp-missions gev-dp-suite',
      attrs: { 'data-role': 'suite' },
    });
    into('shots');
    ui.agl = lslider(t('Height above ground'), {
      minM: MIN_AGL_M,
      maxM: AGL_CAP_M,
      stepM: 5,
      stepFt: 10,
    });
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
    into('orbits');
    ui.radius = lslider(t('Orbit radius'), {
      minM: 10,
      maxM: 300,
      stepM: 5,
      stepFt: 10,
    });
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
    ({ row: ui.ringsRow, labelEl: ui.ringsLabel } = field(
      t('Orbit heights ({unit})', { unit: lengthUnit() }),
      ui.rings,
      { value: false },
    ));
    ui.angles = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': t('Viewing angles'),
        placeholder: DEFAULT_RING_ANGLES_DEG.join(', '),
      },
    });
    ({ row: ui.anglesRow } = field(t('Viewing angles (° down)'), ui.angles, {
      value: false,
    }));
    ui.anglesRow.title = t(
      'Each ring is set by how steeply the camera looks down at the target. The height follows from the angle and the radius.',
    );
    ui.outward = select(
      [
        ['on', t('Facing the building, then facing away')],
        ['off', t('Facing the building only')],
      ],
      t('Photos at each building stop'),
    );
    ({ row: ui.outwardRow } = field(t('Photos at each stop'), ui.outward, {
      value: false,
    }));
    ui.outwardPitch = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': t('Outward tilt'),
        placeholder: String(-DEFAULT_OUTWARD_PITCH_DEG),
      },
    });
    ({ row: ui.outwardPitchRow } = field(
      t('Outward tilt (° down)'),
      ui.outwardPitch,
      { value: false },
    ));
    ui.targetHeight = lslider(t('Target height'), {
      minM: 0,
      maxM: 60,
      stepM: 1,
      stepFt: 5,
    });
    ({ row: ui.targetHeightRow, out: ui.targetHeightOut } = field(
      t('Target height'),
      ui.targetHeight,
    ));
    into('obstacles');
    ui.obstacle = lslider(t('Tree / obstacle height'), {
      minM: 0,
      maxM: 60,
      stepM: 1,
      stepFt: 5,
    });
    ({ row: ui.obstacleRow, out: ui.obstacleOut } = field(
      t('Tree / obstacle height'),
      ui.obstacle,
    ));
    ui.obstacleNote = el(doc, 'p', host, {
      cls: 'gev-dp-note gev-dp-obstacle-note',
    });
    ui.obstaclesBox = el(doc, 'div', host, {
      cls: 'gev-dp-targets gev-dp-obstacles',
    });
    const obstacleBar = el(doc, 'div', ui.obstaclesBox, {
      cls: 'gev-dp-row gev-dp-target-bar',
    });
    el(doc, 'span', obstacleBar, {
      cls: 'gev-dp-label',
      text: t('Obstacle heights'),
    });
    const obstacleWrap = el(doc, 'span', obstacleBar, {
      cls: 'gev-dp-control',
    });
    ui.obstacleRefresh = el(doc, 'button', obstacleWrap, {
      cls: 'data-toggle-chip',
      text: t('LOOK UP'),
      attrs: {
        type: 'button',
        'data-action': 'refresh-obstacles',
        title: t(
          'Fetch first-guess heights from open data. Your own edits are kept',
        ),
      },
    });
    ui.obstacleAdd = el(doc, 'button', obstacleWrap, {
      cls: 'data-toggle-chip',
      text: t('ADD'),
      attrs: {
        type: 'button',
        'aria-pressed': 'false',
        'data-action': 'add-obstacle',
        title: t('Click the globe to add an obstacle'),
      },
    });
    ui.obstacleStatus = el(doc, 'p', ui.obstaclesBox, {
      cls: 'gev-dp-note gev-dp-obstacle-status',
      attrs: { 'aria-live': 'polite' },
    });
    ui.obstacleList = el(doc, 'div', ui.obstaclesBox, {
      cls: 'gev-dp-target-list gev-dp-obstacle-list',
    });
    ui.obstacleDisclaimer = el(doc, 'p', ui.obstaclesBox, {
      cls: 'gev-dp-note gev-dp-obstacle-disclaimer',
    });
    el(doc, 'p', ui.obstaclesBox, {
      cls: 'gev-dp-note gev-dp-obstacle-credit',
      text: t(
        'Data: tree canopy height by Meta and WRI (CC BY 4.0), towers from the FAA Digital Obstacle File, buildings from OpenStreetMap contributors.',
      ),
    });
    ui.conflictBox = el(doc, 'div', host, {
      cls: 'gev-dp-targets gev-dp-conflicts',
      attrs: { 'data-role': 'conflicts' },
    });
    into('orbits');
    ui.targetsBox = el(doc, 'div', host, {
      cls: 'gev-dp-targets',
      attrs: { 'data-role': 'orbit-targets' },
    });
    const targetBar = el(doc, 'div', ui.targetsBox, {
      cls: 'gev-dp-row gev-dp-target-bar',
    });
    el(doc, 'span', targetBar, {
      cls: 'gev-dp-label',
      text: t('Orbit targets'),
    });
    const targetWrap = el(doc, 'span', targetBar, { cls: 'gev-dp-control' });
    ui.targetRecommend = el(doc, 'button', targetWrap, {
      cls: 'data-toggle-chip',
      text: t('RECOMMEND'),
      attrs: {
        type: 'button',
        'data-action': 'recommend-targets',
        title: t(
          'Pick the biggest buildings in the survey area, or the area centre when none are known',
        ),
      },
    });
    ui.targetAdd = el(doc, 'button', targetWrap, {
      cls: 'data-toggle-chip',
      text: t('ADD'),
      attrs: {
        type: 'button',
        'aria-pressed': 'false',
        'data-action': 'add-target',
        title: t('Click the globe to add an orbit target'),
      },
    });
    ui.targetList = el(doc, 'div', ui.targetsBox, {
      cls: 'gev-dp-target-list',
    });
    ui.buildingNote = el(doc, 'p', ui.targetsBox, {
      cls: 'gev-dp-note gev-dp-building-note',
      text: t(
        'Building targets come from OpenStreetMap. Trees, towers and power lines are not in that data: check clearance yourself. Not flight-tested.',
      ),
    });

    const pathBar = el(doc, 'div', ui.targetsBox, {
      cls: 'gev-dp-row gev-dp-target-bar',
    });
    el(doc, 'span', pathBar, {
      cls: 'gev-dp-label',
      text: t('Look-at paths'),
    });
    const pathWrap = el(doc, 'span', pathBar, { cls: 'gev-dp-control' });
    ui.pathAdd = el(doc, 'button', pathWrap, {
      cls: 'data-toggle-chip',
      text: t('DRAW PATH'),
      attrs: {
        type: 'button',
        'aria-pressed': 'false',
        'data-action': 'draw-path',
        title: t(
          'Click points along a road, fence or gap. The drone flies it with the camera locked on an orbit target. Click this button again to finish, Esc cancels.',
        ),
      },
    });
    ui.pathList = el(doc, 'div', ui.targetsBox, {
      cls: 'gev-dp-target-list',
      attrs: { 'data-role': 'lookat-paths' },
    });

    into('shots');
    ui.photoMode = select(
      [
        ['waypoint', t('At every waypoint')],
        ['interval', t('By distance, fewer waypoints')],
      ],
      t('Photos'),
    );
    ({ row: ui.photoRow } = field(t('Photos'), ui.photoMode, { value: false }));
    into('flight');
    ui.speed = lslider(t('Speed'), {
      minM: MIN_PLAN_SPEED_MS,
      maxM: 15,
      stepM: 0.1,
      stepFt: 0.5,
      kind: 'speed',
    });
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
    ui.jobs = select(
      [
        ['per-area', t('One job per area')],
        ['whole', t('One job for the whole plan')],
      ],
      t('Processing jobs'),
    );
    field(t('Processing jobs'), ui.jobs, { value: false });
    ui.jobNote = el(doc, 'p', host, { cls: 'gev-dp-note gev-dp-job-note' });

    into('area');
    const takeoffRow = el(doc, 'div', host, { cls: 'gev-dp-row' });
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

    // ---- 3D check: shaded safety zone, height curtain, camera view.
    ui.check = ui.steps.check.details;
    ui.check.setAttribute('data-role', '3d-check');
    ui.check.classList.add('gev-dp-check');
    host = ui.steps.check.body;
    el(doc, 'p', host, {
      cls: 'gev-dp-note gev-dp-check-note',
      text: t(
        'Visual check only: nothing here detects a collision. Look at it over Google Photorealistic 3D, which shows trees. OpenStreetMap buildings have no trees or power lines.',
      ),
    });
    const checkBox = (label, key) => {
      const row = el(doc, 'label', host, { cls: 'gev-dp-row' });
      const box = el(doc, 'input', null, {
        attrs: { type: 'checkbox', 'data-check': key },
      });
      el(doc, 'span', row, { cls: 'gev-dp-label', text: label });
      el(doc, 'span', row, { cls: 'gev-dp-control' }).append(box);
      return box;
    };
    ui.checkEnabled = checkBox(t('Show 3D check'), 'enabled');
    ui.checkZone = checkBox(t('Safety zone'), 'zone');
    ui.checkCurtain = checkBox(t('Height curtain'), 'curtain');
    ui.checkFootprints = checkBox(t('Photo footprints'), 'footprints');
    ui.checkView = select(
      [
        ['one', t('One at a time')],
        ['thinned', t('Several, thinned')],
        ['off', t('Off')],
      ],
      t('Camera view'),
    );
    ui.checkView.setAttribute('data-check', 'frustum');
    const viewRow = el(doc, 'label', host, { cls: 'gev-dp-row' });
    el(doc, 'span', viewRow, { cls: 'gev-dp-label', text: t('Camera view') });
    el(doc, 'span', viewRow, { cls: 'gev-dp-control' }).append(ui.checkView);
    const photoRow = el(doc, 'label', host, { cls: 'gev-dp-row' });
    el(doc, 'span', photoRow, { cls: 'gev-dp-label', text: t('Step photos') });
    const photoWrap = el(doc, 'span', photoRow, { cls: 'gev-dp-control' });
    ui.checkPhoto = slider(t('Step through the photos'), 1, 1, 1);
    ui.checkPhoto.setAttribute('data-check-slider', 'photo');
    photoWrap.append(ui.checkPhoto);
    ui.checkReadout = el(doc, 'p', host, {
      cls: 'gev-dp-note gev-dp-check-readout',
      attrs: { 'data-role': 'check-readout', 'aria-live': 'polite' },
    });
    // One see-through slider per layer type; 0 hides the layer's shading.
    el(doc, 'p', host, {
      cls: 'gev-dp-areas-label',
      text: t('Transparency'),
    });
    ui.alphaSliders = {};
    ui.alphaOuts = {};
    for (const [layer, label] of [
      ['zone', t('Safety zone')],
      ['curtain', t('Height curtain')],
      ['footprint', t('Photo footprints')],
      ['view', t('Camera view pyramid')],
    ]) {
      const range = ALPHA_RANGE[layer];
      const control = slider(
        t('{layer} opacity', { layer: label }),
        Math.round(range.min * 100),
        Math.round(range.max * 100),
        1,
      );
      control.setAttribute('data-check-slider', `alpha-${layer}`);
      const row = el(doc, 'label', host, { cls: 'gev-dp-row' });
      el(doc, 'span', row, { cls: 'gev-dp-label', text: label });
      const wrap = el(doc, 'span', row, { cls: 'gev-dp-control' });
      wrap.append(control);
      ui.alphaOuts[layer] = el(doc, 'output', wrap, {
        cls: 'gev-slider-value',
      });
      ui.alphaSliders[layer] = control;
    }
    ui.alphaReset = el(doc, 'button', host, {
      cls: 'data-toggle-chip',
      text: t('RESET TRANSPARENCY'),
      attrs: {
        type: 'button',
        'data-action': 'reset-transparency',
        title: t('Put the four layers back to their usual look'),
      },
    });

    // DJI model code: part of the aircraft step.
    host = ui.steps.aircraft.body;
    const advanced = el(doc, 'details', host, { cls: 'gev-dp-advanced' });
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

    // Safety zone width: step 5, next to the obstacle heights.
    host = ui.steps.obstacles.body;
    const widthRow = el(doc, 'label', host, { cls: 'gev-dp-row' });
    el(doc, 'span', widthRow, {
      cls: 'gev-dp-label',
      text: t('Zone half-width'),
    });
    const widthWrap = el(doc, 'span', widthRow, { cls: 'gev-dp-control' });
    ui.checkWidth = lslider(t('Zone half-width'), {
      minM: MIN_ZONE_HALF_WIDTH_M,
      maxM: MAX_ZONE_HALF_WIDTH_M,
      stepM: 1,
      stepFt: 5,
    });
    ui.checkWidth.setAttribute('data-check-slider', 'width');
    widthWrap.append(ui.checkWidth);
    ui.checkWidthOut = el(doc, 'output', widthWrap, {
      cls: 'gev-slider-value',
    });

    // Plan step: totals, warnings. Export step: the KMZ buttons and the note.
    host = ui.steps.plan.body;
    ui.stats = el(doc, 'dl', host, { cls: 'gev-dp-stats' });
    ui.warnings = el(doc, 'ul', host, { cls: 'gev-dp-warnings' });
    host = ui.steps.export.body;
    ui.missions = el(doc, 'div', host, { cls: 'gev-dp-missions' });
    ui.note = el(doc, 'p', host, {
      cls: 'gev-dp-note',
      text: t(
        'NOT FLIGHT-TESTED: check airspace and local rules, keep the aircraft in sight, and fly the first mission short and supervised.',
      ),
    });
    ui.summary = el(doc, 'div', null, {
      cls: 'gev-dp-summary',
      attrs: { 'data-role': 'plan-summary', 'aria-live': 'polite' },
    });
    ui.summary.hidden = true;
    ui.suite.after(ui.summary);
    ui.applyUnitRanges();

    // ------------------------------------------------------ wiring --
    const o = state.options;
    const onInput = (control, apply) =>
      control.addEventListener('input', () => {
        apply();
        syncControls();
        schedule();
      });
    const c = state.check;
    for (const [box, key] of [
      [ui.checkEnabled, 'enabled'],
      [ui.checkZone, 'zone'],
      [ui.checkCurtain, 'curtain'],
      [ui.checkFootprints, 'footprints'],
    ]) {
      box.addEventListener('change', () => {
        c[key] = Boolean(box.checked);
        pushCheck();
        syncCheckUi();
      });
    }
    ui.checkView.addEventListener('change', () => {
      c.frustum = ui.checkView.value;
      pushCheck();
      syncCheckUi();
    });
    ui.checkPhoto.addEventListener('input', () => {
      c.index = Math.max(0, Number(ui.checkPhoto.value) - 1);
      pushCheck();
      syncCheckUi();
    });
    // The zone is rebuilt once the slider settles, not on every pixel.
    ui.checkWidth.addEventListener('input', () => {
      c.halfWidthM = lengthToM(ui.checkWidth.value);
      ui.checkWidthOut.textContent = heightText(c.halfWidthM);
      renderStepLines();
      clearTimeout(checkTimer);
      checkTimer = setTimeout(pushCheck, CHECK_SLIDER_DELAY_MS);
    });
    for (const layer of Object.keys(ALPHA_RANGE)) {
      ui.alphaSliders[layer].addEventListener('input', () => {
        c.alpha[layer] = clampAlpha(
          layer,
          Number(ui.alphaSliders[layer].value) / 100,
        );
        writeAlpha(unitStorage, c.alpha);
        ui.alphaOuts[layer].textContent =
          `${Math.round(c.alpha[layer] * 100)}%`;
        clearTimeout(checkTimer);
        checkTimer = setTimeout(pushCheck, CHECK_SLIDER_DELAY_MS);
      });
    }
    ui.alphaReset.addEventListener('click', () => {
      c.alpha = { ...DEFAULT_ALPHA };
      writeAlpha(unitStorage, c.alpha);
      pushCheck();
      syncCheckUi();
    });
    for (const system of ['ft', 'm']) {
      ui.unitButtons[system].addEventListener('click', () =>
        chooseUnits(system),
      );
    }
    syncCheckUi();
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
    onInput(ui.agl, () => (o.aglM = lengthToM(ui.agl.value)));
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
    onInput(ui.radius, () => (o.orbitRadiusM = lengthToM(ui.radius.value)));
    onInput(
      ui.targetHeight,
      () => (o.orbitTargetHeightM = lengthToM(ui.targetHeight.value)),
    );
    onInput(
      ui.obstacle,
      () => (o.obstacleHeightM = lengthToM(ui.obstacle.value)),
    );
    ui.targetRecommend.addEventListener('click', () => recommendTargets());
    ui.obstacleRefresh.addEventListener('click', () =>
      syncObstacles({ force: true }),
    );
    ui.obstacleAdd.addEventListener('click', () => startObstaclePick());
    ui.targetAdd.addEventListener('click', () => startTargetPick());
    ui.rings.addEventListener('change', () => {
      // An entry whose text is unchanged keeps its exact metre value, so
      // editing one height never nudges the others through foot rounding.
      const kept = new Map(
        (o.orbitHeightsM ?? []).map((m) => [lengthField(m), m]),
      );
      const list = ui.rings.value
        .split(/[\s,;]+/)
        .filter((text) => Number(text) > 0 && Number.isFinite(Number(text)))
        .map((text) =>
          kept.has(String(Number(text)))
            ? kept.get(String(Number(text)))
            : lengthToM(Number(text)),
        );
      o.orbitHeightsM = list.length ? list : null;
      // Typed heights replace the viewing angles; clearing them goes back.
      o.orbitRingMode = list.length ? 'heights' : 'angles';
      syncControls();
      schedule();
    });
    ui.angles.addEventListener('change', () => {
      const list = ui.angles.value
        .split(/[\s,;]+/)
        .filter((text) => text !== '' && Number.isFinite(Number(text)));
      o.orbitAnglesDeg = list.length ? normalizeRingAngles(list) : null;
      o.orbitRingMode = 'angles';
      o.orbitHeightsM = null;
      syncControls();
      schedule();
    });
    ui.outward.addEventListener('change', () => {
      o.orbitOutward = ui.outward.value !== 'off';
      syncControls();
      schedule();
    });
    ui.outwardPitch.addEventListener('change', () => {
      const n = Number(ui.outwardPitch.value);
      o.orbitOutwardPitchDeg = Number.isFinite(n)
        ? Math.min(
            MAX_OUTWARD_PITCH_DEG,
            Math.max(MIN_OUTWARD_PITCH_DEG, -Math.abs(n)),
          )
        : DEFAULT_OUTWARD_PITCH_DEG;
      syncControls();
      schedule();
    });
    ui.pathAdd.addEventListener('click', () => toggleDrawPath());
    ui.photoMode.addEventListener('change', () => {
      o.photoMode = ui.photoMode.value;
      schedule();
    });
    onInput(ui.speed, () => (o.speedMs = speedToMs(ui.speed.value)));
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

  /** The one-line summary each step shows while it is collapsed. */
  function renderStepLines() {
    if (destroyed || !ui.steps) return;
    const o = state.options;
    const preset = getPreset(o.presetId);
    const dot = ' · ';
    const count = state.areas.length;
    const orbit = o.pattern === 'orbit';
    const result = state.result;
    const patternName = {
      grid: t('Grid'),
      double: t('Double grid'),
      orbit: t('Orbit'),
    }[o.pattern];
    const targets = (o.orbitTargets ?? []).filter((x) => x.active !== false);
    const lines = {
      area: [
        count ? t('areas: {n}', { n: num(count) }) : t('Nothing drawn yet'),
        state.takeoff ? t('takeoff set') : t('takeoff at the centre'),
      ],
      aircraft: [preset.name, `1/${num(o.shutterDenominator)} s`],
      shots: [
        modeLabel(modeFor(o)),
        patternName,
        orbit ? '' : heightText(Math.min(o.aglM, AGL_CAP_M)),
        orbit ? '' : `${num(o.frontOverlap)}% / ${num(o.sideOverlap)}%`,
      ],
      orbits: [
        lengthText(o.orbitRadiusM ?? result?.plan?.options?.orbitRadiusM ?? 40),
        t('targets: {n}', { n: num(targets.length) }),
      ],
      obstacles: [
        t('trees {h}', { h: heightText(o.obstacleHeightM) }),
        t('marked: {n}', { n: num(obstacleStore.list().length) }),
        t('zone ±{w}', { w: heightText(state.check.halfWidthM) }),
      ],
      flight: [
        speedText(o.speedMs),
        t('{n} min battery', { n: num(o.batteryMin) }),
        state.jobGrouping === 'whole' ? t('one job') : t('job per area'),
      ],
      plan: result
        ? [
            t('photos: {n}', { n: num(result.totals.photoCount) }),
            durationText(result.totals.durationS),
            t('missions: {n}', { n: num(result.totals.missionCount) }),
          ]
        : [t('Not planned yet')],
      check: state.check.enabled
        ? [
            t('on'),
            ...[
              [state.check.zone, t('zone')],
              [state.check.curtain, t('curtain')],
              [state.check.footprints, t('footprints')],
            ]
              .filter(([on]) => on)
              .map(([, name]) => name),
          ]
        : [t('off')],
      export: result
        ? [t('missions: {n}', { n: num(result.totals.missionCount) })]
        : [t('Nothing to save yet')],
    };
    for (const key of STEP_KEYS) {
      ui.steps[key].line.textContent = lines[key].filter(Boolean).join(dot);
    }
  }

  /** Switch between feet and metres: shown and typed values only. */
  function chooseUnits(system) {
    setUnitSystem(system);
    writeUnitSystem(unitStorage, system);
    ui.applyUnitRanges();
    // Rebuild the obstacle list even while a height box has focus.
    obstacleTyping = false;
    render();
  }

  /** A length as typed in the chosen unit: a short plain number. */
  const lengthField = (metres, digits = 0) => {
    // Metres show exactly as stored (to the centimetre); feet round to the
    // asked digits.
    const places = lengthUnit() === 'm' ? Math.max(digits, 2) : digits;
    return String(
      Math.round(lengthFromM(metres) * 10 ** places) / 10 ** places,
    );
  };

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
      t('up to {v}', { v: speedText(preset.maxSpeedMs, 0) }),
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
    row(t('Speed'), speedText(rec.speedMs));
    if (rec.pattern !== 'orbit') row(t('Height'), heightText(rec.aglM));
    else row(t('Viewing angles (° down)'), DEFAULT_RING_ANGLES_DEG.join(', '));
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

  let checkTimer = null;
  /** Hand the 3D check options (and the camera of the chosen aircraft) over. */
  function pushCheck() {
    clearTimeout(checkTimer);
    if (destroyed) return;
    const c = state.check;
    preview.setCheck({
      enabled: c.enabled,
      zone: c.zone,
      halfWidthM: c.halfWidthM,
      curtain: c.curtain,
      footprints: c.footprints,
      frustum: c.frustum,
      index: c.index,
      frame: getPreset(state.options.presetId),
      alpha: c.alpha,
    });
  }

  /** Keep the 3D check controls and the photo readout true to the globe. */
  function syncCheckUi() {
    if (destroyed || !ui.check) return;
    const c = state.check;
    ui.checkEnabled.checked = c.enabled;
    ui.checkZone.checked = c.zone;
    ui.checkCurtain.checked = c.curtain;
    ui.checkFootprints.checked = c.footprints;
    ui.checkView.value = c.frustum;
    ui.checkWidth.value = lengthField(c.halfWidthM);
    ui.checkWidthOut.textContent = heightText(c.halfWidthM);
    for (const layer of Object.keys(ALPHA_RANGE)) {
      ui.alphaSliders[layer].value = String(Math.round(c.alpha[layer] * 100));
      ui.alphaOuts[layer].textContent = `${Math.round(c.alpha[layer] * 100)}%`;
      ui.alphaSliders[layer].disabled = !c.enabled;
    }
    ui.alphaReset.disabled = !c.enabled;
    renderStepLines();
    for (const control of [
      ui.checkZone,
      ui.checkWidth,
      ui.checkCurtain,
      ui.checkFootprints,
      ui.checkView,
    ]) {
      control.disabled = !c.enabled;
    }
    const info = preview.checkInfo();
    ui.checkPhoto.max = String(Math.max(1, info.count));
    ui.checkPhoto.value = String(info.index + 1);
    ui.checkPhoto.disabled =
      !c.enabled || c.frustum !== 'one' || info.count < 1;
    const cur = info.current;
    if (!c.enabled || !cur) {
      ui.checkReadout.textContent = t('No photos to show yet');
      return;
    }
    const mission = /^mission-(\d+)$/.exec(cur.passId);
    const pass = mission
      ? t('Mission {n}', { n: mission[1] })
      : (state.suite?.passes.find((p) => p.id === cur.passId)?.label ??
        cur.passId);
    const fp = cur.footprint;
    ui.checkReadout.textContent = t(
      'Photo {n} of {total}: {pass}, tilt {pitch} deg, height {h}, covers {w} by {d}',
      {
        n: num(info.index + 1),
        total: num(info.count),
        pass,
        pitch: num(cur.pitchDeg ?? -90),
        h: heightText(cur.aglM ?? 0),
        w: fp ? heightText(fp.widthM) : '-',
        d: fp ? heightText(fp.depthM) : '-',
      },
    );
    if (fp?.clipped) {
      ui.checkReadout.textContent += ` ${t('Part of the view is above the horizon, so the far edge is cut short.')}`;
    }
  }

  function syncControls() {
    const o = state.options;
    const preset = getPreset(o.presetId);
    ui.preset.value = o.presetId;
    ui.mode.value = modeFor(o);
    ui.shutter.value = String(o.shutterDenominator);
    ui.presetInfo.textContent = presetSummary(preset);
    renderRecommended(preset, modeFor(o));
    for (const system of ['ft', 'm']) {
      ui.unitButtons[system].setAttribute(
        'aria-pressed',
        String(lengthUnit() === system),
      );
    }
    ui.agl.value = lengthField(o.aglM);
    ui.aglOut.textContent = heightText(Math.min(o.aglM, AGL_CAP_M));
    ui.aglRow.title = t('Hard cap {cap} above ground', {
      cap: lengthText(AGL_CAP_M),
    });
    ui.ringsLabel.textContent = t('Fixed heights ({unit}, optional)', {
      unit: lengthUnit(),
    });
    ui.rings.setAttribute?.(
      'placeholder',
      [40, 80].map((m) => lengthField(m)).join(', '),
    );
    ui.obstacleDisclaimer.textContent = t(
      'Heights are estimates from open data or numbers you set, not a survey. Trees grow. Power lines and guy wires are in none of these sources. The plan keeps {margin} above each column. Drag the yellow dot on a column, or type a height. Compare the columns with the 3D view by eye. This is a visual check, not flight-tested.',
      { margin: lengthText(OBSTACLE_MARGIN_M) },
    );
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
    ui.radius.value = lengthField(radius);
    ui.radiusOut.textContent = lengthText(radius);
    ui.rings.value = (o.orbitHeightsM ?? [])
      .map((m) => lengthField(m))
      .join(', ');
    ui.angles.value = (o.orbitAnglesDeg ?? []).map((a) => String(a)).join(', ');
    ui.outward.value = o.orbitOutward === false ? 'off' : 'on';
    ui.outwardPitch.value = String(
      Math.abs(o.orbitOutwardPitchDeg ?? DEFAULT_OUTWARD_PITCH_DEG),
    );
    ui.targetHeight.value = lengthField(o.orbitTargetHeightM);
    ui.targetHeightOut.textContent = lengthText(o.orbitTargetHeightM);
    ui.obstacle.value = lengthField(o.obstacleHeightM);
    ui.obstacleOut.textContent = lengthText(o.obstacleHeightM);
    ui.photoMode.value = o.photoMode;
    ui.speed.value = String(Math.round(speedFromMs(o.speedMs) * 10) / 10);
    ui.speedOut.textContent = speedText(o.speedMs);
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
    ui.anglesRow.hidden = !orbit;
    ui.outwardRow.hidden = !orbit;
    ui.outwardPitchRow.hidden = !orbit || o.orbitOutward === false;
    ui.targetHeightRow.hidden = !orbit;
    const orbits = orbitsShown();
    ui.obstacleRow.hidden = !orbits;
    ui.obstacleNote.hidden = !orbits;
    ui.targetsBox.hidden = !orbits;
    // Step 4 only exists while orbits are in the plan.
    ui.steps.orbits.details.hidden = !orbits;
    if (orbits) {
      ui.obstacleNote.textContent = t(
        'Orbits fly at least {min} above ground: tree height plus {margin}, so the drone clears the trees.',
        {
          min: lengthText(
            Math.max(MIN_AGL_M, o.obstacleHeightM + OBSTACLE_MARGIN_M),
          ),
          margin: lengthText(OBSTACLE_MARGIN_M),
        },
      );
    }
    const t0 = state.result?.plan?.takeoff ?? state.takeoff;
    const where = state.takeoff ? '' : ` · ${t('centre')}`;
    ui.takeoffText.textContent = t0
      ? `${num(t0.lat, 5)}, ${num(t0.lon, 5)}${where}`
      : '';
    ui.takeoffReset.disabled = !state.takeoff;
    ui.jobs.value = state.jobGrouping;
    const jobNote = orbit
      ? t(
          'Orbit flies every active target in one mission, climbing above the trees between targets.',
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
    renderTargets();
    renderPaths();
    renderObstacleStatus();
    renderObstacles();
    renderStepLines();
  }

  function renderTargets() {
    ui.targetList.replaceChildren();
    if (!orbitsShown()) return;
    const list = state.options.orbitTargets ?? [];
    if (!list.length) {
      el(doc, 'p', ui.targetList, {
        cls: 'gev-dp-note',
        text: state.areas.length
          ? t('No orbit targets. RECOMMEND picks some, ADD places one.')
          : t('Draw a box on the globe first'),
      });
      return;
    }
    for (const target of list) {
      const row = el(doc, 'div', ui.targetList, {
        cls: 'gev-dp-area gev-dp-target',
        attrs: { 'data-target': target.id },
      });
      const on = el(doc, 'input', row, {
        attrs: {
          type: 'checkbox',
          'aria-label': t('Orbit this target'),
          'data-toggle-target': target.id,
        },
      });
      on.checked = target.active !== false;
      on.addEventListener('change', () => {
        setOrbitTargetActive(target.id, on.checked);
      });
      el(doc, 'span', row, {
        cls: 'gev-dp-area-kind',
        text: target.label || target.id,
        attrs: {
          title:
            `${num(target.lat, 5)}, ${num(target.lon, 5)}` +
            (target.radiusM != null
              ? ` · r ${lengthText(target.radiusM)}`
              : ''),
        },
      });
      const remove = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('Remove'),
        attrs: { type: 'button', 'data-remove-target': target.id },
      });
      remove.addEventListener('click', () => {
        removeOrbitTarget(target.id);
      });
      // Its own size and open arc. The size starts at the automatic value.
      const planRadius =
        state.options.orbitRadiusM ??
        state.result?.plan?.options?.orbitRadiusM ??
        40;
      const radius = target.radiusM ?? planRadius;
      const size = el(doc, 'input', row, {
        cls: 'pp-text-input gev-dp-text gev-dp-target-size',
        attrs: {
          type: 'text',
          inputmode: 'decimal',
          autocomplete: 'off',
          'aria-label': t('Orbit diameter ({unit})', { unit: lengthUnit() }),
          title: t('Orbit diameter ({unit})', { unit: lengthUnit() }),
          'data-target-size': target.id,
        },
      });
      size.value = lengthField(radius * 2);
      size.addEventListener('change', () => {
        const d = lengthToM(size.value);
        updateOrbitTarget(target.id, {
          radiusM:
            Number.isFinite(d) && d > 0
              ? Math.min(300, Math.max(10, d / 2))
              : undefined,
        });
      });
      const arc = (key, label) => {
        const input = el(doc, 'input', row, {
          cls: 'pp-text-input gev-dp-text gev-dp-target-arc',
          attrs: {
            type: 'text',
            inputmode: 'numeric',
            autocomplete: 'off',
            'aria-label': label,
            title: label,
            placeholder: '—',
            'data-target-blocked': `${target.id}:${key}`,
          },
        });
        input.value = target.blocked ? String(target.blocked[key]) : '';
        input.addEventListener('change', () => {
          const other = key === 'fromDeg' ? 'toDeg' : 'fromDeg';
          const mine = input.value.trim() === '' ? null : Number(input.value);
          const theirs = target.blocked ? target.blocked[other] : null;
          const bothSet =
            mine !== null && Number.isFinite(mine) && theirs !== null;
          updateOrbitTarget(target.id, {
            blocked: bothSet
              ? { [key]: mine, [other]: theirs }
              : mine !== null && Number.isFinite(mine)
                ? { [key]: mine, [other]: mine === 0 ? 90 : 0 }
                : undefined,
          });
        });
      };
      arc('fromDeg', t('Blocked sector from (° compass)'));
      arc('toDeg', t('Blocked sector to (° compass)'));
    }
  }

  function renderPaths() {
    ui.pathList.replaceChildren();
    if (!orbitsShown()) return;
    const list = state.options.lookAtPaths ?? [];
    const targets = (state.options.orbitTargets ?? []).filter(
      (x) => x.active !== false,
    );
    for (const path of list) {
      const row = el(doc, 'div', ui.pathList, {
        cls: 'gev-dp-area gev-dp-target',
        attrs: { 'data-lookat-path': path.id },
      });
      const on = el(doc, 'input', row, {
        attrs: {
          type: 'checkbox',
          'aria-label': t('Fly this path'),
          'data-toggle-path': path.id,
        },
      });
      on.checked = path.active !== false;
      on.addEventListener('change', () =>
        updateLookAtPath(path.id, { active: on.checked }),
      );
      el(doc, 'span', row, {
        cls: 'gev-dp-area-kind',
        text: `${path.label || path.id} · ${t('points: {n}', { n: num(path.points.length) })}`,
      });
      const pick = el(doc, 'select', row, {
        cls: 'pp-select gev-field gev-field--compact',
        attrs: {
          'aria-label': t('Look at'),
          title: t('Look at'),
          'data-path-target': path.id,
        },
      });
      for (const tg of targets) {
        el(doc, 'option', pick, {
          text: tg.label || tg.id,
          attrs: { value: tg.id },
        });
      }
      pick.value = targets.some((x) => x.id === path.targetId)
        ? path.targetId
        : (targets[0]?.id ?? '');
      pick.addEventListener('change', () =>
        updateLookAtPath(path.id, { targetId: pick.value }),
      );
      const height = el(doc, 'input', row, {
        cls: 'pp-text-input gev-dp-text gev-dp-target-size',
        attrs: {
          type: 'text',
          inputmode: 'decimal',
          autocomplete: 'off',
          'aria-label': t('Path height ({unit})', { unit: lengthUnit() }),
          title: t('Path height ({unit})', { unit: lengthUnit() }),
          'data-path-height': path.id,
        },
      });
      height.value = lengthField(path.aglM ?? 40);
      height.addEventListener('change', () => {
        const h = lengthToM(height.value);
        updateLookAtPath(path.id, {
          aglM: Number.isFinite(h) && h > 0 ? h : null,
        });
      });
      const remove = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('Remove'),
        attrs: { type: 'button', 'data-remove-path': path.id },
      });
      remove.addEventListener('click', () => removeLookAtPath(path.id));
    }
  }

  /** Warn-only check of the planned route against buildings and obstacles. */
  function renderConflicts() {
    ui.conflictBox.replaceChildren();
    const plan = state.result?.plan;
    if (!plan?.legs?.length) return;
    const footprints = footprintCache.get(areasKey()) ?? [];
    const found = checkConflicts({
      legs: plan.legs,
      buildings: footprints,
      obstacles: obstacleStore.list(),
      zoneHalfWidthM: state.check.halfWidthM,
    });
    state.conflicts = found;
    el(doc, 'p', ui.conflictBox, {
      cls: 'gev-dp-note',
      attrs: { 'data-role': 'conflict-disclaimer' },
      text: t(
        'This check only knows OpenStreetMap buildings and the obstacles you entered. It does NOT see trees, power lines or towers, and it never changes your route.',
      ),
    });
    if (!found.conflicts.length && !found.unknownHeight.length) {
      el(doc, 'p', ui.conflictBox, {
        cls: 'gev-dp-note',
        text: t('No conflicts found with the buildings and obstacles known.'),
        attrs: { 'data-role': 'conflict-none' },
      });
      return;
    }
    const lead = (b) => b.label || b.id || t('building');
    for (const c of found.conflicts.slice(0, 8)) {
      el(doc, 'p', ui.conflictBox, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'conflict' },
        text: t(
          'Conflict: the route passes {name} at {flown}, which needs {need}',
          {
            name: lead(c),
            flown: lengthText(c.flownAglM),
            need: lengthText(c.needAglM),
          },
        ),
      });
    }
    if (found.conflicts.length > 8) {
      el(doc, 'p', ui.conflictBox, {
        cls: 'gev-dp-note',
        text: t('And {n} more conflicts', {
          n: num(found.conflicts.length - 8),
        }),
      });
    }
    if (found.unknownHeight.length) {
      el(doc, 'p', ui.conflictBox, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'conflict-unknown' },
        text: t(
          '{n} buildings near the route have no height in the data: check them yourself',
          { n: num(found.unknownHeight.length) },
        ),
      });
    }
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
    pushCheck();
    syncCheckUi();
    ui.stats.replaceChildren();
    ui.warnings.replaceChildren();
    ui.missions.replaceChildren();
    renderSuite();
    renderSummary();
    renderConflicts();
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
    renderStepLines();
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
    if (plan.orbit) {
      const worst = Math.max(
        0,
        ...plan.orbit.rings.map((r) => r.obstructionRadiusM),
      );
      stat(
        t('Fly-over height'),
        t('{min} min over {obstacle} trees', {
          min: lengthText(plan.orbit.minAglM),
          obstacle: lengthText(plan.orbit.obstacleHeightM),
        }),
      );
      stat(
        t('Tree-free zone'),
        `${lengthText(worst)} ${t('around each target')}`,
      );
      stat(t('Orbit targets'), num(plan.orbit.targets.length));
    }
    stat(t('Waypoints'), missions.map((m) => num(m.waypointCount)).join(' / '));
    stat(t('Speed'), speedText(plan.speedMs));
    stat(
      t('Terrain range'),
      result.ground.known ? lengthText(totals.terrainRangeM) : t('unknown'),
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
    const blocked = () =>
      destroyed ||
      !state.areas.length ||
      state.suiteBusy ||
      state.busy ||
      state.dirty;
    if (blocked() || suiteSettling) return;
    // Settle everything the planner reads before planning: building
    // footprints (orbit targets, obstacles) and the open-data look-up. Their
    // late answers would otherwise replan and silently drop the suite.
    suiteSettling = true;
    ui.suiteButton.disabled = true;
    try {
      if (!state.orbitTargetsTouched) await buildingsFor(areasKey());
      await obstaclePending?.catch(() => {});
      if (!destroyed && state.dirty) await replan();
    } finally {
      suiteSettling = false;
    }
    if (blocked()) {
      render();
      return;
    }
    const token = ++suiteToken;
    state.suiteBusy = true;
    state.suite = null;
    // The orbit pass flies the orbit targets: keep the list in view and in
    // step with the areas from here on.
    state.orbitsPlanned = true;
    syncOrbitTargets();
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
        const obstacleM = await sampleObstacleGround(plan);
        if (destroyed || token !== suiteToken) return;
        const byId = [];
        points.forEach((w, i) => {
          byId[w.id] = ground.wpM[i];
        });
        passes.push({
          id: pass.id,
          label: pass.label,
          result: assembleAreaPlan(plan, { ...ground, wpM: byId, obstacleM }),
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
    // The panel scrolls and the plan buttons sit well down it: bring the
    // totals into view so the answer to PLAN ALL is on screen.
    if (!ui.summary.hidden) ui.summary.scrollIntoView?.({ block: 'nearest' });
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

  /**
   * One line for the whole plan: time in the air, flights and batteries.
   * Single plan, or the grand total over every pass that planned (hidden
   * passes are still in the plan). One KMZ is one flight.
   */
  function renderSummary() {
    ui.summary.replaceChildren();
    ui.summary.hidden = true;
    // A plan being rebuilt has no trustworthy totals yet.
    if (state.suiteBusy || state.busy || state.dirty) return;
    const sum = planSummary({
      suite: state.suite,
      result: state.result,
      batteryMin: state.options.batteryMin,
    });
    if (!sum) return;
    const { durationS, flights, batteries, minutes, failed } = sum;
    ui.summary.hidden = false;
    el(doc, 'p', ui.summary, {
      cls: 'gev-dp-summary-line',
      text: t(
        'Total: {time} flying · {flights} · {batteries} ({min} min each)',
        {
          time: durationText(durationS),
          flights:
            flights === 1
              ? t('{count} flight', { count: num(flights) })
              : t('{count} flights', { count: num(flights) }),
          batteries:
            batteries === 1
              ? t('about {count} battery', { count: num(batteries) })
              : t('about {count} batteries', { count: num(batteries) }),
          min: num(minutes),
        },
      ),
    });
    if (sum.sharedBatteries) {
      el(doc, 'p', ui.summary, {
        cls: 'gev-dp-note',
        text: t(
          'Some flights are split by the 200-waypoint limit and can share a battery.',
        ),
      });
    }
    if (failed.length) {
      el(doc, 'p', ui.summary, {
        cls: 'gev-dp-note',
        text: t('Not in this total (not planned): {passes}', {
          passes: failed.join(', '),
        }),
      });
    }
  }

  function renderSuite() {
    ui.suite.replaceChildren();
    ui.suiteButton.disabled =
      !state.areas.length || state.suiteBusy || state.busy || suiteSettling;
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
        syncCheckUi();
      });
      const swatch = el(doc, 'span', row, { cls: 'gev-dp-swatch' });
      swatch.setAttribute('aria-hidden', 'true');
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
      controllerIds: state.controllerIds,
    });
    for (const pass of state.suite.passes)
      if (pass.result) checkBuilt(pass.result);
    const stamp = kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
    downloadFile(`${stamp}-all-passes.zip`, bytes, 'application/zip');
    return true;
  }

  /** Run the DJI compatibility check on the KMZ files of a result. */
  function checkBuilt(result) {
    const files = result.missions.slice(0, 12).map((mission, i) => ({
      bytes: buildKmz(mission, result.plan, { wpml: wpmlOverride() }),
      name: `mission-${i + 1}.kmz`,
    }));
    library?.checkExport(files, t('this export'));
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
    // A controller mission id names the file <UUID>.kmz, as DJI Fly does.
    const fileName = state.controllerIds[index]
      ? `${state.controllerIds[index]}.kmz`
      : kmzFileName(
          same.indexOf(mission),
          same.length,
          when,
          named ? mission.jobName : '',
        );
    downloadFile(fileName, bytes, 'application/vnd.google-earth.kmz');
    library?.checkExport([{ bytes, name: fileName }], fileName);
    return true;
  }

  function downloadAll(when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed()) return false;
    const bytes = buildBundleZip(result, {
      when,
      wpml: wpmlOverride(),
      controllerIds: state.controllerIds,
    });
    const stamp = kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
    downloadFile(`${stamp}-all.zip`, bytes, 'application/zip');
    checkBuilt(result);
    return true;
  }

  // --------------------------------------------------------- open/close --
  function setPanelOpen(open) {
    if (!open) return;
    panel.hidden = false;
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
    targetTool?.cancel('close');
    pathTool?.cancel('close');
    obstacleTool?.cancel('close');
    state.box = null;
    state.areas = [];
    state.nextArea = 1;
    state.takeoff = null;
    state.orbitsPlanned = false;
    state.options.orbitTargets = [];
    state.options.lookAtPaths = [];
    state.orbitTargetsTouched = false;
    footprintCache.clear();
    footprintPromises.clear();
    resetObstacles();
    state.result = null;
    state.error = null;
    state.busy = false;
    state.dirty = false;
    suiteToken += 1;
    state.suite = null;
    state.suiteHidden = new Set();
    state.controllerIds = [];
    state.imports = [];
    state.suiteBusy = false;
    state.ack = false;
    terrainCache.clear();
    preview.clear();
    library?.renderImports();
    // The card stays on the rail as a collapsed launcher.
    if (!panel.classList.contains('collapsed')) {
      // Through the rail's own button so its arrow and aria state follow.
      entry?.click?.();
      panel.classList.add('collapsed');
    }
    status('');
  }

  // The rail's own collapse button is the launcher: expanding the card opens
  // the planner (and starts a box), collapsing it only puts the tools down.
  // The plan is kept so a collapse forced by the rail layout loses nothing.
  const syncOpenToCard = () => {
    if (destroyed) return;
    const expanded = !panel.classList.contains('collapsed');
    if (expanded && !state.open) {
      state.open = true;
      render();
      if (!state.box) drawBox();
    } else if (!expanded && state.open) {
      state.open = false;
      boxTool?.cancel('close');
      polygonTool?.cancel('close');
      takeoffTool?.cancel('close');
      targetTool?.cancel('close');
      pathTool?.cancel('close');
      obstacleTool?.cancel('close');
    }
  };
  const onEntry = () => queueMicrotask(syncOpenToCard);
  entry?.addEventListener('click', onEntry);
  const cardObserver =
    typeof globalThis.MutationObserver === 'function'
      ? new globalThis.MutationObserver(syncOpenToCard)
      : null;
  cardObserver?.observe(panel, {
    attributes: true,
    attributeFilter: ['class'],
  });

  build();
  syncControls();

  // ---------------------------------------------------------- plan library --
  let library = null;

  /** Restore a stored plan (already validated by readPlan) and plan again. */
  async function loadPlanDocument(raw) {
    const plan = readPlan(raw);
    boxTool?.cancel('load');
    polygonTool?.cancel('load');
    takeoffTool?.cancel('load');
    targetTool?.cancel('load');
    pathTool?.cancel('load');
    obstacleTool?.cancel('load');
    clearTimeout(timer);
    planToken += 1;
    suiteToken += 1;
    state.open = true;
    setPanelOpen(true);
    state.areas = plan.areas;
    state.nextArea = plan.nextArea;
    state.box = plan.areas.at(-1)?.box ?? null;
    state.jobGrouping = plan.jobGrouping;
    state.takeoff = plan.takeoff;
    Object.assign(state.options, plan.options);
    state.options.orbitTargets = plan.orbitTargets;
    state.options.lookAtPaths = plan.lookAtPaths ?? [];
    state.orbitTargetsTouched = plan.orbitTargetsTouched;
    state.orbitsPlanned = plan.suite.planned;
    state.wpml = { ...plan.wpml };
    state.controllerIds = plan.controllerIds;
    state.imports = plan.imports.map((i) => ({ ...i, hidden: false }));
    state.suite = null;
    state.suiteBusy = false;
    state.suiteHidden = new Set(plan.suite.hidden);
    state.result = null;
    state.error = null;
    state.ack = false;
    state.dirty = true;
    footprintCache.clear();
    footprintPromises.clear();
    obstacleMuted = true;
    obstacleStore.load(plan.obstacles);
    obstacleMuted = false;
    showCommitted();
    syncControls();
    render();
    await replan();
    if (plan.suite.planned && state.areas.length) await planSuite();
    return true;
  }

  library = mountLibrary({
    doc,
    container: ui.library,
    client: libraryClient,
    status,
    host: {
      preset: () => getPreset(state.options.presetId),
      droneEnum: () => state.wpml.droneEnumValue,
      snapshot: () =>
        serializePlan(state, {
          controllerIds: state.controllerIds,
          imports: state.imports,
        }),
      load: loadPlanDocument,
      imports: () => state.imports,
      addImport: (item) => state.imports.push({ ...item, hidden: false }),
      removeImport: (id) => {
        state.imports = state.imports.filter((i) => i.id !== id);
      },
      controllerIds: () => state.controllerIds,
      setControllerIds: (ids) => {
        state.controllerIds = ids;
      },
      showOnMap: (items) => preview.showImports(items),
      download: (name, bytes, type) => downloadFile(name, bytes, type),
    },
  });

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
      // Asking for fixed heights means fixed heights; null goes back to angles.
      if (!Object.hasOwn(patch, 'orbitRingMode'))
        o.orbitRingMode = patch.orbitHeightsM?.length ? 'heights' : 'angles';
      plan = true;
    }
    for (const key of [
      'orbitRingMode',
      'orbitAnglesDeg',
      'orbitOutward',
      'orbitOutwardPitchDeg',
      'lookAtPaths',
    ]) {
      if (Object.hasOwn(patch, key)) {
        o[key] = patch[key];
        plan = true;
      }
    }
    if (Object.hasOwn(patch, 'obstacleHeightM')) {
      o.obstacleHeightM = patch.obstacleHeightM;
      plan = true;
    }
    if (Object.hasOwn(patch, 'orbitTargetHeightM')) {
      o.orbitTargetHeightM = patch.orbitTargetHeightM;
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
    library: () => library,
    loadPlan: loadPlanDocument,
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
    updateOrbitTarget,
    toggleDrawPath,
    addLookAtPath,
    updateLookAtPath,
    removeLookAtPath,
    clearTakeoff,
    startTakeoffPick,
    startTargetPick,
    addOrbitTarget,
    startObstaclePick,
    obstacles: {
      list: () => obstacleStore.list(),
      add: addObstacle,
      remove: (id) => obstacleStore.remove(id),
      setHeight: (id, h) => obstacleStore.setHeight(id, h),
      reset: (id) => obstacleStore.reset(id),
      refresh: () => syncObstacles({ force: true }),
    },
    removeOrbitTarget,
    setOrbitTargetActive,
    recommendTargets,
    removeArea,
    downloadsAllowed,
    suiteAllowed,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      clearTimeout(checkTimer);
      entry?.removeEventListener('click', onEntry);
      cardObserver?.disconnect();
      boxTool?.destroy();
      polygonTool?.destroy();
      takeoffTool?.destroy();
      targetTool?.destroy();
      pathTool?.destroy();
      obstacleTool?.destroy();
      resetObstacles();
      library?.destroy();
      preview.destroy();
      body.replaceChildren();
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
