/**
 * Sky view maths (pure, no DOM, no Cesium): az/el <-> camera heading/pitch,
 * the Cesium field-of-view rule, the rectilinear projection the overlay draws
 * with, drag/zoom/key mapping, and the sky-brightness curve.
 *
 * Conventions: azimuth is degrees clockwise from TRUE north, elevation is
 * degrees above the geometric horizon. That is Cesium's local East-North-Up
 * frame, so heading = azimuth and pitch = elevation by construction.
 */

export const DEG = Math.PI / 180;
export const FOV_MIN_DEG = 5;
export const FOV_MAX_DEG = 100;
export const FOV_DEFAULT_DEG = 70;
export const EL_MIN_DEG = -10;
export const EL_MAX_DEG = 90;
export const EYE_HEIGHT_M = 1.7;

/** Wrap an angle in degrees to [0, 360). */
export function normalizeAz(deg) {
  const value = Number(deg);
  if (!Number.isFinite(value)) return 0;
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped === 360 ? 0 : wrapped;
}

export const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export const clampEl = (deg) => clamp(Number(deg) || 0, EL_MIN_DEG, EL_MAX_DEG);
export const clampFov = (deg) =>
  clamp(Number(deg) || FOV_DEFAULT_DEG, FOV_MIN_DEG, FOV_MAX_DEG);

/** A sanitised view state { azDeg, elDeg, rollDeg, fovDeg }. */
export function makeView({
  azDeg = 0,
  elDeg = 20,
  rollDeg = 0,
  fovDeg = FOV_DEFAULT_DEG,
} = {}) {
  return {
    azDeg: normalizeAz(azDeg),
    elDeg: clampEl(elDeg),
    rollDeg: Number.isFinite(Number(rollDeg)) ? Number(rollDeg) : 0,
    fovDeg: clampFov(fovDeg),
  };
}

/** Camera orientation (radians) for a view. */
export function azElToHeadingPitch(azDeg, elDeg, rollDeg = 0) {
  return {
    heading: normalizeAz(azDeg) * DEG,
    pitch: clamp(elDeg, -90, 90) * DEG,
    roll: rollDeg * DEG,
  };
}

/** View angles (degrees) for a camera orientation in radians. */
export function headingPitchToAzEl(heading, pitch) {
  return { azDeg: normalizeAz(heading / DEG), elDeg: pitch / DEG };
}

/** Unit look vector in local East-North-Up for an az/el in degrees. */
export function enuFromAzEl(azDeg, elDeg) {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  return [
    Math.cos(el) * Math.sin(az),
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
  ];
}

/** az/el in degrees for an ENU vector (need not be unit length). */
export function azElFromEnu([e, n, u]) {
  const horizontal = Math.hypot(e, n);
  return {
    azDeg: horizontal < 1e-12 ? 0 : normalizeAz(Math.atan2(e, n) / DEG),
    elDeg: Math.atan2(u, horizontal) / DEG,
  };
}

/**
 * Half-angle tangents of the frustum. Cesium's PerspectiveFrustum uses `fov`
 * as the HORIZONTAL angle when the canvas is wider than tall (aspect > 1) and
 * as the VERTICAL angle otherwise (PerspectiveFrustum.js: fovy = aspectRatio
 * <= 1 ? fov : 2 atan(tan(fov/2) / aspectRatio)); pinned by skyCamera.test.
 * So the sky view's fov is always the angle across the LONGER screen side.
 */
export function frustumTangents(fovDeg, width, height) {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  const t = Math.tan((clampFov(fovDeg) * DEG) / 2);
  return aspect > 1
    ? { tx: t, ty: t / aspect, aspect }
    : { tx: t * aspect, ty: t, aspect };
}

/** Horizontal and vertical field of view in degrees for a canvas size. */
export function fovAngles(fovDeg, width, height) {
  const { tx, ty } = frustumTangents(fovDeg, width, height);
  return {
    horizontalDeg: (2 * Math.atan(tx)) / DEG,
    verticalDeg: (2 * Math.atan(ty)) / DEG,
  };
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Camera basis in ENU: forward, right and up. Roll turns right/up about the
 * forward axis with Cesium's sign (positive roll = right side goes DOWN on
 * screen, i.e. the camera rotates clockwise about its forward axis).
 */
