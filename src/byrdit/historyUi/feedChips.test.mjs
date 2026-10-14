import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGED_FEEDS,
  FEED_STATE_EVENT,
  createFeedChips,
  feedOfUrl,
  isBridgeAnswer,
} from './feedChips.js';
import { DEFAULT_STALE_GREY_MS } from '../history/staleness.js';
import { fakeWindow, flush } from './fakeDom.mjs';

const T0 = Date.parse('2026-10-14T15:00:00Z');
const MIN = 60_000;
const TZ = { timeZone: 'UTC' };

/** A bridge answer as collectorBridge.js sends it (fixture headers). */
function bridgeResponse({
  status = 200,
  lastOk,
  ageMs = 5_000,
  staleSince = null,
  reason = null,
  greyUntil = null,
  body = '{"ac":[]}',
} = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    'X-Feed-Source': 'collector',
  });
  if (lastOk !== undefined) headers.set('X-Feed-Last-OK', String(lastOk));
  headers.set('X-Feed-Age-Ms', String(ageMs));
  if (staleSince !== null) {
    headers.set('X-Feed-Cache', 'STALE');
    headers.set('X-Feed-Stale-Since', String(staleSince));
    headers.set(
      'X-Feed-Grey-Until',
      String(greyUntil ?? staleSince + DEFAULT_STALE_GREY_MS),
    );
  } else headers.set('X-Feed-Cache', 'HIT');
  if (reason) headers.set('X-Feed-Reason', reason);
  return new Response(body, { status, headers });
}

function harness() {
  let mono = 0;
  const win = fakeWindow('https://gev.example/', null);
  const chips = createFeedChips({ target: win, monotonic: () => mono, ...TZ });
  return { win, chips, advance: (ms) => (mono += ms) };
}

test('bridged routes map to chips; track routes and other paths do not', () => {
  assert.equal(feedOfUrl('/api/military').id, 'military');
  assert.equal(
    feedOfUrl('/api/flights?lat=1&lon=2&view=1,2,3,4').id,
    'flights',
  );
  assert.equal(
    feedOfUrl('https://gev.example/api/vessels?maxRows=12000').id,
    'vessels',
  );
  assert.equal(feedOfUrl('/api/transit/vehicles/houston-metro').id, 'transit');
  assert.equal(feedOfUrl('/api/gbfs/https%3A%2F%2Fx').id, 'bikeshare');
  assert.equal(feedOfUrl('/api/celestrak/stations').id, 'satellites');
  assert.equal(feedOfUrl('/api/military/track?hex=ae1234'), null);
  assert.equal(feedOfUrl('/api/flights/track?icao24=a'), null);
  assert.equal(feedOfUrl('/api/history/coverage'), null);
  assert.equal(feedOfUrl('/api/cctv/sources'), null);
  assert.equal(BRIDGED_FEEDS.length, 10);
  assert.equal(
    isBridgeAnswer(new Response('x', { headers: { 'X-Feed-Cache': 'STALE' } })),
    false,
    'upstream cache header alone is not the bridge',
  );
});

test('state live: green LIVE chip, layer drawn', () => {
  const { chips } = harness();
  chips.observe('/api/military', bridgeResponse({ lastOk: T0 }));
  const [s] = chips.states();
  assert.equal(s.state, 'live');
  assert.equal(s.chip, 'LIVE');
  assert.equal(s.draw, true);
});

test('state grey-no-data: grey chip "No data since HH:MM <tz>" + age, layer still drawn', () => {
  const { chips } = harness();
  const lastOk = Date.parse('2026-10-14T14:02:00Z');
  chips.observe(
    '/api/military',
    bridgeResponse({ lastOk, ageMs: 20 * MIN, staleSince: lastOk + 3 * MIN }),
  );
  const [s] = chips.states();
  assert.equal(s.state, 'grey');
  assert.equal(s.chip, 'No data since 14:02 UTC');
  assert.equal(s.age, '20 min');
  assert.equal(s.draw, true);
});

test('state cleared-after-1h: judged on the server clock, then chip only', () => {
  const { chips, advance } = harness();
  const lastOk = Date.parse('2026-10-14T14:02:00Z');
  const staleSince = lastOk + 3 * MIN;
  // answer at server time staleSince + 59 min: still grey
  chips.observe(
    '/api/firms',
    bridgeResponse({ lastOk, ageMs: 62 * MIN, staleSince }),
  );
  assert.equal(chips.states()[0].state, 'grey');
  // no new answer (FIRMS polls every 30 min): 61 s later by the monotonic
  // clock the server-side hour is over -> cleared, chip stays
  advance(61_000);
  const s = chips.states()[0];
  assert.equal(s.state, 'cleared');
  assert.equal(s.draw, false);
  assert.equal(s.chip, 'No data since 14:02 UTC');
});

