import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GHOSTMAPS_HISTORY_LAYER_ID,
  createGhostMapsHistory,
  ghostMapsHistoryChip,
} from './ghostMapsHistory.js';
import { createLayerChips } from './layerChips.js';

const T = Date.UTC(2026, 9, 20, 12);

function fakeTimers() {
  let nowMs = T + 10 * 86_400_000;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const end = nowMs + ms;
      for (;;) {
        const next = [...pending.entries()]
          .filter(([, v]) => v.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        nowMs = Math.max(nowMs, next[1].at);
        next[1].fn();
      }
      nowMs = end;
    },
    pending: () => pending.size,
  };
}

function fakeLayer() {
  const layer = {
    times: [],
    history: null,
    listener: null,
    setHistoryTime(t) {
      layer.times.push(t);
      return Promise.resolve();
    },
    getHistoryState: () => layer.history,
    setHistoryListener(fn) {
      layer.listener = fn;
    },
  };
  return layer;
}

function setup() {
  const clock = fakeTimers();
  const layer = fakeLayer();
  const subscribers = new Set();
  const dm = {
    layers: new Map([[GHOSTMAPS_HISTORY_LAYER_ID, { module: layer }]]),
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
  const driver = createGhostMapsHistory({
    getDataManager: () => dm,
    timers: clock,
    now: clock.now,
  });
  return { clock, layer, dm, driver, subscribers };
}

test('a seek is applied once, after the debounce', () => {
  const { clock, layer, driver } = setup();
  driver.onHistory({ active: true, timeMs: T });
  driver.onHistory({ active: true, timeMs: T + 1000 });
  driver.onHistory({ active: true, timeMs: T + 2000 });
  assert.deepEqual(layer.times, []);
  clock.advance(400);
  assert.deepEqual(layer.times, [T + 2000]);
});

test('LIVE goes back at once and clears the chip', () => {
  const { clock, layer, driver } = setup();
  driver.onHistory({ active: true, timeMs: T });
  clock.advance(400);
  layer.history = { status: 'published', committedAt: T, commit: 'a'.repeat(40) };
  assert.equal(driver.historyLayers().length, 1);
  let notified = 0;
  driver.subscribe(() => notified++);
  driver.onHistory({ active: false });
  assert.deepEqual(layer.times, [T, null]);
  assert.deepEqual(driver.historyLayers(), []);
  assert.equal(notified, 1);
  // LIVE again while already live does nothing
  driver.onHistory({ active: false });
  assert.deepEqual(layer.times, [T, null]);
});

test('playing is throttled and reads the moving history time', () => {
  const { clock, layer, driver } = setup();
  driver.onHistory({ active: true, timeMs: T });
  clock.advance(400);
  layer.times.length = 0;
  driver.onHistory({ active: true, timeMs: T, playing: true, rate: 600 });
  clock.advance(400);
  // 250 ms ticks of a playing control
  for (let i = 0; i < 6; i++) {
    clock.advance(250);
    driver.onHistory({ active: true, timeMs: T + 600 * 250 * (i + 1), playing: true, rate: 600 });
  }
  clock.advance(5_000);
  assert.ok(layer.times.length >= 1 && layer.times.length <= 4, `${layer.times.length}`);
  assert.ok(layer.times.every((t, i) => i === 0 || t > layer.times[i - 1]));
});

test('the time is capped at now (history never runs ahead of the clock)', () => {
  const { clock, layer, driver } = setup();
  const start = clock.now();
  driver.onHistory({ active: true, timeMs: start + 3_600_000 });
  clock.advance(400);
  // applied when the 300 ms debounce fired, capped at that wall time
  assert.equal(layer.times[0], start + 300);
});

test('a layer enabled while history is on gets the time again', () => {
  const { clock, layer, driver, subscribers } = setup();
  driver.onHistory({ active: true, timeMs: T });
  clock.advance(400);
  layer.times.length = 0;
  for (const fn of subscribers) fn({ type: 'refresh' });
  clock.advance(400);
  assert.deepEqual(layer.times, [], 'a refresh event is not a lifecycle change');
  for (const fn of subscribers) fn({ type: 'enable', id: GHOSTMAPS_HISTORY_LAYER_ID });
  clock.advance(400);
  assert.deepEqual(layer.times, [T]);
});

test('no layer, no data manager: nothing happens and nothing throws', () => {
  const clock = fakeTimers();
  const driver = createGhostMapsHistory({
    getDataManager: () => null,
    timers: clock,
    now: clock.now,
  });
  driver.onHistory({ active: true, timeMs: T });
  clock.advance(400);
  assert.deepEqual(driver.historyLayers()[0].status, 'pending');
  driver.onHistory({ active: false });
  driver.destroy();
});

test('layer history changes reach subscribers; destroy unhooks', () => {
  const { clock, layer, driver } = setup();
  driver.onHistory({ active: true, timeMs: T });
  clock.advance(400);
  let n = 0;
  driver.subscribe(() => n++);
  layer.listener();
  assert.equal(n, 1);
  driver.destroy();
  assert.equal(layer.listener, null);
});

test('chip text: published, before the archive, unavailable', () => {
  assert.deepEqual(
    ghostMapsHistoryChip({
      status: 'published',
      committedAt: Date.UTC(2026, 9, 23, 20, 47),
      commit: 'ab12cd34ef'.padEnd(40, '0'),
    }),
    { state: 'published', text: 'As published 2026-10-23 20:47Z (GitHub ab12cd3)' },
  );
  assert.equal(
    ghostMapsHistoryChip({ status: 'before', firstCommittedAt: Date.UTC(2025, 4, 20, 16, 37) }).text,
    'Nothing published yet (archive starts 2025-05-20 16:37Z)',
  );
  assert.equal(ghostMapsHistoryChip({ status: 'before' }).text, 'Nothing published yet');
  assert.equal(ghostMapsHistoryChip({ status: 'unavailable' }), null);
  assert.equal(ghostMapsHistoryChip(null), null);
});

// ---- the chip strip ---------------------------------------------------

function chipsFor({ history, enabled = ['s2-ghostmaps', 'flights'] }) {
  const router = {
    adapters: [{ id: 'flights', layerId: 'flights' }],
    getState: () => ({ active: true, served: {} }),
    isSwapped: (id) => id === 'flights',
    isFailed: () => false,
    subscribe: () => () => {},
  };
  const dm = {
    getEnabledLayerIds: () => new Set(enabled),
    getAll: () => [
      { id: 's2-ghostmaps', name: 'S2 GhostMaps' },
      { id: 'flights', name: 'Flights' },
    ],
    subscribe: () => () => {},
  };
  return createLayerChips({
    feedChips: { states: () => [] },
    getRouter: () => router,
    getDataManager: () => dm,
    getHistoryLayers: () => history,
  });
}

test('GhostMaps shows what was published instead of a LIVE chip', () => {
  const chips = chipsFor({
    history: [
      {
        layerId: 's2-ghostmaps',
        status: 'published',
        state: 'published',
        text: 'As published 2026-10-23 20:47Z (GitHub ab12cd3)',
      },
    ],
  }).states();
  const ghost = chips.filter((c) => c.layerId === 's2-ghostmaps');
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0].chip, 'As published 2026-10-23 20:47Z (GitHub ab12cd3)');
  assert.equal(ghost[0].state, 'history-note');
  assert.equal(ghost[0].label, 'S2 GhostMaps');
});

test('before the archive the chip is the empty reason; unavailable shows LIVE', () => {
  const before = chipsFor({
    history: [{ layerId: 's2-ghostmaps', status: 'before', text: 'Nothing published yet' }],
  }).states();
  const b = before.find((c) => c.layerId === 's2-ghostmaps');
  assert.equal(b.state, 'history-empty');
  assert.equal(b.draw, false);
  const down = chipsFor({
    history: [{ layerId: 's2-ghostmaps', status: 'unavailable' }],
  }).states();
  assert.equal(
    down.find((c) => c.layerId === 's2-ghostmaps').chip,
    'LIVE (history unavailable)',
  );
  const pending = chipsFor({
    history: [{ layerId: 's2-ghostmaps', status: 'pending' }],
  }).states();
  assert.equal(pending.find((c) => c.layerId === 's2-ghostmaps').chip, 'LIVE');
});

test('a disabled GhostMaps layer gets no chip', () => {
  const chips = chipsFor({
    enabled: ['flights'],
    history: [
      { layerId: 's2-ghostmaps', status: 'published', state: 'published', text: 'As published x' },
    ],
  }).states();
  assert.equal(chips.filter((c) => c.layerId === 's2-ghostmaps').length, 0);
});
