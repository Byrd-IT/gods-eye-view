import { BYRDIT_OPEN_STACK_ID } from './stack.js';
import { cameraHeight } from './autoSwitch.js';
import { naipCreditText, normalizeNaip } from './naipConfig.js';

export { naipCreditText, normalizeNaip };

/**
 * NAIP year time slider for the Byrd-IT Open stack (BASEMAP N6).
 *
 * Layers: one Cesium imagery layer per statewide NAIP year (USDA NAIP via
 * TxGIO, rectangle = that year's bounds = Texas) drawn directly above the
 * stack's Sentinel-2 base layer and below every other overlay, plus the
 * regional high-resolution / historic layers (Wood + Upshur) of the same
 * year above it. Years, zooms, bounds and regions all come from the `naip`
 * block of /basemap/config.json (naipProxy.js), never from this file.
 *
 * Year rules (owner addendum 2026-10-12):
 *   - ticks = union of statewide and regional years, oldest left.
 *   - default = config default_year when it is a tick, else the newest.
 *   - a year with statewide NAIP shows that NAIP year; regional layers of
 *     that year draw above it, clipped to their own bounds (their tiles
 *     carry alpha outside the county polygon; a 204 is transparent).
 *   - a year that exists only regionally shows the NEAREST statewide year
 *     outside the counties (tie: the newer one), labelled "(nearest)".
 *
 * Visibility follows the buildings layer (buildings.js): only while the
 * controller shows Byrd-IT Open and the Google 3D tileset is not drawn (the
 * P3 auto-switch hand-over). Any other stack DESTROYS the layers; P3 switching
 * rules are untouched (this module only listens).
 *
 * Credits: "USDA NAIP <year> via TxGIO" (and each regional layer's own short
 * text) are static credits only while that layer is shown AND the camera
 * view touches its bounds at a zoom where it draws.
 *
 * Compare: optional A/B split (Cesium splitDirection + the shared
 * src/ui/imagerySplit.js divider): year A on the left, year B on the right.
 */

const TILE_SIZE = 256;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/** Slider ticks: every year present (statewide or regional), ascending. */
export function sliderYears(naip) {
  const all = new Set();
  for (const y of naip?.years ?? []) all.add(y.year);
  for (const r of naip?.regional ?? []) all.add(r.year);
  return [...all].sort((a, b) => a - b);
}

/** The starting year: config default_year when it is a tick, else newest. */
export function defaultSliderYear(naip) {
  const ticks = sliderYears(naip);
  if (!ticks.length) return null;
  return ticks.includes(naip.defaultYear) ? naip.defaultYear : ticks.at(-1);
}

/** The statewide entry nearest to `year` (tie: the newer one). */
export function nearestStatewide(naip, year) {
  let best = null;
  for (const entry of naip?.years ?? []) {
    const d = Math.abs(entry.year - year);
    const bd = best ? Math.abs(best.year - year) : Infinity;
    if (d < bd || (d === bd && entry.year > best.year)) best = entry;
  }
  return best;
}

/**
 * What to draw for one slider year, bottom to top.
 * @returns {{year: number, statewide: object|null, nearest: boolean, regional: object[], layers: object[], label: string}}
 */
export function planYear(naip, year) {
  const statewide = nearestStatewide(naip, year);
  const nearest = Boolean(statewide) && statewide.year !== year;
  const regional = (naip?.regional ?? []).filter((r) => r.year === year);
  const layers = [...(statewide ? [statewide] : []), ...regional];
  const parts = [];
  if (statewide && !nearest) parts.push(`NAIP ${statewide.year}`);
  for (const r of regional) parts.push(r.name);
  if (nearest)
    parts.push(
      regional.length
        ? `elsewhere NAIP ${statewide.year} (nearest)`
        : `NAIP ${statewide.year} (nearest)`,
    );
  return {
    year,
    statewide,
    nearest,
    regional,
    layers,
    label: `${year}: ${parts.join(' · ') || 'no imagery'}`,
  };
}

/** Next tick in a direction (keyboard arrows); stays put at the ends. */
export function stepYear(ticks, year, delta) {
  const i = ticks.indexOf(year);
  if (i < 0) return ticks.at(-1) ?? null;
  return ticks[Math.max(0, Math.min(ticks.length - 1, i + delta))];
}

