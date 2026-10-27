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
import { attachNaip } from './naip.js';
import {
  createImageryVoice,
  ensureByrditOpen,
  flyToImageryBounds,
} from './imageryVoice.js';
import { createNaipMenuSlider, createNaipSplit } from './naipSlider.js';
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
 *   NAIP year slider (naip.js, N6): only when the server's config carries
 *   an available `naip` block (GEV_BASEMAP_NAIP=1). Its layers live inside
 *   the open stack like buildings and are destroyed on any switch away.
 *
 *   Health (health.js, P9 follow-up): only when the stack is available,
 *   /basemap/health.json is polled in the background (never awaited). When
 *   the edge reports degraded (or down) the Byrd-IT Open chip reads
 *   "(degraded)" with the first warning as its tooltip. A failed health
 *   fetch counts as unknown (no badge): it never blocks or greys out the
 *   chip, and after a degraded poll it clears the badge rather than keeping
 *   a stale warning. Availability still comes only from config.json.
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
      // N6: NAIP year slider (only when the server offers a naip block).
      const naip =
        config.available && config.naip?.available
          ? attachNaip({
              Cesium,
              viewer,
              controller,
              session,
              naip: config.naip,
              createSlider: createNaipMenuSlider,
              createSplit: createNaipSplit,
            })
          : null;
      const hookWindow =
        viewer?.container?.ownerDocument?.defaultView ?? globalThis;
      const imageryVoice = createImageryVoice({
        getNaip: () => naip,
        getCatalog: () => config.naip,
        getWayback: () => hookWindow.__gevWayback ?? null,
        ensureOpen: () => ensureByrditOpen(controller),
        flyTo: (bounds) => flyToImageryBounds(viewer, Cesium, bounds),
      });
      if (hookWindow) hookWindow.__gevImagery = { voice: imageryVoice };
      const detach = () => {
        if (hookWindow?.__gevImagery?.voice === imageryVoice)
          delete hookWindow.__gevImagery;
        if (health) health.onChange = null;
        naip?.();
        buildings?.();
        detachSwitch();
      };
      detach.evaluate = detachSwitch.evaluate;
      detach.buildings = buildings;
      detach.naip = naip;
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
