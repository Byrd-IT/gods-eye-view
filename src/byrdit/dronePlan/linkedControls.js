/**
 * The arithmetic behind the red marks of Mapping Grid (Timed): each of the
 * four sliders (front overlap, speed, interval, height) shows where the OTHER
 * settings would put it.
 *
 * Every figure here is the same relation the plan uses:
 *   spacing  = speed x interval           (metres between photos)
 *   overlap  = 1 - spacing / along        (front overlap, 0..1)
 * where `along` is the along-track ground footprint of one photo at the plan
 * height (planner.footprint, nothing re-derived here). The 0.1 m rounding of
 * planner.writtenSpacingM is NOT applied: a mark is the exact figure, the
 * result line next to the interval box keeps using the written spacing, so
 * the two can differ by up to 0.05 m / along (about 0.06 % at 80 m).
 *
 * A mark only informs: nothing in this module changes a setting. A value
 * outside its slider (or with no solution) is pinned at the nearest end and
 * says which end; unreadable inputs give no mark. Pure: no DOM, no Cesium.
 */
import { footprint } from './planner.js';

/** A positive finite number, else NaN (so every comparison below is false). */
const pos = (v) => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

/** Wanted overlap as a fraction in (0, 1), from a percentage; NaN otherwise. */
function wantedFraction(pct) {
  const n = typeof pct === 'number' ? pct : pct == null ? NaN : Number(pct);
  return Number.isFinite(n) && n > 0 && n < 100 ? n / 100 : NaN;
}

/** Front overlap in percent that speed x interval gives, or null. */
export function frontOverlapPct({ alongM, speedMs, intervalS }) {
  const along = pos(alongM);
  const v = pos(speedMs);
  const t = pos(intervalS);
  if (!(along > 0) || !(v > 0) || !(t > 0)) return null;
  return (1 - (v * t) / along) * 100;
}

/** Speed (m/s) that gives the wanted overlap at this interval, or null. */
export function speedForOverlap({ alongM, wantedPct, intervalS }) {
  const along = pos(alongM);
  const t = pos(intervalS);
  const w = wantedFraction(wantedPct);
  if (!(along > 0) || !(t > 0) || !(w > 0)) return null;
  return ((1 - w) * along) / t;
}

/** Interval (s) that gives the wanted overlap at this speed, or null. */
export function intervalForOverlap({ alongM, wantedPct, speedMs }) {
  const along = pos(alongM);
  const v = pos(speedMs);
  const w = wantedFraction(wantedPct);
  if (!(along > 0) || !(v > 0) || !(w > 0)) return null;
  return ((1 - w) * along) / v;
}

/**
 * `h => along-track footprint (m)` for one aircraft preset and camera tilt:
 * the planner's own footprint(), the function the panel readout calls.
 */
export function alongAtHeightFn(preset, tiltDeg = 0) {
  return (aglM) => footprint(preset, aglM, tiltDeg).alongM;
}

/**
 * Height (m) at which the along-track footprint equals
 * spacing / (1 - wanted), found by BISECTION over [minM, maxM] on
 * `alongAt(h)` (no footprint formula of its own). The footprint grows with
 * height, so a target under the lowest height pins at `minM` ('below') and one
 * over the highest pins at `maxM` ('above'). Returns null when the inputs
 * cannot give a number or `alongAt` throws or is not finite.
 * @returns {null | { valueM:number, status:'inside'|'below'|'above' }}
 */
export function heightForOverlap({
  alongAt,
  minM,
  maxM,
  speedMs,
  intervalS,
  wantedPct,
}) {
  const v = pos(speedMs);
  const t = pos(intervalS);
  const w = wantedFraction(wantedPct);
  const lo0 = Number(minM);
  const hi0 = Number(maxM);
  if (
    typeof alongAt !== 'function' ||
    !(v > 0) ||
    !(t > 0) ||
    !(w > 0) ||
    !Number.isFinite(lo0) ||
    !Number.isFinite(hi0) ||
    !(hi0 > lo0)
  ) {
    return null;
  }
  const target = (v * t) / (1 - w);
  let atLo;
  let atHi;
  try {
    atLo = alongAt(lo0);
    atHi = alongAt(hi0);
  } catch {
    return null;
  }
  if (!Number.isFinite(atLo) || !Number.isFinite(atHi) || !(atHi > atLo)) {
    return null;
  }
  if (target <= atLo) return { valueM: lo0, status: 'below' };
  if (target >= atHi) return { valueM: hi0, status: 'above' };
  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    let along;
    try {
      along = alongAt(mid);
    } catch {
      return null;
    }
    if (!Number.isFinite(along)) return null;
    if (along < target) lo = mid;
    else hi = mid;
  }
  return { valueM: (lo + hi) / 2, status: 'inside' };
}

/** 0..1 position of `value` on a continuous slider; pinned at the ends. */
export function fractionOnRange(value, min, max) {
  const v = Number(value);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !(hi > lo)) return null;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/**
 * Position of a seconds value on the EVEN-spaced interval scale (one tick per
 * option, equal distance between ticks whatever the seconds): the fractional
 * tick index, by linear interpolation between the two neighbouring options.
 * Outside the list the index is pinned at the first or last tick.
 * @returns {null | { index:number, status:'inside'|'below'|'above' }}
 */
