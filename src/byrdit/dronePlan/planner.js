/**
 * Drone Flight Plan: flight geometry, overlap/GSD maths, terrain-relative
 * heights and the mission split. Pure functions (no Cesium, no DOM) so every
 * number is unit-testable in node.
 *
 * Flow:  planFlight(box, options)      -> legs of waypoints (lon/lat + AGL)
 *        assembleMissions(plan, ground) -> missions (<= 200 waypoints and
 *                                          <= battery time) with heights
 *                                          relative to the takeoff point
 */
import {
  applyObstacleClearance,
  normalizeObstacles,
  transitNeeds,
} from './obstacles.js';
import { DEFAULT_PRESET_ID, getPreset } from './presets.js';
import {
  DEFAULT_SHUTTER_DENOMINATOR,
  MIN_PLAN_SPEED_MS,
  floorTo,
  shutterDenominatorOrDefault,
  speedLimits,
} from './speed.js';
import {
  DEFAULT_OUTWARD_PITCH_DEG,
  MAX_OUTWARD_PITCH_DEG,
  MIN_OUTWARD_PITCH_DEG,
  ORBIT_STOP_S,
  OUTWARD_STOP_S,
  RING_MAX_AGL_M,
  angleRings,
  blockedSpanDeg,
  lookAtPitchDeg,
  normalizeBlocked,
  normalizeRingAngles,
  openArcBearings,
} from './orbitRings.js';
import {
  bearingDeg,
  groundDistanceM,
  lonSpanDeg,
  makeFrame,
  metersPerDegree,
  wrapLon,
  toDeg,
  toRad,
  wrapHeading,
} from './geo.js';

/** Hard height cap: 120 m, which is below the 400 ft (121.92 m) FAA limit. */
export const AGL_CAP_M = 120;
export const AGL_CAP_FT = 400;
export const FT_PER_M = 1 / 0.3048;
export const MIN_AGL_M = 10;
/** DJI Fly accepts at most 200 waypoints in one mission. */
export const MAX_WAYPOINTS_PER_MISSION = 200;
/** The DJI Fly default altitude limit above the takeoff point, metres. */
export const DJI_DEFAULT_HEIGHT_LIMIT_M = 120;
/** Refuse plans that would need more waypoints than this in total. */
export const MAX_WAYPOINTS_TOTAL = 12000;
export const MAX_MISSIONS = 60;
/** Speed of the climb/transit to the first waypoint and of the return home. */
export const TRANSIT_SPEED_MS = 8;
/** Takeoff, climb and landing overhead per mission, seconds. */
export const OVERHEAD_S = 45;
/** Time allowed for each turn between legs, seconds. */
export const TURN_S = 3;
/** Distance between waypoints on an interval-photo leg, metres. */
export const INTERVAL_WAYPOINT_STEP_M = 60;
/** Furthest waypoint from the takeoff point before the line-of-sight warning. */
export const VLOS_WARN_M = 500;
/** Ground change between neighbouring waypoints that bends the AGL between them. */
export const STEEP_SEGMENT_M = 25;
/** A takeoff pick may be at most this far from the box (nearest edge), metres. */
export const MAX_TAKEOFF_FROM_BOX_M = 1000;

export const PATTERNS = Object.freeze(['grid', 'double', 'orbit']);

/** Tallest tree / obstacle height an orbit assumes unless told otherwise, m. */
export const DEFAULT_OBSTACLE_HEIGHT_M = 15;
/** Vertical margin kept above the obstacle while flying over it, metres. */
export const OBSTACLE_MARGIN_M = 5;
/** A building orbit flies at least this far above the roof, metres. */
export const ROOF_CLEARANCE_M = 15;
/** Most orbit targets one plan carries. */
export const MAX_ORBIT_TARGETS = 12;

/**
 * The lowest AGL an orbit may fly: obstacle height plus the safety margin,
 * never below the planner's own minimum and never above the height cap.
 */
export function minOrbitAglM(obstacleHeightM) {
  const h = Number.isFinite(Number(obstacleHeightM))
    ? Math.max(0, Number(obstacleHeightM))
    : DEFAULT_OBSTACLE_HEIGHT_M;
  return Math.min(AGL_CAP_M, Math.max(MIN_AGL_M, h + OBSTACLE_MARGIN_M));
}

/**
 * Ring heights (m AGL) for one target. The shared rings are the starting
 * point; a target with a known roof (`roofHeightM`) raises each ring to at
 * least roof + ROOF_CLEARANCE_M. Every ring also keeps the obstacle floor
 * (`minOrbitAglM`), so the result is max(requested, roof + 15, obstacle + 5),
 * kept within MIN_AGL_M..AGL_CAP_M (duplicates dropped for roof targets).
 * `belowRoofClearance` is true when the cap leaves under ROOF_CLEARANCE_M
 * above the roof.
 */
export function targetRingHeights(target, ringsM, obstacleHeightM) {
  const floor = minOrbitAglM(obstacleHeightM);
  const roof = Number(target?.roofHeightM);
  const hasRoof =
    target?.roofHeightM != null && Number.isFinite(roof) && roof > 0;
  const need = hasRoof ? roof + ROOF_CLEARANCE_M : 0;
  const heights = [];
  for (const h of ringsM) {
    const v = round(clamp(Math.max(h, need, floor), MIN_AGL_M, AGL_CAP_M), 1);
    // Rings the roof raised onto one height are flown once; targets without a
    // roof keep the plan's rings as they are.
    if (!hasRoof || !heights.includes(v)) heights.push(v);
  }
  return { heights, belowRoofClearance: need > AGL_CAP_M + 1e-9 };
}

/**
 * Sightline maths for one orbit ring. The camera sits `ringAglM` up and
 * `radiusM` out, looking at the TOP of the target (`targetHeightM`). A tree
 * of `obstacleHeightM` at ground distance d from the target blocks that line
 * when the line is lower than the tree there. The line is at
 * target + (ring - target) * d / radius, so it clears every tree standing at
 * least `obstructionRadiusM` from the target; nearer trees are in the way.
 * `flyoverClearM` is how far the drone passes above the obstacle top.
 */
export function orbitClearance({
  ringAglM,
  radiusM,
  targetHeightM,
  obstacleHeightM,
}) {
  const rise = Math.max(1e-6, ringAglM - targetHeightM);
  const need = Math.max(0, obstacleHeightM - targetHeightM);
  return {
    flyoverClearM: round(ringAglM - obstacleHeightM, 1),
    obstructionRadiusM: round(Math.min(radiusM, (radiusM * need) / rise), 1),
    clearsFlyover: ringAglM >= obstacleHeightM + OBSTACLE_MARGIN_M - 1e-9,
  };
}
export const PHOTO_MODES = Object.freeze(['waypoint', 'interval']);

