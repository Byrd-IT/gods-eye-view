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
  // A Cesium viewer has its own canvas; upstream reads it there (#1760).
  get canvas() {
    return this.scene.canvas;
  },
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

test('imagery status suppresses owner exceptions', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const h = harness({
    status: () => {
      throw new Error(secret);
    },
  });
  const result = await h.runner('control_imagery', { action: 'status' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('imagery status copies only allowlisted typed state from an owner', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const h = harness({
    status: async () => ({
      ok: true,
      year: 2018,
      enabled: true,
      compare: true,
      drawn: true,
      yearB: 2024,
      years: [2018, 2024, secret],
      label: secret,
      counties: ['Titus', secret],
      sets: [{ id: 'hist-titus-1940', name: secret, greyscale: true }],
      wayback: {
        available: true,
        on: false,
        date: secret,
        years: [2018, secret],
      },
      error: secret,
      say: secret,
      extra: secret,
      get hostile() {
        throw new Error(secret);
      },
    }),
  });
  const result = await h.runner('control_imagery', { action: 'status' });
  assert.equal(result.ok, true);
  assert.equal(result.year, 2018);
  assert.equal(result.enabled, true);
  assert.equal(result.compare, true);
  assert.equal(result.drawn, true);
  assert.equal(result.yearB, 2024);
  assert.deepEqual(result.years, [2018, 2024]);
  assert.equal(result.countyCount, 2);
  assert.equal(result.setCount, 1);
  assert.equal('counties' in result, false);
  assert.equal('sets' in result, false);
  assert.deepEqual(result.wayback, {
    available: true,
    on: false,
    date: null,
    years: [2018],
  });
  assert.equal('label' in result, false);
  assert.equal('error' in result, false);
  assert.equal('say' in result, false);
  assert.equal('extra' in result, false);
  assert.equal('hostile' in result, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('imagery status drops an untrusted year and replaces an owner error', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const h = harness({
    status: async () => ({
      ok: true,
      year: secret,
      years: [secret],
      wayback: { available: 'yes', date: secret },
    }),
  });
  const result = await h.runner('control_imagery', { action: 'status' });
  assert.equal(result.ok, true);
  assert.equal('year' in result, false);
  assert.deepEqual(result.years, []);
  assert.deepEqual(result.wayback, {
    available: false,
    date: null,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);

  const failed = harness({
    status: async () => ({ ok: false, error: secret }),
  });
  const refused = await failed.runner('control_imagery', { action: 'status' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Imagery status is unavailable');
  assert.equal(JSON.stringify(refused).includes(secret), false);
});

test('control_imagery stays just before control_droneplan and does not reorder control_sky', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  const imagery = names.indexOf('control_imagery');
  assert.ok(imagery > 1);
  assert.equal(names[imagery - 2], 'control_history');
  assert.equal(names[imagery - 1], 'control_sky');
  assert.equal(names[imagery + 1], 'control_droneplan');
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
      assert.match(error.message, /Unknown imagery action/);
      assert.equal(error.message.includes('sk-synth'), false);
      assert.equal(error.message.includes('Bearer'), false);
      return true;
    },
  );
});
