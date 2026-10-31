import aircraft from './aircraft.js';
import bikeshare from './bikeshare.js';
import firms from './firms.js';
import military from './military.js';
import transit from './transit.js';

/** Recorder adapters by feed. A feed with no adapter here cannot be recorded. */
export const ADAPTERS = Object.freeze({
  aircraft,
  bikeshare,
  firms,
  military,
  transit,
});
