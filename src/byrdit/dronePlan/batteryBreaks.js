/**
 * Pause markers along a continuous route.
 *
 * assembleMissions does not cut a continuous route on battery time. This
 * module does not cut it either, and it does not add waypoints. It estimates
 * where the pilot would pause, come home, swap the battery and resume.
 *
 * Time is estimateMission() in planner.js, not a second formula. Each piece
 * is that call on the piece's own waypoints, with legCount equal to the
 * survey lines the piece actually flies. Each extra line adds TURN_S (3 s).
 * A waypoint-array call that does not pass legs has no line boundaries, so
 * its pauses use leg count 1. options.legCount then changes only the
 * headline routeEstimate. Pass legs to put the turn on the pause.
 *
 * Home is the takeoff point at relative height 0. takeoff.relHeightM is
 * ignored. Each battery pays its own way out, way home and overhead. The
 * headline is one call on the whole polyline. Extra batteries are extra
 * trips home, so the sum of the pieces is longer than the headline.
 *
 * Hover actions with no dwellS are copied onto dwellS before that call, so
 * estimateMission sees them. dwellS already set is left alone. Wind is not
 * modelled. Vertical change is only the 3D segment inside estimateMission.
 * Time on the ground swapping batteries is not included. The resume from
 * the landing point back to the pause is the way-out transit already in
 * estimateMission, not a second leg, and it is not a clearance check.
 *
 * The walk is greedy in path order. A later point that would fit after an
 * infeasible stretch is not pulled forward. On one straight segment the
 * return distance is convex, so the feasible set is one interval and the
 * binary search is the furthest fitting point. A gain under MIN_ADVANCE_M
 * is the round-trip wall, not another battery: that pause is omitted and
 * the remainder is unreachable. The function does not throw for that.
 *
 * Interval photos are linePhotoCount on each survey line's own 3D length,
 * the same length planner.js stores as leg.lengthM. A connector between
 * lines is not photo distance. A new line starts a new count unless the
 * leg is continued. Without legs, the polyline is one line, which is the
 * compatible waypoint-array count.
 *
 * A marker that lands on a vertex is the end of one piece and the start of
 * the next, so that vertex's dwellS is in both durations.
 *
 * Imports: geo.js and planner.js only. planner.js must not import this
 * file. Not called by planFlight or assembleMissions.
 *
 * Integrate a continuous mission with:
 *
 *   batteryBreaks(mission.waypoints, {
 *     takeoff: { lon: plan.takeoff.lon, lat: plan.takeoff.lat },
 *     speedMs: plan.speedMs,
 *     usableMin: plan.options.usableBatteryMin,
 *     legs: mission.legs,
 *   })
 *
 * or batteryBreaks(mission, { takeoff, speedMs, usableMin }).
 * mission.waypoints must be mission.legs flattened in order. A route that
 * does not match the legs throws. Omitting legs keeps the old call:
 * batteryBreaks(waypoints, { takeoff, speedMs, usableMin, photoSpacingM, legCount }).
 */

import { deltaLon, groundDistanceM, makeFrame, wrapLon } from './geo.js';
import {
  OVERHEAD_S,
  TRANSIT_SPEED_MS,
  TURN_S,
  estimateMission,
  isContinuousCapture,
  linePhotoCount,
} from './planner.js';

export const DEFAULT_USABLE_MIN = 20;
/**
 * A further pause that gains less than this is the round-trip wall.
 * 25 m is under a typical photo spacing and above the 1 m numerical creep
 * (the 4-mile, 20-minute walk used to emit 4616 m then 4617 m).
 */
export const MIN_ADVANCE_M = 25;
const BUDGET_EPS_S = 1e-6;
const DIST_EPS_M = 1e-6;
/** A solved point this close to a vertex is that vertex, not the next segment. */
const VERTEX_SNAP_M = 1e-3;
const POINT_MATCH_DEG = 1e-8;
const HEIGHT_MATCH_M = 1e-3;

export const DISCLAIMER =
  'Estimate only. Each battery includes the way out, the route piece, the way home and the takeoff/landing overhead from the planner time formula. When survey lines are supplied, each extra line in that piece adds a 3 second turn. Wind, extra climb time and time swapping batteries are not included, so the real pause will move. A pause that would advance less than 25 m is not marked. These markers are not waypoints and the route is not split.';

