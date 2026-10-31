/**
 * Tropical cyclones from /api/cyclones (NOAA NHC / CPHC current storms):
 * { fetchedAt, stale, unavailable, storms: [{ id, name, classification, basin,
 *   position: {latitude, longitude}, positionAt, advisoryNumber, issuedAt, windKt,
 *   pressureHpa, movement: {directionDegrees, speedKt}, forecastPoints: [...],
 *   track, cone, ... }] }.
 *
 * Keyed by the NHC storm id (al092026); timed by the storm's own position time,
 * so an advisory that repeats a position is not stored twice. The forecast
 * points are kept (a dozen small objects, so the forecast the storm had at each
 * advisory can be replayed); the track line and the cone polygon are not (the
 * cone alone can be 2 MiB, and it is redrawn from the points).
 */
export const feed = 'cyclones';
export const source = 'NOAA NHC / CPHC';
export const mode = 'server-polled';
export const cadenceMs = 300_000;
export const fields = Object.freeze([
  'name',
  'classification',
  'basin',
  'advisoryNumber',
  'issuedAt',
  'windKt',
  'pressureHpa',
  'directionDeg',
  'speedKt',
  'forecast',
]);

const MAX_FORECAST_POINTS = 12;
// The proxy takes forecast points from NOAA GIS layers that can lag the status
// feed by minutes. A storm answered before its forecast is attached is not
// recorded yet, because a row keyed by the advisory's position time would
// shadow the complete one that follows. If the forecast is still missing after
// this long, the storm is recorded without it.
export const FORECAST_GRACE_MS = 90 * 60_000;

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 80) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};
const instant = (value) => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const inRange = (lat, lon) =>
  lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export function entityKey(storm) {
  return String(storm.id).trim().toLowerCase();
}

function forecastOf(points) {
  if (!Array.isArray(points)) return [];
  const kept = [];
  for (const point of points) {
    const lat = num(point?.position?.latitude);
    const lon = num(point?.position?.longitude);
    const tau = num(point?.tauHours);
    if (!inRange(lat, lon) || tau === null) continue;
    const entry = { tauHours: tau, lat, lon };
    const wind = num(point.windKt);
    const gust = num(point.gustKt);
    if (wind !== null) entry.windKt = wind;
    if (gust !== null) entry.gustKt = gust;
    kept.push(entry);
    if (kept.length >= MAX_FORECAST_POINTS) break;
  }
  return kept;
}

export function toRecords(payload) {
  const list = Array.isArray(payload?.storms) ? payload.storms : [];
  const fetchedAt = num(payload?.fetchedAt);
  const records = [];
  for (const storm of list) {
    if (!storm || !/^(?:al|ep|cp)\d{6}$/i.test(String(storm.id))) continue;
    const lat = num(storm.position?.latitude);
    const lon = num(storm.position?.longitude);
    if (!inRange(lat, lon)) continue;
    const t = instant(storm.positionAt) ?? instant(storm.issuedAt);
    if (t === null) continue;
    const forecast = forecastOf(storm.forecastPoints);
    if (!forecast.length) {
      const issued = instant(storm.issuedAt) ?? t;
      // No fetch time to measure against, or still inside the grace period: wait.
      if (fetchedAt === null || fetchedAt - issued < FORECAST_GRACE_MS)
        continue;
    }
    const props = {
      name: text(storm.name),
      classification: text(storm.classification, 16),
      basin: text(storm.basin, 4),
      advisoryNumber: text(storm.advisoryNumber, 8),
      issuedAt: text(storm.issuedAt, 32),
      windKt: num(storm.windKt),
      pressureHpa: num(storm.pressureHpa),
      directionDeg: num(storm.movement?.directionDegrees),
      speedKt: num(storm.movement?.speedKt),
      forecast: forecast.length ? forecast : null,
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    records.push({ id: entityKey(storm), t, lat, lon, props });
  }
  return records;
}

export default { feed, source, mode, cadenceMs, fields, entityKey, toRecords };
