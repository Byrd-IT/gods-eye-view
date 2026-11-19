import '../../render/cesium/unbound.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  NAV_HEADING_MAX_DEG,
  NAV_MAX_STEPS,
  NAV_TILT_MAX_DEG,
  NAV_VOICE_ACTIONS,
  createNavVoice,
  mountNavControl,
} from './navControl.js';
import { readCameraTargetFrame } from '../../ui/cameraOrientationControls.js';

const DEG = Math.PI / 180;
const GROUND = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0);

// ── a very small DOM: enough to build and query the control ─────────────
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
  setPointerCapture() {}
}

function createDocument() {
  const body = new FakeElement('body');
  return {
    body,
    createElement: (tag) => new FakeElement(tag),
  };
}

// ── a real Cesium camera orbiting a fixed ground point ───────────────────
function createViewer({ pick = GROUND, ground = GROUND } = {}) {
  const scene = {
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
  return {
    camera,
    scene,
    canvas: scene.canvas,
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
  };
}

function orbit(viewer, { heading = 30, pitch = -45, range = 1_000 } = {}) {
  viewer.camera.lookAt(
    GROUND,
    new Cesium.HeadingPitchRange(heading * DEG, pitch * DEG, range),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

function setup(options = {}) {
  const viewer = createViewer(options.viewer);
  orbit(viewer, options.view);
  const doc = createDocument();
  const hookWindow = options.hookWindow ?? {};
  const navigations = [];
  const handle = mountNavControl({
    viewer,
    parent: doc.body,
    document: doc,
    hookWindow,
    runNavigation:
      options.runNavigation ||
      ((noun, navigate) => {
        navigations.push(noun);
        return navigate();
      }),
  });
  const frame = () => readCameraTargetFrame(viewer);
  return { viewer, doc, hookWindow, handle, navigations, frame };
}

// ── the adapter on its own, over a fake widget ──────────────────────────
function fakeHandle(overrides = {}) {
  const calls = [];
  const handle = {
    destroyed: false,
    calls,
    setTilt: (deg) => {
      calls.push(['setTilt', deg]);
      return true;
    },
    setHeading: (deg) => {
      calls.push(['setHeading', deg]);
      return true;
    },
    applySteps: (action, count) => {
      calls.push(['applySteps', action, count]);
      return true;
    },
    state: () => ({ heading: 12, tilt: 30, rangeM: 900 }),
    ...overrides,
  };
  return handle;
}

test('a throwing handle provider is contained', async () => {
  const voice = createNavVoice({ getHandle: () => { throw new Error('sensitive-fixture'); } });
  const result = await voice.status();
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture/);
});

test('the adapter exposes exactly the documented actions', () => {
  assert.deepEqual(
    [...NAV_VOICE_ACTIONS],
    ['tilt', 'heading', 'zoom', 'top_down', 'north', 'look', 'status'],
  );
  const voice = createNavVoice({ getHandle: () => fakeHandle() });
  for (const action of NAV_VOICE_ACTIONS)
    assert.equal(typeof voice[action], 'function', `${action} is callable`);
});

test('tilt accepts whole degrees from 0 to 79 and refuses the rest', async () => {
  const handle = fakeHandle();
  const voice = createNavVoice({ getHandle: () => handle });
  const ok = await voice.tilt({ tilt: 40 });
  assert.equal(ok.ok, true);
  assert.equal(ok.tilt, 30, 'the camera readback comes back');
  assert.deepEqual(handle.calls[0], ['setTilt', 40]);

  for (const tilt of [-1, NAV_TILT_MAX_DEG + 1, 4.5, '40', null, undefined])
    assert.equal(
      (await voice.tilt({ tilt })).ok,
      false,
      `tilt ${tilt} refused`,
    );
  assert.equal(handle.calls.length, 1, 'only the good call reached the widget');
});

test('heading accepts whole degrees from 0 to 359 and refuses the rest', async () => {
  const handle = fakeHandle();
  const voice = createNavVoice({ getHandle: () => handle });
  const ok = await voice.heading({ heading: 359 });
  assert.equal(ok.ok, true);
  assert.deepEqual(handle.calls[0], ['setHeading', 359]);
  for (const heading of [-1, NAV_HEADING_MAX_DEG + 1, 12.5, '90', null])
    assert.equal((await voice.heading({ heading })).ok, false);
  assert.equal(handle.calls.length, 1);
});

test('zoom needs a direction and steps within the bound', async () => {
  const handle = fakeHandle();
  const voice = createNavVoice({ getHandle: () => handle });
  const ok = await voice.zoom({ direction: 'in', steps: 3 });
  assert.equal(ok.ok, true);
  assert.deepEqual(handle.calls[0], ['applySteps', 'zoom-in', 3]);
  assert.equal((await voice.zoom({ direction: 'sideways' })).ok, false);
  assert.equal((await voice.zoom({})).ok, false);
  assert.equal(
    (await voice.zoom({ direction: 'out', steps: NAV_MAX_STEPS + 1 })).ok,
    false,
  );
  assert.equal((await voice.zoom({ direction: 'out', steps: 0 })).ok, false);
});

test('look needs a direction and steps within the bound', async () => {
  const handle = fakeHandle();
  const voice = createNavVoice({ getHandle: () => handle });
  const ok = await voice.look({ direction: 'left' });
  assert.equal(ok.ok, true);
  assert.deepEqual(handle.calls[0], ['applySteps', 'look-left', 1]);
  assert.equal((await voice.look({ direction: 'up' })).ok, true);
  assert.equal((await voice.look({ direction: 'sideways' })).ok, false);
  assert.equal((await voice.look({})).ok, false);
  assert.equal(
    (await voice.look({ direction: 'up', steps: NAV_MAX_STEPS + 1 })).ok,
    false,
  );
});

test('top_down, north and status need no arguments', async () => {
  const handle = fakeHandle();
  const voice = createNavVoice({ getHandle: () => handle });
  assert.equal((await voice.top_down()).ok, true);
  assert.equal((await voice.north()).ok, true);
  const status = await voice.status();
  assert.equal(status.ok, true);
  assert.equal(status.heading, 12);
  assert.deepEqual(handle.calls, [
    ['applySteps', 'top-down', 1],
    ['applySteps', 'north', 1],
  ]);
});

test('a widget that refuses a move answers with an error, not a throw', async () => {
  const voice = createNavVoice({
    getHandle: () => fakeHandle({ setTilt: () => false }),
  });
  const result = await voice.tilt({ tilt: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /refused/i);
});

test('a widget that throws answers with an error, not a throw', async () => {
  const voice = createNavVoice({
    getHandle: () =>
      fakeHandle({
        applySteps: () => {
          throw new Error('boom');
        },
      }),
  });
  const result = await voice.zoom({ direction: 'in' });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});

test('a destroyed or missing widget is unavailable', async () => {
  const gone = createNavVoice({ getHandle: () => null });
  assert.equal((await gone.status()).ok, false);
  const destroyed = createNavVoice({
    getHandle: () => fakeHandle({ destroyed: true }),
  });
  const result = await destroyed.north();
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/i);
});

test('errors never repeat the caller text', async () => {
  const voice = createNavVoice({ getHandle: () => fakeHandle() });
  const result = await voice.tilt({ tilt: 'secret-value' });
  assert.equal(result.ok, false);
  assert.ok(!result.error.includes('secret-value'));
});

// ── the adapter over the real widget ────────────────────────────────────
test('voice tilt moves the real camera and reads the tilt back', async () => {
  const { handle, frame, viewer } = setup({
    view: { heading: 20, pitch: -45, range: 3_000 },
  });
  const result = await handle.voice.tilt({ tilt: 40 });
  assert.equal(result.ok, true);
  const after = frame();
  // 40 degrees from top-down is a pitch of -49 degrees.
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(after.pitch) + 49) < 0.05,
    `pitch ${Cesium.Math.toDegrees(after.pitch)}`,
  );
  assert.equal(result.tilt, 40);
  assert.ok(viewer.camera.positionCartographic.height > 0);
});