export function cameraBasis(view) {
  const forward = enuFromAzEl(view.azDeg, view.elDeg);
  const az = view.azDeg * DEG;
  // Right of the heading at the horizon; well defined even at the zenith.
  let right = [Math.cos(az), -Math.sin(az), 0];
  let up = cross(right, forward);
  const roll = (view.rollDeg || 0) * DEG;
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const r2 = right.map((v, i) => v * c - up[i] * s);
    const u2 = up.map((v, i) => v * c + right[i] * s);
    right = r2;
    up = u2;
  }
  return { forward, right, up };
}

/**
 * Project a sky direction to canvas pixels (rectilinear, same as Cesium).
 * Returns null when the direction is behind the camera.
 */
export function projectAzEl(azDeg, elDeg, view, width, height) {
  const { forward, right, up } = cameraBasis(view);
  const d = enuFromAzEl(azDeg, elDeg);
  const z = dot(d, forward);
  if (z <= 1e-6) return null;
  const { tx, ty } = frustumTangents(view.fovDeg, width, height);
  const x = dot(d, right) / z / tx;
  const y = dot(d, up) / z / ty;
  return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
}

/** Inverse of projectAzEl: the sky direction under a canvas pixel. */
export function unprojectPixel(px, py, view, width, height) {
  const { forward, right, up } = cameraBasis(view);
  const { tx, ty } = frustumTangents(view.fovDeg, width, height);
  const x = ((px / width) * 2 - 1) * tx;
  const y = (1 - (py / height) * 2) * ty;
  const d = forward.map((f, i) => f + x * right[i] + y * up[i]);
  return azElFromEnu(d);
}

/**
 * "Grab the sky" drag: moving the pointer right drags the sky right, so the
 * view turns LEFT. The azimuth step grows towards the zenith (1/cos el,
 * capped) so a drag near the top still turns at a usable rate.
 */
export function dragView(view, dx, dy, width, height) {
  const { horizontalDeg, verticalDeg } = fovAngles(view.fovDeg, width, height);
  const perPxX = horizontalDeg / Math.max(1, width);
  const perPxY = verticalDeg / Math.max(1, height);
  const cosEl = Math.max(0.2, Math.cos(view.elDeg * DEG));
  return makeView({
    ...view,
    azDeg: view.azDeg - (dx * perPxX) / cosEl,
    elDeg: view.elDeg + dy * perPxY,
  });
}

/** Zoom by a factor (> 1 zooms in = narrower fov). */
export function zoomView(view, factor) {
  if (!(factor > 0)) return view;
  return makeView({ ...view, fovDeg: view.fovDeg / factor });
}

/** Wheel deltaY to a zoom factor: 100 px of wheel = 1.15x. */
export function wheelZoomFactor(deltaY) {
  return Math.pow(1.15, -(Number(deltaY) || 0) / 100);
}

/** Two-finger pinch: fov scales with the inverse of the finger distance. */
export function pinchView(view, startView, startDistance, distance) {
  if (!(startDistance > 0) || !(distance > 0)) return view;
  return makeView({
    ...view,
    fovDeg: (startView.fovDeg * startDistance) / distance,
  });
}

/** Keyboard: arrows look, +/- zoom, N faces north, Z looks at the zenith. */
export function keyView(view, key) {
  const step = Math.max(0.5, view.fovDeg / 10);
  switch (key) {
    case 'ArrowLeft':
      return makeView({ ...view, azDeg: view.azDeg - step });
    case 'ArrowRight':
      return makeView({ ...view, azDeg: view.azDeg + step });
    case 'ArrowUp':
      return makeView({ ...view, elDeg: view.elDeg + step });
    case 'ArrowDown':
      return makeView({ ...view, elDeg: view.elDeg - step });
    case '+':
    case '=':
      return zoomView(view, 1.25);
    case '-':
    case '_':
      return zoomView(view, 1 / 1.25);
    case 'n':
    case 'N':
      return makeView({ ...view, azDeg: 0 });
    case 'z':
    case 'Z':
      return makeView({ ...view, elDeg: 90 });
    default:
      return null;
  }
}

/** Inertia after a drag: velocity (deg/ms) decays to nothing in ~300 ms. */
export function inertiaStep(velocity, dtMs, tauMs = 100) {
  const k = Math.exp(-Math.max(0, dtMs) / tauMs);
  return {
    dAz: velocity.az * tauMs * (1 - k),
    dEl: velocity.el * tauMs * (1 - k),
    velocity: { az: velocity.az * k, el: velocity.el * k },
  };
}

// ── sky brightness ─────────────────────────────────────────────────────────

