/**
 * Where a longitude/latitude is on the screen right now. The draw and edit
 * tools keep corners as lon/lat and ask this each time they need to know
 * whether a click is close to one, so a camera move since the corner was
 * placed cannot leave a stale pixel position behind.
 */
import * as Cesium from 'cesium';
import { globeHeightM } from './globeHeight.js';

/**
 * @param {object} viewer
 * @param {number} lon Degrees.
 * @param {number} lat Degrees.
 * @param {{ cesium?: object, height?: number|null }} [options] `height` is
 *   metres above the ellipsoid; by default the globe's terrain height there.
 * @returns {{x:number,y:number}|null} Canvas pixels, or null when the point
 *   is not on screen or the scene cannot say.
 */
export function lonLatToScreen(viewer, lon, lat, options = {}) {
  const cesium = options.cesium ?? Cesium;
  try {
    const known = Number.isFinite(options.height) ? options.height : null;
    const height = known ?? globeHeightM(viewer, cesium, lon, lat) ?? 0;
    const point = cesium.SceneTransforms?.worldToWindowCoordinates?.(
      viewer.scene,
      cesium.Cartesian3.fromDegrees(lon, lat, height),
    );
    return Number.isFinite(point?.x) && Number.isFinite(point?.y)
      ? { x: point.x, y: point.y }
      : null;
  } catch {
    return null;
  }
}
