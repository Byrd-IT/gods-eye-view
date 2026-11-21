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
import { validateArgs } from '../../scripts/voice-bench/grade.mjs';

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

test('the drone plan schema states no bound the panel does not have', () => {
  const params = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_droneplan',
  ).parameters;
  const { ring, index } = params.properties;
  // One ring argument serves polygon and path. A path is two or more points
  // (panel.js addLookAtPath), a polygon three or more (polygon.js, enforced
  // by the adapter); the panel's drawing tool has no upper corner count.
  assert.equal(ring.minItems, 2);
  assert.equal(ring.maxItems, undefined);
  const twoPoints = [
    { lon: -94.9, lat: 32.7 },
    { lon: -94.91, lat: 32.71 },
  ];
  assert.deepEqual(
    validateArgs(params, { action: 'path', ring: twoPoints }),
    [],
    'a two-point path is a real panel action',
  );
  assert.ok(
    validateArgs(params, { action: 'path', ring: twoPoints.slice(0, 1) }).length >
      0,
    'one point is not a path',
  );
  const many = Array.from({ length: 120 }, (_, i) => ({
    lon: -94.9 + i * 0.00001,
    lat: 32.7,
  }));
  assert.deepEqual(validateArgs(params, { action: 'polygon', ring: many }), []);
  // A list index is bounded by that list, which the panel reports at call
  // time: a plan with more than sixty missions or photos makes index 60 real.
  assert.equal(index.minimum, 0);
  assert.equal(index.maximum, undefined);
  assert.deepEqual(validateArgs(params, { action: 'preview', index: 60 }), []);
  assert.deepEqual(validateArgs(params, { action: 'check', index: 60 }), []);
  assert.ok(
    validateArgs(params, { action: 'preview', index: -1 }).length > 0,
    'a negative position is not a list index',
  );
});
