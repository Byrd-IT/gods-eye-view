/** Combine local measurements and planned shot identity without upgrading
 * heuristic findings to confirmed defects. No inferred flight instructions.
 */
import { matchPhotosToShots } from './photoQualityMatch.js';

export function buildPhotoReviewReport(photos = [], shots = []) {
  const seen = new Map();
  const unique = [];
  const originalIndexes = [];
  const rows = photos.map((photo, index) => {
    const digest = typeof photo.digest === 'string' && /^[0-9a-f]{64}$/.test(photo.digest)
      ? photo.digest : null;
    const duplicateOf = digest != null && seen.has(digest) ? seen.get(digest) : null;
    if (duplicateOf == null) {
      if (digest != null) seen.set(digest, index);
      unique.push(photo);
      originalIndexes.push(index);
    }
    const reasons = [...(photo.review?.reasons ?? [])];
    if (!Number.isFinite(photo.lon) || !Number.isFinite(photo.lat)) reasons.push('no-position');
    if (!photo.review?.sampleCount) reasons.push('quality-unknown');
    if (duplicateOf != null) reasons.push('exact-duplicate');
    return {
      index, name: photo.name, score: photo.review?.score ?? null,
      duplicateOf, reasons: [...new Set(reasons)], shotKey: null,
    };
  });
  const matches = matchPhotosToShots(unique, shots);
  const refly = [];
  for (const shot of matches.shots) {
    const reasons = [];
    if (shot.status === 'missing') reasons.push('missing-photo');
    else if (shot.status === 'unknown') reasons.push(shot.reason ?? 'assignment-unknown');
    else {
      const row = rows[originalIndexes[shot.photoIndex]];
      row.shotKey = shot.key;
      if (shot.attitude !== 'agreed') reasons.push(`attitude-${shot.attitude}`);
      reasons.push(...row.reasons);
      row.reasons = [...new Set([...row.reasons, ...reasons])];
    }
    if (reasons.length) refly.push({
      ...shot,
      // Indexes published by this report always refer to the original input.
      photoIndex: shot.photoIndex == null ? null : originalIndexes[shot.photoIndex],
      decision: shot.status === 'missing' ? 'missing-capture' : 'inspect-before-refly',
      reasons: [...new Set(reasons)],
    });
  }
  for (const unmatched of matches.unmatchedPhotos) {
    const row = rows[originalIndexes[unmatched.photoIndex]];
    row.reasons = [...new Set([...row.reasons, unmatched.reason])];
  }
  for (const unknown of matches.unknown) {
    if (unknown.kind !== 'photo') continue;
    const row = rows[originalIndexes[unknown.photoIndex]];
    row.reasons = [...new Set([...row.reasons, unknown.reason])];
  }
  return {
    photos: rows, refly, matches, originalIndexes,
    note: 'Re-fly candidates require inspection. Pixel findings are heuristic, native tiles do not cover every pixel, and a matched photo is not proof of usable overlap. Altitude offsets require a common takeoff datum.',
  };
}
