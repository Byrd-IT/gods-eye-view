/**
 * Server side of the map overlay layers (BASEMAP M2 follow-up): the
 * `overlays` block of /basemap/config.json and the tile routes behind it.
 *
 * Off unless GEV_BASEMAP_OVERLAYS=1 (and GEV_BASEMAP=1, which turns the whole
 * /basemap plugin on). With the overlay flag off the composed config has NO
 * `overlays` key and the /basemap/overlay/ routes answer 404, so the page
 * behaves exactly as before.
 *
 * Source: the M2 manifest hires/m2/overlays.json (schema 1). Layers are
 * DISCOVERED from it; nothing here lists a layer. Only status "live" or
 * "live-data" entries of kind overlay-raster (webp) or overlay-vector (mvt)
 * are offered.
 *
 * The browser block is rebuilt field by field from validated values and
 * same-origin paths. Archive names, edge ports, origin URLs, hashes and file
 * names stay server-side: the browser only ever sees
 *   /basemap/overlay/<id>/{z}/{x}/{y}.webp   (raster)
 *   /basemap/overlay/<id>/{z}/{x}/{y}.mvt    (vector)
 * and the proxy maps <id> back to the archive with the cached config, so an
 * unknown id is a 404, never an upstream request.
 *
 * Environment:
 *   GEV_BASEMAP_OVERLAYS=1              flag (default OFF)
 *   GEV_BASEMAP_OVERLAYS_CONFIG=x[,y]   overlays.json: http(s) URL or absolute file path
 *   GEV_BASEMAP_HIRES_URLS=a,b          tile servers (go-pmtiles :12353); a layer's
 *                                       edge.port, when present, replaces the port
 */
import { layerCap } from './layerCap.js';

export const OVERLAY_TILE_ROUTE =
  /^\/basemap\/overlay\/([a-z0-9][a-z0-9-]{0,31})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.(webp|mvt)$/;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VECTOR_LAYER_ID = /^[A-Za-z0-9_]{1,40}$/;
const ARCHIVE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;
const TEXT = /^[A-Za-z0-9 /&+().,'-]{1,80}$/;
const LIVE = new Set(['live', 'live-data']);
const KINDS = Object.freeze({
  'overlay-raster': { kind: 'raster', format: 'webp' },
  'overlay-vector': { kind: 'vector', format: 'mvt' },
  // Our own OpenDroneMap 3D model (3D Tiles, b3dm). Not a z/x/y tile layer:
  // the files under hires/odm3d/<id>/ are relayed one by one.
  'overlay-3d': { kind: '3d', format: '3dtiles' },
});
/** Canopy heights the panel may offer, feet above local ground. */
export const CANOPY_MAX_FT = 120;
/** A file inside a 3D build: up to 3 plain segments, no dots-only parts. */
export const ODM3D_FILE_ROUTE =
  /^\/basemap\/odm3d\/([a-z0-9][a-z0-9-]{0,31})\/((?!\.{1,2}\/)(?:[A-Za-z0-9_-]{1,64}\/){0,2}[A-Za-z0-9_-]{1,96}\.(?:json|b3dm|glb|i3dm|pnts|cmpt|jpg|png))$/;
/** Default cap (raised from 50 on 2026-11-01); env-tunable via GEV_BASEMAP_OVERLAYS_MAX_LAYERS. */
export const DEFAULT_OVERLAY_MAX_LAYERS = 200;

const archiveOk = (value) => {
  const parts = String(value).split('/');
  return parts.length <= 3 && parts.every((p) => ARCHIVE_SEGMENT.test(p));
};
const int = (v, lo, hi) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const text = (value, fallback) =>
  typeof value === 'string' && TEXT.test(value.trim())
    ? value.trim()
    : fallback;

export function overlaysEnabled(env = process.env) {
  return String(env.GEV_BASEMAP_OVERLAYS ?? '').trim() === '1';
}

function bbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    return null;
  const [w, s, e, n] = value;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return [w, s, e, n];
}

function vectorLayers(raw) {
  const out = [];
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, 20)) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const minzoom = int(entry?.minzoom, 0, 22);
    const maxzoom = int(entry?.maxzoom, 0, 22);
    if (!VECTOR_LAYER_ID.test(id) || minzoom === null || maxzoom === null)
      continue;
    if (maxzoom < minzoom) continue;
    out.push({ id, minzoom, maxzoom });
  }
  return out;
}

const num = (v, lo, hi) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

/**
 * The 3D build facts the browser needs, from an overlay-3d manifest entry.
 * ground_m is the median bare-ground height (ODM DTM) in the model's own
 * heights; the canopy cut is measured from it. Null = entry unusable.
 */
function tileset3d(raw) {
  const groundM = num(raw?.ground_m, -500, 9000);
  if (groundM === null) return null;
  const offset = num(raw?.height_offset_m, -300, 300);
  const options = (
    Array.isArray(raw?.canopy_options_ft) ? raw.canopy_options_ft : [90, 120]
  )
    .map((v) => num(v, 10, CANOPY_MAX_FT))
    .filter((v) => v !== null)
    .slice(0, 4);
  const def = raw?.canopy_default_ft;
  return {
    groundM,
    heightOffsetM: offset ?? 0,
    canopyOptionsFt: options,
    canopyDefaultFt:
      def === null || def === undefined
        ? null
        : options.includes(def)
          ? def
          : null,
  };
}

