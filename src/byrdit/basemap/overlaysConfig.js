/**
 * Browser validation of the `overlays` block of /basemap/config.json
 * (composed server-side by overlaysProxy.js). Pure, no imports, so config.js
 * (which the node-side proxy also loads) can use it.
 */

const URL_PATH =
  /^\/basemap\/overlay\/[a-z0-9][a-z0-9-]{0,31}\/\{z\}\/\{x\}\/\{y\}\.(?:webp|mvt)$/;
const TEXT = /^[A-Za-z0-9 /&+().,'-]{1,80}$/;
const VECTOR_LAYER_ID = /^[A-Za-z0-9_]{1,40}$/;
const int = (v, lo, hi) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : null;

function bounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    return null;
  const [w, s, e, n] = value;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return [w, s, e, n];
}

/** Missing or broken = {available: false}: no overlay panel is offered. */
export function normalizeOverlays(raw) {
  const layers = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw?.layers) ? raw.layers : []) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const kind = entry?.kind;
    const format = kind === 'raster' ? 'webp' : kind === 'vector' ? 'mvt' : '';
    const url =
      typeof entry?.url === 'string' && URL_PATH.test(entry.url)
        ? entry.url
        : null;
    const minzoom = int(entry?.minzoom, 0, 22);
    const maxzoom = int(entry?.maxzoom, 0, 22);
    const b = bounds(entry?.bounds);
    if (!id || seen.has(id) || !format || entry.format !== format) continue;
    if (!url || !url.startsWith(`/basemap/overlay/${id}/`)) continue;
    if (!url.endsWith(`.${format}`)) continue;
    if (minzoom === null || maxzoom === null || maxzoom < minzoom || !b)
      continue;
    seen.add(id);
    const opacity = entry.defaultOpacity;
    layers.push({
      id,
      key: `overlay-${id}`,
      name:
        typeof entry.name === 'string' && TEXT.test(entry.name)
          ? entry.name
          : id,
      kind,
      format,
      url,
      minzoom,
      maxzoom,
      bounds: b,
      defaultOpacity:
        typeof opacity === 'number' && opacity >= 0 && opacity <= 1
          ? opacity
          : 1,
      credit:
        typeof entry.credit === 'string' && TEXT.test(entry.credit)
          ? entry.credit
          : 'Byrd-IT',
      vectorLayers:
        kind === 'vector'
          ? (Array.isArray(entry.vectorLayers) ? entry.vectorLayers : [])
              .filter(
                (v) =>
                  VECTOR_LAYER_ID.test(v?.id ?? '') &&
                  int(v?.minzoom, 0, 22) !== null &&
                  int(v?.maxzoom, 0, 22) !== null,
              )
              .map((v) => ({
                id: v.id,
                minzoom: v.minzoom,
                maxzoom: v.maxzoom,
              }))
          : [],
    });
  }
  const available = raw?.available === true && layers.length > 0;
  return { available, layers: available ? layers : [] };
}
