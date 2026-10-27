/**
 * Byrd-IT Open base map: browser side of /basemap/config.json (BASEMAP.md
 * 4.2, 4.3).
 *
 * The flag is server-side (GEV_BASEMAP=1). The /basemap proxy plugin marks
 * the page with <meta name="gev-basemap" content="1">. Without that marker
 * nothing in this module runs and no /basemap request is made, so with the
 * flag OFF the page behaves exactly as before.
 *
 * Coverage is discovered from the config (written from the real archives),
 * never hard-coded here. Every URL the browser uses is a same-origin
 * /basemap/ path; normalizeBasemapConfig drops anything else.
 */

import { normalizeNaip } from './naipConfig.js';

export const BASEMAP_META_NAME = 'gev-basemap';
export const BASEMAP_CONFIG_URL = '/basemap/config.json';
export const BASEMAP_PATH_PREFIX = '/basemap/';

/** Rev2 4.3 switching defaults; /basemap/config.json may override them. */
export const DEFAULT_SWITCH = Object.freeze({
  auto: true,
  enterM: 5_000,
  leaveM: 8_000,
  dwellMs: 5_000,
  reRootAgeMs: 2.5 * 60 * 60 * 1000,
  rootAttemptsPerHour: 3,
});

/**
 * Buildings layer defaults (P6; BASEMAP.md 4.2, 4.3 item 7). The layer is
 * part of the Byrd-IT Open stack and is shown only while that stack is on
 * screen and the camera is at or below showBelowM; it hides again above
 * hideAboveM (hysteresis, so it does not flicker at the edge). The default
 * show height equals the Google LEAVE height: in auto mode Google takes over
 * at 5,000 m, so buildings are seen with the open globe from 8,000 m down
 * to the Google switch, and all the way down when Open is pinned or Google
 * is unavailable. Memory: Cesium's tile cache for this tileset is capped at
 * cacheBytes (+ maximumCacheOverflowBytes while a view needs more).
 */
export const DEFAULT_BUILDINGS = Object.freeze({
  showBelowM: 8_000,
  hideAboveM: 10_000,
  maximumScreenSpaceError: 16,
  cacheBytes: 256 * 1024 * 1024,
  maximumCacheOverflowBytes: 128 * 1024 * 1024,
});
const MAX_BUILDINGS_CACHE_BYTES = 1024 * 1024 * 1024;

/**
 * Cold /basemap/config.json time budget, shared by the proxy and the browser
 * so a hung primary upstream still reaches the healthy standby before the
 * browser gives up (review t_d9b79b50 R2).
 *
 *   attemptMs  one config upstream attempt (headers + body). Config files are
 *              a few hundred bytes, so a primary slower than this is treated
 *              as down and the next URL is tried.
 *   composeMs  the whole compose: terrain and imagery configs run in
 *              parallel, each walking its failover list, all inside this
 *              deadline. Two attempts (active + standby) fit with margin.
 *   clientMs   the browser's fetch timeout: composeMs plus a margin for the
 *              GEV server itself, so the browser always gets the composed
 *              answer (available or not) instead of aborting first.
 */
export const CONFIG_BUDGET = Object.freeze({
  attemptMs: 2_000,
  composeMs: 5_000,
  clientMs: 7_000,
});

/** True only when the server rendered the page with the basemap flag on. */
export function basemapFlagOn(doc = globalThis.document) {
  try {
    const meta = doc?.querySelector?.(`meta[name="${BASEMAP_META_NAME}"]`);
    return meta?.getAttribute?.('content') === '1';
  } catch {
    return false;
  }
}

const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const zoom = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 22 ? value : null;
const samePath = (value) =>
  typeof value === 'string' &&
  value.startsWith(BASEMAP_PATH_PREFIX) &&
  !value.includes('://') &&
  !value.includes('..') &&
  !value.includes('?')
    ? value
    : null;

function bounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [w, s, e, n] = value.map(finite);
  if ([w, s, e, n].some((v) => v === null)) return null;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return [w, s, e, n];
}

function positive(value, fallback) {
  const v = finite(value);
  return v !== null && v > 0 ? v : fallback;
}

/**
 * Validate the served config into the shape the stack uses. Unknown fields
 * are dropped; a part that does not validate is marked unavailable with a
 * reason rather than half-used.
 * @param {unknown} raw
 */
