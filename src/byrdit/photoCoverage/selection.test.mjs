import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScreenPoints } from './selection.js';
const points = [
  { x: 0, y: 0, name: 'a' },
  { x: 3, y: 4, name: 'b' },
  { x: 4, y: 4, name: 'c' },
  { x: NaN, y: 0, name: 'bad' },
];
test('box is inclusive and drag direction independent', () => {
  assert.deepEqual(
    selectScreenPoints(points, { x: 4, y: 4 }, { x: 0, y: 0 }, 'box'),
    ['a', 'b', 'c'],
  );
});
test('circle uses drag start as centre', () => {
  assert.deepEqual(
    selectScreenPoints(points, { x: 0, y: 0 }, { x: 3, y: 4 }, 'circle'),
    ['a', 'b'],
  );
  assert.deepEqual(
    selectScreenPoints(points, { x: 0, y: 0 }, { x: 1, y: 1 }, 'unknown'),
    [],
  );
});
