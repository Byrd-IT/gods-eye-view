/**
 * Grey drawing of a stopped live feed (gev-history DESIGN 2.4b, owner N5;
 * card B12f). While a bridged feed is GREY (liveFeedDraw.js: state grey, or
 * paused while still drawn) its layer keeps the last good data on the map,
 * desaturated and faded (the flights 'feed-dropped, coasting' cue is a 45 %
 * alpha; the same fade is used here), and goes back to its own colours the
 * moment the feed is live again.
 *
 * Fork code only (DESIGN 4.1): the layer's Cesium objects are found through
 * public handles, never by editing the layer:
 *   - its sprite collection (src/data/spriteOrder.js registry, read through
 *     the one-line accessor spriteCollectionOf: flights, military, vessels
 *     'ais', FIRMS, bike share, transit + transit-motion)
 *   - its named CustomDataSource (viewer.dataSources.getByName: FIRMS
 *     'local-firms', 'fire-perimeters', 'rocket-launches',
 *     'weather-cyclones')
 *
 * Collections: the collection's own update(frameState) is wrapped on the
 * INSTANCE, so the grey is applied after every layer change of that frame,
 * right before Cesium builds the draw commands. Entities: their colour /
 * material properties are swapped for grey constants (checked each frame
 * for new entities, fully every REPASS_FRAMES frames).
 *
 * Every value written is remembered with the layer's own value; going back
 * to live restores the layer's value ONLY where the grey value is still in
 * place (a value the layer set meanwhile is kept). Nothing here reads a
 * clock: what is grey comes from modeOf(layerId) (server clock, B11).
 *
 * 3D models: a top-level collection of Models whose ids are the ids of the
 * layer's sprites (the flights / military close-range model handoff) is
 * the same layer's; models get the grey mixed in (ColorBlendMode.MIX).
 *
 * Satellites (owner decision on the card): its PointPrimitiveCollection
 * carries gevLayerId 'satellites' (ONE upstream line in
 * src/layers/satellites/lifecycle.js, a listed touch point); it is found
 * among the top-level scene primitives by that tag. An empty answer cannot
 * clear satellites (its outage guard keeps the old catalog), so its target
 * is hideWhenCleared: while cleared the wrapped update draws nothing (as if
 * show were false; the layer's own show and points are left alone), and the
 * points come back on the first live frame.
 *
 * NOT reached (owner-accepted, documented in the KB and QA notes): the
 * tracked aircraft entity, launch trajectory polylines, the satellite orbit
 * paths and labels / ISS card, the 2-D world-overlay cards of any layer;
 * coloured sprite IMAGES (e.g. the FIRMS glow) are only faded + tinted, a
 * multiply tint cannot desaturate a texture.
 */
import * as Cesium from 'cesium';
import { spriteCollectionOf } from '../../data/spriteOrder.js';
import { MODE_CLEARED, MODE_LIVE } from './liveFeedDraw.js';

/** The property the one-line upstream touch point sets on a collection. */
export const LAYER_TAG = 'gevLayerId';

/** Alpha kept on grey items: the flights stale fade (policy.js, 45 %). */
export const GREY_ALPHA = 0.45;
/** Grey level = GREY_BASE + GREY_SPAN x luminance (dark stays darker). */
export const GREY_BASE = 0.35;
export const GREY_SPAN = 0.4;
/** How much of a 3D model's colour becomes the grey (ColorBlendMode.MIX). */
export const MODEL_BLEND = 0.85;
/** Entities (and model collections) are fully re-checked this often. */
export const REPASS_FRAMES = 30;

