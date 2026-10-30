/**
 * Building footprints for the Drone Flight Plan's orbit targets, read from
 * OpenStreetMap through GEV's own Overpass proxy (`/api/overpass`).
 *
 * The provider is what the panel's `getBuildingFootprints` dependency expects:
 * `(areas) => Promise<Array<{ ring, label, heightM, osmId }>>`. It fails soft:
 * on a timeout, HTTP error, partial answer or an unusable area it resolves
 * `[]` and records why in `provider.lastStatus`, so the planner falls back to
 * the area centre.
 *
 * OSM building data does NOT contain trees, towers, masts or power lines.
 */

export const OVERPASS_ENDPOINT = '/api/overpass';
/** The proxy caps `[timeout:]` at 30 s; ask for less so we give up first. */
export const OVERPASS_QL_TIMEOUT_S = 20;
/** Browser-side give-up time for the whole request, milliseconds. */
export const OVERPASS_FETCH_TIMEOUT_MS = 25000;
/** Most elements one query returns, so the answer stays small. */
export const OVERPASS_ELEMENT_LIMIT = 2000;
/** Most footprints handed to the planner (largest first). */
export const MAX_FOOTPRINTS = 300;
/** Metres per building level when only `building:levels` is tagged. */
export const LEVEL_HEIGHT_M = 3;
/** Areas wider than this (m) are not queried: a building lookup is for sites. */
export const MAX_QUERY_SPAN_M = 5000;

const M_PER_DEG_LAT = 111320;

/** Union bbox (degrees) of panel areas, or null when none/invalid. */
export function areasBox(areas) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const area of areas ?? []) {
    const pts =
      area?.kind === 'polygon' && Array.isArray(area.ring)
        ? area.ring
        : area?.box
          ? [
              { lon: area.box.west, lat: area.box.south },
              { lon: area.box.east, lat: area.box.north },
            ]
          : [];
    if (area?.kind !== 'polygon' && area?.box && area.box.west > area.box.east)
      return null; // crosses the antimeridian: not supported
    for (const p of pts) {
      const lon = Number(p?.lon);
      const lat = Number(p?.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

/** Overpass QL for every building way and relation in a degrees box. */
export function buildingsQuery(box) {
  const bbox = [box.south, box.west, box.north, box.east]
    .map((v) => Number(v).toFixed(6))
    .join(',');
  return (
    `[out:json][timeout:${OVERPASS_QL_TIMEOUT_S}];` +
    `(way["building"](${bbox});relation["building"](${bbox}););` +
    `out tags geom ${OVERPASS_ELEMENT_LIMIT};`
  );
}

/** `12`, `12.5 m`, `40'` -> metres, else null. */
export function parseHeightM(value) {
  if (value == null) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?|ft|feet|')?$/.exec(
    String(value).trim().toLowerCase(),
  );
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return m[2] === 'ft' || m[2] === 'feet' || m[2] === "'" ? n * 0.3048 : n;
}

/** Building height from its tags (`height`, else levels x 3 m), or null. */
export function buildingHeightM(tags = {}) {
  const tagged = parseHeightM(tags.height);
  if (tagged != null && tagged > 0) return tagged;
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return levels * LEVEL_HEIGHT_M;
  return null;
}

function toRing(geometry) {
  const pts = (geometry ?? [])
    .map((g) => ({ lon: Number(g?.lon), lat: Number(g?.lat) }))
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a.lon === b.lon && a.lat === b.lat) pts.pop();
  }
  return pts.length >= 3 ? pts : null;
}

function elementRings(element) {
  if (element.type === 'way') {
    const ring = toRing(element.geometry);
    return ring ? [ring] : [];
  }
  // Multipolygon: each closed outer way is a footprint; outers OSM splits over
  // several unclosed ways are skipped rather than guessed.
  return (element.members ?? [])
    .filter((m) => m?.type === 'way' && m.role === 'outer')
    .filter((m) => {
      const g = m.geometry ?? [];
      return (
        g.length >= 4 &&
        g[0].lon === g[g.length - 1].lon &&
        g[0].lat === g[g.length - 1].lat
      );
    })
    .map((m) => toRing(m.geometry))
    .filter(Boolean);
}

