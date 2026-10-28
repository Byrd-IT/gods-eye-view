/**
 * One-click point picker on the globe (the Drone Flight Plan takeoff point).
 * Same ownership rules as the box tool and the Draw tool: the pointer is
 * claimed for the session, the viewer's own click actions are borrowed and
 * given back, Escape cancels, and destroy() returns everything.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../../annotations/annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../../data/inputOwnership.js';

export const TAKEOFF_POINTER_OWNER = 'drone-plan-takeoff';

/**
 * @param {{ viewer: object, onPoint: (p: {lon:number,lat:number}) => void,
 *   onCancel?: (reason: string, message?: string) => void,
 *   onActive?: (active: boolean) => void, cesium?: object,
 *   pickWorld?: Function, documentRef?: object, owner?: string,
 *   bodyClass?: string }} deps
 * @returns {{ start: () => boolean, cancel: (reason?: string) => void,
 *   isActive: () => boolean, destroy: () => void } | null}
 */
export function initPointTool({
  viewer,
  onPoint,
  onCancel,
  onActive,
  cesium = Cesium,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
  owner = TAKEOFF_POINTER_OWNER,
  bodyClass = 'gev-drone-box',
} = {}) {
  if (!viewer?.scene || typeof onPoint !== 'function') return null;
  let active = false;
  let destroyed = false;
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;

  const worldAt = (position) => {
    if (!position) return null;
    const canvas = viewer.scene.canvas;
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    const point = pickWorld(viewer, position.x / w, position.y / h);
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  };

  const onClick = (event) => {
    if (!active || destroyed) return;
    const point = worldAt(event.position);
    if (!point) {
      onCancel?.('sky');
      return;
    }
    setActive(false);
    onPoint(point);
  };
  const onKey = (event) => {
    if (!active || destroyed || event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    cancel('escape');
  };

  function bindScene() {
    if (handler) return;
    handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, cesium.ScreenSpaceEventType.LEFT_CLICK);
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
  }

  function setActive(next) {
    if (next === active) return active;
    if (next) {
      lease = claimPointer(owner);
      if (!lease) {
        onCancel?.('pointer-busy', `${pointerOwner()}`);
        return active;
      }
      active = true;
      bindScene();
    } else {
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
    setActive(false);
    onCancel?.(reason);
  }

  return {
    start: () => !destroyed && setActive(true),
    cancel,
    isActive: () => active,
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
