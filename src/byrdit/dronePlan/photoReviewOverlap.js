/** Local flat-ground footprint model, NOT measured reconstruction coverage.
 * Uses planned ground and a shared takeoff datum assumption; never silently
 * substitutes relative altitude for AGL. Horizon-clipped frames stay unknown.
 */
import { photoFootprint } from './checkGeometry.js';
import { focalPx } from './photoCheck.js';
import { makeFrame } from './geo.js';

const finite = Number.isFinite;
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const area = (points) => Math.abs(points.reduce((sum, a, i) => {
  const b = points[(i + 1) % points.length];
  return sum + a.x * b.y - a.y * b.x;
}, 0)) / 2;

// Sutherland–Hodgman clipping of convex camera quadrilaterals.
function intersection(subject, clip) {
  const signed = clip.reduce((sum, a, i) => {
    const b = clip[(i + 1) % clip.length];
    return sum + a.x * b.y - a.y * b.x;
  }, 0);
  const sign = signed < 0 ? -1 : 1;
  let result = subject;
  for (let i = 0; i < clip.length && result.length; i += 1) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const input = result;
    result = [];
    let previous = input[input.length - 1];
    let dp = sign * cross(a, b, previous);
    for (const point of input) {
      const dc = sign * cross(a, b, point);
      if ((dc >= 0) !== (dp >= 0)) {
        const t = dp / (dp - dc);
        result.push({ x: previous.x + t * (point.x - previous.x), y: previous.y + t * (point.y - previous.y) });
      }
      if (dc >= 0) result.push(point);
      previous = point;
      dp = dc;
    }
  }
  return result;
}

function footprint(photo, shot) {
  if (!photo || ![photo.lon, photo.lat, photo.relAltM, photo.gimbalPitchDeg,
    photo.gimbalYawDeg, photo.widthPx, photo.heightPx, shot.aglM, shot.relHeightM].every(finite)) return null;
  const f = focalPx(photo);
  const aglM = shot.aglM + photo.relAltM - shot.relHeightM;
  if (!(f > 0 && aglM > 0 && photo.widthPx > 0 && photo.heightPx > 0)) return null;
  const out = photoFootprint({ lon: photo.lon, lat: photo.lat, aglM, pitchDeg: photo.gimbalPitchDeg }, photo.gimbalYawDeg, {
    sensorWidthMm: photo.widthPx, sensorHeightMm: photo.heightPx, focalMm: f,
  });
  return out.empty || out.clipped ? null : out.corners;
}

export function assessPhotoOverlap(photos = [], shots = []) {
  const groups = new Map();
  for (const shot of shots) {
    const key = JSON.stringify([shot.pass, shot.mission, shot.leg, shot.shot]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shot);
  }
  const pairs = [];
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i += 1) {
      const left = group[i - 1];
      const right = group[i];
      const row = { shotKeys: [left.key, right.key], status: 'unknown', overlapFraction: null, reason: 'overlap-unknown' };
      pairs.push(row);
      if (left.status !== 'matched' || right.status !== 'matched') continue;
      // Unequal ground elevations cannot be intersected on one common plane.
      const groundLeft = left.relHeightM - left.aglM;
      const groundRight = right.relHeightM - right.aglM;
      if (!finite(groundLeft) || !finite(groundRight) || Math.abs(groundLeft - groundRight) > 0.5) continue;
      const a = footprint(photos[left.photoIndex], left);
      const b = footprint(photos[right.photoIndex], right);
      if (!a || !b) continue;
      const frame = makeFrame(a[0].lon, a[0].lat);
      const ax = a.map((p) => frame.toXY(p.lon, p.lat));
      const bx = b.map((p) => frame.toXY(p.lon, p.lat));
      const denominator = Math.min(area(ax), area(bx));
      if (!(denominator > 0)) continue;
      row.overlapFraction = Math.max(0, Math.min(1, area(intersection(ax, bx)) / denominator));
      row.status = 'modeled';
      row.reason = row.overlapFraction < 0.01 ? 'modeled-overlap-gap' : null;
    }
  }
  return {
    verified: false,
    model: 'adjacent-same-leg-view-flat-ground',
    note: 'Conditional estimate using planned ground and a common takeoff datum, not verified usable overlap. Ignores terrain, structures, occlusion, roll and image quality. Only adjacent shots of the same leg/view are compared; no sidelap or complete coverage certification. A gap means less than 1% shared area of the smaller footprint, not a photogrammetry overlap target.',
    pairs,
  };
}
