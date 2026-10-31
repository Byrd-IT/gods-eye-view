/**
 * Pure maths for the Drone Flight Plan "3D check": the camera frustum of a
 * photo, its footprint on the ground, and the thinning that keeps the globe
 * fast. No Cesium here, so it is unit-testable and cheap.
 *
 * VISUAL AID ONLY. The ground under a photo is taken as the flat plane at the
 * waypoint's own ground height (`groundM`), so on a steep slope or over a
 * tall building the real footprint differs. Nothing here detects a collision.
 *
 * Frame: x east, y north, z up, metres from the waypoint. Heading is a
 * compass bearing (0 = north, 90 = east); pitch is below the horizon when
 * negative (-90 = straight down), the DJI convention used by the planner.
 */
import { makeFrame, toRad } from './geo.js';

/**
 * Hard ceiling on how far a footprint may reach, horizontally, m. A shot
 * whose frame edge looks above the horizon is cut at a reach tied to the
 * shot itself (REACH_PER_HEIGHT x its height above ground), never beyond
 * this.
 */
export const MAX_REACH_M = 1000;
/** Where a frame edge above the horizon is cut: this many heights out. */
export const REACH_PER_HEIGHT = 4;
/** ...but never closer than this, so a low shot still shows some ground. */
export const MIN_REACH_M = 40;
/** Footprint polygons on the ground beyond this are thinned. */
export const MAX_FOOTPRINTS = 300;
/** Pyramids in the "all thinned" mode. */
export const MAX_FRUSTUMS = 40;
/** A path with more points than this is thinned for the corridor and wall. */
export const MAX_PATH_POINTS = 3000;
export const MIN_ZONE_HALF_WIDTH_M = 2;
export const MAX_ZONE_HALF_WIDTH_M = 30;
export const DEFAULT_ZONE_HALF_WIDTH_M = 10;

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Height of the flight above the ellipsoid, the way the globe draws it. */
export const flightHeightM = (w) => (w.groundM ?? 0) + (w.aglM ?? 0);

/** How far out (m) a photo taken `aboveM` above the ground is drawn. */
export const footprintReachM = (aboveM) =>
  Math.min(
    MAX_REACH_M,
    Math.max(MIN_REACH_M, REACH_PER_HEIGHT * Math.max(aboveM, 0)),
  );

/**
 * The ground area one photo really sees, as four corners: near-left,
 * near-right, far-right, far-left (image bottom first, then top).
 *
 * The corners are the camera frame's own edges meeting the ground. Where the
 * top of the frame looks above the horizon (or farther than the shot's reach,
 * see footprintReachM) the side edges are walked down to the reach and cut
 * there with a straight far edge: the footprint stays INSIDE the frame, it is
 * never stretched towards the horizon.
 *
 * @param {{ lon:number, lat:number, aglM:number, pitchDeg:number }} wp
 * @param {number} headingDeg Compass bearing the camera faces.
 * @param {{ sensorWidthMm:number, sensorHeightMm:number, focalMm:number }} frame
 * @returns {{ corners: {lon:number,lat:number}[], groundM:number,
 *   heightM:number, clipped:boolean, empty:boolean, reachM:number,
 *   widthNearM:number, widthFarM:number, depthM:number }}
 */
