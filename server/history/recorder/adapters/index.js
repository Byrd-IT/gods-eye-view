import aircraft from './aircraft.js';
import bikeshare from './bikeshare.js';
import cyclones from './cyclones.js';
import firms from './firms.js';
import launches from './launches.js';
import military from './military.js';
import perimeters from './perimeters.js';
import quakes from './quakes.js';
import satellites from './satellites.js';
import transit from './transit.js';
import vessels from './vessels.js';

/** Recorder adapters by feed. A feed with no adapter here cannot be recorded. */
export const ADAPTERS = Object.freeze({
  aircraft,
  bikeshare,
  cyclones,
  firms,
  launches,
  military,
  perimeters,
  quakes,
  satellites,
  transit,
  vessels,
});
