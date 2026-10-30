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
import { DEFAULT_PRESET_ID, getPreset } from './presets.js';
import {
  DEFAULT_SHUTTER_DENOMINATOR,
  MIN_PLAN_SPEED_MS,
  floorTo,
  shutterDenominatorOrDefault,
  speedLimits,
} from './speed.js';
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
  orbitTargetHeightM: 3,
  obstacleHeightM: DEFAULT_OBSTACLE_HEIGHT_M,
  orbitTargets: null,
  takeoff: null,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => {
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
    const h = Number(t.heightM);
    out.push({
      id: typeof t.id === 'string' && t.id ? t.id : `target-${out.length + 1}`,
      lon,
      lat,
      label: typeof t.label === 'string' ? t.label : '',
      source: typeof t.source === 'string' ? t.source : 'custom',
      active: t.active !== false,
      heightM: Number.isFinite(h) ? clamp(h, 0, 100) : null,
    });
    if (out.length >= MAX_ORBIT_TARGETS) break;
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
    ? o.orbitHeightsM.map(Number).filter(Number.isFinite)
    : [];
  // Every ring flies at least obstacle + margin above ground, so the drone
  // passes over the trees; a ring asked for lower is raised and says so.
  const floorAgl = minOrbitAglM(o.obstacleHeightM);
  const requestedRings = (heights.length ? heights : [o.aglM / 2, o.aglM])
    .map((h) => clamp(h, MIN_AGL_M, AGL_CAP_M))
    .slice(0, 6);
  const rings = requestedRings.map((h) => Math.max(h, floorAgl));
  if (rings.some((h, i) => h !== requestedRings[i])) {
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
    };
  };

  const agl = options.aglM;
  let fpInfo;
  let spacingInfo = null;
  let photoSpacingM;
  let passCount = 0;

  let orbitInfo = null;
  if (options.pattern === 'orbit') {
    // No target list: one orbit on the centre of the box, as before.
    const active = (options.orbitTargets ?? []).filter((t) => t.active);
    const stops = options.orbitTargets?.length
      ? active
      : [{ id: 'centre', ...center, heightM: null, label: '' }];
    if (!stops.length) {
      return {
        error: 'no-orbit-targets',
        message: 'Turn on at least one orbit target',
      };
    }
    const radius = options.orbitRadiusM;
    const obstacle = options.obstacleHeightM;
    const floorAgl = minOrbitAglM(obstacle);
    // Between targets the drone climbs to this and crosses at it, so it
    // always passes over the trees at obstacle + margin or higher.
    const transitAgl = Math.max(floorAgl, ...options.orbitHeightsM);
    const toTakeoff = frame.toXY(takeoff.lon, takeoff.lat);
    let tooLarge = false;
    let gsdMin = Infinity;
    let arcMax = Infinity;
    const ringInfo = [];
    let prevEnd = null;
    const targetInfo = [];
    for (const stop of stops) {
      if (tooLarge) break;
      const targetH = stop.heightM ?? options.orbitTargetHeightM;
      const c = frame.toXY(stop.lon, stop.lat);
      const from = prevEnd ? prevEnd.p : toTakeoff;
      const startAngle = Math.atan2(from.y - c.y, from.x - c.x);
      const firstLeg = legs.length;
      options.orbitHeightsM.forEach((ringAgl, ringIndex) => {
        if (tooLarge) return;
        const dz = Math.max(1, ringAgl - targetH);
        const pitch = -clamp(toDeg(Math.atan2(dz, radius)), 5, 89);
        const range = Math.hypot(radius, dz);
        const acrossM = (range * preset.sensorWidthMm) / preset.focalMm;
        const arcM = acrossM * (1 - options.frontOverlap / 100);
        const gsd =
          (range * (preset.sensorWidthMm / preset.imageWidthPx) * 100) /
          preset.focalMm;
        gsdMin = Math.min(gsdMin, gsd);
        arcMax = Math.min(arcMax, arcM);
        const n = Math.max(12, Math.ceil((2 * Math.PI * radius) / arcM));
        const sign = ringIndex % 2 === 0 ? 1 : -1;
        const points = [];
        for (let k = 0; k < n; k += 1) {
          const a = startAngle + sign * ((2 * Math.PI * k) / n);
          points.push({
            x: c.x + radius * Math.cos(a),
            y: c.y + radius * Math.sin(a),
          });
        }
        if (waypointCount + n > MAX_WAYPOINTS_TOTAL) {
          tooLarge = true;
          return;
        }
        if (ringIndex === 0 && prevEnd) {
          // Climb where the last orbit ended, cross at transit height and
          // come down on the first point of this one.
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
            toWaypoint(points[0], {
              aglM: transitAgl,
              pitchDeg: round(pitch, 1),
              headingDeg: round(
                wrapHeading(
                  toDeg(Math.atan2(c.x - points[0].x, c.y - points[0].y)),
                ),
                1,
              ),
              photo: false,
            }),
          );
          const hopLen = Math.hypot(
            points[0].x - prevEnd.p.x,
            points[0].y - prevEnd.p.y,
          );
          addLeg({
            id: legs.length,
            passId: 0,
            kind: 'transit',
            pitchDeg: round(pitch, 1),
            photoMode: 'waypoint',
            waypoints: hop,
            lengthM: hopLen,
            photoCount: 0,
          });
        }
        const waypoints = points.map((p) => {
          const heading = wrapHeading(toDeg(Math.atan2(c.x - p.x, c.y - p.y)));
          return toWaypoint(p, {
            aglM: ringAgl,
            pitchDeg: round(pitch, 1),
            headingDeg: round(heading, 1),
            photo: true,
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
          pitchDeg: round(pitch, 1),
          photoMode: 'waypoint',
          waypoints,
          lengthM: length,
          photoCount: waypoints.length,
        });
        const last = points[points.length - 1];
        prevEnd = {
          p: last,
          aglM: ringAgl,
          pitchDeg: round(pitch, 1),
          headingDeg: round(
            wrapHeading(toDeg(Math.atan2(c.x - last.x, c.y - last.y))),
            1,
          ),
        };
        if (stop === stops[0]) {
          ringInfo.push({
            aglM: ringAgl,
            pitchDeg: round(pitch, 1),
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
        firstLeg,
      });
    }
    if (tooLarge) {
      return { error: 'too-large', message: 'Plan needs too many waypoints' };
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
      rings: ringInfo,
      targets: targetInfo,
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
  const durationS =
    routeM / speedMs +
    (outM + backM) / TRANSIT_SPEED_MS +
    OVERHEAD_S +
    TURN_S * Math.max(0, legCount - 1);
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
  const takeoffM = known ? ground.takeoffM : 0;

  // A waypoint the terrain gave no height for takes the nearest read height
  // before it in the route (never the takeoff height, which can be far from
  // the ground there) and is counted, so the plan can say it is a guess.
  // A gap at the very start of the route takes the first height read after it.
  const firstRead = known
    ? plan.legs
        .flatMap((leg) => leg.waypoints)
        .map((w) => ground.wpM[w.id])
        .find((g) => typeof g === 'number' && Number.isFinite(g))
    : undefined;
  let lastGroundM = firstRead ?? takeoffM;
  let missing = 0;
  const legs = plan.legs.map((leg) => ({
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
      : waypoints.filter((w) => w.photo).length;
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
        i === 0 && leg.photoMode !== 'interval' ? { ...w, photo: false } : w,
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

  const built = missions.map((missionLegs, index) => {
    // Reindex the waypoints from 0 inside each mission.
    let next = 0;
    const reindexed = missionLegs.map((leg) => ({
      ...leg,
      waypoints: leg.waypoints.map((w) => ({ ...w, index: next++ })),
    }));
    const wps = flatten(reindexed);
    const est = estimateMission(wps, takeoff, speedMs, reindexed.length);
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
