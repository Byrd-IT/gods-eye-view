/**
 * Which proxy routes the response tee watches, and how each answer becomes the
 * input of a feed adapter. One entry per recorded route; a feed group adds its
 * entries here and its adapter in adapters/index.js. See tee.js for the shape.
 */
import { answerClockMs } from './adapters/military.js';
import { NOT_LIVE } from './adapters/vessels.js';
import { createStationDirectory, statusInput, systemKeyOf } from './adapters/bikeshare.js';
import { FAILED, SKIP } from './tee.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../../src/data/gbfsSource.js';

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


// The transit proxy marks every answer: MISS is a fresh fetch from the operator;
// HIT, INFLIGHT (shared with a fetch already counted) and STALE-ERROR (the old
// snapshot served while the operator is failing) are all the same data again.
// An error answer is never a replay: the proxy marks its 502/503/504 'NONE', and
// those are the failed polls the tee must see.
const transitIsReplay = (res) => {
  if (res.statusCode !== 200) return false;
  const state = String(res.getHeader?.('x-gev-cache') ?? '').toUpperCase();
  return state !== '' && state !== 'MISS';
};
// Only /api/transit/vehicles/<operator>: not /feeds and not the MBTA /trail.
const TRANSIT_VEHICLES = /^\/api\/transit\/vehicles\/([^/]+)\/?$/;
const transitMatch = (url) => {
  const found = TRANSIT_VEHICLES.exec(url.pathname);
  if (!found) return null;
  let id;
  try {
    id = decodeURIComponent(found[1]);
  } catch {
    return null;
  }
  return /^[a-z0-9][a-z0-9._-]{0,47}$/i.test(id)
    ? { key: `/api/transit/vehicles/${id.toLowerCase()}` }
    : null;
};

/**
 * /api/gbfs/<encoded https URL>: the same allowlist the proxy applies decides
 * what is watched, so nothing else is read. `key` is the system (operator host
 * and path, no query), so each system is compared with its own last answer.
 */
const GBFS_PREFIX = '/api/gbfs/';
function gbfsMatch(kind) {
  return (url) => {
    if (!url.pathname.startsWith(GBFS_PREFIX)) return null;
    let target;
    try {
      target = new URL(
        decodeURIComponent(url.pathname.slice(GBFS_PREFIX.length)),
      );
    } catch {
      return null;
    }
    if (
      target.protocol !== 'https:' ||
      !isAllowedGbfsHost(target.hostname) ||
      !isAllowedGbfsPath(target.pathname, target.hostname) ||
      /\/station_information(\.json)?$/i.test(target.pathname) !==
        (kind === 'information')
    )
      return null;
    const system = systemKeyOf(target.hostname, target.pathname);
    return system ? { key: system, system } : null;
  };
}

export function createFeedRoutes() {
  const stations = createStationDirectory();
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
    {
      // One operator's snapshot; each operator is its own poll.
      feed: 'transit',
      name: 'vehicles',
      match: transitMatch,
      isReplay: transitIsReplay,
      parse: 'json',
      pollAt: (payload) =>
        Number.isSafeInteger(payload?.fetchedAt) ? payload.fetchedAt : null,
    },
    {
      // Learns where a system's stations are; records nothing itself.
      feed: 'bikeshare',
      name: 'station-information',
      observe: true,
      match: gbfsMatch('information'),
      parse: 'json',
      payload: (payload, { system }) => stations.learn(system, payload),
    },
    {
      // Availability, joined with the positions learned above. The answer's
      // own last_updated is not trusted as a poll marker (some operators leave
      // it fixed while the counts move), so a repeat is found by its bytes.
      feed: 'bikeshare',
      name: 'station-status',
      match: gbfsMatch('status'),
      parse: 'json',
      payload: (payload, { system }) =>
        Array.isArray(payload?.data?.stations)
          ? statusInput(system, payload, stations)
          : SKIP,
    },
  ];
}
