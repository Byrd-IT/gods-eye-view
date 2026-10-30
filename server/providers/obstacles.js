import { inflateSync } from 'node:zlib';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

/**
 * Open-data obstacle estimates for the Drone Flight Plan (keyless, read-only):
 *
 *   GET /api/obstacles/faa?west=&south=&east=&north=
 *       FAA Digital Obstacle File: towers, masts, poles, stacks with their
 *       height above ground (feet in the file, metres here).
 *   GET /api/obstacles/canopy?west=&south=&east=&north=
 *       Tree-patch heights from the Meta and WRI 1 m canopy height model
 *       (CC BY 4.0). Read with a few HTTP range requests into a cloud
 *       GeoTIFF, never the whole file. The model is trained on airborne
 *       lidar; it is an estimate, not a survey.
 *
 * Google imagery is never used here: its terms forbid measuring it in code.
 */

const FAA_URL =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/' +
  'Digital_Obstacle_File/FeatureServer/0/query';
const CANOPY_BASE =
  'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/' +
  'alsgedi_global_v6_float/chm/';
const TILE_ZOOM = 9;
const FEET_M = 0.3048;
/** Widest box one request may ask for, degrees (about 5 km at mid-latitudes). */
export const MAX_SPAN_DEG = 0.05;
export const GRID = 12;
export const SUB_ROWS = 2;
const MAX_CANOPY_RESULTS = 40;
const MAX_FAA_RESULTS = 60;
const MIN_TREE_M = 3;
const MAX_TREE_M = 100;
const MIN_COVERAGE = 0.25;
const MIB = 1024 * 1024;
/** Largest tile side accepted; the real tiles are 65536. */
const MAX_TIFF_SIDE = 131072;
const TILE_CACHE_MAX = 4;
const RESULT_TTL_MS = 600_000;

const num = (v) => (v === null || v === '' ? NaN : Number(v));

/** Validate and read the box from the query; null when unusable. */
export function parseBox(params) {
  const west = num(params.get('west'));
  const south = num(params.get('south'));
  const east = num(params.get('east'));
  const north = num(params.get('north'));
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (south < -85 || north > 85 || west < -180 || east > 180) return null;
  if (!(east > west) || !(north > south)) return null;
  if (east - west > MAX_SPAN_DEG || north - south > MAX_SPAN_DEG) return null;
  return { west, south, east, north };
}

/** FAA Type_Code to a plan kind. */
function faaKind(code) {
  return /^BLDG/.test(code) ? 'building' : 'tower';
}

/**
 * Rows of the FAA ArcGIS answer as obstacles. Feet become metres. Rows with
 * no position or no usable height are dropped.
 */
export function parseFaaPayload(payload) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(payload?.features) ? payload.features : []) {
    const a = f?.attributes ?? {};
    const x = Number(f?.geometry?.x);
    const y = Number(f?.geometry?.y);
    const agl = Number(a.AGL);
    const oas = String(a.OAS_Number ?? '').trim();
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!Number.isFinite(agl) || agl <= 0 || !/^[\w-]{1,20}$/.test(oas))
      continue;
    if (seen.has(oas)) continue;
    seen.add(oas);
    const code = String(a.Type_Code ?? '')
      .trim()
      .toUpperCase();
    out.push({
      id: `faa-${oas}`,
      kind: faaKind(code),
      source: 'faa',
      lon: x,
      lat: y,
      radiusM: 6,
      estimatedHeightM: Math.round(agl * FEET_M * 10) / 10,
      heightM: Math.round(agl * FEET_M * 10) / 10,
      note: code.slice(0, 20),
    });
    if (out.length >= MAX_FAA_RESULTS) break;
  }
  return out;
}

// ------------------------------------------------------------ canopy --

const mercX = (lon) => (lon * 20037508.342789244) / 180;
const mercY = (lat) =>
  Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137;

