import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageCounts,
  coverageColor,
  photosForCell,
} from './coverageCore.js';

const photos = [
  { name: 'a', placed: true, looks_at_ground: true },
  { name: 'b', placed: true, looks_at_ground: true },
  { name: 'c', placed: true, looks_at_ground: false },
  { name: 'd', placed: false, looks_at_ground: true },
];
const cells = { k: [1, 2], photos: [[0, 1, 1, 2, 3], []] };
test('observations count unique kept placed ground-facing photos; discarding redraws', () => {
  assert.deepEqual(coverageCounts(cells, photos), [2, 0]);
  assert.deepEqual(coverageCounts(cells, photos, new Set(['a'])), [1, 0]);
  assert.deepEqual(
    photosForCell(cells, photos, 0, new Set(['a'])).map((x) => x.name),
    ['b'],
  );
  assert.deepEqual(coverageCounts(cells, photos), [2, 0]);
});
test('coverage color thresholds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 10].map(coverageColor), [
    'red',
    'orange',
    'orange',
    'yellow',
    'yellow',
    'green',
    'green',
  ]);
});
test('bad cross-model photo indices fail closed', () => {
  assert.throws(() => coverageCounts({ k: [0], photos: [[99]] }, photos));
  assert.throws(() => coverageCounts({ k: [], photos: [[0]] }, photos));
  assert.deepEqual(photosForCell(cells, photos, -1), []);
});

// A level shallow camera 10 m up with a 10 deg vertical frame. Cell 4 is 45 m
// ahead: 10 m below the eye is too steep for the frame. Cell 19 is 195 m
// ahead and 10 m below: it falls inside the same frame.
const shallow = {
  name: 'far.jpg',
  placed: true,
  looks_at_ground: false,
  x: 0,
  y: 0,
  z: 10,
  fwd: [1, 0, 0],
  right: [0, 1, 0],
  down: [0, 0, -1],
  hfov: 60,
  vfov: 10,
};
const shallowGrid = {
  nx: 30,
  ny: 1,
  x0: 0,
  y0: 0,
  cell_m: 10,
  k: [4, 19],
  z: [0, 0],
  photos: [[0], [0]],
};
test('shallow photos count only cells actually inside their frame', () => {
  assert.deepEqual(coverageCounts(shallowGrid, [shallow]), [0, 1]);
  assert.deepEqual(photosForCell(shallowGrid, [shallow], 0), []);
  assert.deepEqual(
    photosForCell(shallowGrid, [shallow], 1).map((p) => p.name),
    ['far.jpg'],
  );
  // Geometry never adds an observation the cell did not list.
  const sparse = { ...shallowGrid, photos: [[0], []] };
  assert.deepEqual(coverageCounts(sparse, [shallow]), [0, 0]);
  assert.deepEqual(photosForCell(sparse, [shallow], 1), []);
});
test('shallow photos discard cells on or above the horizon', () => {
  const atHorizon = { ...shallowGrid, z: [0, 10] };
  const aboveHorizon = { ...shallowGrid, z: [0, 20] };
  assert.deepEqual(coverageCounts(atHorizon, [shallow]), [0, 0]);
  assert.deepEqual(coverageCounts(aboveHorizon, [shallow]), [0, 0]);
  assert.deepEqual(photosForCell(aboveHorizon, [shallow], 1), []);
});
test('shallow photos fail closed on missing or malformed geometry', () => {
  const malformed = [
    { ...shallow, down: null },
    { ...shallow, fwd: [1, 0] },
    { ...shallow, hfov: undefined },
    { ...shallow, vfov: 180 },
    { ...shallow, x: NaN },
  ];
  for (const photo of malformed)
    assert.deepEqual(coverageCounts(shallowGrid, [photo]), [0, 0]);
  const noCellZ = { ...shallowGrid, z: undefined };
  assert.deepEqual(coverageCounts(noCellZ, [shallow]), [0, 0]);
  const shortCellZ = { ...shallowGrid, z: [0] };
  assert.deepEqual(coverageCounts(shortCellZ, [shallow]), [0, 0]);
  const noGrid = { k: [4, 19], photos: [[0], [0]] };
  assert.deepEqual(coverageCounts(noGrid, [shallow]), [0, 0]);
});
test('shallow eligibility still honours discard and visible-photo filters', () => {
  const discarded = new Set(['far.jpg']);
  assert.deepEqual(coverageCounts(shallowGrid, [shallow], discarded), [0, 0]);
  assert.deepEqual(photosForCell(shallowGrid, [shallow], 1, discarded), []);
  const hidden = new Set(['other.jpg']);
  assert.deepEqual(
    coverageCounts(shallowGrid, [shallow], new Set(), hidden),
    [0, 0],
  );
  assert.deepEqual(
    photosForCell(shallowGrid, [shallow], 1, new Set(), hidden),
    [],
  );
  const shown = new Set(['far.jpg']);
  assert.deepEqual(
    coverageCounts(shallowGrid, [shallow], new Set(), shown),
    [0, 1],
  );
  assert.deepEqual(
    photosForCell(shallowGrid, [shallow], 1, new Set(), shown).map(
      (p) => p.name,
    ),
    ['far.jpg'],
  );
});
test('ground-facing photos keep their unfiltered observations', () => {
  const ground = {
    ...shallow,
    name: 'ground.jpg',
    looks_at_ground: true,
    down: null,
    hfov: undefined,
  };
  assert.deepEqual(coverageCounts(shallowGrid, [ground]), [1, 1]);
  assert.deepEqual(
    photosForCell(shallowGrid, [ground], 0).map((p) => p.name),
    ['ground.jpg'],
  );
});
