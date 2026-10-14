/**
 * Server side of the NAIP year time slider (BASEMAP N6): the `naip` block of
 * /basemap/config.json and the tile routes behind it.
 *
 * Off unless GEV_BASEMAP_NAIP=1 (and GEV_BASEMAP=1, which turns the whole
 * /basemap plugin on). With the NAIP flag off the composed config has NO
 * `naip` key and the /basemap/naip/ routes answer 404, so the page behaves
 * exactly as the P3 stack did.
 *
 * Source: the multi-year config.json published by the NAIP builds (N1 schema
 * 1, ~/projects/gev-history/basemap-n1/naip-config.schema.md): `years[]`
 * (statewide NAIP, one PMTiles archive per year) and `regional[]` (Wood +
 * Upshur high-resolution and historic layers, H1-H3). Only entries with
 * status "live" are offered. Years and regions are DISCOVERED from that file;
 * nothing here lists a year or a county.
 *
 * The browser block is rebuilt field by field from validated numbers, short
 * plain credit text and same-origin paths. Archive names, edge ports, origin
 * URLs, hashes and file names stay server-side: the browser only ever sees
 *   /basemap/naip/<year>/{z}/{x}/{y}.webp              (statewide year)
 *   /basemap/naip/regional/<id>/{z}/{x}/{y}.webp       (regional layer)
 * and the proxy maps <year>/<id> back to the archive with the cached config,
 * so an unknown year or id is a 404, never an upstream request.
 *
 * Environment:
 *   GEV_BASEMAP_NAIP=1                 flag (default OFF)
 *   GEV_BASEMAP_NAIP_CONFIG=x[,y]      NAIP config.json: http(s) URL or absolute file path
 *   GEV_BASEMAP_NAIP_URLS=a,b          statewide NAIP tile servers (go-pmtiles :12352)
 *   GEV_BASEMAP_HIRES_URLS=a,b         regional tile servers (go-pmtiles :12353); a
 *                                      regional entry's edge.port, when present,
 *                                      replaces the port of these hosts
 */

export const NAIP_TILE_ROUTE =
  /^\/basemap\/naip\/(\d{4})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.webp$/;
export const NAIP_REGIONAL_ROUTE =
  /^\/basemap\/naip\/regional\/([A-Za-z0-9._-]{1,64})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.webp$/;
const ARCHIVE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;
/** 1-3 plain path segments ("2024/naip-tx-2024"); "." and ".." refused. */
const archiveOk = (value) => {
  const parts = value.split('/');
  return parts.length <= 3 && parts.every((p) => ARCHIVE_SEGMENT.test(p));
};
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
/** Credit text is plain words only: no markup, no URLs. */
const CREDIT_TEXT = /^[A-Za-z0-9 /&+().,'-]{1,80}$/;
const MAX_LAYERS = 200;

export function naipEnabled(env = process.env) {
  return String(env.GEV_BASEMAP_NAIP ?? '').trim() === '1';
}

const int = (v, lo, hi) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : null;

function bbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const b = value.map(Number);
  if (b.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, n] = b;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return b;
}

function acquired(raw) {
  const from = DATE.test(raw?.from ?? '') ? raw.from : null;
  const to = DATE.test(raw?.to ?? '') ? raw.to : null;
  return from || to ? { from, to } : null;
}

function creditText(value) {
  return typeof value === 'string' && CREDIT_TEXT.test(value.trim())
    ? value.trim()
    : null;
}

/** min/max zoom pair; maxzoom up to 22 (regional layers reach z20). */
function zooms(raw) {
  const minzoom = int(raw?.minzoom, 0, 22);
  const maxzoom = int(raw?.maxzoom, 0, 22);
  if (minzoom === null || maxzoom === null || maxzoom < minzoom) return null;
  return { minzoom, maxzoom };
}

