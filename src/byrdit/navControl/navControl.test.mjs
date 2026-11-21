import '../../render/cesium/unbound.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  frameForTarget,
  mountNavControl,
  orbitCameraPosition,
  plausibleTarget,
} from './navControl.js';
import { readCameraTargetFrame } from '../../ui/cameraOrientationControls.js';
import { TOP_DOWN_PITCH } from './navMath.js';

const DEG = Math.PI / 180;
const GROUND = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0);

// ── a very small DOM: enough to build, query and drive the control ───────
class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.styles = new Map();
    this.style = { setProperty: (name, value) => this.styles.set(name, value) };
    this.value = '';
    this.textContent = '';
    this.captured = [];
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    const siblings = this.parentNode?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    const match = /^\[([\w-]+)(?:(\^?=)"?([^"\]]*)"?)?\]$/.exec(selector);
    assert.ok(match, `fake DOM supports attribute selectors only: ${selector}`);
    const [, name, operator, expected] = match;
    return [...this.descendants()].filter((node) => {
      const actual = node.getAttribute(name);
      if (actual === null) return false;
      if (!operator) return true;
      return operator === '^='
        ? actual.startsWith(expected)
        : actual === expected;
    });
  }
  getBoundingClientRect() {
    return { left: 100, top: 100, width: 80, height: 80 };
  }
  setPointerCapture(id) {
    this.captured.push(id);
  }
  /** Dispatch an event carrying extra fields (button, detail, key, ...). */
  fire(type, fields = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    this.dispatchEvent(event);
    return event;
  }
}

function createDocument() {
  const body = new FakeElement('body');
  return {
    body,
    createElement: (tag) => new FakeElement(tag),
  };
}

// ── a real Cesium camera orbiting a fixed ground point ───────────────────
function createViewer({ pick = GROUND, ground = GROUND, sampleHeight } = {}) {
  const scene = {
    ...(sampleHeight ? { sampleHeight } : {}),
    canvas: new FakeElement('canvas'),
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84, pick: () => pick },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    pickPositionSupported: false,
    pickPosition: () => null,
    // Upstream's query port (#1760) needs a scene that can pick.
    pick: () => undefined,
    drillPick: () => [],
    requestRender: () => {},
    preRender: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
  };
  scene.canvas.clientWidth = 1200;
  scene.canvas.clientHeight = 800;
  scene.canvas.width = 1200;
  scene.canvas.height = 800;
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.getPickRay = () => ({});
  camera.pickEllipsoid = () => ground;
  const viewer = {
    camera,
    scene,
    canvas: scene.canvas,
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
  };
  return viewer;
}