/**
 * overlays.json -> { browser, routes }. `browser` is the `overlays` block of
 * /basemap/config.json; `routes` maps a layer id to its upstream archive,
 * file extension and edge port.
 * @param {unknown} raw
 */
export function composeOverlays(
  raw,
  { maxLayers = DEFAULT_OVERLAY_MAX_LAYERS } = {},
) {
  const MAX_LAYERS = layerCap(maxLayers, DEFAULT_OVERLAY_MAX_LAYERS);
  const routes = new Map();
  const layers = [];
  for (const entry of (Array.isArray(raw?.layers) ? raw.layers : []).slice(
    0,
    MAX_LAYERS,
  )) {
    if (!LIVE.has(entry?.status)) continue;
    const type = KINDS[entry?.kind];
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const is3d = type?.kind === '3d';
    // A 3D model has no zoom range: it is fetched by screen error, not by level.
    const minzoom = is3d ? 0 : int(entry?.minzoom, 0, 22);
    const maxzoom = is3d ? 22 : int(entry?.maxzoom, 0, 22);
    const bounds = bbox(entry?.bounds);
    if (!type || entry?.format !== type.format) continue;
    if (!ID.test(id) || routes.has(id)) continue;
    if (minzoom === null || maxzoom === null || maxzoom < minzoom) continue;
    if (!bounds || !archiveOk(entry?.archive)) continue;
    const model = is3d ? tileset3d(entry) : null;
    if (is3d && !model) continue;
    routes.set(id, {
      archive: String(entry.archive),
      format: type.format,
      port: is3d ? null : int(entry?.edge?.port, 1024, 65535),
    });
    const opacity = Number(entry?.default_opacity);
    layers.push({
      id,
      name: text(entry?.name, id),
      kind: type.kind,
      format: type.format,
      url: is3d
        ? `/basemap/odm3d/${id}/tileset.json`
        : `/basemap/overlay/${id}/{z}/{x}/{y}.${type.format}`,
      minzoom,
      maxzoom,
      bounds,
      defaultOpacity:
        Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : 1,
      credit: text(entry?.credit, 'Byrd-IT'),
      ...(type.kind === 'vector'
        ? { vectorLayers: vectorLayers(entry?.vector_layers) }
        : {}),
      ...(is3d ? { model } : {}),
    });
  }
  return {
    browser: layers.length ? { available: true, layers } : { available: false },
    routes,
  };
}

/** Upstream bases for a layer: the hires hosts, with its edge port. */
export function overlayBases(hiresUrls, port) {
  if (!port) return hiresUrls;
  return hiresUrls.map((base) => {
    try {
      const url = new URL(base);
      url.port = String(port);
      return url.toString().replace(/\/+$/, '');
    } catch {
      return base;
    }
  });
}

/**
 * Resolve a /basemap/overlay/... path to {bases, path} with the composed
 * routes, or null when the id is not offered or the extension does not match
 * the layer's format (404).
 * @param {string} pathname
 * @param {ReturnType<typeof composeOverlays>['routes']|null} routes
 * @param {{hiresUrls: string[]}} settings
 */
export function resolveOverlayTile(pathname, routes, settings) {
  const m = OVERLAY_TILE_ROUTE.exec(pathname);
  if (!m) return null;
  const [, id, z, x, y, ext] = m;
  const route = routes?.get(id);
  if (!route || route.format !== ext || !settings.hiresUrls.length) return null;
  return {
    bases: overlayBases(settings.hiresUrls, route.port),
    path: `/${route.archive}/${z}/${x}/${y}.${ext}`,
  };
}

/**
 * Resolve /basemap/odm3d/<id>/<file> to {bases, path} (the S1 origin, which
 * serves the published build folders as plain files), or null when the id is
 * not an offered 3D layer or the path is not a plain file inside it.
 * @param {string} pathname
 * @param {ReturnType<typeof composeOverlays>['routes']|null} routes
 * @param {{odm3dUrls: string[]}} settings
 */
export function resolveOdm3dFile(pathname, routes, settings) {
  const m = ODM3D_FILE_ROUTE.exec(pathname);
  if (!m) return null;
  const [, id, file] = m;
  const route = routes?.get(id);
  if (!route || route.format !== '3dtiles' || !settings.odm3dUrls?.length)
    return null;
  return { bases: settings.odm3dUrls, path: `/${route.archive}/${file}` };
}

/**
 * Origin bases for the 3D files, derived from the overlays.json location
 * (http://host:8480/hires/m2/overlays.json -> http://host:8480/hires) unless
 * set explicitly. File paths are not accepted for this (no local reads).
 * @param {string[]} configSources
 * @param {string[]} explicit
 */
export function odm3dBases(configSources, explicit = []) {
  if (explicit.length) return explicit;
  const out = [];
  for (const source of configSources ?? []) {
    if (!/^https?:\/\//i.test(source)) continue;
    try {
      const url = new URL(source);
      const base = `${url.origin}${url.pathname.replace(/\/[^/]+\/overlays\.json$/, '')}`;
      if (base !== url.origin + url.pathname)
        out.push(base.replace(/\/+$/, ''));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * An error message safe to log: every URL in it is cut down to
 * scheme://host/path (no userinfo, query or fragment). fetch() puts the whole
 * configured URL, credentials included, into some of its error messages.
 * @param {unknown} error
 */
export function safeErrorText(error) {
  const text = String(error?.message || error);
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.hostname}${url.pathname}`;
    } catch {
      return '<url>';
    }
  });
}