/**
 * NAIP config.json -> { browser, routes }. `browser` is the `naip` block of
 * /basemap/config.json; `routes` maps statewide years and regional ids to
 * their upstream archive (and edge port) for the tile routes.
 * @param {unknown} raw
 * @param {{statewide?: boolean, regional?: boolean}} [have] which tile servers are configured
 */
export function composeNaip(raw, { statewide = true, regional = true } = {}) {
  const routes = { years: new Map(), regional: new Map() };
  const years = [];
  if (statewide)
    for (const entry of (Array.isArray(raw?.years) ? raw.years : []).slice(
      0,
      MAX_LAYERS,
    )) {
      if (entry?.status !== 'live') continue;
      const year = int(entry?.year, 1900, 2999);
      const z = zooms(entry);
      const bounds = bbox(entry?.bounds);
      const archive = String(entry?.archive ?? '');
      if (year === null || !z || !bounds || !archiveOk(archive)) continue;
      if (routes.years.has(year)) continue; // one statewide layer per year
      routes.years.set(year, { archive });
      years.push({
        year,
        url: `/basemap/naip/${year}/{z}/{x}/{y}.webp`,
        ...z,
        bounds,
        acquired: acquired(entry?.acquired),
      });
    }
  const layers = [];
  if (regional)
    for (const entry of (Array.isArray(raw?.regional)
      ? raw.regional
      : []
    ).slice(0, MAX_LAYERS)) {
      if (entry?.status !== 'live') continue;
      const id = String(entry?.id ?? '');
      const year = int(entry?.year, 1800, 2999);
      const z = zooms(entry);
      const bounds = bbox(entry?.bounds);
      const archive = String(entry?.archive ?? '');
      if (!ID.test(id) || year === null || !z || !bounds) continue;
      if (!archiveOk(archive) || routes.regional.has(id)) continue;
      const port = int(entry?.edge?.port, 1024, 65535);
      routes.regional.set(id, { archive, port });
      const grey = entry?.grayscale === true || entry?.greyscale === true;
      layers.push({
        id,
        year,
        name: creditText(entry?.name) ?? id,
        url: `/basemap/naip/regional/${id}/{z}/{x}/{y}.webp`,
        ...z,
        bounds,
        acquired: acquired(entry?.acquired),
        credit: creditText(entry?.credit?.text) ?? `TxGIO ${year}`,
        greyscale: grey,
      });
    }
  years.sort((a, b) => a.year - b.year);
  layers.sort((a, b) => a.year - b.year || (a.id < b.id ? -1 : 1));
  const defaultYear = int(raw?.default_year, 1800, 2999);
  const browser =
    years.length || layers.length
      ? {
          available: true,
          defaultYear,
          years,
          regional: layers,
        }
      : { available: false };
  return { browser, routes };
}

/** Upstream bases for a regional layer: the hires hosts, with its edge port. */
export function regionalBases(hiresUrls, port) {
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
 * Resolve a /basemap/naip/... path to {bases, path} with the composed
 * routes, or null when the year/id is not offered (404).
 * @param {string} pathname
 * @param {ReturnType<typeof composeNaip>['routes']} routes
 * @param {{naipUrls: string[], hiresUrls: string[]}} settings
 */
export function resolveNaipTile(pathname, routes, settings) {
  const statewide = NAIP_TILE_ROUTE.exec(pathname);
  if (statewide) {
    const [, year, z, x, y] = statewide;
    const route = routes?.years.get(Number(year));
    if (!route || !settings.naipUrls.length) return null;
    return {
      bases: settings.naipUrls,
      path: `/${route.archive}/${z}/${x}/${y}.webp`,
    };
  }
  const regional = NAIP_REGIONAL_ROUTE.exec(pathname);
  if (regional) {
    const [, id, z, x, y] = regional;
    const route = routes?.regional.get(id);
    if (!route || !settings.hiresUrls.length) return null;
    return {
      bases: regionalBases(settings.hiresUrls, route.port),
      path: `/${route.archive}/${z}/${x}/${y}.webp`,
    };
  }
  return null;
}