function orbit(viewer, { heading = 30, pitch = -45, range = 1_000 } = {}) {
  viewer.camera.lookAt(
    GROUND,
    new Cesium.HeadingPitchRange(heading * DEG, pitch * DEG, range),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

/** A manual clock and timers so animation and press-and-hold are deterministic. */
function createClock() {
  let time = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => time,
    timers: {
      setTimeout: (fn, delay) => {
        pending.set(nextId, { fn, at: time + delay, every: 0 });
        return nextId++;
      },
      setInterval: (fn, delay) => {
        pending.set(nextId, { fn, at: time + delay, every: delay });
        return nextId++;
      },
      clearTimeout: (id) => pending.delete(id),
      clearInterval: (id) => pending.delete(id),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    advance(ms, onFrame) {
      const end = time + ms;
      while (time < end) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        const step = due ? Math.max(time, due[1].at) : end;
        time = step;
        onFrame?.();
        if (due && pending.has(due[0])) {
          const [id, timer] = due;
          timer.fn();
          if (timer.every) timer.at += timer.every;
          else pending.delete(id);
        } else if (!due) break;
      }
      time = end;
      onFrame?.();
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function setup(options = {}) {
  const viewer = createViewer(options.viewer);
  orbit(viewer, options.view);
  const doc = createDocument();
  const clock = createClock();
  const navigations = [];
  const toasts = [];
  const handle = mountNavControl({
    viewer,
    showToast: (message) => toasts.push(message),
    parent: doc.body,
    document: doc,
    now: clock.now,
    timers: clock.timers,
    runNavigation:
      options.runNavigation ||
      ((noun, navigate) => {
        navigations.push(noun);
        return navigate();
      }),
  });
  const frame = () => readCameraTargetFrame(viewer);
  const settle = (ms = 1_000) =>
    clock.advance(ms, () => viewer.scene.preUpdate.raiseEvent());
  const button = (name) =>
    handle.root.querySelectorAll(`[data-nav="${name}"]`)[0];
  return {
    viewer,
    doc,
    clock,
    handle,
    navigations,
    toasts,
    frame,
    settle,
    button,
  };
}

test('the control mounts once per viewer and removes itself on destroy', () => {
  const { doc, handle, viewer, clock } = setup();
  const roots = () => doc.body.children.filter((n) => n.tagName === 'SECTION');
  assert.equal(roots().length, 1);
  assert.equal(roots()[0].getAttribute('data-gev-nav-control'), '');
  assert.equal(roots()[0].getAttribute('role'), 'group');
  assert.equal(roots()[0].getAttribute('aria-label'), 'Map navigation');

  // A second mount for the same viewer returns the live control.
  const again = mountNavControl({
    viewer,
    parent: doc.body,
    document: doc,
    timers: clock.timers,
  });
  assert.equal(again, handle);
  assert.equal(roots().length, 1, 'no second control');

  handle.destroy();
  assert.equal(roots().length, 0);
  handle.destroy(); // idempotent
  const remounted = mountNavControl({
    viewer,
    parent: doc.body,
    document: doc,
    timers: clock.timers,
  });
  assert.notEqual(remounted, handle);
  assert.equal(roots().length, 1);
  remounted.destroy();
});

test('every control is a focusable, labelled element', () => {
  const { handle } = setup();
  const controls = handle.root.querySelectorAll('[data-nav]');
  const names = controls.map((node) => node.getAttribute('data-nav')).sort();
  assert.deepEqual(names, [
    'look-down',
    'look-left',
    'look-right',
    'look-up',
    'north',
    'ring',
    'tilt-down',
    'tilt-slider',
    'tilt-up',
    'top-down',
    'zoom-in',
    'zoom-out',
  ]);
  for (const node of controls) {
    assert.ok(node.getAttribute('aria-label'), `${node.tagName} has a label`);
    if (node.tagName === 'BUTTON')
      assert.equal(node.getAttribute('type'), 'button');
  }
  const ring = controls.find((n) => n.getAttribute('data-nav') === 'ring');
  assert.equal(ring.getAttribute('role'), 'slider');
  assert.equal(ring.getAttribute('tabindex'), '0');
  const slider = controls.find(
    (n) => n.getAttribute('data-nav') === 'tilt-slider',
  );
  assert.equal(slider.getAttribute('type'), 'range');
  assert.equal(slider.getAttribute('max'), '179');
  const title = 'Tilt: top-down (bottom) to straight up (top)';
  assert.equal(slider.getAttribute('title'), title);
  assert.equal(slider.getAttribute('aria-label'), title);
});

test('zoom buttons move the real camera toward and away from the target', () => {
  const { button, frame, settle } = setup({ view: { range: 1_000 } });
  button('zoom-in').fire('click', { detail: 0 }); // keyboard activation
  settle();
  assert.ok(Math.abs(frame().range - 700) < 1, `range ${frame().range}`);
  button('zoom-out').fire('click', { detail: 0 });
  settle();
  assert.ok(Math.abs(frame().range - 1_000) < 2, `range ${frame().range}`);
});

test('zoom keeps the heading and pitch of the view', () => {
  const { button, frame, settle } = setup({
    view: { heading: 120, pitch: -35, range: 2_000 },
  });
  button('zoom-in').fire('click', { detail: 0 });
  settle();
  const after = frame();
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.heading) - 120) < 0.01);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.pitch) + 35) < 0.01);
});

test('a pointer click acts once, on pointerdown, not again on its click', () => {
  const { button, frame, settle } = setup({ view: { range: 1_000 } });
  const zoomIn = button('zoom-in');
  zoomIn.fire('pointerdown', { button: 0 });
  zoomIn.fire('pointerup', { button: 0 });
  zoomIn.fire('click', { detail: 1 }); // the compatibility click
  settle();
  assert.ok(Math.abs(frame().range - 700) < 1, `range ${frame().range}`);
});

