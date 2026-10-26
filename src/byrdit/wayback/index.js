import { t } from '../../i18n/index.js';
import {
  createImageryVoice,
  ensureByrditOpen,
  flyToImageryBounds,
} from '../basemap/imageryVoice.js';
import { createWaybackImageryProvider } from './layer.js';
import { createWaybackPanel } from './panel.js';
import {
  INFO_MS,
  INFO_URL,
  RELEASES_URL,
  SETTLE_MS,
  WAYBACK_BASE_STACK,
  WAYBACK_LEASE_OWNER,
  clampIndex,
  createDebounce,
  describeCapture,
  normalizeReleaseDoc,
  waybackFlagOn,
} from './model.js';

export { waybackFlagOn };

/**
 * Esri Wayback time travel (GEV_BYRDIT_WAYBACK). A toggle, a date slider
 * (newest at the right), older/newer buttons and a Latest reset.
 *
 * Separate from the NAIP year slider and independent of it: this module
 * only reads the release list from /api/byrdit/wayback/releases and draws a
 * same-origin tile layer (the server keeps the perpetual tile cache).
 *
 * Base / 3D handling: turning it ON takes an imagery-comparison lease on
 * the map controller with switchPolicy 'esri' (the same mechanism the
 * Recent Imagery layer uses). That switches the stack to Esri imagery (so
 * Google photorealistic 3D, which would cover the imagery, is hidden and
 * the globe is shown). Turning it OFF releases the lease, which puts back
 * exactly the stack that was active before (Google 3D, Byrd-IT Open, ...).
 * If someone else holds the lease the toggle explains and stays off. If the
 * operator picks Google 3D / Byrd-IT Open while it is on, it turns itself
 * off (the lease then restores nothing, the operator's pick stands).
 *
 * Dragging only moves the label; tiles for a release load once the slider
 * has been quiet for SETTLE_MS. The optional per-location capture date (the
 * server's `info` sub-flag) asks once per settle, at least INFO_MS after
 * the last change.
 */

const OWN_STACKS_THAT_COVER = new Set(['photoreal', 'byrdit-open']);
const SWAP_CLEANUP_MS = 1500;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

