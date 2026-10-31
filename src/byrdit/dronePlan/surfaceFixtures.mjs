import { createSurfaceGrid, gridInFrame } from './surfaceGrid.js';
import { metersPerDegree } from './geo.js';
import { lonLatToUtm, utmZoneOf } from './utm.js';

export const CELL = 0.5;

/**
 * A square synthetic surface, `size` metres a side, centred on the origin.
 * `topAt(x, y)` and `groundAt(x, y)` take local metres (x east, y north).
 */
export function makeGrid({
  id = 'test',
  capturedAt = '2026-10-30T00:00:00Z',
  size = 200,
  topAt = () => 0,
  groundAt = () => 0,
  origin = { lon: -95.1, lat: 32.55 },
} = {}) {
  const M = metersPerDegree(origin.lat);
  const ll = (x, y) => ({
    lon: origin.lon + x / M.lon,
    lat: origin.lat + y / M.lat,
  });
  const zone = utmZoneOf(origin.lon);
  const c = lonLatToUtm(origin.lon, origin.lat, zone, true);
  const cols = Math.round(size / CELL);
  const rows = cols;
  const originE = c.e - size / 2;
  const originN = c.n + size / 2;
  const top = new Float32Array(cols * rows);
  const ground = new Float32Array(cols * rows);
  const sw = ll(-size / 2, -size / 2);
  const ne = ll(size / 2, size / 2);
  const meta = {
    id,
    name: id,
    areaId: 'ranch',
    capturedAt,
    source: 'test',
    crs: { type: 'utm', zone, north: true },
    originE,
    originN,
    cellM: CELL,
    cols,
    rows,
    bounds: { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat },
  };
  // The grid is rotated against true north (grid convergence): lay the
  // shapes out in TRUE local metres, as the planner sees them.
  const frame = gridInFrame(
    createSurfaceGrid(meta, top, ground),
    origin.lon,
    origin.lat,
    M,
  );
  for (let r = 0; r < rows; r += 1) {
    for (let col = 0; col < cols; col += 1) {
      const q = frame.local(col, r);
      top[r * cols + col] = topAt(q.x, q.y);
      ground[r * cols + col] = groundAt(q.x, q.y);
    }
  }
  return createSurfaceGrid(meta, top, ground);
}
