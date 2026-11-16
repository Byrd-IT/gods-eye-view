/**
 * Edit a drawn survey area on the globe: drag a corner, drag the centre
 * handle to move the whole area, click an edge-midpoint handle to add a
 * corner, select a corner and remove it. Boxes stay axis-aligned rectangles
 * (four corner handles plus a centre handle); polygons never drop below 3
 * corners. The geometry is areaEdit.js; this module is the pointer, the
 * handles and the preview.
 *
 * The tool holds the pointer for the whole edit session (like the draw tools),
 * freezes the camera only while a handle is being dragged, and hands every
 * finished change to `onCommit`, which runs the same checks and replanning as a
 * newly drawn area. A change that is refused is undone.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../../annotations/annotationResolver.js';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { msg } from '../../i18n/index.js';
import {
  MIN_POLYGON_CORNERS,
  boxCorners,
  boxFromCorner,
  edgeMidpoints,
  insertVertexAtEdge,
  isPolygonShape,
  metricOffset,
  moveAreaBy,
  moveVertex,
  removeVertex,
  shapeCentre,
  translatePoint,
  validateEditedShape,
} from './areaEdit.js';
import { lonLatToScreen } from './screenPoint.js';

export const AREA_EDIT_POINTER_OWNER = 'drone-plan-area-edit';
/** A press this close (canvas pixels) to a handle grabs it. */
export const HANDLE_HIT_PX = 18;
/** The pointer must travel this far before a press becomes a drag. */
export const DRAG_START_PX = 4;

const OUTLINE_CSS = '#8be9ff';
const BAD_CSS = '#ff5555';
const SELECTED_CSS = '#ffd23f';
const CENTRE_CSS = '#ff79c6';
const SOURCE_NAME = 'gev-drone-plan-area-edit';

const copyShape = (area) =>
  isPolygonShape(area)
    ? {
        kind: 'polygon',
        ring: area.ring.map((p) => ({ lon: p.lon, lat: p.lat })),
      }
    : { kind: area.kind ?? 'rect', box: { ...area.box } };

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
 * @param {{ viewer: object,
 *   onCommit: (id: string, shape: object) => boolean|void,
 *   onReject?: (message: string, reason: string) => void,
 *   onChange?: (state: object) => void,
 *   onActive?: (active: boolean) => void,
 *   onExit?: (reason: string) => void,
 *   cesium?: object, pickWorld?: Function, project?: Function,
 *   documentRef?: object, owner?: string }} deps
 *   `onCommit(id, shape)` gets the validated new shape (`{kind:'polygon',
 *   ring, box}` or `{kind, box}`); returning `false` refuses it and the tool
 *   puts the old shape back.
 * @returns {{ start: (area: object) => boolean, cancel: (reason?: string) => void,
 *   isActive: () => boolean, areaId: () => string|null,
 *   selectedCorner: () => number|null, canRemoveCorner: () => boolean,
 *   removeSelectedCorner: () => boolean, cornerCount: () => number,
 *   destroy: () => void } | null}
 */
