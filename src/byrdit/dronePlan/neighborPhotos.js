/**
 * Which photos sit next to the one being stepped through in the 3D check:
 * the one AHEAD and the one BEHIND on the same flight line, and the nearest
 * photo on the line beside it on the LEFT and on the RIGHT. Pure maths in a
 * local east/north metre frame: no Cesium, no DOM.
 *
 * VISUAL AID ONLY, like the rest of the 3D check.
 */
import { makeFrame } from './geo.js';

/** A line counts as parallel to the stepped one within this angle, degrees. */
export const PARALLEL_TOLERANCE_DEG = 20;
/**
 * Photos of the next line whose sideways distance differs by less than this
 * (metres) are all "equally beside" the stepped photo; the one closest along
 * the track wins. A small tilt between two lines must not pick the photo at
 * the far end of the line just because it is a few centimetres nearer.
 */
export const LATERAL_TIE_M = 0.5;
/** A photo this close to the stepped photo's track is on neither side, m. */
const LATERAL_MIN_M = 0.01;
/** Shorter than this is no direction at all, m. */
const MIN_RUN_M = 0.01;

const SIDES = Object.freeze(['front', 'back', 'left', 'right']);
export const NEIGHBOR_SIDES = SIDES;

/** The neighbours when there is nothing to resolve. */
const none = () => ({ front: null, back: null, left: null, right: null });

/** Unit vector of a run between two metre points, or null when too short. */
function unit(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len < MIN_RUN_M ? null : { x: dx / len, y: dy / len };
}

/**
 * The neighbours of `photos[index]`.
 *
 * `photos` is the list the 3D check steps through, in step order. Each:
 *   { lon, lat, scope, leg, kind? }
 * `scope` names the pass and mission (neighbours are only ever found inside
 * it: photos of other missions or passes of a suite are never used), `leg` the
 * flight line inside it (photos of one line share it), `kind` is 'orbit' for a
 * circle, which has an ahead and a behind but no left or right.
 *
 * Returns { front, back, left, right }: each an index into `photos`, or null
 * when there is none on that side.
 *
 *  front   the next photo on the same line in step order
 *  back    the previous photo on the same line
 *  left /  the nearest photo on ANOTHER line of the same mission that runs
 *  right   within PARALLEL_TOLERANCE_DEG of parallel (either way round: a
 *          snaking grid turns every second line round). "Nearest" is the
 *          smallest sideways distance (ties within LATERAL_TIE_M), then the
 *          smallest distance along the track, then the closest in a straight
 *          line. Sideways is measured on the left normal n = (-dy, dx) of the
 *          travel direction d: positive is left.
 *
 * d runs from the previous to the next photo of the stepped photo's line; on
 * the first or last photo of the line it is the line's overall direction
 * (first photo to last photo).
 */
export function neighborPhotos(photos, index) {
  const p = Array.isArray(photos) ? photos[index] : null;
  if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return none();

  // The photos of the stepped photo's scope, grouped by line, in step order.
  const lines = new Map();
  photos.forEach((q, k) => {
    if (!q || q.scope !== p.scope) return;
    if (!Number.isFinite(q.lon) || !Number.isFinite(q.lat)) return;
    if (!lines.has(q.leg)) lines.set(q.leg, []);
    lines.get(q.leg).push(k);
  });
  const own = lines.get(p.leg) ?? [];
  const at = own.indexOf(index);
  const out = none();
  if (at < 0) return out;
  out.front = at + 1 < own.length ? own[at + 1] : null;
  out.back = at > 0 ? own[at - 1] : null;
  if (p.kind === 'orbit') return out;

  const frame = makeFrame(p.lon, p.lat);
  const xy = (k) => frame.toXY(photos[k].lon, photos[k].lat);
  const chord = (ks) => unit(xy(ks[0]), xy(ks[ks.length - 1]));

  // Travel direction: previous to next, else the line's overall direction.
  const both = out.back !== null && out.front !== null;
  const d = (both ? unit(xy(out.back), xy(out.front)) : null) ?? chord(own);
  if (!d) return out;
  const nx = -d.y;
  const ny = d.x;
  const sinMax = Math.sin((PARALLEL_TOLERANCE_DEG * Math.PI) / 180);

  const sides = { left: [], right: [] };
  for (const [leg, ks] of lines) {
    if (leg === p.leg || photos[ks[0]].kind === 'orbit') continue;
    const c = chord(ks);
    if (!c) continue;
    // Parallel either way round: |sin| of the angle between the two lines.
    if (Math.abs(d.x * c.y - d.y * c.x) > sinMax) continue;
    for (const k of ks) {
      const q = xy(k);
      const lateral = q.x * nx + q.y * ny;
      if (Math.abs(lateral) < LATERAL_MIN_M) continue;
      const entry = {
        k,
        lateral: Math.abs(lateral),
        along: Math.abs(q.x * d.x + q.y * d.y),
        dist: Math.hypot(q.x, q.y),
      };
      (lateral > 0 ? sides.left : sides.right).push(entry);
    }
  }
  for (const side of ['left', 'right']) {
    const list = sides[side];
    if (!list.length) continue;
    const nearest = Math.min(...list.map((e) => e.lateral));
    const best = list
      .filter((e) => e.lateral <= nearest + LATERAL_TIE_M)
      .sort(
        (a, b) => a.along - b.along || a.dist - b.dist || a.lateral - b.lateral,
      )[0];
    out[side] = best.k;
  }
  return out;
}
