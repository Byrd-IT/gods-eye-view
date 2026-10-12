import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STALE_GREY_MS,
  STALE_FLOOR_MS,
  feedDisplayState,
  formatClock,
  parseGreyMs,
  staleThresholdMs,
} from './staleness.js';

const LAST_OK = Date.UTC(2026, 9, 12, 14, 19, 36); // 09:19 CDT

const stale = (ageMs, extra = {}) => ({
  status: 200,
  headers: {
    'X-Feed-Cache': 'STALE',
    'X-Feed-Last-OK': String(LAST_OK),
    'X-Feed-Age-Ms': String(ageMs),
    'X-Feed-Stale-Since': String(LAST_OK + 180_000),
    'X-Feed-Reason': 'upstream_error',
    ...extra,
  },
});

test('stale threshold = max(3 x cadence, 90 s), same as the collector', () => {
  assert.equal(STALE_FLOOR_MS, 90_000);
  assert.equal(staleThresholdMs(60_000), 180_000);
  assert.equal(staleThresholdMs(15_000), 90_000);
  assert.equal(staleThresholdMs(900_000), 2_700_000);
});

test('GEV_STALE_GREY_MS parsing (owner N5 default 1 hour)', () => {
  assert.equal(DEFAULT_STALE_GREY_MS, 3_600_000);
  assert.equal(parseGreyMs(undefined), 3_600_000);
  assert.equal(parseGreyMs('600000'), 600_000);
  for (const bad of ['', '0', '-1', '1h', '1e6', 'NaN'])
    assert.equal(parseGreyMs(bad), 3_600_000, bad);
});

test('live: fresh answers draw normally with no chip', () => {
  const s = feedDisplayState({
    status: 200,
    headers: new Headers({ 'X-Feed-Cache': 'HIT' }),
  });
  assert.equal(s.state, 'live');
  assert.equal(s.draw, true);
  assert.equal(s.chip, null);
});

test('grey for the window after X-Feed-Stale-Since, then cleared (server clock)', () => {
  const opts = { timeZone: 'America/Chicago' };
  const g = feedDisplayState(stale(180_001), opts);
  assert.equal(g.state, 'grey');
  assert.equal(g.draw, true);
  assert.equal(g.chip, 'No data since 09:19 CDT');
  assert.equal(g.staleSince, LAST_OK + 180_000);
  assert.equal(g.greyUntil, LAST_OK + 180_000 + 3_600_000);
  assert.equal(
    feedDisplayState(stale(180_000 + 3_599_999), opts).state,
    'grey',
  );
  const c = feedDisplayState(stale(180_000 + 3_600_000), opts);
  assert.equal(c.state, 'cleared');
  assert.equal(c.draw, false);
  assert.equal(c.chip, 'No data since 09:19 CDT', 'the chip stays');
});

test('X-Feed-Grey-Until from the server wins over the local default', () => {
  const s = feedDisplayState(
    stale(200_000, { 'X-Feed-Grey-Until': String(LAST_OK + 190_000) }),
  );
  assert.equal(s.state, 'cleared');
  assert.equal(
    feedDisplayState(stale(200_000), { greyMs: 10_000 }).state,
    'cleared',
  );
});

test('the browser clock is never used', (t) => {
  t.mock.method(Date, 'now', () => LAST_OK + 999 * 3_600_000);
  assert.equal(feedDisplayState(stale(181_000)).state, 'grey');
});

test('no snapshot (503): chip only', () => {
  const s = feedDisplayState({
    status: 503,
    headers: { 'X-Feed-Reason': 'collector_down' },
  });
  assert.equal(s.state, 'none');
  assert.equal(s.draw, false);
  assert.equal(s.chip, 'No data');
});

test('OpenSky budget exhaustion chip', () => {
  const s = feedDisplayState(
    stale(181_000, { 'X-Feed-Reason': 'opensky_paused_until=23:59' }),
  );
  assert.equal(s.chip, 'OpenSky paused until 23:59 UTC');
});

test('formatClock gives HH:MM and the zone', () => {
  assert.equal(formatClock(LAST_OK, { timeZone: 'UTC' }), '14:19 UTC');
  assert.equal(
    formatClock(Date.UTC(2026, 0, 5, 6, 3), { timeZone: 'America/Chicago' }),
    '00:03 CST',
  );
});
