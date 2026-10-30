/**
 * Obstacle columns on the globe: one see-through cylinder per obstacle, from
 * the ground to its height, with a yellow handle on top. Drag the handle up
 * or down to change the height; the panel list does the same by typing.
 *
 * The ground under a column comes from the globe's terrain model. Nothing
 * here reads heights, depths or picks from the Google 3D tiles: their terms
 * forbid measuring them in code. The operator compares these columns with
 * the 3D scene by eye. A guard test greps this file for the banned calls.
 */
import {
  claimPointer,
  isPointerFree,
  releasePointer,
} from '../../data/inputOwnership.js';
import { MAX_OBSTACLE_HEIGHT_M, obstacleLabel } from './obstacles.js';

export const OBSTACLE_OVERLAY_SOURCE = 'gev-drone-obstacles';
export const OBSTACLE_POINTER_OWNER = 'drone-plan-obstacle-drag';
const HANDLE_GRAB_PX = 16;
const MIN_DRAW_LENGTH_M = 0.5;

/**
 * @param {{ dataSource: object, cesium: object, viewer: object,
 *   requestRender: () => void,
 *   overlay?: { set: (entries: object[]) => void, clear: () => void } | null,
 *   onHeight?: (id: string, heightM: number) => void,
 *   kindText?: (kind: string) => string }} deps
 */
/**
 * Where a screen point meets the TERRAIN globe (not the 3D tiles), as lon/lat.
 * This is the pick the ADD tool uses: the standard annotation pick does a depth
 * pick on whatever is rendered, which is Google Photorealistic 3D when it is
 * on, and the Google terms bar reading picks from it. Only the globe is hit.
 * @returns {{lon:number,lat:number}|null}
 */
export function pickTerrainLonLat(
  viewer,
  nx,
  ny,
  cesium = Cesium,
  groundHintM = 0,
) {
  try {
    const canvas = viewer?.scene?.canvas;
    const w = canvas?.clientWidth || canvas?.width;
    const h = canvas?.clientHeight || canvas?.height;
    if (!w || !h || !cesium?.Cartesian2) return null;
    const win = new cesium.Cartesian2(nx * w, ny * h);
    const ray = viewer.camera.getPickRay(win);
    if (!ray) return null;
    // With the globe hidden (Photorealistic 3D on) it cannot answer: use the
    // ellipsoid raised to the plan's terrain height, so a click on high ground
    // does not land far off. The height comes from the terrain read only.
    const wgs = cesium.Ellipsoid?.WGS84;
    const raised =
      Number.isFinite(groundHintM) &&
      groundHintM !== 0 &&
      wgs?.radii &&
      typeof cesium.Ellipsoid === 'function'
        ? new cesium.Ellipsoid(
            wgs.radii.x + groundHintM,
            wgs.radii.y + groundHintM,
            wgs.radii.z + groundHintM,
          )
        : wgs;
    const hit =
      viewer.scene.globe.pick(ray, viewer.scene) ??
      viewer.camera.pickEllipsoid(win, raised);
    if (!hit) return null;
    const c = cesium.Cartographic.fromCartesian(hit);
    const lon = cesium.Math.toDegrees(c.longitude);
    const lat = cesium.Math.toDegrees(c.latitude);
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  } catch {
    return null;
  }
}

