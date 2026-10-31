/**
 * Clearance maths against a surface model (see surfaceGrid.js). Pure
 * functions: no Cesium, no DOM, no network.
 *
 * Distance to the surface. The model is a set of solid columns: each cell
 * stands from the ground up to its `top`. For a drone at height z over a cell
 * `dh` metres away sideways, the closest point of that column is
 *   hypot(dh, max(0, z - top))
 * (above the column: straight down to its top; beside it: sideways). The
 * clearance of a position is the smallest such distance over all cells. A cell
 * is treated as its whole footprint, so `dh` is reduced by half a cell.
 *
 * Heights. A drone at `aglM` above ground stands at ground(p) + aglM in the
 * surface's own vertical reference, with ground(p) taken from the surface
 * itself; the surface never has to agree with the globe's terrain model.
 *
 * WARN ONLY. Nothing here moves a route. The model does not reliably show bare
 * branches, single limbs, power lines or guy wires, and trees change with
 * the season, so a pass is not a guarantee.
 */
import { metersPerDegree } from './geo.js';
import { BLOCK, gridInFrame } from './surfaceGrid.js';

/** Spacing of the checks along a leg, metres. */
export const CLEARANCE_STEP_M = 1;
/** Most samples one check takes; a longer route is sampled more coarsely. */
export const MAX_CLEARANCE_SAMPLES = 60000;
/** Most violation spans that are kept in the result (the count is exact). */
export const MAX_SPANS = 200;
/** Spacing of the points a ring or path floor is read at, metres. */
const PROBE_SPACING_M = 1.5;
/** Point caps; the real spacing of a capped ring or segment is used. */
const MAX_RING_POINTS = 2000;
const MAX_SEGMENT_POINTS = 2000;
/** How far a missing ground cell is looked for around a point, metres. */
const GROUND_SEARCH_M = 4;
/** Most lattice steps from the centre to the edge when looking for holes. */
const UNKNOWN_LATTICE_MAX = 24;

const newestFirst = (a, b) => {
  const ta = a.meta.capturedAt ? Date.parse(a.meta.capturedAt) : -Infinity;
  const tb = b.meta.capturedAt ? Date.parse(b.meta.capturedAt) : -Infinity;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : 1;
};

/**
 * One surface set: several grids (later areas) with the newest one winning
 * wherever it has data, so a newer ODM run replaces an older one for the same
 * ground and an older one still covers what the newer one does not reach.
 * @param {ReturnType<import('./surfaceGrid.js').createSurfaceGrid>[]} grids
 */
export function createSurfaceModel(grids) {
  const list = [...(grids ?? [])].sort(newestFirst);
  return {
    grids: list,
    ids: list.map((g) => g.id),
    /** True when the lon/lat falls inside any grid's rectangle. */
    mayCover(lon, lat, padM = 0) {
      return list.some((g) => {
        const b = g.meta.bounds;
        if (!b) return true;
        const m = metersPerDegree(lat);
        const padLon = padM / m.lon;
        const padLat = padM / m.lat;
        return (
          lon >= b.west - padLon &&
          lon <= b.east + padLon &&
          lat >= b.south - padLat &&
          lat <= b.north + padLat
        );
      });
    },
    /** A view in the local metre frame around (lon0, lat0). */
    view(lon0, lat0) {
      return createSurfaceView(list, lon0, lat0);
    },
  };
}

