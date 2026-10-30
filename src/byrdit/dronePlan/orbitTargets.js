/**
 * Orbit targets for the Drone Flight Plan: which structures inside the survey
 * to circle. Pure functions (no Cesium, no DOM).
 *
 * A target is `{ id, lon, lat, label, source, active, heightM }`. Sources:
 *   'building'  - centre of a building footprint inside an area; also carries
 *                 `radiusM` (sized to the footprint), `roofHeightM` and `heightM`
 *                 (the aim height, half the roof) when the height is known
 *   'area'      - the centre of an area that holds no footprint (fallback)
 *   'custom'    - a point the user clicked on the map
 */
import { deltaLon, makeFrame, wrapLon } from './geo.js';
import { pointInRing } from './polygon.js';
import { MAX_ORBIT_TARGETS } from './planner.js';

/** Footprints smaller than this (m^2) are sheds and noise, not orbit subjects. */
export const MIN_FOOTPRINT_M2 = 30;
/** Recommend at most this many buildings per plan. */
export const MAX_RECOMMENDED = 5;
/** Orbit radius = farthest footprint corner + max(MIN_MARGIN_M, MARGIN_FRACTION * size). */
export const MIN_MARGIN_M = 10;
export const MARGIN_FRACTION = 0.5;
export const MIN_RADIUS_M = 10;
export const MAX_RADIUS_M = 300;
/** Building orbits whose centres are closer than this x (r1 + r2) merge... */
export const MERGE_FACTOR = 0.6;
/** ...unless the merged orbit would be wider than this, metres. */
export const MERGE_MAX_RADIUS_M = 80;
/** The camera aims at this fraction of the roof height (min MIN_AIM_M). */
export const AIM_FRACTION = 0.5;
export const MIN_AIM_M = 2;
const round1 = (v) => Math.round(v * 10) / 10;

function ringOf(area) {
  if (area.kind === 'polygon') return area.ring;
  const b = area.box;
  return [
    { lon: b.west, lat: b.south },
    { lon: b.east, lat: b.south },
    { lon: b.east, lat: b.north },
    { lon: b.west, lat: b.north },
  ];
}

function normalizeFootprint(raw) {
  const ring = (raw?.ring ?? raw?.coordinates ?? raw)
    ?.map?.((p) =>
      Array.isArray(p)
        ? { lon: Number(p[0]), lat: Number(p[1]) }
        : { lon: Number(p?.lon), lat: Number(p?.lat) },
    )
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (!ring || ring.length < 3) return null;
  const heightM = Number(raw.heightM);
  return {
    ring,
    label: typeof raw.label === 'string' ? raw.label : '',
    heightM:
      raw.heightM != null && Number.isFinite(heightM) && heightM > 0
        ? heightM
        : null,
    osmId: typeof raw.osmId === 'string' ? raw.osmId : undefined,
  };
}

/** Farthest-corner distance from the centroid and longest side, metres. */
export function footprintReach(ring) {
  const st = footprintStats(ring);
  const frame = makeFrame(st.lon, st.lat);
  const xy = ring.map((p) => frame.toXY(p.lon, p.lat));
  const xs = xy.map((p) => p.x);
  const ys = xy.map((p) => p.y);
  return {
    farM: Math.max(...xy.map((p) => Math.hypot(p.x, p.y))),
    sizeM: Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    ),
  };
}

/** Orbit radius for a footprint: farthest corner plus a margin, 10-300 m. */
export function orbitRadiusFor({ farM, sizeM }) {
  const margin = Math.max(MIN_MARGIN_M, MARGIN_FRACTION * sizeM);
  return Math.min(
    MAX_RADIUS_M,
    Math.max(MIN_RADIUS_M, Math.ceil(farM + margin)),
  );
}

/** Aim height (m above ground) for a roof height; null when the roof is unknown. */
export function aimHeightFor(roofM) {
  if (roofM == null) return null;
  return round1(Math.min(100, Math.max(MIN_AIM_M, roofM * AIM_FRACTION)));
}

function centreGapM(a, b) {
  const frame = makeFrame(a.lon, a.lat);
  const p = frame.toXY(b.lon, b.lat);
  return Math.hypot(p.x, p.y);
}

function mergePair(a, b) {
  const wa = a.areaM2 || 1;
  const wb = b.areaM2 || 1;
  const frame = makeFrame(a.lon, a.lat);
  const pb = frame.toXY(b.lon, b.lat);
  const ll = frame.toLonLat((pb.x * wb) / (wa + wb), (pb.y * wb) / (wa + wb));
  const f2 = makeFrame(ll.lon, ll.lat);
  const reach = (t) => {
    const p = f2.toXY(t.lon, t.lat);
    return Math.hypot(p.x, p.y) + t.radiusM;
  };
  const radiusM = Math.ceil(Math.max(reach(a), reach(b)));
  if (radiusM > MERGE_MAX_RADIUS_M) return null;
  const roofs = [a.roofHeightM, b.roofHeightM].filter((h) => h != null);
  const roofHeightM = roofs.length ? Math.max(...roofs) : null;
  return {
    ...a,
    lon: ll.lon,
    lat: ll.lat,
    radiusM: Math.max(MIN_RADIUS_M, radiusM),
    roofHeightM,
    areaM2: a.areaM2 + b.areaM2,
    sizeM: Math.max(a.sizeM, b.sizeM, radiusM * 2),
    merged: (a.merged ?? 1) + (b.merged ?? 1),
  };
}

