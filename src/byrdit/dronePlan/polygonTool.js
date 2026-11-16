/**
 * Click-to-draw a polygon on the globe for the Drone Flight Plan tool.
 * Click adds a corner. Closing: click the first corner (a big, distinct dot),
 * double-click, press Enter, or call `finish()` (the panel's FINISH button).
 * Backspace or `undo()` removes the last corner, Escape cancels. Every corner
 * is drawn as a dot and a rubber-band line follows the cursor. The pointer is
 * claimed and given back the same way as the box tool and the takeoff pick.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../../annotations/annotationResolver.js';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { lonLatToScreen } from './screenPoint.js';

export const POLYGON_POINTER_OWNER = 'drone-plan-polygon';
/** A click this close (canvas pixels) to the first corner closes the polygon. */
export const POLYGON_CLOSE_PX = 24;
/** The click that starts a double-click lands this close to where it ends. */
const DOUBLE_CLICK_PX = 12;
const MIN_CORNERS = 3;
const LINE_CSS = '#8be9ff';
const FIRST_CSS = '#ffd23f';

/** True when the key event came from somewhere the user is typing text. */
function isTypingTarget(event) {
  const node = event?.target;
  if (!node) return false;
  const tag = String(node.tagName ?? '').toLowerCase();
  return (
    tag === 'textarea' ||
    tag === 'select' ||
    node.isContentEditable === true ||
    (tag === 'input' &&
      !['button', 'checkbox', 'radio', 'range'].includes(
        String(node.type ?? '').toLowerCase(),
      ))
  );
}

/**
 * @param {{ viewer: object, onRing: (ring: {lon:number,lat:number}[]) => boolean|void,
 *   onCancel?: (reason: string) => void, onActive?: (active: boolean) => void,
 *   onChange?: (state: {count: number, canFinish: boolean}) => void,
 *   cesium?: object, pickWorld?: Function, project?: Function,
 *   documentRef?: object }} deps
 *   `project(viewer, lon, lat, {cesium, height})` gives the canvas pixel of a
 *   lon/lat (null when unknown); it is how the first corner is found again
 *   after the camera has moved.
 * @returns {{ start: () => boolean, cancel: (reason?: string) => void,
 *   finish: () => boolean, undo: () => boolean, isActive: () => boolean,
 *   vertexCount: () => number, canFinish: () => boolean,
 *   destroy: () => void } | null}
 */