/**
 * Approximate web-map zoom the globe draws at for a camera height (used for
 * credits only): the zoom whose 256 px tile spans about the camera height.
 */
export function zoomForHeight(heightM, latDeg = 0) {
  if (!Number.isFinite(heightM) || heightM <= 0) return Infinity;
  const metresAround =
    EARTH_CIRCUMFERENCE_M * Math.max(0.01, Math.cos((latDeg * Math.PI) / 180));
  return Math.log2(metresAround / heightM);
}

function touches([w1, s1, e1, n1], [w2, s2, e2, n2]) {
  return w1 < e2 && w2 < e1 && s1 < n2 && s2 < n1;
}

/**
 * Is this layer's imagery actually on screen? View bounds unknown (camera
 * looking past the horizon) count as "maybe", decided by zoom alone.
 */
export function layerOnScreen(entry, { viewBounds, zoom }) {
  if (!(zoom >= entry.minzoom - 1)) return false;
  if (!viewBounds) return true;
  return touches(entry.bounds, viewBounds);
}

/** A transparent tile for missing/unwanted tiles (browser; injectable). */
function transparentTile() {
  const doc = globalThis.document;
  if (!doc?.createElement) return undefined;
  const canvas = doc.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  return canvas;
}

/**
 * One NAIP/regional imagery provider. Below the layer's minzoom no request
 * is made (a transparent tile instead: Cesium would otherwise clamp to the
 * minimum level and fetch thousands of z12 tiles at a state-wide view);
 * above maxzoom Cesium enlarges the deepest level. A 204 (outside the
 * footprint) or a failed tile is transparent, so the Sentinel-2 base shows.
 */
export function createNaipImageryProvider(
  Cesium,
  entry,
  { blank = transparentTile } = {},
) {
  let empty = null;
  const none = () => (empty ??= blank());
  class NaipImageryProvider extends Cesium.UrlTemplateImageryProvider {
    requestImage(x, y, level, request) {
      if (level < entry.minzoom) return Promise.resolve(none());
      const pending = super.requestImage(x, y, level, request);
      if (!pending) return pending; // Cesium's throttle: "not now"
      return Promise.resolve(pending).then(
        (image) => image ?? none(),
        () => none(),
      );
    }
  }
  const [w, s, e, n] = entry.bounds;
  return new NaipImageryProvider({
    url: entry.url,
    rectangle: Cesium.Rectangle.fromDegrees(w, s, e, n),
    minimumLevel: 0,
    maximumLevel: entry.maxzoom,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    hasAlphaChannel: true,
  });
}

/** Camera view bounds in degrees [w, s, e, n], or null (horizon in view). */
export function viewBoundsOf(viewer, Cesium) {
  try {
    const r = viewer?.camera?.computeViewRectangle?.(
      viewer.scene?.globe?.ellipsoid,
    );
    if (!r) return null;
    const deg = Cesium?.Math?.toDegrees ?? ((v) => (v * 180) / Math.PI);
    const b = [deg(r.west), deg(r.south), deg(r.east), deg(r.north)];
    // A view across the antimeridian: no Texas layer can be in it anyway
    // unless it is huge, so treat it as unknown (zoom decides).
    return b[0] < b[2] ? b : null;
  } catch {
    return null;
  }
}

/**
 * Drive the NAIP layers + slider for one viewer and map controller.
 * @param {{
 *   Cesium: object, viewer: object, controller: object,
 *   naip: ReturnType<typeof normalizeNaip>,
 *   session?: {tileset: object|null},
 *   heightOf?: () => number, viewOf?: () => ({viewBounds: number[]|null, lat: number}),
 *   createProvider?: Function, createSlider?: Function|null, createSplit?: Function|null,
 *   timers?: object, pollMs?: number,
 * }} options
 */
