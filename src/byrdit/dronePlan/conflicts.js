/**
 * Conflict warnings: drawn paths and orbits against OpenStreetMap building
 * footprints and heights, the obstacle heights the person entered, and the
 * safety zone around the route. WARN ONLY: nothing is moved or re-routed.
 *
 * This check does NOT see trees, power lines or towers (OpenStreetMap leaves
 * most of them out), and a building with no height tag has an unknown height.
 * The panel says so next to the result.
 */
import { metersPerDegree } from './geo.js';
import {
  OBSTACLE_CLEARANCE_MARGIN_M,
  OBSTACLE_HORIZONTAL_MARGIN_M,
  normalizeObstacles,
} from './obstacles.js';

/** Most warnings of one kind that are listed (the count is still exact). */
export const MAX_LISTED = 8;
/** Spacing of the checks along a straight stretch of route, metres. */
export const SAMPLE_STEP_M = 4;

function frameOf(lon0, lat0) {
  const m = metersPerDegree(lat0);
  return {
    x: (lon) => (lon - lon0) * m.lon,
    y: (lat) => (lat - lat0) * m.lat,
  };
}

function insideRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Metres from a point to a ring (0 inside it). */
function distToRing(ring, x, y) {
  if (insideRing(ring, x, y)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(
      best,
      distToSegment(x, y, ring[i], ring[(i + 1) % ring.length]),
    );
  }
  return best;
}

/**
 * Check the route of a plan.
 * @param {object} args
 * @param {object[]} args.legs planner legs, waypoints `{ lon, lat, aglM }`
 *   (only flown photo legs: `kind` orbit, lookat, grid ...; all are checked)
 * @param {{ ring: {lon:number,lat:number}[], heightM: number|null,
 *   label?: string, osmId?: string }[]} [args.buildings]
 * @param {object[]} [args.obstacles] entered obstacles
 * @param {number} [args.zoneHalfWidthM] half width of the safety zone
 * @returns {{ conflicts: object[], unknownHeight: object[], checked: number }}
 *   `conflicts`: `{ kind: 'building'|'obstacle', label, id, needAglM,
 *   flownAglM, distM, legId, waypoint }` (the worst spot of each). `unknownHeight`:
 *   buildings the route passes with no height in the data.
 */
export function checkConflicts({
  legs = [],
  buildings = [],
  obstacles = [],
  zoneHalfWidthM = 0,
  clearanceM = OBSTACLE_CLEARANCE_MARGIN_M,
} = {}) {
  const pts = [];
  legs.forEach((leg) => {
    (leg.waypoints ?? []).forEach((w, i) => {
      if (Number.isFinite(w.lon) && Number.isFinite(w.lat))
        pts.push({
          w,
          legId: leg.id,
          i,
          prev: i > 0 ? leg.waypoints[i - 1] : null,
        });
    });
  });
  if (!pts.length) return { conflicts: [], unknownHeight: [], checked: 0 };
  const lon0 = pts[0].w.lon;
  const lat0 = pts[0].w.lat;
  const f = frameOf(lon0, lat0);
  const margin = Math.max(OBSTACLE_HORIZONTAL_MARGIN_M, zoneHalfWidthM || 0);
  // Samples along the whole route: every waypoint and the stretches between.
  const samples = [];
  for (const p of pts) {
    const here = { x: f.x(p.w.lon), y: f.y(p.w.lat), agl: p.w.aglM ?? 0 };
    if (p.prev) {
      const a = {
        x: f.x(p.prev.lon),
        y: f.y(p.prev.lat),
        agl: p.prev.aglM ?? 0,
      };
      const len = Math.hypot(here.x - a.x, here.y - a.y);
      const n = Math.min(400, Math.floor(len / SAMPLE_STEP_M));
      for (let k = 1; k <= n; k += 1) {
        const u = k / (n + 1);
        samples.push({
          x: a.x + (here.x - a.x) * u,
          y: a.y + (here.y - a.y) * u,
          agl: a.agl + (here.agl - a.agl) * u,
          legId: p.legId,
          waypoint: p.i,
        });
      }
    }
    samples.push({ ...here, legId: p.legId, waypoint: p.i });
  }
  const conflicts = [];
  const unknownHeight = [];
  const seenUnknown = new Set();

  const rings = (Array.isArray(buildings) ? buildings : [])
    .filter((b) => Array.isArray(b?.ring) && b.ring.length >= 3)
    .map((b, index) => ({
      b,
      id: b.osmId ?? `building-${index + 1}`,
      ring: b.ring.map((p) => ({ x: f.x(p.lon), y: f.y(p.lat) })),
    }));
  for (const { b, id, ring } of rings) {
    let worst = null;
    for (const s of samples) {
      const d = distToRing(ring, s.x, s.y);
      if (d > margin) continue;
      if (b.heightM == null) {
        if (!seenUnknown.has(id)) {
          seenUnknown.add(id);
          unknownHeight.push({
            kind: 'building',
            id,
            label: b.label || '',
            distM: Math.round(d),
          });
        }
        break;
      }
      const need = b.heightM + clearanceM;
      if (
        s.agl < need - 0.05 &&
        (!worst || s.agl - need < worst.flownAglM - need)
      ) {
        worst = {
          kind: 'building',
          id,
          label: b.label || '',
          needAglM: Math.round(need * 10) / 10,
          flownAglM: Math.round(s.agl * 10) / 10,
          distM: Math.round(d),
          legId: s.legId,
          waypoint: s.waypoint,
        };
      }
    }
    if (worst) conflicts.push(worst);
  }

  for (const o of normalizeObstacles(obstacles)) {
    const ox = f.x(o.lon);
    const oy = f.y(o.lat);
    const reach = (o.radiusM ?? 0) + margin;
    const need = o.heightM + clearanceM;
    let worst = null;
    for (const s of samples) {
      const d = Math.hypot(s.x - ox, s.y - oy);
      if (d > reach) continue;
      if (s.agl < need - 0.05 && (!worst || s.agl < worst.flownAglM)) {
        worst = {
          kind: 'obstacle',
          id: o.id ?? '',
          label: o.label || '',
          needAglM: Math.round(need * 10) / 10,
          flownAglM: Math.round(s.agl * 10) / 10,
          distM: Math.round(d),
          legId: s.legId,
          waypoint: s.waypoint,
        };
      }
    }
    if (worst) conflicts.push(worst);
  }
  conflicts.sort(
    (a, b) => a.flownAglM - a.needAglM - (b.flownAglM - b.needAglM),
  );
  return { conflicts, unknownHeight, checked: samples.length };
}
