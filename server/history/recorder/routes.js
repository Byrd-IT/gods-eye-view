/**
 * Which proxy routes the response tee watches, and how each answer becomes the
 * input of a feed adapter. One entry per recorded route; a feed group adds its
 * entries here and its adapter in adapters/index.js. See tee.js for the shape.
 */
import { answerClockMs } from './adapters/military.js';
import { GROUPS, fromText } from './adapters/satellites.js';
import { FAILED } from './tee.js';

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

const GROUP_PATH = /^\/api\/celestrak\/([a-z0-9-]+)\/?$/;

/**
 * CelesTrak TLE text, one route entry for the recorded groups. The proxy sets
 * `X-TLE-Cached-At` to the time of the upstream fetch on every answer, so two
 * answers with the same value are one refresh; HIT and STALE-ERROR answers are
 * the cache replaying one.
 */
const celestrakGroup = (url) => {
  const group = GROUP_PATH.exec(url.pathname)?.[1];
  return group && GROUPS.includes(group) ? { key: group } : null;
};
const cachedAt = (_parsed, _context, { res }) => {
  const at = Date.parse(String(res.getHeader?.('x-tle-cached-at') ?? ''));
  return Number.isSafeInteger(at) && at > 0 ? at : null;
};
const REPLAYED_TLE = new Set(['HIT', 'STALE-ERROR']);

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
      feed: 'satellites',
      name: 'celestrak',
      match: celestrakGroup,
      isReplay: (res) =>
        REPLAYED_TLE.has(
          String(res.getHeader?.('x-tle-cache') ?? '').toUpperCase(),
        ),
      parse: 'text',
      // A 200 without one valid element set is not a TLE answer: a failed poll.
      payload: (text) => {
        const input = fromText(text);
        return input.sets.length ? input : FAILED;
      },
      pollAt: cachedAt,
    },
  ];
}
