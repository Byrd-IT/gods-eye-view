import { collectorBridgePlugin } from './collectorBridge.js';
import { enabledBridgeFeeds } from './feeds.js';
import { historyApiEnabled, historyApiPlugin } from './historyApi.js';

/**
 * Byrd-IT history plugins (gev-history DESIGN 4.1). Spread FIRST into the
 * plugin list of server/standalone/vite.config.js so the collector bridge
 * sees bridged /api/<feed> routes before the upstream provider plugins.
 * B9: the read-only /api/history/* routes (historyApi.js) when
 * GEV_HISTORY_API=1; options.historyApi carries the server-side injections
 * (rate limiter, client key, Host rule) from server/byrdit/history.js.
 *
 * With every GEV_BRIDGE_<FEED> flag off and GEV_HISTORY_API unset this
 * returns NO plugin, so the plugin list (and upstream's provider-order pin
 * in src/tooling/viteBuild.test.mjs) is exactly what it was without the fork
 * module.
 *
 * @param {Parameters<typeof collectorBridgePlugin>[0] & {
 *   historyApi?: Parameters<typeof historyApiPlugin>[0] }} [options]
 * @returns {import('vite').Plugin[]}
 */
export function historyPlugins(options = {}) {
  const env = options.env ?? globalThis.process?.env ?? {};
  const { historyApi, ...bridgeOptions } = options;
  const plugins = [];
  if (enabledBridgeFeeds(env).length)
    plugins.push(collectorBridgePlugin({ ...bridgeOptions, env }));
  if (historyApiEnabled(env))
    plugins.push(historyApiPlugin({ ...historyApi, env }));
  return plugins;
}

export {
  collectorBridgePlugin,
  createCollectorBridge,
  bridgeConfigFromEnv,
  parseCollectorUrls,
} from './collectorBridge.js';
export {
  BRIDGE_FEEDS,
  enabledBridgeFeeds,
  flightViewLease,
  parseFlightView,
} from './feeds.js';
export {
  appendFlightView,
  cameraViewBox,
  createFlightViewTracker,
  flightViewQuery,
  normalizeViewBox,
} from './flightView.js';
export {
  createHistoryApi,
  historyApiEnabled,
  historyApiPlugin,
} from './historyApi.js';
export {
  feedDisplayState,
  staleThresholdMs,
  parseGreyMs,
  DEFAULT_STALE_GREY_MS,
} from './staleness.js';
