import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointerOwner,
  claimPointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import {
  beginScreenSelection,
  COVERAGE_SELECTION_POINTER_OWNER,
} from './screenSelection.js';
import { fakeInput } from '../../testSupport/fakeCoverageInput.mjs';

function setup() {
  resetPointerOwnership();
  const docHandlers = {},
    children = [];
  const doc = {
    addEventListener: (k, f) => (docHandlers[k] = f),
    removeEventListener: (k) => delete docHandlers[k],
    createElement: () => ({
      style: {},
      remove() {
        children.pop();
      },
    }),
  };
  const canvas = {
    ownerDocument: doc,
    parentElement: { append: (x) => children.push(x) },
  };
  const input = fakeInput();
  const begin = (options) =>
    beginScreenSelection({ viewer: {}, input, canvas, doc, ...options });
  const drag = (a, b) => {
    input.fire('down', { position: a });
    input.fire('move', { startPosition: a, endPosition: b });
    input.fire('up', { position: b });
  };
  return { doc, docHandlers, children, input, begin, drag };
}

test('selection claims the pointer, freezes the camera mid-drag, selects and gives everything back', () => {
  const h = setup();
  let selected;
  const dispose = h.begin({
    mode: 'box',
    getPoints: () => [
      { name: 'a', x: 5, y: 6 },
      { name: 'b', x: 20, y: 20 },
    ],
    onSelect: (x) => (selected = x),
  });
  assert.equal(pointerOwner(), COVERAGE_SELECTION_POINTER_OWNER);
  assert.equal(h.input.state.stockHolds, 1);
  assert.equal(h.input.state.cameraHolds, 0);
  h.input.fire('down', { position: { x: 0, y: 0 } });
  assert.equal(h.input.state.cameraHolds, 1);
  h.input.fire('move', {
    startPosition: { x: 0, y: 0 },
    endPosition: { x: 10, y: 10 },
  });
  assert.equal(h.children[0].style.width, '10px');
  h.input.fire('up', { position: { x: 10, y: 10 } });
  assert.deepEqual(selected, ['a']);
  assert.equal(h.input.state.cameraHolds, 0);
  assert.equal(h.input.state.stockHolds, 0);
  assert.equal(h.input.subscriberCount(), 0);
  assert.equal(h.children.length, 0);
  assert.equal(Object.keys(h.docHandlers).length, 0);
  assert.equal(pointerOwner(), null);
  dispose();
});

test('circle mode selects inside the radius', () => {
  const h = setup();
  let selected;
  h.begin({
    mode: 'circle',
    getPoints: () => [
      { name: 'in', x: 3, y: 0 },
      { name: 'out', x: 30, y: 0 },
    ],
    onSelect: (x) => (selected = x),
  });
  h.drag({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.deepEqual(selected, ['in']);
});

test('Escape mid-drag restores the camera and does not select', () => {
  const h = setup();
  let calls = 0;
  h.begin({ mode: 'circle', getPoints: () => [], onSelect: () => calls++ });
  h.input.fire('down', { position: { x: 1, y: 1 } });
  assert.equal(h.input.state.cameraHolds, 1);
  h.docHandlers.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(h.input.state.cameraHolds, 0);
  assert.equal(h.input.state.stockHolds, 0);
  assert.equal(calls, 0);
  assert.equal(h.children.length, 0);
  assert.equal(pointerOwner(), null);
});

test('a newer pointer claim cancels the session and restores the camera', () => {
  const h = setup();
  let calls = 0;
  h.begin({ mode: 'box', getPoints: () => [], onSelect: () => calls++ });
  h.input.fire('down', { position: { x: 1, y: 1 } });
  claimPointer('draw');
  assert.equal(h.input.state.cameraHolds, 0);
  assert.equal(h.input.state.stockHolds, 0);
  assert.equal(h.input.subscriberCount(), 0);
  assert.equal(calls, 0);
  assert.equal(pointerOwner(), 'draw');
});

test('disposal is idempotent and returns the camera', () => {
  const h = setup();
  const dispose = h.begin({
    mode: 'box',
    getPoints: () => [],
    onSelect: () => {},
  });
  h.input.fire('down', { position: { x: 1, y: 1 } });
  dispose();
  dispose();
  assert.equal(h.input.state.cameraHolds, 0);
  assert.equal(h.input.state.stockHolds, 0);
  assert.equal(h.children.length, 0);
});

test('an invalid mode is refused before anything is taken', () => {
  const h = setup();
  assert.throws(
    () => h.begin({ mode: 'lasso', getPoints: () => [], onSelect() {} }),
    /Invalid selection mode/,
  );
  assert.equal(pointerOwner(), null);
});
