import { isPointerFree } from '../../data/inputOwnership.js';
import { BYRDIT_OPEN_STACK_ID } from './stack.js';
import { cameraHeight } from './autoSwitch.js';
import { BUILDINGS_CREDIT_HTML } from './credits.js';

/**
 * Byrd-IT Open buildings layer (BASEMAP.md 4.2-4.4, phase P6): the Overture
 * buildings 3D Tiles from the P5 edge, behind the same-origin
 * /basemap/v/<ver>/buildings/tileset.json.
 *
 * When it shows (createBuildingsVisibility):
 *   - only while the controller shows the Byrd-IT Open stack. Any other
 *     stack (Google 3D, which already has buildings in its mesh; Esri; OSM;
 *     Bing) DESTROYS the tileset, so its tile cache never sits in memory
 *     next to Google's.
 *   - hidden while the Google tileset is drawn at all: the no-flash hand-over
 *     of the P3 switch (autoSwitch.js) draws Google over the open globe for
 *     up to 3 s before the controller switches, and on the way back keeps it
 *     drawn until the globe has loaded.
 *   - at or below showBelowM camera height (above terrain, as the P3 switch
 *     measures it), hidden again above hideAboveM. The tileset is created the
 *     first time the camera comes down (a page at global view makes no
 *     buildings request) and only hidden, not destroyed, above the
 *     threshold while the open stack stays on screen.
 *
 * Evaluation follows the P3 switch rules: camera moveEnd plus a 1 Hz timer
 * while the camera moves, every settled controller switch, and a per-frame
 * check of ONE boolean (is Google drawn) that re-evaluates only when it
 * changes.
 *
 * Memory: maximumScreenSpaceError, cacheBytes and maximumCacheOverflowBytes
 * come from /basemap/config.json (config.js DEFAULT_BUILDINGS).
 *
 * Credits: BUILDINGS_CREDIT_HTML is a static credit only while buildings are
 * on screen. The tileset's own asset.copyright (the longer notice from P5)
 * goes to Cesium's credit lightbox.
 *
 * Pick: a left click on a building opens a small read-only card with the
 * EXT_structural_metadata properties (buildingPickInfo). The height is shown
 * as estimated unless height_method is "explicit".
 */

/** Pure hysteresis rule for the layer's visibility. */
export function createBuildingsVisibility({ showBelowM, hideAboveM }) {
  return {
    /**
     * @param {boolean} visible  the current visibility
     * @param {{openShown: boolean, googleShown: boolean, heightM: number}} view
     */
    next(visible, { openShown, googleShown, heightM }) {
      if (!openShown || googleShown) return false;
      if (!Number.isFinite(heightM)) return visible;
      return visible ? heightM <= hideAboveM : heightM <= showBelowM;
    },
  };
}

const METHOD_LABELS = Object.freeze({
  num_floors: 'floor count',
  class: 'building class',
  subtype: 'building type',
  footprint: 'footprint size',
  density: 'local building density',
});

