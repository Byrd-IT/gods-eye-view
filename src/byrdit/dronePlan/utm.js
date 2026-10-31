/**
 * WGS84 longitude/latitude to UTM metres (Krueger series, millimetre level
 * inside a zone). The surface model files are written in the UTM zone the
 * photogrammetry job used, so the browser needs this one direction only.
 * Pure functions, no Cesium.
 */
const DEG = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const N = F / (2 - F);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;
const AA = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64);
const ALPHA = [
  0,
  N / 2 - (2 / 3) * N2 + (5 / 16) * N3,
  (13 / 48) * N2 - (3 / 5) * N3,
  (61 / 240) * N3,
];
const E2 = F * (2 - F);
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

/** UTM zone number (1..60) for a longitude. */
export function utmZoneOf(lon) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.min(60, Math.max(1, Math.floor((wrapped + 180) / 6) + 1));
}

/** Central meridian of a zone, degrees. */
export const zoneCentralMeridian = (zone) => (zone - 1) * 6 - 180 + 3;

/**
 * @param {number} lon degrees
 * @param {number} lat degrees (-80..84)
 * @param {number} zone UTM zone 1..60
 * @param {boolean} [north] hemisphere of the false northing (default: from lat)
 * @returns {{ e: number, n: number }} metres
 */
export function lonLatToUtm(lon, lat, zone, north = lat >= 0) {
  const phi = lat * DEG;
  let dl = (lon - zoneCentralMeridian(zone)) * DEG;
  dl = Math.atan2(Math.sin(dl), Math.cos(dl));
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(
    Math.atanh(sinPhi) -
      ((2 * Math.sqrt(N)) / (1 + N)) *
        Math.atanh(((2 * Math.sqrt(N)) / (1 + N)) * sinPhi),
  );
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta;
  let n = xi;
  for (let j = 1; j <= 3; j += 1) {
    e += ALPHA[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALPHA[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return {
    e: FALSE_EASTING + K0 * AA * e,
    n: (north ? 0 : FALSE_NORTHING_SOUTH) + K0 * AA * n,
  };
}

export const WGS84_E2 = E2;