/**
 * Merge building orbits that overlap (centres closer than MERGE_FACTOR x the
 * sum of radii) when the merged orbit stays within MERGE_MAX_RADIUS_M. Largest
 * footprints first, so the result does not depend on input order.
 */
export function mergeOverlapping(list) {
  const byArea = (a, b) =>
    b.areaM2 - a.areaM2 || String(a.osmId).localeCompare(String(b.osmId));
  let out = [...list].sort(byArea);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i];
        const b = out[j];
        if (a.areaId !== b.areaId) continue;
        if (centreGapM(a, b) >= MERGE_FACTOR * (a.radiusM + b.radiusM))
          continue;
        const merged = mergePair(a, b);
        if (!merged) continue;
        out = out.filter((_, k) => k !== i && k !== j);
        out.push(merged);
        out.sort(byArea);
        changed = true;
        break outer;
      }
    }
  }
  return out;
}

/** Area (m^2) and centroid (lon/lat) of a footprint ring. */
export function footprintStats(ring) {
  const lon0 = ring[0].lon;
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const frame = makeFrame(lon0, lat0);
  const pts = ring.map((p) => frame.toXY(p.lon, p.lat));
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a2) < 1e-9) {
    const mean = pts.reduce(
      (m, p) => ({ x: m.x + p.x / pts.length, y: m.y + p.y / pts.length }),
      { x: 0, y: 0 },
    );
    return { areaM2: 0, ...frame.toLonLat(mean.x, mean.y) };
  }
  const ll = frame.toLonLat(cx / (3 * a2), cy / (3 * a2));
  return { areaM2: Math.abs(a2) / 2, lon: ll.lon, lat: ll.lat };
}

/** Centre of an area: the middle of a box, the centroid of a polygon. */
export function areaCenter(area) {
  if (area.kind !== 'polygon') {
    const b = area.box;
    const span = deltaLon(b.west, b.east);
    return {
      lon: wrapLon(b.west + (span < 0 ? span + 360 : span) / 2),
      lat: (b.south + b.north) / 2,
    };
  }
  const { lon, lat } = footprintStats(area.ring);
  return { lon, lat };
}

function inside(area, lon, lat) {
  const ring = ringOf(area);
  const frame = makeFrame(ring[0].lon, ring[0].lat);
  return pointInRing(
    frame.toXY(lon, lat),
    ring.map((p) => frame.toXY(p.lon, p.lat)),
  );
}

/**
 * Recommend orbit targets inside the survey areas.
 * @param {Array<object>} areas Panel areas (`rect` with `box`, `polygon` with `ring`).
 * @param {{ footprints?: Array<object>, max?: number }} [opts] `footprints` are
 *   building outlines as rings of `{lon, lat}` or `[lon, lat]`, optionally with
 *   `heightM`, `label`, `osmId`; each is sized (radius, aim and roof height),
 *   overlapping ones merge, and the biggest inside the areas win. An area
 *   holding none gets its centre.
 * @returns {Array<object>} Targets, building targets first (largest first).
 */
export function recommendOrbitTargets(areas, { footprints = [], max } = {}) {
  const list = Array.isArray(areas) ? areas : [];
  if (!list.length) return [];
  const cap = Math.min(max ?? MAX_RECOMMENDED, MAX_ORBIT_TARGETS);
  const found = [];
  for (const raw of footprints ?? []) {
    const fp = normalizeFootprint(raw);
    if (!fp) continue;
    const st = footprintStats(fp.ring);
    if (!(st.areaM2 >= MIN_FOOTPRINT_M2)) continue;
    const owner = list.find((area) => inside(area, st.lon, st.lat));
    if (!owner) continue;
    const reach = footprintReach(fp.ring);
    found.push({
      ...st,
      ...reach,
      areaId: owner.id,
      label: fp.label,
      osmId: fp.osmId,
      radiusM: orbitRadiusFor(reach),
      roofHeightM: fp.heightM,
    });
  }
  const sized = mergeOverlapping(found);
  const targets = sized.slice(0, cap).map((f, i) => ({
    id: `rec-${i + 1}`,
    lon: f.lon,
    lat: f.lat,
    label: f.label || `Building ${i + 1}`,
    source: 'building',
    active: true,
    // The aim height; null (unknown roof) leaves the plan's target height.
    heightM: aimHeightFor(f.roofHeightM),
    roofHeightM: f.roofHeightM,
    radiusM: f.radiusM,
    areaId: f.areaId,
    areaM2: Math.round(f.areaM2),
    ...(f.osmId ? { osmId: f.osmId } : {}),
  }));
  const covered = new Set(targets.map((t) => t.areaId));
  for (const area of list) {
    if (covered.has(area.id) || targets.length >= cap) continue;
    const c = areaCenter(area);
    targets.push({
      id: `rec-${targets.length + 1}`,
      lon: c.lon,
      lat: c.lat,
      label: list.length > 1 ? `${area.name ?? area.id} centre` : 'Area centre',
      source: 'area',
      active: true,
      heightM: null,
      areaId: area.id,
    });
  }
  return targets;
}

/** True when a click lies inside one of the areas. */
export function targetInsideAreas(areas, lon, lat) {
  return (areas ?? []).some((area) => inside(area, lon, lat));
}
