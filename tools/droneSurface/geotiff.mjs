/**
 * Minimal GeoTIFF reader for the rasters PDAL writes (uncompressed,
 * float32, one band, striped or tiled). Reads only what the surface builder
 * needs: size, pixel size, top-left corner and the UTM zone from the GeoKeys.
 * Anything else (compression, other types, rotated grids) is refused.
 */
const TAG = {
  width: 256,
  height: 257,
  bits: 258,
  compression: 259,
  stripOffsets: 273,
  samples: 277,
  rowsPerStrip: 278,
  stripBytes: 279,
  tileW: 322,
  tileH: 323,
  tileOffsets: 324,
  tileBytes: 325,
  sampleFormat: 339,
  pixelScale: 33550,
  tiepoint: 33922,
  geoKeys: 34735,
  nodata: 42113,
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };

/** @param {Buffer|Uint8Array} bytes */
export function readGeoTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = dv.getUint16(0, false) === 0x4949;
  if (!le && dv.getUint16(0, false) !== 0x4d4d) throw new Error('not a TIFF');
  if (dv.getUint16(2, le) !== 42) throw new Error('BigTIFF is not supported');
  const ifd = dv.getUint32(4, le);
  const count = dv.getUint16(ifd, le);
  const tags = {};
  for (let i = 0; i < count; i += 1) {
    const at = ifd + 2 + i * 12;
    const tag = dv.getUint16(at, le);
    const type = dv.getUint16(at + 2, le);
    const n = dv.getUint32(at + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const base = size <= 4 ? at + 8 : dv.getUint32(at + 8, le);
    if (base + size > bytes.byteLength) throw new Error('bad TIFF tag');
    const vals = [];
    for (let k = 0; k < n; k += 1) {
      const o = base + k * (TYPE_SIZE[type] ?? 1);
      if (type === 3) vals.push(dv.getUint16(o, le));
      else if (type === 4) vals.push(dv.getUint32(o, le));
      else if (type === 12) vals.push(dv.getFloat64(o, le));
      else if (type === 11) vals.push(dv.getFloat32(o, le));
      else if (type === 1) vals.push(dv.getUint8(o));
      else if (type === 2) vals.push(dv.getUint8(o));
    }
    tags[tag] = type === 2 ? String.fromCharCode(...vals).replace(/\0.*$/, '') : vals;
  }
  const one = (t) => tags[t]?.[0];
  const width = one(TAG.width);
  const height = one(TAG.height);
  if (one(TAG.compression) !== 1) throw new Error('compressed TIFF');
  if (one(TAG.bits) !== 32 || one(TAG.sampleFormat) !== 3)
    throw new Error('expected float32');
  if ((one(TAG.samples) ?? 1) !== 1) throw new Error('expected one band');
  if (!tags[TAG.pixelScale] || !tags[TAG.tiepoint]) throw new Error('not georeferenced');
  const [sx, sy] = tags[TAG.pixelScale];
  const [, , , tx, ty] = tags[TAG.tiepoint];
  const data = new Float32Array(width * height);
  const put = (rowOff, colOff, w, h, srcOff, rowBytes) => {
    for (let r = 0; r < h; r += 1) {
      const row = rowOff + r;
      if (row >= height) break;
      for (let c = 0; c < w; c += 1) {
        const col = colOff + c;
        if (col >= width) break;
        data[row * width + col] = dv.getFloat32(srcOff + r * rowBytes + c * 4, le);
      }
    }
  };
  if (tags[TAG.tileOffsets]) {
    const tw = one(TAG.tileW);
    const th = one(TAG.tileH);
    const across = Math.ceil(width / tw);
    tags[TAG.tileOffsets].forEach((off, i) => {
      put(Math.floor(i / across) * th, (i % across) * tw, tw, th, off, tw * 4);
    });
  } else {
    const rps = one(TAG.rowsPerStrip) ?? height;
    tags[TAG.stripOffsets].forEach((off, i) => {
      put(i * rps, 0, width, Math.min(rps, height - i * rps), off, width * 4);
    });
  }
  // GeoKeys: ProjectedCSTypeGeoKey (3072) EPSG 326zz (north) or 327zz (south).
  let zone = null;
  let north = true;
  const gk = tags[TAG.geoKeys];
  if (gk) {
    for (let i = 0; i < gk[3]; i += 1) {
      const key = gk[4 + i * 4];
      const val = gk[7 + i * 4];
      if (key === 3072 && val >= 32601 && val <= 32660) zone = val - 32600;
      if (key === 3072 && val >= 32701 && val <= 32760) {
        zone = val - 32700;
        north = false;
      }
    }
  }
  const nd = tags[TAG.nodata] ? Number(tags[TAG.nodata]) : null;
  return {
    width,
    height,
    cellX: sx,
    cellY: sy,
    originE: tx,
    originN: ty,
    zone,
    north,
    nodata: Number.isFinite(nd) ? nd : null,
    data,
  };
}
