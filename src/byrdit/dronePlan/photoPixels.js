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
