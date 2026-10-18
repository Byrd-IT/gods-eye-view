/**
 * OpenSky tile outlines for history time t (DESIGN.md 4.5: "tile outlines
 * for the OpenSky coverage at t"). Outline-only rectangles in their own
 * Cesium CustomDataSource: not a catalog layer, so the layer-count pins and
 * share fields are untouched; shown only in History mode.
 *
 * Each box edge is drawn ALONG its parallel / meridian (rhumb segments of
 * at most OUTLINE_STEP_DEG, latitudes kept off the poles). Umbrella B12 QA
 * (t_5aa880c7): a whole-world tile [-180,-90,180,90] (OpenSky polled where
 * a viewer looked at the whole globe) drawn corner to corner had a
 * pole-to-pole segment, exactly antipodal. Cesium's geodesic arc refuses
 * that ("Rendering has stopped": the whole globe stops drawing). A box
 * spanning all longitudes has no meridian edges (its west and east edges
 * are one line), and an edge on a pole is not drawn (it is a point).
 */
import * as Cesium from 'cesium';

export const TILE_SOURCE_NAME = 'gev-history-opensky-tiles';
/** Most degrees along one outline segment. */
export const OUTLINE_STEP_DEG = 2;
/** Outline latitudes are kept within +-this (a rhumb line has no pole). */
export const OUTLINE_MAX_LAT = 89.5;

const clampLat = (lat) =>
  Math.max(-OUTLINE_MAX_LAT, Math.min(OUTLINE_MAX_LAT, lat));

/** n+1 evenly spaced values from a to b (both exact), at most `step` apart. */
function ramp(a, b, step) {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  return Array.from({ length: n + 1 }, (_, i) =>
    i === n ? b : a + ((b - a) * i) / n,
  );
}

/**
 * The outline of one [w, s, e, n] box (degrees) as polylines of
 * [lon, lat, lon, lat, ...]. Empty for a degenerate or non-finite box.
 */
export function outlinePolylines(box, step = OUTLINE_STEP_DEG) {
  const [w, s, e, n] = Array.isArray(box) ? box : [];
  if (![w, s, e, n].every(Number.isFinite)) return [];
  if (!(e > w) || !(n > s)) return [];
  const south = clampLat(s);
  const north = clampLat(n);
  if (!(north > south)) return [];
  const parallel = (lat, from, to) =>
    ramp(from, to, step).map((lon) => [lon, lat]);
  const meridian = (lon, from, to) =>
    ramp(from, to, step).map((lat) => [lon, lat]);
  if (e - w >= 360) {
    // all longitudes: only the parallels, and not one lying on a pole
    return [
      [s, south],
      [n, north],
    ]
      .filter(([edge]) => Math.abs(edge) < 90)
      .map(([, lat]) => parallel(lat, w, e).flat());
  }
  const ring = [
    ...parallel(south, w, e),
    ...meridian(e, south, north).slice(1),
    ...parallel(north, e, w).slice(1),
    ...meridian(w, north, south).slice(1),
  ];
  return [ring.flat()];
}

export function createTileOutlines(viewer, { cesium = Cesium } = {}) {
  let source = null;
  const ensure = () => {
    if (source || !viewer?.dataSources?.add) return source;
    source = new cesium.CustomDataSource(TILE_SOURCE_NAME);
    viewer.dataSources.add(source);
    return source;
  };
  return {
    /** tiles: [[w, s, e, n], ...] in degrees */
    show(tiles) {
      const ds = ensure();
      if (!ds) return;
      ds.entities.removeAll();
      for (const tile of tiles) {
        for (const degrees of outlinePolylines(tile)) {
          ds.entities.add({
            polyline: {
              positions: cesium.Cartesian3.fromDegreesArray(degrees),
              width: 1.5,
              material:
                cesium.Color.fromCssColorString('#ffd27a').withAlpha(0.8),
              arcType: cesium.ArcType.RHUMB,
              clampToGround: false,
            },
          });
        }
      }
      viewer.scene?.requestRender?.();
    },
    clear() {
      source?.entities?.removeAll?.();
      viewer?.scene?.requestRender?.();
    },
    destroy() {
      if (source && viewer?.dataSources?.remove && !viewer.isDestroyed?.())
        viewer.dataSources.remove(source, true);
      source = null;
    },
  };
}
