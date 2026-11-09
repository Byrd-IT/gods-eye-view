import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { fetchGoogleKey, fetchIonCredential } from './byrdit/serverKeys.js';
import { t } from './i18n/index.js';
import { installEsLiveFetch } from './byrdit/esLive/clientRedirect.js';

// GEV_ES_LIVE_*: send the USGS quake and ECCC air-quality requests to this
// server (our Elasticsearch copy). First, so the history router wraps it.
installEsLiveFetch();

// No third-party key is injected into this bundle. Cesium ion and Mapillary
// credentials stay on the server (server/byrdit/keyIsolation); the browser only
// learns whether the server holds an ion token. The Google Maps key is fetched
// at runtime from a same-origin endpoint in obfuscated form and decoded in
// memory (Google 3D Tiles are requested by the browser itself). No top-level
// await: the production build targets es2020, which rejects it.
// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;

const application = Promise.all([fetchIonCredential(), fetchGoogleKey()]).then(
  ([cesiumToken, googleApiKey]) => {
    const app = createStandaloneApplication({
      googleApiKey,
      cesiumToken,
      geospatial:
        photonSetting === undefined
          ? {}
          : { endpoints: { photon: photonSetting } },
      allowQaRegistration: import.meta.env.DEV,
    });
    app.start().catch((error) => {
      console.error("God's Eye View initialization failed:", error);
      const loaderStatus = document.querySelector(
        '#loading-screen .loader-status',
      );
      loaderStatus.textContent = t('Error: {message}', {
        message: describeError(error),
      });
      loaderStatus.style.color = '#ff4444';
    });
    return app;
  },
);

export { application };
