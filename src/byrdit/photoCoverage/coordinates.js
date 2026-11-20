// Match build_coverage_model.py's ENU map conversion, not EXIF altitude.
export function modelLatLon(origin, x, y) {
  const lat = Number(origin?.lat),
    lon = Number(origin?.lon);
  if (
    ![lat, lon, x, y].every(Number.isFinite) ||
    Math.abs(lat) >= 90 ||
    Math.abs(lon) > 180
  )
    throw new Error('Invalid model coordinates');
  const factor = 111320 * Math.cos((lat * Math.PI) / 180);
  return { lat: lat + y / 111320, lon: lon + x / factor };
}
export function cellCorners(grid, origin, key) {
  if (
    !Number.isInteger(key) ||
    key < 0 ||
    key >= grid.nx * grid.ny ||
    !Number.isFinite(grid.cell_m) ||
    grid.cell_m <= 0
  )
    throw new Error('Invalid coverage cell');
  const x = grid.x0 + (key % grid.nx) * grid.cell_m,
    y = grid.y0 + Math.floor(key / grid.nx) * grid.cell_m,
    d = grid.cell_m;
  return [
    [x, y],
    [x + d, y],
    [x + d, y + d],
    [x, y + d],
  ].map(([a, b]) => modelLatLon(origin, a, b));
}
export function modelHeight(photoZ, groundZ, terrainHeight) {
  if (![photoZ, groundZ, terrainHeight].every(Number.isFinite))
    throw new Error('Terrain height unavailable');
  return terrainHeight + photoZ - groundZ;
}
