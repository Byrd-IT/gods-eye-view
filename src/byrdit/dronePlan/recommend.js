/**
 * Recommended settings per aircraft and mode, for the Drone Flight Plan panel
 * ("use recommended"). The numbers are the consensus in drone_specs.json
 * (documentation card t_b9148c02): Pix4D (official) for overlap and nadir
 * grids, MipMap / Splatimation for Gaussian-splat orbits, ODM for fast 2D
 * surveys. They are guidance, not rules; each aircraft's own limits (photo
 * interval, blur, top speed) are applied on top by speedLimits().
 *
 * Modes:
 *   mapping-grid - nadir grid, a photo at every waypoint (maps and 3D)
 *   mapping-grid-timed - the same grid, photos from the camera's own Timed
 *                  shot at an interval (path-only file, no photo actions)
 *   splat-orbit  - rings around the centre, camera on the centre (splats)
 *   fast-survey  - nadir grid, high and loose, photos by distance (coverage)
 */
import { footprint, planFlight, spacing } from './planner.js';
import {
  defaultTimedInterval,
  effectivePreset,
  timedIntervalOptions,
} from './cameraLimits.js';
import {
  DEFAULT_SHUTTER_DENOMINATOR,
  floorTo,
  minShutterDenominator,
  speedLimits,
} from './speed.js';
import { INTERVAL_QUICK_FILL_S } from './timing.js';

export const MODES = Object.freeze([
  'mapping-grid',
  'mapping-grid-timed',
  'splat-orbit',
  'fast-survey',
]);
export const DEFAULT_MODE = 'mapping-grid';

/** Orbit radius the recommended speed assumes when no box is drawn, metres. */
const REFERENCE_ORBIT_RADIUS_M = 40;
/** Fly this much below the speed limit, so a gust does not break overlap. */
const SPEED_MARGIN = 0.9;

const MODE_BASE = Object.freeze({
  'mapping-grid': Object.freeze({
    pattern: 'grid',
    photoMode: 'waypoint',
    aglM: 80,
    frontOverlap: 80,
    sideOverlap: 70,
    gimbalPitchDeg: -90,
    tiltPitchDeg: -60,
    orbitHeightsM: null,
    shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
  }),
  // Same numbers as mapping-grid; the camera shoots on its own clock.
  'mapping-grid-timed': Object.freeze({
    pattern: 'grid',
    photoMode: 'waypoint',
    captureMode: 'timed',
    aglM: 80,
    frontOverlap: 80,
    sideOverlap: 70,
    gimbalPitchDeg: -90,
    tiltPitchDeg: -60,
    orbitHeightsM: null,
    shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
  }),
  'splat-orbit': Object.freeze({
    pattern: 'orbit',
    photoMode: 'waypoint',
    aglM: 80,
    frontOverlap: 80,
    sideOverlap: null,
    // The camera follows the ring: the planner points it at the centre.
    gimbalPitchDeg: null,
    tiltPitchDeg: -60,
    // Rings come from viewing angles (25/40/55 degrees down), not heights.
    orbitHeightsM: null,
    orbitRingMode: 'angles',
    shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
  }),
  'fast-survey': Object.freeze({
    pattern: 'grid',
    photoMode: 'interval',
    aglM: 120,
    frontOverlap: 75,
    sideOverlap: 60,
    gimbalPitchDeg: -90,
    tiltPitchDeg: -60,
    orbitHeightsM: null,
    shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
  }),
});

/**
 * Which mode a set of planner options is in. Precedence: an orbit is a splat
 * orbit, a by-distance photo mode is a fast survey; of the rest, Timed capture
 * is Mapping grid (Timed) and everything else Mapping grid (Waypoints).
 */
export function modeFor(options) {
  if (options?.pattern === 'orbit') return 'splat-orbit';
  if (options?.photoMode === 'interval') return 'fast-survey';
  if (options?.captureMode === 'timed') return 'mapping-grid-timed';
  return 'mapping-grid';
}

/**
 * The planner options that SELECT a mode (pattern and photo mode; Timed also
 * names its capture mode).
 */
