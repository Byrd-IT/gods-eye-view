/**
 * What the Drone Flight Plan panel remembers per browser besides the unit
 * system (units.js): which of its numbered steps are open, and how see-through
 * each 3D check layer is. Plain JSON in localStorage; a missing, broken or
 * blocked store gives the defaults, and a failing write is ignored.
 */
import { ALPHA_RANGE, DEFAULT_ALPHA, clampAlpha } from './checkLayer.js';

export const STEPS_STORAGE_KEY = 'gev.dronePlan.steps';
export const ALPHA_STORAGE_KEY = 'gev.dronePlan.alpha';

/** The steps, in order: key, English title. */
export const STEP_KEYS = Object.freeze([
  'area',
  'aircraft',
  'shots',
  'orbits',
  'obstacles',
  'flight',
  'plan',
  'check',
  'export',
]);
/** Open the first time: the steps a first plan needs. */
export const DEFAULT_STEPS_OPEN = Object.freeze({
  area: true,
  aircraft: false,
  shots: true,
  orbits: false,
  obstacles: false,
  flight: false,
  plan: true,
  check: false,
  export: true,
});

function readJson(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Which steps are open: remembered values over the defaults. */
export function readStepsOpen(storage) {
  const saved = readJson(storage, STEPS_STORAGE_KEY) ?? {};
  const open = {};
  for (const key of STEP_KEYS) {
    open[key] =
      typeof saved[key] === 'boolean' ? saved[key] : DEFAULT_STEPS_OPEN[key];
  }
  return open;
}

export function writeStepsOpen(storage, open) {
  const out = {};
  for (const key of STEP_KEYS) out[key] = Boolean(open?.[key]);
  return writeJson(storage, STEPS_STORAGE_KEY, out);
}

/** The level of each layer: remembered values (clamped) over today's look. */
export function readAlpha(storage) {
  const saved = readJson(storage, ALPHA_STORAGE_KEY) ?? {};
  const alpha = { ...DEFAULT_ALPHA };
  for (const layer of Object.keys(ALPHA_RANGE)) {
    if (saved[layer] !== undefined && saved[layer] !== null) {
      alpha[layer] = clampAlpha(layer, saved[layer]);
    }
  }
  return alpha;
}

export function writeAlpha(storage, alpha) {
  const out = {};
  for (const layer of Object.keys(ALPHA_RANGE)) {
    out[layer] = clampAlpha(layer, alpha?.[layer]);
  }
  return writeJson(storage, ALPHA_STORAGE_KEY, out);
}
