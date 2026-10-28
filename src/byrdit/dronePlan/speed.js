/**
 * Speed limits for the Drone Flight Plan: the fastest an aircraft may fly a
 * photo mission and still get sharp, evenly spaced pictures.
 *
 *  interval - the camera needs `minPhotoIntervalS` between frames, so the
 *             speed cannot exceed photo spacing / interval.
 *  blur     - during the exposure the aircraft moves speed x exposure metres;
 *             that smear, measured in ground pixels (speed x exposure / GSD),
 *             must stay under a limit. Electronic shutters read the sensor
 *             line by line (rolling shutter), which skews moving scenes on top
 *             of the smear, so their limit is half a pixel; a mechanical
 *             shutter is allowed one. A heuristic ("DERIVED"), not a DJI figure.
 *  aircraft - the preset's own top waypoint speed.
 * Pure functions, no DOM.
 */

export const BLUR_LIMIT_PX = Object.freeze({ electronic: 0.5, mechanical: 1 });
export const DEFAULT_SHUTTER_DENOMINATOR = 1000;
export const SHUTTER_DENOMINATORS = Object.freeze([250, 500, 1000, 2000, 4000]);
/** Never plan a speed below this: the maths stays finite. */
export const MIN_PLAN_SPEED_MS = 0.1;

/** Clean a shutter denominator (1/N s); anything unusable becomes the default. */
export function shutterDenominatorOrDefault(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 60 && n <= 8000
    ? Math.round(n)
    : DEFAULT_SHUTTER_DENOMINATOR;
}

/** Round DOWN so a limit is never exceeded by rounding. */
export const floorTo = (v, step) => Math.floor(v / step + 1e-9) * step;

/**
 * @param {{ preset: object, photoSpacingM: number, gsdCm: number,
 *   shutterDenominator?: number }} input `photoSpacingM` 0 = no spacing limit
 * @returns {{ intervalMs:number, blurMs:number, aircraftMs:number,
 *   limitMs:number, limitedBy:'interval'|'blur'|'aircraft' }}
 */
export function speedLimits({
  preset,
  photoSpacingM,
  gsdCm,
  shutterDenominator,
}) {
  const exposureS = 1 / shutterDenominatorOrDefault(shutterDenominator);
  const blurPx = BLUR_LIMIT_PX[preset.shutterType] ?? BLUR_LIMIT_PX.electronic;
  const intervalMs =
    photoSpacingM > 0 ? photoSpacingM / preset.minPhotoIntervalS : Infinity;
  const blurMs = gsdCm > 0 ? (blurPx * (gsdCm / 100)) / exposureS : Infinity;
  const aircraftMs = preset.maxSpeedMs;
  const limitMs = Math.min(intervalMs, blurMs, aircraftMs);
  let limitedBy = 'aircraft';
  if (limitMs === intervalMs) limitedBy = 'interval';
  else if (limitMs === blurMs) limitedBy = 'blur';
  return { intervalMs, blurMs, aircraftMs, limitMs, limitedBy };
}

/**
 * The slowest shutter (largest 1/N exposure) that keeps the blur under the
 * limit at `speedMs`, as the denominator N, rounded up to a whole number.
 */
export function minShutterDenominator(preset, gsdCm, speedMs) {
  const blurPx = BLUR_LIMIT_PX[preset.shutterType] ?? BLUR_LIMIT_PX.electronic;
  if (!(gsdCm > 0) || !(speedMs > 0)) return DEFAULT_SHUTTER_DENOMINATOR;
  return Math.ceil(speedMs / (blurPx * (gsdCm / 100)));
}
