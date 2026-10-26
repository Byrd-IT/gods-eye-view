import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
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

test('control_sky is the last Realtime tool and does not reorder control_history', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  assert.equal(names.at(-1), 'control_sky');
  assert.equal(names.at(-2), 'control_history');
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
    /Unknown sky action: rewind/,
  );
  await assert.rejects(
    () => h.runner('control_sky', {}),
    /Unknown sky action: missing/,
  );
  await assert.rejects(
    () => h.runner('control_sky', { action: 'Bearer SECRETKEY123' }),
    /Unknown sky action: missing/,
  );
});

test('control_sky without a Sky view in this host says so', async () => {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
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
