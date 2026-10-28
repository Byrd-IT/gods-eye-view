/**
 * Flat-earth helpers for the Drone Flight Plan tool. A survey box is at most a
 * few kilometres across, so a local east/north frame (metres) around the box
 * centre is accurate to well under a centimetre per kilometre for planning.
 * Pure functions, no Cesium, so the planner is testable in plain node.
 */
const DEG = Math.PI / 180;

/** Metres per degree of latitude and longitude at `latDeg` (WGS84 series). */
export function metersPerDegree(latDeg) {
  const phi = latDeg * DEG;
  const lat =
    111132.92 -
    559.82 * Math.cos(2 * phi) +
    1.175 * Math.cos(4 * phi) -
    0.0023 * Math.cos(6 * phi);
  const lon =
    111412.84 * Math.cos(phi) -
    93.5 * Math.cos(3 * phi) +
    0.118 * Math.cos(5 * phi);
  return { lat, lon };
}

/**
 * A local frame: x east, y north, in metres from (lon0, lat0).
 * @param {number} lon0 Degrees.
 * @param {number} lat0 Degrees.
 */
export function makeFrame(lon0, lat0) {
  const m = metersPerDegree(lat0);
  return {
    lon0,
    lat0,
    toXY(lon, lat) {
      return { x: (lon - lon0) * m.lon, y: (lat - lat0) * m.lat };
    },
    toLonLat(x, y) {
      return { lon: lon0 + x / m.lon, lat: lat0 + y / m.lat };
    },
  };
}

/** Straight-line ground distance in metres between two lon/lat points. */
export function groundDistanceM(a, b) {
  const frame = makeFrame((a.lon + b.lon) / 2, (a.lat + b.lat) / 2);
  const p = frame.toXY(a.lon, a.lat);
  const q = frame.toXY(b.lon, b.lat);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

/** Compass bearing in degrees [0, 360) from `a` to `b` (0 = north, 90 = east). */
export function bearingDeg(a, b) {
  const frame = makeFrame((a.lon + b.lon) / 2, (a.lat + b.lat) / 2);
  const p = frame.toXY(a.lon, a.lat);
  const q = frame.toXY(b.lon, b.lat);
  const deg = Math.atan2(q.x - p.x, q.y - p.y) / DEG;
  return (deg + 360) % 360;
}

/** Wrap a bearing to the WPML heading range (-180, 180]. */
export function wrapHeading(deg) {
  let d = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

export const toRad = (deg) => deg * DEG;
export const toDeg = (rad) => rad / DEG;
