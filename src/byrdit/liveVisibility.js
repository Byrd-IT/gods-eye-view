/**
 * Byrd-IT fork: visibility gating for live map data (t_75fc43e5, 2026-10-09).
 *
 * Owner rule: live data (camera pictures, per-camera ground lookups, layer
 * polling) is pulled only for what is on screen. Pure helpers, no Cesium
 * import, so node tests can drive them with plain fakes. Upstream files call
 * in through small marked hooks (search "Byrd-IT visibility").
 */

/** Per-camera ground refinement (terrain lookups + mesh sampling) only runs
 * when the viewer is low enough for frustum/card detail to matter (street to
 * neighbourhood scale). Above this a few metres of icon height are invisible,
 * and mesh sampling hundreds of city cameras stalls the GPU (readPixels). The
 * active camera is always refined on selection, independent of this. */
export const CCTV_GEO_REFINE_MAX_HEIGHT_M = 20_000;

/** At most this many on-screen cameras are queued per camera settle,
 * nearest first; the next settle continues with the next nearest. */
export const CCTV_GEO_REFINE_MAX_PER_PASS = 60;

/** Screen margin (fraction of width/height) around the viewport that still
 * counts as "visible", so items just off the edge are ready when panned in. */
export const VISIBILITY_MARGIN = 0.1;

/** Wider margin for the active camera: its monitor plane extends past the
 * icon, so it keeps refreshing while any part could still be on screen. */
export const ACTIVE_CAMERA_MARGIN = 0.35;

/** Hidden tabs, minimised windows and background tabs see nothing. */
export function documentHidden(doc = globalThis.document) {
  return !!doc && doc.hidden === true;
}

/**
 * True when a canvas-space point lies inside the viewport plus margin.
 * @param {{x:number,y:number}|undefined|null} screen
 * @param {number} width
 * @param {number} height
 * @param {number} [margin]
 */
export function screenPointInView(
  screen,
  width,
  height,
  margin = VISIBILITY_MARGIN,
) {
  if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y))
    return false;
  if (!(width > 0) || !(height > 0)) return false;
  const mx = width * margin;
  const my = height * margin;
  return (
    screen.x >= -mx &&
    screen.x <= width + mx &&
    screen.y >= -my &&
    screen.y <= height + my
  );
}

/**
 * Builds a reusable "is this world position on screen" test for one view.
 * Horizon-occluded points (far side of the globe) are never visible.
 * @param {Object} viewer - Cesium viewer (duck-typed: scene.canvas,
 *   scene.cartesianToCanvasCoordinates).
 * @param {Object} occluder - object with isPointVisible(position).
 * @param {number} [margin]
 * @returns {(position:Object) => boolean}
 */
export function createViewTest(viewer, occluder, margin = VISIBILITY_MARGIN) {
  const scene = viewer?.scene;
  const canvas = scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;
  return (position) => {
    if (!position || !scene) return false;
    try {
      if (occluder && !occluder.isPointVisible(position)) return false;
      return screenPointInView(
        scene.cartesianToCanvasCoordinates(position),
        width,
        height,
        margin,
      );
    } catch {
      return false;
    }
  };
}

/** Geometry refinement gate: on-screen, low enough, tab visible. */
export function shouldRefineCameraGeometry({ inView, viewerHeightM, hidden }) {
  if (hidden) return false;
  if (!inView) return false;
  const h = Number(viewerHeightM);
  return !Number.isFinite(h) || h <= CCTV_GEO_REFINE_MAX_HEIGHT_M;
}

/**
 * Picks the records the geometry drain should visit for the current view.
 * Records already refined once are skipped; everything else waits until it
 * scrolls into view (cheap prior-height icons until then).
 * @param {Object[]} records
 * @param {(record:Object) => boolean} inView
 * @param {{viewerHeightM:number, hidden?:boolean}} view
 * @returns {Object[]}
 */
export function visibleRecordsNeedingGeometry(records, inView, view) {
  if (view?.hidden) return [];
  const h = Number(view?.viewerHeightM);
  if (Number.isFinite(h) && h > CCTV_GEO_REFINE_MAX_HEIGHT_M) return [];
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.byrditGeometryRefined) continue;
    if (inView(record.position)) out.push(record);
  }
  const limit = Number.isFinite(view?.limit)
    ? view.limit
    : CCTV_GEO_REFINE_MAX_PER_PASS;
  if (out.length > limit && typeof view?.distanceOf === 'function') {
    return out
      .map((record) => ({ record, d: view.distanceOf(record) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((entry) => entry.record);
  }
  return out.slice(0, limit);
}

/**
 * Drops queued records that are no longer on screen (the active camera is
 * always kept). They were never visited, so they re-queue when back in view.
 * @returns {Object[]} the pruned queue
 */
export function pruneOffscreenQueue(queue, inView, keep = null) {
  return (Array.isArray(queue) ? queue : []).filter(
    (record) => record === keep || inView(record?.position),
  );
}

/**
 * Live picture refresh gate for one camera (monitor plane / panel preview).
 * A forced refresh (user just activated the camera) always runs.
 */
export function shouldRefreshLiveFrame({ force = false, hidden, inView }) {
  if (force) return true;
  if (hidden) return false;
  return inView !== false;
}

/**
 * Panel preview gate: the side-panel picture is visible only while the tab
 * is visible and the panel is expanded.
 */
export function panelPreviewVisible({ hidden, collapsed }) {
  return !hidden && !collapsed;
}

/**
 * Lazily computed URL fields: the public camera state used to build
 * frame/media URLs for every catalog camera on every UI notify (8k
 * URLSearchParams per notify was the top CPU cost). Getters keep the field
 * names, enumerability and values identical for consumers.
 * @param {Object} target
 * @param {Record<string, () => any>} fields
 * @returns {Object} target
 */
export function defineLazyFields(target, fields) {
  for (const [key, compute] of Object.entries(fields)) {
    let cached;
    let done = false;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (!done) {
          cached = compute();
          done = true;
        }
        return cached;
      },
      set(value) {
        cached = value;
        done = true;
      },
    });
  }
  return target;
}
