/**
 * Mounts Solunar into the right-hand rail card (#solunar-panel, markup in
 * src/ui/views/ContextView.vue). While the card is open, a click on the map
 * picks the spot; the default spot is the middle of the map. A gold dot marks
 * the spot while the card is open. Fork module (DESIGN.md 4.1).
 */
import * as Cesium from 'cesium';
import { createSolunarPanel } from './panel.js';

export const SOLUNAR_ID = 'solunar-panel';
export const SOLUNAR_BODY_ID = 'gev-solunar-body';
export const SPOT_MARKER_ID = 'gev-solunar-spot';
/** A press that moves farther than this, or lasts longer, is a drag. */
const CLICK_SLOP_PX = 5;
const CLICK_MAX_MS = 600;

const RAD = 180 / Math.PI;

/** Lat/lon (deg) under a canvas pixel, or null (sky, off the globe). */
export function pickSpot(viewer, x, y) {
  const ellipsoid = viewer?.scene?.globe?.ellipsoid;
  const cartesian = viewer?.camera?.pickEllipsoid?.({ x, y }, ellipsoid);
  if (!cartesian || !ellipsoid) return null;
  const c = ellipsoid.cartesianToCartographic(cartesian);
  if (!c) return null;
  return { latDeg: c.latitude * RAD, lonDeg: c.longitude * RAD, cartesian };
}

/** The spot under the middle of the map; the camera position as a fallback. */
export function mapCenterSpot(viewer) {
  const canvas = viewer?.scene?.canvas;
  if (canvas) {
    const hit = pickSpot(
      viewer,
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    if (hit) return hit;
  }
  const c = viewer?.camera?.positionCartographic;
  return c
    ? { latDeg: c.latitude * RAD, lonDeg: c.longitude * RAD, cartesian: null }
    : null;
}

export function mountSolunarForShell(
  shell,
  { document: doc = globalThis.document, now } = {},
) {
  const root = doc?.getElementById?.(SOLUNAR_ID);
  const body = doc?.getElementById?.(SOLUNAR_BODY_ID);
  const viewer = shell?.viewer;
  if (!root || !body || !viewer) return null;
  if (root.dataset?.solunarMounted === '1') return null;
  root.dataset.solunarMounted = '1';

  const isOpen = () => !root.classList.contains('collapsed');
  let marker = null;
  const clearMarker = () => {
    if (marker) viewer.entities.remove(marker);
    marker = null;
    viewer.scene?.requestRender?.(); // the app idles between frames
  };
  const showMarker = (cartesian) => {
    clearMarker();
    if (!cartesian) return;
    marker = viewer.entities.add({
      id: SPOT_MARKER_ID,
      position: cartesian,
      point: {
        pixelSize: 11,
        color: Cesium.Color.GOLD,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    viewer.scene?.requestRender?.();
  };
  let lastCartesian = null;
  const useSpot = (spot, source) => {
    if (!spot) return;
    lastCartesian = spot.cartesian;
    panel.setSpot(spot.latDeg, spot.lonDeg, source);
    if (isOpen()) showMarker(spot.cartesian);
  };
  const useCenter = () => useSpot(mapCenterSpot(viewer), 'center');
  const panel = createSolunarPanel({
    container: body,
    doc,
    ...(now ? { now } : {}),
    onUseCenter: useCenter,
  });

  // Open: default to the map centre unless the user already chose a spot.
  const onToggle = () => {
    if (isOpen()) {
      if (!panel.getSpot() || panel.getSpot().source === 'center') useCenter();
      else {
        showMarker(lastCartesian);
        panel.refresh(); // the card may have stayed closed past midnight
      }
    } else clearMarker();
  };
  const Observer =
    doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = Observer ? new Observer(onToggle) : null;
  observer?.observe(root, { attributes: true, attributeFilter: ['class'] });

  // A click (not a drag) on the map while the card is open picks the spot.
  const canvas = viewer.scene?.canvas;
  let down = null;
  const onDown = (e) => {
    down =
      e.button === 0 ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
  };
  const onUp = (e) => {
    const start = down;
    down = null;
    if (!start || !isOpen() || e.button !== 0) return;
    if (
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX ||
      e.timeStamp - start.at > CLICK_MAX_MS
    )
      return;
    const rect = canvas.getBoundingClientRect();
    useSpot(
      pickSpot(viewer, e.clientX - rect.left, e.clientY - rect.top),
      'click',
    );
  };
  canvas?.addEventListener('pointerdown', onDown);
  canvas?.addEventListener('pointerup', onUp);

  if (isOpen()) useCenter();

  return {
    panel,
    destroy() {
      observer?.disconnect();
      canvas?.removeEventListener('pointerdown', onDown);
      canvas?.removeEventListener('pointerup', onUp);
      clearMarker();
      panel.destroy();
      delete root.dataset.solunarMounted;
    },
  };
}