/** layer id -> the public handles of what it draws. */
export const GREY_TARGETS = Object.freeze({
  flights: Object.freeze({ sprites: ['flights'], dataSources: [] }),
  military: Object.freeze({ sprites: ['military'], dataSources: [] }),
  'ais-live-vessels': Object.freeze({ sprites: ['ais'], dataSources: [] }),
  'local-firms': Object.freeze({
    sprites: ['firms'],
    dataSources: ['local-firms'],
  }),
  'fire-perimeters': Object.freeze({
    sprites: [],
    dataSources: ['fire-perimeters'],
  }),
  'weather-cyclones': Object.freeze({
    sprites: [],
    dataSources: ['weather-cyclones'],
  }),
  'rocket-launches': Object.freeze({
    sprites: [],
    dataSources: ['rocket-launches'],
  }),
  transit: Object.freeze({
    sprites: ['transit', 'transit-motion'],
    dataSources: [],
  }),
  bikeshare: Object.freeze({ sprites: ['bikeshare'], dataSources: [] }),
  satellites: Object.freeze({
    sprites: [],
    dataSources: [],
    tagged: ['satellites'],
    hideWhenCleared: true,
  }),
});

/** The grey of a colour (a new Cesium.Color; alpha x GREY_ALPHA). */
export function greyColor(color) {
  const c = color ?? Cesium.Color.WHITE;
  const lum = 0.299 * c.red + 0.587 * c.green + 0.114 * c.blue;
  const v = GREY_BASE + GREY_SPAN * lum;
  return new Cesium.Color(v, v, v, c.alpha * GREY_ALPHA);
}

const POINT_FIELDS = ['color', 'outlineColor'];
const SPRITE_FIELDS = ['color'];
/** [graphics, field] colour properties of an entity. */
const ENTITY_COLORS = [
  ['billboard', 'color'],
  ['point', 'color'],
  ['point', 'outlineColor'],
  ['label', 'fillColor'],
  ['polygon', 'outlineColor'],
  ['ellipse', 'outlineColor'],
  ['rectangle', 'outlineColor'],
];
/** [graphics, field] material properties of an entity. */
const ENTITY_MATERIALS = [
  ['polygon', 'material'],
  ['polyline', 'material'],
  ['ellipse', 'material'],
  ['rectangle', 'material'],
  ['corridor', 'material'],
  ['wall', 'material'],
  ['cylinder', 'material'],
  ['box', 'material'],
  ['ellipsoid', 'material'],
  ['polylineVolume', 'material'],
];

/**
 * @param {object} options
 *   viewer   the Cesium viewer (scene.preRender, dataSources, clock)
 *   modeOf   (layerId) => 'live' | 'grey' | 'cleared' (liveFeedDraw)
 *   collectionOf  (spriteId) => collection (default spriteCollectionOf)
 *   targets  GREY_TARGETS
 */
