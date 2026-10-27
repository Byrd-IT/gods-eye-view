import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHistoryControl } from './historyControl.js';
import { createHistoryVoice, parseJumpTime } from './historyVoice.js';
import { ALL_HISTORY_ADAPTERS } from './historyEventAdapters.js';
import { DAY_MS, HOUR_MS } from './historyTimeline.js';
import { fixtureFetch, fixtureWorld } from './fixtures/b11Coverage.mjs';
import { fakeClock, fakeDocument, fakeWindow } from './fakeDom.mjs';

const NOW = Date.parse('2026-10-14T16:00:00Z');
const HREF = 'https://gev.example/?sv=29.76,-95.37,180,45,60#lat=29.7&lon=-95.3&l=abc';

function setup({ swapped = [] } = {}) {
  const clock = fakeClock(NOW);
  const world = fixtureWorld(NOW);
  const control = mountHistoryControl({
    document: fakeDocument(),
    window: fakeWindow(HREF, fixtureFetch(world, { calls: [] })),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  const router = {
    adapters: ALL_HISTORY_ADAPTERS,
    getState: () => ({ swapped }),
  };
  const voice = createHistoryVoice({
    getHandle: () => control,
    getRouter: () => router,
    now: clock.now,
  });
  return { clock, control, voice, router };
}

test('parseJumpTime: ISO with a zone, a bare date is UTC, a zoneless time is refused', () => {
  assert.equal(parseJumpTime('2026-03-04T15:30:00Z').ms, Date.parse('2026-03-04T15:30:00Z'));
  assert.equal(parseJumpTime('2026-03-04T09:30:00-06:00').ms, Date.parse('2026-03-04T15:30:00Z'));
  assert.equal(parseJumpTime('2026-03-04').ms, Date.parse('2026-03-04T00:00:00Z'));
  assert.match(parseJumpTime('2026-03-04T09:30:00').error, /zone/);
  assert.match(parseJumpTime('yesterday at 3').error, /ISO 8601/);
  assert.match(parseJumpTime('').error, /ISO 8601/);
  assert.match(parseJumpTime(42).error, /ISO 8601/);
  assert.match(parseJumpTime('2026-13-45T00:00:00Z').error, /not a valid date/);
});

test('status: live to begin with, then reports mode, time, rate, playing feeds', () => {
  const h = setup({ swapped: ['vessels', 'flights'] });
  const s = h.voice.status();
  assert.equal(s.ok, true);
  assert.equal(s.mode, 'live');
  assert.equal(s.time, null);
  assert.equal(s.playing, false);
  assert.equal(s.rate, 1);
  assert.deepEqual(s.playingFeeds, ['ais-live-vessels', 'flights']);
  h.control.destroy();
});

test('jump: opens History at an ISO time, or minutes ago, and says what it did', async () => {
  const h = setup();
  const a = h.voice.jump({ time: '2026-10-10T12:00:00Z' });
  assert.equal(a.ok, true);
  assert.equal(a.mode, 'history');
  assert.equal(a.requested, '2026-10-10T12:00:00.000Z');
  assert.equal(h.control.getState().timeMs !== null, true);
  const b = h.voice.jump({ minutesAgo: 60 });
  assert.equal(b.ok, true);
  assert.equal(b.requested, new Date(NOW - HOUR_MS).toISOString());
  h.control.destroy();
});

test('jump: refuses bad input, clamps the future and the far past', () => {
  const h = setup();
  assert.equal(h.voice.jump({}).ok, false);
  assert.match(h.voice.jump({}).error, /time .* or minutesAgo/);
  assert.equal(h.voice.jump({ time: '2026-10-10T12:00:00' }).ok, false);
  assert.equal(h.voice.jump({ minutesAgo: -5 }).ok, false);
  assert.equal(h.voice.jump({ minutesAgo: 'soon' }).ok, false);
  assert.equal(h.control.getState().mode, 'live', 'a refused jump never opens History');
  const future = h.voice.jump({ time: '2027-01-01T00:00:00Z' });
  assert.equal(future.ok, true);
  assert.equal(future.clamped, 'future');
  const past = h.voice.jump({ time: '2020-01-01T00:00:00Z' });
  assert.equal(past.clamped, 'past');
  assert.ok(Date.parse(past.time) >= NOW - 730 * DAY_MS);
  h.control.destroy();
});

test('play and pause: play needs History open; pause keeps the time', async () => {
  const h = setup();
  const early = h.voice.play();
  assert.equal(early.ok, false);
  assert.match(early.error, /jump to a time first/);
  h.voice.jump({ time: '2026-10-10T12:00:00Z' });
  const p = h.voice.play();
  assert.equal(p.ok, true);
  assert.equal(p.playing, true);
  const q = h.voice.pause();
  assert.equal(q.ok, true);
  assert.equal(q.playing, false);
  assert.equal(q.mode, 'history');
  assert.ok(q.time);
  h.control.destroy();
});

test('play at the present has nothing to play toward', () => {
  const h = setup();
  h.voice.jump({ minutesAgo: 0 });
  const r = h.voice.play();
  assert.equal(r.ok, false);
  assert.match(r.error, /present/);
  h.control.destroy();
});

test('speed: only the control rates, 1 / 10 / 60 / 600', () => {
  const h = setup();
  for (const rate of [10, 60, 600, 1]) {
    const r = h.voice.speed(rate);
    assert.equal(r.ok, true);
    assert.equal(r.rate, rate);
  }
  assert.equal(h.voice.speed('60').rate, 60, 'a numeric string is the same rate');
  const bad = h.voice.speed(5);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.allowed, [1, 10, 60, 600]);
  assert.equal(h.voice.speed(undefined).ok, false);
  assert.equal(h.control.getState().rate, 60, 'a refused speed changes nothing');
  h.control.destroy();
});

test('live: leaves History and stops playback', () => {
  const h = setup();
  h.voice.jump({ time: '2026-10-10T12:00:00Z' });
  h.voice.play();
  const r = h.voice.live();
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'live');
  assert.equal(r.time, null);
  assert.equal(r.playing, false);
  h.control.destroy();
});

test('feedLayerIds is exactly the layer of every history adapter', () => {
  const h = setup();
  assert.deepEqual(
    h.voice.feedLayerIds(),
    ALL_HISTORY_ADAPTERS.map((a) => a.layerId),
  );
  h.control.destroy();
});

test('a destroyed or missing control answers unavailable, never throws', () => {
  const h = setup();
  h.control.destroy();
  for (const call of [
    () => h.voice.status(),
    () => h.voice.jump({ minutesAgo: 5 }),
    () => h.voice.play(),
    () => h.voice.pause(),
    () => h.voice.speed(10),
    () => h.voice.live(),
  ]) {
    const r = call();
    assert.equal(r.ok, false);
    assert.match(r.error, /not available/);
  }
  const none = createHistoryVoice({ getHandle: () => null });
  assert.equal(none.status().ok, false);
  assert.deepEqual(none.feedLayerIds(), []);
});

test('a refused jump time never echoes the text it was given', () => {
  const h = setup();
  for (const text of [
    'https://user:pass@host/?api_key=SECRETKEY123',
    'Bearer abcdef-SECRETKEY123',
    '2026-13-45T00:00:00Z SECRETKEY123',
    '2026-03-04T09:30:00 SECRETKEY123',
  ]) {
    const r = h.voice.jump({ time: text });
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('SECRETKEY123'), text);
  }
  h.control.destroy();
});
