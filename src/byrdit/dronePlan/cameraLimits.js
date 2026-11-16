/**
 * What the chosen photo size (12 MP or 50 MP) changes for an aircraft whose
 * camera has both: the Timed-shot interval list, the camera's shortest
 * interval and the still's pixel size (so ground detail and blur).
 *
 * One rule, in one place. `effectivePreset()` returns the aircraft preset as
 * the planner, the panel readouts and the README must all use for planning
 * maths. For an aircraft without a size choice (every aircraft but the ones
 * in PHOTO_SIZE_AIRCRAFT) it returns the preset it was given, unchanged.
 *
 * Source of the lists: DJI Mini 5 Pro specifications, Camera > Still
 * Photography Modes (Timed shot). The 12 MP image is 4096 x 3072 with the
 * same field of view as the 50 MP one (same 1-inch sensor), so only the pixel
 * size changes, never the sensor size or focal length. The Air 3S wide camera
 * is the same 1-inch 50 MP unit, so it takes the same table; DJI's Air 3S page
 * was not read for its own interval list. Neither figure was timed in flight.
 *
 * Pure: no DOM, no Cesium.
 */
import { getCameraPreset, DEFAULT_CAMERA_PRESET_ID } from './cameraSettings.js';
import { SHUTTER_DENOMINATORS, minShutterDenominator } from './speed.js';

/** Aircraft whose camera offers both photo sizes (preset ids). */
export const PHOTO_SIZE_AIRCRAFT = Object.freeze([
  'dji-mini-5-pro',
  'dji-air-3s',
]);

/**
 * Per camera size (the id of a CAMERA_PRESETS entry): the Timed-shot intervals
 * DJI lists, in seconds, and the shortest of them. The pixel size comes from
 * the camera preset itself (width x height), so it is stated only once.
 */
const SIZE_TABLE = Object.freeze({
  'mapping-50mp': Object.freeze({
    timedIntervalsS: Object.freeze([5, 7, 10, 15, 20, 30, 60]),
  }),
  'test-12mp': Object.freeze({
    timedIntervalsS: Object.freeze([2, 3, 5, 7, 10, 15, 20, 30, 60]),
  }),
});

/** True for an aircraft whose photo size drives the limits. */
export function hasPhotoSizes(preset) {
  return Boolean(preset) && PHOTO_SIZE_AIRCRAFT.includes(preset.id);
}

/**
 * The limits of one photo size on one aircraft, or null when the aircraft has
 * no size choice (keep that aircraft's own preset numbers).
 * @returns {null | { cameraPresetId:string, megapixels:number,
 *   widthPx:number, heightPx:number, timedIntervalsS:readonly number[],
 *   minIntervalS:number, source:'dji-timed-list' }}
 */
export function photoSizeLimits(preset, cameraPresetId) {
  if (!hasPhotoSizes(preset)) return null;
  const camera =
    getCameraPreset(cameraPresetId) ?? getCameraPreset(DEFAULT_CAMERA_PRESET_ID);
  const row = SIZE_TABLE[camera.id];
  if (!row) return null;
  return {
    cameraPresetId: camera.id,
    megapixels: camera.megapixels,
    widthPx: camera.width,
    heightPx: camera.height,
    timedIntervalsS: row.timedIntervalsS,
    minIntervalS: row.timedIntervalsS[0],
    source: 'dji-timed-list',
  };
}

// An effective copy per (aircraft preset object, size): the same object comes
// back every time, so caches keyed by the preset object keep working.
const copies = new WeakMap();

/**
 * The preset to plan with: the aircraft preset with the chosen photo size's
 * pixel width, pixel height and default shortest interval. Returns `preset`
 * itself when the aircraft has no size choice or already matches the size, so
 * the default 50 MP numbers are the aircraft preset's own object. A plan's own
 * "camera minimum interval" override is applied on top of this by
 * presetWithPhotoInterval() as before.
 */
