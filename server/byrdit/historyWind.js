import {
  GFS_BUCKET,
  gfsObjectKey,
  nearestGfsStep,
} from '../providers/wind/catalog.js';
import {
  fetchRange,
  fetchText,
  loadOptionalScalar,
  parseGfsIdx,
  windMessageRanges,
} from '../providers/wind/gfs.js';
import {
  ifsObjectUrls,
  ifsWindRanges,
  nearestIfsStep,
  parseIfsIndex,
} from '../providers/wind/ifs.js';
import { decodeWindGribMessage } from '../providers/wind/decode.js';
import {
  resampleWeatherSnapshot,
  weatherScalarError,
  weatherScalarMetadata,
} from '../providers/wind/grid.js';

/**
 * Wind at a PAST cycle for /api/history/slice?feed=wind (gev-history DESIGN
 * 1.3 #10, card B12c t_de253a39). NOTHING IS STORED: the grid is read on
 * demand from the provider's own archive with GEV's existing byte-range
 * reader pieces (server/providers/wind/*: .idx-selected GRIB2 messages,
 * ecCodes decode, resample), only for an explicit cycle and the forecast
 * step whose valid time is nearest t (the same step rule the live reader
 * applies to `now`). server/providers/wind.js itself is untouched; its live
 * selection (selectLatestGfsCycle(now)) is the only part not reused.
 *
 * Upstream retention, MEASURED 2026-10-14 (HEAD of the f000 inventory):
 *  - GFS s3 noaa-gfs-bdp-pds: gfs.<date>/<HH>/atmos/ layout 200 from
 *    2021-03-22 12Z (06Z of that day 404; gfs.2020* absent); every later
 *    date tested 200 (2024-10-15, 2025-10-14, 2026-10-01, 2026-10-14).
 *    Bounded by the 731-day history window, so never reached in practice.
 *  - ECMWF IFS open data (data.ecmwf.int/forecasts): a rolling window of
 *    the current UTC day and the 3 before it (2026-10-11 00/06/12/18Z 200,
 *    2026-10-10 404).
 * A cycle outside the retention, or an inventory the provider answers
 * 403/404 for, is reported (status != 'ok'); never another cycle (D3).
 */

export const GFS_ATMOS_FROM_MS = Date.UTC(2021, 2, 22, 12);
export const IFS_RETENTION_DAYS = 3;
/**
 * A wind-only answer (overlay scalar unavailable) is kept this long, so a
 * manifest and its grid stay one read, then re-read: a transient upstream
 * error is retried at most once a minute per cycle+step and never pinned
 * until LRU eviction (B12c review R2). A full answer is kept (immutable).
 */
export const WIND_DEGRADED_HOLD_MS = 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Earliest run time each model's upstream still serves. */
export function windRetention(model, nowMs) {
  if (model === 'gfs') return { fromMs: GFS_ATMOS_FROM_MS };
  const d = new Date(nowMs);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { fromMs: day - IFS_RETENTION_DAYS * DAY_MS };
}

/** The forecast step of `runMs` whose valid time is nearest `validMs`. */
export function windStep(model, runMs, validMs) {
  const hours = (validMs - runMs) / HOUR_MS;
  return model === 'gfs'
    ? nearestGfsStep(hours)
    : nearestIfsStep(hours, new Date(runMs).getUTCHours());
}

