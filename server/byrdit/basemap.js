import { readFile } from 'node:fs/promises';
import { basemapPlugins as browserSafeBasemapPlugins } from '../../src/byrdit/basemap/proxy.js';

/**
 * Server-side entry for the Byrd-IT Open base map proxy (BASEMAP.md 4.2).
 * server/standalone/vite.config.js imports basemapPlugins from HERE (one
 * import line + one plugin line, right after historyPlugins). src/ is the
 * browser graph and may not import node builtins, so the file reader for a
 * local GEV_BASEMAP_IMAGERY_CONFIG path is injected here.
 *
 * @param {Parameters<typeof browserSafeBasemapPlugins>[0]} [options]
 */
export function basemapPlugins(options = {}) {
  return browserSafeBasemapPlugins({ readFileImpl: readFile, ...options });
}
