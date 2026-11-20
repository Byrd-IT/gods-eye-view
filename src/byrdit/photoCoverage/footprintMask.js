// Terrain cell-mask footprint adapted from t_99ee9981 reference; validate before deploy.
const FP_MAX_M=304.8;
const FP_MIN_COMP=4;
const LOS_MARGIN_M=1e-6;
function losTables(cov) {
  const C = cov.C, nx = C.nx;
  const present = new Uint8Array(nx * C.ny);
  const zh = new Float64Array(nx * C.ny).fill(NaN);
  C.k.forEach((k, jj) => { present[k] = 1; zh[k] = C.z[jj]; });
  return { present, zh, nx, ny: C.ny, cm: C.cell_m, x0: C.x0, y0: C.y0, ground: cov.ground };
}

// DDA the straight segment from camera plan position to (tx,ty); test each crossed column
// against the ray height where the ray crosses that column's height plane. Camera's own column
// and the target column are excluded. In-grid missing columns use model ground.
function losBlocked(T, p, tx, ty, tz) {
  const dx = tx - p.x, dy = ty - p.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 1e-9)) return false;
  const dzPer = (tz - p.z) / dist;              // ray z change per horizontal metre
  if (!(dzPer < 0)) return false;               // only a descending ray can dive into a column
  const cm = T.cm, nx = T.nx, ny = T.ny;
  let ix = Math.floor((p.x - T.x0) / cm), iy = Math.floor((p.y - T.y0) / cm);
  const ixStart=ix,iyStart=iy;
  const ixT = Math.floor((tx - T.x0) / cm), iyT = Math.floor((ty - T.y0) / cm);
  if (ix === ixT && iy === iyT) return false;   // target shares the camera's column
  const sx = dx / dist, sy = dy / dist;
  // distance to first vertical gridline in each axis
  let bx = sx > 0 ? (T.x0 + (ix + 1) * cm - p.x) / sx : sx < 0 ? (T.x0 + ix * cm - p.x) / sx : Infinity;
  let by = sy > 0 ? (T.y0 + (iy + 1) * cm - p.y) / sy : sy < 0 ? (T.y0 + iy * cm - p.y) / sy : Infinity;
  const stepx = sx > 0 ? cm / sx : sx < 0 ? -cm / sx : Infinity;
  const stepy = sy > 0 ? cm / sy : sy < 0 ? -cm / sy : Infinity;
  let dxs = sx > 0 ? 1 : -1, dys = sy > 0 ? 1 : -1;
  let s = 0;
  while (s < dist) {
    const sNext = Math.min(bx, by, dist);
    const span = sNext - s;
    if (span > 2 * LOS_MARGIN_M) {
      const k = iy * nx + ix;
      if ((ix !== ixT || iy !== iyT) && (ix !== ixStart || iy !== iyStart) && ix >= 0 && iy >= 0 && ix < nx && iy < ny) {
        // same height rule as cov-core cellZOf / terrainRay: present cell -> its height,
        // grid cell with no data -> flat ground_z (this is what stops sight leaking
        // across the sparse no-data interior); a camera sees only INTO present cells.
        const present = T.present[k], h = present ? T.zh[k] : T.ground;
        if (Number.isFinite(h)) {
          const sHit = (h - p.z) / dzPer;         // arclength where ray reaches column height
          if (sHit > s + LOS_MARGIN_M && sHit < sNext - LOS_MARGIN_M) return true;
        }
      }
    }
    s = sNext;
    if (bx <= by) { bx += stepx; ix += dxs; } else { by += stepy; iy += dys; }
    if (bx === Infinity && by === Infinity) break;
    if (ix === ixT && iy === iyT) break;          // stepped into the target column: nothing between
  }
  return false;
}

// cell mask of camera i: frustum-strict, range-capped, LOS-clear, target present
function maskOf(cov, i, T) {
  const p = cov.P[i];
  if (!p || !p.placed || ![p.fwd,p.right,p.down].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)) || ![p.x,p.y,p.z,p.hfov,p.vfov].every(Number.isFinite) || p.hfov<=0 || p.hfov>=180 || p.vfov<=0 || p.vfov>=180) return null;
  if ((p.flags || []).includes('far_off')) return null;
  if (Math.abs(p.x) > 2000 || Math.abs(p.y) > 2000) return null;
  const tx = Math.tan(p.hfov * Math.PI / 360), ty = Math.tan(p.vfov * Math.PI / 360);
  const f = p.fwd, r = p.right, d = p.down;
  const ks = [], zs = [];
  const K = cov.C.k, nx = T.nx, ny = T.ny, cm = T.cm;
  for (let q = 0; q < K.length; q++) {
    const k = K[q], j = Math.floor(k / nx), ci = k % nx;
    const x = T.x0 + (ci + 0.5) * cm, y = T.y0 + (j + 0.5) * cm, z = cov.C.z[q];
    const wx = x - p.x, wy = y - p.y, wz = z - p.z;
    const dist = Math.hypot(wx, wy);
    if (dist > FP_MAX_M) continue;
    const xc = wx * f[0] + wy * f[1] + wz * f[2];
    if (!(xc > 0)) continue;
    const yc = wx * r[0] + wy * r[1] + wz * r[2];
    const zc = wx * d[0] + wy * d[1] + wz * d[2];
    if (!(Math.abs(yc) < tx * xc && Math.abs(zc) < ty * xc)) continue;
    if (losBlocked(T, p, x, y, z)) continue;
    ks.push(k); zs.push(j * nx + ci);
  }
  return ks.length ? { ks, n: ks.length, areaM2: ks.length * cm * cm } : null;
}

function bigComponents(ks, nx, ny, min = FP_MIN_COMP) {
  const set = new Set(ks), seen = new Set(), big = [];
  for (const k of set) {
    if (seen.has(k)) continue;
    const q = [k], comp = [];
    seen.add(k);
    while (q.length) {
      const c = q.pop(); comp.push(c);
      const j = Math.floor(c / nx), i = c % nx;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = (j + a) * nx + (i + b);
        if (i + b >= 0 && i + b < nx && j + a >= 0 && j + a < ny && set.has(n) && !seen.has(n)) { seen.add(n); q.push(n); }
      }
    }
    if (comp.length >= min) big.push(...comp);
  }
  return big.length ? big : null;
}


export function footprintMask(state, index) {
  const cov={C:state.cells,P:state.photos,ground:state.meta.ground_z};
  const table=losTables(cov), m=maskOf(cov,index,table);
  if (!m) return [];
  return bigComponents(m.ks,table.nx,table.ny) ?? [];
}
