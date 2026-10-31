/**
 * Wildfire perimeters from /api/fire-perimeters (NIFC WFIGS current perimeters):
 * { fetchedAt, rows: [{ stableId, name, acres, containedPct, state, category,
 *   discoveredTime, updatedTime, cause, behavior, personnel, county, costToDate,
 *   complexity, complexName, polygons }] }.
 *
 * A perimeter changes shape instead of moving, so it is keyed by the incident id
 * and timed by the agency's own update time (an unchanged perimeter served again
 * on the next poll is the same observation). The polygon itself is NOT stored:
 * one fire can be tens of thousands of vertices (the store caps a row at 64 KiB)
 * and a season holds thousands of them. The row keeps the size, containment and
 * dates, plus the bounding box and the vertex count, which is enough to place
 * the fire and to see it grow. Position is the centre of that box.
 */
export const feed = 'perimeters';
export const source = 'NIFC WFIGS';
export const mode = 'server-polled';
export const cadenceMs = 300_000;
export const fields = Object.freeze([
  'name',
  'acres',
  'containedPct',
  'state',
  'category',
  'discoveredAt',
  'cause',
  'behavior',
  'personnel',
  'county',
  'costToDate',
  'complexity',
  'complexName',
  'bbox',
  'polygonCount',
  'vertexCount',
]);

// WFIGS never holds a perimeter older than this; anything before is a bad stamp.
const EARLIEST_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 80) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};
const epoch = (value, ceiling) => {
  const ms = num(value);
  return ms !== null && ms >= EARLIEST_MS && ms <= ceiling
    ? Math.round(ms)
    : null;
};
const round4 = (value) => Math.round(value * 1e4) / 1e4;

export function entityKey(row) {
  return String(row.stableId).trim();
}

/** Bounding box of the outer rings, and how many polygons and vertices there are. */
export function measure(polygons) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let vertexCount = 0;
  let polygonCount = 0;
  if (!Array.isArray(polygons)) return null;
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !Array.isArray(rings[0])) continue;
    polygonCount += 1;
    for (const ring of rings) {
      if (Array.isArray(ring)) vertexCount += ring.length;
    }
    for (const position of rings[0]) {
      const lon = num(position?.[0]);
      const lat = num(position?.[1]);
      if (lon === null || lat === null) continue;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (!polygonCount || !Number.isFinite(west)) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  if (Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return { west, south, east, north, polygonCount, vertexCount };
}

export function toRecords(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const fetchedAt = epoch(payload?.fetchedAt, Number.MAX_SAFE_INTEGER);
  const records = [];
  for (const row of rows) {
    if (!row || typeof row.stableId !== 'string') continue;
    const id = row.stableId.trim();
    if (!id || id.length > 128) continue;
    const box = measure(row.polygons);
    if (!box) continue;
    const ceiling = (fetchedAt ?? Date.now()) + DAY_MS;
    const t = epoch(row.updatedTime, ceiling) ?? fetchedAt;
    if (t === null) continue;
    const discovered = epoch(row.discoveredTime, ceiling);
    const props = {
      name: text(row.name),
      acres: num(row.acres),
      containedPct: num(row.containedPct),
      state: text(row.state, 16),
      category: text(row.category, 32),
      discoveredAt: discovered === null ? null : discovered,
      cause: text(row.cause, 48),
      behavior: text(row.behavior, 64),
      personnel: num(row.personnel),
      county: text(row.county, 64),
      costToDate: num(row.costToDate),
      complexity: text(row.complexity, 32),
      complexName: text(row.complexName, 80),
      bbox: [
        round4(box.west),
        round4(box.south),
        round4(box.east),
        round4(box.north),
      ],
      polygonCount: box.polygonCount,
      vertexCount: box.vertexCount,
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    records.push({
      id,
      t,
      lat: round4((box.south + box.north) / 2),
      lon: round4((box.west + box.east) / 2),
      props,
    });
  }
  return records;
}

export default { feed, source, mode, cadenceMs, fields, entityKey, toRecords };
