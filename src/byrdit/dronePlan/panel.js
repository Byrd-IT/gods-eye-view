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
import {
  DEFAULT_CAMERA_PRESET_ID,
  allowedShutter,
  cameraPresetOrDefault,
  evText,
  listCameraPresets,
  shutterForPreset,
} from './cameraSettings.js';
import { formatNumber, t } from '../../i18n/index.js';
import { initImageryBoxTool } from '../../ui/imageryBoxTool.js';
import { createSlider } from '../../ui/slider.js';
import { assembleAreaPlan, distanceToAreasM, planAreas } from './areas.js';
import { initPolygonTool } from './polygonTool.js';
import { validateDroneBox } from './limits.js';
import { MAX_LISTED, checkConflicts } from './conflicts.js';
import {
  checkClearance,
  createSurfaceModel,
  createSurfaceProbe,
} from './clearance.js';
import { createSurfaceClient, surfaceTouches } from './surfaceClient.js';
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
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../../overlays/worldOverlay.js';
import {
  createDronePlanPreview,
  passStyle,
  batteryPauseEstimate,
  BATTERY_PAUSE_SOURCE,
} from './preview.js';
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
  MAX_WAYPOINTS_PER_MISSION,
  MIN_AGL_M,
  MIN_WAYPOINTS_PER_MISSION,
  OBSTACLE_MARGIN_M,
  footprint,
  INTERVAL_TRIGGER_PROVEN,
  isContinuousCapture,
  captureSpacingM,
  cleanMinPhotoIntervalS,
  cleanTimedIntervalS,
  presetWithPhotoInterval,
  spacing,
  takeoffDistanceFromBoxM,
  writtenSpacingM,
} from './planner.js';
import {
  DEFAULT_PRESET_ID,
  getPreset,
  kmzStatus,
  listPresets,
} from './presets.js';
import { MODES, modeFor, recommend, recommendedOptions } from './recommend.js';
import {
  INTERVAL_QUICK_FILL_S,
  MAX_TIMED_INTERVAL_S,
  effectiveSpeedMs,
  suiteTimingRows,
  timingFigures,
} from './timing.js';
import {
  DEFAULT_SHUTTER_DENOMINATOR,
  MIN_PLAN_SPEED_MS,
  SHUTTER_DENOMINATORS,
  minShutterDenominator,
  speedLimits,
} from './speed.js';
import { buildBundleZip, buildKmz, kmzFileName } from './wpml.js';
import {
  flightCode,
  flightFileName,
  flightTitle,
  hasLabel,
  controllerFileId,
  labelStem,
} from './missionLabel.js';
import { renderThumb } from './missionThumb.js';
import { buildSuiteZip, suiteOptions } from './suite.js';
import { readPlan, serializePlan } from './planDoc.js';
import { importCheckMission } from './importShots.js';
import { globeHeightM } from './globeHeight.js';
import { mountLibrary } from './libraryPanel.js';
import { mountPhotoCheck } from './photoCheckPanel.js';
import {
  distanceText,
  durationText,
  heightText,
  lengthText,
  planErrorText,
  speedText,
  speedWithMphText,
  warningText,
  warningTone,
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
import {
  ALPHA_RANGE,
  DEFAULT_ALPHA,
  clampAlpha,
  footprintMode,
} from './checkLayer.js';
import {
  STEP_KEYS,
  readAlpha,
  readClearance,
  writeClearance,
  CLEARANCE_MAX_M,
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
/** How far past an area's box a surface model still matters, metres. */
const SURFACE_REACH_M = 400;
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

/** Saved usable-minutes default. The planner does not read this field. */
export const DEFAULT_USABLE_BATTERY_MIN = 20;
const CAPTURE_MODE_VALUES = new Set(['stop', 'distance', 'timed']);

export function cleanCaptureMode(value) {
  return CAPTURE_MODE_VALUES.has(value) ? value : 'stop';
}

/** Integer waypoint cap the field accepts: 20 to 200, default 200. */
export function cleanMaxWaypoints(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return MAX_WAYPOINTS_PER_MISSION;
  return Math.min(
    MAX_WAYPOINTS_PER_MISSION,
    Math.max(MIN_WAYPOINTS_PER_MISSION, n),
  );
}

/**
 * Usable minutes for the pause estimate. Empty, zero and non-numbers return
 * 20. A positive number is clamped to 5..60, the same window as battery time.
 */
export function cleanUsableBatteryMin(value) {
  if (value == null || value === '') return DEFAULT_USABLE_BATTERY_MIN;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USABLE_BATTERY_MIN;
  return Math.min(60, Math.max(5, n));
}

/** Positive metres, or null when spacing comes from front overlap. */
export function cleanPhotoSpacingM(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Degrees from nadir, matching planFlight's pass tilt. Grid and orbit are 0. */
export function captureTiltDeg(options) {
  if (options?.pattern !== 'double') return 0;
  const tilt = 90 + Number(options.tiltPitchDeg);
  return Number.isFinite(tilt) ? tilt : 0;
}

export function captureStepLabel(mode) {
  if (mode === 'distance') return t('Distance trigger');
  if (mode === 'timed') return t('Timed shot');
  return t('Stop photos');
}

/**
 * Footprint, overlap, interval and shutter limits for the panel readout.
 * Uses planner.footprint / spacing and speed.speedLimits /
 * minShutterDenominator. The photo spacing is the one-decimal value written
 * to the KMZ, not the raw overlap metres. Returns null when the spacing
 * would not be positive. A tilt that reaches the horizon throws, as
 * footprint does. Does not change the requested speed.
 */
export function captureFigures({
  preset,
  aglM,
  tiltDeg = 0,
  frontOverlap,
  sideOverlap,
  photoSpacingM = null,
  speedMs,
  shutterDenominator,
  captureMode,
  timedIntervalS = null,
}) {
  if (!preset || !(aglM > 0) || !(speedMs > 0)) return null;
  const fp = footprint(preset, aglM, tiltDeg);
  if (!(fp.alongM > 0) || !(fp.acrossM > 0)) return null;
  const fromOverlap = spacing(fp, frontOverlap, sideOverlap);
  // The same rule the planner uses: with Timed shot and a chosen interval the
  // spacing is speed x interval; otherwise a fixed distance; otherwise the
  // spacing that gives the wanted front overlap.
  const rawPhotoM = captureSpacingM(
    { captureMode, timedIntervalS, speedMs, photoSpacingM },
    photoSpacingM > 0 ? photoSpacingM : fromOverlap.photoM,
  );
  const photoM = writtenSpacingM(rawPhotoM);
  if (!(photoM > 0) || !(fromOverlap.lineM > 0)) return null;
  const limits = speedLimits({
    preset,
    photoSpacingM: photoM,
    gsdCm: fp.gsdCm,
    shutterDenominator,
  });
  const rawShutter = minShutterDenominator(preset, fp.gsdCm, speedMs);
  const standardShutter =
    SHUTTER_DENOMINATORS.find((d) => d >= rawShutter) ?? null;
  const table = SHUTTER_DENOMINATORS.map((denominator) => {
    const cap = speedLimits({
      preset,
      photoSpacingM: 0,
      gsdCm: fp.gsdCm,
      shutterDenominator: denominator,
    });
    return { denominator, maxSpeedMs: cap.limitMs, limitedBy: cap.limitedBy };
  });
  return {
    footprint: fp,
    photoM,
    lineM: fromOverlap.lineM,
    frontPct: (1 - photoM / fp.alongM) * 100,
    sidePct: (1 - fromOverlap.lineM / fp.acrossM) * 100,
    seconds: photoM / speedMs,
    limits,
    rawShutter,
    standardShutter,
    fasterThanTable: standardShutter == null || rawShutter > 4000,
    table,
    minPhotoIntervalS: preset.minPhotoIntervalS,
  };
}

/** Batteries at the usable-minutes setting. Null when the inputs are unusable. */
export function usableBatteryCount(durationS, usableBatteryMin) {
  const minutes = Number(usableBatteryMin);
  if (!(minutes > 0) || !(Number(durationS) >= 0)) return null;
  return Math.max(1, Math.ceil(Number(durationS) / (minutes * 60)));
}

/** Inline colours: the warning list's CSS is amber for every row. */
/**
 * Capture-readout lines that stay in view. Every other line is folded into
 * Details (a 'bad' tone also stays in view). One line counts the cautions
 * inside Details so none is hidden without a sign.
 */
const VISIBLE_CAPTURE_ROLES = new Set([
  'capture-unproven',
  'capture-interval-warn',
  'capture-footprint-error',
  'capture-cautions',
]);

/** Explanations that always fold, even when their tone is 'bad': a short line says it. */
const FOLDED_CAPTURE_ROLES = new Set(['capture-interval']);

export const WARNING_TONE_COLOR = Object.freeze({
  bad: '#ff4d4f',
  warn: '#ffb547',
});

const num = (v, d = 0) =>
  formatNumber(v, { minimumFractionDigits: d, maximumFractionDigits: d });
/** A percentage: whole numbers without a decimal (80), others with one (77.6). */
const pct = (v) => num(v, Math.abs(v - Math.round(v)) < 1e-9 ? 0 : 1);

const PAUSE_MODEL_NOTE =
  'Each extra survey line in a battery adds 3 seconds. Wind and extra climb time are not in the model, so the real pause point moves.';

/**
 * Pause lines for a continuous route, from batteryBreaks. Null when the
 * plan is not continuous. Replaces the old "not a marker" guess.
 * Turns and station resets come from mission.legs. An unreadable result
 * is a warning, not a guessed pause. An unreachable stretch is warned.
 */
export function continuousBatteryLines(result, usableBatteryMin) {
  const estimate = batteryPauseEstimate(result, usableBatteryMin);
  if (!estimate) return null;
  const lines = [];
  const unreadable = (estimate.errors ?? []).length > 0;
  if (estimate.covered && !unreadable && estimate.batteries > 0) {
    lines.push({
      role: 'capture-batteries',
      tone: 'warn',
      text: t(
        'Estimated flight time {time} at the plan speed. At {minutes} usable minutes per battery that is about {count} batteries. Each extra survey line in a battery adds 3 seconds. Wind and extra climb time are not in the model, so the real pause point moves.',
        {
          time: durationText(result.totals?.durationS ?? 0),
          minutes: num(estimate.usableMin),
          count: num(estimate.batteries),
        },
      ),
    });
  }
  if (estimate.breaks.length) {
    for (const item of estimate.breaks) {
      const mark = item.mark;
      lines.push({
        role: 'capture-pause',
        tone: 'warn',
        lat: mark.lat,
        lon: mark.lon,
        groundM: mark.groundM,
        routeM: mark.routeM,
        turnS: mark.turnS,
        photoCount: mark.photoCount,
        text: t(
          'Pause {n} is marked on the globe at {distance} along the route, about {time} into that battery, near {lat}, {lon}. Turn time in that battery: {turns} s.',
          {
            n: num(mark.index),
            distance: distanceText(mark.groundM),
            time: durationText(mark.durationS),
            lat: num(mark.lat, 5),
            lon: num(mark.lon, 5),
            turns: num(mark.turnS),
          },
        ),
      });
    }
  } else if (estimate.covered && !unreadable) {
    lines.push({
      role: 'capture-pause',
      tone: 'warn',
      text: t(
        'This route fits in the usable minutes. No pause marker is needed.',
      ),
    });
  }
  for (const gap of estimate.unreachable) {
    if (
      !Number.isFinite(gap.fromGroundM) ||
      !Number.isFinite(gap.remainingGroundM)
    ) {
      lines.push({
        role: 'capture-unreachable',
        tone: 'bad',
        text: t(
          'Part of this route is not covered. The uncovered distance could not be read. No further pause marker is placed.',
        ),
      });
      continue;
    }
    const distance = distanceText(gap.fromGroundM ?? 0);
    const remaining = distanceText(gap.remainingGroundM ?? 0);
    lines.push({
      role: 'capture-unreachable',
      tone: 'bad',
      text:
        gap.reason === 'no-progress'
          ? t(
              'From {distance} along the route, a further pause would not move forward. {remaining} is not covered.',
              { distance, remaining },
            )
          : t(
              'From {distance} along the route, the round trip already exceeds {minutes} usable minutes. No further pause marker is placed. {remaining} is not covered.',
              {
                distance,
                remaining,
                minutes: num(estimate.usableMin),
              },
            ),
    });
  }
  for (const err of estimate.errors ?? []) {
    lines.push({
      role: 'capture-read-error',
      tone: 'bad',
      text: t(
        'Pause estimate could not be read: {message}. No pause was guessed for that file.',
        { message: err.message },
      ),
    });
  }
  return { estimate, lines };
}

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
  renderPreview = renderThumb,
  libraryClient,
  getBuildingFootprints = null,
  fetchObstacles = null,
  surfaceClient = createSurfaceClient(),
  unitStorage = browserStorage(doc?.defaultView ?? globalThis),
  overlay = {
    set: (entries) => setOverlayEntries(OBSTACLE_OVERLAY_SOURCE, entries),
    clear: () => clearOverlaySource(OBSTACLE_OVERLAY_SOURCE),
  },
  labelOverlay = {
    set: (entries) => setOverlayEntries(BATTERY_PAUSE_SOURCE, entries),
    clear: () => clearOverlaySource(BATTERY_PAUSE_SOURCE),
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
      captureMode: 'stop',
      photoSpacingM: null,
      continuousRoute: false,
      intervalTriggerProven: INTERVAL_TRIGGER_PROVEN,
      shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
      cameraPresetId: DEFAULT_CAMERA_PRESET_ID,
      // Null uses the aircraft preset interval. A number is this plan only.
      minPhotoIntervalS: null,
      // Seconds the person will set for the camera's Timed shot. Null: none.
      timedIntervalS: null,
      batteryMin: 25,
      maxWaypoints: MAX_WAYPOINTS_PER_MISSION,
      usableBatteryMin: DEFAULT_USABLE_BATTERY_MIN,
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
    // A rejected camera-interval entry. Not saved.
    intervalReject: false,
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
      footprints: 'selected',
      frustum: 'one',
      index: 0,
      // How see-through each layer is (0 = invisible): the sliders.
      alpha: readAlpha(unitStorage),
    },
    // The photogrammetry surface model used as an obstacle surface. Warn only:
    // nothing it finds ever moves the route.
    surface: {
      ...readClearance(unitStorage),
      // 'idle' | 'loading' | 'ready' | 'none' | 'signin' | 'error'
      status: 'idle',
      key: null,
      headers: [],
      model: null,
      ids: [],
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
  // The 3D check of imported files (see refreshImportCheck).
  let importCheckToken = 0;
  let importCheckInfo = { aircraft: null, noPhoto: [], unavailable: [] };
  // Bumps only when a new plan is committed, not when the panel is merely
  // ready. A fast replan can be ready again before the first poll, so the
  // QA script waits for this number instead of waiting for "ready" to leave.
  let planNonce = 0;
  let reading = false;
  let timer = null;
  let destroyed = false;
  let surfaceLoading = false;

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
    labelOverlay,
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

  // ------------------------------------------------------ surface model --
  /** Lon/lat box around every area (and the takeoff), or null. */
  function workBox() {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const add = (lon, lat) => {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    };
    for (const area of state.areas) {
      if (area.kind === 'polygon') {
        for (const p of area.ring ?? []) add(p.lon, p.lat);
      } else if (area.box) {
        add(area.box.west, area.box.south);
        add(area.box.east, area.box.north);
      }
    }
    return Number.isFinite(west) ? { west, south, east, north } : null;
  }

  /**
   * Find the surface models that touch the working area and load them. The
   * list is read once per page; a model is downloaded once per page. Failure
   * is never fatal: no model means the tree height setting is used.
   */
  async function ensureSurfaces() {
    const s = state.surface;
    const box = workBox();
    if (!box) return false;
    if (s.status === 'idle' || s.status === 'error') {
      s.status = 'loading';
      try {
        s.headers = await surfaceClient.list();
      } catch (error) {
        s.headers = [];
        s.status = error?.message === 'no-identity' ? 'signin' : 'error';
      }
      if (destroyed) return false;
      if (s.status === 'loading') s.status = 'none';
    }
    const wanted = s.headers
      .filter((h) => surfaceTouches(h, box, SURFACE_REACH_M))
      .map((h) => h.id)
      .sort();
    const key = wanted.join('|');
    if (key === s.key) return false;
    const grids = [];
    for (const id of wanted) {
      try {
        grids.push(await surfaceClient.load(id));
      } catch {
        s.status = 'error';
      }
    }
    if (destroyed) return false;
    const hadModel = Boolean(s.model);
    s.key = key;
    s.model = grids.length ? createSurfaceModel(grids) : null;
    s.ids = grids.map((g) => g.id);
    if (grids.length) s.status = 'ready';
    else if (s.status !== 'error' && s.status !== 'signin') s.status = 'none';
    state.conflictCache = null;
    return hadModel || grids.length > 0;
  }

  /** What the planner asks for heights, or null when the model is off. */
  function surfaceProbe() {
    const s = state.surface;
    if (!s.enabled || !s.model) return null;
    return createSurfaceProbe(s.model, s.minM + s.marginM);
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

  /**
   * Put the panel's usable minutes back on a continuous result when the
   * planner dropped the option. An already-normalized positive value wins.
   */
  function carryUsableBattery(result) {
    if (!result || result.plan?.options?.continuousRoute !== true)
      return result;
    const normalized = Number(result.plan?.options?.usableBatteryMin);
    const carried = Number(result.usableBatteryMin);
    if (!(normalized > 0) && !(carried > 0)) {
      result.usableBatteryMin = cleanUsableBatteryMin(
        state.options.usableBatteryMin,
      );
    }
    return result;
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
    // The surface models load beside the plan, never in front of it: when
    // they arrive and change what is covered, the plan is made again.
    if (!surfaceLoading) {
      surfaceLoading = true;
      ensureSurfaces()
        .then((changed) => {
          if (changed && !destroyed) schedule(0);
        })
        .catch(() => {})
        .finally(() => {
          surfaceLoading = false;
        });
    }
    const options = {
      ...state.options,
      takeoff: state.takeoff,
      jobGrouping: state.jobGrouping,
      surfaceProbe: surfaceProbe(),
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
    state.result = carryUsableBattery(
      assembleAreaPlan(plan, { ...ground, wpM: byId, obstacleM }),
    );
    state.error = null;
    state.busy = false;
    planNonce += 1;
    panel.dataset.planNonce = String(planNonce);
    pushCheck();
    // Takeoff ground, else the globe's own surface there (terrain model
    // only), else 0: the stand-in for an obstacle with no height of its own.
    groundHintM = ground.known
      ? ground.takeoffM
      : (globeHeightM(viewer, cesium, plan.takeoff.lon, plan.takeoff.lat) ?? 0);
    preview.setObstacleGround(groundHintM);
    preview.setObstacleGrounds(obstacleM);
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
    // The "Speed & photo timing" section of the Shots step. It owns the speed
    // and front-overlap sliders, the recommended interval, the interval the
    // person can set, the result of that interval, and a collapsed Details
    // block that holds the long capture readout.
    const buildTimingSection = ({ field: makeField }) => {
      const outer = host;
      ui.timing = el(doc, 'section', outer, {
        cls: 'gev-dp-timing',
        attrs: {
          'data-role': 'timing',
          'aria-label': t('Speed & photo timing'),
        },
      });
      el(doc, 'h4', ui.timing, {
        cls: 'gev-dp-timing-title',
        text: t('Speed & photo timing'),
      });
      host = ui.timing;
      ui.speed = lslider(t('Speed'), {
        minM: MIN_PLAN_SPEED_MS,
        maxM: 15,
        stepM: 0.1,
        stepFt: 0.5,
        kind: 'speed',
      });
      ({ out: ui.speedOut } = makeField(t('Speed'), ui.speed));
      ui.front = slider(t('Front overlap'), 50, 98, 0.5);
      ({ out: ui.frontOut } = makeField(t('Front overlap'), ui.front));
      ui.timingPlanned = el(doc, 'p', ui.timing, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'timing-planned' },
      });
      // The recommended interval is the headline number.
      ui.timingRec = el(doc, 'div', ui.timing, {
        cls: 'gev-dp-timing-rec',
        attrs: { 'data-role': 'timing-recommended' },
      });
      ui.timingRecLabel = el(doc, 'span', ui.timingRec, {
        cls: 'gev-dp-label',
        text: t('Recommended interval'),
      });
      ui.timingRecValue = el(doc, 'strong', ui.timingRec, {
        cls: 'gev-dp-timing-big',
        attrs: { 'data-role': 'timing-recommended-value' },
      });
      ui.timingRecNote = el(doc, 'span', ui.timingRec, {
        cls: 'gev-dp-note',
        attrs: { 'data-role': 'timing-recommended-note' },
      });
      ui.timingTimed = el(doc, 'div', ui.timing, {
        cls: 'gev-dp-timing-timed',
        attrs: { 'data-role': 'timing-timed' },
      });
      host = ui.timingTimed;
      ui.timedInterval = el(doc, 'input', null, {
        cls: 'pp-text-input gev-dp-text',
        attrs: {
          type: 'number',
          min: '0.1',
          max: String(MAX_TIMED_INTERVAL_S),
          step: 'any',
          inputmode: 'decimal',
          'aria-label': t('Interval you can set in DJI Fly (s)'),
          'aria-invalid': 'false',
          'data-role': 'timing-interval',
        },
      });
      makeField(t('Interval you can set in DJI Fly (s)'), ui.timedInterval, {
        value: false,
      });
      ui.timingChips = el(doc, 'div', ui.timingTimed, {
        cls: 'gev-dp-timing-chips',
      });
      ui.timingChipButtons = INTERVAL_QUICK_FILL_S.map((seconds) =>
        el(doc, 'button', ui.timingChips, {
          cls: 'data-toggle-chip',
          text: t('{n} s', { n: String(seconds) }),
          attrs: {
            type: 'button',
            'data-role': 'timing-chip',
            'data-seconds': String(seconds),
            title: t(
              'Fill in this many seconds. An example only: use the interval your aircraft and DJI Fly allow.',
            ),
          },
        }),
      );
      ui.timingClear = el(doc, 'button', ui.timingChips, {
        cls: 'data-toggle-chip',
        text: t('Clear'),
        attrs: { type: 'button', 'data-action': 'timing-clear' },
      });
      el(doc, 'p', ui.timingTimed, {
        cls: 'gev-dp-note',
        text: t(
          'Set this interval in DJI Fly Timed shot and start it by hand. The file takes no photos itself.',
        ),
      });
      ui.timingIntervalNote = el(doc, 'p', ui.timingTimed, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'timing-interval-note' },
      });
      ui.timingResult = el(doc, 'p', ui.timingTimed, {
        cls: 'gev-dp-note gev-dp-timing-result',
        attrs: { 'data-role': 'timing-result' },
      });
      ui.timingSpacingNote = el(doc, 'p', ui.timingTimed, {
        cls: 'gev-dp-note',
        text: t(
          'A fixed photo spacing is also set. The interval sets the spacing; the fixed distance is not used.',
        ),
        attrs: { 'data-role': 'timing-spacing-ignored' },
      });
      ui.timingUnder = el(doc, 'p', ui.timingTimed, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'timing-under-minimum', 'data-tone': 'bad' },
      });
      ui.timingFit = el(doc, 'div', ui.timingTimed, {
        cls: 'gev-dp-timing-fit',
        attrs: { 'data-role': 'timing-fit' },
      });
      ui.timingFitText = el(doc, 'span', ui.timingFit, {
        cls: 'gev-dp-note',
      });
      ui.timingFitButton = el(doc, 'button', ui.timingFit, {
        cls: 'data-toggle-chip',
        attrs: { type: 'button', 'data-action': 'timing-use-speed' },
      });
      ui.timingMode = el(doc, 'div', ui.timing, {
        cls: 'gev-dp-timing-mode',
        attrs: { 'data-role': 'timing-mode' },
      });
      ui.timingModeText = el(doc, 'span', ui.timingMode, {
        cls: 'gev-dp-note',
        text: t(
          'The interval applies to the camera Timed shot. The plan is not changed until you switch.',
        ),
      });
      ui.timingUseTimed = el(doc, 'button', ui.timingMode, {
        cls: 'data-toggle-chip',
        text: t('USE TIMED SHOT'),
        attrs: { type: 'button', 'data-action': 'timing-use-timed' },
      });
      ui.timingTerrain = el(doc, 'p', ui.timing, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'timing-terrain', 'data-tone': 'warn' },
      });
      ui.timingSuite = el(doc, 'div', ui.timing, {
        cls: 'gev-dp-timing-suite',
        attrs: { 'data-role': 'timing-suite' },
      });
      // The long readout (footprint, overlap, shutter table, explanations)
      // is kept, folded into Details.
      ui.captureReadout = el(doc, 'div', ui.timing, {
        attrs: { 'data-role': 'capture-readout' },
      });
      // Visible lines go here; the long ones go into Details below it. Both
      // stay in the readout, so it keeps its text and its data attributes.
      ui.captureAlerts = el(doc, 'div', ui.captureReadout);
      ui.captureDetails = el(doc, 'details', ui.captureReadout, {
        cls: 'gev-dp-timing-details',
        attrs: { 'data-role': 'capture-details' },
      });
      el(doc, 'summary', ui.captureDetails, { text: t('Details') });
      ui.captureDetailsBody = el(doc, 'div', ui.captureDetails);
      host = outer;
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
    ui.photoCheck = el(doc, 'div', ui.steps.export.body, {
      cls: 'gev-dp-photocheck-host',
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
    ui.cameraBlock = el(doc, 'div', host, {
      cls: 'gev-dp-camera',
      attrs: { 'data-role': 'camera-settings' },
    });
    el(doc, 'p', ui.cameraBlock, {
      cls: 'gev-dp-note gev-dp-camera-title',
      text: t('Camera settings (set in DJI Fly)'),
    });
    ui.cameraPreset = select(
      listCameraPresets().map((p) => [p.id, cameraPresetName(p.id)]),
      t('Camera settings preset'),
    );
    const outerHost = host;
    host = ui.cameraBlock;
    field(t('Camera settings preset'), ui.cameraPreset, { value: false });
    ui.minPhotoInterval = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'number',
        min: '0.1',
        max: '60',
        step: '0.1',
        inputmode: 'decimal',
        'aria-label': t('Camera minimum interval (s)'),
        'data-role': 'camera-min-interval',
      },
    });
    field(t('Camera minimum interval (s)'), ui.minPhotoInterval, {
      value: false,
    });
    ui.minPhotoIntervalNote = el(doc, 'p', ui.cameraBlock, {
      cls: 'gev-dp-note',
      attrs: { 'data-role': 'camera-interval-note' },
    });
    host = outerHost;
    ui.cameraList = el(doc, 'ul', ui.cameraBlock, {
      cls: 'gev-dp-camera-list',
      attrs: { 'data-role': 'camera-checklist' },
    });
    el(doc, 'p', ui.cameraBlock, {
      cls: 'gev-dp-note',
      text: t(
        'GEV cannot send these to the aircraft: set them in DJI Fly before launch.',
      ),
    });
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
      // 0.2 m: 457.2 is on the 10 + 0.2n grid (a browser range input stops at
      // the last grid value below max), and every multiple of 5 m still is.
      stepM: 0.2,
      stepFt: 10,
    });
    ({ row: ui.aglRow, out: ui.aglOut } = field(
      t('Height above ground'),
      ui.agl,
    ));
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
    // Surface model: clearance to the canopy and roofs seen by the photos.
    ui.surfaceBox = el(doc, 'div', host, {
      cls: 'gev-dp-targets gev-dp-surface',
      attrs: { 'data-role': 'surface' },
    });
    ui.surfaceStatus = el(doc, 'p', ui.surfaceBox, {
      cls: 'gev-dp-note gev-dp-surface-status',
      attrs: { 'data-role': 'surface-status', 'aria-live': 'polite' },
    });
    ui.surfaceUse = select(
      [
        ['on', t('On')],
        ['off', t('Off')],
      ],
      t('Check the route against the surface model'),
    );
    ui.surfaceUseRow = field(t('Surface model check'), ui.surfaceUse, {
      value: false,
    }).row;
    ui.surfaceUseRow.setAttribute?.('data-role', 'surface-use');
    ui.clearance = lslider(t('Minimum clearance'), {
      minM: 0,
      maxM: CLEARANCE_MAX_M,
      stepM: 1,
      stepFt: 5,
    });
    ({ row: ui.clearanceRow, out: ui.clearanceOut } = field(
      t('Minimum clearance'),
      ui.clearance,
    ));
    ui.clearanceRow.setAttribute?.('data-role', 'clearance-min');
    ui.margin = lslider(t('Position error margin'), {
      minM: 0,
      maxM: CLEARANCE_MAX_M,
      stepM: 1,
      stepFt: 5,
    });
    ({ row: ui.marginRow, out: ui.marginOut } = field(
      t('Position error margin'),
      ui.margin,
    ));
    ui.marginRow.setAttribute?.('data-role', 'clearance-margin');
    ui.surfaceDisclaimer = el(doc, 'p', host, {
      cls: 'gev-dp-note gev-dp-surface-disclaimer',
      attrs: { 'data-role': 'surface-disclaimer' },
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
    ui.captureMode = select(
      [
        ['stop', t('Stop at every photo')],
        ['distance', t('Photo every N metres (KMZ distance trigger)')],
        ['timed', t('Camera timed shot (path-only KMZ)')],
      ],
      t('Capture mode'),
    );
    ({ row: ui.captureRow } = field(t('Capture mode'), ui.captureMode, {
      value: false,
    }));
    ui.spacingSource = select(
      [
        ['overlap', t('From front overlap')],
        ['distance', t('Fixed distance')],
      ],
      t('Photo spacing'),
    );
    ({ row: ui.spacingSourceRow } = field(
      t('Photo spacing'),
      ui.spacingSource,
      {
        value: false,
      },
    ));
    ui.photoSpacing = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'number',
        min: '0.1',
        step: 'any',
        'aria-label': t('Fixed photo spacing'),
      },
    });
    ({ row: ui.spacingRow, labelEl: ui.spacingLabel } = field(
      t('Photo spacing ({unit})', { unit: lengthUnit() }),
      ui.photoSpacing,
      { value: false },
    ));
    buildTimingSection({ field, select });
    into('flight');
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
    ui.maxWaypoints = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'number',
        min: String(MIN_WAYPOINTS_PER_MISSION),
        max: String(MAX_WAYPOINTS_PER_MISSION),
        step: '1',
        'aria-label': t('Maximum waypoints per file'),
      },
    });
    field(t('Maximum waypoints per file'), ui.maxWaypoints, { value: false });
    ui.usableBattery = el(doc, 'input', null, {
      cls: 'pp-text-input gev-dp-text',
      attrs: {
        type: 'number',
        min: '5',
        max: '60',
        step: '1',
        'aria-label': t('Usable minutes per battery'),
        title: t(
          'Pause estimate only, 5 to 60 minutes. File splits still use Battery (min). A continuous route is not split by battery.',
        ),
      },
    });
    field(t('Usable minutes per battery'), ui.usableBattery, { value: false });
    ui.continuous = el(doc, 'input', null, {
      attrs: {
        type: 'checkbox',
        'aria-label': t('One continuous route'),
      },
    });
    ({ row: ui.continuousRow } = field(
      t('One continuous route'),
      ui.continuous,
      {
        value: false,
      },
    ));
    ui.continuousNote = el(doc, 'p', host, {
      cls: 'gev-dp-note',
      attrs: { 'data-role': 'continuous-note' },
      text: t(
        'Do not split this route into battery-sized files. Waypoints are turning points. You pause, swap the battery and resume by hand.',
      ),
    });
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
    el(doc, 'p', host, {
      cls: 'gev-dp-note gev-dp-check-legend',
      attrs: { 'data-role': 'check-legend' },
      text: t(
        'The safety zone is the corridor the aircraft flies, in the air along the route; it is not an obstacle. Orange columns are obstacles, standing on the ground. Footprints lie on the surface.',
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
    ui.checkFootprints = select(
      [
        ['selected', t('Selected photo only')],
        ['all', t('All photos')],
        ['off', t('Off')],
      ],
      t('Photo footprints'),
    );
    ui.checkFootprints.setAttribute('data-check', 'footprints');
    const footprintsRow = el(doc, 'label', host, { cls: 'gev-dp-row' });
    el(doc, 'span', footprintsRow, {
      cls: 'gev-dp-label',
      text: t('Photo footprints'),
    });
    el(doc, 'span', footprintsRow, { cls: 'gev-dp-control' }).append(
      ui.checkFootprints,
    );
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
    ]) {
      box.addEventListener('change', () => {
        c[key] = Boolean(box.checked);
        pushCheck();
        syncCheckUi();
      });
    }
    ui.checkFootprints.addEventListener('change', () => {
      c.footprints = footprintMode(ui.checkFootprints.value);
      pushCheck();
      syncCheckUi();
    });
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
      // The interval belongs to the aircraft preset. A new aircraft starts unset.
      o.minPhotoIntervalS = null;
      state.intervalReject = false;
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
      // The checklist shows this value, so it and the blur limit agree.
      o.shutterDenominator = Number(ui.shutter.value);
      syncControls();
      schedule();
    });
    ui.cameraPreset.addEventListener('change', () => {
      const cam = cameraPresetOrDefault(ui.cameraPreset.value);
      o.cameraPresetId = cam.id;
      // The preset's shutter feeds the blur limit: never slower than it asks.
      o.shutterDenominator = allowedShutter(
        Math.max(cam.minShutterDenominator, o.shutterDenominator),
      );
      syncControls();
      schedule();
    });
    ui.minPhotoInterval.addEventListener('change', () => {
      const raw = ui.minPhotoInterval.value.trim();
      if (raw === '') {
        o.minPhotoIntervalS = null;
        state.intervalReject = false;
      } else {
        const cleaned = cleanMinPhotoIntervalS(raw);
        if (cleaned == null) state.intervalReject = true;
        else {
          o.minPhotoIntervalS = cleaned;
          state.intervalReject = false;
        }
      }
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
    const saveClearance = () => writeClearance(unitStorage, state.surface);
    onInput(ui.clearance, () => {
      state.surface.minM = lengthToM(ui.clearance.value);
      saveClearance();
    });
    onInput(ui.margin, () => {
      state.surface.marginM = lengthToM(ui.margin.value);
      saveClearance();
    });
    ui.surfaceUse.addEventListener('change', () => {
      state.surface.enabled = ui.surfaceUse.value !== 'off';
      saveClearance();
      state.conflictCache = null;
      syncControls();
      schedule();
    });
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
    ui.captureMode.addEventListener('change', () => {
      o.captureMode = cleanCaptureMode(ui.captureMode.value);
      syncControls();
      schedule();
    });
    ui.spacingSource.addEventListener('change', () => {
      if (ui.spacingSource.value === 'distance') {
        if (!(o.photoSpacingM > 0)) {
          const seeded = (() => {
            try {
              return captureFigures({
                preset: getPreset(o.presetId),
                aglM: Math.min(Math.max(o.aglM, MIN_AGL_M), AGL_CAP_M),
                tiltDeg: captureTiltDeg(o),
                frontOverlap: o.frontOverlap,
                sideOverlap: o.sideOverlap,
                photoSpacingM: null,
                speedMs: o.speedMs,
                shutterDenominator: o.shutterDenominator,
              });
            } catch {
              return null;
            }
          })();
          o.photoSpacingM = seeded?.photoM > 0 ? seeded.photoM : 20;
        }
      } else {
        o.photoSpacingM = null;
      }
      syncControls();
      schedule();
    });
    ui.photoSpacing.addEventListener('change', () => {
      o.photoSpacingM = cleanPhotoSpacingM(lengthToM(ui.photoSpacing.value));
      syncControls();
      schedule();
    });
    // Timed-shot interval: typing a usable number updates the figures at
    // once; leaving the field with something unusable keeps the old value and
    // says so (the same rule as the camera minimum field).
    ui.timedInterval.addEventListener('input', () => {
      const n = cleanTimedIntervalS(ui.timedInterval.value);
      if (n == null) return;
      state.timedReject = false;
      o.timedIntervalS = n;
      syncControls();
      schedule();
    });
    ui.timedInterval.addEventListener('change', () => {
      const raw = String(ui.timedInterval.value ?? '').trim();
      if (raw === '') {
        o.timedIntervalS = null;
        state.timedReject = false;
      } else {
        const n = cleanTimedIntervalS(raw);
        if (n == null) state.timedReject = true;
        else {
          o.timedIntervalS = n;
          state.timedReject = false;
        }
      }
      syncControls();
      schedule();
    });
    ui.timingChipButtons.forEach((chip) => {
      chip.addEventListener('click', () => {
        o.timedIntervalS = cleanTimedIntervalS(
          chip.getAttribute('data-seconds'),
        );
        state.timedReject = false;
        syncControls();
        schedule();
      });
    });
    ui.timingClear.addEventListener('click', () => {
      o.timedIntervalS = null;
      state.timedReject = false;
      syncControls();
      schedule();
    });
    ui.timingFitButton.addEventListener('click', () => {
      // The one place the interval panel changes the speed, and only on a click.
      const ms = Number(ui.timingFit.getAttribute('data-speed-ms'));
      if (!(ms > 0)) return;
      o.speedMs = ms;
      syncControls();
      schedule();
    });
    ui.timingUseTimed.addEventListener('click', () => {
      o.captureMode = 'timed';
      syncControls();
      schedule();
    });
    ui.continuous.addEventListener('change', () => {
      o.continuousRoute = ui.continuous.checked === true;
      syncControls();
      schedule();
    });
    ui.maxWaypoints.addEventListener('change', () => {
      o.maxWaypoints = cleanMaxWaypoints(ui.maxWaypoints.value);
      syncControls();
      schedule();
    });
    ui.usableBattery.addEventListener('change', () => {
      o.usableBatteryMin = cleanUsableBatteryMin(ui.usableBattery.value);
      syncControls();
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
        captureStepLabel(o.captureMode),
        o.captureMode === 'timed' && o.timedIntervalS != null
          ? t('{n} s', { n: num(o.timedIntervalS, 1) })
          : '',
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
              [state.check.footprints !== 'off', t('footprints')],
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

  function cameraIntervalNote(preset, override) {
    if (state.intervalReject) {
      return t(
        'That interval was not used. Enter 0.1 to 60, or leave the field blank.',
      );
    }
    const presetS = num(preset.minPhotoIntervalS, 1);
    if (override == null) {
      if (
        preset.minPhotoIntervalStatus === 'derived' &&
        preset.verified === 'unverified'
      ) {
        return t(
          'Preset default {seconds} s, derived/unverified. Blank keeps it. A number replaces it for this plan only and is still not verified.',
          { seconds: presetS },
        );
      }
      return t(
        'Preset default {seconds} s. Blank keeps it. A number replaces it for this plan only.',
        { seconds: presetS },
      );
    }
    return t(
      'This plan uses {seconds} s instead of the preset {preset} s. Not verified here.',
      { seconds: num(override, 1), preset: presetS },
    );
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
      footprints: footprintMode(c.footprints),
      frustum: c.frustum,
      index: c.index,
      frame: importFramePreset() ?? getPreset(state.options.presetId),
      alpha: c.alpha,
    });
  }

  /**
   * Imported files are checked with the aircraft the file names, when that is
   * not the selected one and the panel has no plan of its own on the globe.
   */
  function importFramePreset() {
    const code = importCheckInfo.aircraft;
    if (code === null || state.result || state.suite) return null;
    const selected = getPreset(state.options.presetId);
    if (selected?.wpml?.droneEnumValue === code) return null;
    return listPresets().find((p) => p.wpml?.droneEnumValue === code) ?? null;
  }

  /**
   * Feed the imported files on the globe to the 3D check: every photo station
   * the file's actions give (importShots.js), on terrain heights. A file with
   * no photo action gets none and the readout says so.
   */
  async function refreshImportCheck(items) {
    importCheckToken += 1;
    const token = importCheckToken;
    const imports = (items ?? []).filter((i) => i.isImport);
    const withPhotos = imports.filter((i) => i.shots?.stations?.length);
    importCheckInfo = {
      aircraft:
        withPhotos.find((i) => Number.isInteger(i.droneEnumValue))
          ?.droneEnumValue ?? null,
      noPhoto: imports
        .filter((i) => i.shots && !i.shots.stations.length)
        .map((i) => i.name ?? i.id),
      unavailable: imports.filter((i) => !i.shots).map((i) => i.name ?? i.id),
      unplaceable: [],
    };
    // Every import with a path is placed on the globe (its waypoints are the
    // aircraft); only those with photo actions also feed the camera views.
    const placed = imports.filter((i) => i.shots?.path?.length);
    if (!placed.length) {
      preview.setImportCheck?.(null);
      pushCheck();
      syncCheckUi();
      return;
    }
    const provider =
      viewer.terrainProvider ?? viewer.scene?.globe?.terrainProvider;
    if (terrainCache.size > MAX_TERRAIN_CACHE || provider !== cachedProvider) {
      terrainCache.clear();
    }
    cachedProvider = provider;
    const passes = [];
    for (const item of placed) {
      const points = item.shots.path;
      const ground = await sampleGround({
        viewer,
        cesium,
        points,
        takeoff: points[0],
        cache: terrainCache,
      });
      if (destroyed || token !== importCheckToken) return;
      // Terrain not read: the globe's own surface at the start point (terrain
      // model only) stands in, so the aircraft is not drawn under the map.
      const displayGroundM = ground.known
        ? null
        : globeHeightM(viewer, cesium, points[0].lon, points[0].lat);
      const mission = importCheckMission(item.shots, ground, {
        displayGroundM,
        groundAt: (lon, lat) => globeHeightM(viewer, cesium, lon, lat),
      });
      if (mission.unsupportedHeightMode) {
        importCheckInfo.unplaceable.push({
          name: item.name ?? item.id,
          mode: mission.unsupportedHeightMode,
        });
      }
      passes.push({
        id: item.id,
        color: item.color,
        checkable: Boolean(item.shots.stations?.length),
        missions: [mission],
      });
    }
    preview.setImportCheck?.(passes);
    pushCheck();
    syncCheckUi();
  }

  /** Why the 3D check has no imported photos to show, if it is that. */
  function importCheckNote() {
    if (state.result || state.suite) return null;
    const { noPhoto, unavailable, unplaceable } = importCheckInfo;
    if (unplaceable?.length) {
      const names = (list) => list.map((u) => u.name).join(', ');
      const sea = unplaceable.filter((u) => u.mode === 'EGM96');
      if (sea.length === unplaceable.length) {
        return t(
          'Heights in {names} are measured from sea level, which GEV cannot place on the globe: only the ground track is drawn.',
          { names: names(sea) },
        );
      }
      return t(
        'The height mode of {names} is not one GEV can place on the globe: only the ground track is drawn.',
        { names: names(unplaceable) },
      );
    }
    if (noPhoto.length) {
      return t(
        'No photo actions in {names}: there are no camera views to show.',
        { names: noPhoto.join(', ') },
      );
    }
    if (unavailable.length) {
      return t(
        'A saved plan does not keep where the camera fires: open the original KMZ again to see its camera views ({names}).',
        { names: unavailable.join(', ') },
      );
    }
    return null;
  }

  /** Keep the 3D check controls and the photo readout true to the globe. */
  function syncCheckUi() {
    if (destroyed || !ui.check) return;
    const c = state.check;
    ui.checkEnabled.checked = c.enabled;
    ui.checkZone.checked = c.zone;
    ui.checkCurtain.checked = c.curtain;
    ui.checkFootprints.value = footprintMode(c.footprints);
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
      ui.checkReadout.textContent =
        importCheckNote() ?? t('No photos to show yet');
      return;
    }
    const mission = /^mission-(\d+)$/.exec(cur.passId);
    const pass = mission
      ? t('Mission {n}', { n: mission[1] })
      : (state.suite?.passes.find((p) => p.id === cur.passId)?.label ??
        state.imports.find((i) => i.id === cur.passId)?.name ??
        cur.passId);
    const fp = cur.footprint;
    const speed = Number(state.options.speedMs);
    const minInterval = presetWithPhotoInterval(
      getPreset(state.options.presetId),
      state.options.minPhotoIntervalS,
    )?.minPhotoIntervalS;
    const underMin =
      cur.photoSpacingM > 0 &&
      speed > 0 &&
      minInterval > 0 &&
      cur.photoSpacingM / speed < minInterval;
    const readout = {
      n: num(info.index + 1),
      total: num(info.count),
      pass,
      pitch: num(cur.pitchDeg ?? -90),
      h: heightText(cur.aglM ?? 0),
      w: fp ? heightText(fp.widthM) : '-',
      d: fp ? heightText(fp.depthM) : '-',
    };
    const theoretical = cur.captureMode === 'distance' && underMin;
    ui.checkReadout.textContent = cur.estimated
      ? t(
          'Estimated station {n} of {total}: {pass}, tilt {pitch} deg, height {h}, covers {w} by {d}. Not a photo the camera will take.',
          readout,
        )
      : theoretical
        ? t(
            'Theoretical station {n} of {total}: {pass}, tilt {pitch} deg, height {h}, covers {w} by {d}. Not a photo the camera will take.',
            readout,
          )
        : t(
            'Photo {n} of {total}: {pass}, tilt {pitch} deg, height {h}, covers {w} by {d}',
            readout,
          );
    if (fp?.clipped) {
      ui.checkReadout.textContent += ` ${t('Part of the view is above the horizon, so the far edge is cut short.')}`;
    }
  }

  function cameraPresetName(id) {
    return id === 'test-12mp'
      ? t('12 MP, 4:3 (test)')
      : t('50 MP, 4:3 (mapping)');
  }

  function renderCameraChecklist(o) {
    const cam = cameraPresetOrDefault(o.cameraPresetId);
    const rows = [
      t('Photo size: {mp} MP, {ratio} ({w} x {h})', {
        mp: num(cam.megapixels),
        ratio: cam.ratio,
        w: String(cam.width),
        h: String(cam.height),
      }),
      t('Shutter: 1/{n} s or faster', {
        n: String(shutterForPreset(cam, o.shutterDenominator)),
      }),
      t('White balance: fixed (not auto)'),
      t('Exposure compensation (EV): {ev}', { ev: evText(cam.ev) }),
      t('Before launch: take a test photo and check it is {w} x {h}', {
        w: String(cam.width),
        h: String(cam.height),
      }),
    ];
    ui.cameraList.replaceChildren();
    for (const text of rows) el(doc, 'li', ui.cameraList, { text });
  }

  function syncControls() {
    const o = state.options;
    const preset = getPreset(o.presetId);
    ui.preset.value = o.presetId;
    ui.mode.value = modeFor(o);
    ui.shutter.value = String(o.shutterDenominator);
    ui.cameraPreset.value = cameraPresetOrDefault(o.cameraPresetId).id;
    o.minPhotoIntervalS = cleanMinPhotoIntervalS(o.minPhotoIntervalS);
    const intervalPreset = presetWithPhotoInterval(preset, o.minPhotoIntervalS);
    ui.minPhotoInterval.value =
      o.minPhotoIntervalS == null ? '' : String(o.minPhotoIntervalS);
    ui.minPhotoInterval.setAttribute(
      'aria-invalid',
      state.intervalReject ? 'true' : 'false',
    );
    ui.minPhotoIntervalNote.textContent = cameraIntervalNote(
      preset,
      o.minPhotoIntervalS,
    );
    renderCameraChecklist(o);
    ui.presetInfo.textContent = presetSummary(intervalPreset);
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
    {
      const s = state.surface;
      ui.clearance.value = lengthField(s.minM);
      ui.clearanceOut.textContent = lengthText(s.minM);
      ui.margin.value = lengthField(s.marginM);
      ui.marginOut.textContent = lengthText(s.marginM);
      ui.surfaceUse.value = s.enabled ? 'on' : 'off';
      const have = s.status === 'ready';
      ui.surfaceUseRow.hidden = !have;
      ui.clearanceRow.hidden = !have;
      ui.marginRow.hidden = !have;
      ui.surfaceStatus.textContent =
        s.status === 'ready'
          ? t(
              '{n} surface model(s) cover this area: {names}. Inside them, orbit heights and the clearance check use the model; outside, the tree / obstacle height setting is used.',
              {
                n: num(s.ids.length),
                names: s.headers
                  .filter((h) => s.ids.includes(h.id))
                  .map((h) => h.name)
                  .join(', '),
              },
            )
          : s.status === 'signin'
            ? t('Sign in through byrd-it.com to use surface models.')
            : s.status === 'error'
              ? t(
                  'The surface models could not be read. The tree / obstacle height setting is used.',
                )
              : s.status === 'loading'
                ? t('Looking for a surface model of this area')
                : t(
                    'No surface model covers this area, so the tree / obstacle height setting is used.',
                  );
      ui.surfaceDisclaimer.hidden = !have;
      ui.surfaceDisclaimer.textContent = t(
        'The surface model is built from photos. It does not reliably show bare branches, single limbs, power lines or guy wires, and trees change with the season. Keep visual line of sight and fly with margin. Clearance is a warning only: your route is never changed.',
      );
    }
    ui.photoMode.value = o.photoMode;
    o.captureMode = cleanCaptureMode(o.captureMode);
    o.continuousRoute = o.continuousRoute === true;
    o.intervalTriggerProven = INTERVAL_TRIGGER_PROVEN;
    o.maxWaypoints = cleanMaxWaypoints(o.maxWaypoints);
    o.usableBatteryMin = cleanUsableBatteryMin(o.usableBatteryMin);
    o.photoSpacingM = cleanPhotoSpacingM(o.photoSpacingM);
    ui.captureMode.value = o.captureMode;
    ui.spacingSource.value = o.photoSpacingM > 0 ? 'distance' : 'overlap';
    ui.spacingLabel.textContent = t('Photo spacing ({unit})', {
      unit: lengthUnit(),
    });
    if (o.photoSpacingM > 0)
      ui.photoSpacing.value = lengthField(o.photoSpacingM);
    ui.maxWaypoints.value = String(o.maxWaypoints);
    ui.usableBattery.value = String(o.usableBatteryMin);
    ui.continuous.checked = o.continuousRoute;
    const intervalCapture = isContinuousCapture(o.captureMode);
    const surveyCapture = intervalCapture && o.pattern !== 'orbit';
    ui.spacingSourceRow.hidden = !surveyCapture;
    ui.spacingRow.hidden = !surveyCapture || !(o.photoSpacingM > 0);
    ui.continuousRow.hidden = !surveyCapture;
    ui.continuousNote.hidden = !surveyCapture;
    ui.speed.value = String(Math.round(speedFromMs(o.speedMs) * 10) / 10);
    ui.speedOut.textContent = speedWithMphText(o.speedMs);
    o.timedIntervalS = cleanTimedIntervalS(o.timedIntervalS);
    // Do not rewrite what is being typed when it already means the same number.
    if (cleanTimedIntervalS(ui.timedInterval.value) !== o.timedIntervalS) {
      ui.timedInterval.value =
        o.timedIntervalS == null ? '' : String(o.timedIntervalS);
    }
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
    renderTiming();
    renderCaptureReadout();
    renderStepLines();
  }

  /**
   * The compact "Speed & photo timing" block. Everything here is read from
   * the current settings with the same math the plan uses (the along-track
   * footprint, speed x interval); a setting that cannot give a number gives
   * no number. Nothing here changes the speed, the height or the plan: the
   * only controls that do are the ones the person presses.
   */
  function renderTiming() {
    if (!ui.timing) return;
    const o = state.options;
    const orbit = o.pattern === 'orbit';
    const timed = o.captureMode === 'timed';
    const show = (node, on) => {
      node.hidden = !on;
    };
    const tone = (node, value) => {
      if (value) node.setAttribute('data-tone', value);
      else node.removeAttribute('data-tone');
      node.style.color = value ? (WARNING_TONE_COLOR[value] ?? '') : '';
    };
    const preset = presetWithPhotoInterval(
      getPreset(o.presetId),
      o.minPhotoIntervalS,
    );
    const requestedMs = effectiveSpeedMs(o.speedMs, preset);

    // Requested vs planned speed: the plan can lower the speed in Stop mode.
    const plan = !state.dirty && !state.busy ? state.result?.plan : null;
    const lowered =
      plan && Number(plan.speedMs) > 0 && requestedMs - plan.speedMs > 1e-6;
    let loweredFor = t('blur at this shutter');
    if (plan?.speedLimitedBy === 'camera')
      loweredFor = t('the camera interval');
    show(ui.timingPlanned, Boolean(lowered) && !orbit);
    ui.timingPlanned.textContent = lowered
      ? t(
          'The plan flies at {planned}, not the {requested} you asked for: lowered for {why}.',
          {
            planned: speedWithMphText(plan.speedMs),
            requested: speedWithMphText(requestedMs),
            why: loweredFor,
          },
        )
      : '';
    tone(ui.timingPlanned, lowered ? 'warn' : null);

    show(ui.timingRec, !orbit);
    show(ui.timingTimed, !orbit && timed);
    show(ui.timingMode, !orbit && !timed);
    const terrainOff =
      !orbit &&
      !state.dirty &&
      state.result &&
      state.result.terrainComplete === false;
    show(ui.timingTerrain, Boolean(terrainOff));
    ui.timingTerrain.textContent = terrainOff
      ? t(
          'Terrain heights are incomplete, so the height above ground, the footprint and the interval are not known.',
        )
      : '';
    for (const key of ['data-seconds', 'data-desired-m', 'data-speed-ms'])
      ui.timingRec.removeAttribute(key);
    for (const key of [
      'data-front',
      'data-state',
      'data-seconds',
      'data-speed-ms',
    ]) {
      ui.timingResult.removeAttribute(key);
      ui.timingFit.removeAttribute(key);
    }
    ui.timingSuite.replaceChildren();
    show(ui.timingSuite, false);
    show(ui.timingResult, false);
    show(ui.timingUnder, false);
    show(ui.timingFit, false);
    show(ui.timingIntervalNote, state.timedReject === true);
    ui.timingIntervalNote.textContent =
      state.timedReject === true
        ? t(
            'That interval was not used: enter a positive number of seconds, up to {max}.',
            { max: num(MAX_TIMED_INTERVAL_S) },
          )
        : '';
    ui.timedInterval.setAttribute(
      'aria-invalid',
      state.timedReject === true ? 'true' : 'false',
    );
    show(
      ui.timingSpacingNote,
      !orbit && timed && o.timedIntervalS != null && o.photoSpacingM > 0,
    );
    if (orbit) return;
    if (terrainOff) {
      // Without the ground heights the footprint is unknown, so no figure is
      // given: not the interval, not the overlap an interval would give.
      ui.timingRecValue.textContent = '–';
      ui.timingRecNote.textContent = '';
      tone(ui.timingRecNote, null);
      return;
    }

    let figs = null;
    try {
      figs = captureFigures({
        preset,
        aglM: Math.min(Math.max(Number(o.aglM) || 0, MIN_AGL_M), AGL_CAP_M),
        tiltDeg: captureTiltDeg(o),
        frontOverlap: o.frontOverlap,
        sideOverlap: o.sideOverlap,
        photoSpacingM: null,
        speedMs: requestedMs,
        shutterDenominator: o.shutterDenominator,
      });
    } catch {
      figs = null;
    }
    const timing = figs
      ? timingFigures({
          alongM: figs.footprint.alongM,
          speedMs: requestedMs,
          frontOverlapPct: o.frontOverlap,
          timedIntervalS: timed ? o.timedIntervalS : null,
          minIntervalS: preset.minPhotoIntervalS,
        })
      : null;
    if (!timing) {
      ui.timingRecValue.textContent = '–';
      ui.timingRecNote.textContent = t(
        'Cannot be calculated for these settings: check the camera tilt and height.',
      );
      tone(ui.timingRecNote, 'warn');
      return;
    }
    ui.timingRec.setAttribute(
      'data-seconds',
      String(timing.recommendedIntervalS),
    );
    ui.timingRec.setAttribute('data-desired-m', String(timing.desiredSpacingM));
    ui.timingRec.setAttribute('data-speed-ms', String(requestedMs));
    ui.timingRecValue.textContent = t('{n} s', {
      n: num(timing.recommendedIntervalS, 1),
    });
    const under = timing.recommendedIntervalS + 1e-9 < preset.minPhotoIntervalS;
    ui.timingRecNote.textContent = under
      ? t(
          'for {front}% front overlap at {speed}. Under the camera minimum of {min} s: slow to {limit} or lower the overlap.',
          {
            front: pct(o.frontOverlap),
            speed: speedWithMphText(requestedMs),
            min: num(preset.minPhotoIntervalS, 1),
            limit: speedWithMphText(
              Math.max(
                MIN_PLAN_SPEED_MS,
                timing.desiredSpacingM / preset.minPhotoIntervalS,
              ),
            ),
          },
        )
      : t('for {front}% front overlap at {speed}', {
          front: pct(o.frontOverlap),
          speed: speedWithMphText(requestedMs),
        });
    tone(ui.timingRecNote, under ? 'warn' : null);

    if (timed && timing.chosen) {
      const c = timing.chosen;
      show(ui.timingResult, true);
      ui.timingResult.setAttribute('data-front', String(c.frontPct));
      ui.timingResult.setAttribute('data-state', c.state);
      ui.timingResult.setAttribute('data-seconds', String(c.intervalS));
      ui.timingResult.textContent =
        c.state === 'gap'
          ? t(
              '{s} s at {speed} leaves a gap: photos {gap} apart do not touch ({along} footprint). Wanted {want}% front overlap.',
              {
                s: num(c.intervalS, 1),
                speed: speedWithMphText(requestedMs),
                gap: lengthText(c.spacingM),
                along: lengthText(figs.footprint.alongM),
                want: pct(o.frontOverlap),
              },
            )
          : t(
              '{s} s at {speed} gives {front}% front overlap (wanted {want}%).',
              {
                s: num(c.intervalS, 1),
                speed: speedWithMphText(requestedMs),
                front: pct(c.frontPct),
                want: pct(o.frontOverlap),
              },
            );
      tone(
        ui.timingResult,
        c.state === 'gap' ? 'bad' : c.state === 'short' ? 'warn' : null,
      );
      if (c.underCameraMin) {
        show(ui.timingUnder, true);
        ui.timingUnder.textContent = t(
          '{s} s is under the camera minimum of {min} s: the camera may skip pictures, so this overlap is theoretical.',
          {
            s: num(c.intervalS, 1),
            min: num(preset.minPhotoIntervalS, 1),
          },
        );
        tone(ui.timingUnder, 'bad');
      }
      if (c.state !== 'meets' && c.fitSpeedMs != null) {
        show(ui.timingFit, true);
        ui.timingFit.setAttribute('data-speed-ms', String(c.fitSpeedMs));
        ui.timingFitText.textContent = t(
          'To reach {want}% with {s} s, fly at {speed}.',
          {
            want: pct(o.frontOverlap),
            s: num(c.intervalS, 1),
            speed: speedWithMphText(c.fitSpeedMs),
          },
        );
        ui.timingFitButton.textContent = t('USE {speed}', {
          speed: speedText(c.fitSpeedMs),
        });
      }
    }

    // Plan all passes: one interval, a different overlap on each pass.
    const passes = state.suite?.passes;
    if (timed && passes?.length && !state.suiteBusy) {
      const rows = suiteTimingRows(passes, o.timedIntervalS);
      if (rows.length) {
        show(ui.timingSuite, true);
        el(doc, 'p', ui.timingSuite, {
          cls: 'gev-dp-note',
          text: t(
            'Plan all passes: each pass has its own height, tilt and speed, so one interval gives each its own overlap.',
          ),
        });
        const list = el(doc, 'ul', ui.timingSuite, { cls: 'gev-dp-warnings' });
        for (const row of rows) {
          const li = el(doc, 'li', list, {
            attrs: {
              'data-role': 'timing-suite-row',
              'data-pass': row.id,
              ...(row.frontPct == null
                ? {}
                : { 'data-front': String(row.frontPct) }),
            },
            text:
              row.frontPct == null
                ? t(
                    '{pass}: {speed}, about {s} s between pictures for {want}% front.',
                    {
                      pass: row.label,
                      speed: speedText(row.speedMs),
                      s: num(row.recommendedIntervalS, 1),
                      want: pct(row.desiredFrontPct),
                    },
                  )
                : t('{pass}: {speed}, {front}% front (wanted {want}%).', {
                    pass: row.label,
                    speed: speedText(row.speedMs),
                    front: pct(row.frontPct),
                    want: pct(row.desiredFrontPct),
                  }),
          });
          const toneName =
            row.state === 'gap' ? 'bad' : row.state === 'short' ? 'warn' : null;
          if (toneName) {
            li.setAttribute('data-tone', toneName);
            li.style.color = WARNING_TONE_COLOR[toneName];
          }
        }
      }
    }
  }

  function renderCaptureReadout() {
    const box = ui.captureReadout;
    if (!box) return;
    ui.captureAlerts.replaceChildren();
    for (const key of [
      'data-seconds',
      'data-photo-m',
      'data-front',
      'data-side',
      'data-gsd',
      'data-shutter',
      'data-interval-ms',
      'data-limited-by',
      'data-pause-lat',
      'data-pause-lon',
    ])
      box.removeAttribute(key);
    const o = state.options;
    const interval = isContinuousCapture(o.captureMode);
    box.hidden = !interval;
    ui.captureDetailsBody.replaceChildren();
    if (!interval) return;
    // Short, important lines stay in the box. The long explanations go into
    // Details; the cautions in there are counted in one visible line.
    let cautionCount = 0;
    const say = (text, role, tone) => {
      const folded =
        FOLDED_CAPTURE_ROLES.has(role) ||
        !(tone === 'bad' || VISIBLE_CAPTURE_ROLES.has(role));
      if (folded && tone === 'warn') cautionCount += 1;
      const node = el(
        doc,
        'p',
        folded ? ui.captureDetailsBody : ui.captureAlerts,
        {
          cls: tone ? 'gev-dp-warning' : 'gev-dp-note',
          text,
          attrs: {
            'data-role': role,
            ...(tone ? { 'data-tone': tone } : {}),
          },
        },
      );
      if (tone && WARNING_TONE_COLOR[tone])
        node.style.color = WARNING_TONE_COLOR[tone];
      return node;
    };
    if (o.captureMode === 'distance' && INTERVAL_TRIGGER_PROVEN !== true) {
      say(
        t(
          'NOT proven on the Mini 5 Pro: test a short flight first. A wrong guess flies the lines and takes no photos.',
        ),
        'capture-unproven',
        'warn',
      );
    }
    if (o.captureMode === 'timed') {
      say(
        t(
          'Set DJI Fly to Timed shot at the interval shown and at the plan speed. The file has no photo action. You start the timed shot by hand.',
        ),
        'capture-timed',
        'warn',
      );
    }
    const preset = presetWithPhotoInterval(
      getPreset(o.presetId),
      o.minPhotoIntervalS,
    );
    const agl = Math.min(Math.max(Number(o.aglM) || 0, MIN_AGL_M), AGL_CAP_M);
    let figs = null;
    let figureError = null;
    try {
      figs = captureFigures({
        preset,
        aglM: agl,
        tiltDeg: captureTiltDeg(o),
        frontOverlap: o.frontOverlap,
        sideOverlap: o.sideOverlap,
        photoSpacingM: o.photoSpacingM,
        speedMs: o.speedMs,
        shutterDenominator: o.shutterDenominator,
        captureMode: o.captureMode,
        timedIntervalS: o.timedIntervalS,
      });
    } catch (err) {
      figureError = err;
      figs = null;
    }
    const finishReadout = () => {
      if (cautionCount > 0) {
        say(
          t('{n} cautions about pausing, resuming and light: see Details.', {
            n: num(cautionCount),
          }),
          'capture-cautions',
          'warn',
        );
      }
    };
    const saySafety = () => {
      say(t(PAUSE_MODEL_NOTE), 'capture-wind', 'warn');
      say(
        t(
          'Pausing and resuming is your procedure in DJI Fly. This tool has not verified that DJI Fly resumes after a landing. Check the first resume.',
        ),
        'capture-resume',
        'warn',
      );
      if (o.captureMode === 'timed') {
        say(
          t(
            'Timed shot may stop while the aircraft is paused or returning. After you resume, check in DJI Fly that Timed shot is running before the route continues.',
          ),
          'capture-resume-timed',
          'warn',
        );
      }
      if (o.captureMode === 'distance') {
        say(
          t(
            'The distance trigger is not proven to continue after a resume. Check that photos are still being taken after you resume.',
          ),
          'capture-resume-distance',
          'warn',
        );
      }
      say(
        t(
          'A pause and resume may fly a straight line from the landing point back to the break. That leg crosses open ground. Check it for trees. The clearance check is for the planned route only, not that resume leg.',
        ),
        'capture-clearance',
        'warn',
      );
      say(
        t(
          'The first photo after a resume may not be the right distance from the previous one. Overlap at the break can be off by one photo spacing.',
        ),
        'capture-overlap-break',
        'warn',
      );
      // saySafety is the last thing every path says: close the readout here.
      finishReadout();
    };
    if (o.pattern === 'orbit') {
      say(
        t(
          'Capture mode applies to survey lines. An orbit keeps its own photo spacing.',
        ),
        'capture-orbit',
      );
      saySafety();
      return;
    }
    if (!figs) {
      say(
        figureError?.message === 'Camera tilt reaches the horizon'
          ? t(
              'Camera tilt reaches the horizon, so the footprint cannot be calculated.',
            )
          : t('The footprint cannot be calculated for these settings.'),
        'capture-footprint-error',
        'bad',
      );
      saySafety();
      return;
    }
    box.setAttribute('data-seconds', String(figs.seconds));
    box.setAttribute('data-photo-m', String(figs.photoM));
    box.setAttribute('data-front', String(figs.frontPct));
    box.setAttribute('data-side', String(figs.sidePct));
    box.setAttribute('data-gsd', String(figs.footprint.gsdCm));
    box.setAttribute('data-shutter', String(figs.standardShutter ?? ''));
    box.setAttribute('data-interval-ms', String(figs.limits.intervalMs));
    box.setAttribute('data-limited-by', figs.limits.limitedBy);
    if (state.dirty) {
      say(
        t(
          'Plan is updating. The numbers below are from the current settings, not the last file.',
        ),
        'capture-dirty',
      );
    } else if (!state.result) {
      say(
        t(
          'No plan yet. Footprint, overlap, interval and shutter limits are from the current settings.',
        ),
        'capture-unplanned',
      );
    }
    say(
      t(
        'Footprint at this height: {along} along the track, {across} across the track, ground sample {gsd}.',
        {
          along: lengthText(figs.footprint.alongM),
          across: lengthText(figs.footprint.acrossM),
          gsd: `${num(figs.footprint.gsdCm, 2)} cm/px`,
        },
      ),
      'capture-footprint',
    );
    say(
      t('Overlap at this spacing: {front}% front, {side}% side.', {
        front: num(figs.frontPct, 1),
        side: num(figs.sidePct, 1),
      }),
      'capture-overlap',
    );
    const intervalTone =
      figs.seconds < figs.minPhotoIntervalS
        ? 'bad'
        : figs.seconds < figs.minPhotoIntervalS * 1.2
          ? 'warn'
          : undefined;
    say(
      t(
        'Seconds between pictures at the plan speed: {seconds}. Maximum speed that still keeps that spacing: {speed}.',
        {
          seconds: num(figs.seconds, 1),
          speed: speedText(figs.limits.intervalMs),
        },
      ),
      'capture-interval',
      intervalTone,
    );
    if (figs.seconds < figs.minPhotoIntervalS) {
      say(
        t(
          'Too fast for the camera: {seconds} s between pictures is under the {min} s minimum. Slow down or widen the spacing.',
          {
            seconds: num(figs.seconds, 1),
            min: num(figs.minPhotoIntervalS, 1),
          },
        ),
        'capture-interval-warn',
        'bad',
      );
    } else if (figs.seconds < figs.minPhotoIntervalS * 1.2) {
      say(
        t(
          'Close to the camera limit: {seconds} s between pictures is within 20% of the {min} s minimum.',
          {
            seconds: num(figs.seconds, 1),
            min: num(figs.minPhotoIntervalS, 1),
          },
        ),
        'capture-interval-warn',
        'warn',
      );
    }
    say(
      o.minPhotoIntervalS == null
        ? t(
            'The shortest full-resolution interval on this aircraft is {seconds} s in the preset. That figure is derived from other planners, not verified here.',
            { seconds: num(figs.minPhotoIntervalS, 1) },
          )
        : t(
            'This plan uses {seconds} s instead of the preset {preset} s. Not verified here.',
            {
              seconds: num(figs.minPhotoIntervalS, 1),
              preset: num(getPreset(o.presetId).minPhotoIntervalS, 1),
            },
          ),
      'capture-interval-derived',
    );
    const limitSpeed = speedText(figs.limits.limitMs);
    say(
      figs.limits.limitedBy === 'interval'
        ? t('The tightest speed limit is the camera interval: {speed}.', {
            speed: limitSpeed,
          })
        : figs.limits.limitedBy === 'blur'
          ? t(
              'The tightest speed limit is blur at the chosen shutter: {speed}.',
              {
                speed: limitSpeed,
              },
            )
          : t('The tightest speed limit is the aircraft: {speed}.', {
              speed: limitSpeed,
            }),
      'capture-speed-limit',
    );
    const cam = cameraPresetOrDefault(o.cameraPresetId);
    if (figs.fasterThanTable) {
      say(
        t(
          'The plan speed needs a shutter faster than 1/4000 s. Slow down. The tool cannot keep the blur limit.',
        ),
        'capture-shutter',
        'bad',
      );
    } else {
      say(
        t(
          'Do not use a shutter slower than 1/{n} s at this height and speed.',
          { n: num(figs.standardShutter) },
        ),
        'capture-shutter',
        figs.rawShutter > cam.minShutterDenominator ? 'warn' : undefined,
      );
      if (figs.rawShutter > cam.minShutterDenominator) {
        say(
          t(
            'The plan speed needs a faster shutter than the camera preset minimum of 1/{n} s.',
            { n: num(cam.minShutterDenominator) },
          ),
          'capture-shutter-warn',
          'warn',
        );
      }
    }
    say(
      t(
        'The tool cannot know the light. Read the shutter shown in DJI Fly. If you must leave the shutter open longer, slow down to the speed in the table.',
      ),
      'capture-light',
    );
    const table = el(doc, 'ul', ui.captureDetailsBody, {
      cls: 'gev-dp-warnings',
      attrs: { 'data-role': 'capture-shutter-table' },
    });
    for (const row of figs.table) {
      el(doc, 'li', table, {
        text: t(
          'Shutter 1/{n}: maximum speed {speed} at this height (blur and aircraft limits, not the photo interval).',
          { n: num(row.denominator), speed: speedText(row.maxSpeedMs) },
        ),
        attrs: { 'data-shutter': String(row.denominator) },
      });
    }
    if (!state.dirty && state.result?.totals) {
      const missions = state.result.missions ?? [];
      const maxWp = missions.reduce(
        (max, item) => Math.max(max, item.waypointCount || 0),
        0,
      );
      const photoCount = num(state.result.totals.photoCount);
      say(
        figs.seconds < figs.minPhotoIntervalS
          ? t(
              'Station count {photos} is theoretical, not photos the camera will take. The interval is under the camera minimum.',
              { photos: photoCount },
            )
          : o.captureMode === 'timed'
            ? t(
                'Estimated stations in the plan: {photos}. This is not a count of photos the camera will take. You start the timed shot by hand.',
                { photos: photoCount },
              )
            : t('Photos in the plan: {photos}.', { photos: photoCount }),
        'capture-counts',
        figs.seconds < figs.minPhotoIntervalS ? 'bad' : undefined,
      );
      // Which files hold which waypoints is detail: it goes in Details.
      say(
        t(
          'Waypoints in each file: {waypoints}. Largest file: {max} waypoints.',
          {
            waypoints:
              missions.map((item) => num(item.waypointCount)).join(' / ') ||
              num(0),
            max: num(maxWp),
          },
        ),
        'capture-waypoints',
      );
      const minutes = o.usableBatteryMin;
      const battery = continuousBatteryLines(state.result, minutes);
      if (battery) {
        for (const line of battery.lines) {
          if (Number.isFinite(line.lat) && Number.isFinite(line.lon)) {
            box.setAttribute('data-pause-lat', String(line.lat));
            box.setAttribute('data-pause-lon', String(line.lon));
          }
          say(line.text, line.role, line.tone);
        }
      } else {
        const count = usableBatteryCount(
          state.result.totals.durationS,
          minutes,
        );
        if (count != null) {
          say(
            t(
              'Estimated flight time {time} at the plan speed. At {minutes} usable minutes per battery that is about {count} batteries. Each extra survey line in a battery adds 3 seconds. Wind and extra climb time are not in the model, so the real pause point moves.',
              {
                time: durationText(state.result.totals.durationS),
                minutes: num(minutes),
                count: num(count),
              },
            ),
            'capture-batteries',
            'warn',
          );
        }
      }
    }
    saySafety();
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
  /** Clearance of the route to the surface model: warn only. */
  function renderClearance(plan) {
    const s = state.surface;
    const model = s.enabled ? s.model : null;
    if (!model) {
      state.clearance = null;
      preview.setClearance?.([]);
      return;
    }
    const key = JSON.stringify([s.ids, s.minM, s.marginM]);
    const cached = state.clearanceCache;
    let found;
    if (cached && cached.plan === plan && cached.key === key) {
      found = cached.found;
    } else {
      found = checkClearance({
        legs: plan.legs,
        model,
        minClearanceM: s.minM,
        errorMarginM: s.marginM,
      });
      state.clearanceCache = { plan, key, found };
    }
    state.clearance = found;
    preview.setClearance?.(found.spans);
    const box = el(doc, 'div', ui.conflictBox, {
      attrs: { 'data-role': 'clearance' },
    });
    const total = found.covered + found.outside;
    if (!found.covered) {
      el(doc, 'p', box, {
        cls: 'gev-dp-note',
        attrs: { 'data-role': 'clearance-outside' },
        text: t(
          'The route is outside the surface model, so its clearance is not checked. The tree / obstacle height setting is used.',
        ),
      });
      return;
    }
    if (!found.spanCount) {
      el(doc, 'p', box, {
        cls: 'gev-dp-note',
        attrs: { 'data-role': 'clearance-none' },
        text: t(
          'Surface model: every checked point keeps at least {need} from the canopy and roofs it shows ({min} clearance plus {margin} position error).',
          {
            need: lengthText(found.requiredM),
            min: lengthText(s.minM),
            margin: lengthText(s.marginM),
          },
        ),
      });
    } else {
      el(doc, 'p', box, {
        cls: 'gev-dp-warning',
        attrs: { 'data-role': 'clearance-summary' },
        text: t(
          'Too close to the surface model in {n} places. The closest point is {worst} away; {need} is wanted ({min} clearance plus {margin} position error). The route is not changed: raise it, move it or accept the risk. Red on the globe.',
          {
            n: num(found.spanCount),
            worst: lengthText(found.worst.distM, 1),
            need: lengthText(found.requiredM),
            min: lengthText(s.minM),
            margin: lengthText(s.marginM),
          },
        ),
      });
      for (const span of found.spans.slice(0, MAX_LISTED)) {
        el(doc, 'p', box, {
          cls: 'gev-dp-warning',
          attrs: { 'data-role': 'clearance-span' },
          text: t(
            'Clearance: {length} of the route comes within {dist} of the canopy or a roof (it is {top} high there, the drone {agl} above ground)',
            {
              length: lengthText(Math.max(span.lengthM, 1)),
              dist: lengthText(span.minDistM, 1),
              top: lengthText(span.topAglM ?? 0),
              agl: lengthText(span.minAt.aglM),
            },
          ),
        });
      }
      if (found.spanCount > MAX_LISTED) {
        el(doc, 'p', box, {
          cls: 'gev-dp-note',
          text: t('And {n} more places', {
            n: num(found.spanCount - MAX_LISTED),
          }),
        });
      }
    }
    if (found.outside > 0 && total > 0) {
      el(doc, 'p', box, {
        cls: 'gev-dp-note',
        attrs: { 'data-role': 'clearance-partial' },
        text: t(
          '{n}% of the route is outside the surface model and is not checked.',
          { n: num(Math.round((100 * found.outside) / total)) },
        ),
      });
    }
  }

  function renderConflicts() {
    ui.conflictBox.replaceChildren();
    const plan = state.result?.plan;
    if (!plan?.legs?.length) {
      state.clearance = null;
      preview.setClearance?.([]);
      return;
    }
    renderClearance(plan);
    const footprints = footprintCache.get(areasKey()) ?? [];
    const obstacles = obstacleStore.list();
    // The check is not cheap: keep the answer until the plan, the footprints,
    // the obstacles or the zone width change.
    const key = JSON.stringify([obstacles, state.check.halfWidthM]);
    const cached = state.conflictCache;
    let found;
    if (
      cached &&
      cached.plan === plan &&
      cached.footprints === footprints &&
      cached.key === key
    ) {
      found = cached.found;
    } else {
      found = checkConflicts({
        legs: plan.legs,
        buildings: footprints,
        obstacles,
        zoneHalfWidthM: state.check.halfWidthM,
      });
      state.conflictCache = { plan, footprints, key, found };
    }
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
    for (const c of found.conflicts.slice(0, MAX_LISTED)) {
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
    if (found.conflicts.length > MAX_LISTED) {
      el(doc, 'p', ui.conflictBox, {
        cls: 'gev-dp-note',
        text: t('And {n} more conflicts', {
          n: num(found.conflicts.length - MAX_LISTED),
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
    photoCheck?.refresh();
    ensurePreviews();
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
      if (!text) continue;
      const tone = warningTone(w.code);
      const node = el(doc, 'li', ui.warnings, {
        text,
        attrs: {
          'data-code': w.code,
          ...(tone ? { 'data-tone': tone } : {}),
        },
      });
      if (tone && WARNING_TONE_COLOR[tone])
        node.style.color = WARNING_TONE_COLOR[tone];
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
    const label = planLabel();
    el(doc, 'p', list, {
      cls: 'gev-dp-note',
      text: label
        ? t(
            'Flights are labelled {code}: name each placeholder mission in DJI Fly with its code (see the cheat sheet in the Plan library)',
            { code: flightCode(label.no) },
          )
        : t(
            'Save this plan in the Plan library to give its missions an M number (M1, M2, ...) and a labelled picture',
          ),
      attrs: { 'data-role': 'mission-label-note' },
    });
    missions.forEach((m, i) => {
      const row = el(doc, 'div', list, { cls: 'gev-dp-mission' });
      el(doc, 'span', row, {
        cls: 'gev-dp-mission-label',
        attrs: label
          ? { 'data-code': flightCode(label.no, i, missions.length) }
          : {},
        text:
          (label ? `${flightCode(label.no, i, missions.length)} · ` : '') +
          t('Mission {n}: {wp} waypoints, {photos} photos, {time}', {
            n: num(i + 1),
            wp: num(m.waypointCount),
            photos: num(m.photoCount),
            time: durationText(m.durationS),
          }) +
          (m.jobName && result.jobs?.length > 1 ? ` · ${m.jobName}` : ''),
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
      const pic = el(doc, 'button', row, {
        cls: 'data-toggle-chip',
        text: t('PICTURE'),
        attrs: {
          type: 'button',
          'data-preview': String(i),
          title: t(
            'Download the labelled preview picture of this mission (JPG)',
          ),
        },
      });
      pic.disabled = !downloadsAllowed() || !label;
      pic.addEventListener('click', () => downloadPreview(i));
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
    await ensureSurfaces();
    const probe = surfaceProbe();
    try {
      for (const pass of suiteOptions(state.options)) {
        const plan = planAreas(state.areas, {
          ...pass.options,
          takeoff: state.takeoff,
          jobGrouping: state.jobGrouping,
          surfaceProbe: probe,
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
          result: carryUsableBattery(
            assembleAreaPlan(plan, { ...ground, wpM: byId, obstacleM }),
          ),
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
    const suite = state.suite;
    const label = planLabel();
    const finish = (pics) => {
      if (state.suite !== suite) return false; // replanned while waiting
      const bytes = buildSuiteZip(suite.passes, {
        when,
        wpml: wpmlOverride(),
        controllerIds: state.controllerIds,
        label,
        previews: pics,
      });
      for (const pass of suite.passes) if (pass.result) checkBuilt(pass.result);
      const stamp = label
        ? labelStem(label)
        : kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
      downloadFile(`${stamp}-all-passes.zip`, bytes, 'application/zip');
      if (label && pics.some((b) => !b)) {
        status(t('The picture could not be drawn in this browser'), 'warn');
      }
      return true;
    };
    const results = suite.passes.map((p) => p.result).filter(Boolean);
    const have = flightsOf(results).map((item) => previewFor(label, item));
    if (label && have.some((b) => !b)) {
      return allPreviews(label, results).then(finish);
    }
    return finish(have);
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

  // ------------------------------------------------------ mission labels --
  /** The plan open in the library as { no, name }, or null (not saved/numbered). */
  const planLabel = () => {
    const l = library?.currentLabel?.() ?? null;
    return hasLabel(l) ? l : null;
  };

  // The labelled pictures, drawn in the background (a canvas is async) and
  // kept per mission; a download takes the ones that are ready.
  const previews = new WeakMap(); // mission -> { key, bytes }
  const previewKey = (label, flight, total) =>
    `${flightCode(label.no, flight, total)}|${label.name}`;
  /** The picture of this flight, only when it was drawn with this flight's code. */
  const previewFor = (label, { mission, flight, total }) => {
    if (!label) return null;
    const have = previews.get(mission);
    return have?.key === previewKey(label, flight, total) ? have.bytes : null;
  };

  /**
   * The flights of a group of results in export order. A suite zip numbers its
   * flights across the passes, so its pictures must too (M5-2 is the second
   * flight of the whole suite, whichever pass it is in).
   */
  const flightsOf = (results) => {
    const total = results.reduce((sum, r) => sum + r.missions.length, 0);
    let flight = 0;
    return results.flatMap((result) =>
      result.missions.map((mission, index) => ({
        result,
        mission,
        index,
        flight: flight++,
        total,
      })),
    );
  };

  function previewSpec(label, { result, mission, flight, total }) {
    return {
      code: flightCode(label.no, flight, total),
      title: flightTitle(label, flight, total),
      points: (mission.waypoints ?? []).map((w) => ({
        lat: w.lat,
        lon: w.lon,
      })),
      takeoff: result.plan?.takeoff ?? null,
    };
  }

  const inflight = new WeakMap(); // mission -> { key, promise }

  function makePreview(label, item) {
    const { mission, flight, total } = item;
    const key = previewKey(label, flight, total);
    const have = previews.get(mission);
    if (have?.key === key) return Promise.resolve(have.bytes);
    const running = inflight.get(mission);
    if (running?.key === key) return running.promise;
    const promise = (async () => {
      try {
        const out = await renderPreview(previewSpec(label, item));
        if (!out?.bytes) return null;
        previews.set(mission, { key, bytes: out.bytes });
        return out.bytes;
      } finally {
        if (inflight.get(mission)?.key === key) inflight.delete(mission);
      }
    })();
    inflight.set(mission, { key, promise });
    return promise;
  }

  /** The two groups that can be exported: the open plan, and the suite zip. */
  const exportGroups = () =>
    [
      state.result ? [state.result] : [],
      (state.suite?.passes ?? []).map((p) => p.result).filter(Boolean),
    ].filter((g) => g.length);

  /** Wait for the pictures of every flight of a group (null = could not draw). */
  const allPreviews = (label, results) =>
    Promise.all(
      flightsOf(results).map((item) =>
        makePreview(label, item).catch(() => null),
      ),
    );

  /** Start drawing the pictures of the current plan (and suite passes). */
  function ensurePreviews() {
    const label = planLabel();
    if (!label) return;
    for (const group of exportGroups()) {
      for (const item of flightsOf(group)) {
        makePreview(label, item).catch(() => {});
      }
    }
  }

  async function downloadPreview(index) {
    const result = state.result;
    const label = planLabel();
    if (!downloadsAllowed() || !label || !result?.missions[index]) {
      return false;
    }
    const total = result.missions.length;
    const bytes = await makePreview(label, {
      result,
      mission: result.missions[index],
      index,
      flight: index,
      total,
    });
    if (!bytes) {
      status(t('The picture could not be drawn in this browser'), 'warn');
      return false;
    }
    downloadFile(
      flightFileName(label, index, total, 'jpg').replace(
        /\.jpg$/,
        '_preview.jpg',
      ),
      bytes,
      'image/jpeg',
    );
    return true;
  }

  function downloadMission(index, when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed() || !result.missions[index]) return false;
    const label = planLabel();
    const total = result.missions.length;
    const bytes = buildKmz(result.missions[index], result.plan, {
      when,
      wpml: wpmlOverride(),
      name: label
        ? flightTitle(label, index, total)
        : `GEV Drone Flight Plan ${index + 1}/${total}`,
    });
    const named = (result.jobs ?? []).length > 1;
    const mission = result.missions[index];
    const same = named
      ? result.missions.filter((item) => item.jobId === mission.jobId)
      : result.missions;
    // A controller mission id names the file <UUID>.kmz, as DJI Fly does.
    const controllerId = controllerFileId(state.controllerIds[index]);
    const fileName = controllerId
      ? `${controllerId}.kmz`
      : label
        ? flightFileName(label, index, total)
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

  /**
   * Returns true, or - when the labelled pictures are still being drawn - a
   * promise of true: the zip waits for them so it never ships without.
   */
  function downloadAll(when = new Date()) {
    const result = state.result;
    if (!downloadsAllowed()) return false;
    const label = planLabel();
    const finish = (pics) => {
      if (state.result !== result) return false; // replanned while waiting
      const bytes = buildBundleZip(result, {
        when,
        wpml: wpmlOverride(),
        controllerIds: state.controllerIds,
        label,
        previews: pics,
      });
      const stamp = label
        ? labelStem(label)
        : kmzFileName(0, 1, when).replace(/-m1of1\.kmz$/, '');
      downloadFile(`${stamp}-all.zip`, bytes, 'application/zip');
      checkBuilt(result);
      if (label && pics.some((b) => !b)) {
        status(t('The picture could not be drawn in this browser'), 'warn');
      }
      return true;
    };
    const items = flightsOf([result]);
    const have = items.map((item) => previewFor(label, item));
    if (label && have.some((b) => !b)) {
      // Use the bytes that were just drawn, not a second cache read: a rename
      // meanwhile changes the cache key but this zip keeps its own label.
      return allPreviews(label, [result]).then(finish);
    }
    return finish(have);
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
    refreshImportCheck([]).catch(() => {});
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
  let photoCheck = null;

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
    // A plan saved before the camera preset existed gets the default one.
    state.options.cameraPresetId = DEFAULT_CAMERA_PRESET_ID;
    Object.assign(state.options, plan.options);
    state.options.captureMode = cleanCaptureMode(state.options.captureMode);
    state.options.continuousRoute = state.options.continuousRoute === true;
    // A saved plan cannot suppress the Mini 5 Pro unproven notice.
    state.options.intervalTriggerProven = INTERVAL_TRIGGER_PROVEN;
    state.options.maxWaypoints = cleanMaxWaypoints(
      state.options.maxWaypoints ?? MAX_WAYPOINTS_PER_MISSION,
    );
    state.options.usableBatteryMin = cleanUsableBatteryMin(
      state.options.usableBatteryMin ?? DEFAULT_USABLE_BATTERY_MIN,
    );
    state.options.photoSpacingM = cleanPhotoSpacingM(
      state.options.photoSpacingM,
    );
    // A plan saved before this setting has no interval; do not keep the last
    // plan's. The planDoc check already dropped unusable numbers.
    state.options.timedIntervalS = cleanTimedIntervalS(
      plan.options.timedIntervalS,
    );
    state.timedReject = false;
    // Absence in the file is unset. Do not keep a previous plan's override.
    state.options.minPhotoIntervalS = cleanMinPhotoIntervalS(
      plan.options.minPhotoIntervalS,
    );
    state.intervalReject = false;
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
      showOnMap: (items) => {
        preview.showImports(items);
        refreshImportCheck(items).catch(() => {});
      },
      download: (name, bytes, type) => downloadFile(name, bytes, type),
      // The open plan (or its number) changed: redraw labels and pictures.
      labelChanged: () => {
        ensurePreviews();
        render();
      },
    },
  });

  // ------------------------------------------------------- photo check --
  photoCheck = mountPhotoCheck({
    doc,
    container: ui.photoCheck,
    dropZone: panel,
    host: {
      planned: () => ({ suite: state.suite, result: state.result }),
      plannedGsdCm: () => state.result?.totals?.gsdCm ?? null,
      showOnMap: (data) => preview.showPhotoCheck(data),
      flyToMap: () => preview.flyToPhotoCheck(),
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
    if (Object.hasOwn(patch, 'captureMode')) {
      o.captureMode = cleanCaptureMode(patch.captureMode);
      plan = true;
    }
    if (Object.hasOwn(patch, 'photoSpacingM')) {
      o.photoSpacingM = cleanPhotoSpacingM(patch.photoSpacingM);
      plan = true;
    }
    if (Object.hasOwn(patch, 'timedIntervalS')) {
      o.timedIntervalS = cleanTimedIntervalS(patch.timedIntervalS);
      state.timedReject = false;
      plan = true;
    }
    if (Object.hasOwn(patch, 'continuousRoute')) {
      o.continuousRoute = patch.continuousRoute === true;
      plan = true;
    }
    // intervalTriggerProven is not a voice or options control.
    if (Object.hasOwn(patch, 'maxWaypoints')) {
      o.maxWaypoints = cleanMaxWaypoints(patch.maxWaypoints);
      plan = true;
    }
    if (Object.hasOwn(patch, 'usableBatteryMin')) {
      o.usableBatteryMin = cleanUsableBatteryMin(patch.usableBatteryMin);
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
    photoCheck: () => photoCheck,
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
    downloadPreview,
    ensurePreviews,
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
      photoCheck?.destroy();
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
