import { fromDegrees } from '../../geo/ellipsoid.js';
import { inputFor } from '../../input/dispatcher.js';
import { heightsOf } from '../../queries/heights.js';
import { drawOf, queryOf } from '../../render/rendererOf.js';
import { cellCorners, modelHeight, modelLatLon } from './coordinates.js';
import { coverageColor } from './coverageCore.js';
import { footprintMask } from './footprintMask.js';

// Linear [r, g, b] in 0..1, as the named colours the layer always used.
const RED = [1, 0, 0],
  ORANGE = [1, 0.6470588235294118, 0],
  YELLOW = [1, 1, 0],
  LIME = [0, 1, 0],
  GRAY = [0.5, 0.5, 0.5],
  MAGENTA = [1, 0, 1],
  CYAN = [0, 1, 1],
  BLACK = [0, 0, 0, 1];
const withAlpha = (rgb, a) => [rgb[0], rgb[1], rgb[2], a];

/**
 * Ground coverage and camera positions. The layer owns the draw sets it
 * makes and the click subscription; `destroy()` gives them all back. The
 * ports default to the viewer's renderer; tests pass their own.
 */
export async function createCoverageLayer({
  viewer,
  state,
  onPick = () => {},
  draw,
  query,
  input,
  heights,
}) {
  if (!viewer || !state) throw new Error('Coverage map unavailable');
  try {
    draw ??= drawOf(viewer);
    query ??= queryOf(viewer);
    input ??= inputFor(viewer);
    heights ??= heightsOf(viewer);
  } catch {
    throw new Error('Coverage map unavailable');
  }
  if (!draw || !query || !input || !heights)
    throw new Error('Coverage map unavailable');
  const sets = [];
  let destroyed = false,
    offClick = null;
  const release = () => {
    offClick?.();
    offClick = null;
    for (const set of sets.splice(0)) set.dispose();
  };
  const make = (kind, id, extra) => {
    const set = draw[kind]({ id, pickable: true, ...extra });
    sets.push(set);
    return set;
  };
  try {
    const visible = (p) =>
      !state.visibleNames || state.visibleNames.has(p.name);
    const positions = state.photos.filter(
      (p) =>
        p.placed &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        visible(p),
    );
    // GPS-only photos never took part in the reconstruction: they have no
    // solved pose, frustum, footprint or coverage, but they do have a real
    // position and height to show. Missing or malformed fields fail closed.
    const gpsOnly = state.photos.filter(
      (p) =>
        p.placed === false &&
        typeof p.name === 'string' &&
        p.name.length > 0 &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Number.isFinite(p.z) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lon) <= 180 &&
        visible(p),
    );
    // The solved z coordinates share one model datum. Anchor that datum once
    // at the model origin; sampling at each camera would add terrain slope twice.
    const origin = modelLatLon(state.meta.origin, 0, 0);
    let terrainHeight = null;
    if (positions.length || gpsOnly.length) {
      let terrain;
      try {
        terrain = await heights.batch([{ lon: origin.lon, lat: origin.lat }], {
          against: 'terrain',
          ellipsoidMisses: true,
        });
      } catch {
        throw new Error('Terrain height unavailable');
      }
      if (terrain?.length !== 1 || !Number.isFinite(terrain[0]))
        throw new Error('Terrain height unavailable');
      terrainHeight = terrain[0];
    }
    const heightOf = (z) => modelHeight(z, state.meta.ground_z, terrainHeight);
    const byCell = new Map(state.cells.k.map((k, i) => [k, state.counts[i]]));
    const palette = { red: RED, orange: ORANGE, yellow: YELLOW, green: LIME };
    const rectOf = (key) => {
      const corners = cellCorners(state.cells, state.meta.origin, key),
        a = corners[0],
        b = corners[2];
      return { west: a.lon, south: a.lat, east: b.lon, north: b.lat };
    };
    const cells = [...state.mask].map((key) => ({
      id: `cell:${key}`,
      geometry: { kind: 'rectangle', rect: rectOf(key) },
      fill: withAlpha(palette[coverageColor(byCell.get(key) ?? 0)], 0.45),
      height: 'clampGround',
      meta: { type: 'coverage-cell', key },
    }));
    if (cells.length)
      make('shapes', 'photo-coverage-cells', { blend: 'translucent' }).set(
        cells,
      );
    const footprints = [];
    for (const name of (state.footprintNames ?? []).slice(0, 50)) {
      const index = state.photos.findIndex((p) => p.name === name);
      if (index < 0) continue;
      for (const key of footprintMask(state, index))
        footprints.push({
          id: `footprint:${name}:${key}`,
          geometry: { kind: 'rectangle', rect: rectOf(key) },
          fill: withAlpha(CYAN, 0.24),
          height: 'clampGround',
          meta: { type: 'footprint', name },
        });
    }
    if (footprints.length)
      make('shapes', 'photo-coverage-footprints', {
        blend: 'translucent',
      }).set(footprints);
    const projected = [],
      points = [],
      lines = [];
    positions.forEach((p) => {
      const status = state.discarded.has(p.name)
        ? GRAY
        : p.flags?.length
          ? MAGENTA
          : CYAN;
      const h = heightOf(p.z);
      const position = fromDegrees(p.lon, p.lat, h);
      projected.push({ name: p.name, position });
      points.push({
        id: `photo:${p.name}`,
        pos: position,
        pixelSize: 7,
        color: status,
        outlineColor: BLACK,
        outlineWidth: 1,
        meta: { type: 'photo', name: p.name },
      });
      // A short horizontal direction V at camera altitude, not a ground-coverage polygon.
      const dx = p.fwd?.[0],
        dy = p.fwd?.[1],
        length = Math.hypot(dx, dy);
      if (Number.isFinite(length) && length > 1e-6) {
        const ux = dx / length,
          uy = dy / length;
        const a = modelLatLon(
            state.meta.origin,
            p.x + ux * 10 - uy * 3,
            p.y + uy * 10 + ux * 3,
          ),
          b = modelLatLon(
            state.meta.origin,
            p.x + ux * 10 + uy * 3,
            p.y + uy * 10 - ux * 3,
          );
        lines.push({
          id: `direction:${p.name}`,
          positions: [
            fromDegrees(a.lon, a.lat, h),
            position,
            fromDegrees(b.lon, b.lat, h),
          ],
          widthPx: 2,
          mode: '3d',
          style: { kind: 'solid', color: status },
          meta: { type: 'direction', name: p.name },
        });
      }
    });
    // Yellow GPS-only markers are click-selectable for details, but they are
    // deliberately absent from projected/screenPoints so box and circle
    // selection can never hand an unplaced name to the server-backed keep set.
    // The click detail panel says they are not placed in this model.
    for (const p of gpsOnly)
      points.push({
        id: `photo:${p.name}`,
        pos: fromDegrees(p.lon, p.lat, heightOf(p.z)),
        pixelSize: 7,
        color: YELLOW,
        outlineColor: BLACK,
        outlineWidth: 1,
        meta: { type: 'photo', name: p.name, placed: false },
      });
    if (points.length) make('points', 'photo-coverage-cameras').set(points);
    if (lines.length) make('lines', 'photo-coverage-directions').set(lines);
    const ours = new Set([
      'photo-coverage-cells',
      'photo-coverage-footprints',
      'photo-coverage-cameras',
      'photo-coverage-directions',
    ]);
    offClick = input.onClick((event) => {
      const hit = event?.drawHit;
      if (!hit || !ours.has(hit.set)) return;
      const meta = hit.meta;
      if (meta?.type === 'coverage-cell')
        onPick({ type: 'cell', key: meta.key });
      else if (
        meta?.type === 'footprint' ||
        meta?.type === 'photo' ||
        meta?.type === 'direction'
      )
        onPick({ type: 'photo', name: meta.name });
    });
    return {
      screenPoints() {
        return projected
          .filter((p) => query.isOccluded(p.position) !== true)
          .map((p) => {
            const xy = query.project(p.position);
            return xy ? { name: p.name, x: xy.x, y: xy.y } : null;
          })
          .filter(Boolean);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