export function modeOptions(mode) {
  const base = MODE_BASE[mode] ?? MODE_BASE[DEFAULT_MODE];
  const out = { pattern: base.pattern, photoMode: base.photoMode };
  if (base.captureMode) out.captureMode = base.captureMode;
  return out;
}

/** The two mapping-grid modes: they differ only in who takes the photos. */
const isMappingMode = (mode) =>
  mode === 'mapping-grid' || mode === 'mapping-grid-timed';

/**
 * The option values to set when the person PICKS `mode`; {} when the options
 * are already in that mode. Nothing else is touched. A grid or double pattern
 * stays between the mapping modes, so a tilted double grid survives the switch
 * between Waypoints and Timed. Picking Timed turns the camera's Timed shot on
 * and the photo mode to waypoints; picking Waypoints from Timed turns Stop
 * capture back on. The other modes keep today's behaviour exactly.
 * @returns {{ pattern?:string, photoMode?:string, captureMode?:string }}
 */
export function modeSelectionPatch(options, mode) {
  if (!MODES.includes(mode) || modeFor(options) === mode) return {};
  const next = modeOptions(mode);
  const patch = { pattern: next.pattern, photoMode: next.photoMode };
  if (
    isMappingMode(mode) &&
    (options?.pattern === 'grid' || options?.pattern === 'double')
  ) {
    patch.pattern = options.pattern;
  }
  if (next.captureMode) patch.captureMode = next.captureMode;
  else if (options?.captureMode === 'timed') {
    // Leaving Timed for any other mode turns Stop capture back on, so an
    // orbit or a Fast survey never keeps the camera's timer by accident.
    patch.captureMode = 'stop';
  }
  return patch;
}

/**
 * An orbit recommendation runs a full planFlight(), and the panel asks for it
 * on every slider input. The result depends only on the aircraft, the mode and
 * the orbit radius (everything else comes from MODE_BASE), so keep the last
 * results per preset object. Keyed by the preset object itself, not its id, so
 * an edited copy never reads a stale entry. Callers get fresh copies: they may
 * mutate what recommend() returns.
 */
const orbitCache = new WeakMap();
const ORBIT_CACHE_MAX_PER_PRESET = 32;
let orbitPlanRuns = 0;

/** How many full orbit plans recommend() has run (for tests). */
export function orbitPlanRunCount() {
  return orbitPlanRuns;
}

function orbitLimits(preset, mode, base, radius, cameraPresetId) {
  let perPreset = orbitCache.get(preset);
  if (!perPreset) {
    perPreset = new Map();
    orbitCache.set(preset, perPreset);
  }
  const key = `${mode}|${radius}`;
  let hit = perPreset.get(key);
  if (!hit) {
    orbitPlanRuns += 1;
    const half = 0.0005;
    const plan = planFlight(
      { west: 0 - half, east: half, south: 30 - half, north: 30 + half },
      {
        presetId: preset.id,
        cameraPresetId,
        pattern: 'orbit',
        orbitRadiusM: radius,
        orbitHeightsM: base.orbitHeightsM,
        frontOverlap: base.frontOverlap,
        shutterDenominator: base.shutterDenominator,
      },
    );
    hit = { limits: plan.speedLimits, gsdCm: plan.gsdCm };
    if (perPreset.size >= ORBIT_CACHE_MAX_PER_PRESET) {
      perPreset.delete(perPreset.keys().next().value);
    }
    perPreset.set(key, hit);
  }
  return { limits: { ...hit.limits }, gsdCm: hit.gsdCm };
}

/**
 * The recommended settings for `aircraft` in `mode`. The numbers are worked
 * out with the effective preset of the chosen photo size
 * (`context.cameraPresetId`, cameraLimits.js): an aircraft with a 12 MP / 50 MP
 * choice gets that size's pixel size and shortest interval, any other
 * aircraft its own preset. Timed mode also returns the interval to start from.
 * @param {object} aircraft
 * @param {string} mode One of MODES.
 * @param {{ orbitRadiusM?: number, cameraPresetId?: string }} [context]
 * @returns {object} planner option values plus the camera settings and the
 *   limits the speed was worked out from.
 */
