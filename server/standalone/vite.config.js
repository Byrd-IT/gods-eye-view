import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { googleTokenUnavailablePlugin } from './google-token-unavailable.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { historyPlugins } from '../byrdit/history.js';
import { basemapPlugins } from '../byrdit/basemap.js';
import { waybackPlugins } from '../byrdit/wayback/index.js';
import { featureFlagsHtmlPlugins } from '../byrdit/featureFlags.js';
import { planLibraryPlugins } from '../byrdit/planLibrary/api.js';
import { surfacePlugins } from '../byrdit/surfaces/api.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export function standaloneConfig(
  { command, mode },
  { nominatimStorageDir } = {},
) {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const tools = standaloneVoiceTools();
  return createBrowserViteConfig({
    plugins: [
      ...planLibraryPlugins(),
      ...surfacePlugins(),
      ...historyPlugins(),
      ...basemapPlugins(),
      ...waybackPlugins(),
      // Shared runtime config for the GEV_BASEMAP / GEV_BYRDIT_WAYBACK html
      // flag metas: under preview the served page follows the preview env
      // (dev serves the per-feature tags, building stays as it is).
      ...featureFlagsHtmlPlugins(),
      ...localProviderPlugins({
        realtime: { tools },
        gemini: { tools },
        nominatimStorageDir,
      }),
      localMcpPlugin(),
      googleTokenUnavailablePlugin(),
      apiNotFoundPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    photonUrl: process.env.PHOTON_URL,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
}

export default defineConfig(standaloneConfig);
