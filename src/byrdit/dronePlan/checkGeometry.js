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

/** A ray that never meets the ground is cut at this horizontal reach, m. */
export const MAX_REACH_M = 1000;
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

/**
 * The four ground corners of one photo, near-left, near-right, far-right,
 * far-left as seen from the drone (image bottom first, then top).
 *
 * @param {{ lon:number, lat:number, aglM:number, pitchDeg:number }} wp
 * @param {number} headingDeg Compass bearing the camera faces.
 * @param {{ sensorWidthMm:number, sensorHeightMm:number, focalMm:number }} frame
 * @returns {{ corners: {lon:number,lat:number}[], groundM:number,
 *   heightM:number, clipped:boolean, widthNearM:number, widthFarM:number,
 *   depthM:number }}
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
  const hx = frame.sensorWidthMm / 2;
  const hy = frame.sensorHeightMm / 2;
  let clipped = false;
  const hit = (sx, sy) => {
    const d = [
      f[0] * frame.focalMm + r[0] * sx * hx + u[0] * sy * hy,
      f[1] * frame.focalMm + r[1] * sx * hx + u[1] * sy * hy,
      f[2] * frame.focalMm + r[2] * sx * hx + u[2] * sy * hy,
    ];
    const horiz = Math.hypot(d[0], d[1]);
    // t scales the ray to the ground plane `aboveM` below the drone.
    let t = d[2] < 0 ? aboveM / -d[2] : Infinity;
    if (!Number.isFinite(t) || t * horiz > MAX_REACH_M) {
      clipped = true;
      t = horiz > 0 ? MAX_REACH_M / horiz : 0;
    }
    return { x: d[0] * t, y: d[1] * t };
  };
  // Image bottom (sy -1) is the near edge, top (sy +1) the far edge.
  const xy = [hit(-1, -1), hit(1, -1), hit(1, 1), hit(-1, 1)];
  const frameLL = makeFrame(wp.lon, wp.lat);
  const corners = xy.map((p) => frameLL.toLonLat(p.x, p.y));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return {
    corners,
    groundM: wp.groundM ?? 0,
    heightM: flightHeightM(wp),
    clipped,
    widthNearM: dist(xy[0], xy[1]),
    widthFarM: dist(xy[2], xy[3]),
    depthM: dist(mid(xy[0], xy[1]), mid(xy[2], xy[3])),
  };
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