export function recommend(aircraft, mode, context = {}) {
  const base = MODE_BASE[mode] ?? MODE_BASE[DEFAULT_MODE];
  const preset = effectivePreset(aircraft, context.cameraPresetId);
  const agl = base.aglM;
  let limits;
  let gsdCm;
  if (base.pattern === 'orbit') {
    // The orbit's photo spacing and ground detail come from the planner's own
    // ring maths, so the recommendation can never disagree with the plan.
    const radius = context.orbitRadiusM ?? REFERENCE_ORBIT_RADIUS_M;
    ({ limits, gsdCm } = orbitLimits(
      preset,
      mode,
      base,
      radius,
      context.cameraPresetId,
    ));
  } else {
    const fp = footprint(preset, agl, 0);
    gsdCm = fp.gsdCm;
    limits = speedLimits({
      preset,
      photoSpacingM: spacing(fp, base.frontOverlap, base.sideOverlap).photoM,
      gsdCm: fp.gsdCm,
      shutterDenominator: base.shutterDenominator,
    });
  }
  const speedMs = Math.max(
    0.1,
    floorTo(
      Math.min(limits.limitMs * SPEED_MARGIN, preset.defaultSpeedMs),
      0.1,
    ),
  );
  // Timed shot never goes without an interval: start from one of the camera's
  // own options (null for an aircraft with no list of its own).
  let timedIntervalS = null;
  if (base.captureMode === 'timed') {
    timedIntervalS = defaultTimedInterval({
      options:
        timedIntervalOptions(preset, context.cameraPresetId) ??
        INTERVAL_QUICK_FILL_S,
      minIntervalS: preset.minPhotoIntervalS,
      alongM: footprint(preset, agl, 0).alongM,
      speedMs,
      frontOverlapPct: base.frontOverlap,
    });
  }
  return {
    mode,
    presetId: preset.id,
    pattern: base.pattern,
    photoMode: base.photoMode,
    captureMode: base.captureMode ?? null,
    timedIntervalS,
    aglM: agl,
    frontOverlap: base.frontOverlap,
    sideOverlap: base.sideOverlap,
    gimbalPitchDeg: base.gimbalPitchDeg,
    // Use Recommended puts a plain grid's gimbal back straight down.
    gridPitchDeg: base.gimbalPitchDeg ?? -90,
    tiltPitchDeg: base.tiltPitchDeg,
    orbitHeightsM: base.orbitHeightsM ? [...base.orbitHeightsM] : null,
    orbitRingMode: base.orbitRingMode ?? null,
    speedMs,
    shutterDenominator: base.shutterDenominator,
    // Camera settings to type into DJI Fly / GO 4 (the file cannot set them).
    camera: {
      shutterDenominator: base.shutterDenominator,
      minShutterDenominator: minShutterDenominator(preset, gsdCm, speedMs),
      isoRange: [100, 400],
      whiteBalanceFixed: true,
      focusLocked: true,
      format: '4:3 JPEG',
      photoIntervalS: preset.minPhotoIntervalS,
    },
    limits,
  };
}

/** Option names `recommend()` returns that are planner options. */
export const RECOMMENDED_OPTION_KEYS = Object.freeze([
  'pattern',
  'photoMode',
  'aglM',
  'frontOverlap',
  'sideOverlap',
  'tiltPitchDeg',
  'gridPitchDeg',
  'orbitHeightsM',
  'orbitRingMode',
  'speedMs',
  'shutterDenominator',
]);

/**
 * The planner options of a recommendation, ready to assign. Timed mode also
 * names its capture mode and the interval to start from.
 */
export function recommendedOptions(rec) {
  const out = {};
  for (const key of RECOMMENDED_OPTION_KEYS) {
    // Side overlap is not used by an orbit: leave the user's value alone.
    if (rec[key] === null && key === 'sideOverlap') continue;
    out[key] = rec[key];
  }
  if (rec.captureMode) {
    out.captureMode = rec.captureMode;
    if (rec.timedIntervalS != null) out.timedIntervalS = rec.timedIntervalS;
  }
  return out;
}