export const ASSUMPTIONS = Object.freeze({
  integrated: false,
  addsWaypoints: false,
  usableMinDefault: DEFAULT_USABLE_MIN,
  /** Not the planner batteryMin clamp of 5..60. Default here is 20, not 25. */
  usableMinClamped: false,
  plannerBatteryMinDefault: 25,
  timeModel: 'estimateMission',
  overheadS: OVERHEAD_S,
  transitSpeedMs: TRANSIT_SPEED_MS,
  turnS: TURN_S,
  /** True only for a call that passes legs. A bare waypoint array has no line joins. */
  turnPenaltyOnBreaks: true,
  turnPenaltyRequiresLegs: true,
  windModelled: false,
  climbModel:
    '3D segment length inside estimateMission; no separate climb rate',
  groundSwapTimeIncluded: false,
  resumeLegSeparate: false,
  greedyPrefix: true,
  minAdvanceM: MIN_ADVANCE_M,
  photoCountModel:
    'linePhotoCount on each survey line; connectors are not photo distance; continued lines do not recount the start',
  sharedVertexDwellCountedTwice: true,
  takeoffRelativeHeightM: 0,
});

function heightOf(p) {
  const h = p?.relHeightM ?? 0;
  const n = Number(h);
  return Number.isFinite(n) ? n : 0;
}

/** Same 3D length as the private segmentLength in planner.js. */
function segmentLength(a, b) {
  return Math.hypot(groundDistanceM(a, b), heightOf(b) - heightOf(a));
}

function requirePoint(p, label) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new TypeError(`${label} must be a {lon, lat} point`);
  }
  if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) {
    throw new TypeError(`${label} lon/lat must be finite numbers`);
  }
  if (Math.abs(p.lon) > 180 || Math.abs(p.lat) > 90) {
    throw new RangeError(`${label} lon/lat out of range`);
  }
}

function hoverSeconds(action) {
  const func = String(
    action?.func ?? action?.type ?? action?.actionActuatorFunc ?? '',
  );
  if (func !== 'hover') return 0;
  const raw =
    action?.hoverTime ??
    action?.durationS ??
    action?.params?.hoverTime ??
    action?.params?.durationS;
  const t = Number(raw);
  return t > 0 ? t : 0;
}

