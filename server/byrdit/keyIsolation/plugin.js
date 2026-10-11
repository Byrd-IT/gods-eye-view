import { gatedIonRoute } from './ionEndpoint.js';
import { gatedMapillaryGraphRoute } from './mapillaryGraph.js';
import { gatedGoogleKeyRoute, GOOGLE_KEY_PATH } from './googleKey.js';

/** Attach the server-side key routes (ion endpoint, Mapillary Graph, obfuscated Google key). */
export function installKeyIsolationRoutes(middlewares) {
  middlewares.use('/api/ion', gatedIonRoute());
  middlewares.use('/api/mapillary/graph', gatedMapillaryGraphRoute());
  middlewares.use(GOOGLE_KEY_PATH, gatedGoogleKeyRoute());
}

/**
 * Vite plugin: lets the browser use Cesium ion and the Mapillary Graph API
 * without holding CESIUM_ION_TOKEN or MAPILLARY_CLIENT_TOKEN, and hands it the
 * Google Maps key at runtime in obfuscated form (never in served files).
 */
export function keyIsolationProxy() {
  return {
    name: 'byrdit-key-isolation',
    configureServer(server) {
      installKeyIsolationRoutes(server.middlewares);
    },
    configurePreviewServer(server) {
      installKeyIsolationRoutes(server.middlewares);
    },
  };
}
