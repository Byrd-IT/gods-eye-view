/**
 * Byrd-IT fork: per-layer opacity, wired to the layer lifecycle.
 *
 * Ownership: a layer owns whatever appears in the scene (primitive
 * collections, ground primitives, data sources, imagery layers) during its
 * own init/enable/update. When calls of several layers overlap, an object that
 * appears is only known to belong to ONE of them, so it is credited to all of
 * them and written at the HIGHEST of their opacities: a layer left at 100 %
 * is never dimmed by another layer's slider. The cost of that rule is that an
 * ambiguous object may stay brighter than its real owner's slider says; it
 * never gets dimmer than any candidate owner asked.
 *
 * To keep the ambiguous case rare (dev server only: it needs unbundled
 * /src/ stack frames; a production bundle falls back to the rule above),
 * every add() on the scene collections is attributed at the moment it happens
 * from the call stack:
 *   - a stack with /src/ frames but none inside /src/layers/<name>/ was made
 *     by non-layer code (annotations, file import, drone plan preview, basemap,
 *     history outlines ...): it belongs to NO layer and is never touched;
 *   - a layers/<name> directory is tied to a layer the first time an add from
 *     it happens while exactly ONE layer call is in flight; later overlapped
 *     adds from that directory go to that layer alone, but only while every
 *     other layer in flight has also learned a directory of its own (else the
 *     add stays a candidate set, because the other layer might share it).
 *
 * A layer's `setOpacity(fraction)` hook runs IN ADDITION to the generic
 * writer (they cover different things: a hook its own shaders and uniforms,
 * the writer colours, entities and imagery). A hook must therefore not scale
 * anything the generic writer also scales, or the layer would be dimmed twice.
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

/** Marks an add made by code that is not a data layer. */
export const NON_LAYER = Symbol('non-layer');

/**
 * Where did this stack come from? `layers/flights` for the first frame inside
 * /src/layers/flights/, NON_LAYER when the stack has /src/ frames but none in
 * /src/layers/, null when it has no /src/ frames at all (production bundle).
 */
export function parseSourceKey(stack) {
  let sawSource = false;
  for (const line of String(stack ?? '').split('\n')) {
    if (line.includes('/layerOpacity/')) continue;
    const m = /\/src\/([^/:?\s]+)\/([^/:?\s]+)\//.exec(line);
    if (m || line.includes('/src/')) sawSource = true;
    if (m && m[1] === 'layers') return `layers/${m[2]}`;
  }
  return sawSource ? NON_LAYER : null;
}

const sourceKey = () => parseSourceKey(new Error().stack);

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

