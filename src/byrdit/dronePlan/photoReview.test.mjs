import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPhotoFiles } from './photoReview.js';

const file = (name) => ({ name, slice: () => ({ arrayBuffer: async () => Uint8Array.of(255, 216, 255, 217).buffer }) });
const tile = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(100) };

test('review retains unlocated JPEGs and measurements, not pixel buffers', async () => {
  const result = await reviewPhotoFiles([file('a.jpg')], { readTiles: async () => [tile] });
  assert.equal(result.photos.length, 1);
  const photo = result.photos[0];
  assert.equal(photo.positionSource, null);
  assert.ok(photo.review.reasons.includes('no-position'));
  assert.equal(photo.review.sampleCount, 1);
  assert.equal(photo.review.samples[0].ok, true);
  assert.equal(photo.review.samples[0].metrics.blur.status, 'unknown');
  assert.equal(JSON.stringify(result).includes('"data":'), false);
});

test('decodes sequentially and yields between files', async () => {
  let active = 0; let peak = 0; let yields = 0;
  const result = await reviewPhotoFiles([file('a'), file('b'), file('c')], {
    readTiles: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return [tile]; },
    yieldControl: async () => { yields++; },
  });
  assert.equal(peak, 1);
  assert.equal(yields, 3);
  assert.deepEqual(result.photos.map((p) => p.name), ['a', 'b', 'c']);
});

test('decode and header failures are isolated, generic and do not discard other photos', async () => {
  const secret = 'Bearer fake-private-token-ABC123';
  const brokenHeader = { name: 'broken', slice() { throw new Error(secret); } };
  const result = await reviewPhotoFiles([brokenHeader, file('broken-pixels'), file('good')], {
    readTiles: async (f) => { if (f.name === 'broken-pixels') throw new Error(secret); return [tile]; },
  });
  assert.equal(result.rejected.length, 1);
  assert.equal(result.photos.length, 2);
  assert.ok(result.photos[0].review.reasons.includes('pixels-unavailable'));
  assert.equal(result.photos[0].review.score, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('abort during decode discards in-flight result and never starts next file', async () => {
  const controller = new AbortController(); let decodes = 0;
  const result = await reviewPhotoFiles([file('a'), file('b')], {
    signal: controller.signal,
    readTiles: async () => { decodes++; controller.abort(); return [tile]; },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.photos.length, 0);
  assert.equal(decodes, 1);
});

test('pre-aborted review reads nothing; cap accounts for omitted files', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await reviewPhotoFiles([file('a')], { signal: controller.signal, readTiles: () => { throw new Error('must not run'); } });
  assert.equal(result.cancelled, true);
  assert.equal(result.photos.length, 0);
  const capped = await reviewPhotoFiles([file('a'), file('b')], { maxPhotos: 1, readTiles: async () => [tile] });
  assert.equal(capped.skippedOver, 1);
  assert.equal(capped.photos.length, 1);
});

test('empty samples remain unassessed rather than passing', async () => {
  const result = await reviewPhotoFiles([file('a')], { readTiles: async () => [] });
  assert.equal(result.photos[0].review.score, null);
  assert.ok(result.photos[0].review.reasons.includes('pixels-unavailable'));
});