export const DEFAULT_OPTIONS = Object.freeze({
  presetId: DEFAULT_PRESET_ID,
  aglM: 80,
  frontOverlap: 80,
  sideOverlap: 70,
  pattern: 'grid',
  direction: 'auto',
  tiltPitchDeg: -60,
  speedMs: 5,
  photoMode: 'waypoint',
  shutterDenominator: DEFAULT_SHUTTER_DENOMINATOR,
  batteryMin: 25,
  maxWaypoints: MAX_WAYPOINTS_PER_MISSION,
  orbitRadiusM: null,
  orbitHeightsM: null,
  // Rings by viewing angle (degrees below the horizon) or by fixed heights.
  orbitRingMode: null,
  orbitAnglesDeg: null,
  // Building stops: one photo at the building, one facing directly away.
  orbitOutward: true,
  orbitOutwardPitchDeg: DEFAULT_OUTWARD_PITCH_DEG,
  lookAtPaths: null,
  orbitTargetHeightM: 3,
  obstacleHeightM: DEFAULT_OBSTACLE_HEIGHT_M,
  orbitTargets: null,
  obstacles: null,
  obstaclesDropped: 0,
  takeoff: null,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// A number from a value that may be unset: null, undefined and '' are NaN, not
// 0. Number(null) is 0, which used to turn an unset orbit radius into the 10 m
// minimum.
const optNumber = (v) => (v == null || v === '' ? NaN : Number(v));
const num = (v, fallback) => {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round = (v, digits = 6) => Number(v.toFixed(digits));

/**
 * Footprint and ground sample distance of one still at `aglM`.
 * `tiltDeg` is the camera tilt from straight down (0 = nadir). A tilted
 * footprint uses the NEAR edge for its width (the narrowest part), so the
 * overlap it gives is a floor, not an average.
 */
export function footprint(preset, aglM, tiltDeg = 0) {
  const w = preset.sensorWidthMm;
  const h = preset.sensorHeightMm;
  const f = preset.focalMm;
  const pitchMm = w / preset.imageWidthPx;
  if (!tiltDeg) {
    return {
      acrossM: (aglM * w) / f,
      alongM: (aglM * h) / f,
      gsdCm: (aglM * pitchMm * 100) / f,
    };
  }
  const tilt = toRad(tiltDeg);
  const halfV = Math.atan(h / (2 * f));
  const near = tilt - halfV;
  const far = tilt + halfV;
  if (far >= toRad(85)) {
    throw new RangeError('Camera tilt reaches the horizon');
  }
  const centreRange = aglM / Math.cos(tilt);
  return {
    acrossM: ((aglM / Math.cos(near)) * w) / f,
    alongM: aglM * (Math.tan(far) - Math.tan(near)),
    gsdCm: (centreRange * pitchMm * 100) / f,
  };
}

/** Spacing between flight lines and between photos along a line, metres. */
export function spacing(fp, frontOverlap, sideOverlap) {
  return {
    lineM: fp.acrossM * (1 - sideOverlap / 100),
    photoM: fp.alongM * (1 - frontOverlap / 100),
  };
}

/**
 * Keep the orbit targets that have a real position. A target is
 * `{ lon, lat, id?, label?, active?, heightM? }`; `active: false` keeps it in
 * the list but out of the flight.
 */
export function normalizeOrbitTargets(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    const lon = Number(t?.lon);
    const lat = Number(t?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    const h = optNumber(t.heightM);
    const radius = optNumber(t.radiusM);
    const roof = optNumber(t.roofHeightM);
    const blocked = normalizeBlocked(t.blocked);
    out.push({
      id: typeof t.id === 'string' && t.id ? t.id : `target-${out.length + 1}`,
      lon,
      lat,
      label: typeof t.label === 'string' ? t.label : '',
      source: typeof t.source === 'string' ? t.source : 'custom',
      active: t.active !== false,
      heightM: Number.isFinite(h) ? clamp(h, 0, 100) : null,
      // Building targets only: their own orbit radius and roof height.
      ...(t.radiusM != null && Number.isFinite(radius)
        ? { radiusM: clamp(radius, 10, 300) }
        : {}),
      ...(t.roofHeightM != null && Number.isFinite(roof) && roof > 0
        ? { roofHeightM: clamp(roof, 0, 300) }
        : {}),
      ...(typeof t.osmId === 'string' ? { osmId: t.osmId } : {}),
      ...(blocked ? { blocked } : {}),
      // Per-target outward photo switch; unset follows the plan setting.
      ...(typeof t.outward === 'boolean' ? { outward: t.outward } : {}),
    });
    if (out.length >= MAX_ORBIT_TARGETS) break;
  }
  return out;
}

/** Most look-at paths one plan carries, and most points in one. */
export const MAX_LOOKAT_PATHS = 6;
export const MAX_LOOKAT_POINTS = 200;
/** Default flight height of a look-at path, metres above ground. */
export const DEFAULT_LOOKAT_AGL_M = 40;

/**
 * Look-at paths: `{ id, label, active, targetId, aglM, points: [{lon, lat}] }`.
 * The drone flies the drawn route with the camera locked on the orbit target
 * `targetId`. A path needs two or more valid points.
 */
export function normalizeLookAtPaths(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const p of raw) {
    const points = (Array.isArray(p?.points) ? p.points : [])
      .map((q) => ({ lon: Number(q?.lon), lat: Number(q?.lat) }))
      .filter(
        (q) =>
          Number.isFinite(q.lon) &&
          Number.isFinite(q.lat) &&
          Math.abs(q.lon) <= 180 &&
          Math.abs(q.lat) <= 90,
      )
      .slice(0, MAX_LOOKAT_POINTS);
    if (points.length < 2) continue;
    const agl = p.aglM == null || p.aglM === '' ? NaN : Number(p.aglM);
    out.push({
      id: typeof p.id === 'string' && p.id ? p.id : `path-${out.length + 1}`,
      label: typeof p.label === 'string' ? p.label.slice(0, 80) : '',
      active: p.active !== false,
      targetId: typeof p.targetId === 'string' ? p.targetId : '',
      aglM: Number.isFinite(agl) ? clamp(agl, MIN_AGL_M, AGL_CAP_M) : null,
      points,
    });
    if (out.length >= MAX_LOOKAT_PATHS) break;
  }
  return out;
}

/**
 * Validate and clamp user options. Returns the clean options plus the notes
 * explaining anything that was changed.
 */
export function normalizeOptions(raw = {}, box = null) {
  const notes = [];
  // Only the known option names get through, so nothing a caller attaches to
  // the options can ride along into a plan, a file or a log line.
  const o = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (raw && raw[key] !== undefined) o[key] = raw[key];
  }
  const takeoff = raw?.takeoff;
  const lon = Number(takeoff?.lon);
  const lat = Number(takeoff?.lat);
  o.takeoff =
    takeoff &&
    typeof takeoff.lon === 'number' &&
    typeof takeoff.lat === 'number' &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
      ? { lon, lat }
      : null;
  const preset = getPreset(o.presetId) ?? getPreset(DEFAULT_PRESET_ID);
  o.presetId = preset.id;
  const requestedAgl = num(o.aglM, DEFAULT_OPTIONS.aglM);
  o.aglM = clamp(requestedAgl, MIN_AGL_M, AGL_CAP_M);
  if (requestedAgl > AGL_CAP_M) {
    notes.push({
      code: 'agl-capped',
      params: { requested: requestedAgl, cap: AGL_CAP_M },
    });
  }
  o.frontOverlap = clamp(num(o.frontOverlap, 80), 30, 95);
  o.sideOverlap = clamp(num(o.sideOverlap, 70), 30, 95);
  o.pattern = PATTERNS.includes(o.pattern) ? o.pattern : 'grid';
  o.photoMode = PHOTO_MODES.includes(o.photoMode) ? o.photoMode : 'waypoint';
  o.tiltPitchDeg = clamp(num(o.tiltPitchDeg, -60), -80, -45);
  o.speedMs = clamp(
    num(o.speedMs, preset.defaultSpeedMs),
    MIN_PLAN_SPEED_MS,
    preset.maxSpeedMs,
  );
  o.shutterDenominator = shutterDenominatorOrDefault(o.shutterDenominator);
  o.batteryMin = clamp(num(o.batteryMin, 25), 5, 60);
  o.maxWaypoints = Math.floor(
    clamp(
      num(o.maxWaypoints, MAX_WAYPOINTS_PER_MISSION),
      10,
      MAX_WAYPOINTS_PER_MISSION,
    ),
  );
  if (o.direction !== 'auto') {
    const named = { ew: 0, ns: 90 };
    const deg = o.direction in named ? named[o.direction] : Number(o.direction);
    o.direction = Number.isFinite(deg) ? ((deg % 180) + 180) % 180 : 'auto';
  }
  o.orbitTargetHeightM = clamp(num(o.orbitTargetHeightM, 3), 0, 100);
  o.obstacleHeightM = clamp(
    num(o.obstacleHeightM, DEFAULT_OBSTACLE_HEIGHT_M),
    0,
    AGL_CAP_M - OBSTACLE_MARGIN_M,
  );
  o.orbitTargets = normalizeOrbitTargets(o.orbitTargets);
  o.lookAtPaths = normalizeLookAtPaths(o.lookAtPaths);
  o.orbitOutward = o.orbitOutward !== false;
  o.orbitOutwardPitchDeg = clamp(
    num(o.orbitOutwardPitchDeg, DEFAULT_OUTWARD_PITCH_DEG),
    MIN_OUTWARD_PITCH_DEG,
    MAX_OUTWARD_PITCH_DEG,
  );
  o.obstacles = normalizeObstacles(o.obstacles);
  o.obstaclesDropped = clamp(Math.round(num(o.obstaclesDropped, 0)), 0, 1e6);
  if (box) {
    const m = metersPerDegree((box.south + box.north) / 2);
    const side = Math.max(
      lonSpanDeg(box.west, box.east) * m.lon,
      (box.north - box.south) * m.lat,
    );
    const defaultRadius = clamp(side / 2, 15, 120);
    o.orbitRadiusM = clamp(num(o.orbitRadiusM, defaultRadius), 10, 300);
  } else {
    o.orbitRadiusM = clamp(num(o.orbitRadiusM, 40), 10, 300);
  }
  const heights = Array.isArray(o.orbitHeightsM)
    ? o.orbitHeightsM
        .filter((h) => h != null && h !== '')
        .map(Number)
        .filter(Number.isFinite)
    : [];
  // Rings are set by viewing angle unless fixed heights were asked for (a
  // saved plan or caller that passes heights and no mode keeps its heights).
  o.orbitRingMode =
    o.orbitRingMode === 'angles' || o.orbitRingMode === 'heights'
      ? o.orbitRingMode
      : heights.length
        ? 'heights'
        : 'angles';
  o.orbitAnglesDeg = normalizeRingAngles(o.orbitAnglesDeg);
  // Every ring flies at least obstacle + margin above ground, so the drone
  // passes over the trees; a ring asked for lower is raised and says so.
  const floorAgl = minOrbitAglM(o.obstacleHeightM);
  const requestedRings = (heights.length ? heights : [o.aglM / 2, o.aglM])
    .map((h) => clamp(h, MIN_AGL_M, AGL_CAP_M))
    .slice(0, 6);
  const rings = requestedRings.map((h) => Math.max(h, floorAgl));
  if (
    o.orbitRingMode === 'heights' &&
    rings.some((h, i) => h !== requestedRings[i])
  ) {
    notes.push({
      code: 'orbit-raised-for-obstacles',
      params: {
        minAglM: Math.round(floorAgl),
        obstacleHeightM: Math.round(o.obstacleHeightM),
      },
    });
  }
  o.orbitHeightsM = rings;
  return { options: o, preset, notes };
}

function clipLine(vOffset, ux, uy, vx, vy, hw, hh) {
  // The line p(t) = vOffset * v + t * u, clipped to [-hw, hw] x [-hh, hh].
  let t0 = -Infinity;
  let t1 = Infinity;
  const axes = [
    [vOffset * vx, ux, hw],
    [vOffset * vy, uy, hh],
  ];
  for (const [base, dir, half] of axes) {
    if (Math.abs(dir) < 1e-12) {
      if (Math.abs(base) > half) return null;
      continue;
    }
    const a = (-half - base) / dir;
    const b = (half - base) / dir;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 - t0 > 0.5 ? [t0, t1] : null;
}

/**
 * One pass of parallel flight lines over the box, as legs of XY points.
 * `lookAheadM` moves each line backwards along its travel direction so a
 * forward-tilted camera sees the box, not the ground beyond it.
 */
function gridLegs({ hw, hh, angleDeg, lineM, lookAheadM }) {
  const th = toRad(angleDeg);
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const vx = -uy;
  const vy = ux;
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => x * vx + y * vy);
  const vMin = Math.min(...corners);
  const vMax = Math.max(...corners);
  const span = vMax - vMin;
  const count = Math.max(1, Math.ceil(span / lineM - 1e-9));
  const legs = [];
  for (let i = 0; i < count; i += 1) {
    const v = vMin + ((i + 0.5) * span) / count;
    const clip = clipLine(v, ux, uy, vx, vy, hw, hh);
    if (!clip) continue;
    let [t0, t1] = clip;
    let dir = 1;
    if (legs.length % 2 === 1) {
      [t0, t1] = [t1, t0];
      dir = -1;
    }
    const sx = v * vx + t0 * ux - lookAheadM * dir * ux;
    const sy = v * vy + t0 * uy - lookAheadM * dir * uy;
    const ex = v * vx + t1 * ux - lookAheadM * dir * ux;
    const ey = v * vy + t1 * uy - lookAheadM * dir * uy;
    legs.push({ start: { x: sx, y: sy }, end: { x: ex, y: ey } });
  }
  return legs;
}

/** Evenly spaced points along a segment, no further apart than `maxStepM`. */
function subdivide(start, end, maxStepM, minPoints = 2) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const pieces = Math.max(minPoints - 1, Math.ceil(length / maxStepM - 1e-9));
  const points = [];
  for (let k = 0; k <= pieces; k += 1) {
    const f = pieces === 0 ? 0 : k / pieces;
    points.push({
      x: start.x + (end.x - start.x) * f,
      y: start.y + (end.y - start.y) * f,
    });
  }
  return { points, length };
}

