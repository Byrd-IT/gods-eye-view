import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pointerOwner,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { boxToolFakes } from '../../layers/recentImagery/testDoubles.mjs';
import { POLYGON_POINTER_OWNER, initPolygonTool } from './polygonTool.js';

function fixture(onRing = () => true) {
  resetPointerOwnership();
  const fakes = boxToolFakes();
  const rings = [];
  const cancels = [];
  const tool = initPolygonTool({
    viewer: fakes.viewer,
    cesium: fakes.cesium,
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    onRing: (ring) => {
      rings.push(ring);
      return onRing(ring);
    },
    onCancel: (reason) => cancels.push(reason),
  });
  const stock = (type) =>
    fakes.viewer.screenSpaceEventHandler.getInputAction(fakes.types[type]);
  const click = (x, y) => fakes.fire('LEFT_CLICK', { position: { x, y } });
  return { ...fakes, tool, rings, cancels, stock, click };
}

test('clicks add corners, Backspace removes the last, Escape gives the pointer back', () => {
  const f = fixture();
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), POLYGON_POINTER_OWNER);
  assert.equal(f.stock('LEFT_CLICK'), undefined);
  f.click(200, 200);
  f.click(400, 200);
  f.click(400, 350);
  assert.equal(f.tool.vertexCount(), 3);
  assert.equal(f.key('Backspace').prevented, true);
  assert.equal(f.tool.vertexCount(), 2);
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.stock('LEFT_CLICK'), f.originalClick);
  assert.deepEqual(f.cancels, ['escape']);
  assert.equal(f.rings.length, 0);
});

test('a double-click closes a polygon and returns the pointer', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
  // The click that starts the double-click adds a corner, then the double-click
  // removes that corner and closes.
  f.click(360, 280);
  f.fire('LEFT_DOUBLE_CLICK', { position: { x: 360, y: 280 } });
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
});

test('clicking the first corner closes without adding another point', () => {
  const f = fixture();
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
  f.click(204, 204);
  assert.equal(f.rings.length, 1);
  assert.equal(f.rings[0].length, 3);
  assert.equal(f.tool.isActive(), false);
});

test('a rejected ring stays open so the last corner can be removed', () => {
  const f = fixture(() => false);
  f.tool.start();
  f.click(200, 200);
  f.click(500, 200);
  f.click(500, 360);
  f.click(204, 204);
  assert.equal(f.rings.length, 1);
  assert.equal(f.tool.isActive(), true);
  assert.equal(f.tool.vertexCount(), 3);
  f.tool.destroy();
  assert.equal(pointerOwner(), null);
});
