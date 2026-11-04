/**
 * Time zone helpers for Solunar: which IANA zone is a map spot in, and where
 * do its local days begin and end. Offline: the zone comes from the bundled
 * `tz-lookup` boundary table (CC0), the clock rules from the browser's Intl.
 */
import tzlookup from 'tz-lookup';

const DAY_MS = 86_400_000;
const FALLBACK_ZONE = 'UTC';

/** True when this runtime knows the zone name. */
export function isKnownZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * IANA zone of a spot ("America/Chicago"). Oceans resolve to an Etc/GMT zone;
 * an invalid point or a zone the runtime lacks falls back to UTC.
 */
export function zoneAt(latDeg, lonDeg) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg))
    return FALLBACK_ZONE;
  try {
    const zone = tzlookup(latDeg, lonDeg);
    return isKnownZone(zone) ? zone : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

const partsFormatters = new Map();
function partsFormatter(zone) {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(zone, ms) {
  const out = {};
  for (const p of partsFormatter(zone).formatToParts(new Date(ms)))
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  // Some runtimes print local midnight as 24:00 on the PREVIOUS date.
  if (out.hour === 24) {
    const next = new Date(Date.UTC(out.year, out.month - 1, out.day + 1));
    out.year = next.getUTCFullYear();
    out.month = next.getUTCMonth() + 1;
    out.day = next.getUTCDate();
    out.hour = 0;
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Zone offset from UTC at an instant, in ms (CST = -6 h). */
export function zoneOffsetMs(zone, ms) {
  const p = zonedParts(zone, ms);
  const wallAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a local calendar day starts (00:00 wall clock) in a zone. */
export function localDayStartMs(zone, year, month, day) {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - zoneOffsetMs(zone, wall);
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffsetMs(zone, guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Calendar date `n` days after (year, month, day). */
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** The local calendar date of an instant in a zone. */
export function localDateOf(zone, ms) {
  const { year, month, day } = zonedParts(zone, ms);
  return { year, month, day };
}

/** "2026-11-03" */
export function dateKey({ year, month, day }) {
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}`;
}

export { DAY_MS };