export function photoFootprint(wp, headingDeg, frame) {
  const pitch = toRad(wp.pitchDeg ?? -90);
  const hdg = toRad(headingDeg ?? 0);
  // Forward, right and up of the camera, in east/north/up.
  const f = [
    Math.sin(hdg) * Math.cos(pitch),
    Math.cos(hdg) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  const r = [Math.cos(hdg), -Math.sin(hdg), 0];
  const u = cross(r, f);
  const aboveM = Math.max(wp.aglM ?? 0, 0.01);
  const reachM = footprintReachM(aboveM);
  const hx = frame.sensorWidthMm / 2;
  const hy = frame.sensorHeightMm / 2;
  // Where the ray through frame point (sx, sy), each -1..1, meets the ground
  // plane; null when it never does (at or above the horizon).
  const ray = (sx, sy) => {
    const d = [
      f[0] * frame.focalMm + r[0] * sx * hx + u[0] * sy * hy,
      f[1] * frame.focalMm + r[1] * sx * hx + u[1] * sy * hy,
      f[2] * frame.focalMm + r[2] * sx * hx + u[2] * sy * hy,
    ];
    if (!(d[2] < 0)) return null;
    const t = aboveM / -d[2];
    return { x: d[0] * t, y: d[1] * t, dist: Math.hypot(d[0], d[1]) * t };
  };
  const within = (p) => p !== null && p.dist <= reachM;
  let clipped = false;
  // A side edge runs from the image bottom (sy -1) to the top (sy 1). Return
  // its ground points: the bottom one, and the top one or the point where it
  // leaves the reach.
  const side = (sx) => {
    const bottom = ray(sx, -1);
    if (!within(bottom)) return null;
    const top = ray(sx, 1);
    if (within(top)) return [bottom, top];
    clipped = true;
    // Walk up the edge to the last point inside the reach, then bisect.
    let lo = -1;
    let hi = 1;
    const steps = 64;
    for (let k = 1; k <= steps; k += 1) {
      const sy = -1 + (2 * k) / steps;
      if (within(ray(sx, sy))) lo = sy;
      else {
        hi = sy;
        break;
      }
    }
    for (let k = 0; k < 40; k += 1) {
      const mid = (lo + hi) / 2;
      if (within(ray(sx, mid))) lo = mid;
      else hi = mid;
    }
    return [bottom, ray(sx, lo)];
  };
  const left = side(-1);
  const right = side(1);
  const frameLL = makeFrame(wp.lon, wp.lat);
  if (!left || !right) {
    // Even the bottom of the frame is beyond the reach: nothing to shade.
    return {
      corners: [],
      groundM: wp.groundM ?? 0,
      heightM: flightHeightM(wp),
      clipped: true,
      empty: true,
      reachM,
      widthNearM: 0,
      widthFarM: 0,
      depthM: 0,
    };
  }
  // near-left, near-right, far-right, far-left
  const xy = [left[0], right[0], right[1], left[1]];
  const corners = xy.map((p) => frameLL.toLonLat(p.x, p.y));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return {
    corners,
    groundM: wp.groundM ?? 0,
    heightM: flightHeightM(wp),
    clipped,
    empty: false,
    reachM,
    widthNearM: dist(xy[0], xy[1]),
    widthFarM: dist(xy[2], xy[3]),
    depthM: dist(mid(xy[0], xy[1]), mid(xy[2], xy[3])),
  };
}

/**
 * Whether a ground point (east/north metres from the drone) is inside the
 * camera frame of a shot: used by tests to prove a footprint never leaves the
 * frame. `tolerance` widens the frame edges (frame units, 1 = the full edge).
 */
export function pointInFrame(wp, headingDeg, frame, x, y, tolerance = 1e-6) {
  const pitch = toRad(wp.pitchDeg ?? -90);
  const hdg = toRad(headingDeg ?? 0);
  const f = [
    Math.sin(hdg) * Math.cos(pitch),
    Math.cos(hdg) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  const r = [Math.cos(hdg), -Math.sin(hdg), 0];
  const u = cross(r, f);
  const v = [x, y, -Math.max(wp.aglM ?? 0, 0.01)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(v, f);
  if (!(depth > 0)) return false;
  const sx = ((dot(v, r) / depth) * frame.focalMm) / (frame.sensorWidthMm / 2);
  const sy = ((dot(v, u) / depth) * frame.focalMm) / (frame.sensorHeightMm / 2);
  return Math.abs(sx) <= 1 + tolerance && Math.abs(sy) <= 1 + tolerance;
}

/**
 * The heading to draw a photo with. A waypoint without one (a straight-down
 * grid) faces along the flight: towards the next waypoint, or away from the
 * previous one at the end of the path.
 */
export function photoHeadingDeg(waypoints, index) {
  const w = waypoints[index];
  if (Number.isFinite(w.headingDeg)) return w.headingDeg;
  const from = waypoints[index + 1] ? w : waypoints[index - 1];
  const to = waypoints[index + 1] ?? w;
  if (!from || !to || from === to) return 0;
  const frame = makeFrame(from.lon, from.lat);
  const p = frame.toXY(to.lon, to.lat);
  return ((Math.atan2(p.x, p.y) * 180) / Math.PI + 360) % 360;
}

/**
 * Evenly pick at most `max` of `count` indexes, always keeping the first and
 * the last.
 */
export function thinIndexes(count, max) {
  if (count <= 0 || max <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  if (max === 1) return [0];
  const out = [];
  for (let i = 0; i < max; i += 1) {
    out.push(Math.round((i * (count - 1)) / (max - 1)));
  }
  return [...new Set(out)];
}

/** Clamp a corridor half-width to the slider range. */
export function clampHalfWidthM(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ZONE_HALF_WIDTH_M;
  return Math.min(MAX_ZONE_HALF_WIDTH_M, Math.max(MIN_ZONE_HALF_WIDTH_M, n));
}
