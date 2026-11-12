import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';

function harness(source) {
  const viewer = {
    dataSources: {
      add() {},
      remove() {},
    },
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer };
}

const reading = (id, overrides = {}) => ({
  id: `eccc:${id}`,
  provider: 'eccc',
  scale: 'AQHI',
  value: 2,
  band: 'low',
  stationId: id,
  name: id,
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  observedMs: Date.now() - 60_000,
  color: '#4cc9f0',
  label: '2',
  risk: 'Low health risk',
  note: null,
  ...overrides,
});

test('a stale ES-copy answer reaches the layer status', async () => {
  let call = 0;
  const source = {
    getSnapshot: async () => [reading('A')],
    getSnapshotDetail: async () => ({
      readings: [reading('A')],
      stale: ++call === 1,
      retryAfterSec: call === 1 ? 75 : null,
    }),
  };
  const h = harness(source);
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().retryAfterSec, 75);
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().retryAfterSec, null);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  h.layer.destroy();
});

test('a legacy snapshot-only source keeps its observation-time judgement', async () => {
  const h = harness({ getSnapshot: async () => [reading('A')] });
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy();
});

test('destroy clears ES-copy staleness and retry metadata', async () => {
  const h = harness({
    getSnapshot: async () => [reading('A')],
    getSnapshotDetail: async () => ({ readings: [reading('A')], stale: true, retryAfterSec: 60 }),
  });
  await h.layer.update();
  h.layer.destroy();
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().retryAfterSec, null);
});

test('untrusted source errors do not enter logs or status', async () => {
  const secret = 'fake-user:fake-password@host?api_key=FAKE_KEY_SUFFIX';
  const source = { getSnapshot: async () => [], getSnapshotDetail: async () => { throw new Error(secret); } };
  const h = harness(source); const warnings = []; const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await h.layer.update(h.viewer);
    assert.equal(JSON.stringify(h.layer.getStats()).includes(secret), false);
    assert.equal(warnings.join('\n').includes(secret), false);
  } finally { console.warn = original; h.layer.destroy(); }
});
