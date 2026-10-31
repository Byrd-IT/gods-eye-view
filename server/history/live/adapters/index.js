import { createFirmsAdapter } from './firms.js';
import { createLaunchesAdapter } from './launches.js';
import { createQuakesAdapter } from './quakes.js';
import { createWaterAdapter } from './water.js';

/**
 * One adapter per feed in LIVE_API_SUPPORT (a test checks the two lists match).
 * Secrets are read from `env` when a question is asked, never at boot, and are
 * not kept anywhere.
 */
export function buildLiveApiAdapters(env = process.env) {
  return {
    quakes: createQuakesAdapter(),
    firms: createFirmsAdapter({ getMapKey: () => env.FIRMS_MAP_KEY }),
    water: createWaterAdapter(),
    launches: createLaunchesAdapter(),
  };
}
