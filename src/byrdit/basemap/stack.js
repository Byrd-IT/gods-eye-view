import { basemapCreditHtml } from './credits.js';
import { createBasemapImageryProvider } from './imagery.js';
import { createBasemapTerrain } from './terrain.js';

/**
 * The "Byrd-IT Open" map stack (BASEMAP.md 4.2) and the "Auto" override
 * chip of the rev2 switch (4.3). Both ids are listed in
 * PRESENTED_MAP_STACK_IDS. They only reach the chip row when the flag is on,
 * because only then is either one in the registry.
 */
export const BYRDIT_OPEN_STACK_ID = 'byrdit-open';
export const BASEMAP_AUTO_STACK_ID = 'basemap-auto';

export const BYRDIT_OPEN_STACK = Object.freeze({
  id: BYRDIT_OPEN_STACK_ID,
  label: 'Byrd-IT Open',
  shortLabel: 'OPEN',
  kind: 'byrdit-open',
  requiresIon: false,
});

export const BASEMAP_AUTO_STACK = Object.freeze({
  id: BASEMAP_AUTO_STACK_ID,
  label: 'Auto',
  shortLabel: 'AUTO',
  kind: 'basemap-auto',
  requiresIon: false,
});

/** Last resort when /basemap is down (never Cesium-ion Google). */
export const BASEMAP_FALLBACK_ID = 'esri-imagery';
export const BASEMAP_TILE_FAILURE_THRESHOLD = 3;

/**
 * Map source for the controller registry (same contract as the entries in
 * src/maps/defaultSources.js).
 * @param {{Cesium: object, config: ReturnType<import('./config.js').normalizeBasemapConfig>, fallbackTerrain: () => Promise<{provider: object}>}} options
 */
export function createBasemapMapSource({ Cesium, config, fallbackTerrain }) {
  if (!config?.available)
    return createUnavailableBasemapSource(config?.unavailableReason);
  return {
    descriptor: BYRDIT_OPEN_STACK,
    available: true,
    unavailableReason: null,
    imagery: () => createBasemapImageryProvider(Cesium, config.imagery),
    terrain: {
      id: BYRDIT_OPEN_STACK_ID,
      create: ({ signal } = {}) =>
        createBasemapTerrain(Cesium, config.terrain, {
          fallback: fallbackTerrain,
          signal,
        }),
    },
    credit: basemapCreditHtml(config),
    constructionFallback: {
      id: BASEMAP_FALLBACK_ID,
      message: 'Byrd-IT Open is unavailable; using Esri Satellite',
    },
    tileFailureFallback: {
      id: BASEMAP_FALLBACK_ID,
      threshold: BASEMAP_TILE_FAILURE_THRESHOLD,
      message: 'Byrd-IT Open tile requests failed; using Esri Satellite',
    },
  };
}

/** Listed but greyed out, with the reason in its tooltip (service down). */
export function createUnavailableBasemapSource(reason) {
  const message = reason || 'Byrd-IT Open map service is unavailable';
  return {
    descriptor: BYRDIT_OPEN_STACK,
    available: false,
    unavailableReason: message,
    imagery: () => {
      throw new Error(message);
    },
  };
}
