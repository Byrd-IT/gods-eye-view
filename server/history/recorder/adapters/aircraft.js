/**
 * Civil aircraft from /api/flights. The route serves OpenSky's states/all
 * answer (or, when OpenSky is down, adsb.lol rewritten into the same shape):
 * { time, states: [[icao24, callsign, country, time_position, last_contact,
 * lon, lat, baro_alt, on_ground, velocity, track, vertical_rate, sensors,
 * geo_alt, squawk, spi, position_source, category], ...] }.
 *
 * An aircraft is its 24-bit ICAO address; a fix is timed by its own position
 * time. Heavy: a world-wide poll holds about ten thousand aircraft, so it
 * records only when HISTORY_RECORD_AIRCRAFT=1 names it, never from
 * HISTORY_RECORD=1 alone.
 */
export const feed = 'aircraft';
export const source = 'OpenSky Network (adsb.lol when OpenSky is down)';
export const mode = 'view-driven';
export const cadenceMs = 60_000;
export const defaultOn = false;
export const fields = Object.freeze([
  'callsign',
  'country',
  'baroAltM',
  'geoAltM',
  'onGround',
  'velocityMps',
  'trackDeg',
  'verticalRateMps',
  'squawk',
  'positionSource',
  'category',
]);

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 32) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

export function entityKey(state) {
  return String(state[0]).trim().toLowerCase();
}

/** @returns {Array<{id: string, t: number, lat: number, lon: number, props: object}>} */
export function toRecords(payload) {
  const states = Array.isArray(payload?.states) ? payload.states : [];
  const polledS = num(payload?.time);
  const records = [];
  for (const state of states) {
    if (!Array.isArray(state) || !/^[0-9a-fA-F]{6}$/.test(String(state[0])))
      continue;
    const lat = num(state[6]);
    const lon = num(state[5]);
    if (lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const seenS = num(state[3]) ?? num(state[4]) ?? polledS;
    if (seenS === null || seenS <= 0) continue;
    const props = {
      callsign: text(state[1]),
      country: text(state[2], 64),
      baroAltM: num(state[7]),
      geoAltM: num(state[13]),
      onGround: state[8] === true,
      velocityMps: num(state[9]),
      trackDeg: num(state[10]),
      verticalRateMps: num(state[11]),
      squawk: text(state[14], 8),
      positionSource: num(state[16]),
      category: num(state[17]),
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    records.push({
      id: entityKey(state),
      t: Math.round(seenS * 1000),
      lat,
      lon,
      props,
    });
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
