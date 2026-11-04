/** Browser-local review pipeline. Sequential decode bounds live bitmap memory.
 * Only measurements survive a file: no File, bitmap or pixel data in results.
 * Heuristic findings request inspection; they are not calibrated retake orders.
 */
import { HEADER_BYTES, readPhotoMeta } from './photoExif.js';
import { MAX_PHOTOS } from './photoCheck.js';
import { readNativePhotoTiles } from './photoPixels.js';
import { analyzePhotoQuality } from './photoQuality.js';

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

function summarize(samples, photo) {
  const measured = samples.filter(
    (sample) => sample.ok && sample.code === 'measured',
  );
  const reasons = new Set();
  if (photo.positionSource == null) reasons.add('no-position');
  if (!measured.length) reasons.add('pixels-unavailable');
  for (const sample of measured) {
    for (const id of sample.findings) reasons.add(sample.metrics[id].code);
    if (sample.metrics.shadows.code === 'dark-contrast-unknown')
      reasons.add('dark-contrast-unknown');
  }
  const scores = measured
    .map((s) => s.score)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    score: scores.length ? scores[Math.floor(scores.length / 2)] : null,
    scoreNote:
      'Median native-tile heuristic score, not a calibrated pass/fail grade. Unsampled regions may contain defects. Inspect findings before planning retakes.',
    sampleCount: measured.length,
    reasons: [...reasons],
    samples,
  };
}

/** Read a finite batch in order. Abort cancels publication, including the current
 * file; the decoder still completes its finally/bitmap.close before returning.
 * Injected readers make the same orchestration usable in local offline probes.
 */
export async function reviewPhotoFiles(
  files,
  {
    signal,
    maxPhotos = MAX_PHOTOS,
    readTiles = readNativePhotoTiles,
    yieldControl = yieldToBrowser,
  } = {},
) {
  const list = Array.from(files ?? []);
  const cap =
    Number.isSafeInteger(maxPhotos) && maxPhotos >= 0
      ? Math.min(maxPhotos, MAX_PHOTOS)
      : MAX_PHOTOS;
  const result = {
    photos: [],
    rejected: [],
    skippedOver: Math.max(0, list.length - cap),
    cancelled: false,
  };
  for (const file of list.slice(0, cap)) {
    if (signal?.aborted) break;
    let metadata;
    try {
      const bytes = new Uint8Array(
        await file.slice(0, HEADER_BYTES).arrayBuffer(),
      );
      metadata = readPhotoMeta(bytes, String(file.name ?? ''), {
        includeUnlocated: true,
      });
    } catch {
      // Do not retain exception messages: browser/decoder errors may contain
      // user-controlled strings. Names remain deliberate report data only.
      metadata = { ok: false, reason: 'header-unavailable' };
    }
    if (signal?.aborted) break;
    if (!metadata.ok) {
      result.rejected.push({
        name: String(file.name ?? ''),
        reason: metadata.reason,
      });
    } else {
      let samples = [];
      try {
        const tiles = await readTiles(file);
        if (signal?.aborted) break;
        samples = tiles.map((tile) => analyzePhotoQuality(tile));
      } catch {
        // An unreadable image is unknown, never a clean image or a lost row.
      }
      if (signal?.aborted) break;
      let digest = null;
      try {
        const bytes = await file.arrayBuffer();
        if (signal?.aborted) break;
        const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        digest = Array.from(new Uint8Array(hash), (v) =>
          v.toString(16).padStart(2, '0'),
        ).join('');
      } catch {
        // No name/metadata-only fallback: a copy suffix is not proof of identity.
      }
      if (signal?.aborted) break;
      const review = summarize(samples, metadata.photo);
      if (digest == null) review.reasons.push('duplicate-check-unavailable');
      result.photos.push({ ...metadata.photo, digest, review });
    }
    await yieldControl();
  }
  result.cancelled = Boolean(signal?.aborted);
  return result;
}
