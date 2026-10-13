import { collectorBridgePlugin } from './collectorBridge.js';
import { enabledBridgeFeeds } from './feeds.js';

/**
 * Byrd-IT history plugins (gev-history DESIGN 4.1). Spread FIRST into the
 * plugin list of server/standalone/vite.config.js so the collector bridge
 * sees bridged /api/<feed> routes before the upstream provider plugins.
 * B9/B10 add the read-only /api/history/* routes here.
 *
 * With every GEV_BRIDGE_<FEED> flag off this returns NO plugin, so the plugin
 * list (and upstream's provider-order pin in src/tooling/viteBuild.test.mjs)
 * is exactly what it was without the fork module.
 *
 * @param {Parameters<typeof collectorBridgePlugin>[0]} [options]
 * @returns {import('vite').Plugin[]}
 */
export function historyPlugins(options = {}) {
  const env = options.env ?? globalThis.process?.env ?? {};
  if (!enabledBridgeFeeds(env).length) return [];
  return [collectorBridgePlugin({ ...options, env })];
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
  feedDisplayState,
  staleThresholdMs,
  parseGreyMs,
  DEFAULT_STALE_GREY_MS,
} from './staleness.js';
