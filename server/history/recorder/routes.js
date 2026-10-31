/**
 * Which proxy routes the response tee watches, and how each answer becomes the
 * input of a feed adapter. One entry per recorded route; a feed group adds its
 * entries here and its adapter in adapters/index.js. See tee.js for the shape.
 */
import { answerClockMs } from './adapters/military.js';
import { NOT_LIVE } from './adapters/vessels.js';
import { FAILED, SKIP } from './tee.js';

const exactPath = (path) => (url) =>
  url.pathname === path ? { key: path } : null;

/**
 * /api/flights answers a world-wide OpenSky poll, but when OpenSky is down it
 * answers from adsb.lol around the caller's view, rounded to a 0.25 degree anchor
 * (server/providers/aircraft/opensky.js). Two views asking in the same second
 * get different answers carrying the same `time`, so the answer's own anchor
 * is part of what it is compared with.
 */
const roundedQuarter = (value) => (Math.round(value * 4) / 4).toFixed(2);
const flightsMatch = (url) => {
  if (url.pathname !== '/api/flights') return null;
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const anchored =
    url.searchParams.get('lat') !== null &&
    url.searchParams.get('lon') !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon);
  return {
    key: '/api/flights',
    anchor: anchored ? `${roundedQuarter(lat)},${roundedQuarter(lon)}` : null,
  };
};
const isRegionalFallback = (res) =>
  String(res.getHeader?.('x-opensky-auth') ?? '') === 'adsblol-regional';
const positive = (value) =>
  Number.isSafeInteger(value) && value > 0 ? value : null;

const seconds = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : null;

// The proxies mark an answer they serve again from memory in a response header.
const REPLAYS = new Set([
  'HIT',
  'STALE',
  'STALE-ERROR',
  'INFLIGHT',
  'COOLDOWN',
]);
const replayHeader = (name) => (res) =>
  REPLAYS.has(String(res.getHeader?.(name) ?? '').toUpperCase());
const staleHeader = (name) => (res) =>
  String(res.getHeader?.(name) ?? '').toLowerCase() === 'true';

// LL2's proxy stamps the time of the upstream fetch it is serving as an ISO header.
const cachedAt = (res) => {
  const ms = Date.parse(String(res.getHeader?.('x-gev-cached-at') ?? ''));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export function createFeedRoutes() {
  return [
    {
      feed: 'aircraft',
      name: 'flights',
      match: flightsMatch,
      isReplay: replayHeader('x-opensky-cache'),
      parse: 'json',
      pollAt: (payload) => seconds(payload?.time),
      dedupeKey: (context, { res }) =>
        isRegionalFallback(res) && context.anchor
          ? `${context.key}|${context.anchor}`
          : context.key,
    },
    {
      feed: 'military',
      name: 'military',
      match: exactPath('/api/military'),
      isReplay: replayHeader('x-feed-cache'),
      parse: 'json',
      pollAt: (payload) => answerClockMs(payload),
    },
    {
      // A snapshot of the AISStream cache, never replayed from a response
      // cache (the proxy sends no-store). When the feed is not live the rows are
      // old, so that poll counts as a failed one rather than as new data.
      feed: 'vessels',
      name: 'vessels',
      match: (url) =>
        url.pathname === '/api/vessels'
          ? { key: `/api/vessels|${url.searchParams.get('maxRows') ?? ''}` }
          : null,
      parse: 'json',
      payload: (payload) =>
        NOT_LIVE.includes(payload?.status) ? FAILED : payload,
      pollAt: (payload) =>
        Number.isSafeInteger(payload?.lastMessageAt)
          ? payload.lastMessageAt
          : null,
    },
    {
      // An answer the NHC proxy serves from an old fetch says so in the body;
      // an answer it could not build at all is a failed poll.
      feed: 'cyclones',
      name: 'cyclones',
      match: exactPath('/api/cyclones'),
      parse: 'json',
      payload: (body) => {
        if (body?.unavailable === true) return FAILED;
        return body?.stale === true ? SKIP : body;
      },
      // An unavailable answer has no fetch time; one failed poll a minute is noted.
      pollAt: (body) =>
        body?.unavailable === true
          ? Math.floor(Date.now() / 60_000) * 60_000
          : positive(body?.fetchedAt),
    },
    {
      feed: 'perimeters',
      name: 'fire-perimeters',
      match: exactPath('/api/fire-perimeters'),
      isReplay: staleHeader('x-data-stale'),
      parse: 'json',
      payload: (body) => (body?.stale === true ? SKIP : body),
      pollAt: (body) => positive(body?.fetchedAt),
    },
    {
      feed: 'launches',
      name: 'launches',
      match: exactPath('/api/launches'),
      isReplay: replayHeader('x-gev-cache'),
      parse: 'json',
      // The body has no fetch time; the proxy's header does.
      payload: (body, _context, { res }) => ({
        results: body?.results,
        fetchedAt: cachedAt(res),
      }),
      pollAt: (_body, _context, { res }) => cachedAt(res),
    },
  ];
}