test('holding a zoom button repeats until released, within the clamp', () => {
  const { button, frame, settle, clock } = setup({ view: { range: 1_000 } });
  const zoomIn = button('zoom-in');
  zoomIn.fire('pointerdown', { button: 0 });
  settle(380 + 130 * 3 + 20); // first repeat delay, then three repeats
  zoomIn.fire('pointerup', { button: 0 });
  assert.equal(clock.pendingCount, 0, 'release cancels the repeat timers');
  settle(1_000); // let the last step finish easing
  const held = frame().range;
  // The press plus three repeats is four steps of 30 percent.
  assert.ok(held <= 1_000 * 0.7 ** 3, `repeated while held: ${held}`);
  assert.ok(held >= 1_000 * 0.7 ** 6, `not runaway: ${held}`);
  settle(2_000);
  assert.equal(frame().range, held, 'no more steps after release');
});

test('holding zoom-in never goes below the minimum distance', () => {
  const { button, frame, settle } = setup({ view: { range: 200 } });
  const zoomIn = button('zoom-in');
  zoomIn.fire('pointerdown', { button: 0 });
  settle(5_000);
  zoomIn.fire('pointerup', { button: 0 });
  assert.ok(frame().range >= 39.9, `range ${frame().range}`);
});

test('tilt buttons change the pitch in 10 degree steps and stop at the ends', () => {
  const { button, frame, settle } = setup({
    view: { pitch: -45, range: 4_000 },
  });
  button('tilt-up').fire('click', { detail: 0 });
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 35) < 0.05);
  button('tilt-down').fire('click', { detail: 0 });
  button('tilt-down').fire('click', { detail: 0 });
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 55) < 0.05);
  for (let i = 0; i < 3; i++) {
    button('tilt-up').fire('click', { detail: 0 });
    settle();
  }
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 25) < 0.05);
  for (let i = 0; i < 12; i++) button('tilt-down').fire('click', { detail: 0 });
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 89) < 0.05);
});

test('tilt-up from the orbit limit enters look-up and runs on to straight up', () => {
  const { button, viewer, handle, settle } = setup({
    view: { pitch: -10, range: 4_000 },
  });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  button('tilt-up').fire('click', { detail: 0 });
  settle();
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1,
    'the camera stays at the orbit limit',
  );
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) - 0) < 0.1);
  for (let i = 0; i < 12; i++) button('tilt-up').fire('click', { detail: 0 });
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) - 90) < 0.1);
  for (let i = 0; i < 30; i++) button('tilt-down').fire('click', { detail: 0 });
  settle();
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'orbit');
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) + 89) < 0.1,
    `back to top-down: ${Cesium.Math.toDegrees(viewer.camera.pitch)}`,
  );
});

test('the top-down button leaves look-up around its orbit', () => {
  const { button, viewer, frame, settle } = setup({
    view: { pitch: -10, range: 4_000 },
  });
  button('tilt-slider').value = '179';
  button('tilt-slider').fire('input');
  button('top-down').fire('click', { detail: 0 });
  settle();
  assert.ok(Math.abs(frame().pitch - TOP_DOWN_PITCH) < 1e-3);
  assert.ok(Math.abs(frame().range - 4_000) < 1);
  assert.ok(viewer.camera.positionCartographic.height > 3_900);
});

test('the top-down button returns to straight down', () => {
  const { button, frame, settle } = setup({ view: { pitch: -25 } });
  button('top-down').fire('click', { detail: 0 });
  settle();
  assert.ok(Math.abs(frame().pitch - TOP_DOWN_PITCH) < 1e-3);
});

test('north-up turns the shorter way and keeps pitch and range', () => {
  const { button, frame, settle } = setup({
    view: { heading: 350, pitch: -40, range: 1_500 },
  });
  button('north').fire('click', { detail: 0 });
  settle();
  const after = frame();
  const heading = Cesium.Math.toDegrees(after.heading);
  assert.ok(heading < 0.05 || heading > 359.95, `heading ${heading}`);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.pitch) + 40) < 0.05);
  assert.ok(Math.abs(after.range - 1_500) < 1);
});

