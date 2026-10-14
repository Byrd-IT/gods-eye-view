import { createDefaultMapSources } from '../../maps/defaultSources.js';
import { createKeylessTerrain } from '../../maps/terrain.js';
import { loadPhotorealisticTileset } from '../../maps/google3d.js';
import { basemapFlagOn, loadBasemapConfig } from './config.js';
import {
  createBasemapMapSource,
  BASEMAP_FALLBACK_ID,
  BYRDIT_OPEN_STACK_ID,
} from './stack.js';
import { createGoogleSession } from './googleSession.js';
import { attachBasemapSwitching, createSwitchMachine } from './autoSwitch.js';
import { attachBuildings } from './buildings.js';
import { createBasemapHealthMonitor, loadBasemapHealth } from './health.js';

/**
 * Entry point used by src/app/scene.js (BASEMAP.md 4.3).
 *
 *   flag OFF (no <meta name="gev-basemap" content="1">): returns null and makes
 *     no request; scene.js runs its existing path unchanged (Google created
 *     eagerly, Esri when it fails).
 *   flag ON, /basemap up: `{lazy: true}`. Startup stack is byrdit-open. Google
 *     is created only by the switch (close-up, or the user pins it). Chain:
 *     Google -> byrdit-open -> Esri.
 *   flag ON, /basemap down: `{lazy: true}` as well, with Esri as the base (the
 *     last resort of 4.3 item 6) and a greyed-out "Byrd-IT Open" chip with the
 *     reason. Google stays lazy and auto-switched: 0 roots at global view,
 *     1 for a close-up, the same retry limits. Chain: Google -> Esri.
 *
 *   The buildings layer (buildings.js, P6) is attached only when the stack
 *   is available and the config offers buildings; it lives inside the open
 *   stack and follows the switch (never shown with Google, destroyed on any
 *   stack switch away from Byrd-IT Open).
 *
 *   Health (health.js, P9 follow-up): only when the stack is available,
 *   /basemap/health.json is polled in the background (never awaited). When
 *   the edge reports degraded (or down) the Byrd-IT Open chip reads
 *   "(degraded)" with the first warning as its tooltip; a failed health
 *   fetch changes nothing. Availability still comes only from config.json.
 */

/** Tell the user each distinct status message at most once a minute. */
export function createNotifier(sink, intervalMs = 60_000, now = Date.now) {
  const last = new Map();
  return (message, also = null) => {
    const t = now();
    if (t - (last.get(message) ?? -Infinity) < intervalMs) return false;
    last.set(message, t);
    try {
      sink(message);
      also?.();
    } catch {
      /* status reporting never breaks switching */
    }
    return true;
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
  createHealthMonitor = createBasemapHealthMonitor,
}) {
  if (!basemapFlagOn(doc)) return null;
  if (loaderStatus)
    loaderStatus.textContent = 'Loading the Byrd-IT Open map...';
  const config = await loadBasemapConfig({ fetchImpl, signal });
  signal?.throwIfAborted?.();
  // Background only: the first poll starts here and is never awaited.
  const health = config.available
    ? createHealthMonitor({ load: () => loadBasemapHealth({ fetchImpl }) })
    : null;
  health?.start();
  const basemapSource = createBasemapMapSource({
    Cesium,
    config,
    fallbackTerrain: createKeylessTerrain,
    health,
  });
  // Base map: the open stack, or Esri while /basemap is down.
  const baseId = config.available ? BYRDIT_OPEN_STACK_ID : BASEMAP_FALLBACK_ID;
  if (!config.available) console.warn('[Basemap]', config.unavailableReason);

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
    baseId,
  );
  const tell = createNotifier(notify);
  return {
    lazy: true,
    config,
    session,
    health,
    initialStack: baseId,
    controllerOptions: { registry, initialStack: baseId },
    attach(controller) {
      // A changed degraded reason re-announces the controller state so the
      // chip row (mapSourceControls) re-reads getStacks().
      if (health)
        health.onChange = () => {
          try {
            controller._emitChange?.();
          } catch {
            /* the chip simply keeps its previous text */
          }
        };
      const machine = createSwitchMachine(config.switch);
      const detachSwitch = attachBasemapSwitching({
        controller,
        viewer,
        session,
        machine,
        notify: (message) =>
          tell(message, () => controller._onError?.(message)),
      });
      const buildings =
        config.available && config.buildings?.available
          ? attachBuildings({
              Cesium,
              viewer,
              controller,
              session,
              config: config.buildings,
            })
          : null;
      const detach = () => {
        if (health) health.onChange = null;
        buildings?.();
        detachSwitch();
      };
      detach.evaluate = detachSwitch.evaluate;
      detach.buildings = buildings;
      return detach;
    },
    destroy() {
      health?.stop();
      if (!scene.isDestroyed?.()) session.destroy();
    },
  };
}

/**
 * Replace the eager Google entry of a default registry with a lazy one whose
 * tileset is whatever the session holds (null until the first root request).
 * The controller reads `source.tileset` on every activation and visibility
 * change, so the getter is all it needs. The base stack (the open stack, or
 * Esri while /basemap is down) becomes the default and the recovery stack.
 */
export function createLazyGoogleRegistry(
  registry,
  session,
  baseId = BYRDIT_OPEN_STACK_ID,
) {
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
    defaultId: baseId,
    recoveryId: baseId,
    sources,
  };
}
