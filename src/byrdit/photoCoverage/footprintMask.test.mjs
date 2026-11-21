import test from 'node:test';
import assert from 'node:assert/strict';
import { footprintMask } from './footprintMask.js';
const cells = {
  nx: 3,
  ny: 3,
  x0: 0,
  y0: 0,
  cell_m: 1,
  k: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  z: Array(9).fill(0),
};
const photo = {
  name: 'p',
  placed: true,
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
test('downward camera footprint is the present-cell mask, not whole site shade', () => {
  const s = { cells, photos: [photo], meta: { ground_z: 0 } };
  assert.deepEqual(new Set(footprintMask(s, 0)), new Set(cells.k));
  assert.deepEqual(
    footprintMask({ ...s, photos: [{ ...photo, placed: false }] }, 0),
    [],
  );
  assert.deepEqual(
    footprintMask({ ...s, photos: [{ ...photo, flags: ['far_off'] }] }, 0),
    [],
  );
});
test('upward and malformed cameras do not claim ground', () => {
  const s = {
    cells,
    photos: [{ ...photo, fwd: [0, 0, 1] }],
    meta: { ground_z: 0 },
  };
  assert.deepEqual(footprintMask(s, 0), []);
  assert.deepEqual(
    footprintMask({ ...s, photos: [{ ...photo, down: null }] }, 0),
    [],
  );
});

test('solid tall wall occludes ground even when camera begins outside the grid', () => {
  const nx = 8,
    ny = 5;
  const k = Array.from({ length: nx * ny }, (_, i) => i);
  const grid = {
    nx,
    ny,
    x0: 0,
    y0: 0,
    cell_m: 1,
    k,
    z: k.map((i) => (i % nx === 3 ? 20 : 0)),
  };
  const state = {
    cells: grid,
    meta: { ground_z: 0 },
    photos: [{ ...photo, x: -1.5, y: 2.5, hfov: 120, vfov: 120 }],
  };
  const visible = footprintMask(state, 0);
  assert(visible.length > 0);
  assert(visible.every((i) => i % nx < 3));
  const noWall = { ...state, cells: { ...grid, z: k.map(() => 0) } };
  assert(footprintMask(noWall, 0).some((i) => i % nx > 3));
});

test('a rising ray is blocked at its lowest point inside a wall', () => {
  const nx = 6,
    ny = 4;
  const k = Array.from({ length: nx * ny }, (_, i) => i);
  // The wall tops out between the ray's entry and exit heights, so only the
  // minimum height inside the column (the entry, for a rising ray) is blocked.
  const grid = {
    nx,
    ny,
    x0: 0,
    y0: 0,
    cell_m: 1,
    k,
    z: k.map((i) => (i % nx === 3 ? 7 : i % nx === 5 ? 10 : 0)),
  };
  const rising = {
    ...photo,
    x: -1.5,
    y: 1.5,
    z: 1,
    fwd: [Math.SQRT1_2, 0, Math.SQRT1_2],
    down: [Math.SQRT1_2, 0, -Math.SQRT1_2],
    hfov: 120,
    vfov: 120,
  };
  const state = { cells: grid, meta: { ground_z: 0 }, photos: [rising] };
  assert(!footprintMask(state, 0).some((i) => i % nx === 5));
  const noWall = {
    ...state,
    cells: { ...grid, z: k.map((i) => (i % nx === 5 ? 10 : 0)) },
  };
  assert.equal(
    footprintMask(noWall, 0).filter((i) => i % nx === 5).length,
    ny,
  );
});

test('missing cells.z fails closed instead of throwing', () => {
  const withoutZ = {
    cells: { nx: 3, ny: 3, x0: 0, y0: 0, cell_m: 1, k: cells.k },
    photos: [photo],
    meta: { ground_z: 0 },
  };
  assert.deepEqual(footprintMask(withoutZ, 0), []);
  assert.deepEqual(
    footprintMask(
      { ...withoutZ, cells: { ...withoutZ.cells, z: undefined } },
      0,
    ),
    [],
  );
});
