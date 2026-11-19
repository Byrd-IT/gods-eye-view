import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { GHOSTMAPS_AGE_OPTIONS } from '../layers/ghostMaps/records.js';
import {
  GHOSTMAPS_PRODUCTS,
  GHOSTMAPS_LATEST_DROP,
} from '../layers/ghostMaps/catalog.js';

const viewer = {
  clock: { onTick: { addEventListener: () => () => {} } },
  scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  get canvas() {
    return this.scene.canvas;
  },
  camera: { moveEnd: { addEventListener() {} } },
};
globalThis.window ||= { clearTimeout, setTimeout };
const ids = [...GHOSTMAPS_PRODUCTS, GHOSTMAPS_LATEST_DROP].map((p) => p.id);
test('GhostMaps tool schema tracks actual catalog and typed age options', () => {
  const schema = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_ghostmaps',
  ).parameters.properties;
  assert.deepEqual(schema.product.enum, ids);
  assert.equal(schema.ageDays.type, 'string');
  assert.deepEqual(
    schema.ageDays.enum,
    GHOSTMAPS_AGE_OPTIONS.map((age) => (age === null ? 'all' : String(age))),
  );
});
function harness() {
  const state = new Map(ids.map((id) => [id, false]));
  let age = '7';
  const module = {
    getRowControls: () => ({
      chips: ids.map((id) => ({
        id,
        active: state.get(id),
        onClick: () => state.set(id, !state.get(id)),
      })),
      segmented: {
        options: ['1', '3', '7', '14', '30', 'all'].map((value) => ({
          id: `age-${value}`,
          active: age === value,
          onClick: () => {
            age = value;
          },
        })),
      },
    }),
  };
  const dataManager = {
    layers: new Map([['s2-ghostmaps', { enabled: true, module }]]),
    getAll: () => [],
  };
  return {
    run: createGevActionRunner({ viewer, styleManager: {}, dataManager }),
    state,
    dataManager,
  };
}
test('all products toggle without changing other products and return current state', async () => {
  const { run, state } = harness();
  for (const product of ids) {
    assert.equal(
      (await run('control_ghostmaps', { product, enabled: true })).ok,
      true,
    );
    assert.equal(state.get(product), true);
  }
  assert.equal([...state.values()].every(Boolean), true);
  await run('control_ghostmaps', { product: ids[0], enabled: false });
  assert.equal(state.get(ids[0]), false);
  assert.equal(state.get(ids[1]), true);
});
test('all age settings apply, invalid requests refuse and no layer reports unavailable', async () => {
  const { run, dataManager } = harness();
  for (const ageDays of ['1', '3', '7', '14', '30', 'all']) {
    const result = await run('control_ghostmaps', { ageDays });
    assert.equal(result.ok, true);
    assert.equal(result.ageDays, String(ageDays));
  }
  assert.equal((await run('control_ghostmaps', { ageDays: '2' })).ok, false);
  assert.equal((await run('control_ghostmaps', { ageDays: 7 })).ok, false);
  assert.equal(
    (await run('control_ghostmaps', { product: 'bad', enabled: true })).ok,
    false,
  );
  dataManager.layers.clear();
  assert.equal((await run('control_ghostmaps', {})).ok, false);
});

test('read-back reports product error and loading states without raw errors', async () => {
  const { run, dataManager } = harness();
  dataManager.layers.get('s2-ghostmaps').module.getRowControls = () => ({
    chips: [
      {
        id: 'cip',
        active: true,
        state: 'error',
        title: 'private failure detail',
      },
      { id: 'iran-cip', active: true, busy: true },
    ],
    segmented: { options: [{ id: 'age-7', active: true }] },
  });
  const result = await run('control_ghostmaps', {});
  assert.equal(result.ok, true);
  assert.equal(result.products[0].state, 'error');
  assert.equal(result.products[1].busy, true);
  assert.match(result.say, /failed/);
  assert.equal(
    JSON.stringify(result).includes('private failure detail'),
    false,
  );
});

test('no-op callbacks and exceptions do not report success or expose details', async () => {
  const { run, dataManager } = harness();
  const module = dataManager.layers.get('s2-ghostmaps').module;
  module.getRowControls = () => ({
    chips: [{ id: 'cip', active: false, onClick() {} }],
    segmented: { options: [] },
  });
  assert.equal(
    (await run('control_ghostmaps', { product: 'cip', enabled: true })).ok,
    false,
  );
  module.getRowControls = () => {
    throw new Error('synthetic-exception');
  };
  const failed = await run('control_ghostmaps', {});
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes('synthetic-exception'), false);
});
