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
 *   splat-orbit  - rings around the centre, camera on the centre (splats)
 *   fast-survey  - nadir grid, high and loose, photos by distance (coverage)
 */
import { footprint, planFlight, spacing } from './planner.js';
import {
  DEFAULT_SHUTTER_DENOMINATOR,
  floorTo,
  minShutterDenominator,
  speedLimits,
} from './speed.js';

export const MODES = Object.freeze([
  'mapping-grid',
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
  'splat-orbit': Object.freeze({
    pattern: 'orbit',
    photoMode: 'waypoint',
    aglM: 80,
    frontOverlap: 80,
    sideOverlap: null,
    // The camera follows the ring: the planner points it at the centre.
    gimbalPitchDeg: null,
    tiltPitchDeg: -60,
    orbitHeightsM: Object.freeze([40, 80]),
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

/** Which mode a set of planner options is in. */
export function modeFor(options) {
  if (options?.pattern === 'orbit') return 'splat-orbit';
  if (options?.photoMode === 'interval') return 'fast-survey';
  return 'mapping-grid';
}

/** The planner options that SELECT a mode (pattern and photo mode). */
export function modeOptions(mode) {
  const base = MODE_BASE[mode] ?? MODE_BASE[DEFAULT_MODE];
  return { pattern: base.pattern, photoMode: base.photoMode };
}

/**
 * The recommended settings for `preset` in `mode`.
 * @param {object} preset
 * @param {string} mode One of MODES.
 * @param {{ orbitRadiusM?: number }} [context]
 * @returns {object} planner option values plus the camera settings and the
 *   limits the speed was worked out from.
 */
export function recommend(preset, mode, context = {}) {
  const base = MODE_BASE[mode] ?? MODE_BASE[DEFAULT_MODE];
  const agl = base.aglM;
  let limits;
  let gsdCm;
  if (base.pattern === 'orbit') {
    // The orbit's photo spacing and ground detail come from the planner's own
    // ring maths, so the recommendation can never disagree with the plan.
    const radius = context.orbitRadiusM ?? REFERENCE_ORBIT_RADIUS_M;
    const half = 0.0005;
    const plan = planFlight(
      { west: 0 - half, east: half, south: 30 - half, north: 30 + half },
      {
        presetId: preset.id,
        pattern: 'orbit',
        orbitRadiusM: radius,
        orbitHeightsM: base.orbitHeightsM,
        frontOverlap: base.frontOverlap,
        shutterDenominator: base.shutterDenominator,
      },
    );
    limits = plan.speedLimits;
    gsdCm = plan.gsdCm;
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
  return {
    mode,
    presetId: preset.id,
    pattern: base.pattern,
    photoMode: base.photoMode,
    aglM: agl,
    frontOverlap: base.frontOverlap,
    sideOverlap: base.sideOverlap,
    gimbalPitchDeg: base.gimbalPitchDeg,
    tiltPitchDeg: base.tiltPitchDeg,
    orbitHeightsM: base.orbitHeightsM ? [...base.orbitHeightsM] : null,
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
  'orbitHeightsM',
  'speedMs',
  'shutterDenominator',
]);

/** The planner options of a recommendation, ready to assign. */
export function recommendedOptions(rec) {
  const out = {};
  for (const key of RECOMMENDED_OPTION_KEYS) {
    // Side overlap is not used by an orbit: leave the user's value alone.
    if (rec[key] === null && key === 'sideOverlap') continue;
    out[key] = rec[key];
  }
  return out;
}
