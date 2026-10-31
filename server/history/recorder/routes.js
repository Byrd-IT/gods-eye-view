/**
 * Which proxy routes the response tee watches, and how each answer becomes the
 * input of a feed adapter. One entry per recorded route; a feed group adds its
 * entries here and its adapter in adapters/index.js. See tee.js for the shape.
 */
import { answerClockMs } from './adapters/military.js';
import { FAILED, SKIP } from './tee.js';

const exactPath = (path) => (url) =>
  url.pathname === path ? { key: path } : null;

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
      match: exactPath('/api/flights'),
      isReplay: replayHeader('x-opensky-cache'),
      parse: 'json',
      pollAt: (payload) => seconds(payload?.time),
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
      pollAt: (body) => positive(body?.fetchedAt),
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
