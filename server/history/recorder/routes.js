/**
 * Which proxy routes the response tee watches, and how each answer becomes the
 * input of a feed adapter. One entry per recorded route; a feed group adds its
 * entries here and its adapter in adapters/index.js. See tee.js for the shape.
 */
import { answerClockMs } from './adapters/military.js';

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
  ];
}
