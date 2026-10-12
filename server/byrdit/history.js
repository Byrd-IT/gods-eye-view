import { weatherProxy } from '../providers/weather.js';
import { historyPlugins as browserSafeHistoryPlugins } from '../../src/byrdit/history/index.js';

/**
 * Server-side composition of the Byrd-IT history plugins (gev-history
 * DESIGN 4.1, B15 review t_c057aa83 R4). src/ is the browser graph and may
 * not import server/ (scripts/check-import-directions.mjs), so the server
 * injects GEV's own weatherProxy here: with GEV_BRIDGE_WEATHER=1 the bridge
 * answers /api/weather/tile|image with a private weatherProxy instance whose
 * GetCapabilities reads come from the collector (single consumer of the
 * recorded metadata); only GetMap image bytes are live.
 *
 * server/standalone/vite.config.js imports historyPlugins from HERE (its one
 * touch-point import line); everything else is in src/byrdit/history.
 *
 * @param {Parameters<typeof browserSafeHistoryPlugins>[0]} [options]
 */
export function historyPlugins(options = {}) {
  return browserSafeHistoryPlugins({ weatherProxy, ...options });
}