/** Twilight phase for a Sun altitude in degrees. */
export function twilightPhase(sunAltDeg) {
  if (!Number.isFinite(sunAltDeg)) return 'unknown';
  if (sunAltDeg > 0) return 'day';
  if (sunAltDeg > -6) return 'civil';
  if (sunAltDeg > -12) return 'nautical';
  if (sunAltDeg > -18) return 'astronomical';
  return 'night';
}

/** (Sun altitude, limiting magnitude) knots of the UX curve, SKYVIEW.md 3.3. */
export const LIM_MAG_TABLE = Object.freeze([
  [0, -4],
  [-6, 1],
  [-12, 3.5],
  [-18, 6.5],
]);

/**
 * Faintest magnitude worth drawing for a Sun altitude: -4 in daylight, linear
 * through the twilight knots, +6.5 in full night. A UX curve, not photometry.
 */
export function limMag(sunAltDeg) {
  const h = Number(sunAltDeg);
  if (!Number.isFinite(h)) return LIM_MAG_TABLE[0][1];
  if (h >= LIM_MAG_TABLE[0][0]) return LIM_MAG_TABLE[0][1];
  for (let i = 1; i < LIM_MAG_TABLE.length; i++) {
    const [h1, m1] = LIM_MAG_TABLE[i];
    if (h >= h1) {
      const [h0, m0] = LIM_MAG_TABLE[i - 1];
      return m0 + ((h - h0) / (h1 - h0)) * (m1 - m0);
    }
  }
  return LIM_MAG_TABLE.at(-1)[1];
}

const GRADIENT_KNOTS = [
  // sunAlt, zenith rgb, horizon rgb
  [10, [52, 110, 200], [160, 200, 235]],
  [0, [60, 100, 170], [235, 160, 110]],
  [-6, [25, 40, 85], [150, 90, 80]],
  [-12, [8, 14, 35], [40, 40, 70]],
  [-18, [2, 4, 12], [8, 10, 22]],
];

/**
 * Fallback sky colours (zenith and horizon, CSS rgb strings) when Cesium's
 * own atmosphere is not drawn from the ground (flat-horizon mode). Pure.
 */
export function skyGradient(sunAltDeg) {
  const h = Number.isFinite(sunAltDeg) ? sunAltDeg : -90;
  let lo = GRADIENT_KNOTS.at(-1);
  let hi = GRADIENT_KNOTS[0];
  if (h >= hi[0]) lo = hi;
  else if (h > lo[0]) {
    for (let i = 1; i < GRADIENT_KNOTS.length; i++) {
      if (h >= GRADIENT_KNOTS[i][0]) {
        hi = GRADIENT_KNOTS[i - 1];
        lo = GRADIENT_KNOTS[i];
        break;
      }
    }
  } else hi = lo;
  const t = hi === lo ? 0 : (h - lo[0]) / (hi[0] - lo[0]);
  const mix = (a, b) =>
    `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(', ')})`;
  return { zenith: mix(lo[1], hi[1]), horizon: mix(lo[2], hi[2]) };
}

/**
 * P1 spike result (S4 headless Chromium, Houston, 2026-10-11): with globe
 * lighting following the Sun, Cesium's ground-level atmosphere is right in
 * daylight and dark at night, and the Tycho-2 skybox renders from the ground.
 * In civil twilight it is far too dark (sky nearly black with every skybox
 * star at Sun -5 deg). So the skybox shows only once nautical twilight ends
 * (Sun <= -12 deg) and the overlay adds a twilight wash between 0 and -12.
 */
export const SKYBOX_MAX_SUN_ALT_DEG = -12;

export const skyBoxVisible = (sunAltDeg) =>
  Number.isFinite(sunAltDeg) && sunAltDeg <= SKYBOX_MAX_SUN_ALT_DEG;

/**
 * Twilight wash painted above the horizon: strongest just after sunset,
 * nothing in daylight or once nautical twilight ends. Pure.
 * @returns {?{alpha:number, zenith:string, horizon:string}}
 */
export function twilightWash(sunAltDeg) {
  if (!Number.isFinite(sunAltDeg) || sunAltDeg > 0 || sunAltDeg <= -12)
    return null;
  const alpha =
    sunAltDeg >= -2 ? (-sunAltDeg / 2) * 0.55 : 0.55 * ((sunAltDeg + 12) / 10);
  return {
    alpha: Math.max(0, Math.min(0.55, alpha)),
    ...skyGradient(sunAltDeg),
  };
}
