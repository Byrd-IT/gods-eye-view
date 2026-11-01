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
 * USGS answers a 16 square degree tile in about 9 to 12 s (730 KB), and a
 * view is 9 to 12 tiles. The default 20 s timeout of the live store cut off
 * slow tiles, so the wait is longer, and at most WATER_CONCURRENCY questions
 * are out at once; the others wait their turn here (never a "busy" answer,
 * which would show the live gauges under a history clock).
 */
export const WATER_TIMEOUT_MS = 45_000;
export const WATER_CONCURRENCY = 3;
export const WATER_MAX_QUEUED = 64;

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
    timeoutMs: WATER_TIMEOUT_MS,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    now,
  });
  let running = 0;
  const waiting = [];
  const release = () => {
    // hand the slot straight to the next waiter, so a new question that
    // arrives in between cannot take it (a 4th would then be out)
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  async function turn() {
    if (running < WATER_CONCURRENCY) {
      running += 1;
      return;
    }
    if (waiting.length >= WATER_MAX_QUEUED) {
      const error = new Error(
        'water history source: too many questions waiting',
      );
      error.code = 'BACKEND';
      throw error;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }
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
    async read({ t, bbox, windowMs, limit }) {
      await turn();
      try {
        return await store.slice('water', { t, bbox, windowMs, limit });
      } finally {
        release();
      }
    },
    close: () => store.close(),
  };
}
