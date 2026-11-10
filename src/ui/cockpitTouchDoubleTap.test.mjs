import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  SUBJECT_DOUBLE_CLICK_RADIUS_PX,
  SUBJECT_TOUCH_RADIUS_PX,
  TOUCH_DOUBLE_TAP_MS,
  TOUCH_DOUBLE_TAP_PX,
  TOUCH_TAP_MAX_MS,
  TOUCH_TAP_MAX_TRAVEL_PX,
  isTouchDoubleTap,
  onSceneDoubleClick,
  routeTouchDoubleTap,
} from './cockpitInput.js';

/** A canvas that records listeners and lets a test dispatch pointer events. */
function fakeCanvas() {
  const listeners = new Map();
  return {
    listeners,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    count() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

function rig() {
  const canvas = fakeCanvas();
  let clock = 1000;
  const calls = [];
  const owner = {
    viewer: { canvas },
    onSceneDoubleClick(position, options) {
      calls.push({ position, options });
      return true;
    },
  };
  const remove = routeTouchDoubleTap.call(owner, () => clock);
  const tap = (
    x,
    y,
    { pointerType = 'touch', pointerId = 1, holdMs = 40 } = {},
  ) => {
    const base = { pointerType, pointerId, clientX: x + 10, clientY: y + 20 };
    canvas.fire('pointerdown', base);
    clock += holdMs;
    canvas.fire('pointerup', base);
  };
  return {
    canvas,
    calls,
    remove,
    tap,
    wait: (ms) => {
      clock += ms;
    },
    advance: () => clock,
  };
}

test('two touch taps close together are a double-tap', () => {
  assert.equal(
    isTouchDoubleTap({ x: 5, y: 5, at: 0 }, { x: 9, y: 8, at: 200 }),
    true,
  );
});

test('a double-tap is bounded by time and by distance', () => {
  const first = { x: 0, y: 0, at: 0 };
  assert.equal(
    isTouchDoubleTap(first, { x: 0, y: 0, at: TOUCH_DOUBLE_TAP_MS }),
    true,
  );
  assert.equal(
    isTouchDoubleTap(first, { x: 0, y: 0, at: TOUCH_DOUBLE_TAP_MS + 1 }),
    false,
  );
  assert.equal(
    isTouchDoubleTap(first, { x: TOUCH_DOUBLE_TAP_PX, y: 0, at: 100 }),
    true,
  );
  assert.equal(
    isTouchDoubleTap(first, { x: TOUCH_DOUBLE_TAP_PX + 1, y: 0, at: 100 }),
    false,
  );
  assert.equal(isTouchDoubleTap(null, first), false);
  assert.equal(isTouchDoubleTap(first, { x: 0, y: 0, at: -5 }), false);
});

test('a touch double-tap asks the Cockpit with the fingertip radius', () => {
  const t = rig();
  t.tap(100, 100);
  t.wait(120);
  t.tap(104, 102);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].options, { radiusPx: SUBJECT_TOUCH_RADIUS_PX });
  // Canvas-relative: the page offset (10, 20) is removed.
  assert.equal(t.calls[0].position.x, 104);
  assert.equal(t.calls[0].position.y, 102);
  assert.ok(SUBJECT_TOUCH_RADIUS_PX > SUBJECT_DOUBLE_CLICK_RADIUS_PX);
});

test('a third tap does not chain off the double-tap that just fired', () => {
  const t = rig();
  t.tap(100, 100);
  t.wait(100);
  t.tap(100, 100);
  t.wait(100);
  t.tap(100, 100);
  assert.equal(t.calls.length, 1);
});

test('slow or far apart taps are two single taps', () => {
  const t = rig();
  t.tap(100, 100);
  t.wait(TOUCH_DOUBLE_TAP_MS + 50);
  t.tap(100, 100);
  assert.equal(t.calls.length, 0);
  t.wait(100);
  t.tap(300, 300);
  assert.equal(t.calls.length, 0);
});

test('mouse and pen pointers are left to their own routes', () => {
  const t = rig();
  t.tap(100, 100, { pointerType: 'mouse' });
  t.wait(100);
  t.tap(100, 100, { pointerType: 'mouse' });
  t.tap(100, 100, { pointerType: 'pen' });
  t.wait(100);
  t.tap(100, 100, { pointerType: 'pen' });
  assert.equal(t.calls.length, 0);
});