/**
 * Ground distance in metres from a point to the nearest edge of the box
 * (0 when it is inside).
 */
export function takeoffDistanceFromBoxM(box, point) {
  const span = lonSpanDeg(box.west, box.east);
  const center = {
    lon: wrapLon(box.west + span / 2),
    lat: (box.south + box.north) / 2,
  };
  const frame = makeFrame(center.lon, center.lat);
  const m = metersPerDegree(center.lat);
  const hw = (span * m.lon) / 2;
  const hh = ((box.north - box.south) * m.lat) / 2;
  const q = frame.toXY(point.lon, point.lat);
  return Math.hypot(
    Math.max(Math.abs(q.x) - hw, 0),
    Math.max(Math.abs(q.y) - hh, 0),
  );
}

/**
 * Plan the flight geometry for a degrees box. No terrain yet: every waypoint
 * carries its height ABOVE GROUND; assembleMissions() turns that into heights
 * relative to the takeoff point once ground elevations are known.
 * @param {{west:number,south:number,east:number,north:number}} box
 * @param {object} rawOptions See DEFAULT_OPTIONS.
 * @returns {object} The plan, or `{ error, message }` when it is unplannable.
 */
export function planFlight(box, rawOptions = {}) {
  const { options, preset, notes } = normalizeOptions(rawOptions, box);
  if (
    !box ||
    ![box.west, box.south, box.east, box.north].every(Number.isFinite) ||
    !(lonSpanDeg(box.west, box.east) > 0) ||
    lonSpanDeg(box.west, box.east) > 180 ||
    box.north <= box.south
  ) {
    return { error: 'bad-box', message: 'Draw a box on the globe first' };
  }
  const span = lonSpanDeg(box.west, box.east);
  const center = {
    lon: wrapLon(box.west + span / 2),
    lat: (box.south + box.north) / 2,
  };
  const frame = makeFrame(center.lon, center.lat);
  const m = metersPerDegree(center.lat);
  const hw = (span * m.lon) / 2;
  const hh = ((box.north - box.south) * m.lat) / 2;
  let takeoff =
    options.takeoff &&
    Number.isFinite(options.takeoff.lon) &&
    Number.isFinite(options.takeoff.lat)
      ? { lon: options.takeoff.lon, lat: options.takeoff.lat, custom: true }
      : { ...center, custom: false };
  if (takeoff.custom) {
    // A takeoff far from the box makes every mission a long transit: refuse it
    // and take off from the box centre instead, saying so.
    const away = takeoffDistanceFromBoxM(box, takeoff);
    if (away > MAX_TAKEOFF_FROM_BOX_M) {
      notes.push({
        code: 'takeoff-too-far',
        params: {
          distanceM: Math.round(away),
          limitM: MAX_TAKEOFF_FROM_BOX_M,
        },
      });
      takeoff = { ...center, custom: false };
    }
  }

  const legs = [];
  let waypointCount = 0;
  let nextWaypointId = 0;
  const addLeg = (leg) => {
    waypointCount += leg.waypoints.length;
    legs.push(leg);
  };
  const toWaypoint = (p, extra) => {
    const ll = frame.toLonLat(p.x, p.y);
    return {
      id: nextWaypointId++,
      lon: round(ll.lon, 8),
      lat: round(ll.lat, 8),
      aglM: extra.aglM,
      pitchDeg: extra.pitchDeg,
      headingDeg: extra.headingDeg ?? null,
      photo: extra.photo,
      ...(extra.dwellS ? { dwellS: extra.dwellS } : {}),
      ...(extra.outwardHeadingDeg != null
        ? {
            outwardHeadingDeg: extra.outwardHeadingDeg,
            outwardPitchDeg: extra.outwardPitchDeg,
          }
        : {}),
    };
  };

  const agl = options.aglM;
  let fpInfo;
  let spacingInfo = null;
  let photoSpacingM;
  let passCount = 0;

  let orbitInfo = null;
  if (options.pattern === 'orbit') {
    const allTargets = options.orbitTargets ?? [];
    const activePaths = (options.lookAtPaths ?? []).filter((x) => x.active);
    // No target list: one orbit on the centre of the box, as before (unless
    // look-at paths are all that was asked for).
    const active = allTargets.filter((t) => t.active);
    const stops = allTargets.length
      ? active
      : activePaths.length
        ? []
        : [{ id: 'centre', ...center, heightM: null, label: '' }];
    if (!stops.length && !activePaths.length) {
      return {
        error: 'no-orbit-targets',
        message: 'Turn on at least one orbit target',
      };
    }
    const obstacle = options.obstacleHeightM;
    const floorAgl = minOrbitAglM(obstacle);
    const angleMode = options.orbitRingMode === 'angles';
    const ringCapM = Math.min(AGL_CAP_M, RING_MAX_AGL_M);
    const aimOf = (stop) => stop.heightM ?? options.orbitTargetHeightM;
    const roofOf = (stop) => {
      const roof = Number(stop?.roofHeightM);
      return stop?.roofHeightM != null && Number.isFinite(roof) && roof > 0
        ? roof
        : 0;
    };
    // The rings of one stop: each has its own radius (an angle ring is
    // widened when the obstacle or roof floor forces it higher) and height.
    const ringsOf = (stop) => {
      const targetH = aimOf(stop);
      const radius = stop.radiusM ?? options.orbitRadiusM;
      if (angleMode) {
        const need = roofOf(stop) ? roofOf(stop) + ROOF_CLEARANCE_M : 0;
        const rings = angleRings({
          aimM: targetH,
          radiusM: radius,
          anglesDeg: options.orbitAnglesDeg,
          floorAglM: Math.min(ringCapM, Math.max(floorAgl, need)),
          capAglM: ringCapM,
        });
        return { rings, belowRoofClearance: need > ringCapM + 1e-9 };
      }
      const { heights, belowRoofClearance } = targetRingHeights(
        stop,
        options.orbitHeightsM,
        obstacle,
      );
      const rings = heights.map((aglM) => ({
        angleDeg: null,
        radiusM: radius,
        aglM,
        pitchDeg: round(
          -clamp(toDeg(Math.atan2(Math.max(1, aglM - targetH), radius)), 5, 89),
          1,
        ),
        widened: false,
        capped: false,
        steepened: false,
      }));
      return { rings, belowRoofClearance };
    };
    // Between targets the drone climbs to this and crosses at it, so it
    // always passes over the trees at obstacle + margin or higher.
    const stopRings = new Map(stops.map((stop) => [stop, ringsOf(stop)]));
    const pathAgl = (path, target) =>
      round(
        clamp(
          Math.max(
            path.aglM ?? DEFAULT_LOOKAT_AGL_M,
            floorAgl,
            target && roofOf(target) ? roofOf(target) + ROOF_CLEARANCE_M : 0,
          ),
          MIN_AGL_M,
          AGL_CAP_M,
        ),
        1,
      );
    const pathTarget = (path) =>
      stops.find((x) => x.id === path.targetId) ?? stops[0] ?? null;
    const transitAgl = Math.max(
      floorAgl,
      ...[...stopRings.values()].flatMap((r) => r.rings.map((x) => x.aglM)),
      ...activePaths.map((x) => pathAgl(x, pathTarget(x))),
    );
    const toTakeoff = frame.toXY(takeoff.lon, takeoff.lat);
    let tooLarge = false;
    let gsdMin = Infinity;
    let arcMax = Infinity;
    const ringInfo = [];
    let prevEnd = null;
    const targetInfo = [];
    const lookAtInfo = [];
    let widenedCount = 0;
    let angleChangedCount = 0;
    const headingTo = (from, to) =>
      round(wrapHeading(toDeg(Math.atan2(to.x - from.x, to.y - from.y))), 1);
    // Climb where the last orbit ended, cross at transit height and come
    // down on the first point of the next one.
    const addHop = (first, pitch, heading) => {
      const hop = [];
      if (prevEnd.aglM < transitAgl - 0.5) {
        hop.push(
          toWaypoint(prevEnd.p, {
            aglM: transitAgl,
            pitchDeg: prevEnd.pitchDeg,
            headingDeg: prevEnd.headingDeg,
            photo: false,
          }),
        );
      }
      hop.push(
        toWaypoint(first, {
          aglM: transitAgl,
          pitchDeg: pitch,
          headingDeg: heading,
          photo: false,
        }),
      );
      addLeg({
        id: legs.length,
        passId: 0,
        kind: 'transit',
        pitchDeg: pitch,
        photoMode: 'waypoint',
        waypoints: hop,
        lengthM: Math.hypot(first.x - prevEnd.p.x, first.y - prevEnd.p.y),
        photoCount: 0,
      });
    };
    for (const stop of stops) {
      if (tooLarge) break;
      const targetH = aimOf(stop);
      const { rings, belowRoofClearance } = stopRings.get(stop);
      const c = frame.toXY(stop.lon, stop.lat);
      const from = prevEnd ? prevEnd.p : toTakeoff;
      const startAngle = Math.atan2(from.y - c.y, from.x - c.x);
      const firstLeg = legs.length;
      const blocked = normalizeBlocked(stop.blocked);
      const blockedSpan = blockedSpanDeg(blocked);
      if (blocked && blockedSpan >= 350) {
        notes.push({
          code: 'orbit-blocked-all',
          params: { label: stop.label || stop.id },
        });
        continue;
      }
      const outward =
        stop.outward ?? (stop.source === 'building' && options.orbitOutward);
      // Which way the first ring of an open arc runs: from the end nearest
      // the drone, so the hop does not cross the blocked sector.
      let arcForward = true;
      rings.forEach((ring, ringIndex) => {
        if (tooLarge) return;
        const radius = ring.radiusM;
        const ringAgl = ring.aglM;
        const pitch = ring.pitchDeg;
        const dz = Math.max(1, ringAgl - targetH);
        const range = Math.hypot(radius, dz);
        const acrossM = (range * preset.sensorWidthMm) / preset.focalMm;
        const arcM = acrossM * (1 - options.frontOverlap / 100);
        const gsd =
          (range * (preset.sensorWidthMm / preset.imageWidthPx) * 100) /
          preset.focalMm;
        gsdMin = Math.min(gsdMin, gsd);
        arcMax = Math.min(arcMax, arcM);
        let points;
        if (blocked) {
          const openLenM = (2 * Math.PI * radius * (360 - blockedSpan)) / 360;
          const n = Math.max(3, Math.ceil(openLenM / arcM) + 1);
          const at = (bearing) => ({
            x: c.x + radius * Math.sin(toRad(bearing)),
            y: c.y + radius * Math.cos(toRad(bearing)),
          });
          let bearings = openArcBearings(blocked, n);
          if (ringIndex === 0) {
            const dFirst = Math.hypot(
              at(bearings[0]).x - from.x,
              at(bearings[0]).y - from.y,
            );
            const dLast = Math.hypot(
              at(bearings[n - 1]).x - from.x,
              at(bearings[n - 1]).y - from.y,
            );
            arcForward = dFirst <= dLast;
          }
          if ((ringIndex % 2 === 0) !== arcForward)
            bearings = bearings.reverse();
          points = bearings.map(at);
        } else {
          const n = Math.max(12, Math.ceil((2 * Math.PI * radius) / arcM));
          const sign = ringIndex % 2 === 0 ? 1 : -1;
          points = [];
          for (let k = 0; k < n; k += 1) {
            const a = startAngle + sign * ((2 * Math.PI * k) / n);
            points.push({
              x: c.x + radius * Math.cos(a),
              y: c.y + radius * Math.sin(a),
            });
          }
        }
        if (waypointCount + points.length > MAX_WAYPOINTS_TOTAL) {
          tooLarge = true;
          return;
        }
        if (ringIndex === 0 && prevEnd) {
          addHop(points[0], pitch, headingTo(points[0], c));
        }
        const waypoints = points.map((p) => {
          const heading = headingTo(p, c);
          return toWaypoint(p, {
            aglM: ringAgl,
            pitchDeg: pitch,
            headingDeg: heading,
            photo: true,
            // Stop at the point, turn to the target and shoot; with an
            // outward photo the aircraft then turns half way round.
            dwellS: outward ? OUTWARD_STOP_S : ORBIT_STOP_S,
            ...(outward
              ? {
                  outwardHeadingDeg: round(wrapHeading(heading + 180), 1),
                  outwardPitchDeg: options.orbitOutwardPitchDeg,
                }
              : {}),
          });
        });
        let length = 0;
        for (let k = 1; k < points.length; k += 1) {
          length += Math.hypot(
            points[k].x - points[k - 1].x,
            points[k].y - points[k - 1].y,
          );
        }
        addLeg({
          id: legs.length,
          passId: 0,
          kind: 'orbit',
          targetId: stop.id,
          pitchDeg: pitch,
          photoMode: 'waypoint',
          waypoints,
          lengthM: length,
          photoCount: waypoints.length * (outward ? 2 : 1),
        });
        const last = points[points.length - 1];
        prevEnd = {
          p: last,
          aglM: ringAgl,
          pitchDeg: pitch,
          headingDeg: headingTo(last, c),
        };
        if (ring.widened) widenedCount += 1;
        if (ring.capped || ring.steepened) angleChangedCount += 1;
        // The first target's rings are the plan's headline; a building
        // target with its own radius or rings adds its own entries.
        if (
          stop === stops[0] ||
          stop.radiusM != null ||
          stop.roofHeightM != null
        ) {
          ringInfo.push({
            targetId: stop.id,
            aglM: ringAgl,
            radiusM: radius,
            angleDeg: ring.angleDeg,
            widened: ring.widened,
            capped: ring.capped || ring.steepened,
            pitchDeg: pitch,
            ...orbitClearance({
              ringAglM: ringAgl,
              radiusM: radius,
              targetHeightM: targetH,
              obstacleHeightM: obstacle,
            }),
          });
        }
      });
      targetInfo.push({
        id: stop.id,
        lon: stop.lon,
        lat: stop.lat,
        label: stop.label ?? '',
        heightM: targetH,
        radiusM: stop.radiusM ?? options.orbitRadiusM,
        ringsAglM: rings.map((r) => r.aglM),
        ringRadiiM: rings.map((r) => r.radiusM),
        outward: Boolean(outward),
        ...(blocked ? { blocked } : {}),
        ...(stop.roofHeightM != null
          ? { roofHeightM: stop.roofHeightM, belowRoofClearance }
          : {}),
        firstLeg,
      });
    }
    // Look-at paths: fly the drawn route with the camera locked on a target.
    for (const path of activePaths) {
      if (tooLarge) break;
      const target = pathTarget(path);
      if (!target) {
        notes.push({
          code: 'lookat-no-target',
          params: { label: path.label || path.id },
        });
        continue;
      }
      const aim = aimOf(target);
      const agl = pathAgl(path, target);
      const tc = frame.toXY(target.lon, target.lat);
      const xy = path.points.map((q) => frame.toXY(q.lon, q.lat));
      const distOf = (q) => Math.hypot(q.x - tc.x, q.y - tc.y);
      // Photo spacing from the middle distance to the target, so the overlap
      // setting holds on average along the route.
      const dists = xy.map(distOf).sort((x, y) => x - y);
      const midRange = Math.hypot(
        dists[Math.floor(dists.length / 2)],
        agl - aim,
      );
      const stepM = clamp(
        ((midRange * preset.sensorWidthMm) / preset.focalMm) *
          (1 - options.frontOverlap / 100),
        2,
        60,
      );
      const pts = [xy[0]];
      let length = 0;
      for (let i = 1; i < xy.length; i += 1) {
        const seg = subdivide(xy[i - 1], xy[i], stepM);
        length += seg.length;
        pts.push(...seg.points.slice(1));
      }
      if (waypointCount + pts.length > MAX_WAYPOINTS_TOTAL) {
        tooLarge = true;
        break;
      }
      let lastHeading = 0;
      const wps = pts.map((q) => {
        const d = distOf(q);
        if (d > 0.5) lastHeading = headingTo(q, tc);
        const pitch = round(lookAtPitchDeg(agl, aim, d), 1);
        return toWaypoint(q, {
          aglM: agl,
          pitchDeg: pitch,
          headingDeg: lastHeading,
          photo: true,
          dwellS: ORBIT_STOP_S,
        });
      });
      if (prevEnd) addHop(pts[0], wps[0].pitchDeg, wps[0].headingDeg);
      const firstLeg = legs.length;
      addLeg({
        id: legs.length,
        passId: 0,
        kind: 'lookat',
        targetId: target.id,
        pathId: path.id,
        pitchDeg: wps[0].pitchDeg,
        photoMode: 'waypoint',
        waypoints: wps,
        lengthM: length,
        photoCount: wps.length,
      });
      const endP = pts[pts.length - 1];
      const endW = wps[wps.length - 1];
      prevEnd = {
        p: endP,
        aglM: agl,
        pitchDeg: endW.pitchDeg,
        headingDeg: endW.headingDeg,
      };
      const range0 = Math.hypot(distOf(pts[0]), agl - aim);
      const gsd =
        (range0 * (preset.sensorWidthMm / preset.imageWidthPx) * 100) /
        preset.focalMm;
      gsdMin = Math.min(gsdMin, gsd);
      arcMax = Math.min(arcMax, stepM);
      lookAtInfo.push({
        id: path.id,
        label: path.label,
        targetId: target.id,
        aglM: agl,
        waypointCount: wps.length,
        lengthM: round(length, 1),
        firstLeg,
      });
    }
    if (tooLarge) {
      return { error: 'too-large', message: 'Plan needs too many waypoints' };
    }
    if (!legs.length) {
      if (activePaths.length && !stops.length) {
        return {
          error: 'no-orbit-targets',
          message: 'Turn on at least one orbit target for the look-at path',
        };
      }
      if (notes.some((n) => n.code === 'orbit-blocked-all')) {
        return {
          error: 'orbit-blocked-all',
          message: 'The blocked sector leaves no open arc to fly',
          notes,
        };
      }
      return { error: 'empty', message: 'Box is too small to plan a flight' };
    }
    if (widenedCount) {
      notes.push({
        code: 'orbit-ring-widened',
        params: { count: widenedCount },
      });
    }
    if (angleChangedCount) {
      notes.push({
        code: 'orbit-angle-changed',
        params: { count: angleChangedCount, capM: ringCapM },
      });
    }
    fpInfo = {
      acrossM: 0,
      alongM: 0,
      gsdCm: Number.isFinite(gsdMin) ? gsdMin : 0,
    };
    photoSpacingM = Number.isFinite(arcMax) ? arcMax : 0;
    passCount = 1;
    orbitInfo = {
      obstacleHeightM: obstacle,
      marginM: OBSTACLE_MARGIN_M,
      minAglM: floorAgl,
      transitAglM: transitAgl,
      ringMode: options.orbitRingMode,
      rings: ringInfo,
      targets: targetInfo,
      lookAt: lookAtInfo,
    };
  } else {
    const passes =
      options.pattern === 'double'
        ? [
            {
              tiltDeg: 90 + options.tiltPitchDeg,
              pitch: options.tiltPitchDeg,
              turn: 0,
            },
            {
              tiltDeg: 90 + options.tiltPitchDeg,
              pitch: options.tiltPitchDeg,
              turn: 90,
            },
          ]
        : [{ tiltDeg: 0, pitch: -90, turn: 0 }];
    let baseAngle;
    if (options.direction === 'auto') baseAngle = hw >= hh ? 0 : 90;
    else baseAngle = options.direction;
    fpInfo = footprint(preset, agl, passes[0].tiltDeg);
    spacingInfo = spacing(fpInfo, options.frontOverlap, options.sideOverlap);
    photoSpacingM = spacingInfo.photoM;
    passCount = passes.length;
    for (let p = 0; p < passes.length; p += 1) {
      const pass = passes[p];
      const fp = footprint(preset, agl, pass.tiltDeg);
      const sp = spacing(fp, options.frontOverlap, options.sideOverlap);
      const lookAhead = pass.tiltDeg ? agl * Math.tan(toRad(pass.tiltDeg)) : 0;
      const lines = gridLegs({
        hw,
        hh,
        angleDeg: baseAngle + pass.turn,
        lineM: sp.lineM,
        lookAheadM: lookAhead,
      });
      for (const line of lines) {
        const interval = options.photoMode === 'interval';
        const { points, length } = interval
          ? subdivide(line.start, line.end, INTERVAL_WAYPOINT_STEP_M)
          : subdivide(line.start, line.end, sp.photoM);
        if (waypointCount + points.length > MAX_WAYPOINTS_TOTAL) {
          return {
            error: 'too-large',
            message:
              'Plan needs too many waypoints; shrink the box or lower the overlap',
          };
        }
        addLeg({
          id: legs.length,
          passId: p,
          kind: 'grid',
          pitchDeg: pass.pitch,
          photoMode: options.photoMode,
          waypoints: points.map((pt) =>
            toWaypoint(pt, {
              aglM: agl,
              pitchDeg: pass.pitch,
              headingDeg: null,
              photo: !interval,
            }),
          ),
          lengthM: length,
          photoCount: interval
            ? Math.floor(length / sp.photoM + 1e-9) + 1
            : points.length,
          photoSpacingM: sp.photoM,
        });
      }
    }
  }

  if (!legs.length) {
    return { error: 'empty', message: 'Box is too small to plan a flight' };
  }

  // Speed: the camera needs time between frames (photo spacing / minimum
  // interval) and the picture must not smear while the shutter is open (blur
  // limit from the shutter type and speed), whatever speed the user asked for.
  // The result is rounded DOWN and never raised to a floor: a floor above the
  // camera's limit would fly faster than the camera can keep up with.
  const limits = speedLimits({
    preset,
    photoSpacingM,
    gsdCm: fpInfo.gsdCm,
    shutterDenominator: options.shutterDenominator,
  });
  let speedMs = options.speedMs;
  let speedLimitedBy = null;
  if (limits.limitMs < speedMs) {
    speedMs = limits.limitMs;
    speedLimitedBy = limits.limitedBy === 'blur' ? 'blur' : 'camera';
  }
  speedMs = Math.max(MIN_PLAN_SPEED_MS, floorTo(speedMs, 0.01));
  if (speedLimitedBy) {
    const code =
      speedLimitedBy === 'blur' ? 'speed-blur-limited' : 'speed-camera-limited';
    notes.push({
      code,
      params: {
        requested: options.speedMs,
        limited: speedMs,
        shutter: options.shutterDenominator,
      },
    });
  }
  if (limits.limitMs < MIN_PLAN_SPEED_MS) {
    // Even the slowest planned speed is faster than the camera allows.
    notes.push({
      code: 'speed-below-minimum',
      params: { limitMs: round(limits.limitMs, 3), minMs: MIN_PLAN_SPEED_MS },
    });
  }

  const allWaypoints = legs.flatMap((leg) => leg.waypoints);
  const farthest = allWaypoints.reduce(
    (max, w) => Math.max(max, groundDistanceM(takeoff, w)),
    0,
  );
  if (farthest > VLOS_WARN_M) {
    notes.push({ code: 'vlos', params: { distanceM: Math.round(farthest) } });
  }

  return {
    options,
    preset,
    box,
    center,
    frame,
    takeoff,
    legs,
    waypointCount,
    footprint: fpInfo,
    orbit: orbitInfo,
    spacing: spacingInfo,
    passCount,
    speedMs,
    speedLimitedBy,
    speedLimits: limits,
    gsdCm: fpInfo.gsdCm,
    notes,
  };
}

