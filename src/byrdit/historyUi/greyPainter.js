/**
 * Grey drawing at the draw port (gev-history DESIGN 2.4b, owner N5; card
 * B12f, rebuilt on upstream's renderer seam #1760).
 *
 * Upstream's layers no longer keep Cesium collections the fork could reach:
 * every layer draws through the renderer's draw port (sets of icons, points,
 * lines, shapes and models; src/render/contract/draw.d.ts). The grey is
 * therefore applied where every drawn item passes: the draw port itself.
 * `greyDrawPort(draw)` wraps the renderer's port once, when the renderer is
 * made (one line in src/render/cesium/appRenderer.js, a listed fork touch
 * point). Each set whose id names a greyable layer (GREY_SET_LAYERS) keeps
 * the items the layer last gave it; while that layer is grey the renderer is
 * given grey copies, and going back to live gives it the layer's own items
 * again. The layer's items are never changed, so nothing has to be restored
 * by hand and a value the layer set meanwhile is what comes back.
 *
 * A layer an empty answer cannot clear (satellites, hideWhenCleared) is not
 * greyed when cleared but hidden: its sets get show=false until it is live,
 * and the layer's own show is kept and given back.
 *
 * Nothing here reads a clock or Cesium: what is grey comes from modeOf
 * (liveFeedDraw paintModeOf, server clock B11), set by the history shell.
 */

/** Alpha kept on a grey item (the flights 'feed-dropped, coasting' cue). */
export const GREY_ALPHA = 0.45;
/** Grey level = GREY_BASE + GREY_SPAN x the colour's luminance. */
export const GREY_BASE = 0.35;
export const GREY_SPAN = 0.4;
/** How much of a 3D model's shading the grey tint replaces (mix). */
export const MODEL_BLEND = 0.85;

export const MODE_LIVE = 'live';
export const MODE_CLEARED = 'cleared';

/**
 * Draw-set id prefix -> the layer id liveFeedDraw names, and whether a
 * cleared layer is hidden instead of greyed. The prefixes are the ids
 * upstream's layers give their sets (checked by greyPainter.test.mjs).
 */
export const GREY_SET_LAYERS = Object.freeze([
  Object.freeze({ prefix: 'flights-', layerId: 'flights' }),
  Object.freeze({ prefix: 'military-', layerId: 'military' }),
  Object.freeze({ prefix: 'ais-vessels:', layerId: 'ais-live-vessels' }),
  Object.freeze({ prefix: 'firms:', layerId: 'local-firms' }),
  Object.freeze({ prefix: 'fire-perimeters:', layerId: 'fire-perimeters' }),
  Object.freeze({ prefix: 'weather-cyclones:', layerId: 'weather-cyclones' }),
  Object.freeze({ prefix: 'rocket-launches:', layerId: 'rocket-launches' }),
  Object.freeze({ prefix: 'transit:', layerId: 'transit' }),
  Object.freeze({ prefix: 'bikeshare:', layerId: 'bikeshare' }),
  Object.freeze({
    prefix: 'satellites:',
    layerId: 'satellites',
    hideWhenCleared: true,
  }),
]);

/** The greyable layer a set id belongs to, or null. */
export function greyLayerOfSet(setId, layers = GREY_SET_LAYERS) {
  const id = String(setId ?? '');
  return layers.find((entry) => id.startsWith(entry.prefix)) ?? null;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const greyLevel = (r, g, b) =>
  clamp01(GREY_BASE + GREY_SPAN * (0.299 * r + 0.587 * g + 0.114 * b));

/** `[r, g, b, a]` 0..1 of a CSS colour string, or null when unread. */
function parseCss(text) {
  const s = String(text).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4)
      hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (v) =>
      v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v) / 255;
    const alpha =
      parts[3] === undefined
        ? 1
        : parts[3].endsWith('%')
          ? Number(parts[3].slice(0, -1)) / 100
          : Number(parts[3]);
    const out = [ch(parts[0]), ch(parts[1]), ch(parts[2]), alpha];
    return out.every(Number.isFinite) ? out.map(clamp01) : null;
  }
  if (s === 'white') return [1, 1, 1, 1];
  if (s === 'black') return [0, 0, 0, 1];
  if (s === 'transparent') return [0, 0, 0, 0];
  return null;
}

/**
 * The grey of a contract colour: the same kind back (a CSS string for a
 * string, linear `[r, g, b, a]` for an array), its alpha x GREY_ALPHA.
 * A colour it cannot read becomes the mid grey at GREY_ALPHA.
 * @param {string|readonly number[]|undefined} color
 */
export function greyColor(color) {
  if (Array.isArray(color)) {
    const [r = 1, g = 1, b = 1, a = 1] = color;
    const v = greyLevel(r, g, b);
    return [v, v, v, clamp01(a * GREY_ALPHA)];
  }
  const rgba = color === undefined ? [1, 1, 1, 1] : parseCss(color);
  const [r, g, b, a] = rgba ?? [0.5, 0.5, 0.5, 1];
  const v = Math.round(greyLevel(r, g, b) * 255);
  const alpha = Math.round(clamp01(a * GREY_ALPHA) * 1000) / 1000;
  return `rgba(${v}, ${v}, ${v}, ${alpha})`;
}

