/**
 * Transit vehicles from /api/transit/vehicles/<feedId>: the proxy's decoded
 * GTFS-Realtime VehiclePositions snapshot for one operator,
 * { feedId, fetchedAt, feedTimestamp, vehicles: [{ id, lat, lon, bearing,
 * speedMps, timestamp, timestampSource, routeId, tripId, directionId, label,
 * stopId, status, occupancy }, ...] }.
 *
 * Each operator is its own route and its own poll; the vehicle's identity is
 * the operator plus the operator's own vehicle id, since two operators can use
 * the same id. A fix is timed by the operator's timestamp (the vehicle's own,
 * else the feed header's); when the operator gave neither, the proxy had only
 * its fetch time, and that is what is stored, labelled in `timeSource`.
 *
 * Heavy: 16 operators, each polled by the browser every 15 s while the layer
 * is on, so it records only when HISTORY_RECORD_TRANSIT=1 names it. The
 * proxy's own 15-minute MBTA trail stays as it is; this is the durable copy.
 */
import { isPlausibleVehiclePosition } from '../../../../src/data/gtfsRealtime.js';

export const feed = 'transit';
export const source = 'GTFS-Realtime vehicle positions (operator feeds)';
export const mode = 'view-driven';
// How long an unchanged vehicle goes before it is written again; a moving one
// is written on every poll.
export const cadenceMs = 60_000;
export const defaultOn = false;
export const fields = Object.freeze([
  'routeId',
  'tripId',
  'directionId',
  'label',
  'stopId',
  'status',
  'occupancy',
  'bearingDeg',
  'speedMps',
  'timeSource',
]);

const TIME_SOURCES = new Set(['vehicle', 'header', 'fetch']);
const FEED_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 64) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

export function entityKey(feedId, vehicleId) {
  return `${feedId.toLowerCase()}:${vehicleId}`;
}

/** @returns {Array<{id: string, t: number, lat: number, lon: number, props: object}>} */
export function toRecords(payload) {
  const feedId = text(payload?.feedId, 48);
  if (!feedId || !FEED_ID.test(feedId)) return [];
  const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];
  const fetchedMs = num(payload.fetchedAt);
  const records = [];
  for (const vehicle of vehicles) {
    const id = text(vehicle?.id, 128);
    if (!id) continue;
    const lat = num(vehicle.lat);
    const lon = num(vehicle.lon);
    if (lat === null || lon === null || !isPlausibleVehiclePosition(lat, lon))
      continue;
    const timeSource = TIME_SOURCES.has(vehicle.timestampSource)
      ? vehicle.timestampSource
      : null;
    const reportedS = num(vehicle.timestamp);
    const t =
      timeSource === 'fetch' && fetchedMs !== null
        ? Math.round(fetchedMs)
        : reportedS !== null && reportedS > 0
          ? Math.round(reportedS * 1000)
          : fetchedMs;
    if (t === null || !(t > 0)) continue;
    const props = {
      routeId: text(vehicle.routeId),
      tripId: text(vehicle.tripId, 128),
      directionId: Number.isInteger(vehicle.directionId)
        ? vehicle.directionId
        : null,
      label: text(vehicle.label),
      stopId: text(vehicle.stopId),
      status: text(vehicle.status, 32),
      occupancy: text(vehicle.occupancy, 32),
      bearingDeg: num(vehicle.bearing),
      speedMps: num(vehicle.speedMps),
      timeSource,
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    records.push({ id: entityKey(feedId, id), t, lat, lon, props });
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