test('dragging the ring a quarter turn clockwise turns the heading by 90 degrees', () => {
  const { handle, viewer, frame, button } = setup({
    view: { heading: 0, pitch: -45, range: 1_000 },
  });
  const ring = button('ring');
  // Ring centre is (140,140). Start at 3 o'clock, end at 6 o'clock.
  ring.fire('pointerdown', {
    button: 0,
    clientX: 180,
    clientY: 140,
    pointerId: 7,
  });
  assert.deepEqual(ring.captured, [7], 'the ring captures the pointer');
  assert.equal(handle.root.getAttribute('data-dragging'), 'ring');
  ring.fire('pointermove', { clientX: 170, clientY: 168 });
  ring.fire('pointermove', { clientX: 140, clientY: 180 });
  ring.fire('pointerup', { pointerId: 7 });
  assert.equal(handle.root.getAttribute('data-dragging'), null);
  const heading = Cesium.Math.toDegrees(frame().heading);
  assert.ok(Math.abs(heading - 270) < 0.1, `heading ${heading}`);
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 45) < 0.05);
  assert.ok(Math.abs(frame().range - 1_000) < 1);
  assert.equal(
    handle.root.styles.get('--gev-nav-heading'),
    `${Math.round(Cesium.Math.toDegrees(viewer.camera.heading)) % 360}deg`,
  );
  assert.equal(button('ring').getAttribute('aria-valuenow'), '270');
});

test('ring arrow keys turn the view and Home faces north', () => {
  const { button, frame, settle } = setup({ view: { heading: 40 } });
  const ring = button('ring');
  const event = ring.fire('keydown', { key: 'ArrowRight' });
  assert.equal(event.defaultPrevented, true);
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().heading) - 55) < 0.05);
  ring.fire('keydown', { key: 'Home' });
  settle();
  const heading = Cesium.Math.toDegrees(frame().heading);
  assert.ok(heading < 0.05 || heading > 359.95, `heading ${heading}`);
  assert.equal(ring.fire('keydown', { key: 'a' }).defaultPrevented, false);
});

test('the tilt slider sets the pitch directly and the clamp applies', () => {
  const { button, frame, viewer } = setup({
    view: { heading: 25, pitch: -45, range: 3_000 },
  });
  const slider = button('tilt-slider');
  slider.value = '60'; // 60 degrees from top-down => -29 degrees
  slider.fire('input');
  const after = frame();
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.pitch) + 29) < 0.05);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.heading) - 25) < 0.05);
  assert.ok(Math.abs(after.range - 3_000) < 1);
  slider.value = '79';
  slider.fire('input');
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 10) < 0.05);
  slider.value = '0';
  slider.fire('input');
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 89) < 0.05);
  assert.ok(viewer.camera.positionCartographic.height > 0);
});

test('the slider top looks straight up without moving the camera off its orbit limit', () => {
  const { button, viewer, handle, frame } = setup({
    view: { heading: 25, pitch: -45, range: 3_000 },
  });
  const slider = button('tilt-slider');
  slider.value = '79';
  slider.fire('input');
  const atLimit = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const limitHeight = viewer.camera.positionCartographic.height;
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'orbit');
  assert.ok(
    Math.abs(limitHeight - 3_000 * Math.sin(10 * DEG)) < 1,
    `orbit limit height ${limitHeight}`,
  );

  slider.value = '179';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  assert.ok(
    Cesium.Cartesian3.distance(atLimit, viewer.camera.positionWC) < 1e-6,
    'the camera did not move',
  );
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) - 90) < 0.1);
  assert.equal(handle.root.getAttribute('data-tilt-limited'), null);

  // Back to the bottom: the orbit around the stored anchor, top-down.
  slider.value = '0';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'orbit');
  const after = frame();
  assert.ok(Math.abs(after.pitch - TOP_DOWN_PITCH) < 1e-3);
  assert.ok(Math.abs(after.range - 3_000) < 1);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.heading) - 25) < 0.1);
  assert.ok(Cesium.Cartesian3.distance(after.target, GROUND) < 1);
});

test('the slider midway up the look range orbits to the limit and tilts the gaze above the horizon', () => {
  const { button, viewer, handle } = setup({
    view: { pitch: -45, range: 2_000 },
  });
  const slider = button('tilt-slider');
  slider.value = '99'; // 10 degrees above the horizon
  slider.fire('input');
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) - 10) < 0.1);
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  // The camera that actually ended up there is above the ground.
  assert.ok(viewer.camera.positionCartographic.height > 300);
});

test('a camera moved after look-up is no longer anchored', () => {
  const { button, viewer, handle } = setup({
    view: { pitch: -45, range: 2_000 },
  });
  const slider = button('tilt-slider');
  slider.value = '179';
  slider.fire('input');
  // The user pans: anything else moves the camera.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7, 30.3, 2_000),
    orientation: { heading: 0, pitch: Math.PI / 2, roll: 0 },
  });
  const moved = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  slider.value = '100';
  slider.fire('input');
  assert.ok(Cesium.Cartesian3.distance(moved, viewer.camera.positionWC) < 1e-3);
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) - 11) < 0.1);
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
});

