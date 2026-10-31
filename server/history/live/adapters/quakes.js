import { LIVE_API_SUPPORT } from '../support.js';
import { splitBox } from '../liveApi.js';

const BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
/** The service refuses a limit above this. */
const SERVICE_MAX = 20_000;

/**
 * USGS earthquakes through the FDSN event query. One question per bounding box
 * (two across the antimeridian). Events come back newest first; a question that
 * fills the limit is reported as truncated.
 */
export function createQuakesAdapter() {
  const support = LIVE_API_SUPPORT.quakes;
  return {
    feed: 'quakes',
    source: support.source,
    maxWindowMs: support.maxWindowMs,
    maxPerHour: support.maxPerHour,
    stepMs: support.stepMs,
    earliestMs: () => 0,

    async query({ t, windowMs, limit, bbox, ctx }) {
      const perRequest = Math.min(limit, SERVICE_MAX);
      const observations = [];
      let truncated = false;
      for (const box of splitBox(bbox)) {
        const params = new URLSearchParams({
          format: 'geojson',
          orderby: 'time',
          limit: String(perRequest),
          starttime: new Date(Math.max(0, t - windowMs)).toISOString(),
          endtime: new Date(t).toISOString(),
        });
        if (bbox) {
          params.set('minlatitude', String(box.south));
          params.set('maxlatitude', String(box.north));
          params.set('minlongitude', String(box.west));
          params.set('maxlongitude', String(box.east));
        }
        const { status, text } = await ctx.http(
          `${BASE}?${params}`,
          'application/geo+json, application/json',
        );
        if (status === 204) continue;
        if (status !== 200) throw ctx.fail(`answered HTTP ${status}`);
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw ctx.fail('the response was not JSON');
        }
        if (!Array.isArray(body?.features))
          throw ctx.fail('the response had no features');
        if (body.features.length >= perRequest) truncated = true;
        for (const feature of body.features) {
          const [lon, lat, depth] = feature?.geometry?.coordinates ?? [];
          const p = feature?.properties ?? {};
          if (typeof feature?.id !== 'string' || !Number.isFinite(p.time))
            continue;
          observations.push({
            t: p.time,
            key: feature.id,
            lat,
            lon,
            data: {
              mag: p.mag ?? null,
              magType: p.magType ?? null,
              place: p.place ?? null,
              depthKm: Number.isFinite(depth) ? depth : null,
              status: p.status ?? null,
              tsunami: p.tsunami ?? null,
              url: typeof p.url === 'string' ? p.url : null,
            },
          });
        }
      }
      return { observations, truncated };
    },
  };
}
