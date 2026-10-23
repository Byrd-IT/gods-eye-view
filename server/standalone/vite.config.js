import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { historyPlugins } from '../byrdit/history.js';
import { basemapPlugins } from '../byrdit/basemap.js';
import { waybackPlugins } from '../byrdit/wayback/index.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const tools = standaloneVoiceTools();
  return createBrowserViteConfig({
    plugins: [
      ...historyPlugins(),
      ...basemapPlugins(),
      ...waybackPlugins(),
      ...localProviderPlugins({ realtime: { tools }, gemini: { tools } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
});