function createSurfaceView(grids, lon0, lat0) {
  const mpd = metersPerDegree(lat0);
  const frames = grids.map((g) => gridInFrame(g, lon0, lat0, mpd));

  const nearestTop = (i, x, y) => {
    const g = grids[i];
    const { c, r } = frames[i].colRow(x, y);
    return g.topAtCell(Math.round(c), Math.round(r));
  };
  /** Index of the newest grid with data at a local point, or -1. */
  const ownerAt = (x, y) => {
    for (let i = 0; i < grids.length; i += 1) {
      const t = nearestTop(i, x, y);
      if (t === t) return i;
    }
    return -1;
  };
  /** Ground of grid i around a local point, looking a little way out. */
  const groundIn = (i, x, y) => {
    const g = grids[i];
    const { c, r } = frames[i].colRow(x, y);
    const c0 = Math.round(c);
    const r0 = Math.round(r);
    const own = g.groundAtCell(c0, r0);
    if (own === own) return own;
    const reach = Math.ceil(GROUND_SEARCH_M / g.cellM);
    let best = null;
    let bestD = Infinity;
    for (let dr = -reach; dr <= reach; dr += 1) {
      for (let dc = -reach; dc <= reach; dc += 1) {
        const v = g.groundAtCell(c0 + dc, r0 + dr);
        if (v === v) {
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
    }
    return best;
  };

  /**
   * True when something within `reachM` of a local point is not seen by any
   * surface: a hole in the data, the edge of the model, or off it. A hole is
   * not open air: an unseen tree may stand there, so a point that close to
   * one is "not checked", never "clear". The disc is read on a lattice of
   * one cell (wider for very large reaches, so the cost stays bounded).
   */
  const unknownWithin = (x, y, reachM) => {
    let cell = Infinity;
    for (const g of grids) cell = Math.min(cell, g.cellM);
    const step = Math.max(cell, reachM / UNKNOWN_LATTICE_MAX);
    const n = Math.ceil(reachM / step);
    for (let j = -n; j <= n; j += 1) {
      for (let k = -n; k <= n; k += 1) {
        const dx = k * step;
        const dy = j * step;
        if (dx * dx + dy * dy > reachM * reachM) continue;
        if (ownerAt(x + dx, y + dy) < 0) return true;
      }
    }
    return false;
  };

  /**
   * Visit every cell (from the grid that owns it) within `reachM` of a local
   * point, skipping blocks and cells whose top is below `minTop()` (read
   * again for every block, so a closer hit tightens the search).
   * `visit(topM, groundOfGrid, dhEff, gridIndex)` is called per cell.
   */
  const scan = (i, x, y, reachM, minTop, visit) => {
    const g = grids[i];
    const f = frames[i];
    const cellLocal = g.cellM / f.scale;
    const half = cellLocal / 2;
    const { c, r } = f.colRow(x, y);
    const rad = reachM / cellLocal + 1.5;
    const c0 = Math.max(0, Math.floor(c - rad));
    const c1 = Math.min(g.cols - 1, Math.ceil(c + rad));
    const r0 = Math.max(0, Math.floor(r - rad));
    const r1 = Math.min(g.rows - 1, Math.ceil(r + rad));
    const newer = i; // grids [0, i) are newer
    for (
      let br = Math.floor(r0 / BLOCK);
      br <= Math.floor(r1 / BLOCK);
      br += 1
    ) {
      for (
        let bc = Math.floor(c0 / BLOCK);
        bc <= Math.floor(c1 / BLOCK);
        bc += 1
      ) {
        if (g.blockMax[br * g.bw + bc] < minTop()) continue;
        const rs = Math.max(r0, br * BLOCK);
        const re = Math.min(r1, br * BLOCK + BLOCK - 1);
        const cs = Math.max(c0, bc * BLOCK);
        const ce = Math.min(c1, bc * BLOCK + BLOCK - 1);
        for (let rr = rs; rr <= re; rr += 1) {
          for (let cc = cs; cc <= ce; cc += 1) {
            const t = g.top[rr * g.cols + cc];
            if (!(t === t) || t < minTop()) continue;
            const q = f.local(cc, rr);
            const dh = Math.max(0, Math.hypot(q.x - x, q.y - y) - half);
            if (dh >= reachM) continue;
            if (newer > 0) {
              let taken = false;
              for (let j = 0; j < newer; j += 1) {
                const o = nearestTop(j, q.x, q.y);
                if (o === o) {
                  taken = true;
                  break;
                }
              }
              if (taken) continue;
            }
            visit(t, dh);
          }
        }
      }
    }
  };

  return {
    frames,
    /** Which surface owns a local point, and its ground there. */
    coverAt(x, y) {
      const i = ownerAt(x, y);
      if (i < 0) return null;
      const ground = groundIn(i, x, y);
      if (ground == null) return null;
      return { gridIndex: i, id: grids[i].id, ground };
    },
    /**
     * Smallest 3D distance from a drone at `aglM` over local (x, y) to the
     * surface, searching up to `limitM`. null when the surface does not cover
     * the point. `distM` is `limitM` or more when nothing is closer.
     */
    distanceAt(x, y, aglM, limitM) {
      const own = ownerAt(x, y);
      if (own < 0) return null;
      const ownGround = groundIn(own, x, y);
      if (ownGround == null) return null;
      if (unknownWithin(x, y, limitM)) return null;
      let best = limitM;
      for (let i = 0; i < grids.length; i += 1) {
        // An older surface without ground here is read against the ground of
        // the surface that owns the point, so its trees are never dropped.
        const ground = i === own ? ownGround : (groundIn(i, x, y) ?? ownGround);
        const z = ground + aglM;
        scan(
          i,
          x,
          y,
          limitM,
          () => z - best,
          (t, dh) => {
            const d = Math.hypot(dh, Math.max(0, z - t));
            if (d < best) best = d;
          },
        );
      }
      const topHere = nearestTop(own, x, y);
      return {
        distM: best,
        vertM: ownGround + aglM - topHere,
        topAglM: topHere - ownGround,
        id: grids[own].id,
      };
    },
    /**
     * Lowest AGL at local (x, y) that keeps `requiredM` from the surface, or
     * null when the surface does not cover the point.
     */
    floorAglAt(x, y, requiredM) {
      const own = ownerAt(x, y);
      if (own < 0) return null;
      const ownGround = groundIn(own, x, y);
      if (ownGround == null) return null;
      if (unknownWithin(x, y, requiredM)) return null;
      let floor = null;
      for (let i = 0; i < grids.length; i += 1) {
        const ground = i === own ? ownGround : (groundIn(i, x, y) ?? ownGround);
        let top = -Infinity;
        scan(
          i,
          x,
          y,
          requiredM,
          () => top - requiredM,
          (t, dh) => {
            const need = t + Math.sqrt(requiredM * requiredM - dh * dh);
            if (need > top) top = need;
          },
        );
        if (top === -Infinity) continue;
        floor = floor == null ? top - ground : Math.max(floor, top - ground);
      }
      return floor ?? 0;
    },
  };
}

/** Local metre frame helper shared by the checks. */
function frameOf(lon0, lat0) {
  const m = metersPerDegree(lat0);
  return {
    x: (lon) => (lon - lon0) * m.lon,
    y: (lat) => (lat - lat0) * m.lat,
    lon: (x) => lon0 + x / m.lon,
    lat: (y) => lat0 + y / m.lat,
  };
}

const r1 = (v) => Math.round(v * 10) / 10;
/** Round up to 0.1 m: a floor must never be rounded down. */
const ceil1 = (v) => Math.ceil(v * 10 - 1e-9) / 10;

/**
 * Check the route against the surface. For every waypoint and every
 * `stepM` along every leg, the 3D distance to the surface must be at least
 * `minClearanceM + errorMarginM`.
 * @param {object} args
 * @param {object[]} args.legs planner legs, waypoints `{ lon, lat, aglM }`
 * @param {ReturnType<typeof createSurfaceModel>} args.model
 * @param {number} args.minClearanceM wanted clearance, metres
 * @param {number} [args.errorMarginM] position error, added to it
 * @param {number} [args.stepM]
 */
export function checkClearance({
  legs = [],
  model,
  minClearanceM,
  errorMarginM = 0,
  stepM = CLEARANCE_STEP_M,
  maxSamples = MAX_CLEARANCE_SAMPLES,
} = {}) {
  const requiredM =
    Math.max(0, Number(minClearanceM) || 0) +
    Math.max(0, Number(errorMarginM) || 0);
  const empty = {
    requiredM,
    checked: 0,
    covered: 0,
    outside: 0,
    spans: [],
    spanCount: 0,
    violationSamples: 0,
    worst: null,
    surfaceIds: [],
    stepM,
  };
  const pts = [];
  for (const leg of legs) {
    (leg.waypoints ?? []).forEach((w, i) => {
      if (Number.isFinite(w.lon) && Number.isFinite(w.lat))
        pts.push({ w, legId: leg.id, i });
    });
  }
  if (!pts.length || !model?.grids?.length) return empty;
  const lon0 = pts[0].w.lon;
  const lat0 = pts[0].w.lat;
  const f = frameOf(lon0, lat0);
  const view = model.view(lon0, lat0);

  // Total length decides the step, so a huge route stays bounded.
  let total = 0;
  for (const leg of legs) {
    const ws = leg.waypoints ?? [];
    for (let i = 1; i < ws.length; i += 1) {
      total += Math.hypot(
        f.x(ws[i].lon) - f.x(ws[i - 1].lon),
        f.y(ws[i].lat) - f.y(ws[i - 1].lat),
      );
    }
  }
  const step = Math.max(stepM, total / maxSamples);

  const result = { ...empty, stepM: r1(step) };
  const used = new Set();
  // (At the 1 m default a point can sit 0.5 m from its nearest sample; the
  // position error margin in requiredM is far larger, so this is not widened.)
  // A very long route is sampled further apart than stepM: the distance to
  // the surface changes by at most 1 m per metre, so half of the extra gap is
  // added to what is looked for. (requiredM, as reported, stays the setting.)
  const limit = requiredM + Math.max(0, step - stepM) / 2;
  let open = null;
  const closeSpan = () => {
    if (!open) return;
    result.spanCount += 1;
    if (result.spans.length < MAX_SPANS) result.spans.push(open.span);
    open = null;
  };
  const sampleAt = (x, y, agl, legId, waypoint, isWaypoint) => {
    result.checked += 1;
    const lon = f.lon(x);
    const lat = f.lat(y);
    if (!model.mayCover(lon, lat, limit)) {
      result.outside += 1;
      closeSpan();
      return;
    }
    const d = view.distanceAt(x, y, agl, limit);
    if (!d) {
      result.outside += 1;
      closeSpan();
      return;
    }
    result.covered += 1;
    used.add(d.id);
    if (d.distM < limit - 1e-6) {
      result.violationSamples += 1;
      const here = { lon, lat, aglM: r1(agl) };
      const hit = {
        distM: r1(d.distM),
        vertM: Number.isFinite(d.vertM) ? r1(d.vertM) : null,
        topAglM: d.topAglM == null ? null : r1(d.topAglM),
        at: here,
        waypoint,
      };
      if (!result.worst || d.distM < result.worst.distM)
        result.worst = { ...hit, legId };
      if (!open || open.legId !== legId) {
        closeSpan();
        open = {
          legId,
          span: {
            legId,
            fromWaypoint: waypoint,
            toWaypoint: waypoint,
            start: here,
            end: here,
            lengthM: 0,
            minDistM: hit.distM,
            minAt: here,
            vertM: hit.vertM,
            topAglM: hit.topAglM,
            samples: 1,
            atWaypoint: isWaypoint,
          },
          lastX: x,
          lastY: y,
        };
      } else {
        const s = open.span;
        s.toWaypoint = waypoint;
        s.end = here;
        s.lengthM = r1(s.lengthM + Math.hypot(x - open.lastX, y - open.lastY));
        s.samples += 1;
        s.atWaypoint = s.atWaypoint || isWaypoint;
        if (hit.distM < s.minDistM) {
          s.minDistM = hit.distM;
          s.minAt = here;
          s.vertM = hit.vertM;
          s.topAglM = hit.topAglM;
        }
        open.lastX = x;
        open.lastY = y;
      }
    } else {
      closeSpan();
    }
  };

  for (const leg of legs) {
    const ws = (leg.waypoints ?? []).filter(
      (w) => Number.isFinite(w.lon) && Number.isFinite(w.lat),
    );
    closeSpan();
    ws.forEach((w, i) => {
      const x = f.x(w.lon);
      const y = f.y(w.lat);
      const agl = w.aglM ?? 0;
      if (i > 0) {
        const p = ws[i - 1];
        const px = f.x(p.lon);
        const py = f.y(p.lat);
        const pa = p.aglM ?? 0;
        const len = Math.hypot(x - px, y - py);
        const n = Math.floor(len / step);
        for (let k = 1; k <= n; k += 1) {
          const u = (k * step) / len;
          if (u >= 1) break;
          sampleAt(
            px + (x - px) * u,
            py + (y - py) * u,
            pa + (agl - pa) * u,
            leg.id,
            i,
            false,
          );
        }
      }
      sampleAt(x, y, agl, leg.id, i, true);
    });
    closeSpan();
  }
  closeSpan();
  result.surfaceIds = [...used];
  result.spans.sort((a, b) => a.minDistM - b.minDistM);
  return result;
}

/**
 * What the planner asks of a surface: floors for orbit rings and look-at
 * paths. `requiredM` is the clearance (minimum plus position error).
 * @returns {{ requiredM: number,
 *   ringFloor: (lon:number, lat:number, radiusM:number) => {aglM:number|null, covered:'full'|'partial'|'none'},
 *   pathFloor: (points:{lon:number,lat:number}[]) => {aglM:number|null, covered:'full'|'partial'|'none'} }}
 */
export function createSurfaceProbe(model, requiredM) {
  const wanted = Math.max(0, Number(requiredM) || 0);
  // The floor is read at points PROBE_SPACING_M apart, but the drone flies
  // between them. Distance to a surface changes by at most 1 m per metre
  // moved, so half the spacing of extra clearance covers every point between.
  const ready = Boolean(model?.grids?.length);
  /** `spacingM` is the real gap between the points: half of it is added. */
  const run = (points, spacingM) => {
    const req = wanted + spacingM / 2;
    if (!ready || !points.length) return { aglM: null, covered: 'none' };
    const view = model.view(points[0].lon, points[0].lat);
    const f = frameOf(points[0].lon, points[0].lat);
    let floor = null;
    let inside = 0;
    for (const p of points) {
      const x = f.x(p.lon);
      const y = f.y(p.lat);
      const v = model.mayCover(p.lon, p.lat, 0)
        ? view.floorAglAt(x, y, req)
        : null;
      if (v == null) continue;
      inside += 1;
      floor = floor == null ? v : Math.max(floor, v);
    }
    const covered =
      inside === 0 ? 'none' : inside === points.length ? 'full' : 'partial';
    return { aglM: floor == null ? null : ceil1(floor), covered };
  };
  return {
    requiredM: wanted,
    ready,
    ringFloor(lon, lat, radiusM) {
      const r = Math.max(1, Number(radiusM) || 1);
      const n = Math.min(
        MAX_RING_POINTS,
        Math.max(16, Math.ceil((2 * Math.PI * r) / PROBE_SPACING_M)),
      );
      const spacing = (2 * Math.PI * r) / n;
      const m = metersPerDegree(lat);
      const points = [];
      for (let k = 0; k < n; k += 1) {
        const a = (2 * Math.PI * k) / n;
        points.push({
          lon: lon + (r * Math.cos(a)) / m.lon,
          lat: lat + (r * Math.sin(a)) / m.lat,
        });
      }
      return run(points, spacing);
    },
    pathFloor(points) {
      const out = [];
      const list = Array.isArray(points) ? points : [];
      const first = list[0];
      if (!first) return { aglM: null, covered: 'none' };
      const m = metersPerDegree(first.lat);
      let spacing = PROBE_SPACING_M;
      for (let i = 0; i < list.length; i += 1) {
        out.push(list[i]);
        const nxt = list[i + 1];
        if (!nxt) break;
        const len = Math.hypot(
          (nxt.lon - list[i].lon) * m.lon,
          (nxt.lat - list[i].lat) * m.lat,
        );
        const n = Math.min(
          MAX_SEGMENT_POINTS,
          Math.floor(len / PROBE_SPACING_M),
        );
        spacing = Math.max(spacing, len / (n + 1));
        for (let k = 1; k <= n; k += 1) {
          const u = k / (n + 1);
          out.push({
            lon: list[i].lon + (nxt.lon - list[i].lon) * u,
            lat: list[i].lat + (nxt.lat - list[i].lat) * u,
          });
        }
      }
      return run(out, spacing);
    },
  };
}
