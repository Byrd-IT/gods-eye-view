/**
 * Ground elevation under each waypoint, from the terrain the globe already
 * uses (no new network source). Heights are ellipsoidal (WGS84), the same
 * datum the globe renders. The planner and KMZ only compare them with each
 * other (relative to the takeoff point); the all-passes globe preview draws
 * orbit rings at groundM + aglM and relies on that shared datum.
 */
import { hasRealTerrain } from '../skyView/observer.js';

const CHUNK = 400;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('terrain timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ viewer: object, cesium: object, points: {lon:number,lat:number}[],
 *   takeoff: {lon:number,lat:number}, cache?: Map<string, number>,
 *   timeoutMs?: number }} args
 * @returns {Promise<{known: boolean, takeoffM: number, wpM: (number|null)[], missing?: number}>}
 *   `wpM[i]` is the ground height under `points[i]`, or null when the terrain
 *   gave none (counted in `missing`; the planner never invents a height for
 *   those silently). Never rejects: when terrain cannot be sampled at all it
 *   resolves `{ known: false }`.
 */
export async function sampleGround({
  viewer,
  cesium,
  points,
  takeoff,
  cache = new Map(),
  timeoutMs = 20000,
}) {
  const unknown = {
    known: false,
    takeoffM: 0,
    wpM: points.map(() => 0),
    missing: 0,
  };
  const provider =
    viewer?.terrainProvider ?? viewer?.scene?.globe?.terrainProvider;
  if (
    !cesium ||
    typeof cesium.sampleTerrainMostDetailed !== 'function' ||
    !hasRealTerrain(cesium, provider)
  ) {
    return unknown;
  }
  const key = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
  const wanted = new Map();
  for (const p of [takeoff, ...points]) {
    if (!cache.has(key(p))) wanted.set(key(p), p);
  }
  const sampleInto = async (entries) => {
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      const cartos = slice.map(([, p]) =>
        cesium.Cartographic.fromDegrees(p.lon, p.lat),
      );
      const sampled = await withTimeout(
        cesium.sampleTerrainMostDetailed(provider, cartos),
        timeoutMs,
      );
      slice.forEach(([k], j) => {
        const h = sampled?.[j]?.height;
        if (Number.isFinite(h)) cache.set(k, h);
      });
    }
  };
  try {
    await sampleInto([...wanted.entries()]);
    // A tile that failed to load leaves its points without a height: ask once
    // more for just those before giving up on them.
    const gaps = [...wanted.entries()].filter(([k]) => !cache.has(k));
    if (gaps.length) await sampleInto(gaps);
  } catch {
    return unknown;
  }
  const takeoffM = cache.get(key(takeoff));
  if (!Number.isFinite(takeoffM)) return unknown;
  const wpM = points.map((p) => {
    const h = cache.get(key(p));
    return Number.isFinite(h) ? h : null;
  });
  return {
    known: true,
    takeoffM,
    wpM,
    missing: wpM.filter((h) => h === null).length,
  };
}
