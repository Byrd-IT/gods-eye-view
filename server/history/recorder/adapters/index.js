import aircraft from './aircraft.js';
import cyclones from './cyclones.js';
import firms from './firms.js';
import launches from './launches.js';
import military from './military.js';
import perimeters from './perimeters.js';

/** Recorder adapters by feed. A feed with no adapter here cannot be recorded. */
export const ADAPTERS = Object.freeze({
  aircraft,
  cyclones,
  firms,
  launches,
  military,
  perimeters,
});
