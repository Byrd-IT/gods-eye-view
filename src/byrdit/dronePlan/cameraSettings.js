/**
 * Camera settings to set in DJI Fly before a mission, as guidance.
 *
 * The WPML mission file has no field for photo size, white balance, EV or
 * shutter, so GEV cannot send them to the aircraft. They are shown in the
 * panel and written into the README of every export, and a plan remembers
 * which preset it was made for (`cameraPresetId` in the plan's settings).
 *
 * Pure: no DOM. The panel words the same rows through t().
 */
import { SHUTTER_DENOMINATORS } from './speed.js';

export const DEFAULT_CAMERA_PRESET_ID = 'mapping-50mp';

/**
 * width x height is the 4:3 still the camera writes at that size; the
 * shutter is a slowest allowed (1/500 s or faster).
 */
export const CAMERA_PRESETS = Object.freeze([
  Object.freeze({
    id: 'mapping-50mp',
    name: '50 MP, 4:3 (mapping)',
    megapixels: 50,
    ratio: '4:3',
    width: 8192,
    height: 6144,
    minShutterDenominator: 500,
    ev: -0.7,
  }),
  Object.freeze({
    id: 'test-12mp',
    name: '12 MP, 4:3 (test)',
    megapixels: 12,
    ratio: '4:3',
    width: 4096,
    height: 3072,
    minShutterDenominator: 500,
    ev: -0.7,
  }),
]);

export const listCameraPresets = () => CAMERA_PRESETS;

export function getCameraPreset(id) {
  return CAMERA_PRESETS.find((p) => p.id === id) ?? null;
}

export const isCameraPresetId = (id) => Boolean(getCameraPreset(id));

/** The preset for an id, or the default one when the id is unknown. */
export function cameraPresetOrDefault(id) {
  return getCameraPreset(id) ?? getCameraPreset(DEFAULT_CAMERA_PRESET_ID);
}

/**
 * The shutter denominator to show and use for a preset: the plan's own when it
 * is already fast enough, else the slowest the preset allows.
 */
export function shutterForPreset(preset, shutterDenominator) {
  const n = Number(shutterDenominator);
  return Number.isFinite(n) && n >= preset.minShutterDenominator
    ? n
    : preset.minShutterDenominator;
}

/** The nearest allowed shutter value at or above `n` (for the select list). */
export function allowedShutter(n) {
  return SHUTTER_DENOMINATORS.find((d) => d >= n) ?? SHUTTER_DENOMINATORS.at(-1);
}

/** EV as DJI Fly shows it: -0.7, +0.3, 0. */
export const evText = (ev) =>
  ev === 0 ? '0' : `${ev > 0 ? '+' : '-'}${Math.abs(ev).toFixed(1)}`;

/** The checklist as English lines (README text). */
export function cameraChecklistLines(presetId, shutterDenominator) {
  const p = cameraPresetOrDefault(presetId);
  const shutter = shutterForPreset(p, shutterDenominator);
  return [
    'Camera settings (set in DJI Fly before launch; the mission file cannot carry them):',
    `  - Photo size: ${p.megapixels} MP, ${p.ratio} (${p.width} x ${p.height})`,
    `  - Shutter: 1/${shutter} s or faster`,
    '  - White balance: fixed (not auto)',
    `  - Exposure compensation (EV): ${evText(p.ev)}`,
    `  - Before launch: take a test photo and check it is ${p.width} x ${p.height}.`,
    `  Preset: ${p.name}`,
  ];
}
