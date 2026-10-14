import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRefreshDriver,
  PLAY_MIN_REFRESH_MS,
  PLAY_POLL_MS,
  RELEASE_DEBOUNCE_MS,
} from './historyRefresh.js';
import { createHistoryRouter } from './historyRouter.js';
import { fakeClock, fakeWindow, flush, jsonResponse } from './fakeDom.mjs';

const NOW = Date.parse('2026-10-14T18:00:00Z');
const T = Date.parse('2026-10-14T06:00:00Z');
const MIN = 60_000;

/** A data manager stand-in: enabled ids + refreshLayer that asks the layer's route. */
function fakeManager(win, { enabled, slow = false } = {}) {
  const routes = {
    flights: '/api/flights?view=1,2,3,4',
    military: '/api/military',
    'ais-live-vessels': '/api/vessels?maxRows=12000',
  };
  const m = {
    enabled: new Set(enabled),
    calls: [],
    active: new Map(),
    maxConcurrent: 0,
    gates: [],
    getEnabledLayerIds: () => new Set(m.enabled),
    getAll: () =>
      ['flights', 'military', 'ais-live-vessels', 'earthquakes'].map((id) => ({
        id,
        name: id,
      })),
    subscribe: () => () => {},
    async refreshLayer(id) {
      m.calls.push(id);
      const n = (m.active.get(id) ?? 0) + 1;
      m.active.set(id, n);
      m.maxConcurrent = Math.max(m.maxConcurrent, n);
      try {
        if (slow) await new Promise((r) => m.gates.push(r));
        if (routes[id]) await win.fetch(routes[id]);
        return true;
      } finally {
        m.active.set(id, m.active.get(id) - 1);
      }
    },
  };
  return m;
}

function setup({
  enabled = ['flights', 'military', 'earthquakes'],
  slice,
  slow,
} = {}) {
  const clock = fakeClock(NOW);
  const sliceCalls = [];
  const snapCalls = [];
  const fetch = async (input) => {
    const url = new URL(String(input), 'https://gev.example');
    const q = Object.fromEntries(url.searchParams);
    if (url.pathname === '/api/history/slice') {
      sliceCalls.push(q);
      if (slice) return slice(q);
      return jsonResponse(
        q.feed === 'military'
          ? { ac: [], now: Date.parse(q.t) }
          : q.feed === 'vessels'
            ? { rows: [] }
            : { time: Math.round(Date.parse(q.t) / 1000), states: [] },
      );
    }
    return jsonResponse(
      { live: true },
      { headers: { 'X-Feed-Source': 'live' } },
    );
  };
  const win = fakeWindow('https://gev.example/', fetch);
  const router = createHistoryRouter({
    target: win,
    now: clock.now,
    timers: clock.timers,
    monotonic: clock.monotonic,
  });
  router.install();
  const dm = fakeManager(win, { enabled, slow });
  const client = {
    async snapshots({ feed, around, n }) {
      snapCalls.push({ feed, around, n });
      // recorded every minute
      const base = Math.floor(around / MIN) * MIN;
      return Array.from({ length: n }, (_, i) => base + (i - n / 2) * MIN);
    },
  };
  const driver = createRefreshDriver({
    router,
    getDataManager: () => dm,
    client,
    timers: clock.timers,
    monotonic: clock.monotonic,
    now: clock.now,
  });
  return { clock, router, dm, driver, sliceCalls, snapCalls, win };
}

test('released change: refreshLayer only for enabled, swapped layers (settle polls)', async () => {
  const { clock, dm, driver } = setup();
  driver.onHistory({ active: true, timeMs: T, playing: false });
  assert.equal(dm.calls.length, 0, 'debounced');
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  // flights + military are enabled and swapped (3 polls each: absent
  // aircraft of another time leave at once); vessels is not enabled,
  // earthquakes has no history swap
  assert.deepEqual([...new Set(dm.calls)].sort(), ['flights', 'military']);
  assert.equal(dm.calls.filter((c) => c === 'flights').length, 3);
  assert.equal(dm.calls.filter((c) => c === 'military').length, 3);
  assert.equal(dm.maxConcurrent, 1, 'never overlapping per layer');
});

