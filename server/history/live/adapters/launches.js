import { LIVE_API_SUPPORT } from '../support.js';

const BASE = 'https://ll.thespacedevs.com/2.3.0/launches/';
const PAGE = 100;

/**
 * Launch Library 2 launches whose target time falls in the window. Its
 * anonymous quota is small, which is why the budget for this feed is 10 an hour.
 * `mode=normal` is used because the list mode carries no pad position.
 */
export function createLaunchesAdapter() {
  const support = LIVE_API_SUPPORT.launches;
  return {
    feed: 'launches',
    source: support.source,
    maxWindowMs: support.maxWindowMs,
    maxPerHour: support.maxPerHour,
    stepMs: support.stepMs,
    earliestMs: () => 0,

    async query({ t, windowMs, limit, ctx }) {
      const params = new URLSearchParams({
        mode: 'normal',
        ordering: '-net',
        limit: String(Math.min(limit, PAGE)),
        net__gte: new Date(Math.max(0, t - windowMs)).toISOString(),
        net__lte: new Date(t).toISOString(),
      });
      const { status, text } = await ctx.http(
        `${BASE}?${params}`,
        'application/json',
      );
      if (status !== 200) throw ctx.fail(`answered HTTP ${status}`);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw ctx.fail('the response was not JSON');
      }
      if (!Array.isArray(body?.results))
        throw ctx.fail('the response had no results');
      const observations = [];
      for (const launch of body.results) {
        const at = Date.parse(launch?.net);
        const lat = Number(launch?.pad?.latitude);
        const lon = Number(launch?.pad?.longitude);
        if (typeof launch?.id !== 'string' || !Number.isFinite(at)) continue;
        observations.push({
          t: at,
          key: launch.id,
          lat: Number.isFinite(lat) ? lat : undefined,
          lon: Number.isFinite(lon) ? lon : undefined,
          data: {
            name: launch.name ?? null,
            status: launch.status?.abbrev ?? null,
            pad: launch.pad?.name ?? null,
            provider: launch.launch_service_provider?.name ?? null,
            rocket: launch.rocket?.configuration?.name ?? null,
            windowStart: launch.window_start ?? null,
            windowEnd: launch.window_end ?? null,
          },
        });
      }
      return {
        observations,
        truncated: Number(body.count) > body.results.length,
      };
    },
  };
}
