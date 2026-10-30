/**
 * Orbit targets for the Drone Flight Plan: which structures inside the survey
 * to circle. Pure functions (no Cesium, no DOM).
 *
 * A target is `{ id, lon, lat, label, source, active, heightM }`. Sources:
 *   'building'  - centre of a building footprint inside an area
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
  return { ring, label: typeof raw.label === 'string' ? raw.label : '' };
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
 *   building outlines as rings of `{lon, lat}` or `[lon, lat]`; the biggest
 *   ones inside the areas win. An area holding none gets its centre.
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
    found.push({ ...st, areaId: owner.id, label: fp.label });
  }
  found.sort((a, b) => b.areaM2 - a.areaM2);
  const targets = found.slice(0, cap).map((f, i) => ({
    id: `rec-${i + 1}`,
    lon: f.lon,
    lat: f.lat,
    label: f.label || `Building ${i + 1}`,
    source: 'building',
    active: true,
    heightM: null,
    areaId: f.areaId,
    areaM2: Math.round(f.areaM2),
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
