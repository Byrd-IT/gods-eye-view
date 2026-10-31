import aircraft from './aircraft.js';
import firms from './firms.js';
import military from './military.js';
import satellites from './satellites.js';

/** Recorder adapters by feed. A feed with no adapter here cannot be recorded. */
export const ADAPTERS = Object.freeze({
  aircraft,
  firms,
  military,
  satellites,
});