test('the settle polls of one time cost one slice request per feed (cache)', async () => {
  const { clock, driver, sliceCalls } = setup();
  driver.onHistory({ active: true, timeMs: T });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  assert.deepEqual(sliceCalls.map((q) => q.feed).sort(), [
    'aircraft',
    'military',
  ]);
});

test('a failed (pass-through) feed is not refreshed; it is not swapped', async () => {
  const { clock, dm, driver, win } = setup({
    slice: (q) =>
      q.feed === 'military'
        ? jsonResponse({}, { status: 500 })
        : jsonResponse({ time: 1, states: [] }),
  });
  driver.onHistory({ active: true, timeMs: T });
  await win.fetch('/api/military'); // fails -> pass-through
  dm.calls.length = 0;
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  assert.deepEqual([...new Set(dm.calls)], ['flights']);
});

test('drag: no refresh until the release, then one debounced refresh', async () => {
  const { clock, dm, driver } = setup({ enabled: ['military'] });
  driver.onHistory({ active: true, timeMs: T });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  dm.calls.length = 0;
  driver.setDragging(true);
  for (let i = 1; i <= 10; i++) {
    driver.onHistory({ active: true, timeMs: T - i * MIN });
    await clock.run(RELEASE_DEBOUNCE_MS * 2);
  }
  assert.equal(dm.calls.length, 0);
  driver.setDragging(false);
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  assert.deepEqual(dm.calls, ['military', 'military', 'military']);
});

test('steps in quick succession coalesce into one refresh run', async () => {
  const { clock, dm, driver } = setup({ enabled: ['military'] });
  driver.onHistory({ active: true, timeMs: T });
  driver.onHistory({ active: true, timeMs: T + MIN });
  driver.onHistory({ active: true, timeMs: T + 2 * MIN });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  assert.equal(dm.calls.length, 3);
});

test('playback: one refresh per frame change, paced, never overlapping; next 2 frames prefetched', async () => {
  const { clock, dm, driver, router, snapCalls } = setup({
    enabled: ['military'],
  });
  driver.onHistory({ active: true, timeMs: T, playing: false });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  dm.calls.length = 0;
  // play at 60x: the B11 control moves t; the driver polls it
  let t = T;
  driver.onHistory({ active: true, timeMs: t, playing: true });
  for (let i = 0; i < 40; i++) {
    t += PLAY_POLL_MS * 60;
    driver.onHistory({ active: true, timeMs: t, playing: true });
    await clock.run(PLAY_POLL_MS);
  }
  await driver.settle();
  assert.ok(snapCalls.length >= 1 && snapCalls[0].feed === 'military');
  // 40 ticks x 250 ms = 10 s wall, 10 min history: at most one refresh per
  // PLAY_MIN_REFRESH_MS
  assert.ok(dm.calls.length >= 3, `refreshes ${dm.calls.length}`);
  assert.ok(dm.calls.length <= Math.ceil(10_000 / PLAY_MIN_REFRESH_MS) + 1);
  assert.equal(dm.maxConcurrent, 1);
  const st = router.getState();
  assert.ok(st.stats.prefetches >= 2, 'prefetched');
  assert.ok(st.stats.maxInFlight <= 2);
  assert.ok(st.stats.cacheHits >= 1, 'a prefetched frame served the layer');
});

test('playback with a slow layer: no overlapping refresh of that layer', async () => {
  const { clock, dm, driver } = setup({ enabled: ['military'], slow: true });
  let t = T;
  driver.onHistory({ active: true, timeMs: t, playing: true });
  for (let i = 0; i < 40; i++) {
    t += PLAY_POLL_MS * 600;
    driver.onHistory({ active: true, timeMs: t, playing: true });
    await clock.run(PLAY_POLL_MS);
    if (i % 10 === 9) dm.gates.splice(0).forEach((r) => r());
  }
  dm.gates.splice(0).forEach((r) => r());
  await flush();
  assert.equal(dm.maxConcurrent, 1);
});

