import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pointerOwner,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from '../../layers/recentImagery/testDoubles.mjs';
import { TAKEOFF_POINTER_OWNER, initPointTool } from './pointTool.js';

function fixture() {
  resetPointerOwnership();
  const fakes = boxToolFakes();
  const points = [];
  const cancels = [];
  const actives = [];
  const tool = initPointTool({
    viewer: fakes.viewer,
    cesium: fakes.cesium,
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    onPoint: (p) => points.push(p),
    onCancel: (reason) => cancels.push(reason),
    onActive: (a) => actives.push(a),
  });
  const stock = (type) =>
    fakes.viewer.screenSpaceEventHandler.getInputAction(fakes.types[type]);
  return { ...fakes, tool, points, cancels, actives, stock };
}

test('a pick claims the pointer, borrows the stock clicks and returns all of it with the point', () => {
  const f = fixture();
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), TAKEOFF_POINTER_OWNER);
  assert.equal(f.stock('LEFT_CLICK'), undefined);
  assert.equal(f.stock('LEFT_DOUBLE_CLICK'), undefined);
  assert.ok(f.documentRef.classes.has('gev-drone-box'));
  f.fire('LEFT_CLICK', { position: { x: 500, y: 250 } });
  assert.equal(f.points.length, 1);
  assert.ok(
    Number.isFinite(f.points[0].lon) && Number.isFinite(f.points[0].lat),
  );
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.stock('LEFT_CLICK'), f.originalClick);
  assert.equal(f.stock('LEFT_DOUBLE_CLICK'), f.originalDouble);
  assert.equal(f.documentRef.listeners.length, 0);
  assert.equal(f.documentRef.classes.has('gev-drone-box'), false);
  assert.deepEqual(f.actives, [true, false]);
});

test('a sky click keeps the session; Escape cancels and gives everything back', () => {
  const f = fixture();
  f.tool.start();
  f.fire('LEFT_CLICK', { position: { x: 500, y: 10 } });
  assert.deepEqual(f.cancels, ['sky']);
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.key('Escape').prevented, true);
  assert.deepEqual(f.cancels, ['sky', 'escape']);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.points.length, 0);
});

test('a held pointer refuses the session and borrows nothing', () => {
  const f = fixture();
  const other = fixture;
  void other;
  resetPointerOwnership();
  const first = initPointTool({
    viewer: f.viewer,
    cesium: f.cesium,
    pickWorld: f.pickWorld,
    documentRef: f.documentRef,
    onPoint() {},
    owner: 'draw',
  });
  assert.equal(first.start(), true);
  assert.equal(f.tool.start(), false);
  assert.deepEqual(f.cancels, ['pointer-busy']);
  assert.equal(
    f.stock('LEFT_CLICK'),
    undefined,
    'the first tool still holds the borrow',
  );
  first.destroy();
  assert.equal(f.stock('LEFT_CLICK'), f.originalClick);
});

test('destroy mid-session releases everything and is idempotent', () => {
  const f = fixture();
  f.tool.start();
  f.tool.destroy();
  f.tool.destroy();
  assert.equal(pointerOwner(), null);
  assert.equal(f.stock('LEFT_CLICK'), f.originalClick);
  assert.equal(f.tool.start(), false);
});
