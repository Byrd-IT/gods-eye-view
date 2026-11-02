/**
 * A ring stop with an outward photo is TWO waypoints at the same place.
 *
 * DJI Fly took only the first photo of a waypoint whose action group held two
 * takePhoto actions (first flight, 2026-11-01: 75 photos for 75 stops of a
 * 150-photo ring). So each photo gets a waypoint of its own: the inward
 * waypoint (facing the target, ring pitch) and, at the same position, the
 * outward waypoint (facing away, outward pitch). Every waypoint then carries
 * exactly one takePhoto, and counts, limits and time estimates see 2N.
 */
import { ORBIT_STOP_S, OUTWARD_STOP_S } from './orbitRings.js';

/** True while a waypoint still carries the old one-waypoint, two-photo form. */
export const hasOutwardShot = (w) =>
  Boolean(w) && w.photo !== false && w.outwardHeadingDeg != null;

/**
 * Split every waypoint that has an outward photo into an inward and an
 * outward waypoint (`shot` 'in' / 'out'). Waypoints without one pass through
 * untouched, so running this on its own output changes nothing.
 * @param {object[]} waypoints
 * @returns {object[]}
 */
export function splitOutwardShots(waypoints) {
  return waypoints.flatMap((w) => {
    if (!hasOutwardShot(w)) return [w];
    const { outwardHeadingDeg, outwardPitchDeg, ...rest } = w;
    return [
      { ...rest, shot: 'in', dwellS: ORBIT_STOP_S },
      {
        ...rest,
        shot: 'out',
        headingDeg: outwardHeadingDeg,
        pitchDeg: outwardPitchDeg,
        // Turn half way round and tilt away before the photo.
        dwellS: OUTWARD_STOP_S,
      },
    ];
  });
}
