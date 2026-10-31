/**
 * Rocket launches from /api/launches (Launch Library 2, recent 30 days, detailed):
 * { results: [{ id, name, status, net, window_start, window_end, last_updated,
 *   launch_service_provider, rocket, mission, pad, probability, webcast_live, ... }] }.
 *
 * The route hands over { fetchedAt, results } (see routes.js). Keyed by the LL2
 * launch id and timed by LL2's own `last_updated`, so a launch whose details did
 * not change is not stored again, and a slip of the launch time is a new row.
 * The mission description, the stage and payload lists, the trajectory and the
 * timeline are left out; they are large and change rarely.
 */
export const feed = 'launches';
export const source = 'Launch Library 2';
export const mode = 'server-polled';
export const cadenceMs = 900_000;
export const fields = Object.freeze([
  'name',
  'status',
  'statusId',
  'net',
  'windowStart',
  'windowEnd',
  'provider',
  'rocket',
  'mission',
  'missionType',
  'orbit',
  'padName',
  'location',
  'probability',
  'webcastLive',
]);

const num = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const text = (value, max = 120) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};
const instant = (value) => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const isoOrNull = (value) => {
  const ms = instant(value);
  return ms === null ? null : new Date(ms).toISOString();
};

export function entityKey(launch) {
  return String(launch.id).trim();
}

export function toRecords(payload) {
  const list = Array.isArray(payload?.results) ? payload.results : [];
  const fetchedAt = num(payload?.fetchedAt);
  const records = [];
  for (const launch of list) {
    if (!launch || typeof launch !== 'object') continue;
    const id = text(launch.id, 128);
    if (!id) continue;
    const t =
      instant(launch.last_updated) ??
      (fetchedAt !== null && fetchedAt > 0 ? Math.round(fetchedAt) : null);
    if (t === null) continue;
    const pad = launch.pad && typeof launch.pad === 'object' ? launch.pad : {};
    const lat = num(pad.latitude);
    const lon = num(pad.longitude);
    const placed =
      lat !== null &&
      lon !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;
    const configuration = launch.rocket?.configuration;
    const props = {
      name: text(launch.name),
      status: text(launch.status?.name, 48),
      statusId: num(launch.status?.id),
      net: isoOrNull(launch.net),
      windowStart: isoOrNull(launch.window_start),
      windowEnd: isoOrNull(launch.window_end),
      provider: text(launch.launch_service_provider?.name),
      rocket: text(configuration?.full_name) ?? text(configuration?.name),
      mission: text(launch.mission?.name),
      missionType: text(launch.mission?.type, 48),
      orbit: text(launch.mission?.orbit?.abbrev, 16),
      padName: text(pad.name),
      location: text(pad.location?.name),
      probability: num(launch.probability),
      webcastLive:
        typeof launch.webcast_live === 'boolean' ? launch.webcast_live : null,
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    records.push({
      id,
      t,
      lat: placed ? lat : null,
      lon: placed ? lon : null,
      props,
    });
  }
  return records;
}

export default { feed, source, mode, cadenceMs, fields, entityKey, toRecords };