/** A fill (a colour, or an image fill) greyed: a colour only. */
function greyFill(fill) {
  if (fill == null) return fill;
  if (typeof fill === 'string' || Array.isArray(fill)) return greyColor(fill);
  if (typeof fill === 'object' && 'color' in fill)
    return { ...fill, color: greyColor(fill.color) };
  return fill;
}

/** A line style (`{kind, color, ...}`) greyed, its own fields kept. */
function greyStyle(style) {
  if (!style || typeof style !== 'object') return style;
  const out = { ...style };
  if ('color' in out) out.color = greyColor(out.color);
  if (out.outline && typeof out.outline === 'object')
    out.outline = { ...out.outline, color: greyColor(out.outline.color) };
  if ('from' in out && out.from !== undefined) out.from = greyColor(out.from);
  if ('to' in out && out.to !== undefined) out.to = greyColor(out.to);
  if ('behind' in out && out.behind !== undefined)
    out.behind = greyColor(out.behind);
  return out;
}

/**
 * A grey copy of one item of a set of `kind`. Icons keep their image and
 * get a grey tint and the fade (a multiply tint cannot desaturate a texture,
 * owner-accepted); models get a grey tint mixed over their shading.
 */
export function greyItem(kind, item) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  switch (kind) {
    case 'icons':
      out.color = greyColor(item.color);
      break;
    case 'points':
      out.color = greyColor(item.color);
      if (item.outlineColor !== undefined)
        out.outlineColor = greyColor(item.outlineColor);
      break;
    case 'lines':
      if (item.style) out.style = greyStyle(item.style);
      if (item.depthFail) out.depthFail = greyStyle(item.depthFail);
      if (Array.isArray(item.segmentColors))
        out.segmentColors = item.segmentColors.map(greyColor);
      break;
    case 'shapes':
      if (item.fill != null) out.fill = greyFill(item.fill);
      if (item.outline != null) out.outline = greyColor(item.outline);
      break;
    case 'models':
      out.tint = greyColor(item.tint);
      out.colorBlend = { mode: 'mix', amount: MODEL_BLEND };
      break;
    case 'quads':
      if (item.alpha !== undefined) out.alpha = item.alpha * GREY_ALPHA;
      if (item.outline)
        out.outline = { ...item.outline, color: greyColor(item.outline.color) };
      break;
    case 'meshes':
      out.color = greyColor(item.color);
      break;
    default:
      break;
  }
  return out;
}

/** Packed `r, g, b, a` 0..255 colours greyed (a new array). */
function greyPacked(colors) {
  const out = new Uint8Array(colors.length);
  for (let i = 0; i + 3 < colors.length; i += 4) {
    const v = Math.round(
      greyLevel(colors[i] / 255, colors[i + 1] / 255, colors[i + 2] / 255) *
        255,
    );
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = Math.round(colors[i + 3] * GREY_ALPHA);
  }
  return out;
}

const SET_KINDS = [
  'icons',
  'points',
  'lines',
  'shapes',
  'models',
  'quads',
  'meshes',
];

/**
 * Wrap a renderer's draw port so greyable layers' sets can be drawn grey.
 * Returns the wrapped port; its control is `greyControlOf(port)` (and the
 * page's one control, `greyDrawControl`, for the first port wrapped).
 * @param {object} draw The renderer's draw port.
 * @param {{layers?: typeof GREY_SET_LAYERS, report?: (e: unknown) => void}} [options]
 */
