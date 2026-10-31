import {
  acquisitionMsUtc,
  parseFirmsCsv,
} from '../../../../src/data/firmsCsv.js';
import { LIVE_API_SUPPORT } from '../support.js';
import { splitBox } from '../liveApi.js';

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const SOURCE = 'VIIRS_SNPP_NRT';
const DAY = 24 * 3600 * 1000;
/** The area API answers 1 to 5 days per request. */
const MAX_DAYS_PER_REQUEST = 5;
/** What the near-real-time product is trusted to hold. */
const REACH_MS = 60 * DAY;
const FIELDS = [
  'frp',
  'confidence',
  'brightness',
  'brightnessTi5',
  'daynight',
  'satellite',
  'instrument',
];

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * NASA FIRMS active fires through the area API with a start date and a day
 * range. The MAP_KEY is read from the environment at question time and appears
 * only in the request URL, which no message or log carries.
 * A detection's key and fields match the recorder's, so a feed can move
 * between stored and live-api without the browser noticing.
 *
 * @param {{ getMapKey: () => string }} options
 */
export function createFirmsAdapter({ getMapKey }) {
  const support = LIVE_API_SUPPORT.firms;
  return {
    feed: 'firms',
    source: support.source,
    maxWindowMs: support.maxWindowMs,
    maxPerHour: support.maxPerHour,
    earliestMs: (nowMs) => nowMs - REACH_MS,

    async query({ t, windowMs, bbox, ctx }) {
      const key = String(getMapKey() || '').trim();
      if (!key) throw ctx.fail(`${support.env} is not set`);
      const first = Date.parse(`${day(Math.max(0, t - windowMs))}T00:00:00Z`);
      const last = Date.parse(`${day(t)}T00:00:00Z`);
      const requests = [];
      for (
        let start = first;
        start <= last;
        start += MAX_DAYS_PER_REQUEST * DAY
      ) {
        const days = Math.min(
          MAX_DAYS_PER_REQUEST,
          Math.round((last - start) / DAY) + 1,
        );
        requests.push({ date: day(start), days });
      }
      const observations = [];
      for (const box of splitBox(bbox)) {
        const area = bbox
          ? [box.west, box.south, box.east, box.north].join(',')
          : 'world';
        for (const { date, days } of requests) {
          const url = `${BASE}/${encodeURIComponent(key)}/${SOURCE}/${area}/${days}/${date}`;
          const { status, text } = await ctx.http(url, 'text/csv, text/plain');
          if (status === 401 || status === 403)
            throw ctx.fail('the source rejected the key');
          if (status !== 200) throw ctx.fail(`answered HTTP ${status}`);
          const records = parseFirmsCsv(text);
          if (records === null)
            throw ctx.fail('the source rejected the request');
          for (const fire of records) {
            const at = acquisitionMsUtc(fire.acqDate, fire.acqTime);
            if (!Number.isFinite(at)) continue;
            const data = {};
            for (const name of FIELDS)
              if (fire[name] !== undefined) data[name] = fire[name];
            observations.push({
              t: at,
              key: `${fire.instrument}:${fire.satellite}:${fire.lat.toFixed(4)}:${fire.lon.toFixed(4)}`,
              lat: fire.lat,
              lon: fire.lon,
              data,
            });
          }
        }
      }
      return { observations, truncated: false };
    },
  };
}
