/**
 * Flights view lease, browser side (gev-history DESIGN 2.7 "Demand signal",
 * card B20 item 5).
 *
 * The OpenSky viewport poller pulls ONLY the areas currently on screen in
 * some GEV tab. Each tab therefore adds `view=w,s,e,n` (the visible
 * rectangle of the camera, +10 % margin, clamped to +-90/+-180, at least
 * 1 degree) and `vsid=<random per tab>` to its existing /api/flights
 * request. The collector bridge turns that into a view lease
 * (POST /v1/aircraft/view on the collector); browsers never call OpenSky.
 *
 * Rate: the view of a tab changes at most once per VIEW_MIN_INTERVAL_MS
 * (5 s); requests in between repeat the last view (the collector also
 * ignores refreshes of one sid faster than 5 s).
 *
 * Touch points (one line each, recorded in scripts/package-boundaries.json):
 *   src/layers/flights/controller.js  _flightQuery(): ...flightViewQuery(viewer)
 *   src/sources/live/standalone.js    getSnapshot(): appendFlightView(params, query)
 *
 * Pure and portable: no DOM, no Node built-ins, no Cesium import (the
 * camera's computeViewRectangle() result is read as plain radians).
 */

export const VIEW_MIN_INTERVAL_MS = 5_000;
export const VIEW_MARGIN = 0.1;
export const VIEW_MIN_DEG = 1;
/** Box sent when the camera shows no ground rectangle (horizon view). */
export const FALLBACK_HALF_DEG = 10;
export const VIEW_PARAM_RE =
  /^-?\d{1,3}(?:\.\d{1,4})?,-?\d{1,2}(?:\.\d{1,4})?,-?\d{1,3}(?:\.\d{1,4})?,-?\d{1,2}(?:\.\d{1,4})?$/;
export const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const DEG = 180 / Math.PI;
const round2 = (v) => {
  const x = Math.round(v * 100) / 100;
  return Object.is(x, -0) ? 0 : x;
};
const wrapLon = (lon) => {
  let x = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
};

/**
 * Normalise a visible rectangle (degrees; west > east = crosses the
 * antimeridian) into the `view` box: +10 % margin, latitude clamped,
 * longitude wrapped, at least VIEW_MIN_DEG per side, 2 decimals. A view
 * wider than 360 - margin becomes the world. Returns [w, s, e, n] or null.
 */
export function normalizeViewBox([west, south, east, north]) {
  if (![west, south, east, north].every(Number.isFinite)) return null;
  let span = east - west;
  if (span <= 0) span += 360; // crosses the antimeridian
  let s = Math.max(-90, Math.min(90, south));
  let n = Math.max(-90, Math.min(90, north));
  if (n < s) [s, n] = [n, s];
  const mx = (span * VIEW_MARGIN) / 2;
  const my = ((n - s) * VIEW_MARGIN) / 2;
  span += 2 * mx;
  s = Math.max(-90, s - my);
  n = Math.min(90, n + my);
  if (n - s < VIEW_MIN_DEG) {
    const c = (n + s) / 2;
    s = Math.max(-90, c - VIEW_MIN_DEG / 2);
    n = Math.min(90, s + VIEW_MIN_DEG);
  }
  if (span >= 360) return [-180, round2(s), 180, round2(n)];
  if (span < VIEW_MIN_DEG) {
    const grow = (VIEW_MIN_DEG - span) / 2;
    span = VIEW_MIN_DEG;
    return finish(west - mx - grow, s, span, n);
  }
  return finish(west - mx, s, span, n);
}

function finish(w0, s, span, n) {
  const w = round2(wrapLon(w0));
  let e = round2(wrapLon(w0 + span));
  if (e === w) e = round2(w + VIEW_MIN_DEG);
  return [w, round2(s), e, round2(n)];
}

/**
 * The view box of a Cesium viewer's camera, or null without a camera.
 * computeViewRectangle() is undefined when the camera sees no ground
 * (looking at the horizon / sky): then a box of +-FALLBACK_HALF_DEG around
 * the camera position is used.
 */
export function cameraViewBox(viewer) {
  const camera = viewer?.camera;
  if (!camera) return null;
  let rect = null;
  try {
    rect = camera.computeViewRectangle?.(viewer?.scene?.globe?.ellipsoid);
  } catch {
    rect = null;
  }
  if (
    rect &&
    [rect.west, rect.south, rect.east, rect.north].every(Number.isFinite)
  )
    return normalizeViewBox([
      rect.west * DEG,
      rect.south * DEG,
      rect.east * DEG,
      rect.north * DEG,
    ]);
  const c = camera.positionCartographic;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude))
    return null;
  const lat = c.latitude * DEG;
  const lon = c.longitude * DEG;
  return normalizeViewBox([
    lon - FALLBACK_HALF_DEG,
    lat - FALLBACK_HALF_DEG,
    lon + FALLBACK_HALF_DEG,
    lat + FALLBACK_HALF_DEG,
  ]);
}

/** Random per-tab view id (no user identity). */
export function randomViewSid(random = Math.random) {
  const abc =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let out = 'v';
  for (let i = 0; i < 21; i += 1) out += abc[Math.floor(random() * 64) % 64];
  return out;
}

/**
 * Per-tab tracker: the view changes at most once per VIEW_MIN_INTERVAL_MS.
 * query(viewer) -> {view: 'w,s,e,n', vsid} or {} without a camera.
 */
export function createFlightViewTracker({
  now = () => Date.now(),
  sid = randomViewSid(),
  boxOf = cameraViewBox,
} = {}) {
  let last = null;
  let lastAt = -Infinity;
  return {
    sid,
    query(viewer) {
      const t = now();
      if (last && t - lastAt < VIEW_MIN_INTERVAL_MS)
        return { view: last, vsid: sid };
      const box = boxOf(viewer);
      if (!box) return last ? { view: last, vsid: sid } : {};
      last = box.join(',');
      lastAt = t;
      return { view: last, vsid: sid };
    },
  };
}

let tabTracker = null;

/** Touch point for src/layers/flights/controller.js (one tracker per tab). */
export function flightViewQuery(viewer) {
  tabTracker ??= createFlightViewTracker();
  return tabTracker.query(viewer);
}

/** Touch point for src/sources/live/standalone.js: add view/vsid params. */
export function appendFlightView(params, query = {}) {
  if (typeof query?.view !== 'string' || !VIEW_PARAM_RE.test(query.view))
    return params;
  params.set('view', query.view);
  if (typeof query.vsid === 'string' && SID_RE.test(query.vsid))
    params.set('vsid', query.vsid);
  return params;
}
