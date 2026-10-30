/**
 * Per-obstacle heights for the Drone Flight Plan.
 *
 * An obstacle is a column on the ground: a tree patch, a tower, a building.
 * Its height is an ESTIMATE from open data (USGS-style lidar canopy models,
 * FAA obstacle file, OpenStreetMap) or a number the operator typed or
 * dragged. It is never read from the Google 3D tiles: Google's terms forbid
 * measuring them in code, so they are only a backdrop to compare by eye.
 *
 * Pure module: no Cesium, no network.
 */
import { metersPerDegree, deltaLon } from './geo.js';

export const OBSTACLE_KINDS = Object.freeze([
  'tree',
  'tower',
  'building',
  'other',
]);
export const OBSTACLE_SOURCES = Object.freeze([
  'lidar',
  'canopy',
  'faa',
  'osm',
  'overture',
  'user',
]);
/** Most obstacles one plan keeps; extra ones are dropped, not planned. */
export const MAX_OBSTACLES = 60;
/** Tallest height a column can be set to, metres above ground. */
export const MAX_OBSTACLE_HEIGHT_M = 400;
/** Vertical margin kept above an obstacle top, metres. */
export const OBSTACLE_CLEARANCE_MARGIN_M = 5;
/** Sideways margin around an obstacle in which the clearance applies, m. */
export const OBSTACLE_HORIZONTAL_MARGIN_M = 10;
export const MIN_OBSTACLE_RADIUS_M = 2;
export const MAX_OBSTACLE_RADIUS_M = 300;
const DEFAULT_RADIUS_M = Object.freeze({
  tree: 12,
  tower: 6,
  building: 15,
  other: 10,
});

const finite = (v) => Number.isFinite(Number(v)) && v !== null && v !== '';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Clean one obstacle; null when it has no usable position. Unknown kinds and
 * sources fall back to 'other' / 'user'. A missing estimate means "no
 * estimate", so a reset has nothing to go back to and keeps the height.
 */
export function normalizeObstacle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!finite(raw.lon) || !finite(raw.lat)) return null;
  const lon = Number(raw.lon);
  const lat = Number(raw.lat);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const id = String(raw.id ?? '')
    .replace(/[^\w.:-]+/g, '-')
    .slice(0, 60);
  if (!id) return null;
  const kind = OBSTACLE_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const source = OBSTACLE_SOURCES.includes(raw.source) ? raw.source : 'user';
  const radiusM = clamp(
    finite(raw.radiusM) ? Number(raw.radiusM) : DEFAULT_RADIUS_M[kind],
    MIN_OBSTACLE_RADIUS_M,
    MAX_OBSTACLE_RADIUS_M,
  );
  const estimate = finite(raw.estimatedHeightM)
    ? clamp(Number(raw.estimatedHeightM), 0, MAX_OBSTACLE_HEIGHT_M)
    : null;
  const heightM = clamp(
    finite(raw.heightM) ? Number(raw.heightM) : (estimate ?? 0),
    0,
    MAX_OBSTACLE_HEIGHT_M,
  );
  return {
    id,
    kind,
    lon,
    lat,
    radiusM: round1(radiusM),
    heightM: round1(heightM),
    source,
    estimatedHeightM: estimate === null ? null : round1(estimate),
    userEdited: raw.userEdited === true,
  };
}

/** Clean a list: invalid and duplicate ids dropped, capped at MAX_OBSTACLES. */
export function normalizeObstacles(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const o = normalizeObstacle(raw);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
    if (out.length >= MAX_OBSTACLES) break;
  }
  return out;
}

/**
 * The panel session's obstacle list. Estimates come and go with the plan
 * area; whatever the operator added or edited always survives a refresh.
 */