test('terrain keeps the camera high: the orbit lifts, the view tilts, the toast shows once', () => {
  const heights = [];
  // Ground rises to 168 m under the camera, which the 10-degree lean at
  // 1000 m (174 m up) would nearly touch.
  const { button, viewer, handle, toasts } = setup({
    viewer: {
      sampleHeight: (carto) => {
        heights.push(carto.height);
        return 168;
      },
    },
    view: { pitch: -45, range: 1_000 },
  });
  const slider = button('tilt-slider');
  slider.fire('pointerdown');
  slider.value = '150';
  slider.fire('input');
  slider.value = '179';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  assert.equal(handle.root.getAttribute('data-tilt-limited'), 'terrain');
  assert.equal(
    slider.getAttribute('title'),
    'Tilt: camera held at a safe height above the terrain; the view tilts instead',
  );
  assert.deepEqual(toasts, [
    'Camera held above the terrain; tilting the view instead',
  ]);
  const height = viewer.camera.positionCartographic.height;
  assert.ok(height - 168 >= 8, `camera clears the terrain: ${height - 168} m`);
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) - 90) < 0.1);

  // A new gesture may toast again; the limit clears once the orbit is free.
  slider.fire('pointerup');
  slider.fire('pointerdown');
  slider.value = '179';
  slider.fire('input');
  assert.equal(toasts.length, 2);
  slider.value = '0';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-limited'), null);
  assert.equal(
    slider.getAttribute('title'),
    'Tilt: top-down (bottom) to straight up (top)',
  );
});

test('a terrain-lifted orbit limit holds the camera and turns the gaze to the wanted pitch', () => {
  const { button, viewer, handle, toasts } = setup({
    viewer: { sampleHeight: () => 168 },
    view: { pitch: -45, range: 1_000 },
  });
  const slider = button('tilt-slider');
  slider.value = '79';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  assert.ok(Math.abs(Cesium.Math.toDegrees(viewer.camera.pitch) + 10) < 0.1);
  assert.equal(handle.root.getAttribute('data-tilt-limited'), 'terrain');
  assert.equal(toasts.length, 1);
  assert.ok(viewer.camera.positionCartographic.height - 168 >= 8);
});

test('holding tilt-up into the terrain limit toasts once per press, not per repeat', () => {
  const { button, handle, toasts, settle } = setup({
    viewer: { sampleHeight: () => 168 },
    view: { pitch: -15, range: 1_000 },
  });
  const tiltUp = button('tilt-up');
  tiltUp.fire('pointerdown', { button: 0 });
  settle(380 + 130 * 5 + 20); // the press plus five repeats
  tiltUp.fire('pointerup', { button: 0 });
  settle(1_000);
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  assert.equal(handle.root.getAttribute('data-tilt-limited'), 'terrain');
  assert.equal(toasts.length, 1, `one toast for one hold: ${toasts.length}`);
  // A new press, or a keyboard activation, is a new gesture.
  tiltUp.fire('pointerdown', { button: 0 });
  tiltUp.fire('pointerup', { button: 0 });
  assert.equal(toasts.length, 2);
  tiltUp.fire('click', { detail: 0 });
  assert.equal(toasts.length, 3);
});

test('a slider drag or key press after a button press is a new gesture and may toast again', () => {
  const { button, toasts, settle } = setup({
    viewer: { sampleHeight: () => 168 },
    view: { pitch: -15, range: 1_000 },
  });
  const tiltUp = button('tilt-up');
  tiltUp.fire('pointerdown', { button: 0 });
  tiltUp.fire('pointerup', { button: 0 });
  settle(1_000);
  assert.equal(toasts.length, 1);
  const slider = button('tilt-slider');
  slider.fire('pointerdown');
  slider.value = '170';
  slider.fire('input');
  slider.value = '175';
  slider.fire('input');
  slider.fire('pointerup');
  assert.equal(toasts.length, 2, 'the drag toasts once');
  // Keyboard: a fresh key press is a gesture; its auto-repeat is not.
  slider.fire('keydown', { key: 'ArrowUp', repeat: false });
  slider.value = '176';
  slider.fire('input');
  slider.fire('keydown', { key: 'ArrowUp', repeat: true });
  slider.value = '177';
  slider.fire('input');
  assert.equal(toasts.length, 3);
});

