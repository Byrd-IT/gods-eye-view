/**
 * Browser side of the surface API (server/byrdit/surfaces/api.js): list the
 * surface models, download the ones that cover the working area, and keep
 * them. `fetchImpl` is injectable for tests.
 */
import { parseSurface } from './surfaceGrid.js';

export const SURFACE_BASE = '/api/byrdit/surfaces';

export function createSurfaceClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  base = SURFACE_BASE,
} = {}) {
  const cache = new Map();
  async function get(path, kind) {
    if (!fetchImpl) throw new Error('offline');
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { credentials: 'same-origin' });
    } catch {
      throw new Error('offline');
    }
    if (!res.ok) throw new Error(res.status === 401 ? 'no-identity' : 'failed');
    return kind === 'json' ? res.json() : res.arrayBuffer();
  }
  return {
    /** Headers of every surface the person may use (newest first). */
    async list() {
      const body = await get('', 'json');
      return Array.isArray(body?.surfaces) ? body.surfaces : [];
    },
    /** A parsed grid; one download per id for the life of the page. */
    async load(id) {
      if (!cache.has(id)) {
        cache.set(
          id,
          get(`/${encodeURIComponent(id)}`, 'bin').then(parseSurface),
        );
        cache.get(id).catch(() => cache.delete(id));
      }
      return cache.get(id);
    },
    forget(id) {
      cache.delete(id);
    },
  };
}

/** True when a header's rectangle touches a lon/lat box. */
export function surfaceTouches(meta, box, padM = 0) {
  const b = meta?.bounds;
  if (!b || !box) return false;
  const pad = padM / 111320;
  const mid = ((box.south + box.north) / 2) * (Math.PI / 180);
  // A degree of longitude is shorter away from the equator.
  const padLon = pad / Math.max(0.05, Math.cos(mid));
  return !(
    b.east + padLon < box.west ||
    b.west - padLon > box.east ||
    b.north + pad < box.south ||
    b.south - pad > box.north
  );
}