export function greyDrawPort(draw, { layers = GREY_SET_LAYERS, report } = {}) {
  if (!draw) return draw;
  if (wrappers.has(draw)) return wrappers.get(draw);
  if (controls.has(draw)) return draw; // already a wrapped port
  const tracked = new Set();
  let modeOf = () => MODE_LIVE;
  let enabled = false;
  const stats = { greyItems: 0, repaints: 0, hiddenSets: 0 };

  const modeFor = (layerId) => {
    if (!enabled) return MODE_LIVE;
    try {
      return modeOf(layerId) ?? MODE_LIVE;
    } catch (error) {
      report?.(error);
      return MODE_LIVE;
    }
  };

  function wrapSet(kind, set, entry) {
    const items = new Map();
    let columns = null;
    let ownShow = set.show;
    let state = { grey: false, hidden: false };

    const desired = () => {
      const mode = modeFor(entry.layerId);
      const hidden = Boolean(entry.hideWhenCleared) && mode === MODE_CLEARED;
      return { grey: !hidden && mode !== MODE_LIVE, hidden };
    };
    const drawn = (item) => {
      if (!state.grey) return item;
      stats.greyItems += 1;
      return greyItem(kind, item);
    };
    const drawnColumns = (cols) =>
      state.grey && cols?.colors
        ? { ...cols, colors: greyPacked(cols.colors), dirty: undefined }
        : cols;

    const record = {
      entry,
      /** Bring the drawn set in line with the layer's mode. */
      repaint() {
        const next = desired();
        if (next.hidden !== state.hidden) {
          state = { ...state, hidden: next.hidden };
          set.show = next.hidden ? false : ownShow;
          stats.hiddenSets += next.hidden ? 1 : 0;
        }
        if (next.grey === state.grey) return;
        state = { ...state, grey: next.grey };
        stats.repaints += 1;
        if (columns && set.setColumns) set.setColumns(drawnColumns(columns));
        if (items.size) set.set([...items.values()].map(drawn));
      },
    };

    const wrapped = {
      get id() {
        return set.id;
      },
      set(list) {
        items.clear();
        for (const item of list) items.set(item.id, item);
        record.repaint();
        set.set(state.grey ? list.map(drawn) : list);
      },
      upsert(list) {
        for (const item of list) items.set(item.id, item);
        record.repaint();
        set.upsert(state.grey ? list.map(drawn) : list);
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        set.remove(ids);
      },
      clear() {
        items.clear();
        columns = null;
        set.clear();
      },
      setOptions(options) {
        set.setOptions(options);
      },
      size: () => set.size(),
      get show() {
        return ownShow;
      },
      set show(value) {
        ownShow = value;
        if (!state.hidden) set.show = value;
      },
      on: (...args) => set.on(...args),
      dispose() {
        tracked.delete(record);
        items.clear();
        set.dispose();
      },
    };
    if (typeof set.setColumns === 'function')
      wrapped.setColumns = (cols) => {
        columns = cols;
        record.repaint();
        set.setColumns(drawnColumns(cols));
      };
    tracked.add(record);
    record.repaint();
    return wrapped;
  }

  const port = Object.create(draw);
  for (const kind of SET_KINDS) {
    if (typeof draw[kind] !== 'function') continue;
    port[kind] = (spec) => {
      const set = draw[kind](spec);
      const entry = greyLayerOfSet(spec?.id, layers);
      return entry ? wrapSet(kind, set, entry) : set;
    };
  }
  for (const name of ['clampState', 'on', 'atlas', 'field'])
    if (typeof draw[name] === 'function')
      port[name] = (...args) => draw[name](...args);

  const control = {
    /** Grey by `fn(layerId) -> 'live'|'grey'|'cleared'`, from now on. */
    setModeOf(fn) {
      modeOf = typeof fn === 'function' ? fn : () => MODE_LIVE;
      enabled = typeof fn === 'function';
      control.changed();
    },
    /** A mode changed: every tracked set follows its layer's mode. */
    changed() {
      for (const record of [...tracked]) {
        try {
          record.repaint();
        } catch (error) {
          report?.(error);
        }
      }
    },
    /** The greyable sets drawn now, by layer id. */
    setsByLayer() {
      const out = {};
      for (const record of tracked)
        out[record.entry.layerId] = (out[record.entry.layerId] ?? 0) + 1;
      return out;
    },
    stats,
  };
  controls.set(port, control);
  wrappers.set(draw, port);
  pageControl ??= control;
  return port;
}

/** Wrapped port -> its control; raw port -> its wrapper. */
const controls = new WeakMap();
const wrappers = new WeakMap();
let pageControl = null;

/** The control of a wrapped draw port, or null. */
export function greyControlOf(port) {
  return controls.get(port) ?? controls.get(wrappers.get(port)) ?? null;
}

/** The control of the page's (first wrapped) draw port, or null. */
export function greyDrawControl() {
  return pageControl;
}

/** Tests only: forget the page's control. */
export function _resetGreyDrawForTest() {
  pageControl = null;
}

/**
 * The history shell's painter (the B12f API it always had): grey follows
 * `modeOf(layerId)` while started. `viewer` (the scene host) is kept for
 * the shell's call shape; a repaint writes to the draw sets, and those
 * writes ask the renderer for a frame.
 * @param {{viewer?: object, modeOf: (layerId: string) => string,
 *   control?: ReturnType<typeof greyControlOf>,
 *   requestFrame?: () => void}} options
 */
export function createGreyPainter({ viewer, modeOf, control, requestFrame }) {
  const controlNow = () => control ?? greyDrawControl();
  // Writes to draw sets ask the renderer for a frame themselves; an extra
  // nudge (request-render mode before any write) is the caller's.
  const frame = () => {
    try {
      requestFrame?.();
    } catch {
      /* the next frame paints */
    }
  };
  let started = false;
  return {
    start() {
      started = true;
      controlNow()?.setModeOf(modeOf);
      frame();
    },
    changed() {
      if (!started) return;
      const c = controlNow();
      // a renderer made after start (a re-init) is told the mode once
      c?.setModeOf(modeOf);
      frame();
    },
    stats: () => ({ ...(controlNow()?.stats ?? {}) }),
    setsByLayer: () => controlNow()?.setsByLayer() ?? {},
    destroy() {
      if (started) controlNow()?.setModeOf(null);
      started = false;
      frame();
    },
  };
}
