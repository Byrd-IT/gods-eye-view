import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultArea, rankGaps } from './gaps.js';

test('default area includes unseen nearby ground and excludes invalid cameras', () => {
  const cells = { nx: 5, ny: 5, x0: 0, y0: 0, cell_m: 10, k: [0] };
  const mask = defaultArea(cells, [
    { placed: true, x: 25, y: 25 },
    { placed: false, x: 0, y: 0 },
  ]);
  assert(mask.has(12));
  assert(mask.has(0));
  assert(![...mask].some((i) => i < 0 || i >= 25));
  assert.throws(() => defaultArea({ ...cells, nx: 0 }, []));
});
test('low areas join only by actual cardinal neighbors and rank red cells first', () => {
  const cells = {
    nx: 4,
    ny: 3,
    x0: 0,
    y0: 0,
    cell_m: 3,
    k: [0, 1, 4, 5, 8, 9, 10, 11],
  };
  const mask = new Set([0, 1, 4, 5, 8, 9, 10, 11]);
  const gaps = rankGaps(cells, mask, [0, 0, 0, 0, 5, 5, 5, 5]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].zero, 4);
  assert.equal(gaps[0].areaM2, 36);
  assert.equal(gaps[0].x, 3);
  assert.equal(gaps[0].y, 3);
  assert.throws(() => rankGaps(cells, mask, [0]));
});
test('row boundaries never wrap into false connected components', () => {
  const cells = { nx: 5, ny: 5, x0: 0, y0: 0, cell_m: 3, k: [] };
  const mask = new Set([4, 9, 14, 19, 5, 10, 15, 20]);
  const gaps = rankGaps(cells, mask, []);
  assert.equal(gaps.length, 2);
  assert.deepEqual(
    gaps.map((g) => g.cells.length),
    [4, 4],
  );
});
test('rank orders zero-coverage cells ahead of a larger low-coverage gap', () => {
  // A is 12 cells with no zeros; B is only 4 cells but has 2 zeros. The old
  // zero*3 + size score ranked A (12) above B (10), contrary to the plan.
  const a = [0, 1, 2, 7, 8, 9, 14, 15, 16, 21, 22, 23];
  const b = [4, 5, 11, 12];
  const cells = { nx: 7, ny: 5, x0: 0, y0: 0, cell_m: 3, k: [...a, ...b] };
  const counts = [...a.map(() => 1), 0, 0, 2, 2];
  const gaps = rankGaps(cells, new Set(cells.k), counts);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].zero, 2);
  assert.equal(gaps[0].cells.length, 4);
  assert.equal(gaps[1].zero, 0);
  assert.equal(gaps[1].cells.length, 12);
});
test('equal zero and size ties are deterministic across mask insertion order', () => {
  const cells = {
    nx: 8,
    ny: 2,
    x0: 0,
    y0: 0,
    cell_m: 3,
    k: [0, 1, 2, 3, 12, 13, 14, 15],
  };
  const counts = [0, 0, 1, 1, 0, 0, 1, 1];
  const forward = rankGaps(cells, new Set(cells.k), counts);
  const reverse = rankGaps(cells, new Set([...cells.k].reverse()), counts);
  assert.deepEqual(
    forward.map((g) => [g.zero, g.cells.length, g.x, g.y, g.minCell]),
    reverse.map((g) => [g.zero, g.cells.length, g.x, g.y, g.minCell]),
  );
  assert.equal(forward[0].minCell, 0);
  assert.equal(forward[1].minCell, 12);
});
