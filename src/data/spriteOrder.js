/** Bottom-to-top order of the sprite layers' icon and dot sets. */
export const SPRITE_LAYER_ORDER = Object.freeze([
  'shipwrecks',
  'cctv',
  'firms',
  'wildlife-sightings',
  'bikeshare',
  'transit',
  'transit-motion',
  'rail',
  'directions',
  'ais',
  'military',
  'flights',
]);

/** @type {Map<string, Object>} */
const _collections = new Map();

/**
 * Register the current primitive collection for a sprite layer.
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} collection - Cesium billboard/point primitive collection.
 * @returns {void}
 */
export function registerSpriteCollection(layerId, collection) {
  if (!layerId || !collection) return;
  _collections.set(layerId, collection);
}
export const spriteCollectionOf = (id) => _collections.get(id) ?? null;

/**
 * The draw order (`SetSpec.drawOrder`) a sprite layer's set is made with:
 * its place in `SPRITE_LAYER_ORDER`, counted back from -1 for flights, so
 * flights draw over every other sprite layer and the rest follow the list,
 * whichever layer was turned on first. Every set at the default order, 0
 * (selection highlights, route endpoints, the tracked plane and the other
 * overlays), stays over all of them, as it did when the sprite sets were
 * raised to the bottom of the scene. A key not in the list gets 0.
 * @param {string} layerId - Stable sprite-order layer key.
 * @returns {number}
 */
export function spriteDrawOrder(layerId) {
  const index = SPRITE_LAYER_ORDER.indexOf(layerId);
  return index < 0 ? 0 : index - SPRITE_LAYER_ORDER.length;
}
