/**
 * Byrd-IT fork: per-layer opacity, wired to the layer lifecycle.
 *
 * Ownership: a layer owns whatever appears in the scene (primitive
 * collections, ground primitives, data sources, imagery layers) during its
 * own init/enable/update. When calls of several layers overlap, the new
 * objects are credited to every layer in flight, and an object with several
 * owners takes the lowest of their opacities, so the slider of one layer can
 * never leave another layer MORE transparent than that layer's own slider.
 *
 * A layer that can do better supplies `setOpacity(fraction)` (used instead of
 * the generic writer for that layer).
 *
 * Nothing runs for a layer at 100 %: no writes, no timer work.
 */
import { applyToDataSourceSlice, applyToOwned } from './applyOpacity.js';

const TICK_MS = 1000;

/** Error class name only (never the message, URL or stack of a layer's error). */
const errorKind = (error) =>
  typeof error?.name === 'string' && /^\w{1,40}$/.test(error.name)
    ? error.name
    : 'Error';
/** Entity writes are slow: do at most this much per slice, then yield. */
const SLICE_MS = 12;

function listOf(collection) {
  const out = [];
  if (!collection) return out;
  const n = collection.length ?? 0;
  for (let i = 0; i < n; i++) out.push(collection.get(i));
  return out;
}

function snapshot(viewer) {
  const scene = viewer.scene;
  return {
    prims: new Set([
      ...listOf(scene.primitives),
      ...listOf(scene.groundPrimitives),
    ]),
    sources: new Set(listOf(viewer.dataSources)),
    imagery: new Set(listOf(viewer.imageryLayers)),
  };
}

export function installLayerOpacity({ viewer, dataManager, model, onApplied }) {
  /** @type {Map<string, {prims:Set, sources:Set, imagery:Set}>} */
  const owned = new Map();
  /** @type {Set<{ids:Set<string>}>} */
  const active = new Set();
  const dirty = new Set();
  const forced = new Set();
  /** Per layer: the running slice job (generation) and the entity counts last done. */
  const jobs = new Map();
  const doneCounts = new Map();
  const restores = [];
  let destroyed = false;

  const ownedOf = (id) => {
    let o = owned.get(id);
    if (!o)
      owned.set(
        id,
        (o = { prims: new Set(), sources: new Set(), imagery: new Set() }),
      );
    return o;
  };

  function apply(id, force = true) {
    const module = dataManager.layers.get(id)?.module;
    const value = model.get(id);
    if (typeof module?.setOpacity === 'function') {
      try {
        module.setOpacity(value);
      } catch (error) {
        // The error text may carry anything a layer put in it: log its class only.
        console.warn(`[Opacity] ${id} setOpacity failed (${errorKind(error)})`);
      }
    }
    // The generic writer runs too: a hook covers a layer's own shaders, the
    // writer its collections, data sources and imagery.
    const o = owned.get(id);
    if (o) {
      for (const set of [o.prims, o.sources, o.imagery])
        for (const item of set) if (item?.isDestroyed?.()) set.delete(item);
      applyToOwned(o, value, { skipSources: true });
      scheduleSources(id, o, value, force);
    }
    onApplied?.(id, value);
    viewer.scene?.requestRender?.();
  }

  /**
   * Entity writes run in slices so a source of thousands of entities never
   * blocks a frame. A newer request for the same layer supersedes the old.
   * Unchanged sources (same entity count, not forced) are not re-scanned.
   */
  function scheduleSources(id, o, value, force) {
    const sources = [...o.sources].filter(
      (ds) =>
        ds?.entities?.values &&
        (force || doneCounts.get(ds) !== ds.entities.values.length),
    );
    const prior = jobs.get(id);
    if (prior) prior.cancelled = true;
    if (!sources.length) return;
    const job = { cancelled: false };
    jobs.set(id, job);
    let at = 0;
    let from = 0;
    const step = () => {
      if (job.cancelled || destroyed) return;
      const ds = sources[at];
      if (!ds || ds.isDestroyed?.()) {
        at++;
        from = 0;
      } else {
        from = applyToDataSourceSlice(ds, value, from, SLICE_MS);
        if (from >= ds.entities.values.length) {
          doneCounts.set(ds, ds.entities.values.length);
          at++;
          from = 0;
        }
      }
      if (at >= sources.length) {
        if (jobs.get(id) === job) jobs.delete(id);
        viewer.scene?.requestRender?.();
        return;
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  function wrap(id, module, method) {
    const original = module[method];
    if (typeof original !== 'function') return;
    const wrapped = async function (...args) {
      const call = { ids: new Set([id]) };
      for (const other of active) {
        other.ids.add(id);
        for (const x of other.ids) call.ids.add(x);
      }
      const before = snapshot(viewer);
      active.add(call);
      try {
        return await original.apply(this, args);
      } finally {
        active.delete(call);
        if (!destroyed) {
          const after = snapshot(viewer);
          for (const owner of call.ids) {
            const o = ownedOf(owner);
            for (const p of after.prims)
              if (!before.prims.has(p)) o.prims.add(p);
            let addedSource = false;
            for (const s of after.sources)
              if (!before.sources.has(s)) {
                o.sources.add(s);
                addedSource = true;
              }
            for (const i of after.imagery)
              if (!before.imagery.has(i)) o.imagery.add(i);
            if (model.get(owner) < 1) dirty.add(owner);
            if (addedSource && model.get(owner) < 1) forced.add(owner);
          }
          flush();
        }
      }
    };
    try {
      module[method] = wrapped;
      restores.push(() => {
        if (module[method] === wrapped) module[method] = original;
      });
    } catch (error) {
      console.warn(
        `[Opacity] cannot wrap ${id}.${method} (${errorKind(error)})`,
      );
    }
  }

  function flush() {
    for (const id of [...dirty]) {
      const force = forced.has(id);
      dirty.delete(id);
      forced.delete(id);
      apply(id, force);
    }
  }

  for (const [id, entry] of dataManager.layers) {
    const module = entry.module;
    if (!module) continue;
    for (const method of ['init', 'enable', 'update']) wrap(id, module, method);
  }

  const unsubscribe = model.subscribe((id) => {
    dirty.add(id);
    forced.add(id);
    for (const ds of owned.get(id)?.sources ?? []) doneCounts.delete(ds);
    flush();
  });
  const timer = setInterval(() => {
    for (const [id] of owned) if (model.get(id) < 1) dirty.add(id);
    // Layers with a hook are re-applied too: their own redraws reset alpha.
    for (const [id, entry] of dataManager.layers)
      if (model.get(id) < 1 && typeof entry.module?.setOpacity === 'function')
        dirty.add(id);
    flush();
  }, TICK_MS);
  timer.unref?.();

  return {
    ownedCount: (id) => {
      const o = owned.get(id);
      return o ? o.prims.size + o.sources.size + o.imagery.size : 0;
    },
    reapply: (id) => {
      dirty.add(id);
      forced.add(id);
      flush();
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      for (const job of jobs.values()) job.cancelled = true;
      unsubscribe();
      for (const restore of restores.splice(0)) restore();
    },
  };
}
