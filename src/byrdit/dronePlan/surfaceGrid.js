/**
 * A surface model: a regular grid of the height of everything standing on
 * the ground (canopy, roofs, poles) and of the bare ground under it, built
 * from a photogrammetry point cloud (OpenDroneMap) by
 * tools/droneSurface/build-surface.mjs.
 *
 * The model is a PHOTO model: it does not reliably show bare branches,
 * single limbs, power lines or guy wires, and trees change with the season.
 * It is a warning aid, never a clearance guarantee.
 *
 * File layout (little endian):
 *   8 bytes  magic "GEVSURF1"
 *   4 bytes  uint32 length of the JSON header in bytes
 *   n bytes  JSON header (UTF-8), zero padded to a multiple of 4
 *   cols*rows float32  top    (m, surface height; NaN = no data)
 *   cols*rows float32  ground (m, bare ground height; NaN = unknown)
 * Rows run north to south, columns west to east. Heights share one vertical
 * reference inside a file; only differences inside one file are ever used.
 */
import { lonLatToUtm } from './utm.js';

export const SURFACE_MAGIC = 'GEVSURF1';
export const MAX_SURFACE_CELLS = 40_000_000;
/** Cells per side of a block in the max pyramid. */
export const BLOCK = 8;

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const isSurfaceId = (v) => typeof v === 'string' && ID.test(v);

const finiteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Check and trim the JSON header. Returns the clean header or throws. */
export function cleanSurfaceMeta(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('bad-header');
  const m = raw;
  if (!isSurfaceId(m.id)) throw new Error('bad-id');
  const zone = Number(m.crs?.zone);
  if (!Number.isInteger(zone) || zone < 1 || zone > 60)
    throw new Error('bad-crs');
  const cols = Number(m.cols);
  const rows = Number(m.rows);
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 2 ||
    cols * rows > MAX_SURFACE_CELLS
  )
    throw new Error('bad-size');
  const cellM = Number(m.cellM);
  if (!(cellM >= 0.05 && cellM <= 10)) throw new Error('bad-cell');
  if (!finiteNum(Number(m.originE)) || !finiteNum(Number(m.originN)))
    throw new Error('bad-origin');
  const captured = Date.parse(m.capturedAt);
  return {
    id: m.id,
    name: String(m.name ?? m.id).slice(0, 120),
    areaId: isSurfaceId(m.areaId) ? m.areaId : m.id,
    capturedAt: Number.isFinite(captured)
      ? new Date(captured).toISOString()
      : null,
    source: String(m.source ?? '').slice(0, 60),
    crs: { type: 'utm', zone, north: m.crs?.north !== false },
    originE: Number(m.originE),
    originN: Number(m.originN),
    cellM,
    cols,
    rows,
    bounds: m.bounds
      ? {
          west: Number(m.bounds.west),
          south: Number(m.bounds.south),
          east: Number(m.bounds.east),
          north: Number(m.bounds.north),
        }
      : null,
  };
}

/** Pack a surface into the file layout. */
export function encodeSurface(meta, top, ground) {
  const clean = cleanSurfaceMeta(meta);
  const n = clean.cols * clean.rows;
  if (top.length !== n || ground.length !== n) throw new Error('bad-size');
  const json = new TextEncoder().encode(JSON.stringify(clean));
  const padded = Math.ceil(json.length / 4) * 4;
  const out = new ArrayBuffer(12 + padded + n * 8);
  new Uint8Array(out, 0, 8).set(new TextEncoder().encode(SURFACE_MAGIC));
  new DataView(out).setUint32(8, padded, true);
  new Uint8Array(out, 12, json.length).set(json);
  new Float32Array(out, 12 + padded, n).set(top);
  new Float32Array(out, 12 + padded + n * 4, n).set(ground);
  return out;
}

/** Read the JSON header only (for the list), or throw. */
export function decodeSurfaceHeader(buf) {
  const bytes = new Uint8Array(buf);
  if (
    bytes.length < 12 ||
    new TextDecoder().decode(bytes.subarray(0, 8)) !== SURFACE_MAGIC
  )
    throw new Error('bad-magic');
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  if (len > 65536 || 12 + len > bytes.length) throw new Error('bad-header');
  let raw;
  try {
    raw = JSON.parse(
      new TextDecoder()
        .decode(bytes.subarray(12, 12 + len))
        .replace(/\0+$/, ''),
    );
  } catch {
    throw new Error('bad-header');
  }
  return { meta: cleanSurfaceMeta(raw), dataOffset: 12 + len };
}