/** The Bing-style quadkey of the 1:512 tile holding (lon, lat). */
export function quadkey(lon, lat, z = TILE_ZOOM) {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const rad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(
      0,
      Math.floor(
        ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
      ),
    ),
  );
  let q = '';
  for (let i = z; i > 0; i -= 1) {
    const mask = 1 << (i - 1);
    q += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return q;
}

/**
 * Read the few tags a one-row-per-strip, 8-bit, deflate + horizontal
 * predictor BigTIFF needs from its first bytes. Anything else is refused,
 * so a changed file layout fails closed instead of producing wrong heights.
 */
export function parseTiffHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 24 || dv.getUint16(0, true) !== 0x4949)
    throw new Error('unsupported_tiff');
  if (dv.getUint16(2, true) !== 43) throw new Error('unsupported_tiff');
  const ifd = Number(dv.getBigUint64(8, true));
  if (ifd + 8 > buf.byteLength) throw new Error('unsupported_tiff');
  const n = Number(dv.getBigUint64(ifd, true));
  const tags = new Map();
  for (let i = 0; i < n && i < 64; i += 1) {
    const at = ifd + 8 + i * 20;
    if (at + 20 > buf.byteLength) throw new Error('unsupported_tiff');
    tags.set(dv.getUint16(at, true), {
      type: dv.getUint16(at + 2, true),
      count: Number(dv.getBigUint64(at + 4, true)),
      at: at + 12,
    });
  }
  const scalar = (tag) => {
    const t = tags.get(tag);
    if (!t) return undefined;
    if (t.type === 3) return dv.getUint16(t.at, true);
    if (t.type === 4) return dv.getUint32(t.at, true);
    if (t.type === 16) return Number(dv.getBigUint64(t.at, true));
    return undefined;
  };
  const pointer = (tag) => {
    const t = tags.get(tag);
    return t ? Number(dv.getBigUint64(t.at, true)) : undefined;
  };
  const width = scalar(256);
  const height = scalar(257);
  if (
    !(width <= MAX_TIFF_SIDE) ||
    !(height <= MAX_TIFF_SIDE) ||
    scalar(258) !== 8 ||
    scalar(259) !== 8 ||
    scalar(277) !== 1 ||
    scalar(278) !== 1 ||
    scalar(317) !== 2 ||
    scalar(339) !== 1 ||
    !(width > 0) ||
    !(height > 0) ||
    tags.get(273)?.count !== height ||
    tags.get(279)?.count !== height
  ) {
    throw new Error('unsupported_tiff');
  }
  return {
    width,
    height,
    stripOffsets: pointer(273),
    stripBytes: pointer(279),
    scaleAt: pointer(33550),
    tiepointAt: pointer(33922),
  };
}

/** Undo the horizontal predictor on 8-bit samples, in place. */
export function undoPredictor(row) {
  let acc = 0;
  for (let i = 0; i < row.length; i += 1) {
    acc = (acc + row[i]) & 255;
    row[i] = acc;
  }
  return row;
}

/** Inflate and un-predict one strip (one image row). */
export function decodeRow(compressed, width) {
  const row = Uint8Array.from(inflateSync(compressed));
  if (row.length !== width) throw new Error('bad_row');
  return undoPredictor(row);
}

/**
 * Turn sampled rows into tree-patch obstacles. `rows` is a list of
 * { cellRow, samples: [{ cellCol, value }] } where value is the canopy
 * height in metres at that pixel. A cell is a patch when enough of its
 * pixels are tall enough; its height is the 90th percentile of those.
 */
