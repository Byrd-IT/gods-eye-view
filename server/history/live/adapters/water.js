import { invalid } from '../../store/common.js';
import { LIVE_API_SUPPORT } from '../support.js';

const BASE = 'https://waterservices.usgs.gov/nwis/iv/';
const DAY = 24 * 3600 * 1000;
const REACH_MS = 120 * DAY;
const MAX_AREA_SQ_DEG = 25;
const NO_DATA = -999999;
/** Parameter code -> field. 00060 discharge in cubic feet per second, 00065 gage height in feet. */
const PARAMETERS = Object.freeze({
  '00060': 'dischargeCfs',
  '00065': 'gageHeightFt',
});

const minute = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

/**
 * USGS stream gauges through the instantaneous-values service. The service
 * wants a bounding box of at most 25 square degrees, so a question without one,
 * or with a larger one, is refused up front with a message the caller can show.
 * Each gauge is reported at its newest reading at or before t.
 */
export function createWaterAdapter() {
  const support = LIVE_API_SUPPORT.water;
  return {
    feed: 'water',
    source: support.source,
    maxWindowMs: support.maxWindowMs,
    maxPerHour: support.maxPerHour,
    earliestMs: (nowMs) => nowMs - REACH_MS,

    check({ bbox }) {
      if (!bbox)
        throw invalid(
          'water history needs a bounding box (the source refuses an unbounded question)',
        );
      if (bbox.west > bbox.east)
        throw invalid('water history does not cross the antimeridian');
      if ((bbox.east - bbox.west) * (bbox.north - bbox.south) > MAX_AREA_SQ_DEG)
        throw invalid(
          `water history area may be at most ${MAX_AREA_SQ_DEG} square degrees; zoom in`,
        );
    },

    async query({ t, windowMs, bbox, ctx }) {
      const params = new URLSearchParams({
        format: 'json',
        bBox: [bbox.west, bbox.south, bbox.east, bbox.north]
          .map((n) => n.toFixed(6))
          .join(','),
        parameterCd: Object.keys(PARAMETERS).join(','),
        startDT: minute(Math.max(0, t - windowMs)),
        endDT: minute(t),
        siteStatus: 'active',
      });
      const { status, text } = await ctx.http(
        `${BASE}?${params}`,
        'application/json',
      );
      if (status === 404) return { observations: [], truncated: false };
      if (status !== 200) throw ctx.fail(`answered HTTP ${status}`);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw ctx.fail('the response was not JSON');
      }
      const series = body?.value?.timeSeries;
      if (!Array.isArray(series))
        throw ctx.fail('the response had no time series');
      const sites = new Map();
      for (const item of series) {
        const code = item?.sourceInfo?.siteCode?.[0]?.value;
        const place = item?.sourceInfo?.geoLocation?.geogLocation;
        const field = PARAMETERS[item?.variable?.variableCode?.[0]?.value];
        if (typeof code !== 'string' || !place || !field) continue;
        let newest = null;
        for (const point of item?.values?.[0]?.value ?? []) {
          const at = Date.parse(point?.dateTime);
          const value = Number(point?.value);
          if (
            !Number.isFinite(at) ||
            at > t ||
            !Number.isFinite(value) ||
            value === NO_DATA
          )
            continue;
          if (!newest || at > newest.at) newest = { at, value };
        }
        if (!newest) continue;
        let site = sites.get(code);
        if (!site) {
          site = {
            t: 0,
            key: code,
            lat: Number(place.latitude),
            lon: Number(place.longitude),
            data: { name: item.sourceInfo.siteName ?? null },
          };
          sites.set(code, site);
        }
        site.data[field] = newest.value;
        site.t = Math.max(site.t, newest.at);
      }
      return { observations: [...sites.values()], truncated: false };
    },
  };
}
