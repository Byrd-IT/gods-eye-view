/**
 * USGS earthquakes. The input is the USGS all_day summary GeoJSON.
 *
 * Nothing on the server sees this feed (the browser fetches USGS itself and
 * keeps doing so), so recording it takes a server-side poller: one extra
 * request to USGS every `pollMs`, started only when HISTORY_RECORD_QUAKES=1.
 * `optIn` keeps HISTORY_RECORD=1 from switching it on by accident.
 *
 * An event is revised over time, so a row is one version of an event: its key
 * is the USGS event id and its time is the version's `updated` stamp (the
 * origin time when USGS gives none). The same version seen in the next refresh
 * writes nothing new; a revision writes a new row.
 *
 * Only events the live layer shows are kept (magnitude 2.5 or more), and only
 * these fields; nothing else of the payload or the request is.
 */
export const feed = 'quakes';
export const source = 'USGS';
/** No handler to tee: the recorder's own poller fetches the feed. */
export const mode = 'poller';
export const upstreamUrl =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
/** USGS asks for at most one request a minute; five keeps the extra load small. */
export const pollMs = 300_000;
export const cadenceMs = pollMs;
/** Recorded only when HISTORY_RECORD_QUAKES=1; HISTORY_RECORD=1 alone does not start it. */
export const optIn = true;
export const fields = Object.freeze([
  'mag',
  'magType',
  'place',
  'depthKm',
  'time',
  'updated',
  'status',
]);

const MIN_MAGNITUDE = 2.5;

export function entityKey(eventId) {
  return String(eventId);
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** @returns {Array<{id: string, t: number, lat: number, lon: number, props: object}>} */
export function toRecords(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const records = [];
  for (const feature of features) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties;
    if (
      feature?.id == null ||
      feature.id === '' ||
      !Array.isArray(coordinates) ||
      !properties ||
      typeof properties !== 'object'
    )
      continue;
    const [lon, lat, depthKm] = coordinates;
    if (!finite(lon) || Math.abs(lon) > 180) continue;
    if (!finite(lat) || Math.abs(lat) > 90) continue;
    if (!finite(properties.mag) || properties.mag > 10) continue;
    if (properties.mag < MIN_MAGNITUDE) continue;
    const t = finite(properties.updated) ? properties.updated : properties.time;
    if (!finite(t)) continue;
    const props = {
      mag: properties.mag,
      depthKm: finite(depthKm) ? depthKm : null,
    };
    for (const name of ['magType', 'place', 'status'])
      if (typeof properties[name] === 'string') props[name] = properties[name];
    if (finite(properties.time)) props.time = properties.time;
    if (finite(properties.updated)) props.updated = properties.updated;
    records.push({ id: entityKey(feature.id), t, lat, lon, props });
  }
  return records;
}

export default {
  feed,
  source,
  mode,
  upstreamUrl,
  pollMs,
  cadenceMs,
  optIn,
  fields,
  entityKey,
  toRecords,
};
