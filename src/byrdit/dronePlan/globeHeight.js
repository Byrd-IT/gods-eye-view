/**
 * The globe's own terrain height at a point: what the map is drawing right
 * now. Read from the terrain model only (`globe.getHeight`), never from the
 * Google 3D tiles, whose terms forbid measuring them in code. Null when the
 * globe cannot say (its tile is not loaded, or the globe is hidden).
 */
export function globeHeightM(viewer, cesium, lon, lat) {
  try {
    const h = viewer?.scene?.globe?.getHeight?.(
      cesium.Cartographic.fromDegrees(lon, lat),
    );
    return typeof h === 'number' && Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}
