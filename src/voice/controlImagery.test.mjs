import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { IMAGERY_VOICE_ACTIONS } from '../byrdit/basemap/imageryVoice.js';

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

const SECRET = 'Bearer sk-synthTEST123suffix';

function harness(imagery) {
  const voice =
    imagery === undefined
      ? {
          async year(args) {
            return { ok: true, actionSeen: 'year', year: args.year };
          },
          async wayback(args) {
            return { ok: true, actionSeen: 'wayback', date: args.date };
          },
          async off(args) {
            return { ok: true, actionSeen: 'off', target: args.target };
          },
          async status() {
            return { ok: true, actionSeen: 'status', years: [1940, 2024] };
          },
        }
      : imagery;
  const runner = createGevActionRunner({
    viewer: VIEWER,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    imagery: () => voice,
  });
  return { runner, voice };
}

test('control_imagery is the last Realtime tool and does not reorder control_sky', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  assert.equal(names.at(-1), 'control_imagery');
  assert.equal(names.at(-2), 'control_sky');
  assert.equal(names.at(-3), 'control_history');
  const tool = GEV_REALTIME_TOOLS.find(
    (item) => item.name === 'control_imagery',
  );
  assert.deepEqual(tool.parameters.properties.action.enum, [
    ...IMAGERY_VOICE_ACTIONS,
  ]);
  assert.equal(tool.parameters.properties.year.type, 'integer');
  assert.equal(tool.parameters.properties.year.enum, undefined);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
});

test('year, wayback, off and status reach the imagery adapter', async () => {
  const { runner } = harness();
  assert.equal(
    (await runner('control_imagery', { action: 'year', year: 2018 })).year,
    2018,
  );
  assert.equal(
    (await runner('control_imagery', { action: 'wayback', date: '2014' })).date,
    '2014',
  );
  assert.equal(
    (await runner('control_imagery', { action: 'off', target: 'aerial' }))
      .target,
    'aerial',
  );
  assert.deepEqual(
    (await runner('control_imagery', { action: 'status' })).years,
    [1940, 2024],
  );
});

test('a missing imagery host and an unknown action do not echo caller text', async () => {
  const bare = createGevActionRunner({
    viewer: VIEWER,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    imagery: () => null,
  });
  const missing = await bare('control_imagery', {
    action: 'year',
    county: SECRET,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not available in this host/);
  assert.equal(JSON.stringify(missing).includes('sk-synth'), false);
  const { runner } = harness();
  await assert.rejects(
    () => runner('control_imagery', { action: SECRET }),
    (error) => {
      assert.match(error.message, /Unknown imagery action: missing/);
      assert.equal(error.message.includes('sk-synth'), false);
      assert.equal(error.message.includes('Bearer'), false);
      return true;
    },
  );
});
