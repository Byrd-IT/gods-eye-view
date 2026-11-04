/** Combine local measurements and planned shot identity without upgrading
 * heuristic findings to confirmed defects. No inferred flight instructions.
 */
import { matchPhotosToShots } from './photoQualityMatch.js';
import { assessPhotoOverlap } from './photoReviewOverlap.js';

export function buildPhotoReviewReport(
  photos = [],
  shots = [],
  { rejected = [], skippedOver = 0, cancelled = false } = {},
) {
  // Unread, omitted or unlocated files may contain an unmatched planned shot.
  // Keep positive associations, but never infer absence from a partial batch.
  const coverageIncomplete = Boolean(
    skippedOver > 0 ||
    rejected.length ||
    cancelled ||
    photos.some((p) => !Number.isFinite(p.lon) || !Number.isFinite(p.lat)),
  );
  const seen = new Map();
  const unique = [];
  const originalIndexes = [];
  const rows = photos.map((photo, index) => {
    const digest =
      typeof photo.digest === 'string' && /^[0-9a-f]{64}$/.test(photo.digest)
        ? photo.digest
        : null;
    const duplicateOf =
      digest != null && seen.has(digest) ? seen.get(digest) : null;
    if (duplicateOf == null) {
      if (digest != null) seen.set(digest, index);
      unique.push(photo);
      originalIndexes.push(index);
    }
    const reasons = [...(photo.review?.reasons ?? [])];
    if (!Number.isFinite(photo.lon) || !Number.isFinite(photo.lat))
      reasons.push('no-position');
    if (!photo.review?.sampleCount || !Number.isFinite(photo.review?.score))
      reasons.push('quality-unknown');
    if (duplicateOf != null) reasons.push('exact-duplicate');
    return {
      index,
      name: photo.name,
      score: photo.review?.score ?? null,
      evidence: {
        sampleCount: photo.review?.sampleCount ?? 0,
        scoreNote: photo.review?.scoreNote ?? null,
        samples: photo.review?.samples ?? [],
        positionSource: photo.positionSource ?? null,
        lon: photo.lon ?? null,
        lat: photo.lat ?? null,
        relAltM: photo.relAltM ?? null,
        gimbalPitchDeg: photo.gimbalPitchDeg ?? null,
        gimbalYawDeg: photo.gimbalYawDeg ?? null,
        digest,
      },
      duplicateOf,
      reasons: [...new Set(reasons)],
      shotKey: null,
    };
  });
  const matches = matchPhotosToShots(unique, shots);
  if (coverageIncomplete) {
    matches.shots = matches.shots.map((shot) => {
      if (shot.status !== 'missing') return shot;
      const unknown = {
        ...shot,
        status: 'unknown',
        reason: 'coverage-unknown',
      };
      matches.unknown.push({ ...unknown, kind: 'shot', shotKey: shot.key });
      return unknown;
    });
    matches.missing = [];
  }
  const overlap = assessPhotoOverlap(unique, matches.shots);
  const gapKeys = new Set(
    overlap.pairs
      .filter((pair) => pair.reason === 'modeled-overlap-gap')
      .flatMap((pair) => pair.shotKeys),
  );
  const refly = [];
  for (const shot of matches.shots) {
    const reasons = gapKeys.has(shot.key) ? ['modeled-overlap-gap'] : [];
    if (shot.status === 'missing') reasons.push('missing-photo');
    else if (shot.status === 'unknown')
      reasons.push(shot.reason ?? 'assignment-unknown');
    else {
      const row = rows[originalIndexes[shot.photoIndex]];
      row.shotKey = shot.key;
      if (shot.attitude !== 'agreed') reasons.push(`attitude-${shot.attitude}`);
      reasons.push(...row.reasons);
      row.reasons = [...new Set([...row.reasons, ...reasons])];
    }
    if (reasons.length)
      refly.push({
        ...shot,
        // Indexes published by this report always refer to the original input.
        photoIndex:
          shot.photoIndex == null ? null : originalIndexes[shot.photoIndex],
        decision:
          shot.status === 'missing'
            ? 'missing-capture'
            : 'inspect-before-refly',
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
  const exportedMatches = { ...matches };
  for (const field of [
    'shots',
    'matches',
    'missing',
    'retakes',
    'extraPhotos',
    'unmatchedPhotos',
    'unknown',
  ]) {
    exportedMatches[field] = matches[field].map((entry) =>
      Number.isInteger(entry.photoIndex)
        ? { ...entry, photoIndex: originalIndexes[entry.photoIndex] }
        : entry,
    );
  }
  return {
    coverageIncomplete,
    photos: rows,
    refly,
    matches: exportedMatches,
    originalIndexes,
    overlap,
    note: 'Re-fly candidates require inspection. Pixel findings are heuristic, native tiles do not cover every pixel, and a matched photo is not proof of usable overlap. Altitude offsets require a common takeoff datum.',
  };
}
