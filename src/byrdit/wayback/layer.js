import { MAX_LEVEL, tileTemplate } from './model.js';

const TILE_SIZE = 256;

function transparentTile() {
  const doc = globalThis.document;
  if (!doc?.createElement) return undefined;
  const canvas = doc.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  return canvas;
}

/**
 * Imagery provider for one Wayback release: the same-origin tile route as a
 * Cesium URL template (WebMercator, 256 px, z / row / col). A tile the
 * server cannot give (404 no imagery, 502 upstream trouble) becomes a
 * transparent tile, so Cesium does not retry it in a loop and the Esri base
 * shows through that one tile.
 */
export function createWaybackImageryProvider(
  Cesium,
  release,
  { blank = transparentTile, credit } = {},
) {
  let empty = null;
  const none = () => (empty ??= blank());
  class WaybackImageryProvider extends Cesium.UrlTemplateImageryProvider {
    requestImage(x, y, level, request) {
      const pending = super.requestImage(x, y, level, request);
      if (!pending) return pending; // Cesium's throttle: "not now"
      return Promise.resolve(pending).then(
        (image) => image ?? none(),
        () => none(),
      );
    }
  }
  return new WaybackImageryProvider({
    url: tileTemplate(release),
    minimumLevel: 0,
    maximumLevel: MAX_LEVEL,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    ...(credit ? { credit } : {}),
  });
}