/**
 * Parse a whole surface file.
 * @param {ArrayBuffer} buf
 */
export function parseSurface(buf) {
  const { meta, dataOffset } = decodeSurfaceHeader(buf);
  const n = meta.cols * meta.rows;
  if (buf.byteLength < dataOffset + n * 8) throw new Error('truncated');
  const top = new Float32Array(buf.slice(dataOffset, dataOffset + n * 4));
  const ground = new Float32Array(
    buf.slice(dataOffset + n * 4, dataOffset + n * 8),
  );
  return createSurfaceGrid(meta, top, ground);
}

/**
 * @param {ReturnType<typeof cleanSurfaceMeta>} meta
 * @param {Float32Array} top
 * @param {Float32Array} ground
 */
export function createSurfaceGrid(meta, top, ground) {
  const { cols, rows, cellM } = meta;
  const bw = Math.ceil(cols / BLOCK);
  const bh = Math.ceil(rows / BLOCK);
  // Highest top per block: lets a search skip a whole block that is too low
  // to matter. NaN cells are ignored; an all-NaN block stays -Infinity.
  const blockMax = new Float32Array(bw * bh).fill(-Infinity);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = top[r * cols + c];
      if (v === v) {
        const b = Math.floor(r / BLOCK) * bw + Math.floor(c / BLOCK);
        if (v > blockMax[b]) blockMax[b] = v;
      }
    }
  }
  return {
    meta,
    id: meta.id,
    cols,
    rows,
    cellM,
    top,
    ground,
    blockMax,
    bw,
    bh,
    /** Cell centre in UTM metres. */
    cellEN(c, r) {
      return {
        e: meta.originE + (c + 0.5) * cellM,
        n: meta.originN - (r + 0.5) * cellM,
      };
    },
    /** Column/row (fractional) holding a UTM point. */
    colRowOf(e, n) {
      return {
        c: (e - meta.originE) / cellM - 0.5,
        r: (meta.originN - n) / cellM - 0.5,
      };
    },
    /** Top at an integer cell, or NaN outside. */
    topAtCell(c, r) {
      return c >= 0 && c < cols && r >= 0 && r < rows ? top[r * cols + c] : NaN;
    },
    groundAtCell(c, r) {
      return c >= 0 && c < cols && r >= 0 && r < rows
        ? ground[r * cols + c]
        : NaN;
    },
  };
}

/**
 * A grid seen from one local frame (x east, y north, metres, from lon0/lat0).
 * The grid's UTM axes are rotated a little against true north (grid
 * convergence); the affine map below carries that rotation, so a local metre
 * is a metre on every grid, whatever its zone.
 */
export function gridInFrame(grid, lon0, lat0, metersPerDeg) {
  const z = grid.meta.crs.zone;
  const north = grid.meta.crs.north;
  const o = lonLatToUtm(lon0, lat0, z, north);
  const dE = 100 / metersPerDeg.lon;
  const dN = 100 / metersPerDeg.lat;
  const pe = lonLatToUtm(lon0 + dE, lat0, z, north);
  const pn = lonLatToUtm(lon0, lat0 + dN, z, north);
  // UTM metres per local metre along x (east) and y (north).
  const exx = (pe.e - o.e) / 100;
  const exy = (pe.n - o.n) / 100;
  const eyx = (pn.e - o.e) / 100;
  const eyy = (pn.n - o.n) / 100;
  const det = exx * eyy - eyx * exy;
  return {
    grid,
    /** Fractional column/row of a local point. */
    colRow(x, y) {
      const e = o.e + exx * x + eyx * y;
      const n = o.n + exy * x + eyy * y;
      return grid.colRowOf(e, n);
    },
    /** Local x/y of a cell centre. */
    local(c, r) {
      const { e, n } = grid.cellEN(c, r);
      const de = e - o.e;
      const dn = n - o.n;
      return {
        x: (de * eyy - eyx * dn) / det,
        y: (exx * dn - exy * de) / det,
      };
    },
    /** The metric size of a cell in local metres (grids are near-isometric). */
    scale: Math.sqrt(Math.abs(det)),
  };
}
