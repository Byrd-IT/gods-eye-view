import test from 'node:test';
import assert from 'node:assert/strict';
import { readPhotoPixels, readNativePhotoTiles } from './photoPixels.js';

test('native samples cover a 3x3 grid without resizing and release bitmap', async () => {
  let closed = 0;
  const bitmap = {
    width: 8192,
    height: 6144,
    close() {
      closed++;
    },
  };
  const draws = [];
  const canvas = {
    getContext: () => ({
      drawImage: (...args) => draws.push(args),
      getImageData: (x, y, width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
    }),
  };
  const tiles = await readNativePhotoTiles(
    {},
    { decode: async () => bitmap, createCanvas: () => canvas, tileSize: 128 },
  );
  assert.equal(tiles.length, 9);
  assert.deepEqual(draws[0].slice(1), [0, 0, 128, 128, 0, 0, 128, 128]);
  assert.deepEqual(draws[8].slice(1), [8064, 6016, 128, 128, 0, 0, 128, 128]);
  assert.equal(closed, 1);
});

test('native sampling handles small images and closes on failure', async () => {
  let closed = 0;
  const bitmap = {
    width: 20,
    height: 10,
    close() {
      closed++;
    },
  };
  const dimensions = [];
  const canvas = {
    getContext: () => ({
      drawImage: (...args) => dimensions.push(args.slice(1)),
      getImageData: (x, y, width, height) => ({ width, height }),
    }),
  };
  const tiles = await readNativePhotoTiles(
    {},
    { decode: async () => bitmap, createCanvas: () => canvas },
  );
  assert.equal(tiles.length, 1);
  assert.deepEqual(dimensions[0], [0, 0, 20, 10, 0, 0, 20, 10]);
  await assert.rejects(
    readNativePhotoTiles(
      {},
      {
        decode: async () => bitmap,
        createCanvas: () => ({ getContext: () => null }),
      },
    ),
  );
  assert.equal(closed, 2);
});

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
