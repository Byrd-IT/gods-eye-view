/**
 * Esri Wayback time travel: browser-side model (pure, no Cesium, no DOM).
 *
 * The server (server/byrdit/wayback) serves the release list and a
 * same-origin tile cache; nothing here ever talks to Esri directly.
 */

export const WAYBACK_META_NAME = 'gev-wayback';
export const WAYBACK_API = '/api/byrdit/wayback';
export const RELEASES_URL = `${WAYBACK_API}/releases`;
export const INFO_URL = `${WAYBACK_API}/info`;
/** The stack the lease switches to (Google 3D hides the imagery). */
export const WAYBACK_BASE_STACK = 'esri-imagery';
export const WAYBACK_LEASE_OWNER = 'wayback';
export const WAYBACK_PANEL_ID = 'gev-wayback';
export const DEFAULT_ATTRIBUTION =
  'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
/** Tiles are requested to this level; Cesium enlarges the deepest level beyond. */
export const MAX_LEVEL = 19;
/** Quiet time after the last slider move before tiles load for the release. */
export const SETTLE_MS = 350;
/** Quiet time before the optional per-location lookup (one request). */
export const INFO_MS = 1000;

/** True only when the server rendered the page with the Wayback flag on. */
export function waybackFlagOn(doc = globalThis.document) {
  try {
    const meta = doc?.querySelector?.(`meta[name="${WAYBACK_META_NAME}"]`);
    return meta?.getAttribute?.('content') === '1';
  } catch {
    return false;
  }
}

/** Same-origin Cesium URL template for one release (z / row({y}) / col({x})). */
export function tileTemplate(release) {
  if (!Number.isSafeInteger(release) || release < 0)
    throw new RangeError('invalid Wayback release');
  return `${WAYBACK_API}/tile/${release}/{z}/{y}/{x}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the /releases document. Releases come back OLDEST FIRST (the
 * slider's order: newest at the right). Anything off = null (no control).
 */
export function normalizeReleaseDoc(doc) {
  const list = Array.isArray(doc?.releases) ? doc.releases : [];
  const seen = new Set();
  const releases = [];
  for (const entry of list.slice(0, 1000)) {
    const release = entry?.release;
    if (!Number.isSafeInteger(release) || release < 0 || seen.has(release))
      continue;
    if (typeof entry.date !== 'string' || !DATE.test(entry.date)) continue;
    seen.add(release);
    releases.push({ release, date: entry.date });
  }
  if (!releases.length) return null;
  releases.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.release - b.release,
  );
  const attribution =
    typeof doc.attribution === 'string' &&
    /^[\w ,.&()'-]{1,120}$/.test(doc.attribution)
      ? doc.attribution
      : DEFAULT_ATTRIBUTION;
  return {
    releases,
    attribution,
    stale: doc.stale === true,
    info: doc.info === true,
  };
}

export const clampIndex = (index, length) =>
  Math.max(0, Math.min(length - 1, Math.trunc(Number(index)) || 0));

/** Debounce with injectable timers; .flush() runs it now, .cancel() drops it. */
export function createDebounce(fn, ms, timers = globalThis) {
  let handle = null;
  let args = null;
  const debounced = (...next) => {
    args = next;
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      handle = null;
      const call = args;
      args = null;
      fn(...call);
    }, ms);
  };
  debounced.cancel = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
    args = null;
  };
  debounced.flush = () => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
    const call = args;
    args = null;
    fn(...call);
  };
  debounced.pending = () => handle !== null;
  return debounced;
}

/** "2023-04-12 · 0.5 m · Vivid / Vantor" from the /info document. */
export function describeCapture(info) {
  if (!info?.captured && !info?.source) return '';
  const parts = [];
  if (info.captured && DATE.test(info.captured)) parts.push(info.captured);
  if (Number.isFinite(info.resolutionM) && info.resolutionM > 0)
    parts.push(
      info.resolutionM < 1
        ? `${Math.round(info.resolutionM * 100)} cm`
        : `${Number(info.resolutionM.toFixed(1))} m`,
    );
  const source = [info.source, info.provider].filter(
    (s) => typeof s === 'string' && s,
  );
  if (source.length) parts.push(source.join(' / '));
  return parts.join(' · ');
}