export function createGreyPainter({
  viewer,
  modeOf = () => 'live',
  collectionOf = spriteCollectionOf,
  targets = GREY_TARGETS,
} = {}) {
  const itemRecs = new WeakMap(); // primitive item -> Map field -> rec
  const entityRecs = new WeakMap(); // graphics -> Map field -> rec
  const wrapped = new WeakMap(); // collection -> {layerId, painted}
  const dsState = new WeakMap(); // data source -> {painted, size}
  const stats = { painted: 0, restored: 0 };
  let frame = 0;
  let off = null;
  let destroyed = false;

  // grey while grey, and while cleared until the emptied answer has removed
  // the items (no flash of live colour in between)
  const isGrey = (layerId) => {
    if (destroyed) return false;
    try {
      return (modeOf(layerId) ?? MODE_LIVE) !== MODE_LIVE;
    } catch {
      return false;
    }
  };
  // draws nothing at all: cleared, for a layer an empty answer cannot clear
  const isHidden = (layerId) => {
    if (destroyed || !targets[layerId]?.hideWhenCleared) return false;
    try {
      return modeOf(layerId) === MODE_CLEARED;
    } catch {
      return false;
    }
  };
  const hidden = { count: 0 };

  // ── primitives ──────────────────────────────────────────

  function fieldsOf(collection) {
    return collection instanceof Cesium.PointPrimitiveCollection
      ? POINT_FIELDS
      : SPRITE_FIELDS;
  }

  function paintItem(item, field, grey) {
    const cur = item?.[field];
    if (!cur) return;
    let recs = itemRecs.get(item);
    const rec = recs?.get(field);
    if (grey) {
      if (rec && Cesium.Color.equals(cur, rec.written)) return;
      // first time, or the layer set its own colour since: remember it
      const orig = Cesium.Color.clone(cur);
      const written = greyColor(orig);
      if (!recs) itemRecs.set(item, (recs = new Map()));
      recs.set(field, { orig, written });
      item[field] = written;
      stats.painted++;
    } else if (rec) {
      if (Cesium.Color.equals(cur, rec.written)) {
        item[field] = rec.orig;
        stats.restored++;
      }
      recs.delete(field);
    }
  }

  /** A 3D model: grey colour mixed over its texture, then restored. */
  function paintModel(model, grey) {
    const rec = itemRecs.get(model)?.get('model');
    if (grey) {
      if (rec && model.color && Cesium.Color.equals(model.color, rec.written))
        return;
      const orig = {
        color: model.color ? Cesium.Color.clone(model.color) : undefined,
        mode: model.colorBlendMode,
        amount: model.colorBlendAmount,
      };
      const written = greyColor(orig.color ?? Cesium.Color.WHITE);
      if (!itemRecs.has(model)) itemRecs.set(model, new Map());
      itemRecs.get(model).set('model', { orig, written });
      model.color = written;
      model.colorBlendMode = Cesium.ColorBlendMode.MIX;
      model.colorBlendAmount = MODEL_BLEND;
      stats.painted++;
    } else if (rec) {
      if (model.color && Cesium.Color.equals(model.color, rec.written)) {
        model.color = rec.orig.color;
        model.colorBlendMode = rec.orig.mode;
        model.colorBlendAmount = rec.orig.amount;
        stats.restored++;
      }
      itemRecs.get(model).delete('model');
    }
  }

  /** Grey (or restore) every item of one collection. */
  function paintCollection(collection, grey) {
    const fields = fieldsOf(collection);
    const n = Number(collection?.length) || 0;
    for (let i = 0; i < n; i++) {
      const item = collection.get(i);
      if (item instanceof Cesium.Model) paintModel(item, grey);
      else for (const f of fields) paintItem(item, f, grey);
    }
  }

  /**
   * The layer's own 3D models: a top-level PrimitiveCollection of Models
   * whose ids are ids of the layer's sprites (flights / military hand a
   * close aircraft from its billboard to a model with the same id).
   */
  function modelSiblings(sprites) {
    const ids = new Set();
    const n = Number(sprites?.length) || 0;
    for (let i = 0; i < n; i++) {
      const id = sprites.get(i)?.id;
      if (typeof id === 'string') ids.add(id);
    }
    const out = [];
    const prims = viewer?.scene?.primitives;
    const m = Number(prims?.length) || 0;
    if (!ids.size) return out;
    for (let i = 0; i < m; i++) {
      const p = prims.get(i);
      if (!(p instanceof Cesium.PrimitiveCollection) || !p.length) continue;
      const first = p.get(0);
      if (first instanceof Cesium.Model && ids.has(first.id)) out.push(p);
    }
    return out;
  }

  /** Wrap a collection's update once: grey right before it draws. */
  function adopt(collection, layerId) {
    if (!collection || wrapped.has(collection)) return;
    if (typeof collection.update !== 'function') return;
    const st = { layerId, painted: false };
    wrapped.set(collection, st);
    const original = collection.update;
    collection.update = function greyPainterUpdate(...args) {
      try {
        // no draw (or pick) commands this frame: the same as show=false
        if (isHidden(st.layerId)) {
          hidden.count++;
          return undefined;
        }
        if (isGrey(st.layerId)) {
          paintCollection(this, true);
          st.painted = true;
        } else if (st.painted) {
          paintCollection(this, false);
          st.painted = false;
        }
      } catch {
        /* drawing must never break */
      }
      return original.apply(this, args);
    };
  }

  // ── entities ────────────────────────────────────────────

  const now = () => viewer?.clock?.currentTime;

  function colorOfProperty(prop, isMaterial) {
    if (prop === undefined || prop === null) return null;
    try {
      const v =
        typeof prop.getValue === 'function' ? prop.getValue(now()) : prop;
      if (isMaterial) return v?.color instanceof Cesium.Color ? v.color : null;
      return v instanceof Cesium.Color ? v : null;
    } catch {
      return null;
    }
  }

  function paintEntityField(graphics, field, isMaterial, grey, fallback) {
    if (!graphics) return;
    let recs = entityRecs.get(graphics);
    const rec = recs?.get(field);
    const cur = graphics[field];
    if (grey) {
      if (rec && cur === rec.written) return;
      const color = colorOfProperty(cur, isMaterial) ?? fallback;
      if (!color) return;
      const g = greyColor(color);
      const written = isMaterial
        ? new Cesium.ColorMaterialProperty(g)
        : new Cesium.ConstantProperty(g);
      if (!recs) entityRecs.set(graphics, (recs = new Map()));
      recs.set(field, { orig: cur, written });
      graphics[field] = written;
      stats.painted++;
    } else if (rec) {
      if (cur === rec.written) {
        graphics[field] = rec.orig;
        stats.restored++;
      }
      recs.delete(field);
    }
  }

  function paintEntity(entity, grey) {
    for (const [g, f] of ENTITY_COLORS)
      paintEntityField(
        entity?.[g],
        f,
        false,
        grey,
        g === 'billboard' && f === 'color' ? Cesium.Color.WHITE : null,
      );
    for (const [g, f] of ENTITY_MATERIALS)
      paintEntityField(entity?.[g], f, true, grey, null);
  }

  function paintDataSource(ds, grey, full) {
    let st = dsState.get(ds);
    if (!st) dsState.set(ds, (st = { painted: false, size: -1 }));
    const list = ds?.entities?.values ?? [];
    if (grey) {
      if (st.painted && !full && st.size === list.length) return;
      for (const e of list) paintEntity(e, true);
      st.painted = true;
      st.size = list.length;
    } else if (st.painted) {
      for (const e of list) paintEntity(e, false);
      st.painted = false;
      st.size = -1;
    }
  }

  function dataSourcesNamed(name) {
    try {
      return viewer?.dataSources?.getByName?.(name) ?? [];
    } catch {
      return [];
    }
  }

  // ── tagged collections (satellites) ─────────────────────

  /** Top-level scene primitives carrying LAYER_TAG === tag. */
  function taggedCollections(tag) {
    const out = [];
    const prims = viewer?.scene?.primitives;
    const m = Number(prims?.length) || 0;
    for (let i = 0; i < m; i++) {
      const p = prims.get(i);
      if (p && p[LAYER_TAG] === tag && !p.isDestroyed?.()) out.push(p);
    }
    return out;
  }

  // ── the frame pass ──────────────────────────────────────

  /** Adopt the layers' collections and grey / restore their entities. */
  function pass() {
    frame++;
    const full = frame % REPASS_FRAMES === 0;
    for (const [layerId, t] of Object.entries(targets)) {
      // a re-init adds a new tagged collection: adopt is once per instance
      for (const tag of t.tagged ?? [])
        for (const c of taggedCollections(tag)) adopt(c, layerId);
      for (const id of t.sprites) {
        let c = null;
        try {
          c = collectionOf(id);
        } catch {
          c = null;
        }
        if (c && !c.isDestroyed?.()) {
          adopt(c, layerId);
          if (full || frame === 1)
            for (const models of modelSiblings(c)) adopt(models, layerId);
        }
      }
      const grey = isGrey(layerId);
      for (const name of t.dataSources)
        for (const ds of dataSourcesNamed(name))
          paintDataSource(ds, grey, full);
    }
  }

  function start() {
    if (off || !viewer?.scene?.preRender?.addEventListener) return;
    const handler = () => {
      try {
        pass();
      } catch {
        /* keep drawing */
      }
    };
    off = viewer.scene.preRender.addEventListener(handler);
  }

  /** A mode changed: draw a frame even in request-render mode. */
  function changed() {
    try {
      pass();
      viewer?.scene?.requestRender?.();
    } catch {
      /* the next frame paints */
    }
  }

  return {
    start,
    pass,
    changed,
    paintCollection,
    adopt,
    stats,
    hidden,
    destroy() {
      destroyed = true; // wrapped collections restore on their next frame
      try {
        off?.();
      } catch {
        /* the scene is gone */
      }
      off = null;
    },
  };
}