/** A waypoint that is only a place to stand: no photo, no outward turn. */
function withoutPhoto(w) {
  const out = { ...w, photo: false };
  delete out.outwardHeadingDeg;
  delete out.outwardPitchDeg;
  delete out.dwellS;
  return out;
}

function segmentLength(a, b) {
  return Math.hypot(
    groundDistanceM(a, b),
    (b.relHeightM ?? 0) - (a.relHeightM ?? 0),
  );
}

/**
 * Distance and time for one mission: climb and transit to the first waypoint,
 * the route, and the return to the takeoff point.
 */
export function estimateMission(waypoints, takeoff, speedMs, legCount = 1) {
  if (!waypoints.length) {
    return { distanceM: 0, routeM: 0, durationS: 0 };
  }
  const home = { lon: takeoff.lon, lat: takeoff.lat, relHeightM: 0 };
  let routeM = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    routeM += segmentLength(waypoints[i - 1], waypoints[i]);
  }
  const outM = segmentLength(home, waypoints[0]);
  const backM = segmentLength(waypoints[waypoints.length - 1], home);
  // Stops that turn the aircraft (orbit points with a photo facing away) cost
  // time on top of the flying.
  const dwellS = waypoints.reduce((sum, w) => sum + (w.dwellS ?? 0), 0);
  const durationS =
    routeM / speedMs +
    (outM + backM) / TRANSIT_SPEED_MS +
    OVERHEAD_S +
    TURN_S * Math.max(0, legCount - 1) +
    dwellS;
  return { distanceM: routeM + outM + backM, routeM, durationS };
}

