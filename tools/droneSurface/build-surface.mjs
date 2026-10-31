#!/usr/bin/env node
/**
 * Build a Drone Flight Plan surface file from a canopy-top raster (DSM) and a
 * bare-ground raster (DTM), both GeoTIFF float32 in the same UTM zone, as
 * written by PDAL from an OpenDroneMap point cloud. Offline: reads two files,
 * writes one file, runs nothing else.
 *
 *   node tools/droneSurface/build-surface.mjs \
 *     --dsm dsm.tif --dtm dtm.tif --id ranch-2026-10-30 \
 *     --name "Ranch 2026-10-30" --captured 2026-10-30 [--area ranch] \
 *     [--cell 1] [--out ~/gev-surfaces]
 *
 * --cell resamples to a coarser cell (max over the block for the top, so a
 * tree is never lost; mean for the ground). The top is the highest point in
 * the cell; holes in the DSM stay holes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGeoTiff } from './geotiff.mjs';
import { encodeSurface } from '../../src/byrdit/dronePlan/surfaceGrid.js';
import { lonLatToUtm, zoneCentralMeridian } from '../../src/byrdit/dronePlan/utm.js';

const isNo = (v, nd) => !Number.isFinite(v) || (nd != null && v === nd) || v < -9000;

/**
 * @returns {{ meta: object, top: Float32Array, ground: Float32Array }}
 */
export function buildSurface({ dsm, dtm, id, name, areaId, capturedAt, cellM, source, bounds }) {
  if (dsm.zone == null || dsm.zone !== dtm.zone) throw new Error('DSM and DTM need the same UTM zone');
  if (Math.abs(dsm.cellX - dsm.cellY) > 1e-9 * dsm.cellX) throw new Error('The DSM needs square pixels');
  const cell = dsm.cellX;
  const f = Math.max(1, Math.round((cellM ?? cell) / cell));
  const cols = Math.ceil(dsm.width / f);
  const rows = Math.ceil(dsm.height / f);
  const top = new Float32Array(cols * rows).fill(NaN);
  const ground = new Float32Array(cols * rows).fill(NaN);
  const gsum = new Float64Array(cols * rows);
  const gn = new Uint32Array(cols * rows);
  const holes = new Uint32Array(cols * rows);
  // The DTM may have another cell size and corner: read it by coordinate.
  const dtmAt = (e, n) => {
    const c = Math.floor((e - dtm.originE) / dtm.cellX);
    const r = Math.floor((dtm.originN - n) / dtm.cellY);
    if (c < 0 || c >= dtm.width || r < 0 || r >= dtm.height) return NaN;
    const v = dtm.data[r * dtm.width + c];
    return isNo(v, dtm.nodata) ? NaN : v;
  };
  for (let r = 0; r < dsm.height; r += 1) {
    for (let c = 0; c < dsm.width; c += 1) {
      const v = dsm.data[r * dsm.width + c];
      const o = Math.floor(r / f) * cols + Math.floor(c / f);
      if (isNo(v, dsm.nodata)) {
        holes[o] += 1;
        continue;
      }
      if (!(top[o] >= v)) top[o] = v;
      const g = dtmAt(dsm.originE + (c + 0.5) * dsm.cellX, dsm.originN - (r + 0.5) * dsm.cellY);
      if (g === g) {
        gsum[o] += g;
        gn[o] += 1;
      }
    }
  }
  for (let i = 0; i < ground.length; i += 1) {
    // A coarse cell with a hole in it is not fully seen: an unseen tree may
    // stand in the missing part, so it stays a hole (no verdict).
    if (holes[i]) {
      top[i] = NaN;
      ground[i] = NaN;
      continue;
    }
    if (gn[i]) ground[i] = gsum[i] / gn[i];
    // The top can never be under the bare ground it stands on.
    if (top[i] === top[i] && ground[i] === ground[i] && top[i] < ground[i]) top[i] = ground[i];
    if (top[i] === top[i] && !(ground[i] === ground[i])) top[i] = NaN; // no ground, no verdict
  }
  const meta = {
    id,
    name,
    areaId: areaId || id,
    capturedAt,
    source: source ?? 'odm-pdal',
    crs: { type: 'utm', zone: dsm.zone, north: dsm.north },
    originE: dsm.originE,
    originN: dsm.originN,
    cellM: cell * f,
    cols,
    rows,
    bounds,
  };
  return { meta, top, ground };
}

/** UTM -> lon/lat for the rectangle corners (inverse of utm.js, Newton). */
export function utmToLonLat(e, n, zone, north) {
  let lon = zoneCentralMeridian(zone) + (e - 500000) / 96000;
  let lat = (north ? n : n - 1e7) / 110900;
  for (let i = 0; i < 12; i += 1) {
    const p = lonLatToUtm(lon, lat, zone, north);
    const q = lonLatToUtm(lon + 1e-5, lat, zone, north);
    const s = lonLatToUtm(lon, lat + 1e-5, zone, north);
    const a = (q.e - p.e) / 1e-5;
    const b = (s.e - p.e) / 1e-5;
    const c = (q.n - p.n) / 1e-5;
    const d = (s.n - p.n) / 1e-5;
    const det = a * d - b * c;
    const de = e - p.e;
    const dn = n - p.n;
    lon += (de * d - b * dn) / det;
    lat += (a * dn - c * de) / det;
  }
  return { lon, lat };
}

export function boundsOf(dsm) {
  const w = dsm.originE;
  const ea = dsm.originE + dsm.width * dsm.cellX;
  const no = dsm.originN;
  const so = dsm.originN - dsm.height * dsm.cellY;
  const pts = [
    utmToLonLat(w, no, dsm.zone, dsm.north),
    utmToLonLat(ea, no, dsm.zone, dsm.north),
    utmToLonLat(w, so, dsm.zone, dsm.north),
    utmToLonLat(ea, so, dsm.zone, dsm.north),
  ];
  return {
    west: Math.min(...pts.map((p) => p.lon)),
    east: Math.max(...pts.map((p) => p.lon)),
    south: Math.min(...pts.map((p) => p.lat)),
    north: Math.max(...pts.map((p) => p.lat)),
  };
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['dsm', 'dtm', 'id', 'name', 'captured'])
    if (!opt[k]) throw new Error(`missing --${k}`);
  const dsm = readGeoTiff(readFileSync(resolve(opt.dsm)));
  const dtm = readGeoTiff(readFileSync(resolve(opt.dtm)));
  const { meta, top, ground } = buildSurface({
    dsm,
    dtm,
    id: opt.id,
    name: opt.name,
    areaId: opt.area,
    capturedAt: opt.captured,
    cellM: opt.cell ? Number(opt.cell) : undefined,
    bounds: boundsOf(dsm),
  });
  const out = resolve(opt.out ?? join(homedir(), 'gev-surfaces'));
  mkdirSync(out, { recursive: true });
  const file = join(out, `${meta.id}.gevsurf`);
  writeFileSync(file, Buffer.from(encodeSurface(meta, top, ground)));
  const have = top.reduce((n, v) => n + (v === v ? 1 : 0), 0);
  console.log(`wrote ${file}: ${meta.cols}x${meta.rows} cells of ${meta.cellM} m, ${have} with data`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`build-surface: ${error.message}`);
    process.exit(1);
  }
}