export function createObstacleStore({ onChange } = {}) {
  let list = [];
  let nextUser = 1;
  const emit = () => onChange?.(list);
  const replace = (next) => {
    list = next;
    emit();
  };
  return {
    list: () => list,
    get: (id) => list.find((o) => o.id === id) ?? null,
    clear() {
      nextUser = 1;
      if (list.length) replace([]);
    },
    /** The operator clicked the map. Returns the new obstacle or null (full). */
    add({ lon, lat, kind = 'tree', heightM = 15, radiusM } = {}) {
      if (list.length >= MAX_OBSTACLES) return null;
      let id;
      do id = `user-${nextUser++}`;
      while (list.some((o) => o.id === id));
      const o = normalizeObstacle({
        id,
        kind,
        lon,
        lat,
        radiusM,
        heightM,
        source: 'user',
        estimatedHeightM: null,
        userEdited: true,
      });
      if (!o) return null;
      replace([...list, o]);
      return o;
    },
    remove(id) {
      if (!list.some((o) => o.id === id)) return false;
      replace(list.filter((o) => o.id !== id));
      return true;
    },
    /** Type or drag. The estimate is kept so Reset can return to it. */
    setHeight(id, heightM) {
      if (!finite(heightM)) return false;
      const target = list.find((o) => o.id === id);
      if (!target) return false;
      const h = round1(clamp(Number(heightM), 0, MAX_OBSTACLE_HEIGHT_M));
      replace(
        list.map((o) =>
          o.id === id ? { ...o, heightM: h, userEdited: true } : o,
        ),
      );
      return true;
    },
    setRadius(id, radiusM) {
      if (!finite(radiusM)) return false;
      if (!list.some((o) => o.id === id)) return false;
      const r = round1(
        clamp(Number(radiusM), MIN_OBSTACLE_RADIUS_M, MAX_OBSTACLE_RADIUS_M),
      );
      replace(list.map((o) => (o.id === id ? { ...o, radiusM: r } : o)));
      return true;
    },
    /** Back to the open-data estimate. A user-added obstacle has none. */
    reset(id) {
      const target = list.find((o) => o.id === id);
      if (!target || target.estimatedHeightM === null) return false;
      replace(
        list.map((o) =>
          o.id === id
            ? { ...o, heightM: o.estimatedHeightM, userEdited: false }
            : o,
        ),
      );
      return true;
    },
    /**
     * Merge a fresh set of open-data estimates. Estimates not seen again are
     * dropped, except those of `keepSources` (sources that failed to load); an obstacle the operator edited keeps their height (its
     * estimate is refreshed); user-added ones are untouched.
     */
    replaceEstimates(found, { keepSources = [] } = {}) {
      const fresh = normalizeObstacles(found).filter(
        (o) => o.source !== 'user',
      );
      const freshById = new Map(fresh.map((o) => [o.id, o]));
      // A source that could not be read this time says nothing about what is
      // there: what it gave before, and every edit, stays as it was.
      const kept = list.filter(
        (o) =>
          o.source === 'user' ||
          keepSources.includes(o.source) ||
          (o.userEdited && freshById.has(o.id)),
      );
      const merged = kept.map((o) => {
        const f = freshById.get(o.id);
        if (!f) return o;
        freshById.delete(o.id);
        return { ...o, estimatedHeightM: f.estimatedHeightM };
      });
      for (const o of fresh) {
        if (!freshById.has(o.id)) continue;
        if (merged.length >= MAX_OBSTACLES) break;
        merged.push(o);
      }
      replace(merged);
      return merged.length;
    },
  };
}

/** Local east/north metres of (lon, lat) from an origin. */
function xy(origin, m, lon, lat) {
  return {
    x: deltaLon(origin.lon, lon) * m.lon,
    y: (lat - origin.lat) * m.lat,
  };
}

/** Shortest distance from the origin (0,0) to the segment a-b. */
function distToSegment(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(-(a.x * dx + a.y * dy) / len2, 0, 1) : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

/** Height a flight must reach near this obstacle, metres above ground. */
export function requiredAglM(obstacle) {
  return obstacle.heightM + OBSTACLE_CLEARANCE_MARGIN_M;
}

/**
 * Raise legs so every waypoint, and every straight stretch between two
 * neighbours, that passes within (radius + horizontal margin) of an obstacle
 * is at least obstacle height + 5 m above ground. A leg the height cap
 * cannot lift high enough keeps the capped height and is flagged `blocked`
 * so the globe can draw it red and the panel can warn.
 *
 * Legs are not mutated; changed ones are copied.
 *
 * @param {object[]} legs planner legs ({ id, waypoints:[{lon,lat,aglM}] })
 * @param {object[]} obstacles normalized obstacles
 * @param {{ capM: number }} limits the highest allowed AGL
 * @returns {{ legs: object[], raised: number, blocked: object[] }}
 */
export function applyObstacleClearance(legs, obstacles, { capM }) {
  const list = normalizeObstacles(obstacles);
  if (!list.length || !legs?.length) {
    return { legs, raised: 0, blocked: [] };
  }
  let raised = 0;
  const blocked = [];
  const out = legs.map((leg) => {
    const wps = leg.waypoints;
    if (!wps?.length) return leg;
    const need = wps.map(() => 0);
    const cause = wps.map(() => null);
    for (const ob of list) {
      const m = metersPerDegree(ob.lat);
      const reach = ob.radiusM + OBSTACLE_HORIZONTAL_MARGIN_M;
      const req = requiredAglM(ob);
      const pts = wps.map((w) => xy(ob, m, w.lon, w.lat));
      const lift = (i) => {
        if (req > need[i]) {
          need[i] = req;
          cause[i] = ob.id;
        }
      };
      pts.forEach((p, i) => {
        if (Math.hypot(p.x, p.y) <= reach) lift(i);
      });
      for (let i = 1; i < pts.length; i += 1) {
        if (distToSegment(pts[i - 1], pts[i]) <= reach) {
          lift(i - 1);
          lift(i);
        }
      }
    }
    let changed = false;
    let legBlocked = false;
    const next = wps.map((w, i) => {
      if (!need[i] || w.aglM >= need[i] - 1e-9) return w;
      changed = true;
      const target = Math.min(need[i], capM);
      const capped = need[i] > capM + 1e-9;
      if (capped) {
        legBlocked = true;
        blocked.push({
          legId: leg.id,
          waypointId: w.id,
          obstacleId: cause[i],
          needAglM: round1(need[i]),
          capM,
        });
      }
      if (target <= w.aglM) return capped ? { ...w, obstacleBlocked: true } : w;
      raised += 1;
      return capped
        ? { ...w, aglM: target, obstacleBlocked: true }
        : { ...w, aglM: target };
    });
    if (!changed) return leg;
    return legBlocked
      ? { ...leg, waypoints: next, obstacleBlocked: true }
      : { ...leg, waypoints: next };
  });
  return { legs: out, raised, blocked };
}

/** Label for the globe column: "<kind> <h> m". */
export function obstacleLabel(o, kindText = (k) => k) {
  return `${kindText(o.kind)} ${Math.round(o.heightM)} m`;
}