function ringAreaM2(ring) {
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  let a2 = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a2 +=
      p.lon * kx * (q.lat * M_PER_DEG_LAT) -
      q.lon * kx * (p.lat * M_PER_DEG_LAT);
  }
  return Math.abs(a2) / 2;
}

/**
 * Footprints of an Overpass answer, in the shape recommendOrbitTargets reads:
 * `{ ring: [{lon,lat}], label, heightM|null, osmId }`. Duplicate OSM ids are
 * dropped; the biggest `max` footprints are kept.
 */
export function parseBuildings(payload, { max = MAX_FOOTPRINTS } = {}) {
  const seen = new Set();
  const out = [];
  for (const element of payload?.elements ?? []) {
    if (!element || (element.type !== 'way' && element.type !== 'relation'))
      continue;
    const tags = element.tags ?? {};
    if (!tags.building || tags.building === 'no') continue;
    const rings = elementRings(element);
    rings.forEach((ring, i) => {
      const base = `${element.type}-${element.id}`;
      const osmId = rings.length > 1 ? `${base}-${i + 1}` : base;
      if (seen.has(osmId)) return;
      seen.add(osmId);
      out.push({
        ring,
        label: typeof tags.name === 'string' ? tags.name.slice(0, 60) : '',
        heightM: buildingHeightM(tags),
        osmId,
        _area: ringAreaM2(ring),
      });
    });
  }
  out.sort((a, b) => b._area - a._area || a.osmId.localeCompare(b.osmId));
  return out.slice(0, max).map(({ _area, ...fp }) => fp);
}

/** Reads the Overpass answer for a box; rejects with a short reason. */
export async function fetchBuildings(
  box,
  { fetchImpl = globalThis.fetch, timeoutMs = OVERPASS_FETCH_TIMEOUT_MS } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(buildingsQuery(box))}`,
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(
        response?.status === 429
          ? 'rate-limited'
          : response?.status === 504
            ? 'timeout'
            : 'unavailable',
      );
    }
    const payload = await response.json();
    // A partial answer (runtime error / timeout remark) must not read as
    // "no buildings here".
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error('incomplete');
    }
    return payload;
  } catch (err) {
    if (controller.signal.aborted) throw new Error('timeout');
    throw err instanceof Error ? err : new Error('unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the panel's `getBuildingFootprints` dependency.
 * `provider.lastStatus` is `{ ok, reason, count }` after each call.
 */
export function createBuildingFootprintProvider({
  fetchImpl,
  timeoutMs = OVERPASS_FETCH_TIMEOUT_MS,
} = {}) {
  async function provider(areas) {
    const set = (ok, reason, count = 0) => {
      provider.lastStatus = { ok, reason, count };
    };
    const box = areasBox(areas);
    if (!box) {
      set(false, 'no-area');
      return [];
    }
    const midLat = (box.south + box.north) / 2;
    const spanM = Math.max(
      (box.east - box.west) *
        M_PER_DEG_LAT *
        Math.cos((midLat * Math.PI) / 180),
      (box.north - box.south) * M_PER_DEG_LAT,
    );
    if (spanM > MAX_QUERY_SPAN_M) {
      set(false, 'area-too-large');
      return [];
    }
    try {
      const payload = await fetchBuildings(box, {
        fetchImpl: fetchImpl ?? globalThis.fetch?.bind(globalThis),
        timeoutMs,
      });
      const found = parseBuildings(payload);
      set(true, found.length ? 'ok' : 'none', found.length);
      return found;
    } catch (err) {
      set(false, err?.message || 'unavailable');
      return [];
    }
  }
  provider.lastStatus = null;
  return provider;
}
