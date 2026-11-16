/**
 * How much of one photo's ground footprint another photo covers: the area of
 * the overlap of the two footprint quadrilaterals divided by the area of the
 * first. Pure maths in a local east/north metre frame (no Cesium, no DOM).
 * A footprint is a convex four-corner shape (near-left, near-right,
 * far-right, far-left), so a Sutherland-Hodgman clip gives the overlap and the
 * shoelace formula its area.
 *
 * VISUAL AID ONLY, like the rest of the 3D check.
 */
import { makeFrame } from './geo.js';

/** A footprint smaller than this is degenerate, m². */
export const MIN_AREA_M2 = 1e-6;

/** Twice the signed area of a ring of {x, y}; positive when counter-clockwise. */
function signedArea2(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Area of a polygon of {x, y} metre points, m² (shoelace). */
export function polygonAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  return Math.abs(signedArea2(ring)) / 2;
}

/** Whether a ring turns the same way at every corner (collinear allowed). */
function isConvex(ring) {
  let sign = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return sign !== 0;
}

/** The ring wound counter-clockwise. */
const ccw = (ring) => (signedArea2(ring) < 0 ? [...ring].reverse() : [...ring]);

/**
 * The part of convex ring `subject` inside convex ring `clip` (Sutherland-
 * Hodgman); [] when they do not meet. Both are {x, y} metre points.
 */
export function clipConvex(subject, clip) {
  const s = ccw(subject);
  const c = ccw(clip);
  let out = s;
  for (let i = 0; i < c.length && out.length; i += 1) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    // Inside = left of the edge a->b.
    const side = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k += 1) {
      const cur = input[k];
      const prev = input[(k + input.length - 1) % input.length];
      const sc = side(cur);
      const sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) out.push(crossing(prev, cur, sp, sc));
        out.push(cur);
      } else if (sp >= 0) {
        out.push(crossing(prev, cur, sp, sc));
      }
    }
  }
  return out;
}

/** Where the segment prev->cur crosses the edge, from the two side values. */
function crossing(prev, cur, sp, sc) {
  const t = sp / (sp - sc);
  return { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
}

/**
 * Overlap of footprint `other` on footprint `selected`, as a percentage of
 * the selected footprint's area (0 to 100). Both are lists of { lon, lat }
 * corners. Returns null (not known) when either is missing, has fewer than
 * three corners, is degenerate or is not convex.
 */
export function footprintOverlapPct(selected, other) {
  if (!Array.isArray(selected) || !Array.isArray(other)) return null;
  if (selected.length < 3 || other.length < 3) return null;
  const finite = (p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat);
  if (!selected.every(finite) || !other.every(finite)) return null;
  const frame = makeFrame(selected[0].lon, selected[0].lat);
  const a = selected.map((p) => frame.toXY(p.lon, p.lat));
  const b = other.map((p) => frame.toXY(p.lon, p.lat));
  const areaA = polygonAreaM2(a);
  if (areaA < MIN_AREA_M2 || polygonAreaM2(b) < MIN_AREA_M2) return null;
  if (!isConvex(a) || !isConvex(b)) return null;
  const inter = polygonAreaM2(clipConvex(a, b));
  return Math.min(100, Math.max(0, (inter / areaA) * 100));
}