export function effectivePreset(preset, cameraPresetId) {
  const limits = photoSizeLimits(preset, cameraPresetId);
  if (!limits) return preset;
  if (
    preset.imageWidthPx === limits.widthPx &&
    preset.imageHeightPx === limits.heightPx &&
    preset.minPhotoIntervalS === limits.minIntervalS
  ) {
    return preset;
  }
  let bySize = copies.get(preset);
  if (!bySize) {
    bySize = new Map();
    copies.set(preset, bySize);
  }
  let copy = bySize.get(limits.cameraPresetId);
  if (!copy) {
    copy = Object.freeze({
      ...preset,
      imageWidthPx: limits.widthPx,
      imageHeightPx: limits.heightPx,
      minPhotoIntervalS: limits.minIntervalS,
    });
    bySize.set(limits.cameraPresetId, copy);
  }
  return copy;
}

/**
 * The Timed-shot intervals to offer for this aircraft and size, ascending, or
 * null when the aircraft has no list of its own (the caller keeps its generic
 * quick-fill examples).
 */
export function timedIntervalOptions(preset, cameraPresetId) {
  return photoSizeLimits(preset, cameraPresetId)?.timedIntervalsS ?? null;
}

/**
 * The interval a Timed plan starts from: the LONGEST option (fewest photos)
 * that is not under the camera minimum and still gives at least the wanted
 * front overlap at this speed and along-track footprint. When no such option
 * exists the SHORTEST option that is not under the minimum is used (the most
 * overlap the camera can give; the panel then shows the shortfall). When every
 * option is under the minimum, the longest option. Never returns null for a
 * non-empty list.
 * @param {{ options:readonly number[], minIntervalS?:number, alongM:number,
 *   speedMs:number, frontOverlapPct:number }} input
 * @returns {number|null} null only for an empty option list
 */
export function defaultTimedInterval({
  options,
  minIntervalS = 0,
  alongM,
  speedMs,
  frontOverlapPct,
}) {
  const list = [...(options ?? [])].filter((n) => n > 0).sort((a, b) => a - b);
  if (!list.length) return null;
  const allowed = list.filter((n) => n + 1e-9 >= Number(minIntervalS || 0));
  if (!allowed.length) return list.at(-1);
  const along = Number(alongM);
  const speed = Number(speedMs);
  const front = Number(frontOverlapPct);
  if (!(along > 0) || !(speed > 0) || !Number.isFinite(front)) {
    return allowed[0];
  }
  // Overlap falls as the interval grows: it is met up to this many seconds.
  const longestS = ((1 - front / 100) * along) / speed;
  const meeting = allowed.filter((n) => n <= longestS + 1e-9);
  return meeting.length ? meeting.at(-1) : allowed[0];
}

/** The fastest still shutter DJI lists for the 1-inch camera: 1/8000 s. */
export const CAMERA_FASTEST_SHUTTER_DENOMINATOR = 8000;

/**
 * The slowest shutter that keeps the blur under the planner's half-pixel
 * heuristic (speed.js), for the plan's real speed and ground detail. An
 * ESTIMATE from that heuristic, not a DJI figure. Pass the EFFECTIVE preset so
 * the pixel size is the chosen photo size's.
 * @returns {null | { exact:number, standard:number|null, beyondTable:boolean,
 *   beyondCamera:boolean }} `exact` is 1/N from minShutterDenominator;
 *   `standard` the next stop up in SHUTTER_DENOMINATORS (null when `exact` is
 *   faster than the fastest stop); `beyondCamera` when `exact` is faster than
 *   the camera's own 1/8000 s.
 */
export function shutterAdvice(preset, gsdCm, speedMs) {
  if (!preset || !(Number(gsdCm) > 0) || !(Number(speedMs) > 0)) return null;
  const exact = minShutterDenominator(preset, Number(gsdCm), Number(speedMs));
  const standard = SHUTTER_DENOMINATORS.find((d) => d >= exact) ?? null;
  return {
    exact,
    standard,
    beyondTable: standard == null,
    beyondCamera: exact > CAMERA_FASTEST_SHUTTER_DENOMINATOR,
  };
}
