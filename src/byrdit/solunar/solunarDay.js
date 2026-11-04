/**
 * Solunar facts for ONE local calendar day at a spot: sun and moon rise, set
 * and transit, moon phase, the major/minor feeding windows and the day
 * rating. Pure functions of (spot, date); astronomy-engine does the sky math
 * (MIT, pinned exact in package.json); no DOM, no network, no key.
 *
 * Day rule (the fix for the "borrowed next day's moonrise" bug): an event
 * belongs to a day only when its instant lies inside [local midnight, next
 * local midnight) in the spot's zone. A day without a moonrise or moonset has
 * an EMPTY list for it, and the UI shows "none"; the next day's event is
 * never copied in. A day can have two events of one kind only on a 25-hour
 * (clock-back) day; both are returned.
 */
import {
  Body,
  Illumination,
  MakeTime,
  MoonPhase,
  Observer,
  SearchHourAngle,
  SearchRiseSet,
} from 'astronomy-engine';
import {
  DAY_MS,
  addDays,
  dateKey,
  localDateOf,
  localDayStartMs,
  zoneAt,
} from './zone.js';
import { rateDay } from './rating.js';

const MIN_MS = 60_000;
export const MAJOR_HALF_MS = 60 * MIN_MS; // major window = transit +/- 1 h (2 h)
export const MINOR_HALF_MS = 30 * MIN_MS; // minor window = rise/set +/- 30 min (1 h)
const SYNODIC_DEG_PER_DAY = 360 / 29.530588;

/** Rises (dir +1) or sets (dir -1) whose instant is in [startMs, endMs). */
function riseSetsIn(body, observer, dir, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let guard = 0; guard < 4 && from < endMs; guard++) {
    const found = SearchRiseSet(
      body,
      observer,
      dir,
      MakeTime(new Date(from)),
      (endMs - from) / DAY_MS,
    );
    if (!found) break;
    const ms = found.date.getTime();
    if (ms >= endMs) break;
    out.push(ms);
    from = ms + MIN_MS;
  }
  return out;
}

/** Meridian crossings (hourAngle 0 = upper, 12 = lower) in [startMs, endMs). */
function transitsIn(body, observer, hourAngle, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let guard = 0; guard < 4 && from < endMs; guard++) {
    const found = SearchHourAngle(
      body,
      observer,
      hourAngle,
      MakeTime(new Date(from)),
    );
    const ms = found.time.date.getTime();
    if (ms >= endMs) break;
    out.push(ms);
    from = ms + 6 * 60 * MIN_MS;
  }
  return out;
}

/** The eight common phase names from the Moon's elongation (0 = new). */
export function phaseName(elongationDeg) {
  const names = [
    'New Moon',
    'Waxing Crescent',
    'First Quarter',
    'Waxing Gibbous',
    'Full Moon',
    'Waning Gibbous',
    'Last Quarter',
    'Waning Crescent',
  ];
  const e = ((elongationDeg % 360) + 360) % 360;
  return names[Math.floor(((e + 22.5) % 360) / 45)];
}

/** Days from `elongationDeg` to the nearest new or full moon. */
export function daysFromSyzygy(elongationDeg) {
  const e = ((elongationDeg % 360) + 360) % 360;
  const fromNew = Math.min(e, 360 - e);
  const fromFull = Math.abs(e - 180);
  return Math.min(fromNew, fromFull) / SYNODIC_DEG_PER_DAY;
}

const windowAround = (kind, source, ms, half) => ({
  kind,
  source,
  centerMs: ms,
  startMs: ms - half,
  endMs: ms + half,
});

/**
 * @param {{latDeg:number, lonDeg:number, zone?:string}} spot
 * @param {{year:number, month:number, day:number}} date local calendar date
 */
export function solunarDay(spot, date) {
  const { latDeg, lonDeg } = spot;
  const zone = spot.zone || zoneAt(latDeg, lonDeg);
  const observer = new Observer(latDeg, lonDeg, 0);
  const startMs = localDayStartMs(zone, date.year, date.month, date.day);
  const next = addDays(date, 1);
  const endMs = localDayStartMs(zone, next.year, next.month, next.day);

  const sunrise = riseSetsIn(Body.Sun, observer, +1, startMs, endMs);
  const sunset = riseSetsIn(Body.Sun, observer, -1, startMs, endMs);
  const sunTransit = transitsIn(Body.Sun, observer, 0, startMs, endMs);
  const moonrise = riseSetsIn(Body.Moon, observer, +1, startMs, endMs);
  const moonset = riseSetsIn(Body.Moon, observer, -1, startMs, endMs);
  const moonUpper = transitsIn(Body.Moon, observer, 0, startMs, endMs);
  const moonLower = transitsIn(Body.Moon, observer, 12, startMs, endMs);

  const noon = MakeTime(new Date(startMs + (endMs - startMs) / 2));
  const elongationDeg = MoonPhase(noon);
  const windows = [
    ...moonUpper.map((ms) => windowAround('major', 'upper', ms, MAJOR_HALF_MS)),
    ...moonLower.map((ms) => windowAround('major', 'lower', ms, MAJOR_HALF_MS)),
    ...moonrise.map((ms) => windowAround('minor', 'rise', ms, MINOR_HALF_MS)),
    ...moonset.map((ms) => windowAround('minor', 'set', ms, MINOR_HALF_MS)),
  ].sort((a, b) => a.startMs - b.startMs);

  const base = {
    date: dateKey(date),
    zone,
    latDeg,
    lonDeg,
    startMs,
    endMs,
    sunrise,
    sunset,
    sunTransit,
    moonrise,
    moonset,
    moonUpper,
    moonLower,
    elongationDeg,
    phase: phaseName(elongationDeg),
    illumination: Illumination(Body.Moon, noon).phase_fraction,
    daysFromSyzygy: daysFromSyzygy(elongationDeg),
    windows,
  };
  return { ...base, ...rateDay(base) };
}

/** The next `count` local days (today first) at a spot. */
export function solunarWeek(spot, nowMs, count = 7) {
  const zone = spot.zone || zoneAt(spot.latDeg, spot.lonDeg);
  const today = localDateOf(zone, nowMs);
  return Array.from({ length: count }, (_, i) =>
    solunarDay({ ...spot, zone }, addDays(today, i)),
  );
}