/**
 * Turn a plan plus ground elevations into missions.
 * @param {object} plan Result of planFlight().
 * @param {{ takeoffM: number, wpM: number[], known: boolean }} ground
 *   `wpM[waypoint.id]` is the ground elevation under each waypoint and
 *   `takeoffM` the elevation at the takeoff point (same datum).
 */
export function assembleMissions(plan, ground) {
  const { options, preset, takeoff, speedMs } = plan;
  const warnings = [...plan.notes];
  const known = ground?.known === true;
  if (!known) warnings.push({ code: 'terrain-unknown', params: {} });
  // Per-obstacle heights: lift every stretch that passes a column, and flag
  // the ones the height cap cannot lift (drawn red on the globe).
  const readM = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cleared = applyObstacleClearance(plan.legs, options.obstacles, {
    capM: AGL_CAP_M,
    // Ground under each waypoint and under each column, from the terrain
    // read (never from the 3D tiles): a column on higher ground needs the
    // difference added on top.
    groundOf: known ? (w) => readM(ground.wpM?.[w.id]) : null,
    obstacleGroundOf: known ? (o) => readM(ground.obstacleM?.[o.id]) : null,
  });
  const planLegs = cleared.legs;
  if (cleared.raised) {
    warnings.push({
      code: 'obstacle-raised',
      params: { count: cleared.raised },
    });
  }
  if (cleared.blocked.length) {
    warnings.push({
      code: 'obstacle-blocked',
      params: {
        count: cleared.blocked.length,
        needM: Math.round(Math.max(...cleared.blocked.map((b) => b.needAglM))),
        capM: AGL_CAP_M,
      },
    });
  }
  if (options.obstaclesDropped > 0) {
    warnings.push({
      code: 'obstacle-list-cut',
      params: { count: options.obstaclesDropped },
    });
  }
  const takeoffM = known ? ground.takeoffM : 0;

  // A waypoint the terrain gave no height for takes the nearest read height
  // before it in the route (never the takeoff height, which can be far from
  // the ground there) and is counted, so the plan can say it is a guess.
  // A gap at the very start of the route takes the first height read after it.
  const firstRead = known
    ? planLegs
        .flatMap((leg) => leg.waypoints)
        .map((w) => ground.wpM[w.id])
        .find((g) => typeof g === 'number' && Number.isFinite(g))
    : undefined;
  let lastGroundM = firstRead ?? takeoffM;
  let missing = 0;
  const legs = planLegs.map((leg) => ({
    ...leg,
    waypoints: leg.waypoints.map((w) => {
      const g = known ? ground.wpM[w.id] : 0;
      const read = typeof g === 'number' && Number.isFinite(g);
      if (read) lastGroundM = g;
      else if (known) missing += 1;
      const groundM = read ? g : lastGroundM;
      return {
        ...w,
        groundM,
        groundEstimated: !read && known,
        relHeightM: round(groundM + w.aglM - takeoffM, 1),
      };
    }),
  }));
  if (missing) {
    warnings.push({ code: 'terrain-partial', params: { count: missing } });
  }
  const terrainComplete = known && missing === 0;

  const rel = legs.flatMap((leg) => leg.waypoints.map((w) => w.relHeightM));
  const grounds = legs.flatMap((leg) => leg.waypoints.map((w) => w.groundM));
  const maxRel = Math.max(...rel);
  const minRel = Math.min(...rel);
  const terrainRangeM = known
    ? Math.max(...grounds, takeoffM) - Math.min(...grounds, takeoffM)
    : 0;
  if (maxRel > DJI_DEFAULT_HEIGHT_LIMIT_M) {
    warnings.push({
      code: 'rel-height-over-limit',
      params: {
        maxRelM: Math.round(maxRel),
        limitM: DJI_DEFAULT_HEIGHT_LIMIT_M,
        terrainRangeM: Math.round(terrainRangeM),
      },
    });
  }
  if (minRel < 2) {
    warnings.push({
      code: 'below-takeoff',
      params: { minRelM: Math.round(minRel * 10) / 10 },
    });
  }
  let steep = 0;
  for (const leg of legs) {
    for (let i = 1; i < leg.waypoints.length; i += 1) {
      if (
        Math.abs(leg.waypoints[i].groundM - leg.waypoints[i - 1].groundM) >
        STEEP_SEGMENT_M
      ) {
        steep += 1;
      }
    }
  }
  if (steep) warnings.push({ code: 'steep-segment', params: { count: steep } });

  const budgetS = options.batteryMin * 60;
  const missions = [];
  let current = [];
  let overBudget = false;
  let tooMany = false;
  const flatten = (list) => list.flatMap((leg) => leg.waypoints);
  const feasible = (list) => {
    const wps = flatten(list);
    if (wps.length > options.maxWaypoints) return false;
    return (
      estimateMission(wps, takeoff, speedMs, list.length).durationS <= budgetS
    );
  };
  const close = () => {
    if (current.length) missions.push(current);
    current = [];
    // Past this many the plan cannot be flown anyway: stop splitting rather
    // than build thousands of missions.
    if (missions.length > MAX_MISSIONS) tooMany = true;
  };
  // In interval mode a piece that continues a cut leg starts where the last
  // one ended, so it does not count a second photo at that shared point.
  const photosIn = (leg, waypoints, lengthM) =>
    leg.photoMode === 'interval'
      ? Math.floor(lengthM / (leg.photoSpacingM || 1) + 1e-9) +
        (leg.continued ? 0 : 1)
      : waypoints.reduce(
          (sum, w) =>
            sum + (w.photo ? (w.outwardHeadingDeg != null ? 2 : 1) : 0),
          0,
        );
  const pending = [...legs];
  let guard = 0;
  while (pending.length && !tooMany) {
    guard += 1;
    if (guard > 100000) throw new Error('Mission split did not terminate');
    const leg = pending.shift();
    if (feasible([...current, leg])) {
      current.push(leg);
      continue;
    }
    if (current.length) {
      close();
      pending.unshift(leg);
      continue;
    }
    // The leg alone exceeds a mission: cut it at the largest feasible piece.
    let take = 2;
    while (
      take < leg.waypoints.length &&
      feasible([{ ...leg, waypoints: leg.waypoints.slice(0, take + 1) }])
    ) {
      take += 1;
    }
    take = Math.min(take, leg.waypoints.length);
    const head = leg.waypoints.slice(0, take);
    // The waypoint where the leg is cut ends one mission and starts the next;
    // it is photographed once, in the first.
    const tail = leg.waypoints
      .slice(take - 1)
      .map((w, i) =>
        i === 0 && leg.photoMode !== 'interval' ? withoutPhoto(w) : w,
      );
    const asLeg = (waypoints, continued = leg.continued === true) => {
      const lengthM = waypoints.reduce(
        (sum, w, i) => (i ? sum + segmentLength(waypoints[i - 1], w) : sum),
        0,
      );
      const piece = { ...leg, continued, waypoints, lengthM };
      return { ...piece, photoCount: photosIn(piece, waypoints, lengthM) };
    };
    current.push(asLeg(head));
    if (!feasible(current)) overBudget = true;
    close();
    if (tail.length > 1) pending.unshift(asLeg(tail, true));
  }
  if (!tooMany) close();
  if (overBudget) warnings.push({ code: 'mission-over-budget', params: {} });
  if (tooMany) {
    warnings.push({
      code: 'too-many-missions',
      params: { count: MAX_MISSIONS },
    });
    missions.length = MAX_MISSIONS;
  }

  // Each mission flies its own way out from the takeoff point to its first
  // waypoint and its own way home from its last one, so those two stretches
  // are checked per mission, after the split.
  let transitBlocked = 0;
  let transitNeedM = 0;
  let transitMaxRel = -Infinity;
  const withTransit = (missionLegs) => {
    const wps = missionLegs.flatMap((leg) => leg.waypoints);
    if (!wps.length || !options.obstacles?.length) return missionLegs;
    const need = transitNeeds(
      options.obstacles,
      takeoff,
      wps[0],
      wps[wps.length - 1],
      {
        groundOf: known ? (w) => readM(ground.wpM?.[w.id]) : null,
        obstacleGroundOf: known ? (o) => readM(ground.obstacleM?.[o.id]) : null,
      },
    );
    const lifts = new Map();
    const want = (w, n) => {
      if (!n) return;
      lifts.set(w, Math.max(lifts.get(w) ?? 0, n.needAglM));
    };
    want(wps[0], need.first);
    want(wps[wps.length - 1], need.last);
    if (!lifts.size) return missionLegs;
    return missionLegs.map((leg) => {
      let blocked = false;
      const waypoints = leg.waypoints.map((w) => {
        const n = lifts.get(w);
        if (n === undefined || w.aglM >= n - 1e-9) return w;
        const to = Math.min(n, AGL_CAP_M);
        const capped = n > AGL_CAP_M + 1e-9;
        if (capped) {
          blocked = true;
          transitBlocked += 1;
          transitNeedM = Math.max(transitNeedM, n);
        }
        const rel = round(w.relHeightM + Math.max(0, to - w.aglM), 1);
        transitMaxRel = Math.max(transitMaxRel, rel);
        return {
          ...w,
          aglM: Math.max(w.aglM, to),
          relHeightM: rel,
          ...(capped ? { obstacleBlocked: true } : {}),
        };
      });
      return {
        ...leg,
        waypoints,
        ...(blocked ? { obstacleBlocked: true } : {}),
      };
    });
  };
  const built = missions.map((rawLegs, index) => {
    const missionLegs = withTransit(rawLegs);
    // Reindex the waypoints from 0 inside each mission.
    let next = 0;
    const reindexed = missionLegs.map((leg) => ({
      ...leg,
      waypoints: leg.waypoints.map((w) => ({ ...w, index: next++ })),
    }));
    const wps = flatten(reindexed);
    const est = estimateMission(wps, takeoff, speedMs, reindexed.length);
    // The lift can make a mission longer than the battery: say so.
    if (est.durationS > budgetS && !overBudget) {
      overBudget = true;
      warnings.push({ code: 'mission-over-budget', params: {} });
    }
    return {
      index,
      legs: reindexed,
      waypoints: wps,
      waypointCount: wps.length,
      photoCount: reindexed.reduce((s, l) => s + l.photoCount, 0),
      distanceM: est.distanceM,
      routeM: est.routeM,
      durationS: est.durationS,
    };
  });

  // The lifted ends can pass the height DJI Fly allows above the takeoff point.
  if (
    transitMaxRel > DJI_DEFAULT_HEIGHT_LIMIT_M &&
    !warnings.some((w) => w.code === 'rel-height-over-limit')
  ) {
    warnings.push({
      code: 'rel-height-over-limit',
      params: {
        maxRelM: Math.round(transitMaxRel),
        limitM: DJI_DEFAULT_HEIGHT_LIMIT_M,
        terrainRangeM: Math.round(terrainRangeM),
      },
    });
  }
  if (transitBlocked) {
    warnings.push({
      code: 'obstacle-blocked',
      params: {
        count: transitBlocked,
        needM: Math.round(transitNeedM),
        capM: AGL_CAP_M,
      },
    });
  }

  const totals = {
    photoCount: built.reduce((s, m) => s + m.photoCount, 0),
    distanceM: built.reduce((s, m) => s + m.distanceM, 0),
    durationS: built.reduce((s, m) => s + m.durationS, 0),
    waypointCount: built.reduce((s, m) => s + m.waypointCount, 0),
    missionCount: built.length,
    gsdCm: plan.gsdCm,
    speedMs,
    maxRelHeightM: maxRel,
    minRelHeightM: minRel,
    terrainRangeM,
  };
  return {
    plan,
    missions: built,
    totals,
    warnings,
    terrainComplete,
    truncated: tooMany,
    ground: { takeoffM, known, missing },
  };
}

/** Bearing used by the UI to point the takeoff marker; re-exported helper. */
export { bearingDeg };
