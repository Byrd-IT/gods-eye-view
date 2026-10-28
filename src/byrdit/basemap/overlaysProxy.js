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
});
const MAX_LAYERS = 50;

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

/**
 * overlays.json -> { browser, routes }. `browser` is the `overlays` block of
 * /basemap/config.json; `routes` maps a layer id to its upstream archive,
 * file extension and edge port.
 * @param {unknown} raw
 */
export function composeOverlays(raw) {
  const routes = new Map();
  const layers = [];
  for (const entry of (Array.isArray(raw?.layers) ? raw.layers : []).slice(
    0,
    MAX_LAYERS,
  )) {
    if (!LIVE.has(entry?.status)) continue;
    const type = KINDS[entry?.kind];
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const minzoom = int(entry?.minzoom, 0, 22);
    const maxzoom = int(entry?.maxzoom, 0, 22);
    const bounds = bbox(entry?.bounds);
    if (!type || entry?.format !== type.format) continue;
    if (!ID.test(id) || routes.has(id)) continue;
    if (minzoom === null || maxzoom === null || maxzoom < minzoom) continue;
    if (!bounds || !archiveOk(entry?.archive)) continue;
    routes.set(id, {
      archive: String(entry.archive),
      format: type.format,
      port: int(entry?.edge?.port, 1024, 65535),
    });
    const opacity = Number(entry?.default_opacity);
    layers.push({
      id,
      name: text(entry?.name, id),
      kind: type.kind,
      format: type.format,
      url: `/basemap/overlay/${id}/{z}/{x}/{y}.${type.format}`,
      minzoom,
      maxzoom,
      bounds,
      defaultOpacity:
        Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : 1,
      credit: text(entry?.credit, 'Byrd-IT'),
      ...(type.kind === 'vector'
        ? { vectorLayers: vectorLayers(entry?.vector_layers) }
        : {}),
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
