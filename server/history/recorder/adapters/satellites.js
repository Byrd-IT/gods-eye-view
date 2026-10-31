import { parseTleText, tleCatalogNumber } from '../../../../src/sources/tle.js';

/**
 * Satellite element sets from /api/celestrak/<group>, the CelesTrak TLE text
 * the proxy relays (name line, then the two 69-character element lines).
 *
 * A row is one element set, not a position: key = NORAD catalogue number
 * (Alpha-5 decoded), time = the set's own epoch, lat/lon null. Positions are
 * computed from the set by SGP4 at any moment, so storing them would only
 * store a guess. The same set seen again, from this group or another that
 * lists the same satellite, has the same key and epoch and writes nothing.
 *
 * Only the groups in GROUPS are recorded (see routes.js); the two catalogue-
 * sized ones (`active`, `starlink`) are left out on purpose. The adapter also
 * stops at MAX_SETS in one answer.
 */
export const feed = 'satellites';
export const source = 'CelesTrak';
/** The proxy fetches only while a client asks for a group, and at most every 6 h. */
export const mode = 'view-driven';
export const cadenceMs = 6 * 3600_000;
export const fields = Object.freeze([
  'name',
  'line1',
  'line2',
  'classification',
  'intlDesignator',
  'inclinationDeg',
  'raanDeg',
  'eccentricity',
  'argPerigeeDeg',
  'meanAnomalyDeg',
  'meanMotionRevDay',
  'bstar',
  'revNumber',
]);

/** The groups worth keeping: a few hundred element sets each, none catalogue-sized. */
export const GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
]);
export const MAX_SETS = 5000;
const MAX_NAME = 24;

// Fixed-column shapes of the two lines (69 characters each).
const LINE1 =
  /^1 [ 0-9A-Z]{5}[A-Z] [ 0-9A-Z]{8} (\d{2})(\d{3}\.\d{8}) [ +-]\.\d{8} [ +-]\d{5}[+-]\d [ +-]\d{5}[+-]\d \d [ \d]{4}\d$/;
const LINE2 =
  /^2 [ 0-9A-Z]{5} [ \d]{3}\.\d{4} [ \d]{3}\.\d{4} \d{7} [ \d]{3}\.\d{4} [ \d]{3}\.\d{4} [ \d]\d\.\d{8}[ \d]{5}\d$/;

/** Column 69: digits add their value, "-" adds 1, everything else 0; modulo 10. */
export function tleChecksumOk(line) {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return sum % 10 === Number(line[68]);
}

/**
 * Epoch of a line 1 as epoch milliseconds, or null. Two-digit years 57-99 are
 * 19xx and 00-56 are 20xx; anything before 1970 is refused, because a negative
 * time breaks the stores' index lifecycle.
 */
export function tleEpochMs(line1) {
  const match = LINE1.exec(line1);
  if (!match) return null;
  const yy = Number(match[1]);
  const day = Number(match[2]);
  if (!(day >= 1 && day < 367)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const t = Date.UTC(year, 0, 1) + Math.round((day - 1) * 86_400_000);
  return Number.isSafeInteger(t) && t > 0 ? t : null;
}

const num = (text) => {
  const value = Number(String(text).trim());
  return Number.isFinite(value) ? value : null;
};

/** The B* drag term: "-11606-4" is -0.11606e-4. */
function bstarOf(field) {
  const match = /^([ +-])(\d{5})([+-]\d)$/.exec(field);
  if (!match) return null;
  const value = Number(`0.${match[2]}e${match[3]}`);
  return match[1] === '-' ? -value : value;
}

export function entityKey(set) {
  return String(tleCatalogNumber(set.line1));
}

/** Parse the proxy's TLE text into the adapter's input. Bounded; never throws. */
export function fromText(text) {
  if (typeof text !== 'string') return { sets: [] };
  return { sets: parseTleText(text).slice(0, MAX_SETS) };
}

/** @param {{ sets?: Array<{name: string, line1: string, line2: string}> }} payload */
export function toRecords(payload) {
  const sets = Array.isArray(payload?.sets) ? payload.sets : [];
  const records = [];
  for (const set of sets.slice(0, MAX_SETS)) {
    const { line1, line2 } = set ?? {};
    if (typeof line1 !== 'string' || typeof line2 !== 'string') continue;
    if (!LINE1.test(line1) || !LINE2.test(line2)) continue;
    if (!tleChecksumOk(line1) || !tleChecksumOk(line2)) continue;
    const id = tleCatalogNumber(line1);
    if (id === null || id !== tleCatalogNumber(line2)) continue;
    const t = tleEpochMs(line1);
    if (t === null) continue;
    const name = typeof set.name === 'string' ? set.name.trim() : '';
    const props = {
      // A name over the TLE limit, or with anything but printable ASCII, is not a name.
      name:
        name && name.length <= MAX_NAME && /^[ -~]+$/.test(name) ? name : null,
      line1,
      line2,
      classification: line1[7],
      intlDesignator: line1.slice(9, 17).trim() || null,
      inclinationDeg: num(line2.slice(8, 16)),
      raanDeg: num(line2.slice(17, 25)),
      eccentricity: num(`0.${line2.slice(26, 33)}`),
      argPerigeeDeg: num(line2.slice(34, 42)),
      meanAnomalyDeg: num(line2.slice(43, 51)),
      meanMotionRevDay: num(line2.slice(52, 63)),
      bstar: bstarOf(line1.slice(53, 61)),
      revNumber: num(line2.slice(63, 68)),
    };
    for (const field of Object.keys(props))
      if (props[field] === null) delete props[field];
    records.push({ id: String(id), t, lat: null, lon: null, props });
  }
  return records;
}

export default {
  feed,
  source,
  mode,
  cadenceMs,
  fields,
  entityKey,
  toRecords,
};
