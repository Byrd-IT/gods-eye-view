// The coverage layer and drag selection on the contract's stub renderer:
// the draw items, the click routing and the selection go through the real
// ports (draw, query, input dispatcher), not hand-made fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';
import { createCoverageLayer } from './layer.js';
import { beginScreenSelection } from './screenSelection.js';

const state = () => ({
  meta: { origin: { lat: 32.6907, lon: -95.1527 }, ground_z: 0 },
  photos: [
    {
      name: 'a.jpg',
      lat: 32.6907,
      lon: -95.1527,
      x: 0,
      y: 0,
      z: 40,
      fwd: [1, 0, -1],
      placed: true,
      flags: [],
    },
    {
      name: 'gps.jpg',
      lat: 32.6909,
      lon: -95.1529,
      z: 40,
      placed: false,
    },
  ],
  cells: { nx: 1, ny: 1, x0: 0, y0: 0, cell_m: 3, k: [0] },
  counts: [6],
  mask: new Set([0]),
  discarded: new Set(),
});

function scene() {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  renderer.testing.setHeights(() => 120);
  return { renderer, viewer };
}

test('stub renderer: the layer draws its contract sets and gives them back', async () => {
  const { renderer, viewer } = scene();
  const layer = await createCoverageLayer({ viewer, state: state() });
  const ids = renderer.testing.sets().filter((id) => id.startsWith('photo-'));
  assert.deepEqual(ids.sort(), [
    'photo-coverage-cameras',
    'photo-coverage-cells',
    'photo-coverage-directions',
  ]);
  const cameras = renderer.testing.setRecord('photo-coverage-cameras');
  assert.ok(cameras, 'camera set recorded');
  layer.destroy();
  layer.destroy();
  assert.deepEqual(
    renderer.testing.sets().filter((id) => id.startsWith('photo-')),
    [],
  );
});

test('stub renderer: a placed camera projects on screen; the GPS-only one never does', async () => {
  const { renderer, viewer } = scene();
  renderer.camera.setView({
    destination: { lon: -95.1527, lat: 32.6907, height: 1500 },
  });
  const layer = await createCoverageLayer({ viewer, state: state() });
  const points = layer.screenPoints();
  assert.deepEqual(
    points.map((p) => p.name),
    ['a.jpg'],
  );
  const [{ x, y }] = points;
  // Straight down over the camera: it projects near the middle of 1280x720.
  assert.ok(Math.abs(x - 640) < 5 && Math.abs(y - 360) < 5, `${x},${y}`);
  layer.destroy();
});

test('a viewer with no renderer, or none at all, is "Coverage map unavailable"', async () => {
  await assert.rejects(
    createCoverageLayer({ viewer: null, state: state() }),
    /^Error: Coverage map unavailable$/,
  );
  await assert.rejects(
    createCoverageLayer({ viewer: {}, state: state() }),
    /^Error: Coverage map unavailable$/,
  );
});

test('stub renderer: a click on the camera marker picks that photo through the dispatcher', async () => {
  const { renderer, viewer } = scene();
  renderer.camera.setView({
    destination: { lon: -95.1527, lat: 32.6907, height: 1500 },
  });
  const picks = [];
  const layer = await createCoverageLayer({
    viewer,
    state: state(),
    onPick: (p) => picks.push(p),
  });
  const [{ x, y }] = layer.screenPoints();
  renderer.testing.pointer('down', x, y);
  renderer.testing.pointer('up', x, y);
  renderer.testing.pointer('click', x, y);
  for (let i = 0; i < 4; i++) renderer.testing.tick();
  assert.deepEqual(picks, [{ type: 'photo', name: 'a.jpg' }]);
  layer.destroy();
  renderer.testing.pointer('down', x, y);
  renderer.testing.pointer('up', x, y);
  renderer.testing.pointer('click', x, y);
  for (let i = 0; i < 4; i++) renderer.testing.tick();
  assert.equal(picks.length, 1, 'no clicks after destroy');
});

test('stub renderer: a box drag selects the camera and holds the camera only mid-drag', async () => {
  const { renderer, viewer } = scene();
  renderer.camera.setView({
    destination: { lon: -95.1527, lat: 32.6907, height: 1500 },
  });
  const layer = await createCoverageLayer({ viewer, state: state() });
  const selected = [];
  const doc = {
    createElement: () => ({ style: {}, remove() {} }),
    addEventListener() {},
    removeEventListener() {},
  };
  const input = renderer.input;
  beginScreenSelection({
    viewer,
    mode: 'box',
    doc,
    getPoints: () => layer.screenPoints(),
    onSelect: (names) => selected.push(...names),
  });
  assert.equal(input.isPointerFree(), false, 'pointer held for the session');
  renderer.testing.pointer('down', 600, 320);
  renderer.testing.pointer('move', 700, 400);
  renderer.testing.pointer('up', 700, 400);
  assert.deepEqual(selected, ['a.jpg']);
  assert.equal(input.isPointerFree(), true, 'pointer given back');
  layer.destroy();
});
