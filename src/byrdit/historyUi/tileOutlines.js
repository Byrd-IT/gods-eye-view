/**
 * OpenSky tile outlines for history time t (DESIGN.md 4.5: "tile outlines
 * for the OpenSky coverage at t"). Outline-only rectangles in their own
 * Cesium CustomDataSource: not a catalog layer, so the layer-count pins and
 * share fields are untouched; shown only in History mode.
 */
import * as Cesium from 'cesium';

export const TILE_SOURCE_NAME = 'gev-history-opensky-tiles';

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
      for (const [w, s, e, n] of tiles) {
        if (![w, s, e, n].every(Number.isFinite)) continue;
        ds.entities.add({
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArray([
              w,
              s,
              e,
              s,
              e,
              n,
              w,
              n,
              w,
              s,
            ]),
            width: 1.5,
            material: cesium.Color.fromCssColorString('#ffd27a').withAlpha(0.8),
            clampToGround: false,
          },
        });
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
