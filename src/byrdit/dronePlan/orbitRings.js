/**
 * Orbit ring maths for the Drone Flight Plan: rings set by VIEWING ANGLE,
 * partial arcs, and look-at paths. Pure functions (no Cesium, no DOM).
 *
 * A ring is a circle of `radiusM` around the target flown at `aglM` above
 * ground. The camera looks at the aim point (`aimM` above ground at the
 * target), so the tilt below the horizon is atan((aglM - aimM) / radiusM).
 * Picking the ANGLE first (default 25, 40 and 55 degrees down) and working out
 * the height from it keeps the picture useful at any radius; the old fixed
 * 40 m and 80 m rings looked almost straight down at a small building.
 */
export const DEFAULT_RING_ANGLES_DEG = Object.freeze([25, 40, 55]);
export const MIN_RING_ANGLE_DEG = 10;
export const MAX_RING_ANGLE_DEG = 80;
export const MAX_RING_ANGLES = 6;
/** The outward photo of a building stop: level to 10 degrees down. */
export const DEFAULT_OUTWARD_PITCH_DEG = -5;
export const MIN_OUTWARD_PITCH_DEG = -45;
export const MAX_OUTWARD_PITCH_DEG = 0;
/** Time for the 180 degree turn, the tilt change and a second photo, seconds. */
export const OUTWARD_STOP_S = 4;
/** Time a stop-and-turn orbit waypoint costs even without an outward photo. */
export const ORBIT_STOP_S = 1.5;
/** The tallest ring may not be higher than this: 400 ft, metres. */
export const RING_MAX_AGL_M = 121.9;

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** Viewing angles as a clean list: finite, in range, no repeats, at most 6. */
export function normalizeRingAngles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (item == null || item === '') continue;
    const n = Number(item);
    if (!Number.isFinite(n)) continue;
    const a = round1(clamp(n, MIN_RING_ANGLE_DEG, MAX_RING_ANGLE_DEG));
    if (!out.includes(a)) out.push(a);
    if (out.length >= MAX_RING_ANGLES) break;
  }
  return out.length ? out : [...DEFAULT_RING_ANGLES_DEG];
}

/**
 * Rings for one target from viewing angles.
 *   height = aim + radius x tan(angle)
 * A ring that would sit below `floorAglM` (obstacle height plus margin, or
 * the roof plus clearance) is NOT steepened: the radius is widened until the
 * same angle reaches the floor. The height never passes `capAglM`; when the
 * cap bites, the ring keeps its radius and the angle gets shallower.
 * @returns {Array<{angleDeg:number, radiusM:number, aglM:number,
 *   pitchDeg:number, widened:boolean, capped:boolean, steepened:boolean}>}
 */
export function angleRings({
  aimM,
  radiusM,
  anglesDeg,
  floorAglM,
  capAglM = RING_MAX_AGL_M,
  maxRadiusM = 300,
}) {
  const aim = Math.max(0, Number(aimM) || 0);
  const baseR = Math.max(1, Number(radiusM) || 1);
  const floor = Math.max(0, Number(floorAglM) || 0);
  const cap = Math.max(floor, Number(capAglM) || RING_MAX_AGL_M);
  const rings = [];
  for (const angleDeg of normalizeRingAngles(anglesDeg)) {
    const tan = Math.tan(angleDeg * DEG);
    let r = baseR;
    let h = aim + r * tan;
    let widened = false;
    let capped = false;
    let steepened = false;
    if (h < floor - 1e-9) {
      // Widen, never steepen: the same angle reaches the floor further out.
      const need = (floor - aim) / tan;
      r = Math.min(maxRadiusM, Math.max(r, need));
      widened = r > baseR + 1e-9;
      h = aim + r * tan;
      if (h < floor - 1e-9) {
        // Even the widest radius cannot reach the floor at this angle.
        h = floor;
        steepened = true;
      }
    }
    if (h > cap + 1e-9) {
      h = cap;
      capped = true;
    }
    const dz = Math.max(1, h - aim);
    const pitchDeg = -clamp(Math.atan2(dz, r) / DEG, 5, 89);
    rings.push({
      angleDeg,
      radiusM: round1(r),
      aglM: round1(h),
      pitchDeg: round1(pitchDeg),
      widened,
      capped,
      steepened,
    });
  }
  // Two angles can land on one ring (the floor lifted both): fly it once.
  const seen = [];
  return rings.filter((ring) => {
    const dup = seen.some(
      (s) =>
        Math.abs(s.aglM - ring.aglM) < 0.05 &&
        Math.abs(s.radiusM - ring.radiusM) < 0.05,
    );
    if (!dup) seen.push(ring);
    return !dup;
  });
}

/** Compass bearing (degrees clockwise from north) as an XY-plane angle (radians). */
export const bearingToMath = (bearingDeg) => (90 - bearingDeg) * DEG;

/** A bearing into 0..360. */
export const wrap360 = (deg) => ((deg % 360) + 360) % 360;

/** A bearing into -180..180 (the range WPML headings use). */
export const wrap180 = (deg) => {
  const w = wrap360(deg);
  return w > 180 ? w - 360 : w;
};

/**
 * The blocked sector of an orbit: `from` clockwise to `to`, compass degrees
 * as seen from the target. Returns null when there is none (or it is not a
 * usable pair of numbers).
 */
export function normalizeBlocked(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.fromDeg == null || raw.toDeg == null) return null;
  if (raw.fromDeg === '' || raw.toDeg === '') return null;
  const from = Number(raw.fromDeg);
  const to = Number(raw.toDeg);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const f = round1(wrap360(from));
  const t = round1(wrap360(to));
  if (f === t) return null;
  return { fromDeg: f, toDeg: t };
}

/** Size of the blocked sector, degrees (0 when there is none). */
export function blockedSpanDeg(blocked) {
  const b = normalizeBlocked(blocked);
  return b ? wrap360(b.toDeg - b.fromDeg) : 0;
}

/**
 * Bearings (degrees clockwise from north, seen from the target) of the open
 * arc, first to last, going clockwise. The open arc starts where the blocked
 * sector ends and stops where it begins, so no stretch of it crosses the
 * blocked sector. `count` points include both ends.
 */
export function openArcBearings(blocked, count) {
  const b = normalizeBlocked(blocked);
  if (!b) return [];
  const open = 360 - wrap360(b.toDeg - b.fromDeg);
  const n = Math.max(2, Math.floor(count));
  const out = [];
  for (let k = 0; k < n; k += 1) {
    out.push(round1(wrap360(b.toDeg + (open * k) / (n - 1))));
  }
  return out;
}

/** True when `bearingDeg` lies inside the blocked sector. */
export function inBlockedSector(blocked, bearingDeg) {
  const b = normalizeBlocked(blocked);
  if (!b) return false;
  return wrap360(bearingDeg - b.fromDeg) < wrap360(b.toDeg - b.fromDeg);
}

/**
 * Camera pitch for a look-at point: from a drone `aglM` up and `distM` away
 * (ground distance) at an aim point `aimM` up. Clamped to 5..89 degrees down;
 * directly overhead (distance 0) is 89, never undefined.
 */
export function lookAtPitchDeg(aglM, aimM, distM) {
  const dz = Math.max(1, aglM - aimM);
  return -clamp(Math.atan2(dz, Math.max(0, distM)) / DEG, 5, 89);
}
