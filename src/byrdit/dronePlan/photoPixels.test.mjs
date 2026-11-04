import test from 'node:test';
import assert from 'node:assert/strict';
import { readPhotoPixels } from './photoPixels.js';

test('local decoder scales large photos and always closes the bitmap', async () => {
  let closed = 0;
  const bitmap = {
    width: 8192,
    height: 6144,
    close() {
      closed++;
    },
  };
  let drawn;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage(...args) {
          drawn = args;
        },
        getImageData(x, y, w, h) {
          return {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          };
        },
      };
    },
  };
  const result = await readPhotoPixels(
    {},
    { decode: async () => bitmap, createCanvas: () => canvas, maxEdge: 512 },
  );
  assert.equal(result.width, 512);
  assert.equal(result.height, 384);
  assert.equal(drawn[0], bitmap);
  assert.equal(closed, 1);
});

test('local decoder closes the bitmap when canvas read fails', async () => {
  let closed = 0;
  const bitmap = {
    width: 100,
    height: 100,
    close() {
      closed++;
    },
  };
  await assert.rejects(
    readPhotoPixels(
      {},
      {
        decode: async () => bitmap,
        createCanvas: () => ({ getContext: () => null }),
      },
    ),
  );
  assert.equal(closed, 1);
});