export function normalizeBasemapConfig(raw) {
  const t = raw?.terrain ?? {};
  const i = raw?.imagery ?? {};
  const terrainUrl = samePath(t.url);
  const imageryUrl = samePath(i.url);
  const terrain = {
    available: t.available === true && Boolean(terrainUrl),
    url: terrainUrl,
    version: typeof t.version === 'string' ? t.version : null,
    maxzoom: zoom(t.maxzoom) ?? 0,
    waterMask: t.waterMask !== false,
  };
  const regions = (Array.isArray(i.regions) ? i.regions : [])
    .map((r) => ({ bounds: bounds(r?.bounds), maxzoom: zoom(r?.maxzoom) }))
    .filter((r) => r.bounds && r.maxzoom !== null);
  const baseMaxzoom = zoom(i.baseMaxzoom) ?? 0;
  const imagery = {
    available:
      i.available === true &&
      Boolean(imageryUrl) &&
      /\{z\}.*\{x\}.*\{y\}/.test(imageryUrl ?? ''),
    url: imageryUrl,
    baseMaxzoom,
    maxzoom: Math.max(baseMaxzoom, zoom(i.maxzoom) ?? baseMaxzoom),
    year: Number.isInteger(i.year) ? i.year : null,
    regions,
  };
  const s = raw?.switch ?? {};
  const enterM = positive(s.enterM, DEFAULT_SWITCH.enterM);
  let leaveM = positive(s.leaveM, DEFAULT_SWITCH.leaveM);
  if (leaveM <= enterM) leaveM = enterM * 1.6;
  const sw = {
    auto: s.auto !== false,
    enterM,
    leaveM,
    dwellMs: positive(s.dwellMs, DEFAULT_SWITCH.dwellMs),
    reRootAgeMs: positive(s.reRootAgeMs, DEFAULT_SWITCH.reRootAgeMs),
    rootAttemptsPerHour: Math.max(
      1,
      Math.floor(
        positive(s.rootAttemptsPerHour, DEFAULT_SWITCH.rootAttemptsPerHour),
      ),
    ),
  };
  const buildings = normalizeBuildings(raw?.buildings);
  // N6: the NAIP year slider block; absent (flag off) = not offered.
  const naip = normalizeNaip(raw?.naip);
  const reasons = [];
  if (!terrain.available) reasons.push('terrain');
  if (!imagery.available) reasons.push('imagery');
  return {
    available: reasons.length === 0,
    unavailableReason: reasons.length
      ? `Byrd-IT Open map service is unavailable (${reasons.join(', ')})`
      : null,
    terrain,
    imagery,
    buildings,
    naip,
    switch: sw,
  };
}

/**
 * The optional buildings block. A missing or invalid block only turns the
 * buildings layer off; the stack itself stays available.
 */
export function normalizeBuildings(raw) {
  const b = raw ?? {};
  const url = samePath(b.url);
  const showBelowM = positive(b.showBelowM, DEFAULT_BUILDINGS.showBelowM);
  let hideAboveM = positive(b.hideAboveM, DEFAULT_BUILDINGS.hideAboveM);
  if (hideAboveM <= showBelowM) hideAboveM = showBelowM * 1.25;
  const sse = positive(
    b.maximumScreenSpaceError,
    DEFAULT_BUILDINGS.maximumScreenSpaceError,
  );
  const bytes = (value, fallback) =>
    Math.min(MAX_BUILDINGS_CACHE_BYTES, Math.floor(positive(value, fallback)));
  return {
    available:
      b.available === true && Boolean(url) && url.endsWith('/tileset.json'),
    url: url && url.endsWith('/tileset.json') ? url : null,
    version: typeof b.version === 'string' ? b.version : null,
    bounds: bounds(b.bounds),
    showBelowM,
    hideAboveM,
    maximumScreenSpaceError: Math.min(256, Math.max(1, sse)),
    cacheBytes: bytes(b.cacheBytes, DEFAULT_BUILDINGS.cacheBytes),
    maximumCacheOverflowBytes: bytes(
      b.maximumCacheOverflowBytes,
      DEFAULT_BUILDINGS.maximumCacheOverflowBytes,
    ),
  };
}

/**
 * Fetch and validate /basemap/config.json. A network or HTTP failure gives
 * an unavailable config (never throws), so the caller can take the esri path.
 */
export async function loadBasemapConfig({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = CONFIG_BUDGET.clientMs,
} = {}) {
  try {
    const timeout = AbortSignal.timeout?.(timeoutMs);
    const combined =
      signal && timeout && AbortSignal.any
        ? AbortSignal.any([signal, timeout])
        : (signal ?? timeout);
    const response = await fetchImpl(BASEMAP_CONFIG_URL, {
      signal: combined,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeBasemapConfig(await response.json());
  } catch (error) {
    signal?.throwIfAborted?.();
    const unavailable = normalizeBasemapConfig(null);
    unavailable.unavailableReason = `Byrd-IT Open map service is unavailable (${
      error?.message || String(error)
    })`;
    return unavailable;
  }
}
