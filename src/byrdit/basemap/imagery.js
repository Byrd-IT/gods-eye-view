/**
 * Byrd-IT Open imagery (BASEMAP.md 4.2): one Cesium imagery layer over the
 * same-origin archive /basemap/imagery/<archive>/{z}/{x}/{y}.webp.
 *
 * The archive holds a global coarse base (NASA GIBS, z0..baseMaxzoom) and
 * Sentinel-2 detail only inside the covered regions listed in
 * /basemap/config.json. Outside those regions, or above a region's max zoom,
 * the provider sends NO request for the missing tile. It crops and enlarges
 * the nearest ancestor the archive does have (the "coarse global base"). A
 * detail tile that answers 204 or fails inside a region gets the same
 * treatment from the base ancestor. Only a tile whose ancestor also fails is
 * reported to Cesium, which is what the controller's tile-failure fallback
 * to Esri counts (service down).
 *
 * planTile() and the coordinate helpers are pure and tested without Cesium.
 */

const TILE_SIZE = 256;

/** Longitude/latitude bounds of a Web Mercator XYZ tile. */
export function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lon = (i) => (i / n) * 360 - 180;
  const lat = (j) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

function intersects([w1, s1, e1, n1], [w2, s2, e2, n2]) {
  return w1 < e2 && w2 < e1 && s1 < n2 && s2 < n1;
}

/**
 * The deepest zoom the archive serves for this tile: a covered region's
 * max zoom when the tile touches one, else the global base max zoom.
 */
export function coveredMaxzoom(imagery, x, y, z) {
  if (z <= imagery.baseMaxzoom) return imagery.baseMaxzoom;
  const rect = tileBounds(x, y, z);
  let best = null;
  for (const region of imagery.regions)
    if (intersects(rect, region.bounds))
      best = Math.max(best ?? -1, region.maxzoom);
  return best === null
    ? imagery.baseMaxzoom
    : Math.max(best, imagery.baseMaxzoom);
}

/** True when the camera point is inside a detail region (UI status only). */
export function isCovered(imagery, lon, lat) {
  return imagery.regions.some(
    ({ bounds: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n,
  );
}

/** The ancestor tile at `level` and the sub-square of it that covers x/y/z. */
export function ancestorOf(x, y, z, level) {
  const d = z - level;
  const n = 2 ** d;
  const ax = Math.floor(x / n);
  const ay = Math.floor(y / n);
  return { x: ax, y: ay, z: level, n, col: x - ax * n, row: y - ay * n };
}

/**
 * Decide how to get a tile.
 * @returns {{kind: 'direct', fallbackLevel: number} | {kind: 'ancestor', level: number}}
 */
export function planTile(imagery, x, y, z) {
  const max = coveredMaxzoom(imagery, x, y, z);
  if (z <= max)
    return {
      kind: 'direct',
      fallbackLevel: Math.min(imagery.baseMaxzoom, z - 1),
    };
  return { kind: 'ancestor', level: max };
}

/**
 * The source rectangle of the child inside the ancestor image. A bitmap that
 * Cesium decoded with flipY (ImageBitmap) is stored bottom-up, so the row is
 * mirrored for it.
 */
export function cropRect(width, height, { n, col, row }, flipped) {
  const sw = width / n;
  const sh = height / n;
  const sx = col * sw;
  const sy = flipped ? height - (row + 1) * sh : row * sh;
  return { sx, sy, sw, sh };
}

function isImageBitmap(image) {
  return (
    typeof globalThis.ImageBitmap !== 'undefined' &&
    image instanceof globalThis.ImageBitmap
  );
}

/** Enlarge part of an ancestor image to a full tile (browser only). */
export async function cropAncestorImage(image, part, size = TILE_SIZE) {
  const flipped = isImageBitmap(image);
  const width = image.width;
  const height = image.height;
  const { sx, sy, sw, sh } = cropRect(width, height, part, flipped);
  if (flipped && typeof globalThis.createImageBitmap === 'function')
    // Same orientation as the bottom-up source, which is what Cesium expects.
    return globalThis.createImageBitmap(image, sx, sy, sw, sh, {
      resizeWidth: size,
      resizeHeight: size,
      resizeQuality: 'medium',
    });
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
  return canvas;
}

/**
 * @param {object} Cesium - the Cesium namespace (injected for tests).
 * @param {ReturnType<import('./config.js').normalizeBasemapConfig>['imagery']} imagery
 * @param {{crop?: Function, cacheSize?: number}} [options]
 */
export function createBasemapImageryProvider(
  Cesium,
  imagery,
  { crop = cropAncestorImage, cacheSize = 64 } = {},
) {
  const base = Cesium.UrlTemplateImageryProvider.prototype.requestImage;
  const ancestors = new Map();

  class BasemapImageryProvider extends Cesium.UrlTemplateImageryProvider {
    requestImage(x, y, level, request) {
      const plan = planTile(imagery, x, y, level);
      if (plan.kind === 'ancestor')
        return this._fromAncestor(x, y, level, plan.level);
      const pending = super.requestImage(x, y, level, request);
      // undefined = Cesium's request throttle said "not now"; pass it on.
      if (!pending || plan.fallbackLevel < 0) return pending;
      return Promise.resolve(pending).catch(() =>
        this._fromAncestor(x, y, level, plan.fallbackLevel),
      );
    }

    _ancestor(x, y, z) {
      const key = `${z}/${x}/${y}`;
      let entry = ancestors.get(key);
      if (entry) {
        ancestors.delete(key);
        ancestors.set(key, entry);
        return entry;
      }
      entry = Promise.resolve(base.call(this, x, y, z, undefined));
      entry.catch(() => ancestors.delete(key));
      ancestors.set(key, entry);
      while (ancestors.size > cacheSize)
        ancestors.delete(ancestors.keys().next().value);
      return entry;
    }

    async _fromAncestor(x, y, z, level) {
      const part = ancestorOf(x, y, z, level);
      const image = await this._ancestor(part.x, part.y, part.z);
      if (!image) throw new Error(`No ancestor imagery for ${z}/${x}/${y}`);
      return crop(image, part, TILE_SIZE);
    }
  }

  return new BasemapImageryProvider({
    url: imagery.url,
    maximumLevel: imagery.maxzoom,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    hasAlphaChannel: false,
  });
}