export function installLayerOpacity({
  viewer,
  dataManager,
  model,
  onApplied,
  sourceKeyOf = sourceKey,
  tickMs = TICK_MS,
}) {
  /** @type {Map<string, {prims:Set, sources:Set, imagery:Set}>} */
  const owned = new Map();
  /** item -> ids of every layer that may own it */
  const owners = new WeakMap();
  /** data sources whose entity collection changed since their last write */
  const stale = new WeakSet();
  const listeners = [];
  /** item -> ids it was attributed to when add() ran (exact or candidates) */
  const attributed = new WeakMap();
  /** source directory -> the one layer id that creates objects from it (null = shared) */
  const keyOwner = new Map();
  /** layer ids that own a learned directory */
  const learned = new Set();
  /** @type {Set<{ids:Set<string>}>} */
  const active = new Set();
  const dirty = new Set();
  const forced = new Set();
  /** Per layer: the running slice job (generation) and the entity counts last done. */
  const jobs = new Map();
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
      // An item with several candidate owners takes the highest of their values.
      const groups = new Map();
      const put = (kind, item) => {
        let v = value;
        for (const other of owners.get(item) ?? [])
          v = Math.max(v, model.get(other));
        let g = groups.get(v);
        if (!g)
          groups.set(
            v,
            (g = { prims: new Set(), sources: new Set(), imagery: new Set() }),
          );
        g[kind].add(item);
      };
      for (const item of o.prims) put('prims', item);
      for (const item of o.sources) put('sources', item);
      for (const item of o.imagery) put('imagery', item);
      for (const [v, g] of groups) applyToOwned(g, v, { skipSources: true });
      scheduleSources(id, groups, force);
    }
    onApplied?.(id, value);
    viewer.scene?.requestRender?.();
  }

  /**
   * Entity writes run in slices so a source of thousands of entities never
   * blocks a frame. A newer request for the same layer supersedes the old.
   * A source is re-scanned when forced or when its entity collection changed.
   */
  function scheduleSources(id, groups, force) {
    const work = [];
    for (const [v, g] of groups)
      for (const ds of g.sources)
        if (ds?.entities?.values && (force || stale.has(ds)))
          work.push([ds, v]);
    if (!work.length) return; // a tick with nothing new must not cancel a running pass
    const prior = jobs.get(id);
    if (prior) prior.cancelled = true;
    const job = { cancelled: false };
    jobs.set(id, job);
    let at = 0;
    let from = 0;
    const step = () => {
      if (job.cancelled || destroyed) return;
      const [ds, v] = work[at] ?? [];
      if (!ds || ds.isDestroyed?.()) {
        at++;
        from = 0;
      } else {
        from = applyToDataSourceSlice(ds, v, from, SLICE_MS);
        if (from >= ds.entities.values.length) {
          stale.delete(ds);
          at++;
          from = 0;
        }
      }
      if (at >= work.length) {
        if (jobs.get(id) === job) jobs.delete(id);
        viewer.scene?.requestRender?.();
        return;
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  function watchSource(ds) {
    const event = ds?.entities?.collectionChanged;
    if (!event?.addEventListener) return;
    const off = event.addEventListener(() => stale.add(ds));
    listeners.push(
      typeof off === 'function' ? off : () => event.removeEventListener?.(off),
    );
  }

  function attribute(item) {
    if (!item || typeof item !== 'object' || active.size === 0) return;
    const key = sourceKeyOf();
    if (key === NON_LAYER) {
      attributed.set(item, new Set()); // not made by a layer: owned by none
      return;
    }
    const live = [...active].map((c) => c.id);
    let ids;
    if (live.length === 1) {
      if (key) {
        const cur = keyOwner.get(key);
        if (cur === undefined) {
          keyOwner.set(key, live[0]);
          learned.add(live[0]);
        } else if (cur !== live[0]) keyOwner.set(key, null);
      }
      ids = new Set(live);
    } else {
      const known = key ? keyOwner.get(key) : undefined;
      if (known && live.includes(known)) {
        const unsure = live.filter((id) => id !== known && !learned.has(id));
        ids = new Set(unsure.length ? [known, ...unsure] : [known]);
      } else ids = new Set(live);
    }
    attributed.set(item, ids);
  }

  function hookAdd(collection) {
    const original = collection?.add;
    if (typeof original !== 'function') return;
    const own = Object.prototype.hasOwnProperty.call(collection, 'add');
    const hooked = function (...args) {
      const result = original.apply(this, args);
      try {
        attribute(args[0]);
      } catch {
        // attribution is best effort; the call-end diff still covers the item
      }
      return result;
    };
    try {
      collection.add = hooked;
      restores.push(() => {
        if (collection.add !== hooked) return;
        if (own) collection.add = original;
        else delete collection.add;
      });
    } catch {
      // frozen collection: fall back to the call-end diff only
    }
  }

  function wrap(id, module, method) {
    const original = module[method];
    if (typeof original !== 'function') return;
    const wrapped = async function (...args) {
      const call = { id, ids: new Set([id]) };
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
          const added = [];
          for (const p of after.prims) if (!before.prims.has(p)) added.push(p);
          for (const x of after.sources)
            if (!before.sources.has(x)) {
              added.push(x);
              watchSource(x);
            }
          for (const i of after.imagery)
            if (!before.imagery.has(i)) added.push(i);
          const kindOf = new Map();
          for (const p of after.prims)
            if (!before.prims.has(p)) kindOf.set(p, 'prims');
          for (const x of after.sources)
            if (!before.sources.has(x)) kindOf.set(x, 'sources');
          for (const i of after.imagery)
            if (!before.imagery.has(i)) kindOf.set(i, 'imagery');
          const touched = new Set();
          for (const item of added) {
            const who = attributed.get(item) ?? call.ids;
            owners.set(item, new Set(who));
            for (const owner of who) {
              ownedOf(owner)[kindOf.get(item)].add(item);
              touched.add(owner);
            }
          }
          for (const owner of new Set([...call.ids, ...touched])) {
            // The call may have replaced or recoloured entities in place.
            if (model.get(owner) < 1) {
              dirty.add(owner);
              forced.add(owner);
            }
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

  hookAdd(viewer.scene?.primitives);
  hookAdd(viewer.scene?.groundPrimitives);
  hookAdd(viewer.dataSources);
  hookAdd(viewer.imageryLayers);

  for (const [id, entry] of dataManager.layers) {
    const module = entry.module;
    if (!module) continue;
    for (const method of ['init', 'enable', 'update']) wrap(id, module, method);
  }

  const unsubscribe = model.subscribe((id) => {
    dirty.add(id);
    forced.add(id);
    flush();
  });
  const timer = setInterval(() => {
    for (const [id] of owned) if (model.get(id) < 1) dirty.add(id);
    // Layers with a hook are re-applied too: their own redraws reset alpha.
    for (const [id, entry] of dataManager.layers)
      if (model.get(id) < 1 && typeof entry.module?.setOpacity === 'function')
        dirty.add(id);
    flush();
  }, tickMs);
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
      for (const off of listeners.splice(0)) off();
      unsubscribe();
      for (const restore of restores.splice(0)) restore();
    },
  };
}
