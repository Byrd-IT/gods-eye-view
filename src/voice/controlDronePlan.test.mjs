import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import {
  DRONEPLAN_VOICE_ACTIONS,
  createDronePlanVoice,
} from '../byrdit/dronePlan/dronePlanVoice.js';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

const VIEWER = {
  clock: { onTick: { addEventListener: () => () => {} } },
  scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  // A Cesium viewer has its own canvas; upstream reads it there (#1760).
  get canvas() {
    return this.scene.canvas;
  },
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

test('control_droneplan stays before the appended view tools without reordering imagery', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  // The navigation, solunar and map overlay voice tools this release appends
  // land after the clean-view and opacity pair, so the tail is now ten
  // tools long.
  assert.deepEqual(names.slice(-10), [
    'control_history',
    'control_sky',
    'control_imagery',
    'control_droneplan',
    'set_clean_view',
    'set_layer_opacity',
    'control_nav',
    'control_solunar',
    'control_overlays',
    'control_ghostmaps',
  ]);
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
  assert.equal(
    (await runner('control_droneplan', { action: 'open' })).open,
    true,
  );
  assert.equal(
    (await runner('control_droneplan', { action: 'close' })).cleared,
    true,
  );
  assert.equal(
    (await runner('control_droneplan', { action: 'status' })).aircraft,
    'DJI Mini 5 Pro',
  );
  assert.equal(
    (
      await runner('control_droneplan', {
        action: 'download',
        which: 'mission',
      })
    ).downloaded,
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

test('control_droneplan option bounds are the panel sliders, not guesswork', async () => {
  const panel = readFileSync(
    new URL('../byrdit/dronePlan/panel.js', import.meta.url),
    'utf8',
  );
  // The four sliders the voice options mirror, as panel.js builds them.
  assert.match(panel, /slider\(t\('Front overlap'\), 50, 98, 0\.5\)/);
  assert.match(panel, /slider\(t\('Side overlap'\), 40, 95, 1\)/);
  assert.match(panel, /slider\(t\('Camera tilt'\), -80, -45, 5\)/);
  assert.match(panel, /minM: 10,\s*maxM: 300,/);

  const props = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_droneplan',
  ).parameters.properties;
  assert.equal(props.frontOverlap.minimum, 50);
  assert.equal(props.frontOverlap.maximum, 98);
  assert.equal(props.sideOverlap.minimum, 40);
  assert.equal(props.sideOverlap.maximum, 95);
  assert.equal(props.tiltPitchDeg.minimum, -80);
  assert.equal(props.tiltPitchDeg.maximum, -45);
  assert.equal(props.orbitRadiusM.minimum, 10);
  assert.equal(props.orbitRadiusM.maximum, 300);

  // The voice validation uses the same ends: 98% is a panel value, 98.1 is not.
  const state = {
    open: true,
    areas: [],
    options: { presetId: 'dji-mini-5-pro', frontOverlap: 80 },
  };
  const calls = [];
  const voice = createDronePlanVoice({
    isOpen: () => true,
    getState: () => state,
    open() {},
    applyOptions(patch) {
      calls.push(patch);
      Object.assign(state.options, patch);
      return true;
    },
    replan: async () => {},
  });
  assert.equal((await voice.options({ frontOverlap: 98 })).ok, true);
  assert.equal(calls.at(-1).frontOverlap, 98);
  assert.equal((await voice.options({ frontOverlap: 98.1 })).ok, false);
});
