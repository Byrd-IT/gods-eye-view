import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDocument } from '../historyUi/fakeDom.mjs';
import { attachCoveragePanel } from './panel.js';
import { beginScreenSelection } from './screenSelection.js';
import { fakeInput } from '../../testSupport/fakeCoverageInput.mjs';
const model = 's4_today';
const photos = [
  {
    name: 'p.jpg',
    placed: true,
    looks_at_ground: true,
    x: 0,
    y: 0,
    lat: 0,
    lon: 0,
    z: 1,
    thumb: 'thumbs/p.jpg',
    flags: [],
  },
];
const cells = {
  model,
  nx: 1,
  ny: 1,
  x0: 0,
  y0: 0,
  cell_m: 10,
  k: [0],
  photos: [[0]],
};
const ok = (value) => ({ ok: true, json: async () => value });
const tick = () => new Promise((r) => setImmediate(r));
test('no fetch before opt-in; photo selection, discard, and teardown', async () => {
  const doc = fakeDocument(),
    root = doc.createElement('div');
  let requests = [],
    layers = [],
    pick;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/model.json'))
      return ok({ id: model, origin: { lat: 0, lon: 0 }, ground_z: 0 });
    if (url.endsWith('/photos.json')) return ok({ model, photos });
    if (url.endsWith('/cells.json')) return ok(cells);
    return ok([]);
  };
  const createLayer = async (x) => {
    pick = x.onPick;
    const layer = {
      dead: false,
      visible: x.state.visibleNames,
      counts: x.state.counts,
      destroy() {
        this.dead = true;
      },
    };
    layers.push(layer);
    return layer;
  };
  const detach = attachCoveragePanel({
    doc,
    container: root,
    viewer: {},
    fetchImpl,
    createLayer,
  });
  assert.equal(requests.length, 0);
  assert(root.textContent.includes('Ground: red 0'));
  const toggle = root.find((n) => n.textContent === 'Show photo coverage');
  toggle.onclick();
  await tick();
  await tick();
  assert.equal(layers.length, 1);
  pick({ type: 'photo', name: 'p.jpg' });
  await tick();
  assert(root.textContent.includes('p.jpg'));
  assert.equal(layers.length, 2);
  const date = root.find((n) => n.getAttribute('aria-label') === 'Flight date');
  date.value = '2026-11-17';
  date.onchange();
  await tick();
  assert.equal(layers.length, 3);
  assert.equal(layers[2].visible.size, 0);
  assert.deepEqual(layers[2].counts, [0]);
  assert(layers[1].dead);
  date.value = '';
  date.onchange();
  await tick();
  assert.equal(layers.length, 4);
  pick({ type: 'photo', name: 'p.jpg' });
  await tick();
  assert.equal(layers.length, 5);
  const discard = root.find((n) => n.textContent === 'Discard');
  discard.onclick();
  await tick();
  assert.equal(layers.length, 6);
  assert(layers[4].dead);
  toggle.onclick();
  assert(layers[5].dead);
  detach();
  assert.equal(root.children.length, 0);
});
test('pitch and date filters read the coverage photo schema', async () => {
  const doc = fakeDocument(),
    root = doc.createElement('div');
  const rows = [
    {
      name: 'iso.jpg',
      placed: true,
      looks_at_ground: true,
      x: 0,
      y: 0,
      gimbal_pitch: -45,
      flight_date: '2026-11-17',
    },
    {
      name: 'compact.jpg',
      placed: true,
      looks_at_ground: true,
      x: 0,
      y: 0,
      gimbal_pitch: -20,
      flight_date: '20261118',
    },
    {
      name: 'legacy.jpg',
      placed: true,
      looks_at_ground: true,
      x: 0,
      y: 0,
      pitch_deg: 70,
      flight_date: '2026-11-19',
    },
    {
      name: 'nodate.jpg',
      placed: true,
      looks_at_ground: true,
      x: 0,
      y: 0,
      gimbal_pitch: -60,
    },
  ];
  const photoCells = { ...cells, photos: [[0, 1, 2, 3]] };
  const fetchImpl = async (url) => {
    if (url.endsWith('/model.json'))
      return ok({ id: model, origin: { lat: 0, lon: 0 }, ground_z: 0 });
    if (url.endsWith('/photos.json')) return ok({ model, photos: rows });
    if (url.endsWith('/cells.json')) return ok(photoCells);
    return ok([]);
  };
  let visible = null;
  const createLayer = async (x) => {
    visible = x.state.visibleNames;
    return { destroy() {} };
  };
  const detach = attachCoveragePanel({
    doc,
    container: root,
    viewer: {},
    fetchImpl,
    createLayer,
  });
  root.find((n) => n.textContent === 'Show photo coverage').onclick();
  await tick();
  await tick();
  assert.deepEqual([...visible], ['iso.jpg', 'compact.jpg', 'legacy.jpg', 'nodate.jpg']);
  const date = root.find((n) => n.getAttribute('aria-label') === 'Flight date');
  date.value = '2026-11-17';
  date.onchange();
  await tick();
  assert.deepEqual([...visible], ['iso.jpg']);
  date.value = '20261117';
  date.onchange();
  await tick();
  assert.deepEqual([...visible], ['iso.jpg']);
  date.value = '2026-11-18';
  date.onchange();
  await tick();
  assert.deepEqual([...visible], ['compact.jpg']);
  date.value = '20261118';
  date.onchange();
  await tick();
  assert.deepEqual([...visible], ['compact.jpg']);
  date.value = '';
  date.onchange();
  await tick();
  const minPitch = root.find(
    (n) => n.getAttribute('aria-label') === 'Minimum pitch in degrees',
  );
  const maxPitch = root.find(
    (n) => n.getAttribute('aria-label') === 'Maximum pitch in degrees',
  );
  minPitch.value = '-50';
  maxPitch.value = '-40';
  minPitch.onchange();
  maxPitch.onchange();
  await tick();
  assert.deepEqual([...visible], ['iso.jpg']);
  minPitch.value = '-80';
  maxPitch.value = '-65';
  minPitch.onchange();
  maxPitch.onchange();
  await tick();
  assert.deepEqual([...visible], ['legacy.jpg']);
  detach();
});
test('unplaced photos show read-only detail and never enter bulk selection', async () => {
  const doc = fakeDocument(),
    root = doc.createElement('div'),
    container = doc.createElement('div'),
    canvas = doc.createElement('canvas');
  const viewer = { container };
  const input = fakeInput();
  const placed = {
    name: 'p.jpg',
    placed: true,
    looks_at_ground: true,
    x: 0,
    y: 0,
    lat: 0,
    lon: 0,
    z: 1,
    height_ft: 100,
    gimbal_pitch: -45,
    thumb: 'thumbs/p.jpg',
    flags: [],
  };
  const unplaced = {
    name: 'gps.jpg',
    placed: false,
    lat: 1,
    lon: 2,
    z: 30,
    height_ft: 120,
    gimbal_pitch: -30,
    thumb: 'thumbs/gps.jpg',
  };
  const photoCells = { ...cells, photos: [[0, 1]] };
  const fetchImpl = async (url) => {
    if (url.endsWith('/model.json'))
      return ok({ id: model, origin: { lat: 0, lon: 0 }, ground_z: 0 });
    if (url.endsWith('/photos.json'))
      return ok({ model, photos: [placed, unplaced] });
    if (url.endsWith('/cells.json')) return ok(photoCells);
    return ok([]);
  };
  let pick = null,
    counts = null;
  const createLayer = async (x) => {
    pick = x.onPick;
    counts = x.state.counts;
    return {
      destroy() {},
      // Deliberately offer the GPS-only name too: the panel must filter it.
      screenPoints: () => [
        { name: 'gps.jpg', x: 2, y: 2 },
        { name: 'p.jpg', x: 4, y: 4 },
      ],
    };
  };
  const detach = attachCoveragePanel({
    doc,
    container: root,
    viewer,
    fetchImpl,
    createLayer,
    beginSelection: (o) => beginScreenSelection({ ...o, input, canvas }),
  });
  root.find((n) => n.textContent === 'Show photo coverage').onclick();
  await tick();
  await tick();
  // GPS-only photos never contribute to coverage counts.
  assert.deepEqual(counts, [1]);
  pick({ type: 'photo', name: 'gps.jpg' });
  await tick();
  assert(root.textContent.includes('gps.jpg'));
  assert(root.textContent.includes('not placed in this model'));
  assert.equal(
    root.find((n) => n.textContent === 'Keep'),
    null,
  );
  assert.equal(
    root.find((n) => n.textContent === 'Discard'),
    null,
  );
  pick({ type: 'photo', name: 'p.jpg' });
  await tick();
  assert(root.find((n) => n.textContent === 'Keep'));
  assert(root.find((n) => n.textContent === 'Discard'));
  root.find((n) => n.textContent === 'Box select').onclick();
  input.fire('down', { position: { x: 0, y: 0 } });
  input.fire('move', {
    startPosition: { x: 0, y: 0 },
    endPosition: { x: 10, y: 10 },
  });
  input.fire('up', { position: { x: 10, y: 10 } });
  await tick();
  assert(root.find((n) => n.textContent === '1 selected'));
  detach();
});
