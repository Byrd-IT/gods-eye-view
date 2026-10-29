import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { DRONEPLAN_VOICE_ACTIONS } from '../byrdit/dronePlan/dronePlanVoice.js';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

const VIEWER = {
  clock: { onTick: { addEventListener: () => () => {} } },
  scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  camera: { moveEnd: { addEventListener() {} } },
};

const SECRET = 'sk-ant-secret-Bearer-not-a-drone';

function harness(dronePlan) {
  const voice =
    dronePlan === undefined
      ? {
          async open() {
            return { ok: true, open: true };
          },
          async close() {
            return { ok: true, open: false, cleared: true };
          },
          async status() {
            return { ok: true, aircraft: 'DJI Mini 5 Pro' };
          },
          async download() {
            return { ok: true, downloaded: false };
          },
        }
      : dronePlan;
  const runner = createGevActionRunner({
    viewer: VIEWER,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    dronePlan: () => voice,
  });
  return { runner, voice };
}

test('control_droneplan is the last Realtime tool and does not reorder control_imagery', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  assert.equal(names.at(-1), 'control_droneplan');
  assert.equal(names.at(-2), 'control_imagery');
  assert.equal(names.at(-3), 'control_sky');
  assert.equal(names.at(-4), 'control_history');
  const tool = GEV_REALTIME_TOOLS.find(
    (item) => item.name === 'control_droneplan',
  );
  assert.deepEqual(tool.parameters.properties.action.enum, [
    ...DRONEPLAN_VOICE_ACTIONS,
  ]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.match(tool.description, /NOT FLIGHT-TESTED/);
  assert.match(realtimeInstructions(), /control_droneplan/);
  assert.match(realtimeInstructions(), /NOT FLIGHT-TESTED/);
});

test('control_droneplan dispatches to the panel adapter and wraps the action', async () => {
  const { runner } = harness();
  assert.equal((await runner('control_droneplan', { action: 'open' })).open, true);
  assert.equal(
    (await runner('control_droneplan', { action: 'close' })).cleared,
    true,
  );
  assert.equal(
    (await runner('control_droneplan', { action: 'status' })).aircraft,
    'DJI Mini 5 Pro',
  );
  assert.equal(
    (await runner('control_droneplan', { action: 'download', which: 'mission' }))
      .downloaded,
    false,
  );
});

test('a missing Drone Flight Plan host does not repeat the request', async () => {
  const { runner: bare } = harness(null);
  const missing = await bare('control_droneplan', {
    action: 'options',
    aircraft: SECRET,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not available in this host/);
  assert.equal(JSON.stringify(missing).includes(SECRET), false);
});

test('an unknown drone plan action does not repeat a secret token', async () => {
  const { runner } = harness();
  await assert.rejects(
    () => runner('control_droneplan', { action: SECRET }),
    (err) => {
      assert.match(err.message, /Unknown drone plan action: missing/);
      assert.equal(err.message.includes(SECRET), false);
      return true;
    },
  );
});
