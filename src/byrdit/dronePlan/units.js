/**
 * Display units for the Drone Flight Plan panel and its 3D check: feet by
 * default, metres on request, remembered per browser.
 *
 * Everything inside the planner, the plan documents and the DJI KMZ/WPML
 * stays in METRES (and m/s): DJI requires it. Only what the person reads or
 * types goes through this module. Nothing here is ever written to a file the
 * aircraft reads.
 */
import { FT_PER_M } from './planner.js';
import { MPH_PER_MS } from './timing.js';

export { FT_PER_M, MPH_PER_MS };
export const UNITS_STORAGE_KEY = 'gev.dronePlan.units';
export const UNIT_SYSTEMS = Object.freeze(['ft', 'm']);
export const DEFAULT_UNIT_SYSTEM = 'ft';

let current = DEFAULT_UNIT_SYSTEM;

/** `ft` or `m`; anything else is the default. */
export const normalizeUnitSystem = (value) =>
  value === 'm' || value === 'ft' ? value : DEFAULT_UNIT_SYSTEM;

export const getUnitSystem = () => current;

export function setUnitSystem(system) {
  current = normalizeUnitSystem(system);
  return current;
}

const isFeet = (system) => normalizeUnitSystem(system) === 'ft';

/** `ft` or `m`. */
export const lengthUnit = (system = current) => (isFeet(system) ? 'ft' : 'm');
/**
 * The speed label: `mph` in the feet system (the pilot's road-speed unit) or
 * `m/s` in metric. Internal speeds are always m/s; this is display only.
 */
export const speedUnit = (system = current) => (isFeet(system) ? 'mph' : 'm/s');

/** Metres to the display unit (a number, not rounded). */
export const lengthFromM = (metres, system = current) =>
  isFeet(system) ? metres * FT_PER_M : metres;
/** The display unit to metres, to the centimetre (a typed number, rounded). */
export const lengthToM = (value, system = current) =>
  isFeet(system)
    ? Math.round((Number(value) / FT_PER_M) * 100) / 100
    : Number(value);
/** m/s to mph (1 m/s = 3.6000/1.609344 mph); pure, no display system. */
export const speedMphFromMs = (ms) => Number(ms) * MPH_PER_MS;
/** mph to m/s, to the mm/s; pure, no display system. */
export const speedMphToMs = (value) =>
  Math.round((Number(value) / MPH_PER_MS) * 1000) / 1000;
/**
 * m/s to the display speed: mph in the feet system, m/s in metric. The metre
 * branch returns the value unchanged so metric display and internal m/s stay
 * the same number, as they always have.
 */
export const speedFromMs = (ms, system = current) =>
  isFeet(system) ? speedMphFromMs(ms) : ms;
/** The display speed to internal m/s, to the mm/s. */
export const speedToMs = (value, system = current) =>
  isFeet(system) ? speedMphToMs(value) : Number(value);

/**
 * A slider range in the display unit. The metre range is kept; in feet the
 * ends are pulled inside it onto the foot step, so a value on the slider can
 * always be turned back into a legal number of metres.
 * @param {{ minM:number, maxM:number, stepM:number, stepFt:number,
 *   kind?: 'length' | 'speed' }} spec
 */
export function sliderRange(spec, system = current) {
  if (!isFeet(system)) {
    return { min: spec.minM, max: spec.maxM, step: spec.stepM };
  }
  const to = spec.kind === 'speed' ? speedFromMs : lengthFromM;
  const step = spec.stepFt;
  return {
    min: Math.ceil(to(spec.minM, 'ft') / step - 1e-9) * step,
    max: Math.floor(to(spec.maxM, 'ft') / step + 1e-9) * step,
    step,
  };
}

/**
 * Read the remembered system. A browser without storage, or with storage
 * that throws (private mode, blocked cookies), gets the default.
 */
export function readUnitSystem(storage) {
  try {
    return normalizeUnitSystem(storage?.getItem?.(UNITS_STORAGE_KEY));
  } catch {
    return DEFAULT_UNIT_SYSTEM;
  }
}

/** Remember the system; a failing store is ignored. */
export function writeUnitSystem(storage, system) {
  try {
    storage?.setItem?.(UNITS_STORAGE_KEY, normalizeUnitSystem(system));
    return true;
  } catch {
    return false;
  }
}

/** The browser's local storage, or null when there is none to use. */
export function browserStorage(win = globalThis) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}