test('voice heading turns the real camera to the asked bearing', async () => {
  const { handle, frame } = setup({
    view: { heading: 30, pitch: -45, range: 2_000 },
  });
  const result = await handle.voice.heading({ heading: 210 });
  assert.equal(result.ok, true);
  const heading = Cesium.Math.toDegrees(frame().heading);
  assert.ok(Math.abs(heading - 210) < 0.05, `heading ${heading}`);
  assert.equal(result.heading, 210);
});

test('voice zoom in and out move the real camera', async () => {
  const { handle, frame } = setup({ view: { range: 1_000 } });
  const zoomed = await handle.voice.zoom({ direction: 'in' });
  assert.equal(zoomed.ok, true);
  assert.ok(Math.abs(frame().range - 700) < 1, `range ${frame().range}`);
  const out = await handle.voice.zoom({ direction: 'out' });
  assert.equal(out.ok, true);
  assert.ok(Math.abs(frame().range - 1_000) < 2, `range ${frame().range}`);
});

test('voice zoom chains the steps it was given', async () => {
  const { handle, frame } = setup({ view: { range: 1_000 } });
  const result = await handle.voice.zoom({ direction: 'in', steps: 2 });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(frame().range - 490) < 2, `range ${frame().range}`);
});

test('voice top_down and north use the widget behaviour', async () => {
  const { handle, frame } = setup({
    view: { heading: 120, pitch: -30, range: 1_500 },
  });
  const down = await handle.voice.top_down();
  assert.equal(down.ok, true);
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 89) < 0.05);
  assert.equal(down.topDown, true);
  const north = await handle.voice.north();
  assert.equal(north.ok, true);
  const heading = Cesium.Math.toDegrees(frame().heading);
  assert.ok(heading < 0.05 || heading > 359.95, `heading ${heading}`);
  assert.equal(north.northUp, true);
});

