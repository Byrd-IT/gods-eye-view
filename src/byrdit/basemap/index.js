import { createDefaultMapSources } from '../../maps/defaultSources.js';
import { createKeylessTerrain } from '../../maps/terrain.js';
import { loadPhotorealisticTileset } from '../../maps/google3d.js';
import { basemapFlagOn, loadBasemapConfig } from './config.js';
import { createBasemapMapSource, BYRDIT_OPEN_STACK_ID } from './stack.js';
import { createGoogleSession } from './googleSession.js';
import { attachBasemapSwitching, createSwitchMachine } from './autoSwitch.js';

/**
 * Entry point used by src/app/scene.js (BASEMAP.md 4.3).
 *
 *   flag OFF (no <meta name="gev-basemap" content="1">): returns null and makes
 *     no request; scene.js runs its existing path unchanged (Google created
 *     eagerly, Esri when it fails).
 *   flag ON, /basemap down: `{lazy: false}`. The existing path runs, plus a
 *     greyed-out "Byrd-IT Open" chip with the reason. Chain: Google -> Esri.
 *   flag ON, /basemap up: `{lazy: true}`. Startup stack is byrdit-open. Google
 *     is created only by the switch (close-up, or the user pins it). Chain:
 *     Google -> byrdit-open -> Esri.
 */

/** Tell the user each distinct status message at most once a minute. */
function createNotifier(sink, intervalMs = 60_000) {
  const last = new Map();
  return (message) => {
    const t = Date.now();
    if (t - (last.get(message) ?? -Infinity) < intervalMs) return;
    last.set(message, t);
    try {
      sink(message);
    } catch {
      /* status reporting never breaks switching */
    }
  };
}

export async function openBasemap({
  Cesium,
  viewer,
  googleApiKey = '',
  googleTokens = null,
  cesiumToken = '',
  loaderStatus = null,
  signal,
  doc = globalThis.document,
  fetchImpl = globalThis.fetch,
  notify = (message) => console.info('[Basemap]', message),
}) {
  if (!basemapFlagOn(doc)) return null;
  if (loaderStatus)
    loaderStatus.textContent = 'Loading the Byrd-IT Open map...';
  const config = await loadBasemapConfig({ fetchImpl, signal });
  signal?.throwIfAborted?.();
  const basemapSource = createBasemapMapSource({
    Cesium,
    config,
    fallbackTerrain: createKeylessTerrain,
  });
  if (!config.available) {
    console.warn('[Basemap]', config.unavailableReason);
    return {
      lazy: false,
      config,
      controllerOptions: { basemapSource },
      initialStack: null,
      attach: () => () => {},
      destroy() {},
    };
  }

  const scene = viewer.scene;
  const session = createGoogleSession({
    hasCredentials: Boolean(String(googleApiKey || '').trim() || googleTokens),
    load: () =>
      loadPhotorealisticTileset(Cesium, { googleApiKey, googleTokens }),
    attach: (tileset) => {
      tileset.show = false;
      scene.primitives.add(tileset);
    },
    detach: (tileset) => {
      if (tileset.isDestroyed?.()) return;
      if (!scene.primitives.remove(tileset)) tileset.destroy?.();
    },
    reRootAgeMs: config.switch.reRootAgeMs,
    rootAttemptsPerHour: config.switch.rootAttemptsPerHour,
  });
  const registry = createLazyGoogleRegistry(
    createDefaultMapSources({
      googleTileset: null,
      cesiumToken,
      googleApiKey,
      basemapSource,
    }),
    session,
  );
  const tell = createNotifier(notify);
  return {
    lazy: true,
    config,
    session,
    initialStack: BYRDIT_OPEN_STACK_ID,
    controllerOptions: { registry, initialStack: BYRDIT_OPEN_STACK_ID },
    attach(controller) {
      const machine = createSwitchMachine(config.switch);
      return attachBasemapSwitching({
        controller,
        viewer,
        session,
        machine,
        notify: (message) => {
          tell(message);
          controller._onError?.(message);
        },
      });
    },
    destroy() {
      if (!scene.isDestroyed?.()) session.destroy();
    },
  };
}

/**
 * Replace the eager Google entry of a default registry with a lazy one whose
 * tileset is whatever the session holds (null until the first root request).
 * The controller reads `source.tileset` on every activation and visibility
 * change, so the getter is all it needs. The open stack becomes the default
 * and the recovery stack.
 */
export function createLazyGoogleRegistry(registry, session) {
  const sources = registry.sources.map((source) => {
    if (source.descriptor.id !== 'photoreal') return source;
    const lazy = { ...source };
    delete lazy.tileset;
    delete lazy.available;
    lazy.createTileset = () => session.ensure();
    return Object.defineProperties(lazy, {
      tileset: { get: () => session.tileset, enumerable: true },
      available: { get: () => session.hasCredentials, enumerable: true },
    });
  });
  return {
    ...registry,
    defaultId: BYRDIT_OPEN_STACK_ID,
    recoveryId: BYRDIT_OPEN_STACK_ID,
    sources,
  };
}
