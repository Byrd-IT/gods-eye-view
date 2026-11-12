import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';

function harness(source) {
  const overlayCalls = [];
  const viewer = {
    dataSources: {
      add() {},
      remove() {},
    },
  };
  const layer = createEarthquakesLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        overlayCalls.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer };
}

const row = {
  stableId: 'event-a',
  usgsId: 'event-a',
  lon: 30,
  lat: 20,
  depthKm: 3,
  mag: 4,
  place: 'Fixture',
  time: 1000,
};

test('a stale ES-copy answer reaches the layer status', async () => {
  let call = 0;
  const source = {
    getSnapshot: async () => [row],
    getSnapshotDetail: async () => ({
      rows: [row],
      stale: ++call === 1,
      retryAfterSec: call === 1 ? 75 : null,
    }),
  };
  const h = harness(source);
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().retryAfterSec, 75);
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().retryAfterSec, null);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  h.layer.destroy();
});

test('a legacy snapshot-only source reports no staleness', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy();
});
test('a superseded stale answer must not overwrite the fresh status', async () => {
  let call = 0;
  let release1 = null;
  const source = {
    getSnapshot: async () => [row],
    getSnapshotDetail: () => {
      call++;
      if (call === 1) {
        // First request: hang until the test releases it, so its stale
        // answer settles only after a newer request has already
        // committed its status.
        return new Promise((resolve) => {
          release1 = () => resolve({ rows: [row], stale: true, retryAfterSec: 90 });
        });
      }
      return { rows: [row], stale: false, retryAfterSec: null };
    },
  };
  const h = harness(source);
  const first = h.layer.update(h.viewer);
  const second = h.layer.update(h.viewer); // supersedes in-flight first
  await second;
  assert.equal(h.layer.getStats().stale, false);
  release1(); // superseded request finally answers stale
  await first;
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().retryAfterSec, null);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  h.layer.destroy();
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