export function createObstacleLayer({
  dataSource,
  cesium,
  viewer,
  requestRender,
  overlay = null,
  onHeight,
  kindText = (kind) => kind,
}) {
  let entities = [];
  let current = [];
  let grounds = new Map();
  let handler = null;
  let drag = null;
  let lease = null;
  let destroyed = false;
  // Ground height from the plan's terrain read, for when the globe is hidden
  // (Photorealistic tiles on) and cannot answer. Never taken from the tiles.
  let groundHintM = 0;

  const color = (css, alpha) =>
    cesium.Color.fromCssColorString(css).withAlpha(alpha);

  function groundAt(o) {
    try {
      const h = viewer.scene?.globe?.getHeight?.(
        cesium.Cartographic.fromDegrees(o.lon, o.lat),
      );
      return Number.isFinite(h) ? h : groundHintM;
    } catch {
      return groundHintM;
    }
  }

  function drop() {
    for (const entity of entities) dataSource.entities.remove(entity);
    entities = [];
  }

  function draw() {
    drop();
    grounds = new Map();
    const labels = [];
    for (const o of current) {
      const ground = groundAt(o);
      grounds.set(o.id, ground);
      const length = Math.max(MIN_DRAW_LENGTH_M, o.heightM);
      const hot = o.userEdited || o.source === 'user';
      entities.push(
        dataSource.entities.add({
          name: `Obstacle ${o.id}`,
          position: cesium.Cartesian3.fromDegrees(
            o.lon,
            o.lat,
            ground + length / 2,
          ),
          cylinder: {
            length,
            topRadius: o.radiusM,
            bottomRadius: o.radiusM,
            material: color(hot ? '#ffd24a' : '#ff6a3d', 0.22),
            outline: true,
            outlineColor: color(hot ? '#ffd24a' : '#ff6a3d', 0.9),
            numberOfVerticalLines: 8,
          },
        }),
      );
      const top = cesium.Cartesian3.fromDegrees(o.lon, o.lat, ground + length);
      entities.push(
        dataSource.entities.add({
          name: `Obstacle handle ${o.id}`,
          position: top,
          point: {
            pixelSize: 12,
            color: color('#ffd24a', 1),
            outlineColor: color('#000000', 0.7),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
      labels.push({
        id: o.id,
        position: top,
        variant: 'label',
        title: obstacleLabel(o, kindText),
        horizonCull: false,
      });
    }
    try {
      if (overlay) {
        if (labels.length) overlay.set(labels);
        else overlay.clear();
      }
    } catch {
      /* labels are a nicety: a host that is not running must not stop the columns */
    }
    requestRender();
  }

  function bind() {
    if (handler || destroyed || !cesium.ScreenSpaceEventHandler) return;
    const canvas = viewer.scene?.canvas;
    if (!canvas) return;
    handler = new cesium.ScreenSpaceEventHandler(canvas);
    handler.setInputAction(onDown, cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(onMove, cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(onUp, cesium.ScreenSpaceEventType.LEFT_UP);
  }

  /** The obstacle whose top handle is under the pointer, if any. */
  function handleAt(position) {
    let best = null;
    let bestPx = HANDLE_GRAB_PX;
    for (const o of current) {
      const ground = grounds.get(o.id) ?? 0;
      const top = cesium.Cartesian3.fromDegrees(
        o.lon,
        o.lat,
        ground + Math.max(MIN_DRAW_LENGTH_M, o.heightM),
      );
      const px = cesium.SceneTransforms?.worldToWindowCoordinates?.(
        viewer.scene,
        top,
      );
      if (!px) continue;
      const d = Math.hypot(px.x - position.x, px.y - position.y);
      if (d <= bestPx) {
        bestPx = d;
        best = o;
      }
    }
    return best;
  }

  /**
   * Height above the ground at the pointer: the closest point between the
   * pointer's view ray and the vertical line through the column.
   */
  function heightFromPointer(o, position) {
    const ray = viewer.camera.getPickRay(position);
    if (!ray) return null;
    const ground = grounds.get(o.id) ?? 0;
    const p0 = cesium.Cartesian3.fromDegrees(o.lon, o.lat, ground);
    const n = cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      p0,
      new cesium.Cartesian3(),
    );
    const d = ray.direction;
    const w0 = cesium.Cartesian3.subtract(
      p0,
      ray.origin,
      new cesium.Cartesian3(),
    );
    const b = cesium.Cartesian3.dot(n, d);
    const denom = 1 - b * b;
    if (denom < 1e-6) return null;
    const s =
      (b * cesium.Cartesian3.dot(d, w0) - cesium.Cartesian3.dot(n, w0)) / denom;
    return Number.isFinite(s) ? s : null;
  }

  let inputsBefore = true;
  function setCameraInputs(on) {
    const c = viewer.scene?.screenSpaceCameraController;
    if (!c) return;
    if (!on) inputsBefore = c.enableInputs !== false;
    c.enableInputs = on ? inputsBefore : false;
  }

  function onDown(event) {
    if (destroyed || drag || !event?.position || !isPointerFree()) return;
    const hit = handleAt(event.position);
    if (!hit) return;
    lease = claimPointer(OBSTACLE_POINTER_OWNER);
    if (!lease) return;
    drag = { id: hit.id };
    setCameraInputs(false);
  }

  function onMove(event) {
    if (!drag || !event?.endPosition) return;
    const o = current.find((x) => x.id === drag.id);
    if (!o) return;
    const h = heightFromPointer(o, event.endPosition);
    if (h === null) return;
    const clamped = Math.max(0, Math.min(MAX_OBSTACLE_HEIGHT_M, h));
    onHeight?.(o.id, Math.round(clamped * 10) / 10);
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    setCameraInputs(true);
    releasePointer(lease);
    lease = null;
  }
  const onUp = () => endDrag();

  return {
    /** Redraw every column from the list. Cheap enough to call on each edit. */
    set(list) {
      if (destroyed) return;
      current = Array.isArray(list) ? list : [];
      if (current.length) bind();
      draw();
    },
    /** Ground elevation (m) to use where the globe has no height. */
    setGroundHint(m) {
      const next = Number.isFinite(m) ? m : 0;
      if (next === groundHintM) return;
      groundHintM = next;
      if (current.length && !destroyed) draw();
    },
    clear() {
      endDrag();
      current = [];
      draw();
    },
    count: () => entities.length / 2,
    isDragging: () => drag !== null,
    destroy() {
      if (destroyed) return;
      endDrag();
      destroyed = true;
      drop();
      try {
        overlay?.clear();
      } catch {
        /* nothing to clear */
      }
      handler?.destroy();
      handler = null;
    },
  };
}