export function tickPosition(options, seconds) {
  const list = Array.isArray(options) ? options : [];
  const s = Number(seconds);
  if (!list.length || !Number.isFinite(s)) return null;
  if (s <= list[0]) {
    return { index: 0, status: s < list[0] ? 'below' : 'inside' };
  }
  const last = list.length - 1;
  if (s >= list[last]) {
    return { index: last, status: s > list[last] ? 'above' : 'inside' };
  }
  for (let i = 0; i < last; i++) {
    if (s >= list[i] && s <= list[i + 1]) {
      return {
        index: i + (s - list[i]) / (list[i + 1] - list[i]),
        status: 'inside',
      };
    }
  }
  return null;
}

/**
 * The tick nearest to a typed seconds value, so the thumb can sit there while
 * the output keeps the typed number. Ties go to the shorter interval.
 * @returns {number} an index into `options`, or -1 for an empty list
 */
export function nearestTickIndex(options, seconds) {
  const list = Array.isArray(options) ? options : [];
  const s = Number(seconds);
  if (!list.length || !Number.isFinite(s)) return -1;
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    if (Math.abs(list[i] - s) < Math.abs(list[best] - s)) best = i;
  }
  return best;
}

/**
 * One mark for a continuous slider.
 * `value` is the figure in the slider's unit; the step is in the same unit.
 * @returns {null | { value:number, fraction:number,
 *   status:'inside'|'below'|'above', matches:boolean }}
 */
function continuousMark({ value, min, max, step, thumb }) {
  if (!Number.isFinite(value)) return null;
  const fraction = fractionOnRange(value, min, max);
  if (fraction == null) return null;
  const status = value < min ? 'below' : value > max ? 'above' : 'inside';
  const tolerance = Number(step) > 0 ? Number(step) : 0;
  return {
    value,
    fraction,
    status,
    // Within one step of the thumb (and the mark really is on the slider).
    matches:
      status === 'inside' &&
      Number.isFinite(Number(thumb)) &&
      Math.abs(Number(thumb) - value) <= tolerance + 1e-9,
  };
}

/**
 * All four marks for the current settings. Every range, value and figure is
 * in INTERNAL units (m, m/s, s, percent); the panel turns the results into
 * the unit the person reads.
 *
 * @param {object} input
 * @param {number} input.alongM along-track footprint at the plan height
 * @param {number} input.speedMs plan speed
 * @param {number} input.intervalS Timed-shot interval
 * @param {number} input.frontOverlapPct the WANTED front overlap
 * @param {number} input.aglM plan height above ground
 * @param {(aglM:number)=>number} input.alongAt along-track footprint at a height
 * @param {{min:number,max:number,step:number}} input.speedRange m/s
 * @param {{min:number,max:number,step:number}} input.overlapRange percent
 * @param {{min:number,max:number,step:number}} input.heightRange metres
 * @param {readonly number[]} input.intervalOptions seconds, ascending
 * @returns {{ overlap, speed, interval, height }} each null or a mark:
 *   `{ value, fraction, status, matches }` (interval marks carry `index`
 *   instead of a fraction of a continuous range; `fraction` is index/(n-1)).
 */
export function linkedMarks({
  alongM,
  speedMs,
  intervalS,
  frontOverlapPct: wantedPct,
  aglM,
  alongAt,
  speedRange,
  overlapRange,
  heightRange,
  intervalOptions,
}) {
  const out = { overlap: null, speed: null, interval: null, height: null };

  const given = frontOverlapPct({ alongM, speedMs, intervalS });
  if (given != null && overlapRange) {
    out.overlap = continuousMark({
      value: given,
      min: overlapRange.min,
      max: overlapRange.max,
      step: overlapRange.step,
      thumb: wantedPct,
    });
  }

  const needSpeed = speedForOverlap({ alongM, wantedPct, intervalS });
  if (needSpeed != null && speedRange) {
    out.speed = continuousMark({
      value: needSpeed,
      min: speedRange.min,
      max: speedRange.max,
      step: speedRange.step,
      thumb: speedMs,
    });
  }

  const needS = intervalForOverlap({ alongM, wantedPct, speedMs });
  const list = Array.isArray(intervalOptions) ? intervalOptions : [];
  if (needS != null && list.length) {
    const place = tickPosition(list, needS);
    if (place) {
      const thumbIndex = nearestTickIndex(list, intervalS);
      out.interval = {
        value: needS,
        index: place.index,
        fraction: list.length > 1 ? place.index / (list.length - 1) : 0,
        status: place.status,
        // The thumb sits on the tick nearest the mark.
        matches:
          place.status === 'inside' &&
          thumbIndex >= 0 &&
          Math.abs(place.index - thumbIndex) <= 0.5 + 1e-9,
      };
    }
  }

  if (heightRange) {
    const solved = heightForOverlap({
      alongAt,
      minM: heightRange.min,
      maxM: heightRange.max,
      speedMs,
      intervalS,
      wantedPct,
    });
    if (solved) {
      out.height = {
        ...continuousMark({
          value: solved.valueM,
          min: heightRange.min,
          max: heightRange.max,
          step: heightRange.step,
          thumb: aglM,
        }),
        // A pinned value is at an end by construction: say which end.
        status: solved.status,
      };
      out.height.matches =
        solved.status === 'inside' &&
        Number.isFinite(Number(aglM)) &&
        Math.abs(Number(aglM) - solved.valueM) <=
          (Number(heightRange.step) || 0) + 1e-9;
    }
  }
  return out;
}
