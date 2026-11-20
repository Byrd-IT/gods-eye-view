import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageCounts, coverageColor, photosForCell } from './coverageCore.js';

const photos = [
  {name:'a',placed:true,looks_at_ground:true},
  {name:'b',placed:true,looks_at_ground:true},
  {name:'c',placed:true,looks_at_ground:false},
  {name:'d',placed:false,looks_at_ground:true},
];
const cells = {k:[1, 2], photos:[[0,1,1,2,3],[]]};
test('observations count unique kept placed ground-facing photos; discarding redraws', () => {
  assert.deepEqual(coverageCounts(cells,photos),[2,0]);
  assert.deepEqual(coverageCounts(cells,photos,new Set(['a'])),[1,0]);
  assert.deepEqual(photosForCell(cells,photos,0,new Set(['a'])).map(x=>x.name),['b']);
  assert.deepEqual(coverageCounts(cells,photos),[2,0]);
});
test('coverage color thresholds', () => {
  assert.deepEqual([0,1,2,3,4,5,10].map(coverageColor),['red','orange','orange','yellow','yellow','green','green']);
});
test('bad cross-model photo indices fail closed', () => {
  assert.throws(()=>coverageCounts({k:[0],photos:[[99]]},photos));
  assert.throws(()=>coverageCounts({k:[],photos:[[0]]},photos));
  assert.deepEqual(photosForCell(cells,photos,-1),[]);
});
