/**
 * Per-obstacle heights for the Drone Flight Plan.
 *
 * An obstacle is a column on the ground: a tree patch, a tower, a building.
 * Its height is an ESTIMATE from open data (the Meta/WRI canopy height
 * model, FAA obstacle file, OpenStreetMap) or a number the operator typed or
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
/** `lidar` and `overture` are reserved for sources not wired yet. */
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
export function normalizeObstacles(list, max = MAX_OBSTACLES) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const o = normalizeObstacle(raw);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
    if (out.length >= max) break;
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
  let droppedCount = 0;
  const emit = () => onChange?.(list);
  const replace = (next) => {
    list = next;
    emit();
  };
  return {
    list: () => list,
    /** Open-data rows the last refresh could not keep (over the cap). */
    dropped: () => droppedCount,
    get: (id) => list.find((o) => o.id === id) ?? null,
    clear() {
      nextUser = 1;
      droppedCount = 0;
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
    /** Restore a saved list (a library plan being opened). */
    load(saved) {
      const next = normalizeObstacles(saved);
      nextUser =
        1 +
        next.reduce(
          (m, o) => Math.max(m, Number(/^user-(\d+)$/.exec(o.id)?.[1]) || 0),
          0,
        );
      replace(next);
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
    /** What the obstacle is. Only for obstacles the operator added. */
    setKind(id, kind) {
      const target = list.find((o) => o.id === id);
      if (!target || target.source !== 'user') return false;
      if (!OBSTACLE_KINDS.includes(kind)) return false;
      replace(
        list.map((o) =>
          o.id === id ? { ...o, kind, radiusM: DEFAULT_RADIUS_M[kind] } : o,
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
    replaceEstimates(found, { keepSources = [], within = null } = {}) {
      const fresh = normalizeObstacles(found, Infinity).filter(
        (o) => o.source !== 'user',
      );
      const freshById = new Map(fresh.map((o) => [o.id, o]));
      // A source that could not be read (fully or partly) says nothing about
      // what is there: what it gave before stays. An edited obstacle is never
      // dropped: the operator corrected it, and ids can change when the area
      // moves, so a fresh row is matched to it by position as well as by id.
      // Rows kept only because their source failed must still lie in the
      // area now being planned, or old areas would pile up for ever.
      const kept = list.filter(
        (o) =>
          o.source === 'user' ||
          o.userEdited ||
          (keepSources.includes(o.source) && (!within || within(o))),
      );
      const near = (a, b) => {
        const m = metersPerDegree(a.lat);
        return (
          a.kind === b.kind &&
          Math.hypot(deltaLon(a.lon, b.lon) * m.lon, (b.lat - a.lat) * m.lat) <=
            Math.max(a.radiusM, b.radiusM)
        );
      };
      const taken = new Set();
      const merged = kept.map((o) => {
        if (o.source === 'user') return o;
        const f =
          freshById.get(o.id) ??
          (o.userEdited ? fresh.find((x) => near(o, x)) : null);
        if (!f) return o;
        taken.add(f.id);
        return o.userEdited
          ? { ...o, estimatedHeightM: f.estimatedHeightM }
          : o;
      });
      // When the cap bites: the operator's own rows win, then fresh open-data
      // rows (towers first, they are the rare ones), then rows kept from a
      // source that could not be read.
      const mine = (o) => o.source === 'user' || o.userEdited;
      const seen = new Set(merged.map((o) => o.id));
      const added = fresh
        .filter((o) => !taken.has(o.id) && !seen.has(o.id))
        .sort((a, b) => (b.kind === 'tower') - (a.kind === 'tower'));
      const final = merged.filter(mine);
      for (const o of [...added, ...merged.filter((o) => !mine(o))]) {
        if (final.length >= MAX_OBSTACLES) break;
        final.push(o);
      }
      droppedCount = Math.max(
        0,
        added.length +
          merged.filter((o) => !mine(o)).length -
          (final.length - merged.filter(mine).length),
      );
      replace(final);
      return final.length;
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
export function applyObstacleClearance(
  legs,
  obstacles,
  { capM, groundOf = null, obstacleGroundOf = null },
) {
  const list = normalizeObstacles(obstacles);
  if (!list.length || !legs?.length) {
    return { legs, raised: 0, blocked: [] };
  }
  // The whole route in flight order: stretches between legs (the turn from
  // one grid line to the next) are flown too, so they are checked too.
  const seq = [];
  legs.forEach((leg, li) => {
    (leg.waypoints ?? []).forEach((w, wi) => seq.push({ li, wi, w }));
  });
  if (!seq.length) return { legs, raised: 0, blocked: [] };
  const need = seq.map(() => 0);
  const cause = seq.map(() => null);
  for (const ob of list) {
    const m = metersPerDegree(ob.lat);
    const reach = ob.radiusM + OBSTACLE_HORIZONTAL_MARGIN_M;
    const base = requiredAglM(ob);
    const obGround = obstacleGroundOf ? obstacleGroundOf(ob) : null;
    // The column stands on ITS ground; a waypoint on lower ground needs the
    // difference on top, or the 5 m margin is eaten on a slope.
    const req = (i) => {
      const wg = groundOf ? groundOf(seq[i].w) : null;
      const extra =
        Number.isFinite(obGround) && Number.isFinite(wg)
          ? Math.max(0, obGround - wg)
          : 0;
      return base + extra;
    };
    const lift = (i) => {
      const r = req(i);
      if (r > need[i]) {
        need[i] = r;
        cause[i] = ob.id;
      }
    };
    const pts = seq.map(({ w }) => xy(ob, m, w.lon, w.lat));
    pts.forEach((p, i) => {
      if (Math.hypot(p.x, p.y) <= reach) lift(i);
    });
    const pair = (a, b) => {
      if (distToSegment(pts[a], pts[b]) <= reach) {
        lift(a);
        lift(b);
      }
    };
    for (let i = 1; i < pts.length; i += 1) pair(i - 1, i);
    // An orbit ring is a closed loop: the last point flies back to the first.
    let start = 0;
    for (let i = 1; i <= seq.length; i += 1) {
      if (i === seq.length || seq[i].li !== seq[start].li) {
        if (legs[seq[start].li].kind === 'orbit' && i - start > 2) {
          pair(i - 1, start);
        }
        start = i;
      }
    }
  }
  let raised = 0;
  const blocked = [];
  const changedLegs = new Map();
  const legBlocked = new Set();
  seq.forEach((entry, i) => {
    const { li, wi, w } = entry;
    if (!need[i] || w.aglM >= need[i] - 1e-9) return;
    const target = Math.min(need[i], capM);
    const capped = need[i] > capM + 1e-9;
    let next = w;
    if (capped) {
      legBlocked.add(li);
      blocked.push({
        legId: legs[li].id,
        waypointId: w.id,
        obstacleId: cause[i],
        needAglM: round1(need[i]),
        capM,
      });
      next = { ...w, obstacleBlocked: true };
    }
    if (target > w.aglM) {
      raised += 1;
      next = { ...next, aglM: target };
    }
    if (next === w) return;
    if (!changedLegs.has(li)) changedLegs.set(li, [...legs[li].waypoints]);
    changedLegs.get(li)[wi] = next;
  });
  const out = legs.map((leg, li) => {
    if (!changedLegs.has(li)) return leg;
    return legBlocked.has(li)
      ? { ...leg, waypoints: changedLegs.get(li), obstacleBlocked: true }
      : { ...leg, waypoints: changedLegs.get(li) };
  });
  return { legs: out, raised, blocked };
}

/** Label for the globe column: "<kind> <h> m". */
export function obstacleLabel(o, kindText = (k) => k) {
  return `${kindText(o.kind)} ${Math.round(o.heightM)} m`;
}

/**
 * What the way out from the takeoff point to a mission's first waypoint and
 * the way home from its last waypoint need. Each mission flies its own, so
 * this runs per mission after the route is split into batteries. The takeoff
 * end stays on the ground, so only the waypoint end can be lifted.
 * @returns {{ first: {needAglM:number, obstacleId:string}|null,
 *   last: {needAglM:number, obstacleId:string}|null }}
 */
export function transitNeeds(
  obstacles,
  takeoff,
  first,
  last,
  { groundOf = null, obstacleGroundOf = null } = {},
) {
  const out = { first: null, last: null };
  const list = normalizeObstacles(obstacles);
  if (!takeoff || !first || !last || !list.length) return out;
  for (const ob of list) {
    const m = metersPerDegree(ob.lat);
    const reach = ob.radiusM + OBSTACLE_HORIZONTAL_MARGIN_M;
    const t = xy(ob, m, takeoff.lon, takeoff.lat);
    const obGround = obstacleGroundOf ? obstacleGroundOf(ob) : null;
    const need = (w) => {
      const wg = groundOf ? groundOf(w) : null;
      const extra =
        Number.isFinite(obGround) && Number.isFinite(wg)
          ? Math.max(0, obGround - wg)
          : 0;
      return requiredAglM(ob) + extra;
    };
    const note = (key, w) => {
      const n = need(w);
      if (!out[key] || n > out[key].needAglM) {
        out[key] = { needAglM: n, obstacleId: ob.id };
      }
    };
    if (distToSegment(t, xy(ob, m, first.lon, first.lat)) <= reach) {
      note('first', first);
    }
    if (distToSegment(xy(ob, m, last.lon, last.lat), t) <= reach) {
      note('last', last);
    }
  }
  return out;
}