export function initAreaEditTool({
  viewer,
  onCommit,
  onReject,
  onChange,
  onActive,
  onExit,
  cesium = Cesium,
  pickWorld = pickWorldFromScreen,
  project = lonLatToScreen,
  documentRef = globalThis.document,
  owner = AREA_EDIT_POINTER_OWNER,
} = {}) {
  if (!viewer?.scene || typeof onCommit !== 'function') return null;

  let active = false;
  let destroyed = false;
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let savedCameraInputs = null;
  let source = null;
  let hovering = false;
  /** The area being edited: its id and the last shape that was accepted. */
  let areaId = null;
  let shape = null;
  /** The shape under the pointer while a handle is being dragged. */
  let draft = null;
  let selected = null;
  /** @type {null|{handle: object, grab: object, startShape: object, startPos: {x:number,y:number}, moved: boolean}} */
  let drag = null;

  const color = (css) => cesium.Color?.fromCssColorString?.(css);
  const requestRender = () => viewer.scene.requestRender?.();
  const cameraController = () => viewer.scene.screenSpaceCameraController;

  function freezeCamera() {
    const controller = cameraController();
    if (!controller || savedCameraInputs !== null) return;
    savedCameraInputs = controller.enableInputs;
    controller.enableInputs = false;
  }
  function thawCamera() {
    const controller = cameraController();
    if (controller && savedCameraInputs !== null)
      controller.enableInputs = savedCameraInputs;
    savedCameraInputs = null;
  }

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

  const viewShape = () => draft ?? shape;

  /** Every handle of a shape: corners, edge midpoints, centre. */
  function handlesOf(of) {
    if (!of) return [];
    const centre = { id: 'centre', kind: 'centre', ...shapeCentre(of) };
    if (isPolygonShape(of)) {
      const corners = of.ring.map((p, index) => ({
        id: `vertex:${index}`,
        kind: 'vertex',
        index,
        lon: p.lon,
        lat: p.lat,
      }));
      const mids = edgeMidpoints(of.ring).map((p, index) => ({
        id: `mid:${index}`,
        kind: 'mid',
        index,
        lon: p.lon,
        lat: p.lat,
      }));
      return [...corners, ...mids, centre];
    }
    const corners = Object.entries(boxCorners(of.box)).map(([key, p]) => ({
      id: `corner:${key}`,
      kind: 'corner',
      corner: key,
      lon: p.lon,
      lat: p.lat,
    }));
    return [...corners, centre];
  }

  const PRIORITY = { vertex: 0, corner: 0, mid: 1, centre: 2 };

  /** The handle under a canvas position: corners first, then midpoints, then the centre. */
  function hitHandle(position) {
    if (!position || !shape) return null;
    let best = null;
    for (const handle of handlesOf(viewShape())) {
      const spot = project(viewer, handle.lon, handle.lat, { cesium });
      if (!spot) continue;
      const distance = Math.hypot(position.x - spot.x, position.y - spot.y);
      if (distance > HANDLE_HIT_PX) continue;
      if (
        !best ||
        PRIORITY[handle.kind] < PRIORITY[best.handle.kind] ||
        (PRIORITY[handle.kind] === PRIORITY[best.handle.kind] &&
          distance < best.distance)
      ) {
        best = { handle, distance };
      }
    }
    return best?.handle ?? null;
  }

  // ------------------------------------------------------------ drawing --
  const point = (handle, bad) => {
    const isSelected = handle.kind === 'vertex' && handle.index === selected;
    const size = { vertex: 13, corner: 13, mid: 8, centre: 15 }[handle.kind];
    const fill = isSelected
      ? SELECTED_CSS
      : handle.kind === 'centre'
        ? CENTRE_CSS
        : handle.kind === 'mid'
          ? '#b8f1ff'
          : '#ffffff';
    return {
      position: cesium.Cartesian3.fromDegrees(handle.lon, handle.lat),
      point: {
        pixelSize: isSelected ? size + 3 : size,
        color: color(fill),
        outlineColor: color(bad ? BAD_CSS : OUTLINE_CSS),
        outlineWidth: handle.kind === 'mid' ? 1 : 3,
        heightReference: cesium.HeightReference?.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    };
  };

  function redraw() {
    if (!source || destroyed) return;
    source.entities.removeAll();
    const view = viewShape();
    if (!view) return;
    // While a drag is live the outline turns red as soon as the shape would
    // be refused, so the refusal on release is no surprise.
    const bad = draft ? !validateEditedShape(draft).ok : false;
    const ring = isPolygonShape(view)
      ? view.ring
      : [
          { lon: view.box.west, lat: view.box.south },
          { lon: view.box.east, lat: view.box.south },
          { lon: view.box.east, lat: view.box.north },
          { lon: view.box.west, lat: view.box.north },
        ];
    const flat = ring.flatMap((p) => [p.lon, p.lat]);
    flat.push(ring[0].lon, ring[0].lat);
    source.entities.add({
      polyline: {
        positions: cesium.Cartesian3.fromDegreesArray(flat),
        width: 3,
        clampToGround: true,
        material: color(bad ? BAD_CSS : OUTLINE_CSS),
      },
    });
    for (const handle of handlesOf(view)) {
      source.entities.add(point(handle, bad));
    }
    requestRender();
  }

  function notify() {
    onChange?.({
      areaId,
      kind: shape ? (isPolygonShape(shape) ? 'polygon' : 'rect') : null,
      cornerCount: cornerCount(),
      selectedCorner: selected,
      canRemoveCorner: canRemoveCorner(),
    });
  }

  function cornerCount() {
    if (!shape) return 0;
    return isPolygonShape(shape) ? shape.ring.length : 4;
  }
  function canRemoveCorner() {
    return (
      active &&
      !drag &&
      isPolygonShape(shape ?? {}) &&
      selected !== null &&
      shape.ring.length > MIN_POLYGON_CORNERS
    );
  }

  // ------------------------------------------------------------ commits --
  /** Validate `next`, hand it over, and keep it or put the old shape back. */
  function commit(next, { select = selected, before = selected } = {}) {
    const checked = validateEditedShape(next);
    if (!checked.ok) {
      selected = before;
      onReject?.(checked.message, checked.reason);
      return false;
    }
    const accepted = onCommit(areaId, checked.shape);
    if (accepted === false) {
      selected = before;
      return false;
    }
    shape = copyShape(checked.shape);
    selected = isPolygonShape(shape) ? select : null;
    return true;
  }

  // ------------------------------------------------------------- events --
  function setHover(on) {
    if (on === hovering) return;
    hovering = on;
    const canvas = viewer.scene.canvas;
    if (canvas?.style) canvas.style.cursor = on ? 'grab' : '';
  }

  const onDown = (event) => {
    if (!active || destroyed || drag) return;
    const handle = hitHandle(event.position);
    if (!handle) return;
    const grab = worldAt(event.position);
    if (!grab) return;
    drag = {
      handle,
      grab,
      startShape: copyShape(shape),
      startPos: { x: event.position.x, y: event.position.y },
      moved: false,
      selectedBefore: selected,
    };
    freezeCamera();
    documentRef?.addEventListener?.('pointerup', onDocumentUp);
    documentRef?.addEventListener?.('pointercancel', onDocumentUp);
    if (viewer.scene.canvas?.style)
      viewer.scene.canvas.style.cursor = 'grabbing';
  };

  /** The draft shape for the pointer at `world`, from the shape the drag began with. */
  function draftFor(session, world) {
    const { handle, grab, startShape } = session;
    const { dxM, dyM } = metricOffset(grab, world);
    if (handle.kind === 'centre') return moveAreaBy(startShape, grab, world);
    if (handle.kind === 'vertex') {
      const target = translatePoint(startShape.ring[handle.index], dxM, dyM);
      const ring = target && moveVertex(startShape.ring, handle.index, target);
      return ring && { kind: 'polygon', ring };
    }
    if (handle.kind === 'corner') {
      const target = translatePoint(
        boxCorners(startShape.box)[handle.corner],
        dxM,
        dyM,
      );
      const box =
        target && boxFromCorner(startShape.box, handle.corner, target);
      return box && { kind: startShape.kind, box };
    }
    return null;
  }

  const onMove = (event) => {
    if (!active || destroyed) return;
    const position = event?.endPosition ?? event?.position;
    if (!drag) {
      setHover(Boolean(hitHandle(position)));
      return;
    }
    if (!drag.moved) {
      const travelled = Math.hypot(
        position.x - drag.startPos.x,
        position.y - drag.startPos.y,
      );
      if (travelled < DRAG_START_PX) return;
      drag.moved = true;
      // Dragging an edge handle adds the corner and carries it along.
      if (drag.handle.kind === 'mid') {
        const inserted = insertVertexAtEdge(
          drag.startShape.ring,
          drag.handle.index,
        );
        if (!inserted) return;
        drag.startShape = { kind: 'polygon', ring: inserted.ring };
        drag.handle = {
          id: `vertex:${inserted.index}`,
          kind: 'vertex',
          index: inserted.index,
          ...inserted.ring[inserted.index],
        };
        selected = inserted.index;
      }
    }
    const world = worldAt(position);
    if (!world) return;
    const next = draftFor(drag, world);
    if (!next) return;
    draft = next;
    redraw();
  };

  /** End the drag: commit what it made, or put the old shape back. */
  function endDrag(position) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    documentRef?.removeEventListener?.('pointerup', onDocumentUp);
    documentRef?.removeEventListener?.('pointercancel', onDocumentUp);
    thawCamera();
    const world = position ? worldAt(position) : null;
    if (finished.moved && world && draft) {
      draft = draftFor(finished, world) ?? draft;
    }
    const result = draft;
    draft = null;
    const handle = finished.handle;
    if (!finished.moved) {
      // A click: select a corner, or add a corner at an edge midpoint.
      if (handle.kind === 'vertex') {
        selected = handle.index;
      } else if (handle.kind === 'mid') {
        const inserted = insertVertexAtEdge(shape.ring, handle.index);
        if (inserted) {
          commit(
            { kind: 'polygon', ring: inserted.ring },
            { select: inserted.index },
          );
        }
      }
    } else if (result) {
      const index = handle.kind === 'vertex' ? handle.index : selected;
      commit(result, { select: index, before: finished.selectedBefore });
    } else if (finished.moved) {
      selected = finished.selectedBefore;
    }
    setHover(false);
    redraw();
    notify();
  }

  const onUp = (event) => endDrag(event?.position);
  function onDocumentUp() {
    endDrag(null);
  }

  /** Esc during a drag drops the drag; otherwise it leaves edit mode. */
  function abortDrag() {
    if (!drag) return false;
    selected = drag.selectedBefore;
    drag = null;
    draft = null;
    documentRef?.removeEventListener?.('pointerup', onDocumentUp);
    documentRef?.removeEventListener?.('pointercancel', onDocumentUp);
    thawCamera();
    redraw();
    notify();
    return true;
  }

  function removeSelectedCorner() {
    if (!active || destroyed || drag) return false;
    if (!isPolygonShape(shape ?? {}) || selected === null) return false;
    const next = removeVertex(shape.ring, selected);
    if (!next) {
      onReject?.(msg('A polygon needs at least 3 corners'), 'too-few-corners');
      return false;
    }
    const ok = commit({ kind: 'polygon', ring: next }, { select: null });
    redraw();
    notify();
    return ok;
  }

  const onKey = (event) => {
    if (!active || destroyed) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      if (!abortDrag()) cancel('escape');
      return;
    }
    if (isTypingTarget(event)) return;
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      isPolygonShape(shape ?? {}) &&
      selected !== null
    ) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      removeSelectedCorner();
    }
  };

  // ----------------------------------------------------------- lifecycle --
  function bindScene() {
    if (handler) return;
    handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onDown, cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(onMove, cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(onUp, cesium.ScreenSpaceEventType.LEFT_UP);
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
    if (cesium.CustomDataSource && viewer.dataSources?.add) {
      source = new cesium.CustomDataSource(SOURCE_NAME);
      viewer.dataSources.add(source);
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
    documentRef?.removeEventListener?.('pointerup', onDocumentUp);
    documentRef?.removeEventListener?.('pointercancel', onDocumentUp);
    thawCamera();
    setHover(false);
    if (source) {
      try {
        source.entities.removeAll();
        viewer.dataSources.remove(source, true);
      } catch {
        /* viewer already disposed */
      }
      source = null;
    }
  }

  function stop() {
    drag = null;
    draft = null;
    shape = null;
    selected = null;
    areaId = null;
    releaseScene();
    releasePointer(lease);
    lease = null;
    active = false;
  }

  function start(area) {
    if (destroyed || !area?.id) return false;
    if (isPolygonShape(area) ? !area.ring?.length : !area.box) return false;
    if (active) {
      // Switching to another area keeps the pointer.
      abortDrag();
      areaId = area.id;
      shape = copyShape(area);
      selected = null;
      redraw();
      notify();
      return true;
    }
    lease = claimPointer(owner);
    if (!lease) return false;
    active = true;
    areaId = area.id;
    shape = copyShape(area);
    selected = null;
    bindScene();
    redraw();
    onActive?.(true);
    notify();
    return true;
  }

  function cancel(reason = 'cancel') {
    if (!active || destroyed) return;
    stop();
    onActive?.(false);
    onExit?.(reason);
    onChange?.({
      areaId: null,
      kind: null,
      cornerCount: 0,
      selectedCorner: null,
      canRemoveCorner: false,
    });
  }

  return {
    start,
    cancel,
    isActive: () => active,
    areaId: () => areaId,
    selectedCorner: () => selected,
    canRemoveCorner,
    removeSelectedCorner,
    cornerCount,
    destroy() {
      if (destroyed) return;
      const wasActive = active;
      stop();
      destroyed = true;
      if (wasActive) onActive?.(false);
    },
  };
}
