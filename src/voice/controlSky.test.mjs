import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { readHostViewState } from '../agent/worldPacket.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import {
  SKY_PRESET_IDS,
  SKY_VOICE_ACTIONS,
} from '../byrdit/skyView/skyVoice.js';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

function harness({ voiceOverrides = {}, sky = undefined } = {}) {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    // A Cesium viewer has its own canvas; upstream reads it there (#1760).
    get canvas() {
      return this.scene.canvas;
    },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const calls = [];
  const rec =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      return { ok: true, open: true, ...result };
    };
  const voice = {
    status: rec('status', { open: false, lines: true }),
    open: rec('open', { opened: true }),
    close: rec('close', { open: false, closed: true }),
    look: rec('look', { target: 'Jupiter', kind: 'body' }),
    time: rec('time', { time: '2026-10-26T04:00:00.000Z' }),
    lines: rec('lines', { lines: false }),
    preset: rec('preset', { preset: 'sunset' }),
    ...voiceOverrides,
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    ...(sky === undefined ? { sky: () => voice } : { sky }),
  });
  return { runner, calls, voice };
}

test('view state reads untrusted enum and boolean accessors once', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  let skyReads = 0;
  let historyReads = 0;
  let boolReads = 0;
  const state = await readHostViewState({
    sky: {
      status: () => ({
        get timeMode() {
          return ++skyReads === 1 ? 'live' : secret;
        },
        get open() {
          return ++boolReads === 1 ? true : secret;
        },
      }),
    },
    history: {
      status: () => ({
        get mode() {
          return ++historyReads === 1 ? 'history' : secret;
        },
      }),
    },
  });
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(state.sky.timeMode, 'live');
  assert.equal(state.sky.open, true);
  assert.equal(state.historyPlayback.mode, 'history');
});

test('control_sky stays just before control_imagery and does not reorder control_history', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  const sky = names.indexOf('control_sky');
  assert.ok(sky > 0);
  assert.equal(names[sky - 1], 'control_history');
  assert.equal(names[sky + 1], 'control_imagery');
  assert.equal(names[sky + 2], 'control_droneplan');
  const tool = GEV_REALTIME_TOOLS.find((t) => t.name === 'control_sky');
  assert.deepEqual(tool.parameters.properties.action.enum, [
    ...SKY_VOICE_ACTIONS,
  ]);
  assert.deepEqual(tool.parameters.properties.preset.enum, [...SKY_PRESET_IDS]);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.target.maxLength, 80);
  assert.equal(tool.parameters.properties.time.maxLength, 40);
  assert.equal(tool.parameters.properties.enabled.type, 'boolean');
});

test('Sky status suppresses owner exceptions', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const h = harness({
    voiceOverrides: {
      status: () => {
        throw new Error(secret);
      },
    },
  });
  const result = await h.runner('control_sky', { action: 'status' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Sky status copies only allowlisted typed state from an owner', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const h = harness({
    voiceOverrides: {
      status: async () => ({
        ok: true,
        open: true,
        lines: false,
        timeMode: 'live',
        time: '2026-10-26T04:00:00.000Z',
        lookingAt: secret,
        latitude: 32.7,
        longitude: -94.9,
        error: secret,
        say: secret,
        extra: secret,
        get hostile() {
          throw new Error(secret);
        },
      }),
    },
  });
  const result = await h.runner('control_sky', { action: 'status' });
  assert.equal(result.ok, true);
  assert.equal(result.open, true);
  assert.equal(result.lines, false);
  assert.equal(result.timeMode, 'live');
  assert.equal(result.time, '2026-10-26T04:00:00.000Z');
  assert.equal(result.latitude, 32.7);
  assert.equal(result.longitude, -94.9);
  assert.equal(result.lookingAt, null);
  assert.equal('error' in result, false);
  assert.equal('say' in result, false);
  assert.equal('extra' in result, false);
  assert.equal('hostile' in result, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Sky status omits arbitrary catalog labels and replaces a bad owner error', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const h = harness({
    voiceOverrides: {
      status: async () => ({
        ok: true,
        open: true,
        lookingAt: 'Jupiter',
        timeMode: secret,
        time: secret,
        latitude: secret,
        longitude: secret,
      }),
    },
  });
  const safe = await h.runner('control_sky', { action: 'status' });
  assert.equal(safe.lookingAt, null);
  assert.equal('timeMode' in safe, false);
  assert.equal('time' in safe, false);
  assert.equal('latitude' in safe, false);
  assert.equal('longitude' in safe, false);
  assert.equal(JSON.stringify(safe).includes(secret), false);

  const failed = harness({
    voiceOverrides: {
      status: async () => ({ ok: false, error: secret }),
    },
  });
  const refused = await failed.runner('control_sky', { action: 'status' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Sky status is unavailable');
  assert.equal(JSON.stringify(refused).includes(secret), false);
});

