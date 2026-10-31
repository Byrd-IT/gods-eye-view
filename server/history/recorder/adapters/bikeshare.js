/**
 * Bikeshare station availability from /api/gbfs/<station_status URL>: a GBFS
 * station_status answer, { last_updated, data: { stations: [{ station_id,
 * num_bikes_available, num_ebikes_available, num_docks_available,
 * num_bikes_disabled, num_docks_disabled, is_installed, is_renting,
 * is_returning, last_reported, ... }] } }.
 *
 * A station_status answer has no positions. The tee watches the same system's
 * station_information answer as an `observe` route and learns the positions
 * from it (the station directory below); the status route joins them in before
 * the adapter sees the answer. A station whose position has not been seen yet
 * (the server restarted while the browser still holds station_information in
 * its own cache) is recorded without a position rather than lost.
 *
 * A station is its system (operator host and path) plus its station_id; a
 * reading is timed by the station's own last_reported, else the answer's
 * last_updated. Many systems each report every station every minute, so it is
 * heavy and records only when HISTORY_RECORD_BIKESHARE=1 names it; an
 * unchanged station is not written again inside the minimum interval.
 */
export const feed = 'bikeshare';
export const source = 'GBFS station_status (bikeshare operators)';
export const mode = 'view-driven';
export const cadenceMs = 60_000;
export const defaultOn = false;
export const fields = Object.freeze([
  'name',
  'capacity',
  'bikesAvailable',
  'ebikesAvailable',
  'docksAvailable',
  'bikesDisabled',
  'docksDisabled',
  'installed',
  'renting',
  'returning',
]);

export const MAX_SYSTEMS = 64;
export const MAX_STATIONS_PER_SYSTEM = 20_000;
const MAX_SYSTEM_KEY = 160;
const MAX_STATION_ID = 64;

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = (value) => {
  const n = num(value);
  return n !== null && n >= 0 && n <= 100_000 ? n : null;
};
const text = (value, max = 80) => {
  if (typeof value === 'number' && Number.isFinite(value))
    value = String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};
// GBFS 1.x writes these flags as 0/1, 2.x as booleans.
const flag = (value) =>
  value === true || value === 1
    ? true
    : value === false || value === 0
      ? false
      : null;

/** A system's identity: operator host and the path that holds its feeds (no query, no credentials). */
export function systemKeyOf(hostname, pathname) {
  const key = `${hostname}${pathname}`
    .replace(/\/station_(information|status)(\.json)?$/i, '')
    .toLowerCase();
  return key.length > 0 && key.length <= MAX_SYSTEM_KEY ? key : null;
}

export function entityKey(system, stationId) {
  return `${system}#${stationId}`;
}

/**
 * What each system's station_information has said about its stations, bounded
 * in systems (least recently used goes first) and in stations per system.
 */
export function createStationDirectory({
  maxSystems = MAX_SYSTEMS,
  maxStations = MAX_STATIONS_PER_SYSTEM,
} = {}) {
  /** @type {Map<string, Map<string, {lat:number, lon:number, name:string|null, capacity:number|null}>>} */
  const systems = new Map();
  return {
    learn(system, payload) {
      const list = payload?.data?.stations;
      if (!Array.isArray(list)) return;
      const stations = new Map();
      for (const station of list) {
        if (stations.size >= maxStations) break;
        const id = text(station?.station_id, MAX_STATION_ID);
        const lat = num(station?.lat);
        const lon = num(station?.lon);
        if (!id || lat === null || lon === null) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        if (lat === 0 && lon === 0) continue;
        stations.set(id, {
          lat,
          lon,
          name: text(station.name),
          capacity: count(station.capacity),
        });
      }
      if (stations.size === 0) return;
      systems.delete(system);
      systems.set(system, stations);
      if (systems.size > maxSystems)
        systems.delete(systems.keys().next().value);
    },
    locate(system) {
      return systems.get(system) ?? null;
    },
    get size() {
      return systems.size;
    },
  };
}

/**
 * The adapter's input for one station_status answer: the system, the answer's
 * clock, and each station with the position and name learned for it.
 * @param {string} system
 * @param {object} payload parsed station_status
 * @param {ReturnType<typeof createStationDirectory>} directory
 */
export function statusInput(system, payload, directory) {
  const known = directory.locate(system);
  const list = Array.isArray(payload?.data?.stations)
    ? payload.data.stations
    : [];
  return {
    system,
    lastUpdated: num(payload?.last_updated),
    stations: list.map((station) => {
      const id = text(station?.station_id, MAX_STATION_ID);
      return { ...station, _place: (id && known?.get(id)) || null };
    }),
  };
}

/** @returns {Array<{id: string, t: number, lat?: number, lon?: number, props: object}>} */
export function toRecords(input) {
  const system = text(input?.system, MAX_SYSTEM_KEY);
  if (!system || !Array.isArray(input.stations)) return [];
  const answerS = num(input.lastUpdated);
  const records = [];
  for (const station of input.stations) {
    const id = text(station?.station_id, MAX_STATION_ID);
    if (!id) continue;
    const reportedS = num(station.last_reported);
    const seenS = reportedS !== null && reportedS > 0 ? reportedS : answerS;
    if (seenS === null || seenS <= 0) continue;
    const place = station._place;
    const props = {
      name: text(place?.name),
      capacity: count(place?.capacity),
      bikesAvailable: count(station.num_bikes_available),
      ebikesAvailable: count(station.num_ebikes_available),
      docksAvailable: count(station.num_docks_available),
      bikesDisabled: count(station.num_bikes_disabled),
      docksDisabled: count(station.num_docks_disabled),
      installed: flag(station.is_installed),
      renting: flag(station.is_renting),
      returning: flag(station.is_returning),
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    const record = {
      id: entityKey(system, id),
      t: Math.round(seenS * 1000),
      props,
    };
    if (place) {
      record.lat = place.lat;
      record.lon = place.lon;
    }
    records.push(record);
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
