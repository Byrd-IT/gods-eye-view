/**
 * Click-to-draw a polygon on the globe for the Drone Flight Plan tool.
 * Click adds a corner, double-click or a click on the first corner closes,
 * Backspace removes the last corner, Escape cancels. The pointer is claimed
 * and given back the same way as the box tool and the takeoff pick.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../../annotations/annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../../data/inputOwnership.js';

export const POLYGON_POINTER_OWNER = 'drone-plan-polygon';
const CLOSE_PX = 12;

/**
 * @param {{ viewer: object, onRing: (ring: {lon:number,lat:number}[]) => boolean|void,
 *   onCancel?: (reason: string) => void, onActive?: (active: boolean) => void,
 *   cesium?: object, pickWorld?: Function, documentRef?: object }} deps
 */
export function initPolygonTool({
  viewer,
  onRing,
  onCancel,
  onActive,
  cesium = Cesium,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
  owner = POLYGON_POINTER_OWNER,
  bodyClass = 'gev-drone-box',
} = {}) {
  if (!viewer?.scene || typeof onRing !== 'function') return null;
  let active = false;
  let destroyed = false;
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  /** @type {{lon:number,lat:number,x:number,y:number}[]} */
  let vertices = [];
  let preview = null;

  const worldAt = (position) => {
    if (!position) return null;
    const canvas = viewer.scene.canvas;
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    const point = pickWorld(viewer, position.x / w, position.y / h);
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { lon, lat, x: position.x, y: position.y };
  };

  const nearFirst = (position) => {
    if (vertices.length < 3 || !position) return false;
    const first = vertices[0];
    return Math.hypot(position.x - first.x, position.y - first.y) <= CLOSE_PX;
  };

  function drawPreview() {
    if (!preview || destroyed) return;
    preview.entities.removeAll();
    if (vertices.length) {
      const flat = vertices.flatMap((v) => [v.lon, v.lat]);
      if (vertices.length > 2) flat.push(vertices[0].lon, vertices[0].lat);
      preview.entities.add({
        polyline: {
          positions: cesium.Cartesian3.fromDegreesArray(flat),
          width: 2,
          clampToGround: true,
          material: cesium.Color?.fromCssColorString?.('#8be9ff'),
        },
      });
    }
    viewer.scene.requestRender?.();
  }

  function tryClose() {
    if (vertices.length < 3) return false;
    const ring = vertices.map((v) => ({ lon: v.lon, lat: v.lat }));
    if (onRing(ring) === false) return false;
    vertices = [];
    drawPreview();
    setActive(false);
    return true;
  }

  const onClick = (event) => {
    if (!active || destroyed) return;
    const point = worldAt(event.position);
    if (!point) {
      onCancel?.('sky');
      return;
    }
    if (nearFirst(event.position)) {
      tryClose();
      return;
    }
    vertices.push(point);
    drawPreview();
  };

  const onDouble = (event) => {
    if (!active || destroyed) return;
    // A double-click also added a corner on the click that started it.
    if (vertices.length && event?.position) {
      const last = vertices[vertices.length - 1];
      if (
        Math.hypot(event.position.x - last.x, event.position.y - last.y) <=
        CLOSE_PX
      ) {
        vertices.pop();
      }
    } else if (vertices.length) {
      vertices.pop();
    }
    if (!tryClose() && vertices.length < 3) onCancel?.('short');
    drawPreview();
  };

  const onKey = (event) => {
    if (!active || destroyed) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      cancel('escape');
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      vertices.pop();
      drawPreview();
    }
  };

  function bindScene() {
    if (handler) return;
    handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(
      onDouble,
      cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    const stock = viewer.screenSpaceEventHandler;
    if (stock) {
      savedSingleClick =
        stock.getInputAction(cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
      savedDoubleClick =
        stock.getInputAction(cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
        null;
      stock.removeInputAction(cesium.ScreenSpaceEventType.LEFT_CLICK);
      stock.removeInputAction(cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
    documentRef?.addEventListener?.('keydown', onKey, true);
    documentRef?.body?.classList?.add?.(bodyClass);
    if (cesium.CustomDataSource && viewer.dataSources?.add) {
      preview = new cesium.CustomDataSource('gev-drone-plan-polygon-preview');
      viewer.dataSources.add(preview);
    }
  }

  function releaseScene() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    const stock = viewer.screenSpaceEventHandler;
    if (stock && savedSingleClick) {
      stock.setInputAction(
        savedSingleClick,
        cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    }
    if (stock && savedDoubleClick) {
      stock.setInputAction(
        savedDoubleClick,
        cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    }
    savedSingleClick = null;
    savedDoubleClick = null;
    documentRef?.removeEventListener?.('keydown', onKey, true);
    documentRef?.body?.classList?.remove?.(bodyClass);
    if (preview) {
      try {
        viewer.dataSources.remove(preview, true);
      } catch {
        /* viewer already disposed */
      }
      preview = null;
    }
  }

  function setActive(next) {
    if (next === active) return active;
    if (next) {
      lease = claimPointer(owner);
      if (!lease) {
        onCancel?.('pointer-busy');
        return active;
      }
      active = true;
      vertices = [];
      bindScene();
    } else {
      vertices = [];
      releaseScene();
      releasePointer(lease);
      lease = null;
      active = false;
    }
    onActive?.(active);
    return active;
  }

  function cancel(reason = 'cancel') {
    if (!active || destroyed) return;
    vertices = [];
    setActive(false);
    onCancel?.(reason);
  }

  return {
    start: () => !destroyed && setActive(true),
    cancel,
    isActive: () => active,
    vertexCount: () => vertices.length,
    destroy() {
      if (destroyed) return;
      if (active) setActive(false);
      destroyed = true;
      releaseScene();
      releasePointer(lease);
      lease = null;
    },
  };
}
