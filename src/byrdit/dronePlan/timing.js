/**
 * Speed and photo timing for a survey line shot with the camera's own Timed
 * shot (DJI Fly "Timed shot", capture mode C).
 *
 * Three numbers belong together and are kept apart on purpose:
 *  - the front overlap the person WANTS (a planning target);
 *  - the interval the person CAN set in DJI Fly (a custom number: 5, 7 and 10
 *    are quick-fill examples, not a claim about any aircraft's firmware);
 *  - the front overlap that interval and speed actually GIVE.
 * Only the along-track footprint decides these (the side overlap is about
 * the spacing between lines and is not touched here). Pure: no DOM.
 */
import {
  MAX_TIMED_INTERVAL_S,
  cleanTimedIntervalS,
  writtenSpacingM,
} from './planner.js';
import { MIN_PLAN_SPEED_MS, floorTo } from './speed.js';

export { MAX_TIMED_INTERVAL_S, cleanTimedIntervalS };

/** Miles per hour in one metre per second (1 mi = 1609.344 m exactly). */
export const MPH_PER_MS = 3600 / 1609.344;
export const msToMph = (ms) => Number(ms) * MPH_PER_MS;
export const mphToMs = (mph) => Number(mph) / MPH_PER_MS;

/** Quick-fill buttons. Examples a pilot knows from DJI Fly, NOT firmware limits. */
export const INTERVAL_QUICK_FILL_S = Object.freeze([5, 7, 10]);

/** Front overlap within this many points of the wanted value counts as met. */
const MEETS_TOLERANCE_PCT = 0.05;

/**
 * The speed the planner will actually use: the same clamp planFlight applies
 * (0.1 m/s up to the aircraft's top speed). Unreadable input is the aircraft's
 * default speed, as in the planner.
 */
export function effectiveSpeedMs(speedMs, preset) {
  const raw = speedMs == null || speedMs === '' ? NaN : Number(speedMs);
  const n = Number.isFinite(raw) ? raw : preset.defaultSpeedMs;
  return Math.min(preset.maxSpeedMs, Math.max(MIN_PLAN_SPEED_MS, n));
}

/**
 * @param {{ alongM:number, speedMs:number, frontOverlapPct:number,
 *   timedIntervalS?:number|null, minIntervalS?:number }} input
 *   alongM is the along-track ground footprint of one photo.
 * @returns {null | {
 *   desiredSpacingM:number, recommendedIntervalS:number, speedMs:number,
 *   chosen: null | { intervalS:number, spacingM:number, frontPct:number,
 *     shortfallPct:number, state:'meets'|'short'|'gap',
 *     underCameraMin:boolean, fitSpeedMs:number|null } }}
 *   Null when the inputs cannot give a real number.
 */
export function timingFigures({
  alongM,
  speedMs,
  frontOverlapPct,
  timedIntervalS = null,
  minIntervalS = 0,
}) {
  const along = Number(alongM);
  const speed = Number(speedMs);
  const front = Number(frontOverlapPct);
  if (!(along > 0) || !(speed > 0) || !Number.isFinite(front)) return null;
  const desiredSpacingM = along * (1 - front / 100);
  if (!(desiredSpacingM > 0)) return null;
  const out = {
    desiredSpacingM,
    recommendedIntervalS: desiredSpacingM / speed,
    speedMs: speed,
    chosen: null,
  };
  const interval = cleanTimedIntervalS(timedIntervalS);
  if (interval == null) return out;
  // The same 0.1 m station spacing the plan and the file use.
  const spacingM = writtenSpacingM(speed * interval);
  const frontPct = (1 - spacingM / along) * 100;
  const shortfallPct = front - frontPct;
  const fit = floorTo(desiredSpacingM / interval, 0.1);
  out.chosen = {
    intervalS: interval,
    spacingM,
    frontPct,
    shortfallPct,
    state:
      frontPct <= 0
        ? 'gap'
        : shortfallPct <= MEETS_TOLERANCE_PCT
          ? 'meets'
          : 'short',
    underCameraMin:
      Number(minIntervalS) > 0 && interval + 1e-9 < Number(minIntervalS),
    // Null when even the slowest plan speed cannot reach the wanted overlap.
    fitSpeedMs: fit >= MIN_PLAN_SPEED_MS ? Number(fit.toFixed(1)) : null,
  };
  return out;
}

/**
 * One row per survey pass of PLAN ALL: the interval gives each pass a
 * different overlap, because each pass has its own height, tilt and speed.
 * Orbits keep their own ring spacing and failed passes have no plan, so
 * neither gets a row. Read from the planned result, not re-derived. With no
 * interval chosen, `frontPct` and `state` are null and the row still gives
 * the interval that pass would need.
 * @returns {{id:string,label:string,speedMs:number,frontPct:number|null,
 *   desiredFrontPct:number,recommendedIntervalS:number,
 *   state:'meets'|'short'|'gap'|null}[]}
 */
export function suiteTimingRows(passes, timedIntervalS) {
  const interval = cleanTimedIntervalS(timedIntervalS);
  if (!Array.isArray(passes)) return [];
  const rows = [];
  for (const pass of passes) {
    const plan = pass?.result?.plan;
    if (!plan || plan.options?.pattern === 'orbit') continue;
    const figs = timingFigures({
      alongM: plan.footprint?.alongM,
      speedMs: plan.speedMs,
      frontOverlapPct: plan.options?.frontOverlap,
      timedIntervalS: interval,
    });
    if (!figs) continue;
    rows.push({
      id: String(pass.id),
      label: String(pass.label ?? pass.id),
      speedMs: figs.speedMs,
      frontPct: figs.chosen ? figs.chosen.frontPct : null,
      desiredFrontPct: Number(plan.options.frontOverlap),
      recommendedIntervalS: figs.recommendedIntervalS,
      state: figs.chosen ? figs.chosen.state : null,
    });
  }
  return rows;
}
