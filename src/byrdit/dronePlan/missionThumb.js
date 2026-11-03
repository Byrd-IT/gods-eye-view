/**
 * The preview picture of a flight: the route on a satellite tile (when the
 * tile can be read) with the flight's code in big letters, so the picture in
 * a folder listing, in the zip and on the controller (when it is copied to
 * waypoint/map_preview/<UUID>/<UUID>.jpg) says which mission it is.
 *
 * 400 x 300 is the size DJI Fly and MavenBridge write for their own previews.
 * The drawing code takes a 2D context, so tests run it on a recording stub.
 */
export const THUMB_W = 400;
export const THUMB_H = 300;
const MIN_SPAN_M = 80;
const EARTH = 6378137;

const rad = (d) => (d * Math.PI) / 180;
const mercX = (lon) => EARTH * rad(lon);
const mercY = (lat) =>
  EARTH *
  Math.log(Math.tan(Math.PI / 4 + rad(Math.max(-85, Math.min(85, lat))) / 2));

/**
 * Fit points (and the takeoff) into the picture, in web mercator so a tile of
 * the same box lines up.
 * @param {{ lat: number, lon: number }[]} points
 * @returns {{ project: (p: {lat:number,lon:number}) => {x:number,y:number},
 *   bbox: number[] } | null} null when there is no usable point
 */
export function thumbFrame(points, w = THUMB_W, h = THUMB_H, margin = 0.14) {
  const pts = (points ?? []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
  );
  if (!pts.length) return null;
  const xs = pts.map((p) => mercX(p.lon));
  const ys = pts.map((p) => mercY(p.lat));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Mercator metres are bigger than ground metres by 1/cos(lat); the minimum
  // span is only there to keep a one-point plan from zooming to nothing.
  const scale = 1 / Math.cos(rad(pts[0].lat));
  let spanX = Math.max(maxX - minX, MIN_SPAN_M * scale);
  let spanY = Math.max(maxY - minY, MIN_SPAN_M * scale);
  spanX *= 1 + margin * 2;
  spanY *= 1 + margin * 2;
  // Same aspect as the picture.
  const aspect = w / h;
  if (spanX / spanY < aspect) spanX = spanY * aspect;
  else spanY = spanX / aspect;
  const x0 = cx - spanX / 2;
  const y1 = cy + spanY / 2;
  return {
    bbox: [x0, cy - spanY / 2, x0 + spanX, y1],
    project: (p) => ({
      x: ((mercX(p.lon) - x0) / spanX) * w,
      y: ((y1 - mercY(p.lat)) / spanY) * h,
    }),
  };
}

/** ArcGIS World Imagery picture of the frame (the tile source Mission-Installer also uses). */
export function tileUrl(frame, w = THUMB_W, h = THUMB_H) {
  const bbox = frame.bbox.map((n) => n.toFixed(2)).join(',');
  return `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${w},${h}&format=jpg&f=image`;
}

/**
 * Draw the picture. `tile` is an optional image already loaded by the caller.
 * @param {*} ctx a CanvasRenderingContext2D (or a stub with the same calls)
 * @param {{ code: string, title?: string, points: {lat:number,lon:number}[],
 *   takeoff?: {lat:number,lon:number}|null, tile?: any, w?: number, h?: number }} spec
 */
export function drawThumb(ctx, spec) {
  const w = spec.w ?? THUMB_W;
  const h = spec.h ?? THUMB_H;
  const frame = thumbFrame(
    [...(spec.points ?? []), ...(spec.takeoff ? [spec.takeoff] : [])],
    w,
    h,
  );
  ctx.fillStyle = '#1d2a22';
  ctx.fillRect(0, 0, w, h);
  if (spec.tile) ctx.drawImage(spec.tile, 0, 0, w, h);
  if (frame && spec.points?.length) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // A dark underlay so the route reads on bright imagery.
    for (const [color, width] of [
      ['rgba(0,0,0,0.65)', 5],
      ['#19e68c', 2.5],
    ]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      spec.points.forEach((p, i) => {
        const { x, y } = frame.project(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    if (spec.takeoff) {
      const { x, y } = frame.project(spec.takeoff);
      ctx.fillStyle = '#fcc419';
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('H', x, y + 1);
    }
  }
  // The label: big, in the corner, on a solid plate so it reads on any map.
  const plateH = spec.title ? 150 : 124;
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(0, 0, Math.min(w, 250), plateH);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const code = String(spec.code ?? '');
  const size = code.length <= 3 ? 104 : code.length <= 5 ? 72 : 54;
  ctx.font = `bold ${size}px sans-serif`;
  ctx.fillText(code, 12, 12 + size * 0.82);
  if (spec.title) {
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = '#9ff5c9';
    const name = String(spec.title).replace(/^M\d+(?:-\d+)?\s*/, '');
    ctx.fillText(name.slice(0, 24), 14, plateH - 12);
  }
  return { frame };
}

const loadImage = (src, { timeoutMs = 4000, create } = {}) =>
  new Promise((resolve) => {
    let img;
    try {
      img = create();
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.crossOrigin = 'anonymous';
    img.src = src;
  });

const toBytes = (canvas, type, quality) =>
  new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) =>
          blob
            ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
            : reject(new Error('no-blob')),
        type,
        quality,
      );
    } catch (error) {
      reject(error);
    }
  });

/**
 * Render the picture to JPEG bytes in a browser. The satellite tile is tried
 * first; when it cannot be loaded, or a tile from another site taints the
 * canvas so it cannot be read back, the picture is drawn again without it.
 * Never throws: it resolves null when no canvas is available.
 * @param {object} spec as drawThumb
 * @param {{ createCanvas?: () => any, createImage?: () => any,
 *   withTile?: boolean }} [deps] injectable for tests
 * @returns {Promise<{ bytes: Uint8Array, tile: boolean } | null>}
 */
export async function renderThumb(spec, deps = {}) {
  const w = spec.w ?? THUMB_W;
  const h = spec.h ?? THUMB_H;
  const createCanvas =
    deps.createCanvas ??
    (() => {
      const c = globalThis.document?.createElement?.('canvas');
      if (c) {
        c.width = w;
        c.height = h;
      }
      return c;
    });
  const createImage = deps.createImage ?? (() => new globalThis.Image());
  const attempt = async (tile) => {
    const canvas = createCanvas();
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return null;
    drawThumb(ctx, { ...spec, tile });
    return toBytes(canvas, 'image/jpeg', 0.86);
  };
  const frame = thumbFrame(
    [...(spec.points ?? []), ...(spec.takeoff ? [spec.takeoff] : [])],
    w,
    h,
  );
  if (frame && deps.withTile !== false) {
    const tile = await loadImage(tileUrl(frame, w, h), { create: createImage });
    if (tile) {
      try {
        const bytes = await attempt(tile);
        if (bytes) return { bytes, tile: true };
      } catch {
        // a tainted canvas cannot be read back: fall through to no tile
      }
    }
  }
  try {
    const bytes = await attempt(null);
    return bytes ? { bytes, tile: false } : null;
  } catch {
    return null;
  }
}
