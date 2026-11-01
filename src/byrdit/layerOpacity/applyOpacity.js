/**
 * Byrd-IT fork: write a layer opacity into whatever a layer put on the globe.
 *
 * Duck-typed (no Cesium import) so it runs under node:test with plain fakes.
 * The one rule: a layer's own colours are the BASE and are never lost. Each
 * item remembers {base, applied}; when the colour found on the item is still
 * the one we applied, the base is kept and re-scaled, and when it differs the
 * layer has written a new colour, which becomes the new base. At 100 % the
 * base is written back and the memo is dropped, so the default path leaves
 * the scene exactly as the layer made it.
 */

const GRAPHICS = [
  'billboard',
  'point',
  'label',
  'polyline',
  'polygon',
  'ellipse',
  'ellipsoid',
  'box',
  'cylinder',
  'corridor',
  'rectangle',
  'wall',
  'path',
  'model',
  'plane',
  'polylineVolume',
];
const COLOR_KEYS = ['color', 'outlineColor', 'fillColor', 'backgroundColor'];

const same = (a, b) =>
  !!a &&
  !!b &&
  a.red === b.red &&
  a.green === b.green &&
  a.blue === b.blue &&
  a.alpha === b.alpha;

const isColor = (c) =>
  !!c &&
  typeof c.red === 'number' &&
  typeof c.alpha === 'number' &&
  typeof c.clone === 'function';

/**
 * Re-scale one colour slot. `memo` is a Map owned by the caller.
 * @returns {boolean} whether a write happened.
 */
function scaleSlot(memo, key, current, opacity, write) {
  if (!isColor(current)) return false;
  const rec = memo.get(key);
  const mine = rec && same(current, rec.applied);
  const base = mine ? rec.base : current.clone();
  if (opacity >= 1) {
    if (!mine) return false;
    write(base.clone());
    memo.delete(key);
    return true;
  }
  const applied = base.clone();
  applied.alpha = base.alpha * opacity;
  if (mine && same(current, applied)) return false;
  write(applied);
  // Read back what the owner kept (setters may quantise) to compare next time.
  memo.set(key, { base, applied: applied.clone() });
  return true;
}

const memos = new WeakMap();
function memoFor(holder) {
  let memo = memos.get(holder);
  if (!memo) {
    memo = new Map();
    memos.set(holder, memo);
  }
  return memo;
}

function scaleItem(item, opacity) {
  if (!item) return;
  const memo = memoFor(item);
  for (const key of COLOR_KEYS) {
    if (isColor(item[key]))
      scaleSlot(memo, key, item[key], opacity, (v) => (item[key] = v));
  }
  // Polyline (PolylineCollection) carries its colour in material uniforms.
  const uniforms = item.material?.uniforms;
  if (uniforms) {
    for (const key of COLOR_KEYS) {
      if (isColor(uniforms[key]))
        scaleSlot(memo, `u:${key}`, uniforms[key], opacity, (v) => {
          uniforms[key] = v;
        });
    }
  }
}

function eachItem(collection, fn) {
  const n = collection.length;
  for (let i = 0; i < n; i++) fn(collection.get(i));
}

const COLLECTION_TYPES = new Set([
  'BillboardCollection',
  'PointPrimitiveCollection',
  'LabelCollection',
  'PolylineCollection',
]);

/**
 * Apply `opacity` to a scene container: an item collection, a
 * PrimitiveCollection (recursively), or a model.
 * @returns {number} items touched.
 */
export function applyToPrimitive(prim, opacity) {
  if (!prim || (typeof prim.isDestroyed === 'function' && prim.isDestroyed()))
    return 0;
  const type = prim.constructor?.name;
  if (COLLECTION_TYPES.has(type)) {
    let n = 0;
    eachItem(prim, (item) => {
      scaleItem(item, opacity);
      n++;
    });
    return n;
  }
  if (type === 'PrimitiveCollection') {
    let n = 0;
    eachItem(prim, (child) => {
      n += applyToPrimitive(child, opacity);
    });
    return n;
  }
  if (type === 'Primitive' || type === 'GroundPolylinePrimitive') {
    // A material appearance (glow/colour lines) keeps its colour in uniforms.
    const target = prim.appearance?.material;
    if (!target?.uniforms) return 0;
    const memo = memoFor(target);
    let n = 0;
    for (const key of COLOR_KEYS) {
      const c = target.uniforms[key];
      if (isColor(c))
        n += scaleSlot(memo, `u:${key}`, c, opacity, (v) => {
          target.uniforms[key] = v;
        })
          ? 1
          : 0;
    }
    return n;
  }
  if (type === 'Model') {
    const memo = memoFor(prim);
    scaleSlot(memo, 'color', prim.color, opacity, (v) => (prim.color = v));
    return 1;
  }
  return 0;
}

