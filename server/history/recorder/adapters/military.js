/**
 * Military aircraft from /api/military, which relays adsb.lol's v2/mil answer:
 * { now, total, ac: [{ hex, flight, r, t, lat, lon, alt_baro, alt_geom, gs,
 * track, baro_rate, squawk, category, dbFlags, seen_pos, ... }] }.
 *
 * Keyed by the ICAO hex; timed by the answer's own clock minus the age of the
 * position. Same volume class as civil aircraft but far smaller (hundreds), so
 * it follows HISTORY_RECORD=1.
 */
export const feed = 'military';
export const source = 'adsb.lol';
export const mode = 'view-driven';
export const cadenceMs = 60_000;
export const fields = Object.freeze([
  'callsign',
  'registration',
  'type',
  'altBaroFt',
  'altGeomFt',
  'onGround',
  'groundSpeedKt',
  'trackDeg',
  'verticalRateFpm',
  'squawk',
  'category',
  'dbFlags',
]);

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 32) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

export function entityKey(aircraft) {
  return String(aircraft.hex).trim().toLowerCase();
}

/** adsb.lol stamps `now` in epoch milliseconds; tolerate seconds. */
export function answerClockMs(payload) {
  const now = num(payload?.now);
  if (now === null || now <= 0) return null;
  return now < 1e11 ? Math.round(now * 1000) : Math.round(now);
}

export function toRecords(payload) {
  const list = Array.isArray(payload?.ac) ? payload.ac : [];
  const clock = answerClockMs(payload);
  const records = [];
  for (const aircraft of list) {
    if (!aircraft || !/^~?[0-9a-fA-F]{6}$/.test(String(aircraft.hex))) continue;
    const lat = num(aircraft.lat);
    const lon = num(aircraft.lon);
    if (lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (clock === null) continue;
    const age = Math.max(0, num(aircraft.seen_pos) ?? num(aircraft.seen) ?? 0);
    const onGround = aircraft.alt_baro === 'ground';
    const props = {
      callsign: text(aircraft.flight),
      registration: text(aircraft.r),
      type: text(aircraft.t, 8),
      altBaroFt: onGround ? null : num(aircraft.alt_baro),
      altGeomFt: num(aircraft.alt_geom),
      onGround,
      groundSpeedKt: num(aircraft.gs),
      trackDeg: num(aircraft.track),
      verticalRateFpm: num(aircraft.baro_rate) ?? num(aircraft.geom_rate),
      squawk: text(aircraft.squawk, 8),
      category: text(aircraft.category, 4),
      dbFlags: num(aircraft.dbFlags),
    };
    for (const name of Object.keys(props))
      if (props[name] === null) delete props[name];
    records.push({
      id: entityKey(aircraft),
      t: Math.round(clock - age * 1000),
      lat,
      lon,
      props,
    });
  }
  return records;
}

export default { feed, source, mode, cadenceMs, fields, entityKey, toRecords };
