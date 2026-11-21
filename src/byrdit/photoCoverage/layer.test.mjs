import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { createCoverageLayer } from './layer.js';
import { fakeDrawPort, fakeInput } from '../../testSupport/fakeCoverageInput.mjs';

function harness({ fail = false, height = 100 } = {}) {
  const draw = fakeDrawPort(),
    input = fakeInput(),
    sampled = [];
  const query = {
    occluded: false,
    project: () => ({ x: 3, y: 4 }),
    isOccluded() {
      return this.occluded;
    },
  };
  const heights = {
    async batch(points, options) {
      sampled.push({ points, options });
      if (fail) throw Error('terrain');
      return points.map(() => height);
    },
  };
  const make = (state, extra = {}) =>
    createCoverageLayer({
      viewer: {},
      state,
      draw,
      query,
      input,
      heights,
      ...extra,
    });
  const live = () => [...draw.sets.values()].filter((s) => !s.disposed);
  /** Deliver a click whose top draw hit is `hit`. */
  const click = (hit) => input.subs.click.forEach((s) => s.fn({ drawHit: hit }));
  return { draw, input, query, heights, sampled, make, live, click };
}
const state = {
  meta: { origin: { lat: 0, lon: 0 }, ground_z: -10 },
  photos: [
    {
      name: 'p.jpg',
      lat: 0,
      lon: 0,
      x: 0,
      y: 0,
      z: 5,
      fwd: [1, 0, -1],
      placed: true,
      flags: [],
    },
  ],
  cells: { nx: 1, ny: 1, x0: 0, y0: 0, cell_m: 3, k: [0] },
  counts: [1],
  mask: new Set([0]),
  discarded: new Set(),
};
const alpha = (c) => c[3];

test('layer draws ground and terrain-aligned camera then removes everything exactly once', async () => {
  const h = harness(),
    picks = [];
  const layer = await h.make(state, { onPick: (p) => picks.push(p) });
  const cells = h.draw.set('photo-coverage-cells');
  assert.equal(cells.kind, 'shapes');
  assert.equal(cells.spec.pickable, true);
  assert.equal(cells.spec.blend, 'translucent');
  const cell = cells.items.get('cell:0');
  assert.equal(cell.geometry.kind, 'rectangle');
  assert.equal(cell.height, 'clampGround');
  assert.deepEqual(cell.meta, { type: 'coverage-cell', key: 0 });
  assert.equal(alpha(cell.fill), 0.45);
  const cam = h.draw.set('photo-coverage-cameras').items.get('photo:p.jpg');
  assert.deepEqual(cam.pos, fromDegrees(0, 0, 115));
  assert.equal(cam.pixelSize, 7);
  assert.deepEqual(cam.outlineColor, [0, 0, 0, 1]);
  assert.equal(cam.outlineWidth, 1);
  assert.deepEqual(cam.meta, { type: 'photo', name: 'p.jpg' });
  const dir = h.draw.set('photo-coverage-directions').items.get('direction:p.jpg');
  assert.equal(dir.mode, '3d');
  assert.equal(dir.widthPx, 2);
  assert.equal(dir.style.kind, 'solid');
  assert.deepEqual(dir.meta, { type: 'direction', name: 'p.jpg' });
  assert.deepEqual(layer.screenPoints(), [{ name: 'p.jpg', x: 3, y: 4 }]);
  h.query.occluded = true;
  assert.deepEqual(layer.screenPoints(), []);
  h.click({ set: 'photo-coverage-cells', id: 'cell:0', meta: cell.meta });
  assert.deepEqual(picks, [{ type: 'cell', key: 0 }]);
  layer.destroy();
  layer.destroy();
  assert.equal(h.live().length, 0);
  assert.equal(h.input.subscriberCount(), 0);
});