const cycleOf = (runMs) => {
  const d = new Date(runMs);
  return {
    date: d.toISOString().slice(0, 10).replaceAll('-', ''),
    hour: d.getUTCHours(),
  };
};

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Function} [options.decodeImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.targetDx] same 1 degree as the live reader
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxEntries] decoded grids kept (LRU)
 * @param {number} [options.degradedHoldMs] how long a wind-only answer (the
 *   overlay's scalar read failed, e.g. a transient 503) is reused before the
 *   next request reads the cycle again
 */
export function createWindHistoryReader({
  fetchImpl = fetch,
  decodeImpl = decodeWindGribMessage,
  now = () => Date.now(),
  targetDx = 1,
  timeoutMs = 40_000,
  maxEntries = 6,
  degradedHoldMs = WIND_DEGRADED_HOLD_MS,
} = {}) {
  const cache = new Map();

  async function load({ model, overlay, runMs, forecastHour }) {
    const cycle = cycleOf(runMs);
    const urls =
      model === 'gfs'
        ? (() => {
            const base = `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey({ ...cycle, forecastHour })}`;
            return { index: `${base}.idx`, grib: base };
          })()
        : ifsObjectUrls({ ...cycle, step: forecastHour });
    let indexStatus = null;
    const tracked = async (url, init) => {
      const response = await fetchImpl(url, init);
      if (url === urls.index) indexStatus = response.status;
      return response;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    try {
      let index;
      try {
        index = await fetchText({
          url: urls.index,
          fetchImpl: tracked,
          signal,
        });
      } catch (error) {
        if (indexStatus === 404 || indexStatus === 403)
          return { status: 'upstream_missing' };
        throw error;
      }
      const inventory =
        model === 'gfs'
          ? parseGfsIdx(index.toString())
          : parseIfsIndex(index.toString());
      const rangesOf = (opts) =>
        model === 'gfs'
          ? windMessageRanges(inventory, opts)
          : ifsWindRanges(inventory, opts);
      const ranges = rangesOf();
      let scalarRange;
      if (overlay !== 'none') {
        try {
          scalarRange = rangesOf({ overlay }).scalar;
        } catch {
          /* a missing optional field does not discard valid wind */
        }
      }
      const loadOne = async (range) =>
        decodeImpl(
          await fetchRange({ url: urls.grib, ...range, fetchImpl, signal }),
        );
      const [u, v, scalar] = await Promise.all([
        loadOne(ranges.u),
        loadOne(ranges.v),
        loadOptionalScalar({
          range: scalarRange,
          url: urls.grib,
          fetchImpl,
          decodeImpl,
          signal,
        }),
      ]);
      signal.throwIfAborted();
      const fields = resampleWeatherSnapshot({
        u,
        v,
        scalar,
        overlay,
        targetDx,
      });
      return {
        status: 'ok',
        ...build({ model, overlay, runMs, forecastHour, cycle, fields }),
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** Same checks, id and manifest as server/providers/wind.js refresh(). */
  function build({ model, overlay, runMs, forecastHour, cycle, fields }) {
    const { grid } = fields;
    const count = grid.nx * grid.ny;
    const expectedScalar = weatherScalarMetadata(overlay);
    const missingScalar =
      expectedScalar &&
      fields.scalar === undefined &&
      fields.scalarError === weatherScalarError(overlay);
    const scalar = missingScalar ? null : expectedScalar;
    if (
      !Number.isInteger(grid.nx) ||
      !Number.isInteger(grid.ny) ||
      grid.nx < 1 ||
      grid.ny < 1 ||
      count > 1_000_000 ||
      ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
      grid.dx <= 0 ||
      grid.dy <= 0 ||
      (scalar
        ? ['kind', 'units', 'level'].some(
            (field) => fields.scalar?.[field] !== scalar[field],
          )
        : fields.scalar !== undefined || grid.scalar !== undefined) ||
      (!expectedScalar && fields.scalarError !== undefined) ||
      (scalar && fields.scalarError !== undefined)
    )
      throw new Error('Invalid wind grid');
    const components = [grid.u, grid.v, ...(scalar ? [grid.scalar] : [])];
    for (const values of components)
      if (
        !(values instanceof Float32Array) ||
        values.length !== count ||
        !values.every(Number.isFinite)
      )
        throw new Error('Invalid wind grid');
    const suffix =
      overlay === 'none'
        ? ''
        : `-${overlay}${missingScalar ? '-wind-only' : ''}`;
    const query = `model=${model}${overlay === 'none' ? '' : `&overlay=${overlay}`}`;
    const id = `${model}-${cycle.date}-${cycle.hour}-f${forecastHour || 0}-${targetDx}${suffix}`;
    const manifest = {
      schemaVersion: 1,
      model,
      cycle: {
        ...cycle,
        forecastHour,
        runIso: new Date(runMs).toISOString(),
        validIso: new Date(runMs + forecastHour * HOUR_MS).toISOString(),
      },
      ...(expectedScalar ? { overlay } : {}),
      ...(scalar ? { scalar } : {}),
      ...(missingScalar ? { scalarError: weatherScalarError(overlay) } : {}),
      fetchedAt: now(),
      level: '10 m above ground',
      units: 'm/s',
      grid: {
        nx: grid.nx,
        ny: grid.ny,
        lo1: grid.lo1,
        la1: grid.la1,
        dx: grid.dx,
        dy: grid.dy,
      },
      stale: false,
      unavailable: false,
      reason: null,
      gridUrl: `/api/wind/grid/${id}.bin?${query}`,
    };
    const bytes = Buffer.concat(
      components.map((values) =>
        Buffer.from(values.buffer, values.byteOffset, values.byteLength),
      ),
    );
    return { manifest, bytes };
  }

  /**
   * @param {{model: 'gfs'|'ifs', overlay: string, runMs: number,
   *   validMs: number}} request
   * @returns {Promise<{status: 'ok', manifest: object, bytes: Buffer}
   *   | {status: 'upstream_missing'}>} manifest.scalarError set = degraded
   *   (wind-only), held for degradedHoldMs only
   */
  function read({ model, overlay, runMs, validMs }) {
    const forecastHour = windStep(model, runMs, validMs);
    const key = `${model}:${overlay}:${runMs}:${forecastHour}`;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      // a degraded (wind-only) answer is held only until retryAt
      if (entry.retryAt === undefined || now() < entry.retryAt) {
        cache.set(key, entry);
        return entry.promise;
      }
    }
    const promise = load({ model, overlay, runMs, forecastHour });
    entry = { promise };
    cache.set(key, entry);
    promise.then(
      (value) => {
        if (cache.get(key) !== entry) return;
        if (value.status !== 'ok') cache.delete(key);
        else if (value.manifest.scalarError !== undefined)
          entry.retryAt = now() + degradedHoldMs;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return promise;
  }

  return {
    retention: (model, nowMs = now()) => windRetention(model, nowMs),
    read,
  };
}
