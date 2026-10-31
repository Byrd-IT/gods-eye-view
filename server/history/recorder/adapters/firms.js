import { acquisitionMsUtc } from '../../../../src/data/firmsCsv.js';

/**
 * NASA FIRMS active fires. The input is the payload /api/firms returns
 * ({fetchedAt, stale, ttlMs, sources, count, fires}).
 *
 * A detection is one satellite pass over one place, so its key is instrument,
 * satellite and position (4 decimals, about 11 m) and its time is the
 * acquisition time. Seeing the same detection in the next refresh therefore
 * writes nothing new.
 *
 * Only these fields are kept; nothing else of the payload or the request is.
 */
export const feed = 'firms';
export const source = 'NASA FIRMS';
/** The handler refreshes only while a client asks for it, and at most every ttlMs. */
export const mode = 'view-driven';
export const cadenceMs = 30 * 60_000;
export const fields = Object.freeze([
  'frp',
  'confidence',
  'brightness',
  'brightnessTi5',
  'daynight',
  'satellite',
  'instrument',
]);

export function entityKey(fire) {
  return `${fire.instrument}:${fire.satellite}:${fire.lat.toFixed(4)}:${fire.lon.toFixed(4)}`;
}

/** @returns {Array<{id: string, t: number, lat: number, lon: number, props: object}>} */
export function toRecords(payload) {
  const fires = Array.isArray(payload?.fires) ? payload.fires : [];
  const records = [];
  // Detections share a few hundred acquisition minutes, so parse each once.
  const times = new Map();
  for (const fire of fires) {
    if (!fire || !Number.isFinite(fire.lat) || !Number.isFinite(fire.lon))
      continue;
    const stamp = `${fire.acqDate} ${fire.acqTime}`;
    let t = times.get(stamp);
    if (t === undefined) {
      t = acquisitionMsUtc(fire.acqDate, fire.acqTime);
      times.set(stamp, t);
    }
    if (!Number.isFinite(t)) continue;
    const props = {};
    for (const name of fields)
      if (fire[name] !== undefined) props[name] = fire[name];
    records.push({
      id: entityKey(fire),
      t,
      lat: fire.lat,
      lon: fire.lon,
      props,
    });
  }
  return records;
}

export default { feed, source, mode, cadenceMs, fields, entityKey, toRecords };
