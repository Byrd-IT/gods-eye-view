/**
 * Open-data first guesses for obstacle heights (browser side).
 *
 * Sources, all open: FAA Digital Obstacle File (towers), a 1 m tree canopy
 * height model from Meta and WRI (CC BY 4.0), and OpenStreetMap building
 * tags (through the footprints the panel already loads). Every call fails
 * soft: a source that cannot be read is reported and the plan carries on
 * with the plan-wide default height.
 *
 * Google's 3D tiles are NOT a source: their terms forbid reading heights or
 * other measurements from them in code. They only serve as a backdrop the
 * operator compares the drawn columns against by eye.
 */
import { areasBox } from './buildingFootprints.js';
import { MAX_OBSTACLES, normalizeObstacles } from './obstacles.js';

export const OBSTACLES_ENDPOINT = '/api/obstacles';
export const OBSTACLE_FETCH_TIMEOUT_MS = 30000;
/** Most requests one lookup makes per source. */
export const MAX_LOOKUP_BOXES = 4;
const BOX_DEG = 0.049;
const M_PER_DEG_LAT = 111320;

/**
 * Split the planning area into at most MAX_LOOKUP_BOXES boxes of at most
 * 0.05 degrees (about 5 km), centred on the area. Bigger areas are looked up
 * around their centre only: the cap bounds cost; the status then says
 * `partial` so the panel can tell the operator.
 */
export function lookupBoxes(areas) {
  const box = areasBox(areas);
  if (!box) return [];
  const lon = (box.west + box.east) / 2;
  const lat = (box.south + box.north) / 2;
  const cols = Math.min(
    2,
    Math.max(1, Math.ceil((box.east - box.west) / BOX_DEG)),
  );
  const rows = Math.min(
    2,
    Math.max(1, Math.ceil((box.north - box.south) / BOX_DEG)),
  );
  const w = Math.min(box.east - box.west, cols * BOX_DEG);
  const h = Math.min(box.north - box.south, rows * BOX_DEG);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push({
        west: lon - w / 2 + (c * w) / cols,
        east: lon - w / 2 + ((c + 1) * w) / cols,
        south: lat - h / 2 + (r * h) / rows,
        north: lat - h / 2 + ((r + 1) * h) / rows,
      });
    }
  }
  return out.slice(0, MAX_LOOKUP_BOXES);
}

const q = (v) => v.toFixed(6);

async function getJson(url, { fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response?.ok) throw new Error('unavailable');
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** One source over several boxes: obstacles found and how many boxes failed. */
async function fromSource(source, boxes, deps) {
  const settled = await Promise.allSettled(
    boxes.map((b) =>
      getJson(
        `${OBSTACLES_ENDPOINT}/${source}?west=${q(b.west)}&south=${q(b.south)}` +
          `&east=${q(b.east)}&north=${q(b.north)}`,
        deps,
      ),
    ),
  );
  const found = [];
  let failed = 0;
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value?.obstacles)) {
      failed += 1;
      continue;
    }
    if (r.value.partial) failed += 1;
    found.push(...r.value.obstacles);
  }
  return { found, failed, boxes: boxes.length };
}

/**
 * Towers and tree patches for the planning area. Resolves, never rejects.
 * @returns {Promise<{ obstacles: object[], status: Record<string, string> }>}
 *   status per source: 'ok' | 'none' | 'partial' | 'failed' | 'skipped'.
 */
export async function fetchOpenObstacles(
  areas,
  {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    timeoutMs = OBSTACLE_FETCH_TIMEOUT_MS,
    signal,
  } = {},
) {
  const boxes = lookupBoxes(areas);
  const status = { faa: 'skipped', canopy: 'skipped' };
  if (!boxes.length || typeof fetchImpl !== 'function') {
    return { obstacles: [], status };
  }
  const deps = { fetchImpl, timeoutMs, signal };
  const [faa, canopy] = await Promise.all([
    fromSource('faa', boxes, deps),
    fromSource('canopy', boxes, deps),
  ]);
  // Areas wider than the capped boxes are only read around their centre.
  const area = areasBox(areas);
  const covered =
    !area ||
    (Math.min(...boxes.map((b) => b.west)) <= area.west + 1e-9 &&
      Math.max(...boxes.map((b) => b.east)) >= area.east - 1e-9 &&
      Math.min(...boxes.map((b) => b.south)) <= area.south + 1e-9 &&
      Math.max(...boxes.map((b) => b.north)) >= area.north - 1e-9);
  const grade = (r) =>
    r.failed >= r.boxes
      ? 'failed'
      : r.failed || !covered
        ? 'partial'
        : r.found.length
          ? 'ok'
          : 'none';
  status.faa = grade(faa);
  status.canopy = grade(canopy);
  // Towers first: they are the rare, high-value ones when the cap bites.
  const obstacles = normalizeObstacles([...faa.found, ...canopy.found]).slice(
    0,
    MAX_OBSTACLES,
  );
  return { obstacles, status };
}

/**
 * OpenStreetMap buildings with a height tag as obstacles. A building with no
 * height tag is left out: guessing from levels is already done by the
 * footprint parser, and no data means the plan-wide default applies.
 */
export function buildingObstacles(footprints, max = 20) {
  const out = [];
  for (const fp of Array.isArray(footprints) ? footprints : []) {
    const h = Number(fp?.heightM);
    const ring = Array.isArray(fp?.ring) ? fp.ring : [];
    if (!Number.isFinite(h) || h <= 0 || ring.length < 3) continue;
    const lon = ring.reduce((s, p) => s + p.lon, 0) / ring.length;
    const lat = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const mLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    const radius = Math.max(
      ...ring.map((p) =>
        Math.hypot((p.lon - lon) * mLon, (p.lat - lat) * M_PER_DEG_LAT),
      ),
    );
    out.push({
      id: `osm-${String(fp.osmId ?? out.length).replace(/[^\w-]+/g, '-')}`,
      kind: 'building',
      source: 'osm',
      lon,
      lat,
      radiusM: radius,
      estimatedHeightM: h,
      heightM: h,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** The plain-language source names, for the panel list. */
export const SOURCE_NAMES = Object.freeze({
  faa: 'FAA obstacle file',
  canopy: 'Tree canopy model',
  lidar: 'Lidar',
  osm: 'OpenStreetMap',
  overture: 'Overture',
  user: 'You',
});
