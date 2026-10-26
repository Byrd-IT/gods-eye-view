import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { ALL_HISTORY_ADAPTERS } from '../byrdit/historyUi/historyEventAdapters.js';
import { VOICE_TOGGLE_LAYER_IDS } from './layerManifest.js';

globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };

const FEEDS = ALL_HISTORY_ADAPTERS.map((a) => a.layerId);

function harness({ failLayers = [], voiceOverrides = {} } = {}) {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const on = new Set();
  const order = [];
  const dataManager = {
    layers: new Map(FEEDS.map((id) => [id, { module: {} }])),
    getAll: () => FEEDS.map((id) => ({ id, name: id, enabled: on.has(id) })),
    getLayerLifecycleState: (id) => ({
      enabled: on.has(id),
      lifecycleState: on.has(id) ? 'enabled' : 'disabled',
      uncertain: false,
    }),
    async setEnabled(id, value) {
      order.push([id, value]);
      if (failLayers.includes(id)) return false;
      if (value) on.add(id);
      else on.delete(id);
      return true;
    },
  };
  const calls = [];
  const rec =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args]);
      return { ok: true, ...result };
    };
  const voice = {
    feedLayerIds: () => FEEDS,
    status: rec('status', { mode: 'live' }),
    jump: rec('jump', { mode: 'history' }),
    play: rec('play', { playing: true }),
    pause: rec('pause', { playing: false }),
    speed: rec('speed', { rate: 60 }),
    live: rec('live', { mode: 'live' }),
    ...voiceOverrides,
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager,
    history: () => voice,
  });
  return { runner, calls, on, order, voice };
}

test('the tool schema names exactly the history feed layers, all voice-toggleable', () => {
  const tool = GEV_REALTIME_TOOLS.find((t) => t.name === 'control_history');
  assert.ok(tool, 'control_history is a Realtime tool');
  assert.deepEqual(tool.parameters.properties.feeds.items.enum, FEEDS);
  for (const id of FEEDS) assert.ok(VOICE_TOGGLE_LAYER_IDS.includes(id), id);
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'jump', 'play', 'pause', 'speed', 'live', 'status', 'feeds',
  ]);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.rate.enum, [1, 10, 60, 600]);
});

test('control_history jump passes time or minutesAgo to History', async () => {
  const h = harness();
  const r = await h.runner('control_history', { action: 'jump', time: '2026-03-04T15:30:00Z' });
  assert.equal(r.action, 'control_history');
  assert.equal(r.ok, true);
  await h.runner('control_history', { action: 'jump', minutesAgo: 90 });
  assert.deepEqual(h.calls, [
    ['jump', { time: '2026-03-04T15:30:00Z', minutesAgo: undefined }],
    ['jump', { time: undefined, minutesAgo: 90 }],
  ]);
});

test('control_history play, pause, speed, live and status reach their History call', async () => {
  const h = harness();
  assert.equal((await h.runner('control_history', { action: 'play' })).playing, true);
  assert.equal((await h.runner('control_history', { action: 'pause' })).playing, false);
  assert.equal((await h.runner('control_history', { action: 'speed', rate: 60 })).rate, 60);
  assert.equal((await h.runner('control_history', { action: 'live' })).mode, 'live');
  assert.equal((await h.runner('control_history', { action: 'status' })).ok, true);
  assert.deepEqual(h.calls.map((c) => c[0]), ['play', 'pause', 'speed', 'live', 'status']);
  assert.deepEqual(h.calls[2], ['speed', 60]);
});

test('control_history actions are case-insensitive; an unknown action throws like its siblings', async () => {
  const h = harness();
  assert.equal((await h.runner('control_history', { action: 'PAUSE' })).ok, true);
  await assert.rejects(() => h.runner('control_history', { action: 'rewind' }), /Unknown history action: rewind/);
  await assert.rejects(() => h.runner('control_history', {}), /Unknown history action: missing/);
});

test('control_history without a History in this host says so', async () => {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const dataManager = { layers: new Map(), getAll: () => [] };
  for (const history of [undefined, () => null]) {
    const runner = createGevActionRunner({ viewer, styleManager: {}, dataManager, history });
    const r = await runner('control_history', { action: 'play' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'control_history');
    assert.match(r.error, /not available/);
  }
});

test('feeds only: lists turn on, every other history feed turns off', async () => {
  const h = harness();
  for (const id of ['transit', 'wind']) h.on.add(id);
  const r = await h.runner('control_history', { action: 'feeds', feeds: ['flights', 'ais-live-vessels'] });
  assert.equal(r.ok, true);
  assert.equal(r.feedMode, 'only');
  assert.equal(r.mode, 'live', 'History state rides along');
  assert.deepEqual([...h.on].sort(), ['ais-live-vessels', 'flights']);
  assert.deepEqual(r.changed.filter((c) => c.enabled).map((c) => c.layerId), ['flights', 'ais-live-vessels']);
  assert.equal(r.changed.filter((c) => !c.enabled).length, FEEDS.length - 2);
  assert.deepEqual(h.calls.at(-1), ['status'], 'ends with the History state');
});

test('feeds add turns only the named feeds on; remove turns only them off', async () => {
  const h = harness();
  h.on.add('wind');
  await h.runner('control_history', { action: 'feeds', feeds: ['military'], feedMode: 'add' });
  assert.deepEqual([...h.on].sort(), ['military', 'wind']);
  const r = await h.runner('control_history', { action: 'feeds', feeds: ['wind'], feedMode: 'remove' });
  assert.equal(r.ok, true);
  assert.deepEqual([...h.on], ['military']);
});

test('feeds accept common names and dedupe', async () => {
  const h = harness();
  const r = await h.runner('control_history', { action: 'feeds', feeds: ['ships', 'vessels', 'fires'], feedMode: 'add' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...h.on].sort(), ['ais-live-vessels', 'local-firms']);
});

test('feeds refuse a layer that has no history, an empty list and a bad mode, changing nothing', async () => {
  const h = harness();
  const notFeed = await h.runner('control_history', { action: 'feeds', feeds: ['flights', 'cctv'] });
  assert.equal(notFeed.ok, false);
  assert.match(notFeed.error, /Not a History feed: cctv/);
  assert.deepEqual(notFeed.feedLayers, FEEDS);
  const empty = await h.runner('control_history', { action: 'feeds', feeds: [] });
  assert.equal(empty.ok, false);
  const none = await h.runner('control_history', { action: 'feeds' });
  assert.equal(none.ok, false);
  const mode = await h.runner('control_history', { action: 'feeds', feeds: ['flights'], feedMode: 'toggle' });
  assert.equal(mode.ok, false);
  assert.deepEqual(h.order, [], 'a refused request toggles no layer');
});

test('feeds report a layer that would not switch, and keep going', async () => {
  const h = harness({ failLayers: ['military'] });
  const r = await h.runner('control_history', { action: 'feeds', feeds: ['flights', 'military'], feedMode: 'add' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map((f) => f.layerId), ['military']);
  assert.deepEqual(r.changed.map((c) => c.layerId), ['flights']);
  assert.ok(h.on.has('flights'));
});
