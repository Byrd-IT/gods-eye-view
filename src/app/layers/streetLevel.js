import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../../layers/streetLevel/providers/mapillary/index.js';
import { createGoogleProvider } from '../../layers/streetLevel/providers/google/index.js';
import { createKartaViewProvider } from '../../layers/streetLevel/providers/kartaview/index.js';
import { createPanoramaxProvider } from '../../layers/streetLevel/providers/panoramax/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as scenePick from '../../data/scenePick.js';
import * as render from '../../renderGovernor.js';

/**
 * The browser Maps key for Google Street View. Byrd-IT fork: none. The fork
 * never puts the Google key on a window global (src/byrdit/serverKeys.js keeps
 * it in a closure for Google 3D Tiles only), and Street View on our key needs
 * an owner decision (Maps JavaScript API on the key, billing, CSP). With no
 * key the provider reports "key required" and the keyless providers
 * (Mapillary via the server, KartaView, Panoramax) work as before.
 */
const googleApiKey = () => null;

/**
 * Mapillary, Google Street View, KartaView and Panoramax, once the Mapillary
 * source is supplied; else none.
 */
function defaultProviders(sources) {
  if (sources.mapillary == null) return [];
  return [
    createMapillaryProvider({ source: sources.mapillary }),
    createGoogleProvider({ getApiKey: googleApiKey }),
    createKartaViewProvider(),
    createPanoramaxProvider(),
  ];
}

/**
 * Inject providers, or use the defaults. An explicit provider list replaces
 * them; an unused sources.mapillary is neither constructed nor validated,
 * including when the list is empty.
 */
export function createApplicationStreetLevel({
  surface,
  sources = {},
  providers = defaultProviders(sources),
}) {
  return createStreetLevelLayer({
    providers,
    services: {
      sprites,
      picking,
      input,
      scenePick,
      render,
      ground: surface?.groundFloor ?? null,
      meshFloor: surface?.meshFloor ?? null,
      terrain: surface?.terrain ?? null,
    },
  });
}