const finiteNumber = (value) => {
  const n = typeof value === 'bigint' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (value) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
const metres = (value) => `${value.toFixed(1)} m`;

/**
 * Read-only info for a picked building (EXT_structural_metadata of the P5
 * tiles: name, class, subtype, height, height_method, num_floors,
 * source_height, ground_elev, gers_id).
 * @param {(name: string) => unknown} getProperty
 */
export function buildingPickInfo(getProperty) {
  const get = (name) => {
    try {
      return getProperty(name);
    } catch {
      return undefined;
    }
  };
  const name = text(get('name'));
  const kind = [text(get('class')), text(get('subtype'))]
    .filter(Boolean)
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(' / ');
  const height = finiteNumber(get('height'));
  const method = text(get('height_method'));
  const explicit = method === 'explicit';
  const rows = [];
  if (kind) rows.push(['Type', kind]);
  if (height !== null) {
    rows.push([
      'Height',
      explicit
        ? metres(height)
        : `~${metres(height)} (estimated from ${
            METHOD_LABELS[method] ?? 'an unknown method'
          })`,
    ]);
  }
  const floors = finiteNumber(get('num_floors'));
  if (floors !== null && floors > 0) rows.push(['Floors', String(floors)]);
  const ground = finiteNumber(get('ground_elev'));
  if (ground !== null && ground !== 0)
    rows.push(['Ground elevation', metres(ground)]);
  const gers = text(get('gers_id'));
  if (gers) rows.push(['Overture ID', gers]);
  return {
    title: name ?? 'Building',
    rows,
    heightEstimated: height !== null && !explicit,
    heightMethod: method,
  };
}

/** A small card in the viewer container; plain text only (no markup). */
export function createPickCard(container, doc = globalThis.document) {
  let card = null;
  const onKey = (event) => {
    if (event.key === 'Escape') hide();
  };
  function hide() {
    card?.remove();
    card = null;
    doc?.removeEventListener?.('keydown', onKey);
  }
  function show(info, position) {
    hide();
    if (!container || !doc?.createElement) return;
    card = doc.createElement('div');
    card.className = 'gev-building-pick';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', info.title);
    Object.assign(card.style, {
      position: 'absolute',
      left: `${Math.round((position?.x ?? 0) + 12)}px`,
      top: `${Math.round((position?.y ?? 0) + 12)}px`,
      maxWidth: '300px',
      padding: '8px 10px',
      background: 'rgba(12, 16, 22, 0.9)',
      color: '#e6edf3',
      font: '12px/1.4 system-ui, sans-serif',
      borderRadius: '6px',
      zIndex: '30',
      pointerEvents: 'auto',
    });
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    Object.assign(close.style, {
      float: 'right',
      background: 'none',
      border: '0',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: '14px',
    });
    close.addEventListener('click', hide);
    const title = doc.createElement('strong');
    title.textContent = info.title;
    card.append(close, title);
    for (const [label, value] of info.rows) {
      const row = doc.createElement('div');
      row.textContent = `${label}: ${value}`;
      card.append(row);
    }
    container.append(card);
    doc.addEventListener?.('keydown', onKey);
  }
  return {
    show,
    hide,
    get element() {
      return card;
    },
  };
}

/**
 * Drive the buildings layer for one viewer + map controller.
 *
 * @param {{
 *   Cesium: object,
 *   viewer: object,
 *   controller: object,
 *   config: ReturnType<import('./config.js').normalizeBuildings>,
 *   session?: {tileset: object|null},
 *   heightOf?: () => number,
 *   timers?: object,
 *   pollMs?: number,
 *   retryMs?: number,
 *   now?: () => number,
 *   pickCard?: {show: Function, hide: Function},
 *   pointerFree?: () => boolean,
 *   warn?: Function,
 * }} options
 * @returns {(() => void) & {evaluate: () => void, state: () => object}}
 */
export function attachBuildings({
  Cesium,
  viewer,
  controller,
  config,
  session = null,
  heightOf = () => cameraHeight(viewer),
  timers = globalThis,
  pollMs = 1_000,
  retryMs = 60_000,
  now = Date.now,
  pickCard = createPickCard(viewer?.container),
  pointerFree = isPointerFree,
  warn = (...args) => console.warn(...args),
}) {
  const scene = viewer.scene;
  const visibility = createBuildingsVisibility(config);
  let tileset = null;
  let creating = false;
  let gen = 0;
  let visible = false;
  let detached = false;
  let failedAt = -Infinity;
  let pollTimer = null;
  let googleWasShown = false;
  let creditOn = null;
  let handler = null;
  let created = 0;
  let destroyed = 0;
  const removers = [];

  const googleShown = () => session?.tileset?.show === true;

  function setCredit(on) {
    if (on === creditOn) return;
    const display = scene?.frameState?.creditDisplay;
    if (!display) return;
    try {
      if (creditOn) display.removeStaticCredit(creditOn);
      creditOn = on ? new Cesium.Credit(BUILDINGS_CREDIT_HTML, true) : null;
      if (creditOn) display.addStaticCredit(creditOn);
    } catch {
      creditOn = null;
    }
  }

  /** Make the tileset, the credit and the pick card follow `visible`. */
  function sync() {
    const shown = Boolean(tileset) && visible;
    if (tileset && tileset.show !== visible) tileset.show = visible;
    setCredit(shown);
    if (!shown) pickCard?.hide?.();
    scene?.requestRender?.();
  }

  function installPick() {
    if (handler || !Cesium.ScreenSpaceEventHandler || !scene?.canvas) return;
    handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((click) => {
      if (!tileset || !visible || !pointerFree()) return;
      let picked;
      try {
        picked = scene.pick(click.position);
      } catch {
        return;
      }
      if (
        picked?.tileset === tileset &&
        typeof picked.getProperty === 'function'
      )
        pickCard?.show?.(
          buildingPickInfo((name) => picked.getProperty(name)),
          click.position,
        );
      else pickCard?.hide?.();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removePick() {
    if (handler && !handler.isDestroyed?.()) handler.destroy();
    handler = null;
    pickCard?.hide?.();
  }

  function destroyTileset() {
    gen += 1;
    creating = false;
    visible = false;
    if (tileset) {
      const old = tileset;
      tileset = null;
      destroyed += 1;
      if (!old.isDestroyed?.()) {
        old.show = false;
        if (!scene.primitives.remove(old)) old.destroy?.();
      }
    }
    removePick();
    sync();
  }

  async function create() {
    const my = ++gen;
    creating = true;
    try {
      const made = await Cesium.Cesium3DTileset.fromUrl(config.url, {
        maximumScreenSpaceError: config.maximumScreenSpaceError,
        cacheBytes: config.cacheBytes,
        maximumCacheOverflowBytes: config.maximumCacheOverflowBytes,
        preloadWhenHidden: false,
        showCreditsOnScreen: false,
      });
      if (my !== gen || detached) {
        if (!made.isDestroyed?.()) made.destroy?.();
        return;
      }
      creating = false;
      made.show = false;
      scene.primitives.add(made);
      tileset = made;
      created += 1;
      installPick();
      evaluate();
    } catch (error) {
      if (my !== gen || detached) return;
      creating = false;
      failedAt = now();
      warn('[Basemap] buildings tileset unavailable:', error?.message || error);
    }
  }

  function evaluate() {
    if (detached) return;
    const openShown = controller.getActiveId() === BYRDIT_OPEN_STACK_ID;
    if (!openShown) {
      if (tileset || creating) destroyTileset();
      return;
    }
    visible = visibility.next(visible, {
      openShown,
      googleShown: googleShown(),
      heightM: heightOf(),
    });
    if (visible && !tileset && !creating && now() - failedAt >= retryMs)
      void create();
    sync();
  }

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
    destroyTileset();
    detached = true;
    timers.clearInterval(pollTimer);
    pollTimer = null;
    for (const remove of removers) remove?.();
  };
  detach.evaluate = evaluate;
  detach.state = () => ({
    visible,
    tileset,
    creating,
    created,
    destroyed,
    credit: Boolean(creditOn),
  });
  return detach;
}
