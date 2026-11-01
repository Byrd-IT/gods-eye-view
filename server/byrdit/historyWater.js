import {
  buildLiveApiAdapters,
  createLiveApiStore,
} from '../history/live/index.js';

/**
 * USGS stream-gauge readings at a PAST time for
 * /api/history/slice?feed=water (card t_7a4c6a57, gev-history audit option 4).
 * NOTHING IS STORED: the H8 live-api water backend asks USGS NWIS
 * instantaneous values for the box and time, behind its own per-hour budget,
 * answer cache, timeout, size cap and no-redirect rule (server/history/live).
 *
 * src/ is the browser graph and may not import server/
 * (scripts/check-import-directions.mjs), so server/byrdit/history.js injects
 * this reader into the history service, like the wind reader.
 *
 * The H8 water adapter allows a box of at most 25 square degrees, about 120
 * days back and a window of at most 6 h; a stricter or looser question is
 * refused by the adapter, not here. The budget sent to USGS is
 * GEV_HISTORY_WATER_PER_HOUR (default 600): one question per 4-degree tile of
 * a view, so a few scrubs of a wide view need more than the 120 an hour the
 * H8 matrix allows a single box.
 */
export const DEFAULT_WATER_PER_HOUR = 600;

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 */
export function createWaterHistoryReader({
  env = process.env,
  fetch: fetchImpl,
  now = Date.now,
} = {}) {
  const perHour = Number(env.GEV_HISTORY_WATER_PER_HOUR);
  const adapter = buildLiveApiAdapters(env).water;
  const tuned = {
    ...adapter,
    maxPerHour:
      Number.isInteger(perHour) && perHour > 0 && perHour <= 5000
        ? perHour
        : DEFAULT_WATER_PER_HOUR,
  };
  const store = createLiveApiStore({
    adapters: { water: tuned },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    now,
  });
  return {
    /** Oldest instant USGS answers for, at the clock `nowMs`. */
    earliestMs: (nowMs) => tuned.earliestMs(nowMs),
    /** Widest window one question may ask for (ms). */
    maxWindowMs: tuned.maxWindowMs,
    /** Time steps a question is snapped to (ms). */
    stepMs: tuned.stepMs,
    /**
     * @returns {Promise<{observations: Array<{t:number,key:string,lat:number,lon:number,data:object}>, truncated:boolean}>}
     */
    read({ t, bbox, windowMs, limit }) {
      return store.slice('water', { t, bbox, windowMs, limit });
    },
    close: () => store.close(),
  };
}