test('D4: LIVE refreshes each layer that was swapped (and only those)', async () => {
  const { clock, dm, driver, sliceCalls } = setup({
    enabled: ['flights', 'military', 'earthquakes'],
  });
  driver.onHistory({ active: true, timeMs: T });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  dm.calls.length = 0;
  const slices = sliceCalls.length;
  driver.onHistory({ active: false, timeMs: null });
  await driver.settle();
  assert.deepEqual([...new Set(dm.calls)].sort(), ['flights', 'military']);
  assert.equal(sliceCalls.length, slices, 'the LIVE refreshes ask live');
  // nothing more refreshes after LIVE (no timers left running)
  dm.calls.length = 0;
  await clock.run(10_000);
  assert.equal(dm.calls.length, 0);
});

test('a layer enabled during history is picked up by the next change', async () => {
  const { clock, dm, driver } = setup({ enabled: ['military'] });
  driver.onHistory({ active: true, timeMs: T });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  dm.enabled.add('ais-live-vessels');
  dm.calls.length = 0;
  driver.onHistory({ active: true, timeMs: T + MIN });
  await clock.run(RELEASE_DEBOUNCE_MS + 1);
  await driver.settle();
  assert.deepEqual([...new Set(dm.calls)].sort(), [
    'ais-live-vessels',
    'military',
  ]);
  assert.equal(dm.calls.filter((c) => c === 'ais-live-vessels').length, 1);
});

test('playback pace: all swapped layers together stay inside the slice budget; prefetch = the frames that will be shown', async () => {
  const { clock, dm, driver, router, sliceCalls } = setup({
    enabled: ['flights', 'military', 'ais-live-vessels'],
  });
  let t = T;
  driver.onHistory({ active: true, timeMs: t, playing: true, rate: 60 });
  const start = clock.monotonic();
  const at = new Map();
  for (let i = 0; i < 240; i++) {
    t += PLAY_POLL_MS * 60;
    driver.onHistory({ active: true, timeMs: t, playing: true, rate: 60 });
    await clock.run(PLAY_POLL_MS);
  }
  await driver.settle();
  // 60 s of wall time, 3 layers, 34 frames/min (budget 40 - reserve 6)
  // -> one frame per layer every 5.3 s at most
  const interval = (60_000 * 3) / router.frameBudgetPerMin;
  // (the first second holds the settle polls of entering history)
  for (const call of driver.calls.filter((c) => c.at > start + 1_000)) {
    const prev = at.get(call.layerId);
    if (prev !== undefined)
      assert.ok(
        call.at - prev >= interval - 1,
        `${call.layerId} ${call.at - prev}`,
      );
    at.set(call.layerId, call.at);
  }
  assert.ok(dm.calls.length >= 3 * 9, `refreshes ${dm.calls.length}`);
  assert.ok(
    sliceCalls.length <= router.budgetPerMin + 3,
    `slices ${sliceCalls.length}`,
  );
  // most shown frames were prefetched (cache hits), and the prefetched
  // military frames are interval * rate (= 5.3 min) apart, not every minute
  assert.ok(
    router.getState().stats.cacheHits >= 15,
    JSON.stringify(router.getState().stats),
  );
  const mil = sliceCalls
    .filter((q) => q.feed === 'military')
    .map((q) => Date.parse(q.t));
  const gaps = mil
    .slice(1)
    .map((x, i) => x - mil[i])
    .filter((g) => g > 0);
  assert.ok(
    gaps.filter((g) => g >= 4 * MIN).length >= gaps.length / 2,
    JSON.stringify(gaps),
  );
});