export function initPolygonTool({
  viewer,
  onRing,
  onCancel,
  onActive,
  onChange,
  cesium = Cesium,
  pickWorld = pickWorldFromScreen,
  project = lonLatToScreen,
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
  /** @type {{lon:number,lat:number,height?:number,x:number,y:number}[]} */
  let vertices = [];
  /** Where the pointer is now, for the rubber band; null until it moves. */
  let cursor = null;
  let preview = null;

  const color = (css) => cesium.Color?.fromCssColorString?.(css);

  const worldAt = (position) => {
    if (!position) return null;
    const canvas = viewer.scene.canvas;
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    const point = pickWorld(viewer, position.x / w, position.y / h);
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const height = Number(point?.height);
    return {
      lon,
      lat,
      ...(Number.isFinite(height) ? { height } : {}),
      x: position.x,
      y: position.y,
    };
  };

  /**
   * Where a corner is on screen now, from its lon/lat, never from where the
   * click was: the camera may have moved since. A pick on a roof sits above the
   * terrain, so both heights count. Falls back to the click position only when
   * the scene cannot project.
   */
  const screenSpots = (vertex) => {
    const spots = [];
    const at = project(viewer, vertex.lon, vertex.lat, {
      cesium,
      height: vertex.height,
    });
    if (at) spots.push(at);
    if (Number.isFinite(vertex.height)) {
      const ground = project(viewer, vertex.lon, vertex.lat, { cesium });
      if (ground) spots.push(ground);
    }
    return spots.length ? spots : [{ x: vertex.x, y: vertex.y }];
  };

  const nearFirst = (position) => {
    if (vertices.length < MIN_CORNERS || !position) return false;
    return screenSpots(vertices[0]).some(
      (spot) =>
        Math.hypot(position.x - spot.x, position.y - spot.y) <=
        POLYGON_CLOSE_PX,
    );
  };

  const canFinish = () => vertices.length >= MIN_CORNERS;
  const notify = () =>
    onChange?.({ count: vertices.length, canFinish: canFinish() });

  const dot = (vertex, first) => ({
    position: cesium.Cartesian3.fromDegrees(vertex.lon, vertex.lat),
    point: {
      pixelSize: first ? 16 : 10,
      color: color(first ? FIRST_CSS : LINE_CSS),
      outlineColor: color(first ? '#000000' : '#0b1b24'),
      outlineWidth: first ? 3 : 2,
      heightReference: cesium.HeightReference?.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  const rubberBand = () => {
    const last = vertices[vertices.length - 1];
    if (!last || !cursor) return [];
    return cesium.Cartesian3.fromDegreesArray([
      last.lon,
      last.lat,
      cursor.lon,
      cursor.lat,
    ]);
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
          material: color(LINE_CSS),
        },
      });
      // The line from the last corner to the pointer reads from the cursor
      // each frame, so a mouse move only has to ask for a render.
      preview.entities.add({
        polyline: {
          positions: new cesium.CallbackProperty(rubberBand, false),
          width: 2,
          clampToGround: true,
          material: color(LINE_CSS)?.withAlpha?.(0.6),
        },
      });
      vertices.forEach((v, i) => preview.entities.add(dot(v, i === 0)));
    }
    viewer.scene.requestRender?.();
  }

  function tryClose() {
    if (!canFinish()) return false;
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
    cursor = { lon: point.lon, lat: point.lat };
    drawPreview();
    notify();
  };

  const onMove = (event) => {
    if (!active || destroyed || !vertices.length) return;
    const point = worldAt(event?.endPosition ?? event?.position);
    if (!point) return;
    cursor = { lon: point.lon, lat: point.lat };
    viewer.scene.requestRender?.();
  };

  const onDouble = (event) => {
    if (!active || destroyed) return;
    // A double-click also added a corner on the click that started it.
    if (vertices.length && event?.position) {
      const last = vertices[vertices.length - 1];
      if (
        Math.hypot(event.position.x - last.x, event.position.y - last.y) <=
        DOUBLE_CLICK_PX
      ) {
        vertices.pop();
      }
    } else if (vertices.length) {
      vertices.pop();
    }
    if (!tryClose() && vertices.length < MIN_CORNERS) onCancel?.('short');
    drawPreview();
    notify();
  };

  function undo() {
    if (!active || destroyed || !vertices.length) return false;
    vertices.pop();
    drawPreview();
    notify();
    return true;
  }

  function finish() {
    if (!active || destroyed) return false;
    return tryClose();
  }

  const onKey = (event) => {
    if (!active || destroyed) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      cancel('escape');
      return;
    }
    if (isTypingTarget(event)) return;
    if (event.key === 'Backspace') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      undo();
      return;
    }
    if (event.key === 'Enter') {
      // Consumed even with too few corners, so a focused button does not
      // also fire (a focused DRAW POLYGON would cancel the drawing).
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      finish();
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
    handler.setInputAction(onMove, cesium.ScreenSpaceEventType.MOUSE_MOVE);
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
      cursor = null;
      bindScene();
    } else {
      vertices = [];
      cursor = null;
      releaseScene();
      releasePointer(lease);
      lease = null;
      active = false;
    }
    onActive?.(active);
    notify();
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
    finish,
    undo,
    isActive: () => active,
    vertexCount: () => vertices.length,
    canFinish: () => active && canFinish(),
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