test('looking up after the camera was moved clears a stale terrain-limit title', () => {
  const { button, viewer, handle } = setup({
    viewer: { sampleHeight: () => 168 },
    view: { pitch: -45, range: 1_000 },
  });
  const slider = button('tilt-slider');
  slider.value = '179';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-limited'), 'terrain');
  // Something else moves the camera (still looking up): the anchor is gone.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7, 30.3, 2_000),
    orientation: { heading: 0, pitch: Math.PI / 4, roll: 0 },
  });
  slider.value = '150';
  slider.fire('input');
  assert.equal(handle.root.getAttribute('data-tilt-mode'), 'look-up');
  assert.equal(handle.root.getAttribute('data-tilt-limited'), null);
  assert.equal(
    slider.getAttribute('title'),
    'Tilt: top-down (bottom) to straight up (top)',
  );
});

test('look around turns the gaze without moving the camera', () => {
  const { button, viewer } = setup({ view: { heading: 30, pitch: -45 } });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const headingBefore = viewer.camera.heading;
  button('look-left').fire('click', { detail: 0 });
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-3,
    'camera stays where it is',
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(headingBefore - viewer.camera.heading) - 3) <
      0.05,
  );
});

test('every action goes through the navigation policy; a refusal leaves the camera alone', () => {
  const calls = [];
  const { button, viewer, settle } = setup({
    runNavigation: (noun) => {
      calls.push(noun);
      return false; // e.g. cockpit owns the camera
    },
  });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  for (const name of ['zoom-in', 'tilt-up', 'north', 'top-down', 'look-left'])
    button(name).fire('click', { detail: 0 });
  button('ring').fire('keydown', { key: 'ArrowLeft' });
  settle();
  assert.deepEqual(calls, Array(6).fill('camera'));
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-6,
    'refused navigation does not move the camera',
  );
});

test('a wild centre pick falls back to the ground under the centre', () => {
  // 13 km below the ellipsoid, as a depth glitch returns while tiles stream.
  const wild = Cesium.Cartesian3.fromDegrees(-97.6, 30.5, -13_000);
  assert.equal(plausibleTarget(wild), false);
  assert.equal(plausibleTarget(GROUND), true);
  assert.equal(plausibleTarget(null), false);
  const { button, viewer, settle } = setup({
    viewer: { pick: wild, ground: GROUND },
    view: { range: 1_000 },
  });
  button('zoom-in').fire('click', { detail: 0 });
  settle();
  const height = viewer.camera.positionCartographic.height;
  assert.ok(height > 0, `camera stays above ground, height ${height}`);
  const frame = frameForTarget(viewer.camera, GROUND);
  assert.ok(Math.abs(frame.range - 700) < 1, `range ${frame.range}`);
});

test('with no ground under the centre the control works in place', () => {
  const { button, viewer, settle } = setup({
    viewer: { pick: null, ground: null },
  });
  // Looking above the horizon: upstream's query port (#1760) intersects the
  // ellipsoid itself, so a downward view always has ground under its centre.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_000),
    orientation: { heading: 90 * DEG, pitch: 5 * DEG, roll: 0 },
  });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  button('north').fire('click', { detail: 0 });
  settle();
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-3,
  );
  assert.ok(
    Cesium.Math.toDegrees(viewer.camera.heading) < 0.05 ||
      Cesium.Math.toDegrees(viewer.camera.heading) > 359.95,
  );
});

test('orbitCameraPosition agrees with Cesium lookAt', () => {
  const viewer = createViewer();
  orbit(viewer, { heading: 135, pitch: -35, range: 2_500 });
  const mine = orbitCameraPosition(GROUND, {
    heading: 135 * DEG,
    pitch: -35 * DEG,
    range: 2_500,
  });
  assert.ok(Cesium.Cartesian3.distance(mine, viewer.camera.positionWC) < 0.01);
});

test('destroy stops animation, hold timers and listeners', () => {
  const { button, handle, clock, viewer } = setup({ view: { range: 1_000 } });
  button('zoom-in').fire('pointerdown', { button: 0 });
  assert.ok(clock.pendingCount > 0);
  handle.destroy();
  assert.equal(clock.pendingCount, 0);
  const position = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  viewer.scene.preUpdate.raiseEvent();
  assert.ok(
    Cesium.Cartesian3.distance(position, viewer.camera.positionWC) < 1e-6,
  );
});