test('palette follows coverage count and camera status colours', async () => {
  const h = harness();
  const photo = state.photos[0];
  const s = {
    ...state,
    photos: [
      { ...photo, name: 'kept' },
      { ...photo, name: 'gone' },
      { ...photo, name: 'flag', flags: ['far_off'] },
    ],
    discarded: new Set(['gone']),
  };
  await h.make(s);
  const pts = h.draw.set('photo-coverage-cameras').items;
  assert.deepEqual(pts.get('photo:kept').color, [0, 1, 1]);
  assert.deepEqual(pts.get('photo:gone').color, [0.5, 0.5, 0.5]);
  assert.deepEqual(pts.get('photo:flag').color, [1, 0, 1]);
  const colorFor = async (count) => {
    const g = harness();
    await g.make({ ...state, counts: [count] });
    return g.draw.set('photo-coverage-cells').items.get('cell:0').fill;
  };
  const colours = await Promise.all([0, 1, 3, 9].map(colorFor));
  assert.equal(new Set(colours.map((c) => c.slice(0, 3).join())).size, 4);
  colours.forEach((c) => assert.equal(alpha(c), 0.45));
});

test('terrain failure rejects and leaves no sets or subscriptions', async () => {
  const h = harness({ fail: true });
  await assert.rejects(h.make(state), /Terrain height unavailable/);
  assert.equal(h.live().length, 0);
  assert.equal(h.input.subscriberCount(), 0);
});

test('a non-finite terrain height is unavailable', async () => {
  const h = harness({ height: null });
  await assert.rejects(h.make(state), /Terrain height unavailable/);
  assert.equal(h.live().length, 0);
});

test('a failure while drawing disposes the sets already made', async () => {
  const h = harness();
  const draw = h.draw;
  draw.lines = () => {
    throw new Error('lines unavailable');
  };
  await assert.rejects(h.make(state), /lines unavailable/);
  assert.equal(h.live().length, 0);
  assert.equal(h.input.subscriberCount(), 0);
});

test('footprints without clear ground fail closed without rejecting the layer', async () => {
  const h = harness();
  const layer = await h.make({ ...state, footprintNames: ['p.jpg'] });
  assert.equal(h.draw.set('photo-coverage-footprints'), undefined);
  assert(h.draw.set('photo-coverage-cells'));
  layer.destroy();
});

test('footprints are capped at 50 photos', async () => {
  const h = harness();
  const grid = {
    nx: 3,
    ny: 3,
    x0: 0,
    y0: 0,
    cell_m: 1,
    k: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    z: Array(9).fill(0),
  };
  const base = {
    placed: true,
    lat: 0,
    lon: 0,
    x: 1.5,
    y: 1.5,
    z: 10,
    fwd: [0, 0, -1],
    right: [1, 0, 0],
    down: [0, 1, 0],
    hfov: 90,
    vfov: 90,
    flags: [],
  };
  const photos = Array.from({ length: 60 }, (_, i) => ({
    ...base,
    name: `p${i}.jpg`,
  }));
  const layer = await h.make({
    meta: { origin: { lat: 0, lon: 0 }, ground_z: 0 },
    photos,
    cells: grid,
    counts: Array(9).fill(1),
    mask: new Set(grid.k),
    discarded: new Set(),
    footprintNames: photos.map((p) => p.name),
  });
  const set = h.draw.set('photo-coverage-footprints');
  const items = [...set.items.values()];
  assert.equal(new Set(items.map((i) => i.meta.name)).size, 50);
  assert.equal(alpha(items[0].fill), 0.24);
  assert.equal(items[0].meta.type, 'footprint');
  const picks = [];
  layer.destroy();
  const again = await h.make(
    { ...state, footprintNames: [] },
    { onPick: (p) => picks.push(p) },
  );
  h.click({ set: 'photo-coverage-cells', id: 'cell:0', meta: items[0].meta });
  assert.deepEqual(picks, [{ type: 'photo', name: items[0].meta.name }]);
  again.destroy();
});

