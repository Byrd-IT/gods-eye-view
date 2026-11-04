/** Sample a bounded grid of native-resolution patches, without rescaling.
 * Samples are not a substitute for examining every pixel of the photograph.
 */
export async function readNativePhotoTiles(
  file,
  {
    decode = (input) => createImageBitmap(input),
    createCanvas = () => document.createElement('canvas'),
    tileSize = 256,
  } = {},
) {
  const bitmap = await decode(file);
  try {
    if (
      !Number.isSafeInteger(bitmap.width) ||
      !Number.isSafeInteger(bitmap.height) ||
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      !Number.isSafeInteger(tileSize) ||
      tileSize < 1 ||
      tileSize > 1024
    )
      throw new Error('Invalid image dimensions');
    const width = Math.min(tileSize, bitmap.width);
    const height = Math.min(tileSize, bitmap.height);
    const positions = (span) => [...new Set([0, Math.floor(span / 2), span])];
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image canvas unavailable');
    const tiles = [];
    for (const y of positions(bitmap.height - height)) {
      for (const x of positions(bitmap.width - width)) {
        context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
        tiles.push(context.getImageData(0, 0, width, height));
      }
    }
    return tiles;
  } finally {
    bitmap.close();
  }
}

/** Decode one local photo to bounded RGBA pixels. Nothing is uploaded or saved. */
export async function readPhotoPixels(
  file,
  {
    decode = (input) => createImageBitmap(input),
    createCanvas = () => document.createElement('canvas'),
    maxEdge = 512,
  } = {},
) {
  const bitmap = await decode(file);
  try {
    if (
      !Number.isFinite(bitmap.width) ||
      !Number.isFinite(bitmap.height) ||
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      !Number.isFinite(maxEdge) ||
      maxEdge < 1
    )
      throw new Error('Invalid image dimensions');
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image canvas unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}
