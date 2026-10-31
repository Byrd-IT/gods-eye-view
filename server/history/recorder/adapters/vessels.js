/**
 * Vessels from /api/vessels. The route serves a snapshot of the in-memory AIS
 * cache that the AISStream websocket fills (server/providers/vessels/):
 * { rows: [{ mmsi, name, imo, type, destination, lat, lon, speed, course,
 * heading, last_position_UTC, last_position_epoch }], status, lastMessageAt, ... }.
 *
 * The recorder reads that answer on its way out (the response tee) and never
 * opens an AISStream connection of its own: AISStream allows one connection per
 * key, and the live layer already holds it. The cache keeps one row per vessel,
 * so a snapshot is the latest fix of every vessel heard in the last 30 minutes.
 *
 * A vessel is its MMSI; a fix is timed by its own AIS report time, so a vessel
 * that has not reported since the last snapshot is the same observation again
 * and writes nothing. Heavy: a worldwide snapshot holds up to 50 000 vessels,
 * so it records only when HISTORY_RECORD_VESSELS=1 names it, never from
 * HISTORY_RECORD=1 alone. The minimum interval defaults to five minutes, so a
 * vessel at anchor is kept about every five minutes, not on every poll.
 */
export const feed = 'vessels';
export const source = 'AISStream';
export const mode = 'view-driven';
export const cadenceMs = 300_000;
export const defaultOn = false;
export const fields = Object.freeze([
  'name',
  'imo',
  'shipType',
  'destination',
  'speedKn',
  'courseDeg',
  'headingDeg',
]);

/** Feed states in which the snapshot holds nothing new: a poll that did not answer. */
export const NOT_LIVE = Object.freeze([
  'down',
  'auth-failed',
  'missing-key',
  'unsupported',
  'stale',
  'reconnecting',
  'connecting',
  'idle',
]);

const MMSI = /^\d{5,10}$/;

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 64) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

export function entityKey(row) {
  return String(row.mmsi).trim();
}

/** Position time of a row in ms: the epoch seconds, else the UTC string. */
function fixTimeMs(row) {
  const seconds = num(row.last_position_epoch);
  if (seconds !== null && seconds > 0) return Math.round(seconds * 1000);
  if (typeof row.last_position_UTC === 'string') {
    const parsed = Date.parse(row.last_position_UTC);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** @returns {Array<{id: string, t: number, lat: number, lon: number, props: object}>} */
export function toRecords(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const records = [];
  for (const row of rows) {
    if (!row || !MMSI.test(String(row.mmsi).trim())) continue;
    const lat = num(row.lat);
    const lon = num(row.lon);
    if (lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const t = fixTimeMs(row);
    if (t === null) continue;
    const id = entityKey(row);
    const name = text(row.name);
    const props = {
      // The cache names a vessel it knows nothing else about "MMSI <number>".
      name: name === `MMSI ${id}` ? null : name,
      imo: text(row.imo, 12),
      shipType: text(row.type, 12),
      destination: text(row.destination, 32),
      speedKn: num(row.speed),
      courseDeg: num(row.course),
      headingDeg: num(row.heading),
    };
    for (const key of Object.keys(props))
      if (props[key] === null) delete props[key];
    records.push({ id, t, lat, lon, props });
  }
  return records;
}

export default {
  feed,
  source,
  mode,
  cadenceMs,
  defaultOn,
  fields,
  entityKey,
  toRecords,
};
