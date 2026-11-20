import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultArea, rankGaps } from './gaps.js';

test('default area includes unseen nearby ground and excludes invalid cameras', () => {
  const cells={nx:5,ny:5,x0:0,y0:0,cell_m:10,k:[0]};
  const mask=defaultArea(cells,[{placed:true,x:25,y:25},{placed:false,x:0,y:0}]);
  assert(mask.has(12));
  assert(mask.has(0));
  assert(![...mask].some(i => i<0 || i>=25));
  assert.throws(() => defaultArea({...cells, nx:0},[]));
});
test('low areas join only by actual cardinal neighbors and rank red cells first', () => {
  const cells={nx:4,ny:3,x0:0,y0:0,cell_m:3,k:[0,1,4,5,8,9,10,11]};
  const mask=new Set([0,1,4,5,8,9,10,11]);
  const gaps=rankGaps(cells,mask,[0,0,0,0,5,5,5,5]);
  assert.equal(gaps.length,1); assert.equal(gaps[0].zero,4); assert.equal(gaps[0].areaM2,36);
  assert.equal(gaps[0].x,3); assert.equal(gaps[0].y,3);
  assert.throws(()=>rankGaps(cells,mask,[0]));
});
test('row boundaries never wrap into false connected components', () => {
  const cells={nx:5,ny:5,x0:0,y0:0,cell_m:3,k:[]};
  const mask=new Set([4,9,14,19,5,10,15,20]);
  const gaps=rankGaps(cells,mask,[]);
  assert.equal(gaps.length,2); assert.deepEqual(gaps.map(g=>g.cells.length),[4,4]);
});