/** dwellS wins. A hover action is dwell only when dwellS was not set. */
function dwellOf(p) {
  const explicit = Number(p?.dwellS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (!Array.isArray(p?.actions)) return 0;
  return p.actions.reduce((sum, action) => sum + hoverSeconds(action), 0);
}

function copyPoint(p) {
  const out = { lon: p.lon, lat: p.lat, relHeightM: heightOf(p) };
  const dwell = dwellOf(p);
  if (dwell > 0) out.dwellS = dwell;
  if (p?.photo === true) out.photo = true;
  if (p?.outwardHeadingDeg != null) out.outwardHeadingDeg = p.outwardHeadingDeg;
  return out;
}

function samePoint(a, b) {
  return (
    Math.abs(a.lon - b.lon) <= POINT_MATCH_DEG &&
    Math.abs(a.lat - b.lat) <= POINT_MATCH_DEG &&
    Math.abs(heightOf(a) - heightOf(b)) <= HEIGHT_MATCH_M
  );
}

function midLon(a, b) {
  return wrapLon(a + deltaLon(a, b) / 2);
}

/** Linear in the same local frame groundDistanceM uses for this segment. */
function interpolate(a, b, t) {
  if (t <= 0) return copyPoint(a);
  if (t >= 1) return copyPoint(b);
  const frame = makeFrame(midLon(a.lon, b.lon), (a.lat + b.lat) / 2);
  const p = frame.toXY(a.lon, a.lat);
  const q = frame.toXY(b.lon, b.lat);
  const ll = frame.toLonLat(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
  return {
    lon: ll.lon,
    lat: ll.lat,
    relHeightM: heightOf(a) + (heightOf(b) - heightOf(a)) * t,
  };
}

function countsByLine(leg) {
  if (!(leg.spacingM > 0)) return false;
  if (leg.photoMode === 'interval') return true;
  if (isContinuousCapture(leg.captureMode)) return true;
  if (leg.captureMode === 'stop') return false;
  return !leg.captureMode && !leg.photoMode;
}

/** Planner lengthM wins when the drawn line is only a centimetre off it. */
function photoLength(leg, used, measured) {
  const stored = leg.storedLengthM;
  if (!(stored > 0) || !(measured > DIST_EPS_M)) return used;
  if (Math.abs(measured - stored) > 0.05) return used;
  if (used >= measured - DIST_EPS_M) return stored;
  return stored * (used / measured);
}

function photoFlags(point) {
  if (point?.photo !== true) return 0;
  return point.outwardHeadingDeg != null ? 2 : 1;
}

function normalizeLegs(legs, fallbackSpacing) {
  if (legs == null) return null;
  if (!Array.isArray(legs) || !legs.length) {
    throw new TypeError('legs must be a non-empty array of survey lines');
  }
  return legs.map((leg, i) => {
    if (!leg || !Array.isArray(leg.waypoints) || !leg.waypoints.length) {
      throw new TypeError(`legs[${i}].waypoints must be a non-empty array`);
    }
    const spacing = Number(leg.photoSpacingM);
    const resolved = spacing > 0 ? spacing : fallbackSpacing;
    const waypoints = leg.waypoints.map((p, j) => {
      requirePoint(p, `legs[${i}].waypoints[${j}]`);
      return copyPoint(p);
    });
    return {
      waypoints,
      spacingM: resolved > 0 ? resolved : null,
      continued: leg.continued === true,
      captureMode: leg.captureMode,
      photoMode: leg.photoMode,
      storedLengthM:
        Number.isFinite(Number(leg.lengthM)) && Number(leg.lengthM) > 0
          ? Number(leg.lengthM)
          : null,
    };
  });
}

function buildChain(normLegs) {
  const points = [];
  const segments = [];
  const legSpans = [];
  let routeM = 0;
  let groundM = 0;
  for (let i = 0; i < normLegs.length; i += 1) {
    const leg = normLegs[i];
    let startRouteM = routeM;
    let startGroundM = groundM;
    const flags = [];
    leg.waypoints.forEach((raw, j) => {
      const point = copyPoint(raw);
      if (!points.length) {
        points.push(point);
        startRouteM = 0;
        startGroundM = 0;
      } else {
        const prev = points[points.length - 1];
        const ground = groundDistanceM(prev, point);
        const length = segmentLength(prev, point);
        const connector = j === 0 && length > DIST_EPS_M;
        segments.push({
          index: points.length - 1,
          startRouteM: routeM,
          endRouteM: routeM + length,
          startGroundM: groundM,
          endGroundM: groundM + ground,
          length,
          ground,
          connector,
        });
        routeM += length;
        groundM += ground;
        if (j === 0) {
          startRouteM = routeM;
          startGroundM = groundM;
        }
        points.push(point);
      }
      const n = photoFlags(raw);
      if (n > 0) flags.push({ routeM, n });
    });
    legSpans.push({
      index: i,
      startRouteM,
      endRouteM: routeM,
      startGroundM,
      endGroundM: groundM,
      spacingM: leg.spacingM,
      continued: leg.continued,
      storedLengthM: leg.storedLengthM,
      countByLine: countsByLine(leg),
      flags,
    });
  }
  return { points, segments, legSpans, routeM, groundM };
}

function assertRouteMatches(route, points) {
  if (!route.length) return;
  if (route.length !== points.length) {
    throw new Error(
      `legs flatten to ${points.length} points but route has ${route.length}; pass mission.waypoints with mission.legs`,
    );
  }
  for (let i = 0; i < route.length; i += 1) {
    if (!samePoint(route[i], points[i])) {
      throw new Error(
        `route[${i}] does not match legs; pass the legs flattened in order`,
      );
    }
  }
}

function locate(chain, routeDist) {
  const { points, segments, routeM } = chain;
  if (!points.length) return null;
  if (routeDist <= DIST_EPS_M || !segments.length) {
    return {
      ...copyPoint(points[0]),
      segmentIndex: 0,
      fraction: 0,
      routeM: 0,
      groundM: 0,
    };
  }
  const d = Math.min(Math.max(routeDist, 0), routeM);
  if (d >= routeM - DIST_EPS_M) {
    const last = segments[segments.length - 1];
    return {
      ...copyPoint(points[points.length - 1]),
      segmentIndex: last.index,
      fraction: 1,
      routeM,
      groundM: chain.groundM,
    };
  }
  const seg =
    segments.find((s) => d <= s.endRouteM + DIST_EPS_M) ??
    segments[segments.length - 1];
  const span = seg.length;
  const raw = span <= DIST_EPS_M ? 1 : (d - seg.startRouteM) / span;
  const clamped = Math.min(1, Math.max(0, raw));
  const atEnd = clamped >= 1 - 1e-9;
  const atStart = clamped <= 1e-9;
  const fraction = atEnd ? 1 : atStart ? 0 : clamped;
  const point = atEnd
    ? copyPoint(points[seg.index + 1])
    : atStart
      ? copyPoint(points[seg.index])
      : interpolate(points[seg.index], points[seg.index + 1], fraction);
  return {
    ...point,
    segmentIndex: seg.index,
    fraction,
    routeM: seg.startRouteM + fraction * seg.length,
    groundM: seg.startGroundM + fraction * seg.ground,
  };
}

function pieceWaypoints(chain, fromM, toM) {
  const from = locate(chain, fromM);
  const to = locate(chain, toM);
  if (!from) return [];
  if (Math.abs(to.routeM - from.routeM) <= DIST_EPS_M) return [from];
  const wps = [from];
  chain.points.forEach((p, i) => {
    if (i === 0) return;
    const at = chain.segments[i - 1].endRouteM;
    if (at > from.routeM + DIST_EPS_M && at < to.routeM - DIST_EPS_M) {
      wps.push(copyPoint(p));
    }
  });
  wps.push(to);
  return wps;
}

function emptyResult(usableMin, speedMs, legCount, photoSpacingM) {
  return {
    assumptions: ASSUMPTIONS,
    disclaimer: DISCLAIMER,
    addsWaypoints: false,
    usableMin,
    budgetS: usableMin * 60,
    speedMs,
    legCount,
    legsUsed: false,
    photoSpacingM,
    groundM: 0,
    routeM: 0,
    routeEstimate: { distanceM: 0, routeM: 0, durationS: 0 },
    batteryCount: 0,
    photoCount: null,
    breaks: [],
    pieces: [],
    unreachable: null,
    covered: true,
  };
}

/**
 * Estimate pause markers along a continuous route.
 *
 * @param {Array<{lon:number,lat:number,relHeightM?:number,dwellS?:number,actions?:object[]}>
 *   | {waypoints:object[], legs:object[]}} route
 *   Ordered polyline, or a mission `{ waypoints, legs }`. Not modified.
 * @param {object} [options]
 * @param {{lon:number,lat:number}} [options.takeoff] Required when the route is non-empty.
 *   Relative height is ignored (home is height 0).
 * @param {number} [options.speedMs=5] Survey speed, m/s. Not the 8 m/s transit speed.
 * @param {number} [options.usableMin=20] Usable minutes per battery. Not clamped to 5..60.
 * @param {number} [options.photoSpacingM] Fallback ground metres between interval photos.
 * @param {number} [options.legCount=1] Headline only, and only when `legs` is omitted.
 * @param {Array<{
 *   waypoints: object[],
 *   photoSpacingM?: number,
 *   lengthM?: number,
 *   continued?: boolean,
 *   captureMode?: 'distance'|'timed'|'stop',
 *   photoMode?: 'interval'|'waypoint',
 * }>} [options.legs] Survey lines in flight order. Enables the 3 s turn and
 *   per-line photo counts. Must flatten to `route` when `route` is non-empty.
 * @returns {object} Markers, pieces, and unreachable. Never inserts waypoints.
 */
export function batteryBreaks(route, options = {}) {
  let opts = options ?? {};
  let pointsIn = route;
  if (
    pointsIn &&
    typeof pointsIn === 'object' &&
    !Array.isArray(pointsIn) &&
    Array.isArray(pointsIn.legs)
  ) {
    opts = { ...opts, legs: opts.legs ?? pointsIn.legs };
    pointsIn = Array.isArray(pointsIn.waypoints) ? pointsIn.waypoints : [];
  }
  if (!Array.isArray(pointsIn)) {
    throw new TypeError('route must be an array of {lon, lat} points');
  }
  const usableMin = opts.usableMin ?? DEFAULT_USABLE_MIN;
  if (!Number.isFinite(usableMin) || usableMin <= 0) {
    throw new RangeError(
      'usableMin must be a finite number of minutes greater than 0',
    );
  }
  const speedMs = opts.speedMs ?? 5;
  if (!Number.isFinite(speedMs) || speedMs <= 0) {
    throw new RangeError('speedMs must be a finite speed greater than 0');
  }
  const requestedLegs = opts.legCount ?? 1;
  if (!Number.isInteger(requestedLegs) || requestedLegs < 1) {
    throw new RangeError('legCount must be an integer >= 1');
  }
  let photoSpacingM = null;
  if (opts.photoSpacingM != null) {
    photoSpacingM = Number(opts.photoSpacingM);
    if (!Number.isFinite(photoSpacingM) || photoSpacingM <= 0) {
      throw new RangeError(
        'photoSpacingM must be a finite spacing greater than 0',
      );
    }
  }
  const suppliedLegs = normalizeLegs(opts.legs, photoSpacingM);
  const legsUsed = suppliedLegs != null;
  if (!pointsIn.length && !suppliedLegs) {
    return emptyResult(usableMin, speedMs, requestedLegs, photoSpacingM);
  }

  const normLegs = suppliedLegs ?? [
    {
      waypoints: pointsIn,
      spacingM: photoSpacingM,
      continued: false,
      captureMode: photoSpacingM ? 'distance' : undefined,
      photoMode: undefined,
    },
  ];
  if (legsUsed) {
    normLegs.forEach((leg) => {
      leg.waypoints.forEach((p, j) => requirePoint(p, `leg waypoint ${j}`));
    });
  } else {
    pointsIn.forEach((p, i) => requirePoint(p, `route[${i}]`));
  }
  if (!normLegs.some((leg) => leg.waypoints.length)) {
    return emptyResult(usableMin, speedMs, requestedLegs, photoSpacingM);
  }

  requirePoint(opts.takeoff, 'takeoff');
  const takeoff = { lon: opts.takeoff.lon, lat: opts.takeoff.lat };
  const chain = buildChain(normLegs);
  if (legsUsed) assertRouteMatches(pointsIn, chain.points);
  const budgetS = usableMin * 60;
  const headlineLegs = legsUsed ? chain.legSpans.length : requestedLegs;
  const routeEstimate = chain.points.length
    ? estimateMission(chain.points, takeoff, speedMs, headlineLegs)
    : { distanceM: 0, routeM: 0, durationS: 0 };

  const breaks = [];
  const pieces = [];
  let unreachable = null;

  const pieceLegCount = (fromM, toM) => {
    if (toM <= fromM + DIST_EPS_M) return 1;
    let n = 0;
    for (const leg of chain.legSpans) {
      const overlap =
        Math.min(toM, leg.endRouteM) - Math.max(fromM, leg.startRouteM);
      const startsInside =
        leg.startRouteM > fromM + DIST_EPS_M &&
        leg.startRouteM <= toM + DIST_EPS_M;
      if (overlap > DIST_EPS_M || startsInside) n += 1;
    }
    return Math.max(1, n);
  };
  const durationOf = (fromM, toM) => {
    const durationS = estimateMission(
      pieceWaypoints(chain, fromM, toM),
      takeoff,
      speedMs,
      pieceLegCount(fromM, toM),
    ).durationS;
    return Number.isFinite(durationS) ? durationS : Number.POSITIVE_INFINITY;
  };
  const fits = (fromM, toM) => durationOf(fromM, toM) <= budgetS + BUDGET_EPS_S;

  function photosUntil(routeDist) {
    let lineCount = 0;
    let flagCount = 0;
    let saw = false;
    for (const leg of chain.legSpans) {
      if (leg.countByLine) {
        saw = true;
        if (routeDist <= leg.startRouteM + DIST_EPS_M) continue;
        const measured = leg.endRouteM - leg.startRouteM;
        const used = Math.min(routeDist, leg.endRouteM) - leg.startRouteM;
        if (used > DIST_EPS_M) {
          lineCount += linePhotoCount(
            photoLength(leg, used, measured),
            leg.spacingM,
            leg.continued,
          );
        }
      } else {
        for (const flag of leg.flags) {
          if (flag.routeM <= routeDist + DIST_EPS_M && flag.n > 0) {
            flagCount += flag.n;
            saw = true;
          }
        }
      }
    }
    return saw ? lineCount + flagCount : null;
  }

  function legIndexAt(routeDist) {
    let found = null;
    for (const leg of chain.legSpans) {
      if (
        routeDist >= leg.startRouteM - DIST_EPS_M &&
        routeDist <= leg.endRouteM + DIST_EPS_M
      ) {
        found = leg.index;
      }
    }
    return found;
  }

  function marker(index, at, durationS, fromM) {
    const legsInPiece = pieceLegCount(fromM, at.routeM);
    return {
      index,
      lon: at.lon,
      lat: at.lat,
      relHeightM: at.relHeightM,
      segmentIndex: at.segmentIndex,
      fraction: at.fraction,
      groundM: at.groundM,
      routeM: at.routeM,
      minutes: durationS / 60,
      durationS,
      photoCount: photosUntil(at.routeM),
      addedWaypoint: false,
      legCount: legsInPiece,
      turnS: TURN_S * Math.max(0, legsInPiece - 1),
      advanceM: at.routeM - fromM,
      legIndex: legIndexAt(at.routeM),
    };
  }

  function piece(fromM, toM, durationS) {
    const from = locate(chain, fromM);
    const to = locate(chain, toM);
    const endPhotos = photosUntil(to.routeM);
    const startPhotos = photosUntil(from.routeM);
    return {
      fromRouteM: from.routeM,
      toRouteM: to.routeM,
      fromGroundM: from.groundM,
      toGroundM: to.groundM,
      durationS,
      fits: true,
      legCount: pieceLegCount(from.routeM, to.routeM),
      photoCount: endPhotos == null ? null : endPhotos - (startPhotos ?? 0),
      advanceM: to.routeM - from.routeM,
    };
  }

  function finish(batteryCount) {
    const coveredTo = unreachable ? unreachable.fromRouteM : chain.routeM;
    return {
      assumptions: ASSUMPTIONS,
      disclaimer: DISCLAIMER,
      addsWaypoints: false,
      usableMin,
      budgetS,
      speedMs,
      legCount: headlineLegs,
      legsUsed,
      photoSpacingM,
      groundM: chain.groundM,
      routeM: chain.routeM,
      routeEstimate,
      batteryCount,
      photoCount: photosUntil(coveredTo),
      breaks,
      pieces,
      unreachable,
      covered: unreachable == null,
    };
  }

  function snapToVertex(routeDist) {
    if (routeDist <= VERTEX_SNAP_M) return 0;
    if (Math.abs(routeDist - chain.routeM) <= VERTEX_SNAP_M)
      return chain.routeM;
    for (const seg of chain.segments) {
      if (Math.abs(routeDist - seg.endRouteM) <= VERTEX_SNAP_M)
        return seg.endRouteM;
    }
    return routeDist;
  }

  function furthest(fromM) {
    let cursor = fromM;
    for (const seg of chain.segments) {
      if (seg.endRouteM <= fromM + DIST_EPS_M) continue;
      if (fits(fromM, seg.endRouteM)) {
        cursor = seg.endRouteM;
        continue;
      }
      const start = Math.max(fromM, seg.startRouteM);
      if (!fits(fromM, start)) return cursor;
      let lo = start;
      let hi = seg.endRouteM;
      for (let i = 0; i < 60; i += 1) {
        const mid = (lo + hi) / 2;
        if (fits(fromM, mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    }
    return cursor;
  }

  if (!chain.points.length) return finish(0);

  if (chain.routeM <= DIST_EPS_M) {
    const durationS = durationOf(0, 0);
    if (durationS <= budgetS + BUDGET_EPS_S) {
      pieces.push(piece(0, 0, durationS));
      return finish(1);
    }
    unreachable = {
      fromGroundM: 0,
      fromRouteM: 0,
      remainingGroundM: chain.groundM,
      reason: 'round-trip-exceeds-usable-minutes',
      durationS,
    };
    return finish(0);
  }

  let cursor = 0;
  let guard = 0;
  while (cursor < chain.routeM - DIST_EPS_M) {
    guard += 1;
    if (guard > 10000)
      throw new Error('battery break search did not terminate');
    if (fits(cursor, chain.routeM)) {
      pieces.push(
        piece(cursor, chain.routeM, durationOf(cursor, chain.routeM)),
      );
      break;
    }
    const stay = durationOf(cursor, cursor);
    const here = locate(chain, cursor);
    if (stay > budgetS + BUDGET_EPS_S) {
      unreachable = {
        fromGroundM: here.groundM,
        fromRouteM: here.routeM,
        remainingGroundM: chain.groundM - here.groundM,
        reason: 'round-trip-exceeds-usable-minutes',
        durationS: stay,
      };
      break;
    }
    let next = furthest(cursor);
    const snapped = snapToVertex(next);
    if (snapped !== next && fits(cursor, snapped)) next = snapped;
    const advanceM = next - cursor;
    if (!(advanceM >= MIN_ADVANCE_M)) {
      unreachable = {
        fromGroundM: here.groundM,
        fromRouteM: here.routeM,
        remainingGroundM: chain.groundM - here.groundM,
        reason: 'no-progress',
        durationS: stay,
        advanceM,
      };
      break;
    }
    const durationS = durationOf(cursor, next);
    const at = locate(chain, next);
    pieces.push(piece(cursor, next, durationS));
    breaks.push(marker(breaks.length + 1, at, durationS, cursor));
    cursor = next;
  }

  return finish(pieces.length);
}
