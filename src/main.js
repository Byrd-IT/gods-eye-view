import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { fetchIonCredential } from './byrdit/serverKeys.js';

// No third-party key is injected into this bundle. Cesium ion, Mapillary and
// Google credentials stay on the server (server/byrdit/keyIsolation); the
// browser only learns whether the server holds an ion token. No top-level
// await: the production build targets es2020, which rejects it.
const application = fetchIonCredential().then((cesiumToken) => {
  const app = createStandaloneApplication({
    cesiumToken,
    allowQaRegistration: import.meta.env.DEV,
  });
  app.start().catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  });
  return app;
});

export { application };