test('Sky status reads hostile accessors once', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  let reads = 0;
  const h = harness({
    voiceOverrides: {
      status: async () => ({
        ok: true,
        get timeMode() {
          return ++reads === 1 ? 'live' : secret;
        },
      }),
    },
  });
  const result = await h.runner('control_sky', { action: 'status' });
  assert.equal(reads, 1);
  assert.equal(result.timeMode, 'live');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('new Sky calls suppress owner exceptions and report absent adapters', async () => {
  const secret = 'SYNTHETIC_TOKEN_SUFFIXABC123';
  const h = harness({
    voiceOverrides: {
      playback: () => {
        throw new Error(secret);
      },
    },
  });
  const result = await h.runner('control_sky', { action: 'play' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    (await h.runner('control_sky', { action: 'layers', layer: 'grid' })).ok,
    false,
  );
  const nullAdapter = harness({ voiceOverrides: { playback: () => null } });
  assert.equal(
    (await nullAdapter.runner('control_sky', { action: 'play' })).ok,
    false,
  );
});

test('control_sky open, close, look, time, lines, preset and status reach Sky', async () => {
  const h = harness();
  assert.equal(
    (await h.runner('control_sky', { action: 'open' })).opened,
    true,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'close' })).closed,
    true,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'look', target: 'Jupiter' }))
      .target,
    'Jupiter',
  );
  assert.equal(
    (
      await h.runner('control_sky', {
        action: 'time',
        time: '2026-10-26T04:00:00Z',
      })
    ).ok,
    true,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'lines', enabled: false })).lines,
    false,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'preset', preset: 'sunset' }))
      .preset,
    'sunset',
  );
  assert.equal((await h.runner('control_sky', { action: 'status' })).ok, true);
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ['open', 'close', 'look', 'time', 'lines', 'preset', 'status'],
  );
  assert.deepEqual(h.calls[2], ['look', 'Jupiter']);
  assert.deepEqual(h.calls[3], [
    'time',
    { time: '2026-10-26T04:00:00Z', live: undefined },
  ]);
  assert.deepEqual(h.calls[4], ['lines', false]);
  assert.deepEqual(h.calls[5], ['preset', 'sunset']);
});

test('control_sky actions are case-insensitive; an unknown action throws a short token', async () => {
  const h = harness();
  assert.equal((await h.runner('control_sky', { action: 'CLOSE' })).ok, true);
  await assert.rejects(
    () => h.runner('control_sky', { action: 'rewind' }),
    /Unknown sky action/,
  );
  await assert.rejects(() => h.runner('control_sky', {}), /Unknown sky action/);
  await assert.rejects(
    () => h.runner('control_sky', { action: 'Bearer SECRETKEY123' }),
    /Unknown sky action/,
  );
});

test('control_sky without a Sky view in this host says so', async () => {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    // A Cesium viewer has its own canvas; upstream reads it there (#1760).
    get canvas() {
      return this.scene.canvas;
    },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const dataManager = { layers: new Map(), getAll: () => [] };
  for (const sky of [undefined, () => null]) {
    const runner = createGevActionRunner({
      viewer,
      styleManager: {},
      dataManager,
      sky,
    });
    const r = await runner('control_sky', { action: 'open' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'control_sky');
    assert.match(r.error, /not available/);
  }
});

test('control_sky passes live through and does not invent a target', async () => {
  const h = harness();
  await h.runner('control_sky', { action: 'time', live: true });
  assert.deepEqual(h.calls[0], ['time', { time: undefined, live: true }]);
  await h.runner('control_sky', { action: 'look' });
  assert.deepEqual(h.calls[1], ['look', undefined]);
});