export function summarizeCells(rows, box, grid = GRID) {
  const cells = new Map();
  for (const row of rows) {
    for (const s of row.samples) {
      const key = row.cellRow * grid + s.cellCol;
      const c = cells.get(key) ?? { total: 0, trees: [] };
      c.total += 1;
      if (s.value >= MIN_TREE_M && s.value <= MAX_TREE_M) c.trees.push(s.value);
      cells.set(key, c);
    }
  }
  const dLon = (box.east - box.west) / grid;
  const dLat = (box.north - box.south) / grid;
  const midLat = (box.north + box.south) / 2;
  const cellM = Math.min(
    dLon * 111320 * Math.cos((midLat * Math.PI) / 180),
    dLat * 110574,
  );
  const out = [];
  for (const [key, c] of cells) {
    if (!c.total || c.trees.length / c.total < MIN_COVERAGE) continue;
    c.trees.sort((a, b) => a - b);
    const h =
      c.trees[Math.min(c.trees.length - 1, Math.floor(c.trees.length * 0.9))];
    const r = Math.floor(key / grid);
    const col = key % grid;
    out.push({
      id: `chm-${r}-${col}-${Math.round(box.west * 1e4)}-${Math.round(box.south * 1e4)}`,
      kind: 'tree',
      source: 'canopy',
      lon: Math.round((box.west + (col + 0.5) * dLon) * 1e6) / 1e6,
      lat: Math.round((box.south + (r + 0.5) * dLat) * 1e6) / 1e6,
      radiusM: Math.max(3, Math.min(150, Math.round(cellM / 2))),
      estimatedHeightM: h,
      heightM: h,
      coverage: Math.round((c.trees.length / c.total) * 100) / 100,
    });
  }
  out.sort(
    (a, b) =>
      b.estimatedHeightM * b.coverage - a.estimatedHeightM * a.coverage ||
      a.id.localeCompare(b.id),
  );
  return out.slice(0, MAX_CANOPY_RESULTS);
}