function viewOfViewer(viewer, Cesium) {
  try {
    const ellipsoid = viewer.scene?.globe?.ellipsoid ?? viewer.scene?.ellipsoid;
    const canvas = viewer.scene?.canvas;
    const hit = viewer.camera?.pickEllipsoid?.(
      { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
      ellipsoid,
    );
    if (!hit) return null;
    const c = ellipsoid.cartesianToCartographic(hit);
    const deg = Cesium?.Math?.toDegrees ?? ((v) => (v * 180) / Math.PI);
    const lat = deg(c.latitude);
    const height = viewer.camera.positionCartographic?.height ?? 0;
    const z =
      height > 0
        ? Math.log2(
            (EARTH_CIRCUMFERENCE_M * Math.max(0.01, Math.cos(c.latitude))) /
              height,
          )
        : 12;
    return {
      lat,
      lon: deg(c.longitude),
      z: Math.max(0, Math.min(19, Math.round(z))),
    };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   Cesium: object, viewer: object, controller: object, doc?: object,
 *   fetchImpl?: typeof fetch, timers?: object,
 *   createProvider?: Function, createPanel?: Function|null,
 *   viewOf?: () => ({lat: number, lon: number, z: number}|null),
 *   settleMs?: number, infoMs?: number, swapMs?: number,
 * }} options
 * @returns {Promise<(() => void) & object>} detach (also carries the API); a no-op detach when the flag is off
 */
export async function attachWayback({
  Cesium,
  viewer,
  controller,
  doc = globalThis.document,
  fetchImpl = globalThis.fetch,
  timers = globalThis,
  createProvider = (release, credit) =>
    createWaybackImageryProvider(Cesium, release, { credit }),
  createPanel = createWaybackPanel,
  viewOf = () => viewOfViewer(viewer, Cesium),
  settleMs = SETTLE_MS,
  infoMs = INFO_MS,
  swapMs = SWAP_CLEANUP_MS,
} = {}) {
  const off = () => {};
  if (!waybackFlagOn(doc) || !viewer || !controller) return off;

  let doc_ = null;
  try {
    const response = await fetchImpl(RELEASES_URL, {
      credentials: 'same-origin',
    });
    if (!response?.ok) return off;
    doc_ = normalizeReleaseDoc(await response.json());
  } catch {
    return off;
  }
  if (!doc_) return off;
  const { releases, attribution } = doc_;
  const last = releases.length - 1;
  const scene = viewer.scene;
  const collection = viewer.imageryLayers;

  const state = {
    on: false,
    index: last,
    detail: '',
    notice: '',
  };
  /** The release the shown layer draws (null = none). */
  let shownRelease = null;
  let layer = null;
  const retired = new Set();
  let lease = null;
  let leaseReady = false;
  let releasing = null;
  let enabling = 0;
  let unsubscribe = null;
  let creditObject = null;
  let creditText = null;
  let destroyed = false;
  let infoToken = 0;
  let layersCreated = 0;
  let infoRequests = 0;
  const removers = [];

  const requestRender = () => scene?.requestRender?.();
  const labelOf = (i) => releases[i].date;

  function paint() {
    panel?.update({
      on: state.on,
      index: state.index,
      label: labelOf(state.index),
      detail: state.detail,
      notice: state.notice,
    });
  }

  // ----- credits -----
  function setCredit(text) {
    const display = scene?.frameState?.creditDisplay;
    if (!display || text === creditText) return;
    try {
      if (creditObject) display.removeStaticCredit(creditObject);
      creditObject = text ? new Cesium.Credit(text, true) : null;
      creditText = text;
      if (creditObject) display.addStaticCredit(creditObject);
    } catch {
      /* retried on the next change */
    }
  }

  // ----- layer -----
  function baseIndex() {
    const base = controller._imageryLayer;
    const i = base ? collection.indexOf(base) : -1;
    return i < 0 ? 0 : i + 1;
  }

  function dropLayer(held) {
    retired.delete(held);
    try {
      if (!held.isDestroyed?.()) collection.remove(held, true);
    } catch {
      /* already gone */
    }
  }

  function showRelease(release, date) {
    if (shownRelease === release) return;
    const previous = layer;
    const created = new Cesium.ImageryLayer(createProvider(release));
    layersCreated += 1;
    collection.add(created, Math.min(baseIndex(), collection.length));
    layer = created;
    shownRelease = release;
    if (previous) {
      retired.add(previous);
      timers.setTimeout(() => {
        if (retired.has(previous)) {
          dropLayer(previous);
          requestRender();
        }
      }, swapMs);
    }
    setCredit(`${attribution} · Wayback ${date}`);
    requestRender();
  }

  function removeAllLayers() {
    if (layer) dropLayer(layer);
    for (const held of [...retired]) dropLayer(held);
    layer = null;
    shownRelease = null;
    setCredit(null);
    requestRender();
  }

  // ----- settle (debounced tile load) and optional per-location info -----
  const lookup = createDebounce(
    async () => {
      if (!state.on || !leaseReady || !doc_.info) return;
      const view = viewOf();
      if (!view) return;
      const entry = releases[state.index];
      const token = ++infoToken;
      infoRequests += 1;
      try {
        const params = new URLSearchParams({
          release: String(entry.release),
          lat: view.lat.toFixed(4),
          lon: view.lon.toFixed(4),
          z: String(view.z),
        });
        const response = await fetchImpl(`${INFO_URL}?${params}`, {
          credentials: 'same-origin',
        });
        if (!response?.ok) throw new Error('info unavailable');
        const text = describeCapture(await response.json());
        if (token !== infoToken || !state.on) return;
        state.detail = text
          ? t('Captured {details}', { details: text })
          : releaseNote(entry);
      } catch {
        if (token !== infoToken || !state.on) return;
        state.detail = releaseNote(entry);
      }
      paint();
    },
    infoMs,
    timers,
  );

  const releaseNote = (entry) =>
    t('Wayback release {date}', { date: entry.date });

  const settle = createDebounce(
    () => {
      if (!state.on || !leaseReady) return;
      const entry = releases[state.index];
      showRelease(entry.release, entry.date);
      state.detail = releaseNote(entry);
      paint();
      lookup();
    },
    settleMs,
    timers,
  );

  // ----- on / off -----
  function onControllerChange() {
    if (!state.on || !leaseReady) return;
    if (OWN_STACKS_THAT_COVER.has(controller.getActiveId?.())) disable();
  }

  async function enable() {
    if (destroyed || state.on) return false;
    if (releasing) await releasing;
    if (destroyed || state.on) return false;
    const mine = ++enabling;
    state.notice = '';
    let held;
    try {
      held = controller.acquireImageryComparison({
        owner: WAYBACK_LEASE_OWNER,
        switchPolicy: 'esri',
      });
    } catch {
      state.notice = t('Another imagery tool is using the map');
      paint();
      return false;
    }
    lease = held;
    leaseReady = false;
    state.on = true;
    state.detail = '';
    paint();
    let result;
    try {
      result = await held.ready;
    } catch {
      result = { status: 'failed' };
    }
    if (mine !== enabling || lease !== held || !state.on) return false;
    if (result?.status !== 'ready') {
      state.notice = t('Esri imagery is unavailable right now');
      await disable();
      return false;
    }
    leaseReady = true;
    unsubscribe = controller.subscribe?.(() => onControllerChange()) ?? null;
    const entry = releases[state.index];
    showRelease(entry.release, entry.date);
    state.detail = releaseNote(entry);
    paint();
    lookup();
    return true;
  }

  function disable() {
    if (!state.on && !lease) return releasing ?? Promise.resolve();
    enabling += 1;
    state.on = false;
    leaseReady = false;
    settle.cancel();
    lookup.cancel();
    infoToken += 1;
    unsubscribe?.();
    unsubscribe = null;
    removeAllLayers();
    state.detail = '';
    paint();
    const held = lease;
    lease = null;
    if (!held) return Promise.resolve();
    releasing = Promise.resolve()
      .then(() => held.release())
      .catch((error) => {
        console.warn(
          '[Wayback] could not restore the previous map:',
          typeof error?.name === 'string' ? error.name : 'Error',
        );
      })
      .then(() => {
        releasing = null;
        requestRender();
      });
    return releasing;
  }

  // ----- slider -----
  function setIndex(index) {
    const next = clampIndex(index, releases.length);
    if (next === state.index) return false;
    state.index = next;
    state.notice = '';
    if (state.on) {
      state.detail = '';
      infoToken += 1;
      lookup.cancel();
      settle();
    }
    paint();
    return true;
  }

  const api = {
    enable,
    disable,
    setIndex,
    step: (delta) => setIndex(state.index + delta),
    latest: () => setIndex(last),
    /** Run the pending debounced work now (tests, keyboard users who want it at once). */
    settleNow: () => settle.flush(),
    state: () => ({
      on: state.on,
      ready: leaseReady,
      index: state.index,
      release: releases[state.index].release,
      date: releases[state.index].date,
      count: releases.length,
      shownRelease,
      layersCreated,
      layersOnGlobe: (layer ? 1 : 0) + retired.size,
      infoRequests,
      credit: creditText,
      notice: state.notice,
      detail: state.detail,
    }),
  };

  const panel = createPanel
    ? createPanel({
        container: viewer.container,
        count: releases.length,
        onToggle: (on) => (on ? enable() : disable()),
        onIndex: (i) => setIndex(i),
        onStep: (delta) => api.step(delta),
        onLatest: () => api.latest(),
      })
    : null;
  paint();

  const camera = viewer.camera;
  if (camera?.moveEnd?.addEventListener) {
    removers.push(
      camera.moveEnd.addEventListener(() => {
        if (!state.on || !leaseReady) return;
        state.detail = releaseNote(releases[state.index]);
        paint();
        lookup();
      }),
    );
  }

  const hookWindow =
    viewer?.container?.ownerDocument?.defaultView ?? globalThis;
  const waybackSlot = {
    enable: api.enable,
    disable: api.disable,
    setIndex: api.setIndex,
    settleNow: api.settleNow,
    state: api.state,
    catalog: () =>
      releases.map((entry) => ({ release: entry.release, date: entry.date })),
  };
  if (hookWindow) hookWindow.__gevWayback = waybackSlot;
  // Wayback can be on when the Open basemap flag is off. Install a voice
  // then; the basemap attach replaces it with one that also knows NAIP.
  let imagerySlot = null;
  if (hookWindow && !hookWindow.__gevImagery) {
    imagerySlot = {
      voice: createImageryVoice({
        getNaip: () => null,
        getCatalog: () => null,
        getWayback: () => hookWindow.__gevWayback ?? null,
        ensureOpen: () => ensureByrditOpen(controller),
        flyTo: (bounds) => flyToImageryBounds(viewer, Cesium, bounds),
      }),
    };
    hookWindow.__gevImagery = imagerySlot;
  }

  const detach = () => {
    if (destroyed) return;
    destroyed = true;
    if (hookWindow?.__gevWayback === waybackSlot)
      delete hookWindow.__gevWayback;
    if (imagerySlot && hookWindow?.__gevImagery === imagerySlot)
      delete hookWindow.__gevImagery;
    disable();
    for (const remove of removers) remove?.();
    panel?.destroy?.();
  };
  return Object.assign(detach, api, { panel });
}
