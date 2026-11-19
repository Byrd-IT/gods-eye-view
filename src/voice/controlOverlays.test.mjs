import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { OVERLAY_VOICE_ACTIONS } from '../byrdit/basemap/overlaysVoice.js';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

const VIEWER = {
  clock: { onTick: { addEventListener: () => () => {} } },
  scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  get canvas() {
    return this.scene.canvas;
  },
  camera: { moveEnd: { addEventListener() {} } },
};

const SECRET = 'sk-ant-secret-Bearer-not-an-overlay';

function harness(overlays) {
  const runner = createGevActionRunner({
    viewer: VIEWER,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    overlays,
  });
  return runner;
}

test('the overlay tool offers exactly the adapter actions', () => {
  const tool = GEV_REALTIME_TOOLS.find(
    (item) => item.name === 'control_overlays',
  );
  assert.ok(tool, 'the control_overlays tool is published');
  assert.deepEqual(tool.parameters.properties.action.enum, [
    ...OVERLAY_VOICE_ACTIONS,
  ]);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.description);
});

test('control_overlays dispatches to the overlay adapter and wraps the action', async () => {
  const calls = [];
  const runner = harness(() => ({
    enable: (args) => {
      calls.push(args);
      return { ok: true, overlayId: 'hillshade', enabled: true };
    },
    opacity: (args) => {
      calls.push(args);
      return { ok: true, overlayId: 'hillshade', opacityPct: 40 };
    },
    status: () => ({ ok: true, overlays: [] }),
  }));
  const enabled = await runner('control_overlays', {
    action: 'enable',
    overlayId: 'hillshade',
    enabled: true,
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.action, 'control_overlays');
  assert.equal(enabled.overlayId, 'hillshade');
  const faded = await runner('control_overlays', {
    action: 'opacity',
    overlayId: 'hillshade',
    opacityPct: 40,
  });
  assert.equal(faded.opacityPct, 40);
  assert.deepEqual(calls, [
    { action: 'enable', overlayId: 'hillshade', enabled: true },
    { action: 'opacity', overlayId: 'hillshade', opacityPct: 40 },
  ]);
});

test('control_overlays reports the overlays as unavailable without an adapter', async () => {
  for (const overlays of [null, undefined, () => null]) {
    const result = await harness(overlays)('control_overlays', {
      action: 'status',
    });
    assert.equal(result.ok, false);
    assert.equal(result.unavailable, true);
    assert.match(result.error, /map overlays/i);
  }
});

test('control_overlays refuses an action the adapter does not have', async () => {
  const runner = harness(() => ({ status: () => ({ ok: true }) }));
  const result = await runner('control_overlays', { action: 'teleport' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown map overlay action/i);
  const missing = await runner('control_overlays', {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /unknown map overlay action/i);
});

test('control_overlays contains provider and adapter exceptions without leaking', async () => {
  const providers = [
    () => {
      throw new Error(SECRET);
    },
    () => ({
      status: () => {
        throw new Error(SECRET);
      },
    }),
  ];
  for (const provider of providers) {
    const result = await harness(provider)('control_overlays', {
      action: 'status',
    });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('control_overlays reports an adapter refusal as a refusal', async () => {
  const runner = harness(() => ({
    enable: () => ({
      ok: false,
      error: 'There is no map overlay with that name.',
      overlays: [{ id: 'hillshade', name: 'Hillshade 1 m lidar' }],
    }),
  }));
  const result = await runner('control_overlays', {
    action: 'enable',
    overlayId: 'nope',
    enabled: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no map overlay/i);
  assert.deepEqual(result.overlays, [
    { id: 'hillshade', name: 'Hillshade 1 m lidar' },
  ]);
});
