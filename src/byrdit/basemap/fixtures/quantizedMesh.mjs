/**
 * Test helper (node:test only, never shipped): a minimal quantized-mesh-1.0
 * decoder and height sampler for the P6 alignment test (BASEMAP.md 6 P6
 * item 5). Format: https://github.com/CesiumGS/quantized-mesh (header,
 * zig-zag delta u/v/height, high-water-mark triangle indices). Extensions
 * after the index data (normals, water mask) are ignored.
 */

const QUANTIZED_MAX = 32767;

/** Bounds [west, south, east, north] (degrees) of a TMS geographic tile. */
export function geographicTileBounds({ z, x, y }) {
  const size = 180 / 2 ** z;
  const west = -180 + x * size;
  const south = -90 + y * size;
  return [west, south, west + size, south + size];
}

function zigZagDeltaDecode(view, offset, count) {
  const out = new Uint16Array(count);
  let value = 0;
  for (let i = 0; i < count; i++) {
    const encoded = view.getUint16(offset + i * 2, true);
    value += (encoded >> 1) ^ -(encoded & 1);
    out[i] = value;
  }
  return out;
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes  an uncompressed .terrain tile
 * @param {{z: number, x: number, y: number}} tile
 */
export function decodeQuantizedMesh(bytes, tile) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] === 0x1f && u8[1] === 0x8b)
    throw new Error('gzip-encoded tile: decompress first');
  const minimumHeight = view.getFloat32(24, true);
  const maximumHeight = view.getFloat32(28, true);
  let offset = 88;
  const vertexCount = view.getUint32(offset, true);
  offset += 4;
  const u = zigZagDeltaDecode(view, offset, vertexCount);
  offset += vertexCount * 2;
  const v = zigZagDeltaDecode(view, offset, vertexCount);
  offset += vertexCount * 2;
  const h = zigZagDeltaDecode(view, offset, vertexCount);
  offset += vertexCount * 2;
  const wide = vertexCount > 65536;
  const bytesPerIndex = wide ? 4 : 2;
  if (offset % bytesPerIndex)
    offset += bytesPerIndex - (offset % bytesPerIndex);
  const triangleCount = view.getUint32(offset, true);
  offset += 4;
  const indices = new Uint32Array(triangleCount * 3);
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = wide
      ? view.getUint32(offset + i * 4, true)
      : view.getUint16(offset + i * 2, true);
    indices[i] = highest - code;
    if (code === 0) highest += 1;
  }
  const [west, south, east, north] = geographicTileBounds(tile);
  return {
    tile,
    bounds: [west, south, east, north],
    minimumHeight,
    maximumHeight,
    vertexCount,
    triangleCount,
    u,
    v,
    h,
    indices,
  };
}

/**
 * Terrain height (m above the ellipsoid) at lon/lat by barycentric
 * interpolation in the mesh triangle that contains the point; NaN outside.
 */
export function sampleHeight(mesh, lon, lat) {
  const [west, south, east, north] = mesh.bounds;
  const pu = ((lon - west) / (east - west)) * QUANTIZED_MAX;
  const pv = ((lat - south) / (north - south)) * QUANTIZED_MAX;
  const { u, v, h, indices } = mesh;
  const range = mesh.maximumHeight - mesh.minimumHeight;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const det = (v[b] - v[c]) * (u[a] - u[c]) + (u[c] - u[b]) * (v[a] - v[c]);
    if (det === 0) continue;
    const l1 =
      ((v[b] - v[c]) * (pu - u[c]) + (u[c] - u[b]) * (pv - v[c])) / det;
    const l2 =
      ((v[c] - v[a]) * (pu - u[c]) + (u[a] - u[c]) * (pv - v[c])) / det;
    const l3 = 1 - l1 - l2;
    const eps = -1e-9;
    if (l1 < eps || l2 < eps || l3 < eps) continue;
    const q = l1 * h[a] + l2 * h[b] + l3 * h[c];
    return mesh.minimumHeight + (q / QUANTIZED_MAX) * range;
  }
  return Number.NaN;
}
