/**
 * Which proxy routes the response tee watches, and how each answer becomes the
 * input of a feed adapter. One entry per recorded route; a feed group adds its
 * entries here and its adapter in adapters/index.js. See tee.js for the shape.
 */
import { answerClockMs } from './adapters/military.js';
import {
  createStationDirectory,
  statusInput,
  systemKeyOf,
} from './adapters/bikeshare.js';
import { SKIP } from './tee.js';
import {
  isAllowedGbfsHost,
  isAllowedGbfsPath,
} from '../../../src/data/gbfsSource.js';

const exactPath = (path) => (url) =>
  url.pathname === path ? { key: path } : null;

const seconds = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : null;

// The proxies mark an answer they serve again from memory in a response header.
const REPLAYS = new Set(['HIT', 'STALE', 'INFLIGHT', 'COOLDOWN']);
const replayHeader = (name) => (res) =>
  REPLAYS.has(String(res.getHeader?.(name) ?? '').toUpperCase());

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