/** Constant-valued colour property of an entity graphic, or null. */
function constantColor(prop) {
  if (!prop || typeof prop.setValue !== 'function') return null;
  let v;
  try {
    v = prop.getValue();
  } catch {
    return null;
  }
  return isColor(v) ? v : null;
}

function scaleGraphic(graphic, opacity) {
  const memo = memoFor(graphic);
  let n = 0;
  for (const key of COLOR_KEYS) {
    const prop = graphic[key];
    const color = constantColor(prop);
    if (color && scaleSlot(memo, key, color, opacity, (v) => prop.setValue(v)))
      n++;
  }
  // `material` is a property whose `.color` is a constant colour property.
  const mat = graphic.material;
  const matColor = mat && !isColor(mat) ? mat.color : null;
  const color = constantColor(matColor);
  if (
    color &&
    scaleSlot(memo, 'm', color, opacity, (v) => matColor.setValue(v))
  )
    n++;
  return n;
}

/**
 * Apply `opacity` to the entities of a data source from index `from`, for at
 * most `budgetMs` (checked every 16 entities). Entity property writes are
 * costly (thousands of entities take seconds), so callers slice the work.
 * @returns {number} the index to resume from; equal to the entity count when
 *   the whole source is done.
 */
export function applyToDataSourceSlice(
  ds,
  opacity,
  from = 0,
  budgetMs = Infinity,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
) {
  const store = ds?.entities;
  const entities = store?.values;
  if (!entities) return 0;
  const start = now();
  let i = from;
  // One change notification for the slice, not one per entity.
  store.suspendEvents?.();
  try {
    for (; i < entities.length; i++) {
      const entity = entities[i];
      for (const name of GRAPHICS) {
        const graphic = entity[name];
        if (graphic) scaleGraphic(graphic, opacity);
      }
      if (i % 16 === 15 && now() - start >= budgetMs) {
        i++;
        break;
      }
    }
  } finally {
    store.resumeEvents?.();
  }
  return i;
}

/** Apply `opacity` to every entity of a data source. @returns entities seen. */
export function applyToDataSource(ds, opacity) {
  if (!ds?.entities?.values) return 0;
  applyToDataSourceSlice(ds, opacity);
  return ds.entities.values.length;
}

/**
 * Imagery layers have a native alpha. Same rule as colours: an alpha that is
 * not the one we applied was written by the layer and becomes the new base.
 */
const imagery = new WeakMap();
export function applyToImagery(layer, opacity) {
  if (!layer || typeof layer.alpha !== 'number') return 0;
  const rec = imagery.get(layer);
  const mine = rec && layer.alpha === rec.applied;
  const base = mine ? rec.base : layer.alpha;
  if (opacity >= 1) {
    if (!mine) return 0;
    layer.alpha = base;
    imagery.delete(layer);
    return 1;
  }
  const applied = base * opacity;
  if (mine && layer.alpha === applied) return 1;
  layer.alpha = applied;
  imagery.set(layer, { base, applied: layer.alpha });
  return 1;
}

/**
 * Apply `opacity` to everything a layer owns.
 * @param {{prims?: Iterable, sources?: Iterable, imagery?: Iterable}} owned
 */
export function applyToOwned(owned, opacity, { skipSources = false } = {}) {
  let n = 0;
  for (const p of owned.prims ?? []) n += applyToPrimitive(p, opacity);
  if (!skipSources)
    for (const d of owned.sources ?? []) n += applyToDataSource(d, opacity);
  for (const i of owned.imagery ?? []) n += applyToImagery(i, opacity);
  return n;
}
