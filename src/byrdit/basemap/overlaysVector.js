import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * Vector (MVT) overlay tiles drawn onto a 256 px canvas (BASEMAP M2).
 * Cesium has no vector tile layer, so each tile is decoded here and painted
 * as a transparent canvas that an imagery layer can fade with its alpha.
 *
 * Layers drawn (ids come from the M2 tiles; unknown ids are skipped):
 *   contours_minor / contours_major   3DEP contours, elev_ft label on majors
 *   bathy_contours / bathy_major      TWDB lake depth, depth_ft label on majors
 *   lake_pool                         the lake's pool outline
 */

export const TILE_SIZE = 256;

export const VECTOR_STYLES = Object.freeze({
  contours_minor: Object.freeze({
    order: 0,
    stroke: 'rgba(150, 100, 50, 0.7)',
    width: 0.7,
  }),
  bathy_contours: Object.freeze({
    order: 1,
    stroke: 'rgba(80, 160, 235, 0.85)',
    width: 0.8,
  }),
  contours_major: Object.freeze({
    order: 2,
    stroke: 'rgba(135, 78, 28, 0.95)',
    width: 1.5,
    label: (p) =>
      Number.isFinite(Number(p.elev_ft))
        ? `${Math.round(Number(p.elev_ft))}`
        : null,
  }),
  bathy_major: Object.freeze({
    order: 3,
    stroke: 'rgba(20, 105, 220, 0.95)',
    width: 1.5,
    label: (p) =>
      Number.isFinite(Number(p.depth_ft))
        ? `${Math.round(Number(p.depth_ft))} ft`
        : null,
  }),
  lake_pool: Object.freeze({
    order: 4,
    stroke: 'rgba(10, 50, 140, 0.95)',
    width: 1.8,
  }),
});

const MIN_LABEL_RING_PX = 90;
const MIN_LABEL_GAP_PX = 70;
const MAX_FEATURES = 60_000;

function ringLengthPx(ring, k) {
  let total = 0;
  for (let i = 1; i < ring.length; i++)
    total +=
      Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y) * k;
  return total;
}

/** Point halfway along the ring's length, in pixels. */
function midpoint(ring, k) {
  let left = ringLengthPx(ring, k) / 2;
  for (let i = 1; i < ring.length; i++) {
    const dx = (ring[i].x - ring[i - 1].x) * k;
    const dy = (ring[i].y - ring[i - 1].y) * k;
    const seg = Math.hypot(dx, dy);
    if (left <= seg && seg > 0) {
      const f = left / seg;
      return { x: ring[i - 1].x * k + dx * f, y: ring[i - 1].y * k + dy * f };
    }
    left -= seg;
  }
  const last = ring.at(-1);
  return { x: last.x * k, y: last.y * k };
}

/**
 * Paint one decoded tile (VectorTile-like: {layers: {id: {extent, length,
 * feature(i)}}}) onto a 2D context. Returns counts for tests.
 */
export function drawVectorTile(ctx, tile, { size = TILE_SIZE } = {}) {
  const drawn = { features: 0, labels: 0 };
  const placed = [];
  const ids = Object.keys(tile?.layers ?? {})
    .filter((id) => VECTOR_STYLES[id])
    .sort((a, b) => VECTOR_STYLES[a].order - VECTOR_STYLES[b].order);
  const labels = [];
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const id of ids) {
    const layer = tile.layers[id];
    const style = VECTOR_STYLES[id];
    const k = size / (layer.extent || 4096);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.width;
    for (let i = 0; i < layer.length; i++) {
      if (drawn.features >= MAX_FEATURES) return drawn;
      const feature = layer.feature(i);
      if (feature.type !== 2 && feature.type !== 3) continue;
      const rings = feature.loadGeometry();
      ctx.beginPath();
      for (const ring of rings) {
        ring.forEach((pt, j) =>
          j === 0
            ? ctx.moveTo(pt.x * k, pt.y * k)
            : ctx.lineTo(pt.x * k, pt.y * k),
        );
        if (feature.type === 3) ctx.closePath();
      }
      ctx.stroke();
      drawn.features += 1;
      const text = style.label?.(feature.properties ?? {});
      if (!text) continue;
      const ring = rings.reduce(
        (a, r) => (r.length > (a?.length ?? 0) ? r : a),
        null,
      );
      if (!ring || ring.length < 2 || ringLengthPx(ring, k) < MIN_LABEL_RING_PX)
        continue;
      const mid = midpoint(ring, k);
      labels.push({ text, x: mid.x, y: mid.y });
    }
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  for (const label of labels) {
    if (label.x < 8 || label.y < 8 || label.x > size - 8 || label.y > size - 8)
      continue;
    if (
      placed.some(
        (p) => Math.hypot(p.x - label.x, p.y - label.y) < MIN_LABEL_GAP_PX,
      )
    )
      continue;
    placed.push(label);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillStyle = '#1b2430';
    ctx.fillText(label.text, label.x, label.y);
    drawn.labels += 1;
  }
  return drawn;
}

async function gunzipIfNeeded(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode MVT bytes (gzip tolerated) to a VectorTile. */
export async function decodeMvt(buffer) {
  const bytes = await gunzipIfNeeded(new Uint8Array(buffer));
  return new VectorTile(new PbfReader(bytes));
}

function canvasTile(size = TILE_SIZE) {
  const doc = globalThis.document;
  if (!doc?.createElement) return undefined;
  const canvas = doc.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * Imagery provider for one vector overlay. Below minzoom no request is made;
 * a 204/404, network error or undecodable tile is a transparent tile.
 */
export function createVectorOverlayProvider(
  Cesium,
  entry,
  {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    decode = decodeMvt,
    makeCanvas = canvasTile,
  } = {},
) {
  let empty = null;
  const blank = () => (empty ??= makeCanvas());
  class VectorOverlayProvider extends Cesium.UrlTemplateImageryProvider {
    requestImage(x, y, level) {
      if (level < entry.minzoom || !fetchImpl) return Promise.resolve(blank());
      const url = entry.url
        .replace('{z}', String(level))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      return (async () => {
        try {
          const response = await fetchImpl(url, { credentials: 'same-origin' });
          if (response.status !== 200) return blank();
          const tile = await decode(await response.arrayBuffer());
          const canvas = makeCanvas();
          const ctx = canvas?.getContext?.('2d');
          if (!ctx) return blank();
          drawVectorTile(ctx, tile);
          return canvas;
        } catch {
          return blank();
        }
      })();
    }
  }
  const [w, s, e, n] = entry.bounds;
  return new VectorOverlayProvider({
    url: entry.url,
    rectangle: Cesium.Rectangle.fromDegrees(w, s, e, n),
    minimumLevel: 0,
    maximumLevel: entry.maxzoom,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    hasAlphaChannel: true,
  });
}