test('a press that drags or is held is not a tap', () => {
  const t = rig();
  // Drag: moves further than a tap may.
  const down = {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 110,
    clientY: 120,
  };
  t.canvas.fire('pointerdown', down);
  t.canvas.fire('pointermove', {
    ...down,
    clientX: 110 + TOUCH_TAP_MAX_TRAVEL_PX + 5,
  });
  t.canvas.fire('pointerup', down);
  t.wait(100);
  t.tap(100, 100);
  assert.equal(t.calls.length, 0);
  // Long press.
  t.wait(100);
  t.tap(100, 100, { holdMs: TOUCH_TAP_MAX_MS + 100 });
  t.wait(100);
  t.tap(100, 100);
  assert.equal(t.calls.length, 0);
});

test('a second finger makes a pinch, never a tap pair', () => {
  const t = rig();
  t.tap(100, 100);
  t.wait(100);
  const a = { pointerType: 'touch', pointerId: 1, clientX: 110, clientY: 120 };
  const b = { pointerType: 'touch', pointerId: 2, clientX: 160, clientY: 120 };
  t.canvas.fire('pointerdown', a);
  t.canvas.fire('pointerdown', b);
  t.wait(40);
  t.canvas.fire('pointerup', a);
  t.canvas.fire('pointerup', b);
  assert.equal(t.calls.length, 0);
});

test('a cancelled touch forgets the first tap', () => {
  const t = rig();
  t.tap(100, 100);
  t.canvas.fire('pointercancel', { pointerType: 'touch', pointerId: 7 });
  t.wait(100);
  t.tap(100, 100);
  assert.equal(t.calls.length, 0);
});

test('removing the route takes every listener off the canvas', () => {
  const t = rig();
  assert.ok(t.canvas.count() > 0);
  t.remove();
  assert.equal(t.canvas.count(), 0);
  t.tap(100, 100);
  t.wait(100);
  t.tap(100, 100);
  assert.equal(t.calls.length, 0);
});

test('a viewer without a canvas gets a no-op route', () => {
  const remove = routeTouchDoubleTap.call({ viewer: {} });
  assert.equal(typeof remove, 'function');
  remove();
});

/** A Cockpit stand-in with a followed aircraft drawn at (100, 100). */
function cockpitWithTrackAt100() {
  const entered = [];
  return {
    entered,
    active: false,
    destroyed: false,
    resolveEntryKind: () => 'aircraft',
    enter() {
      entered.push(true);
    },
    viewer: {
      trackedEntity: {
        position: { getValue: () => new Cesium.Cartesian3(1, 2, 3) },
      },
      clock: { currentTime: 0 },
      scene: {
        cartesianToCanvasCoordinates: (_world, result) => {
          result.x = 100;
          result.y = 100;
          return result;
        },
      },
    },
  };
}

test('the mouse radius is unchanged and a fingertip radius reaches farther', () => {
  const cockpit = cockpitWithTrackAt100();
  // 40 px away: outside the mouse's 32 px, inside the fingertip's 44 px.
  const near = { x: 140, y: 100 };
  assert.equal(onSceneDoubleClick.call(cockpit, near), false);
  assert.equal(cockpit.entered.length, 0);
  assert.equal(
    onSceneDoubleClick.call(cockpit, near, {
      radiusPx: SUBJECT_TOUCH_RADIUS_PX,
    }),
    true,
  );
  assert.equal(cockpit.entered.length, 1);
});

test('a double-tap beyond the fingertip radius does not enter', () => {
  const cockpit = cockpitWithTrackAt100();
  assert.equal(
    onSceneDoubleClick.call(
      cockpit,
      { x: 100 + SUBJECT_TOUCH_RADIUS_PX + 1, y: 100 },
      { radiusPx: SUBJECT_TOUCH_RADIUS_PX },
    ),
    false,
  );
  assert.equal(cockpit.entered.length, 0);
});

test('an active Cockpit ignores a double-tap', () => {
  const cockpit = cockpitWithTrackAt100();
  cockpit.active = true;
  assert.equal(
    onSceneDoubleClick.call(cockpit, { x: 100, y: 100 }, { radiusPx: 44 }),
    false,
  );
});