export function attachNaip({
  Cesium,
  viewer,
  controller,
  naip,
  session = null,
  heightOf = () => cameraHeight(viewer),
  viewOf = () => ({
    viewBounds: viewBoundsOf(viewer, Cesium),
    lat: Cesium?.Math?.toDegrees
      ? Cesium.Math.toDegrees(
          viewer?.camera?.positionCartographic?.latitude ?? 0,
        )
      : 0,
  }),
  createProvider = (entry) => createNaipImageryProvider(Cesium, entry),
  createSlider = null,
  createSplit = null,
  timers = globalThis,
  pollMs = 1_000,
}) {
  const scene = viewer.scene;
  const collection = viewer.imageryLayers;
  const ticks = sliderYears(naip);
  const state = {
    year: defaultSliderYear(naip),
    yearB: null,
    enabled: true,
    compare: false,
  };
  /** key -> {entry, side, layer} for every layer this module added. */
  const layers = new Map();
  /** credit text -> Cesium.Credit currently on screen. */
  const credits = new Map();
  const creditObjects = new Map();
  let created = 0;
  let destroyed = 0;
  let detached = false;
  let googleWasShown = false;
  let pollTimer = null;
  let split = null;
  const removers = [];

  const googleShown = () => session?.tileset?.show === true;
  const openShown = () => controller.getActiveId() === BYRDIT_OPEN_STACK_ID;

  function baseIndex() {
    const base = controller._imageryLayer;
    const i = base ? collection.indexOf(base) : -1;
    return i < 0 ? -1 : i;
  }

  /** The ordered layers wanted now: [{key, entry, side}], bottom to top. */
  function wanted() {
    if (state.year === null) return [];
    const sides =
      state.compare && state.yearB !== null
        ? [
            ['left', state.year],
            ['right', state.yearB],
          ]
        : [['both', state.year]];
    const out = [];
    for (const [side, year] of sides)
      for (const entry of planYear(naip, year).layers)
        out.push({ key: `${side}:${entry.key}`, entry, side });
    return out;
  }

  function splitDirection(side) {
    const dirs = Cesium.SplitDirection;
    if (!dirs) return undefined;
    return side === 'left'
      ? dirs.LEFT
      : side === 'right'
        ? dirs.RIGHT
        : dirs.NONE;
  }

  function removeLayer(key) {
    const held = layers.get(key);
    if (!held) return;
    layers.delete(key);
    destroyed += 1;
    if (!held.layer.isDestroyed?.()) collection.remove(held.layer, true);
  }

  function removeAll() {
    for (const key of [...layers.keys()]) removeLayer(key);
  }

  /** Make the collection hold exactly wanted(), in order, above the base. */
  function syncLayers(show) {
    const want = wanted();
    const keys = new Set(want.map((w) => w.key));
    for (const key of [...layers.keys()]) if (!keys.has(key)) removeLayer(key);
    want.forEach(({ key, entry, side }, i) => {
      const at = baseIndex() + 1 + i;
      let held = layers.get(key);
      if (!held) {
        const layer = new Cesium.ImageryLayer(createProvider(entry), {
          show,
        });
        layers.set(key, (held = { entry, side, layer }));
        created += 1;
        collection.add(layer, Math.min(at, collection.length));
      } else if (collection.indexOf(held.layer) !== at) {
        collection.remove(held.layer, false);
        collection.add(held.layer, Math.min(at, collection.length));
      }
      const dir = splitDirection(side);
      if (dir !== undefined && held.layer.splitDirection !== dir)
        held.layer.splitDirection = dir;
      if (held.layer.show !== show) held.layer.show = show;
    });
  }

  function setCredits(texts) {
    const display = scene?.frameState?.creditDisplay;
    if (!display) return;
    for (const [t, credit] of [...credits]) {
      if (texts.has(t)) continue;
      try {
        display.removeStaticCredit(credit);
        credits.delete(t);
      } catch {
        /* retried on the next change */
      }
    }
    for (const t of texts) {
      if (credits.has(t)) continue;
      try {
        let credit = creditObjects.get(t);
        if (!credit)
          creditObjects.set(t, (credit = new Cesium.Credit(t, true)));
        display.addStaticCredit(credit);
        credits.set(t, credit);
      } catch {
        /* retried on the next change */
      }
    }
  }

  let splitKey = null;
  function syncSplit(show) {
    const want = show && state.compare && state.yearB !== null;
    const key = want ? `${state.year}|${state.yearB}` : null;
    if (key === splitKey) return;
    // New years = new labels: rebuild the divider where the user left it.
    const at = split?.getValue?.() ?? 0.5;
    split?.destroy?.();
    split = null;
    splitKey = null;
    if (!want || !createSplit) return;
    split = createSplit({
      scene,
      parent: viewer.container,
      initialValue: at,
      beforeLabel: String(state.year),
      afterLabel: String(state.yearB),
      ariaLabel: 'Compare aerial imagery years',
      requestRender: () => scene?.requestRender?.(),
    });
    splitKey = key;
  }

  let slider = null;
  function uiState() {
    return {
      ticks,
      year: state.year,
      yearB: state.yearB,
      enabled: state.enabled,
      compare: state.compare,
      label: state.year === null ? '' : planYear(naip, state.year).label,
      labelB:
        state.compare && state.yearB !== null
          ? planYear(naip, state.yearB).label
          : '',
    };
  }

  function evaluate() {
    if (detached) return;
    if (!openShown()) {
      removeAll();
      setCredits(new Set());
      syncSplit(false);
      slider?.setVisible?.(false);
      scene?.requestRender?.();
      return;
    }
    const show = state.enabled && !googleShown();
    syncLayers(show);
    syncSplit(show);
    const texts = new Set();
    if (show) {
      const { viewBounds, lat } = viewOf();
      const zoom = zoomForHeight(heightOf(), lat);
      for (const { entry } of layers.values())
        if (layerOnScreen(entry, { viewBounds, zoom })) texts.add(entry.credit);
    }
    setCredits(texts);
    slider?.setVisible?.(true);
    slider?.update?.(uiState());
    scene?.requestRender?.();
  }

  const api = {
    setYear(year) {
      if (!ticks.includes(year) || year === state.year) return false;
      state.year = year;
      evaluate();
      return true;
    },
    step(delta) {
      return api.setYear(stepYear(ticks, state.year, delta));
    },
    setEnabled(on) {
      state.enabled = Boolean(on);
      evaluate();
    },
    setCompare(on, yearB = state.yearB) {
      state.compare = Boolean(on);
      if (state.compare)
        state.yearB = ticks.includes(yearB)
          ? yearB
          : (stepYear(ticks, state.year, -1) ?? state.year);
      evaluate();
    },
    setYearB(year) {
      if (!ticks.includes(year)) return false;
      state.yearB = year;
      evaluate();
      return true;
    },
  };

  if (createSlider)
    slider = createSlider({
      container: viewer.container,
      state: uiState(),
      onYear: (y) => api.setYear(y),
      onYearB: (y) => api.setYearB(y),
      onEnabled: (on) => api.setEnabled(on),
      onCompare: (on) => api.setCompare(on),
    });

  removers.push(controller.subscribe?.(() => evaluate()));
  const camera = viewer?.camera;
  if (camera?.moveEnd?.addEventListener) {
    removers.push(
      camera.moveStart.addEventListener(() => {
        if (pollTimer === null)
          pollTimer = timers.setInterval(evaluate, pollMs);
      }),
      camera.moveEnd.addEventListener(() => {
        timers.clearInterval(pollTimer);
        pollTimer = null;
        evaluate();
      }),
    );
  }
  if (scene?.preUpdate?.addEventListener) {
    removers.push(
      scene.preUpdate.addEventListener(() => {
        const shown = googleShown();
        if (shown === googleWasShown) return;
        googleWasShown = shown;
        evaluate();
      }),
    );
  }
  evaluate();

  const detach = () => {
    if (detached) return;
    detached = true;
    removeAll();
    setCredits(new Set());
    split?.destroy?.();
    split = null;
    splitKey = null;
    slider?.destroy?.();
    slider = null;
    timers.clearInterval(pollTimer);
    pollTimer = null;
    for (const remove of removers) remove?.();
  };
  Object.assign(detach, api, {
    evaluate,
    state: () => ({
      ...uiState(),
      layers: [...layers.values()].map(({ entry, side, layer }) => ({
        key: entry.key,
        side,
        show: layer.show,
      })),
      credits: [...credits.keys()],
      created,
      destroyed,
      split: Boolean(split),
    }),
  });
  return detach;
}