test('voice look turns the gaze without moving the camera', async () => {
  const { handle, viewer } = setup({ view: { heading: 30, pitch: -45 } });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const result = await handle.voice.look({ direction: 'right' });
  assert.equal(result.ok, true);
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-3,
    'the camera stays where it is',
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(viewer.camera.heading) - 33) < 0.05,
    `heading ${Cesium.Math.toDegrees(viewer.camera.heading)}`,
  );
});

test('voice status reads the camera back', async () => {
  const { handle, frame } = setup({
    view: { heading: 45, pitch: -45, range: 1_200 },
  });
  const result = await handle.voice.status();
  assert.equal(result.ok, true);
  assert.equal(result.heading, 45);
  assert.equal(
    result.tilt,
    44,
    '45 degrees below the horizon is 44 from top-down',
  );
  assert.ok(Math.abs(result.rangeM - 1_200) < 5, `range ${result.rangeM}`);
  assert.equal(result.following, false);
  assert.equal(result.northUp, false);
});

test('a refused navigation leaves the camera alone and says so', async () => {
  const { handle, viewer } = setup({
    runNavigation: () => false, // e.g. the cockpit owns the camera
  });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  for (const action of ['north', 'top_down'])
    assert.equal((await handle.voice[action]()).ok, false);
  assert.equal((await handle.voice.tilt({ tilt: 20 })).ok, false);
  assert.equal((await handle.voice.heading({ heading: 90 })).ok, false);
  assert.equal((await handle.voice.zoom({ direction: 'in' })).ok, false);
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-6,
    'a refused move does not touch the camera',
  );
});

// ── the published surface ───────────────────────────────────────────────
test('the mounted control publishes window.__gevNav.voice', async () => {
  const hookWindow = {};
  const { handle } = setup({ hookWindow });
  assert.ok(hookWindow.__gevNav, 'the hook is published');
  assert.equal(typeof hookWindow.__gevNav.voice, 'object');
  assert.equal(typeof hookWindow.__gevNav.voice.status, 'function');
  assert.equal(hookWindow.__gevNav.voice, handle.voice);
  const result = await hookWindow.__gevNav.voice.status();
  assert.equal(result.ok, true);
});

test('destroying the control takes the published hook with it', async () => {
  const hookWindow = {};
  const { handle } = setup({ hookWindow });
  handle.destroy();
  assert.equal(hookWindow.__gevNav, undefined);
});

test('a remount publishes a fresh hook and the old destroy leaves it alone', async () => {
  const hookWindow = {};
  const { handle, viewer, doc } = setup({ hookWindow });
  const first = hookWindow.__gevNav;
  handle.destroy();
  const remounted = mountNavControl({
    viewer,
    parent: doc.body,
    document: doc,
    hookWindow,
  });
  assert.ok(hookWindow.__gevNav);
  assert.notEqual(hookWindow.__gevNav, first);
  assert.equal(hookWindow.__gevNav.voice, remounted.voice);
  remounted.destroy();
  assert.equal(hookWindow.__gevNav, undefined);
});

test('the published voice answers when the widget is gone', async () => {
  const hookWindow = {};
  const { handle } = setup({ hookWindow });
  const voice = hookWindow.__gevNav.voice;
  handle.destroy();
  const result = await voice.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/i);
});