test('a page opened after the grey hour is cleared at its first answer', () => {
  const { chips } = harness();
  const lastOk = Date.parse('2026-10-14T10:00:00Z');
  chips.observe(
    '/api/military',
    bridgeResponse({
      lastOk,
      ageMs: 5 * 3_600_000,
      staleSince: lastOk + 3 * MIN,
    }),
  );
  const s = chips.states()[0];
  assert.equal(s.state, 'cleared');
  assert.equal(s.draw, false);
  assert.equal(s.age, '5 h 00 min');
});

test('the browser clock is never used: a wrong Date.now does not change the state', () => {
  const { chips } = harness();
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const lastOk = Date.parse('2026-10-14T14:02:00Z');
    chips.observe(
      '/api/military',
      bridgeResponse({ lastOk, ageMs: 20 * MIN, staleSince: lastOk + 3 * MIN }),
    );
    assert.equal(chips.states()[0].state, 'grey');
  } finally {
    Date.now = realNow;
  }
});

test('state opensky-paused: "OpenSky paused until HH:MM UTC"', () => {
  const { chips } = harness();
  const lastOk = Date.parse('2026-10-14T14:02:00Z');
  chips.observe(
    '/api/flights?lat=29&lon=-95',
    bridgeResponse({
      lastOk,
      ageMs: 10 * MIN,
      staleSince: lastOk + 3 * MIN,
      reason: 'opensky_paused_until=17:30',
    }),
  );
  const s = chips.states()[0];
  assert.equal(s.feed, 'flights');
  assert.equal(s.state, 'paused');
  assert.equal(s.chip, 'OpenSky paused until 17:30 UTC');
  assert.equal(s.draw, true, 'inside the grey hour the last data stays (grey)');
});

test('503 with no snapshot: chip only', () => {
  const { chips } = harness();
  chips.observe(
    '/api/vessels',
    bridgeResponse({
      status: 503,
      reason: 'collector_down',
      body: '{"error":"no_snapshot"}',
    }),
  );
  const s = chips.states()[0];
  assert.equal(s.state, 'none');
  assert.equal(s.draw, false);
  assert.equal(s.chip, 'No data');
});

test('feed recovers: back to LIVE at once; state changes are announced for B12', () => {
  const { chips, win } = harness();
  const lastOk = Date.parse('2026-10-14T14:02:00Z');
  chips.observe(
    '/api/military',
    bridgeResponse({
      lastOk,
      ageMs: 2 * 3_600_000,
      staleSince: lastOk + 3 * MIN,
    }),
  );
  chips.refresh();
  chips.observe('/api/military', bridgeResponse({ lastOk: T0 }));
  chips.refresh();
  const events = win.events
    .filter((e) => e.type === FEED_STATE_EVENT)
    .map((e) => [e.detail.feed, e.detail.state, e.detail.draw]);
  assert.deepEqual(events, [
    ['military', 'cleared', false],
    ['military', 'live', true],
  ]);
});

test('transit group shows its worst vehicle feed', () => {
  const { chips } = harness();
  const lastOk = Date.parse('2026-10-14T14:02:00Z');
  chips.observe('/api/transit/vehicles/a', bridgeResponse({ lastOk: T0 }));
  chips.observe(
    '/api/transit/vehicles/b',
    bridgeResponse({ lastOk, ageMs: 20 * MIN, staleSince: lastOk + 3 * MIN }),
  );
  const states = chips.states();
  assert.equal(states.length, 1);
  assert.equal(states[0].state, 'grey');
});

test('fetch wrapper: the same promise back, body never read, errors untouched, restored on destroy', async () => {
  const win = fakeWindow('https://gev.example/', null);
  const answer = bridgeResponse({ lastOk: T0 });
  let calls = 0;
  const original = async function (input) {
    calls++;
    assert.equal(this, win, 'called with the window as this');
    if (String(input).includes('boom')) throw new TypeError('network');
    return answer;
  };
  win.fetch = original;
  const chips = createFeedChips({ target: win, monotonic: () => 0 });
  chips.install();
  assert.notEqual(win.fetch, original);
  const response = await win.fetch('/api/military');
  assert.equal(response, answer);
  await flush();
  assert.equal(response.bodyUsed, false, 'the layer still reads its own body');
  assert.deepEqual(await response.json(), { ac: [] });
  assert.equal(chips.states()[0].state, 'live');
  await assert.rejects(win.fetch('/api/military/boom'), TypeError);
  await win.fetch('/api/cctv/sources');
  assert.equal(calls, 3);
  chips.destroy();
  assert.equal(win.fetch, original);
});
