import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  SUBJECT_DOUBLE_CLICK_RADIUS_PX,
  SUBJECT_TOUCH_RADIUS_PX,
  TOUCH_DOUBLE_TAP_MS,
  TOUCH_DOUBLE_TAP_PX,
  TOUCH_TAP_MAX_MS,
  TOUCH_PRESS_STALE_MS,
  TOUCH_TAP_MAX_TRAVEL_PX,
  isTouchDoubleTap,
  onSceneDoubleClick,
  routeTouchDoubleTap,
} from './cockpitInput.js';
import { CockpitViewController } from './cockpitController.js';

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

// ---- Controller wiring (review finding 3) and the follow-on dblclick (finding 1) ----

function controllerEnvironment() {
  const original = { document: globalThis.document, window: globalThis.window };
  const document = Object.assign(new EventTarget(), {
    getElementById: () => null,
    querySelectorAll: () => [],
    body: { classList: { remove() {} } },
  });
  const window = Object.assign(new EventTarget(), { clearTimeout, setTimeout });
  globalThis.document = document;
  globalThis.window = window;
  const callbacks = new Set();
  const event = {
    addEventListener(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
  };
  const canvas = fakeCanvas();
  const handlerActions = new Map();
  const stockCalls = [];
  handlerActions.set(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK, (e) =>
    stockCalls.push(e),
  );
  const viewer = {
    canvas,
    scene: {
      canvas,
      preUpdate: event,
      screenSpaceCameraController: { enableInputs: false },
      cartesianToCanvasCoordinates: (_world, result) => {
        result.x = 100;
        result.y = 100;
        return result;
      },
    },
    trackedEntityChanged: event,
    entities: { contains: () => false },
    trackedEntity: {
      position: { getValue: () => new Cesium.Cartesian3(1, 2, 3) },
    },
    clock: { currentTime: 0 },
    screenSpaceEventHandler: {
      getInputAction: (type) => handlerActions.get(type),
      setInputAction: (fn, type) => handlerActions.set(type, fn),
      removeInputAction: (type) => handlerActions.delete(type),
      isDestroyed: () => false,
    },
  };
  return {
    viewer,
    canvas,
    handlerActions,
    stockCalls,
    restore() {
      Object.assign(globalThis, original);
    },
  };
}

test('the Cockpit controller listens for a touch double-tap and releases it on dispose', () => {
  const env = controllerEnvironment();
  try {
    const owner = new CockpitViewController(env.viewer, { services: {} });
    assert.ok(env.canvas.count() > 0, 'canvas listeners attached');
    owner.dispose();
    assert.equal(env.canvas.count(), 0, 'canvas listeners released');
  } finally {
    env.restore();
  }
});

test('through the controller, a fingertip double-tap on the track enters once', () => {
  const env = controllerEnvironment();
  try {
    const owner = new CockpitViewController(env.viewer, {
      services: { releaseContinuousRender() {} },
    });
    owner.resolveEntryKind = () => 'aircraft';
    let entered = 0;
    owner.enter = () => {
      entered += 1;
      owner.active = true;
    };
    let clock = 1000;
    const tap = (x, y) => {
      const base = {
        pointerType: 'touch',
        pointerId: 1,
        clientX: x,
        clientY: y,
      };
      env.canvas.fire('pointerdown', base);
      env.canvas.fire('pointerup', base);
    };
    const realNow = performance.now;
    performance.now = () => clock;
    try {
      // 40 px from the track at (100, 100): beyond the mouse's 32 px, inside 44 px.
      tap(140, 100);
      clock += 120;
      tap(140, 100);
      assert.equal(entered, 1);
      // A third tap, with the Cockpit active, does not enter again.
      clock += 100;
      tap(140, 100);
      clock += 100;
      tap(140, 100);
      assert.equal(entered, 1);
    } finally {
      performance.now = realNow;
    }
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('a dblclick right after a touch entry does not reach the stock handler', () => {
  const env = controllerEnvironment();
  try {
    const owner = new CockpitViewController(env.viewer, {
      services: { releaseContinuousRender() {} },
    });
    owner.resolveEntryKind = () => 'aircraft';
    owner.enter = () => {
      owner.active = true;
    };
    const routed = env.handlerActions.get(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    assert.equal(typeof routed, 'function');
    let clock = 5000;
    const realNow = performance.now;
    performance.now = () => clock;
    try {
      // A plain dblclick away from the track still goes to Cesium.
      routed({ position: { x: 900, y: 900 } });
      assert.equal(env.stockCalls.length, 1);
      const base = {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      };
      for (let i = 0; i < 2; i += 1) {
        env.canvas.fire('pointerdown', base);
        env.canvas.fire('pointerup', base);
        clock += 100;
      }
      assert.equal(owner.active, true);
      // The dblclick some touch devices add after the double-tap is swallowed.
      routed({ position: { x: 100, y: 100 } });
      assert.equal(env.stockCalls.length, 1);
      // Later, with the guard expired, a dblclick is Cesium's again.
      clock += 2000;
      routed({ position: { x: 900, y: 900 } });
      assert.equal(env.stockCalls.length, 2);
    } finally {
      performance.now = realNow;
    }
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('a press whose release never arrives does not hold the route shut', () => {
  const t = rig();
  // Pointer 9 goes down and is never released.
  t.canvas.fire('pointerdown', {
    pointerType: 'touch',
    pointerId: 9,
    clientX: 50,
    clientY: 50,
  });
  t.wait(TOUCH_PRESS_STALE_MS + 100);
  t.tap(100, 100);
  t.wait(100);
  t.tap(100, 100);
  assert.equal(t.calls.length, 1);
});
