import { BYRDIT_OPEN_STACK_ID } from './stack.js';
import { cameraHeight } from './autoSwitch.js';
import {
  createNaipImageryProvider,
  layerOnScreen,
  viewBoundsOf,
  zoomForHeight,
} from './naip.js';
import { createVectorOverlayProvider } from './overlaysVector.js';

export { normalizeOverlays } from './overlaysConfig.js';

/**
 * Map overlay layers for the Byrd-IT Open stack (BASEMAP M2 follow-up):
 * raster (US Topo, hillshade, colour relief, terrain-RGB) and vector
 * (contours, TWDB lake depth) layers, each with its own on/off toggle and
 * opacity. Layers, zooms and bounds come from the `overlays` block of
 * /basemap/config.json (overlaysProxy.js), never from this file.
 *
 * Every overlay is OFF until the user turns it on and is drawn only inside
 * its own bounds (the lake corridors): the imagery rectangle clips the layer
 * and tiles outside are transparent. Stacking is fixed: rasters in manifest
 * order, vectors above them, all above the NAIP imagery.
 *
 * Visibility follows the NAIP layers (naip.js): only while the controller
 * shows Byrd-IT Open and the Google 3D tileset is not drawn. Any other stack
 * removes the layers (the user's toggles and opacities are kept).
 */

const CREDIT_ZOOM_SLACK = 2;

/**
 * Raster first, then vector; manifest order inside each group. Newly enabled
 * layers are raised to the top of the imagery stack, so overlays sit above
 * every other imagery layer (by design: they are the user's explicit choice).
 */
export function stackOrder(overlays) {
  const layers = overlays?.layers ?? [];
  return [
    ...layers.filter((l) => l.kind !== 'vector'),
    ...layers.filter((l) => l.kind === 'vector'),
  ];
}

export function attachOverlays({
  Cesium,
  viewer,
  controller,
  overlays,
  session = null,
  heightOf = () => cameraHeight(viewer),
  viewOf = () => ({
    viewBounds: viewBoundsOf(viewer, Cesium),
    lat: Cesium?.Math?.toDegrees
      ? Cesium.Math.toDegrees(
          viewer?.camera?.positionCartographic?.latitude ?? 0,
        )
      : 0,
  }),
  createProvider = (entry) =>
    entry.kind === 'vector'
      ? createVectorOverlayProvider(Cesium, entry)
      : createNaipImageryProvider(Cesium, entry),
  createPanel = null,
}) {
  const scene = viewer.scene;
  const collection = viewer.imageryLayers;
  const order = stackOrder(overlays);
  /** id -> {enabled, opacity} for every offered overlay. */
  const state = new Map(
    order.map((entry) => [
      entry.id,
      { enabled: false, opacity: entry.defaultOpacity },
    ]),
  );
  const layers = new Map(); // id -> Cesium imagery layer
  const credits = new Map();
  const creditObjects = new Map();
  let created = 0;
  let destroyed = 0;
  let detached = false;
  let googleWasShown = false;
  let panel = null;
  const removers = [];

  const googleShown = () => session?.tileset?.show === true;
  const openShown = () => controller.getActiveId() === BYRDIT_OPEN_STACK_ID;

  function removeLayer(id) {
    const layer = layers.get(id);
    if (!layer) return;
    layers.delete(id);
    destroyed += 1;
    if (!layer.isDestroyed?.()) collection.remove(layer, true);
  }
  const removeAll = () => {
    for (const id of [...layers.keys()]) removeLayer(id);
  };

  function syncLayers() {
    let added = false;
    for (const entry of order) {
      const s = state.get(entry.id);
      if (!s.enabled) {
        removeLayer(entry.id);
        continue;
      }
      let layer = layers.get(entry.id);
      if (!layer) {
        layer = new Cesium.ImageryLayer(createProvider(entry), {
          show: true,
          alpha: s.opacity,
        });
        layers.set(entry.id, layer);
        created += 1;
        collection.add(layer);
        added = true;
      }
      if (layer.alpha !== s.opacity) layer.alpha = s.opacity;
      if (layer.show !== true) layer.show = true;
    }
    // New layers land on top; restore the fixed raster -> vector order.
    if (added)
      for (const entry of order) {
        const layer = layers.get(entry.id);
        if (layer) collection.raiseToTop?.(layer);
      }
  }

  function setCredits(texts) {
    const display = scene?.frameState?.creditDisplay;
    if (!display) return;
    for (const [t, credit] of [...credits]) {
      if (texts.has(t)) continue;
      try {
        display.removeStaticCredit(credit);
        credits.delete(t);
      } catch {
        /* retried on the next change */
      }
    }
    for (const t of texts) {
      if (credits.has(t)) continue;
      try {
        let credit = creditObjects.get(t);
        if (!credit)
          creditObjects.set(t, (credit = new Cesium.Credit(t, true)));
        display.addStaticCredit(credit);
        credits.set(t, credit);
      } catch {
        /* retried on the next change */
      }
    }
  }

  const uiState = () => ({
    layers: order.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      enabled: state.get(entry.id).enabled,
      opacity: state.get(entry.id).opacity,
      minzoom: entry.minzoom,
    })),
  });

  function evaluate() {
    if (detached) return;
    if (!openShown() || googleShown()) {
      removeAll();
      setCredits(new Set());
      panel?.setVisible?.(openShown());
      panel?.update?.(uiState());
      scene?.requestRender?.();
      return;
    }
    syncLayers();
    const texts = new Set();
    const { viewBounds, lat } = viewOf();
    const zoom = zoomForHeight(heightOf(), lat);
    for (const entry of order)
      // zoomForHeight is only an estimate of the level Cesium draws; credit a
      // little early rather than draw tiles with no attribution.
      if (
        layers.has(entry.id) &&
        layerOnScreen(
          { ...entry, minzoom: entry.minzoom - CREDIT_ZOOM_SLACK },
          { viewBounds, zoom },
        )
      )
        texts.add(entry.credit);
    setCredits(texts);
    panel?.setVisible?.(true);
    panel?.update?.(uiState());
    scene?.requestRender?.();
  }

  const api = {
    setEnabled(id, on) {
      const s = state.get(id);
      if (!s) return false;
      s.enabled = Boolean(on);
      evaluate();
      return true;
    },
    setOpacity(id, value) {
      const s = state.get(id);
      const v = Number(value);
      if (!s || !Number.isFinite(v)) return false;
      s.opacity = Math.min(1, Math.max(0, v));
      evaluate();
      return true;
    },
  };

  if (createPanel)
    panel = createPanel({
      container: viewer.container,
      state: uiState(),
      onEnabled: (id, on) => api.setEnabled(id, on),
      onOpacity: (id, value) => api.setOpacity(id, value),
    });

  removers.push(controller.subscribe?.(() => evaluate()));
  const camera = viewer?.camera;
  if (camera?.moveEnd?.addEventListener)
    removers.push(camera.moveEnd.addEventListener(() => evaluate()));
  if (scene?.preUpdate?.addEventListener)
    removers.push(
      scene.preUpdate.addEventListener(() => {
        const shown = googleShown();
        if (shown === googleWasShown) return;
        googleWasShown = shown;
        evaluate();
      }),
    );
  evaluate();

  const detach = () => {
    if (detached) return;
    detached = true;
    removeAll();
    setCredits(new Set());
    panel?.destroy?.();
    panel = null;
    for (const remove of removers) remove?.();
  };
  Object.assign(detach, api, {
    evaluate,
    state: () => ({
      ...uiState(),
      active: [...layers.keys()],
      credits: [...credits.keys()],
      created,
      destroyed,
    }),
  });
  return detach;
}