test('all cameras share the single terrain anchor at model origin', async () => {
  const h = harness();
  const s = {
    ...state,
    photos: [
      state.photos[0],
      { ...state.photos[0], name: 'p2.jpg', lon: 0.01, x: 900 },
    ],
  };
  await h.make(s);
  assert.equal(h.sampled.length, 1);
  assert.deepEqual(h.sampled[0].points, [{ lon: 0, lat: 0 }]);
  assert.equal(h.sampled[0].options.against, 'terrain');
  const pts = h.draw.set('photo-coverage-cameras').items;
  assert.deepEqual(pts.get('photo:p.jpg').pos, fromDegrees(0, 0, 115));
  assert.deepEqual(pts.get('photo:p2.jpg').pos, fromDegrees(0.01, 0, 115));
});

test('GPS-only unplaced photos draw yellow and clickable without pose or bulk selection', async () => {
  const h = harness(),
    picks = [];
  const s = {
    ...state,
    photos: [
      state.photos[0],
      { name: 'gps.jpg', placed: false, lat: 1, lon: 2, z: 30 },
      { name: 'no-height.jpg', placed: false, lat: 1, lon: 2 },
      { name: 'bad-lat.jpg', placed: false, lat: NaN, lon: 2, z: 30 },
    ],
  };
  const layer = await h.make(s, { onPick: (p) => picks.push(p) });
  const pts = h.draw.set('photo-coverage-cameras').items;
  const gps = pts.get('photo:gps.jpg');
  assert.deepEqual(gps.color, [1, 1, 0]);
  assert.deepEqual(gps.pos, fromDegrees(2, 1, 140));
  assert.deepEqual(gps.meta, { type: 'photo', name: 'gps.jpg', placed: false });
  assert.equal(
    h.draw.set('photo-coverage-directions').items.has('direction:gps.jpg'),
    false,
  );
  assert.equal(pts.has('photo:no-height.jpg'), false);
  assert.equal(pts.has('photo:bad-lat.jpg'), false);
  assert.equal(h.draw.set('photo-coverage-cells').items.size, 1);
  assert.deepEqual(layer.screenPoints(), [{ name: 'p.jpg', x: 3, y: 4 }]);
  h.click({ set: 'photo-coverage-cameras', id: 'photo:gps.jpg', meta: gps.meta });
  assert.deepEqual(picks, [{ type: 'photo', name: 'gps.jpg' }]);
  layer.destroy();
});

test('a model with only GPS-only photos uses the shared terrain datum', async () => {
  const h = harness();
  await h.make({
    ...state,
    photos: [{ name: 'gps.jpg', placed: false, lat: 1, lon: 2, z: 30 }],
  });
  assert.equal(h.sampled.length, 1);
  const gps = h.draw.set('photo-coverage-cameras').items.get('photo:gps.jpg');
  assert.deepEqual(gps.pos, fromDegrees(2, 1, 140));
  assert.deepEqual(gps.color, [1, 1, 0]);
});

test('clicks route photo, direction and footprint hits and ignore foreign sets', async () => {
  const h = harness(),
    picks = [];
  await h.make(state, { onPick: (p) => picks.push(p) });
  h.click({
    set: 'photo-coverage-cameras',
    id: 'photo:p.jpg',
    meta: { type: 'photo', name: 'p.jpg' },
  });
  h.click({
    set: 'photo-coverage-directions',
    id: 'direction:p.jpg',
    meta: { type: 'direction', name: 'p.jpg' },
  });
  h.click({
    set: 'photo-coverage-footprints',
    id: 'footprint:p.jpg:0',
    meta: { type: 'footprint', name: 'p.jpg' },
  });
  h.click({ set: 'other', id: 'x', meta: { type: 'photo', name: 'z' } });
  h.click(null);
  assert.deepEqual(picks, Array(3).fill({ type: 'photo', name: 'p.jpg' }));
});