/** Fixed-origin FAA and canopy routes for dev and preview. */
export function obstaclesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  const results = new Map();
  const inFlight = new Map();
  const tiles = new Map();

  async function ranged(url, start, end, cap, timeout = 20_000) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal,
      redirect: 'error',
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseBytesCapped(response, cap, signal);
  }

  /** The header of one canopy tile (a few KB), cached for a few tiles. */
  async function loadTile(key) {
    const hit = tiles.get(key);
    if (hit) {
      tiles.delete(key);
      tiles.set(key, hit);
      return hit;
    }
    const url = `${CANOPY_BASE}${key}.tif`;
    const pending = (async () => {
      const head = await ranged(url, 0, 4095, 8192);
      const info = parseTiffHeader(head);
      const [scale, tie] = await Promise.all([
        ranged(url, info.scaleAt, info.scaleAt + 23, 64),
        ranged(url, info.tiepointAt, info.tiepointAt + 47, 128),
      ]);
      const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
      return {
        url,
        width: info.width,
        height: info.height,
        offsetsAt: info.stripOffsets,
        countsAt: info.stripBytes,
        res: view(scale).getFloat64(0, true),
        x0: view(tie).getFloat64(24, true),
        y0: view(tie).getFloat64(32, true),
      };
    })();
    tiles.set(key, pending);
    if (tiles.size > TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      if (tiles.get(key) === pending) tiles.delete(key);
      throw error;
    }
  }

  /** The strip tables for rows first..last only (8 bytes a row each). */
  async function loadRowTables(tile, first, last) {
    const bytes = (last - first + 1) * 8;
    const [offs, counts] = await Promise.all([
      ranged(
        tile.url,
        tile.offsetsAt + first * 8,
        tile.offsetsAt + first * 8 + bytes - 1,
        bytes + 16,
      ),
      ranged(
        tile.url,
        tile.countsAt + first * 8,
        tile.countsAt + first * 8 + bytes - 1,
        bytes + 16,
      ),
    ]);
    const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { first, offs: view(offs), counts: view(counts) };
  }

  async function readRow(tile, tables, row) {
    const at = (row - tables.first) * 8;
    const off = Number(tables.offs.getBigUint64(at, true));
    const len = Number(tables.counts.getBigUint64(at, true));
    if (!(len > 0) || len > 4 * MIB) throw new Error('bad_row');
    const bytes = await ranged(tile.url, off, off + len - 1, len + 16);
    return decodeRow(bytes, tile.width);
  }

  async function loadCanopy(box) {
    const dLon = (box.east - box.west) / GRID;
    const dLat = (box.north - box.south) / GRID;
    const tile = await loadTile(
      quadkey((box.west + box.east) / 2, (box.north + box.south) / 2),
    );
    const rowOf = (lat) => Math.round((tile.y0 - mercY(lat)) / tile.res - 0.5);
    const colOf = (lon) => Math.floor((mercX(lon) - tile.x0) / tile.res);
    // A box that sticks out of the tile is only partly read: say so.
    const inside =
      rowOf(box.north) >= 0 &&
      rowOf(box.south) < tile.height &&
      colOf(box.west) >= 0 &&
      colOf(box.east) < tile.width;
    const jobs = [];
    for (let r = 0; r < GRID; r += 1) {
      for (let s = 0; s < SUB_ROWS; s += 1) {
        const row = rowOf(box.south + (r + (s + 0.5) / SUB_ROWS) * dLat);
        if (row >= 0 && row < tile.height) jobs.push({ r, row });
      }
    }
    if (!jobs.length) throw new Error('canopy_unavailable');
    const tables = await loadRowTables(
      tile,
      Math.min(...jobs.map((j) => j.row)),
      Math.max(...jobs.map((j) => j.row)),
    );
    const rows = [];
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const data = await readRow(tile, tables, job.row);
          const samples = [];
          for (let c = 0; c < GRID; c += 1) {
            const a = colOf(box.west + c * dLon);
            const b = Math.ceil(
              (mercX(box.west + (c + 1) * dLon) - tile.x0) / tile.res,
            );
            for (
              let col = Math.max(0, a);
              col < Math.min(tile.width, b);
              col += 1
            ) {
              samples.push({ cellCol: c, value: data[col] });
            }
          }
          rows.push({ cellRow: job.r, samples });
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    // Mostly failed: say so rather than reporting "no trees here".
    if (rows.length < jobs.length / 2) throw new Error('canopy_unavailable');
    return {
      obstacles: summarizeCells(rows, box),
      partial: failed > 0 || !inside,
    };
  }

  async function loadFaa(box) {
    const url =
      `${FAA_URL}?` +
      new URLSearchParams({
        geometry: `${box.west},${box.south},${box.east},${box.north}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OAS_Number,Type_Code,AGL',
        returnGeometry: 'true',
        outSR: '4326',
        resultRecordCount: '200',
        f: 'json',
      });
    const signal = AbortSignal.timeout(20_000);
    const response = await fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(response, 2 * MIB, signal);
    if (payload?.error || !Array.isArray(payload?.features))
      throw new Error('invalid_payload');
    return { obstacles: parseFaaPayload(payload), partial: false };
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const [path, query = ''] = (req.url || '/').split('?');
    const kind = path === '/faa' ? 'faa' : path === '/canopy' ? 'canopy' : null;
    if (!kind) return json(404, { error: 'unknown_route' });
    const box = parseBox(new URLSearchParams(query));
    if (!box) return json(400, { error: 'invalid_box' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const key = [
      kind,
      ...[box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)),
    ].join(':');
    const cached = results.get(key);
    if (cached && now() - cached.savedAt < RESULT_TTL_MS)
      return json(200, cached.value);
    if (!inFlight.has(key) && inFlight.size >= 32)
      return json(429, { error: 'busy' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, () =>
        kind === 'faa' ? loadFaa(box) : loadCanopy(box),
      );
      const value = { source: kind, ...(await promise) };
      if (!value.partial) {
        results.delete(key);
        results.set(key, { value, savedAt: now() });
        if (results.size > 64) results.delete(results.keys().next().value);
      }
      json(200, value);
    } catch {
      json(502, { error: 'obstacles_unavailable', source: kind });
    }
  }

  return {
    name: 'obstacles',
    configureServer({ middlewares }) {
      middlewares.use('/api/obstacles', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/obstacles', handler);
    },
  };
}
