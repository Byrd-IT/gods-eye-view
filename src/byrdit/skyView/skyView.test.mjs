import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  describeObserver,
  mountSkyView,
  skyViewFor,
  toLocalInputValue,
} from './skyView.js';
import { worldDirectionToAzEl } from './skyCamera.js';
import { createObserver } from './observer.js';
import { readFileSync } from 'node:fs';
import { createSatWorkerHandler } from './satWorker.js';

// ── a very small DOM ───────────────────────────────────────────────────────
class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.focused = false;
    this.width = 0;
    this.height = 0;
    this.drawCalls = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
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
  focus() {
    this.focused = true;
  }
  setPointerCapture() {}
  getContext() {
    const element = this;
    const noop = () => {};
    return new Proxy(
      {},
      {
        get(target, key) {
          if (key === 'createLinearGradient')
            return () => ({ addColorStop: noop });
          if (key === 'clearRect')
            return () => {
              element.drawCalls += 1;
            };
          if (key in target) return target[key];
          return noop;
        },
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      },
    );
  }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  find(name) {
    for (const node of this.descendants())
      if (node.getAttribute('data-sky') === name) return node;
    return null;
  }
}

function fakeDocument() {
  const doc = new EventTarget();
  doc.createElement = (tag) => new FakeElement(tag);
  doc.body = new FakeElement('body');
  const classes = new Set();
  doc.body.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
  };
  return doc;
}

function fakeTimers() {
  let id = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.set(id, { fn, ms, every: false });
      return id++;
    },
    clearTimeout: (handle) => pending.delete(handle),
    setInterval: (fn, ms) => {
      pending.set(id, { fn, ms, every: true });
      return id++;
    },
    clearInterval: (handle) => pending.delete(handle),
    /** Run every one-shot timer once (intervals stay). */
    flush() {
      for (const [key, timer] of [...pending]) {
        if (!timer.every) pending.delete(key);
        timer.fn();
      }
    },
  };
}

class FakeHandler {
  static last = null;
  constructor(canvas) {
    this.canvas = canvas;
    this.actions = new Map();
    this.destroyed = false;
    FakeHandler.last = this;
  }
  setInputAction(fn, type) {
    this.actions.set(type, fn);
  }
  destroy() {
    this.destroyed = true;
  }
}

const SkyCesium = { ...Cesium, ScreenSpaceEventHandler: FakeHandler };

function fakeViewer({ width = 1200, height = 800, pickHeight = 20 } = {}) {
  const canvas = new FakeElement('canvas');
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  const scene = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      show: true,
      enableLighting: false,
      dynamicAtmosphereLighting: true,
      dynamicAtmosphereLightingFromSun: false,
    },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
    preRender: new Cesium.Event(),
    skyBox: { show: true },
    skyAtmosphere: { show: true },
    screenSpaceCameraController: { enableInputs: true },
    primitives: { length: 0, get: () => undefined },
    pickPositionSupported: true,
    pickPosition: () =>
      Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, pickHeight),
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 3000),
    orientation: { heading: 0.4, pitch: -0.7, roll: 0 },
  });
  camera.frustum.fov = 1;
  camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, 0);
  scene.camera = camera;
  return {
    scene,
    camera,
    container: new FakeElement('div'),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    clock: new Cesium.Clock({
      currentTime: Cesium.JulianDate.fromIso8601('2026-10-11T12:00:00Z'),
      shouldAnimate: false,
    }),
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
  };
}

function fakeHistory(location) {
  return {
    state: null,
    writes: 0,
    replaceState(_state, _title, href) {
      this.writes += 1;
      location.href = href;
    },
  };
}

function setup(options = {}) {
  const doc = fakeDocument();
  const viewer = fakeViewer(options.viewer);
  const timers = fakeTimers();
  const location = {
    href: options.href || 'https://gev.test/#v=2&lat=30&lon=-97',
  };
  const history = fakeHistory(location);
  const toasts = [];
  const handle = mountSkyView({
    viewer,
    document: doc,
    timers,
    location,
    history,
    CesiumApi: SkyCesium,
    now: options.now ?? (() => Date.parse('2026-10-12T03:30:00Z')),
    showToast: (m) => toasts.push(m),
    geolocation: options.geolocation,
    isSecureContext: options.isSecureContext ?? true,
    geocode: options.geocode,
    runNavigation: options.runNavigation,
    lifetime: options.lifetime,
    createSatWorker: options.createSatWorker,
    fetchCelestrak: options.fetchCelestrak,
    requestFrame: options.requestFrame ?? (() => null),
    reducedMotion: options.reducedMotion,
    ...(options.orientationWindow
      ? { orientationWindow: options.orientationWindow }
      : {}),
    ...(options.offerPointing ? { offerPointing: options.offerPointing } : {}),
    ...(options.orientationOptions
      ? { orientationOptions: options.orientationOptions }
      : {}),
    ...(options.declinationAt ? { declinationAt: options.declinationAt } : {}),
  });
  return { doc, viewer, timers, location, history, handle };
}

const click = (node) => node.dispatchEvent(new Event('click'));
const pointer = (type, props) => Object.assign(new Event(type), props);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function poseDelta(camera, before) {
  return Math.max(
    Cesium.Cartesian3.distance(camera.position, before.position),
    Cesium.Cartesian3.distance(camera.direction, before.direction),
    Cesium.Cartesian3.distance(camera.up, before.up),
    Cesium.Cartesian3.distance(camera.right, before.right),
  );
}

test('mount: Sky button, panel, toolbar, overlay canvas; once per viewer; null without a DOM', () => {
  const { doc, viewer, handle } = setup();
  const button = doc.body.find('open');
  assert.ok(button);
  assert.equal(button.textContent, 'Sky');
  assert.ok(doc.body.find('panel').hidden);
  assert.ok(doc.body.find('bar').hidden);
  assert.ok(viewer.container.find('canvas').hidden);
  assert.equal(mountSkyView({ viewer, document: doc }), handle);
  assert.equal(skyViewFor(viewer), handle);
  assert.equal(skyViewFor(null), null);
  assert.equal(mountSkyView({ viewer: fakeViewer(), document: null }), null);
  assert.equal(mountSkyView({ viewer: null, document: doc }), null);
  click(button);
  assert.equal(doc.body.find('panel').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  click(doc.body.find('close'));
  assert.equal(doc.body.find('panel').hidden, true);
  handle.destroy();
  assert.equal(doc.body.find('open'), null);
  assert.equal(skyViewFor(viewer), null);
});

test('enter at typed lat, lon: eye at 1.7 m over unknown ground (0, flagged), inputs off, URL written; exit restores the camera to 1e-6', async () => {
  const { doc, viewer, timers, location, handle } = setup();
  const before = {
    position: Cesium.Cartesian3.clone(viewer.camera.position),
    direction: Cesium.Cartesian3.clone(viewer.camera.direction),
    up: Cesium.Cartesian3.clone(viewer.camera.up),
    right: Cesium.Cartesian3.clone(viewer.camera.right),
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
    fov: viewer.camera.frustum.fov,
    time: Cesium.JulianDate.clone(viewer.clock.currentTime),
  };
  click(doc.body.find('open'));
  doc.body.find('query').value = '29.7604 N 95.3698 W';
  doc.body.find('form').dispatchEvent(new Event('submit'));
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'manual');
  assert.equal(handle.observer.heightKnown, false);
  assert.equal(handle.observer.groundHeightM, 0);
  const carto = viewer.camera.positionCartographic;
  assert.ok(Math.abs(carto.height - 1.7) < 1e-6);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  assert.equal(viewer.scene.globe.enableLighting, true);
  assert.equal(doc.body.find('bar').hidden, false);
  assert.equal(viewer.container.find('canvas').hidden, false);
  assert.ok(viewer.container.find('canvas').drawCalls > 0, 'overlay drawn');
  assert.ok(doc.body.classList.contains('gev-sky-active'));
  assert.match(
    doc.body.find('info').textContent,
    /ground height unknown \(0 m used\)/,
  );
  assert.match(doc.body.find('info').textContent, /Sun -?\d+\.\d° \(/);
  timers.flush();
  assert.match(location.href, /[?&]sv=29\.7604,-95\.3698,0,20,70(&|#)/);
  assert.match(location.href, /#v=2&lat=30&lon=-97$/, 'hash untouched');

  click(doc.body.find('back'));
  assert.equal(handle.active, false);
  assert.ok(
    poseDelta(viewer.camera, before) < 1e-6,
    `pose delta ${poseDelta(viewer.camera, before)}`,
  );
  assert.ok(Math.abs(viewer.camera.heading - before.heading) < 1e-6);
  assert.ok(Math.abs(viewer.camera.pitch - before.pitch) < 1e-6);
  assert.ok(Math.abs(viewer.camera.roll - before.roll) < 1e-6);
  assert.equal(viewer.camera.frustum.fov, before.fov);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
  assert.equal(viewer.scene.globe.enableLighting, false);
  assert.equal(viewer.scene.skyBox.show, true);
  assert.ok(Cesium.JulianDate.equals(viewer.clock.currentTime, before.time));
  assert.equal(doc.body.find('bar').hidden, true);
  assert.ok(!doc.body.classList.contains('gev-sky-active'));
  assert.ok(!/[?&]sv=/.test(location.href), 'sv removed on exit');
});

test('drag, wheel and keys move the real Cesium camera; Escape leaves', async () => {
  const { viewer, handle } = setup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  const canvas = viewer.container.find('canvas');
  const az0 = handle.view.azDeg;
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 700, clientY: 450 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 700, clientY: 450 }),
  );
  assert.ok(
    handle.view.azDeg < az0 || handle.view.azDeg > 300,
    'drag right turns left',
  );
  assert.ok(handle.view.elDeg > 20, 'drag down looks up');
  const look = worldDirectionToAzEl(
    Cesium,
    viewer.camera.positionWC,
    viewer.camera.directionWC,
  );
  assert.ok(Math.abs(look.elDeg - handle.view.elDeg) < 1e-6);
  const fov0 = handle.view.fovDeg;
  canvas.dispatchEvent(
    Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -200 }),
  );
  assert.ok(handle.view.fovDeg < fov0);
  assert.ok(
    Math.abs(viewer.camera.frustum.fov - (handle.view.fovDeg * Math.PI) / 180) <
      1e-12,
  );
  // pinch: two pointers spreading apart zoom in
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 500, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 2, clientX: 700, clientY: 400 }),
  );
  const fov1 = handle.view.fovDeg;
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 2, clientX: 900, clientY: 400 }),
  );
  assert.ok(Math.abs(handle.view.fovDeg - fov1 / 2) < 1e-9);
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 2 }));
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 1 }));
  canvas.dispatchEvent(Object.assign(new Event('keydown'), { key: 'n' }));
  assert.equal(handle.view.azDeg, 0);
  canvas.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Z' }));
  assert.equal(handle.view.elDeg, 90);
  canvas.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(handle.active, false);
});

test('pick on map: one click on the globe sets the observer with the picked ground height', async () => {
  const { doc, viewer, handle } = setup({ viewer: { pickHeight: 20 } });
  click(doc.body.find('open'));
  click(doc.body.find('pick'));
  assert.ok(doc.body.classList.contains('gev-sky-picking'));
  const picker = FakeHandler.last;
  const action = picker.actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  action({ position: new Cesium.Cartesian2(10, 10) });
  await settle();
  assert.equal(picker.destroyed, true, 'one click only');
  assert.ok(!doc.body.classList.contains('gev-sky-picking'));
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'map');
  assert.equal(handle.observer.heightKnown, true);
  assert.ok(Math.abs(handle.observer.groundHeightM - 20) < 1e-6);
  assert.ok(Math.abs(viewer.camera.positionCartographic.height - 21.7) < 1e-6);
});

test('a wild pick (tile glitch) falls back to the ellipsoid and samples the height', async () => {
  const { doc, handle } = setup({ viewer: { pickHeight: -13_000 } });
  click(doc.body.find('open'));
  click(doc.body.find('here'));
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.heightKnown, false);
  assert.equal(handle.observer.groundHeightM, 0);
});

test('use my location: one press = one request; ready enters with the GPS fix and accuracy', async () => {
  const calls = [];
  const geolocation = {
    getCurrentPosition: (ok, fail, options) =>
      calls.push({ ok, fail, options }),
  };
  const { doc, handle } = setup({ geolocation });
  click(doc.body.find('open'));
  click(doc.body.find('gps'));
  click(doc.body.find('gps'));
  assert.equal(calls.length, 1);
  assert.equal(
    doc.body.find('status').textContent,
    'Waiting for your browser to allow location',
  );
  calls[0].ok({ coords: { latitude: 29.76, longitude: -95.37, accuracy: 30 } });
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'gps');
  assert.equal(handle.observer.accuracyM, 30);
  assert.match(doc.body.find('info').textContent, /\+\/- 30 m/);
});

test('location messages: denied, insecure context', async () => {
  const calls = [];
  const geolocation = {
    getCurrentPosition: (ok, fail) => calls.push({ ok, fail }),
  };
  const denied = setup({ geolocation });
  click(denied.doc.body.find('gps'));
  calls[0].fail({ code: 1 });
  await settle();
  assert.match(denied.doc.body.find('status').textContent, /Location blocked/);
  assert.equal(denied.handle.active, false);
  const insecure = setup({ geolocation, isSecureContext: false });
  click(insecure.doc.body.find('gps'));
  assert.equal(
    insecure.doc.body.find('status').textContent,
    'Location needs the https:// address',
  );
  assert.equal(calls.length, 1);
});

test('place search uses the existing keyless geocoder', async () => {
  const asked = [];
  const { doc, handle } = setup({
    geocode: async (q) => {
      asked.push(q);
      return { lat: 29.7604, lng: -95.3698, name: 'Houston' };
    },
  });
  doc.body.find('query').value = 'Houston';
  doc.body.find('form').dispatchEvent(new Event('submit'));
  for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(asked, ['Houston']);
  assert.equal(handle.active, true);
  assert.equal(handle.observer.latDeg, 29.7604);
  const miss = setup({ geocode: async () => null });
  miss.doc.body.find('query').value = 'Nowhere';
  miss.doc.body.find('form').dispatchEvent(new Event('submit'));
  for (let i = 0; i < 4; i++) await settle();
  assert.match(miss.doc.body.find('status').textContent, /No place found/);
  assert.equal(miss.handle.active, false);
});

test('flat horizon hides the globe; grid and live/fixed time go to the URL flags', async () => {
  const { doc, viewer, timers, location, handle } = setup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(doc.body.find('flat'));
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(doc.body.find('flat').getAttribute('aria-pressed'), 'true');
  click(doc.body.find('grid'));
  const time = doc.body.find('time');
  time.value = '2026-10-12T03:30';
  time.dispatchEvent(new Event('change'));
  assert.equal(handle.clock.mode, 'fixed');
  timers.flush();
  assert.match(location.href, /svf=3/);
  assert.match(location.href, /sv=[^&#]*,\d{4}-\d\d-\d\dT\d\d:\d\d:00Z/);
  click(doc.body.find('flat'));
  assert.equal(viewer.scene.globe.show, true);
  click(doc.body.find('live'));
  assert.equal(handle.clock.mode, 'live');
  handle.exit();
  assert.equal(viewer.scene.globe.show, true);
});

test('a shared sv link opens straight into the sky with its view, time and flags', async () => {
  const href =
    'https://gev.test/?sv=29.7604,-95.3698,250,12.5,40,2026-10-12T00:15:00Z&svf=2#v=2&lat=1&lon=2';
  const { viewer, timers, handle } = setup({ href });
  assert.equal(handle.active, false);
  timers.flush();
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'url');
  assert.equal(handle.view.azDeg, 250);
  assert.equal(handle.view.elDeg, 12.5);
  assert.equal(handle.view.fovDeg, 40);
  assert.equal(handle.flags.grid, true);
  assert.equal(handle.clock.mode, 'fixed');
  assert.equal(
    Cesium.JulianDate.toIso8601(viewer.clock.currentTime, 0),
    '2026-10-12T00:15:00Z',
  );
});

test('the shell navigation policy can refuse (cockpit); following hides the button', async () => {
  const { doc, viewer, handle } = setup({ runNavigation: () => false });
  await handle.enterAt({ latDeg: 1, lonDeg: 2, source: 'manual' });
  assert.equal(handle.active, false);
  assert.match(
    doc.body.find('status').textContent,
    /not available in this mode/,
  );
  viewer.trackedEntity = {};
  viewer.trackedEntityChanged.raiseEvent();
  assert.equal(doc.body.find('open').hidden, true);
  viewer.trackedEntity = undefined;
  viewer.trackedEntityChanged.raiseEvent();
  assert.equal(doc.body.find('open').hidden, false);
});

test('the shell lifetime destroys the view (and restores the camera if active)', async () => {
  const removers = new Set();
  const { doc, viewer, handle } = setup({ lifetime: { removers } });
  assert.equal(removers.size, 1);
  const pos = Cesium.Cartesian3.clone(viewer.camera.position);
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  for (const remove of removers) remove();
  assert.equal(handle.destroyed, true);
  assert.ok(Cesium.Cartesian3.distance(viewer.camera.position, pos) < 1e-6);
  assert.equal(doc.body.find('open'), null);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
});

test('another navigation taking the camera ends Sky mode without fighting it', async () => {
  const { viewer, timers, handle } = setup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  const tick = [...timers.pending.values()].find((t) => t.every);
  tick.fn();
  assert.equal(handle.active, true, 'camera still at the eye');
  const away = Cesium.Cartesian3.fromDegrees(-74, 40.7, 5000);
  viewer.camera.setView({ destination: away });
  tick.fn();
  assert.equal(handle.active, false);
  assert.ok(
    Cesium.Cartesian3.distance(viewer.camera.position, away) < 1e-6,
    'camera left where the other navigation put it',
  );
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
});

test('describeObserver and toLocalInputValue', () => {
  const o = createObserver({
    latDeg: 29.7604,
    lonDeg: -95.3698,
    groundHeightM: 15,
    heightKnown: true,
    accuracyM: 30,
  });
  assert.equal(
    describeObserver(o, { sunAltDeg: -3.25 }),
    '29.7604° N 95.3698° W · ground 15 m · +/- 30 m · Sun -3.3° (Civil twilight)',
  );
  assert.equal(describeObserver(null), '');
  assert.match(
    toLocalInputValue(Date.parse('2026-10-12T03:30:00Z')),
    /^\d{4}-\d\d-\d\dT\d\d:\d\d$/,
  );
});

// ── satellites (P2a) ───────────────────────────────────────────────────────
const SAT_FIXTURE = readFileSync(
  new URL('./reference/satFixture200.csv', import.meta.url),
  'utf8',
);

class InlineSatWorker extends EventTarget {
  constructor() {
    super();
    this.outbox = [];
    this.terminated = false;
    this.handle = createSatWorkerHandler((m) => this.outbox.push(m));
  }
  postMessage(message) {
    this.handle(message);
    queueMicrotask(() => this.deliver());
  }
  deliver() {
    for (const data of this.outbox.splice(0))
      this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  terminate() {
    this.terminated = true;
  }
}

function satSetup(extra = {}) {
  const worker = new InlineSatWorker();
  const fetched = [];
  const env = setup({
    createSatWorker: () => worker,
    fetchCelestrak: async (path) => {
      fetched.push(path);
      return path === 'active'
        ? SAT_FIXTURE
        : SAT_FIXTURE.split(/\r?\n/)[0] + '\r\n';
    },
    reducedMotion: () => true,
    ...extra,
  });
  return { ...env, worker, fetched };
}

async function pumpSats(worker) {
  for (let i = 0; i < 6; i++) {
    await settle();
    worker.deliver();
  }
}

const clickWithTarget = (node, target) => {
  const event = new Event('click');
  Object.defineProperty(event, 'target', { value: target });
  node.dispatchEvent(event);
};

test('satellites: worker starts on enter, panel lists overhead objects with the element-age banner', async () => {
  const { doc, handle, worker, fetched } = satSetup();
  assert.equal(doc.body.find('sats').hidden, true, 'hidden before Sky');
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(doc.body.find('sats').hidden, false);
  assert.ok(fetched.includes('active') && fetched.includes('stations'));
  assert.ok(!fetched.includes('starlink'), 'Starlink off by default');
  assert.equal(handle.satellites.status, 'ready');
  const list = doc.body.find('sats-list');
  assert.ok(list.children.length > 0, 'rows listed');
  assert.match(
    doc.body.find('sats-title').textContent,
    /^Overhead now \(\d+\)$/,
  );
  assert.match(
    doc.body.find('sats-banner').textContent,
    /^Elements: newest epoch 2026-10-1\d/,
  );
  handle.redraw();
  assert.ok(handle.satelliteModel, 'satellite model drawn');
});

test('satellites: canvas click selects (card), list click selects + looks at it, chips filter, exit stops the worker', async () => {
  const { doc, viewer, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  // clicks on the list background or a row gap select nothing (not index 0)
  const listNode = doc.body.find('sats-list');
  clickWithTarget(listNode, listNode);
  clickWithTarget(listNode, listNode.children[0]);
  assert.equal(handle.selectedSatellite, null, 'background click: no select');
  assert.equal(doc.body.find('sats-card').hidden, true);
  // look at the highest object so it is on screen, then click it
  const first = doc.body.find('sats-list').children[0].children[0];
  const index = Number(first.getAttribute('data-index'));
  clickWithTarget(doc.body.find('sats-list'), first);
  assert.equal(handle.selectedSatellite, index);
  const row = handle.satellites.lookup(index).row;
  assert.ok(
    Math.abs(((handle.view.azDeg - row.azDeg + 540) % 360) - 180) < 1e-3,
    'looked at it (reduced motion: instant)',
  );
  assert.ok(Math.abs(handle.view.elDeg - row.elDeg) < 1e-3);
  const card = doc.body.find('sats-card');
  assert.equal(card.hidden, false);
  assert.equal(
    card.children[0].textContent,
    handle.satellites.meta[index].name,
  );
  // rows and card buttons survive refreshes (a click must not be lost)
  const lookButton = doc.body.find('sats-look');
  const rowButton = doc.body.find('sats-list').children[0].children[0];
  handle.satellites.requestTick(true);
  await pumpSats(worker);
  assert.equal(doc.body.find('sats-look'), lookButton);
  assert.equal(doc.body.find('sats-list').children[0].children[0], rowButton);
  // a nested element inside a row button selects that row
  handle.selectSatellite(null);
  const inner = doc.createElement('span');
  rowButton.append(inner);
  clickWithTarget(doc.body.find('sats-list'), inner);
  assert.equal(
    handle.selectedSatellite,
    Number(rowButton.getAttribute('data-index')),
  );
  inner.remove();
  handle.selectSatellite(index);
  handle.setView({ azDeg: (row.azDeg + 180) % 360 });
  click(lookButton);
  assert.ok(Math.abs(((handle.view.azDeg - row.azDeg + 540) % 360) - 180) < 1);
  // clear, then click the dot on the canvas
  handle.selectSatellite(null);
  handle.redraw();
  const dot = handle.satelliteModel.dots.find((d) => d.index === index);
  assert.ok(dot, 'dot at the view centre');
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 5, clientX: dot.x, clientY: dot.y }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 5, clientX: dot.x + 1, clientY: dot.y }),
  );
  assert.equal(handle.selectedSatellite, index);
  // a click on empty sky clears the selection
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 6, clientX: 3, clientY: 3 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 6, clientX: 3, clientY: 3 }),
  );
  assert.equal(handle.selectedSatellite, null);
  // chip: hide the class of that object
  const klass = handle.satellites.meta[index].klass;
  const chip = doc.body.find(`chip-${klass}`);
  click(chip);
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  handle.redraw();
  assert.ok(!handle.satelliteModel.dots.some((d) => d.index === index));
  click(chip);
  // GEO belt switch and data-set switches
  click(doc.body.find('geo-belt'));
  assert.equal(doc.body.find('geo-belt').getAttribute('aria-pressed'), 'true');
  handle.redraw();
  assert.ok(handle.satelliteModel.belt.length > 0);
  click(doc.body.find('set-starlink'));
  assert.equal(handle.satellites.sets.starlink, true);
  // exit
  click(doc.body.find('back'));
  assert.equal(worker.terminated, true);
  assert.equal(handle.satellites.running, false);
  assert.equal(doc.body.find('sats').hidden, true);
  assert.equal(handle.selectedSatellite, null);
  handle.destroy();
  assert.equal(doc.body.find('sats'), null);
});

test('satellites: a picked Sky time forces an immediate worker tick at that time', async () => {
  const { doc, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  const time = doc.body.find('time');
  time.value = '2026-10-11T18:00';
  time.dispatchEvent(new Event('change'));
  await pumpSats(worker);
  assert.equal(
    handle.satellites.stats.timeMs,
    new Date('2026-10-11T18:00').getTime(),
  );
});

test('satellites: without Web Workers the sky still works and the panel says why', async () => {
  const { doc, handle } = setup({ createSatWorker: () => null });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  assert.equal(handle.active, true);
  assert.equal(handle.satellites.status, 'unavailable');
  assert.match(doc.body.find('sats-banner').textContent, /Web Workers/);
});

test('redraws reuse the cached canvas size (no forced layout per frame); a resize re-measures', async () => {
  const observers = [];
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  try {
    const { viewer, handle } = setup();
    // one on the globe canvas (size cache); P2a adds one on the toolbar
    const canvasObserver = observers.find(
      (o) => o.targets[0] === viewer.scene.canvas,
    );
    assert.ok(canvasObserver, 'the globe canvas is observed');
    await handle.enterAt({
      latDeg: 29.7604,
      lonDeg: -95.3698,
      source: 'manual',
    });
    const globe = viewer.scene.canvas;
    let width = 1200;
    let reads = 0;
    Object.defineProperty(globe, 'clientWidth', {
      configurable: true,
      get() {
        reads += 1;
        return width;
      },
    });
    for (let i = 0; i < 5; i++) handle.setView({ azDeg: 100 + i });
    assert.equal(reads, 0, 'five redraws, no size read');
    const timing = handle.redrawPerf();
    assert.ok(timing.count >= 5 && timing.p95 >= 0, 'redraws are timed');
    handle.resetRedrawPerf();
    assert.equal(handle.redrawPerf().count, 0);
    const overlay = handle.elements.canvas;
    const before = overlay.width;
    width = 900;
    canvasObserver.callback([]);
    assert.ok(reads > 0, 'the resize re-measured');
    assert.ok(overlay.width < before, 'overlay follows the new size');
    reads = 0;
    handle.setView({ azDeg: 140 });
    assert.equal(reads, 0, 'cached again after the resize');
    handle.destroy?.();
    assert.ok(
      observers.every((o) => o.disconnected),
      'observers released',
    );
  } finally {
    globalThis.ResizeObserver = saved;
  }
});

// ── P3b search x P2a satellites (review t_89d6442c R2) ────────────────────
test('R2: the search box finds satellites from the P2a engine; look-at + marker on the drawn dot; below-horizon objects say so', async () => {
  const { doc, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(handle.satellites.status, 'ready');
  const meta = handle.satellites.meta;
  const count = (name) => meta.filter((m) => m.name === name).length;
  const query = doc.body.find('sky-search-query');
  const submit = (text) => {
    query.value = text;
    doc.body.find('sky-search').dispatchEvent(new Event('submit'));
    return doc.body.find('sky-search-status').textContent;
  };
  // "ISS" ranks the space station first, never the star Meissa
  const iss = handle.content.search('ISS');
  assert.equal(iss[0].kind, 'satellite');
  assert.match(iss[0].label, /^ISS/);
  assert.equal(meta[iss[0].target.id].noradId, 25544);
  // an object above the horizon: animated look-at (instant here) + marker
  const up = handle.satellites
    .objectsAt(handle.clock.getTime())
    .filter((o) => o.elDeg > 10 && count(meta[o.index].name) === 1)
    .sort((a, b) => b.elDeg - a.elDeg)
    .map((o) => ({ d: o, m: meta[o.index] }))[0];
  assert.ok(up, 'a uniquely named satellite above 10 deg');
  const text = submit(up.m.name);
  assert.ok(text.startsWith(`${up.m.name}: az `), text);
  assert.equal(handle.content.marker.target.type, 'satellite');
  assert.equal(handle.content.marker.target.id, up.d.index);
  const objects = handle.satellites.objectsAt(handle.clock.getTime());
  const drawn = objects.find((o) => o.index === up.d.index);
  assert.ok(
    Math.abs(((handle.view.azDeg - drawn.azDeg + 540) % 360) - 180) < 1e-6,
  );
  assert.ok(Math.abs(handle.view.elDeg - drawn.elDeg) < 1e-6);
  handle.redraw();
  const marker = handle.content.lastStats.marker;
  const dot = handle.satelliteModel.dots.find((d) => d.index === up.d.index);
  assert.ok(marker && dot, 'marker and dot drawn');
  assert.ok(
    Math.hypot(marker.x - dot.x, marker.y - dot.y) < 1,
    `marker ${marker.x},${marker.y} on the dot ${dot.x},${dot.y}`,
  );
  // an object the worker does not report (below -2 deg): honest status
  const below = meta.findIndex(
    (m, i) => count(m.name) === 1 && !handle.satellites.lookup(i)?.row,
  );
  assert.ok(below >= 0, 'an object below the horizon');
  const before = handle.view;
  assert.match(
    submit(meta[below].name),
    /right now: it is below the horizon or not computed yet/,
  );
  assert.deepEqual(handle.view, before);
  // leaving the sky drops the satellite positions
  handle.exit();
  assert.ok(!handle.content.search('ISS').some((r) => r.kind === 'satellite'));
});

test('a plain redraw reads no layout for the satellite edge-arrow insets; a selection does', async () => {
  const { doc, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  let reads = 0;
  const rect = () => {
    reads += 1;
    return {
      left: 0,
      right: 300,
      top: 0,
      bottom: 120,
      width: 300,
      height: 120,
    };
  };
  doc.body.find('sats').getBoundingClientRect = rect;
  handle.elements.bar.getBoundingClientRect = rect;
  for (let i = 0; i < 5; i++) handle.setView({ azDeg: 100 + i });
  assert.equal(reads, 0, 'no layout reads without a selection');
  const index = handle.satellites.objectsAt(handle.clock.getTime())[0].index;
  handle.selectSatellite(index);
  handle.redraw();
  assert.ok(reads > 0, 'the selected object arrow reads the insets');
});

// ── P4: point at the sky (phones) ──────────────────────────────────────────
function sensorWindow({ ios = false, permission = 'granted', apis = true } = {}) {
  const listeners = new Map();
  const win = {
    screen: { orientation: { angle: 0 } },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type, data) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, ...data });
    },
    count: (type) => listeners.get(type)?.size ?? 0,
  };
  if (apis) {
    win.DeviceOrientationEvent = function DeviceOrientationEvent() {};
    win.ondeviceorientationabsolute = null;
    if (ios)
      win.DeviceOrientationEvent.requestPermission = () =>
        Promise.resolve(permission);
  }
  return win;
}
/** Portrait pose: back of the phone towards bearing/elevation, gamma = sideways tilt. */
const portraitPose = (bearingDeg, elDeg, gamma = 0) => ({
  alpha: (360 - bearingDeg + 360) % 360,
  beta: 90 + elDeg,
  gamma,
  absolute: true,
});
let sensorClock = 0;
const pointingSetup = (win, extra = {}) =>
  setup({
    orientationWindow: win,
    offerPointing: () => true,
    declinationAt: () => 2,
    orientationOptions: {
      // no animation frames: each accepted sample is applied directly
      requestFrame: () => null,
      now: () => (sensorClock += 40),
    },
    ...extra,
  });

test('P4: the Point button is offered only where pointing makes sense (touch); hidden on desktop', () => {
  const desktop = setup();
  assert.equal(desktop.doc.body.find('point').hidden, true);
  const phone = pointingSetup(sensorWindow());
  assert.equal(phone.doc.body.find('point').hidden, false);
});

test('P4 ACCEPT: sensors absent -> "unsupported" message, drag still turns the camera', async () => {
  const { doc, viewer, handle } = pointingSetup(sensorWindow({ apis: false }));
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(doc.body.find('point'));
  await settle();
  assert.equal(handle.orientation.state, 'unsupported');
  assert.match(doc.body.find('orient-status').textContent, /No orientation sensor/);
  assert.equal(doc.body.find('orient').hidden, false);
  assert.equal(viewer.container.find('crosshair').hidden, true);
  const az0 = handle.view.azDeg;
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }));
  canvas.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 700, clientY: 400 }));
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 700, clientY: 400 }));
  assert.notEqual(handle.view.azDeg, az0, 'drag works');
});

test('P4 ACCEPT: permission denied (iOS) shows the message and drag still works; LAN http explains the https address', async () => {
  const { doc, viewer, handle } = pointingSetup(
    sensorWindow({ ios: true, permission: 'denied' }),
  );
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(doc.body.find('point'));
  await settle();
  assert.equal(handle.orientation.state, 'denied');
  assert.match(doc.body.find('orient-status').textContent, /Motion access is blocked/);
  const el0 = handle.view.elDeg;
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }));
  canvas.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 600, clientY: 480 }));
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 600, clientY: 480 }));
  assert.ok(handle.view.elDeg > el0, 'drag works');

  const lan = pointingSetup(sensorWindow({ ios: true }), { isSecureContext: false });
  await lan.handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(lan.doc.body.find('point'));
  await settle();
  assert.equal(lan.handle.orientation.state, 'insecure');
  assert.match(
    lan.doc.body.find('orient-status').textContent,
    /https:\/\/godseyeview\.byrd-it\.com/,
  );
});

test('P4: the phone drives the real Cesium camera (true north via declination, roll in phone mode); a tap keeps pointing, a drag takes over and levels the roll', async () => {
  const win = sensorWindow();
  const { doc, viewer, handle } = pointingSetup(win);
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  const point = doc.body.find('point');
  click(point);
  await settle();
  assert.equal(handle.orientation.state, 'asking');
  // upright, back to MAGNETIC 88 -> true 90 with the injected +2 deg E
  win.fire('deviceorientationabsolute', portraitPose(88, 0));
  assert.equal(handle.orientation.state, 'on');
  assert.equal(point.getAttribute('aria-pressed'), 'true');
  assert.equal(point.textContent, 'Stop pointing');
  assert.equal(viewer.container.find('crosshair').hidden, false);
  assert.ok(doc.body.classList.contains('gev-sky-pointing'), 'compact toolbar class');
  assert.ok(Math.abs(handle.view.azDeg - 90) < 1e-6, `az ${handle.view.azDeg}`);
  assert.ok(Math.abs(handle.view.elDeg) < 1e-6);
  let look = worldDirectionToAzEl(Cesium, viewer.camera.positionWC, viewer.camera.directionWC);
  assert.ok(Math.abs(look.azDeg - 90) < 1e-6 && Math.abs(look.elDeg) < 1e-6);
  const status = doc.body.find('orient-status').textContent;
  assert.match(status, /declination 2\.0° E/);
  assert.match(status, /Use my location/, 'a map/manual observer gets the GPS tip');
  // tilted up 30 deg and rolled sideways: roll reaches the camera
  win.fire('deviceorientationabsolute', portraitPose(88, 30, 15));
  assert.ok(Math.abs(handle.view.rollDeg) > 5, `roll ${handle.view.rollDeg}`);
  assert.ok(
    Math.abs(viewer.camera.roll - (handle.view.rollDeg * Math.PI) / 180) < 1e-6 ||
      Math.abs(Math.abs(viewer.camera.roll - (handle.view.rollDeg * Math.PI) / 180) - 2 * Math.PI) < 1e-6,
  );
  look = worldDirectionToAzEl(Cesium, viewer.camera.positionWC, viewer.camera.directionWC);
  assert.ok(Math.abs(look.elDeg - handle.view.elDeg) < 1e-6);
  // a tap (no movement) does not stop pointing
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }));
  canvas.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 602, clientY: 401 }));
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 602, clientY: 401 }));
  assert.equal(handle.orientation.state, 'on');
  // a pinch zoom keeps pointing too (fov only)
  canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -100 }));
  assert.equal(handle.orientation.state, 'on');
  // a drag takes over: pointing off, roll back to level, listeners gone
  canvas.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }));
  canvas.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 680, clientY: 400 }));
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 680, clientY: 400 }));
  assert.equal(handle.orientation.state, 'off');
  assert.equal(handle.view.rollDeg, 0);
  assert.equal(win.count('deviceorientationabsolute'), 0);
  assert.match(doc.body.find('orient-status').textContent, /Drag took over/);
  assert.equal(viewer.container.find('crosshair').hidden, true);
  assert.ok(!doc.body.classList.contains('gev-sky-pointing'));
  const az = handle.view.azDeg;
  win.fire('deviceorientationabsolute', portraitPose(0, 0));
  assert.equal(handle.view.azDeg, az, 'the phone no longer moves the view');
  // leaving the sky with pointing on stops it as well
  click(point);
  await settle();
  win.fire('deviceorientationabsolute', portraitPose(10, 10));
  assert.equal(handle.orientation.state, 'on');
  click(doc.body.find('back'));
  assert.equal(handle.orientation.state, 'off');
  assert.equal(win.count('deviceorientationabsolute'), 0);
});

test('P4: Align on the Moon fixes a compass offset; refused when the centre is far from it', async () => {
  // a time when the Moon is comfortably up over Houston
  const { moonState } = await import('./ephemeris.js');
  const obs = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
  let when = null;
  for (let h = 0; h < 72 && when == null; h += 1) {
    const t = Date.parse('2026-10-12T00:00:00Z') + h * 3_600_000;
    const m = moonState(t, obs, { refraction: true });
    if (m.elDeg > 20 && m.elDeg < 50) when = t;
  }
  assert.ok(when, 'found a Moon-up time');
  const win = sensorWindow();
  const { doc, handle, timers } = pointingSetup(win, { now: () => when });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'gps' });
  const moon = handle.content.ephemeris.moon;
  click(doc.body.find('point'));
  await settle();
  // the compass is 6 deg off: the phone "thinks" it points at the Moon's az - 6
  win.fire('deviceorientationabsolute', portraitPose(moon.azDeg - 2 - 6, moon.elDeg));
  assert.equal(doc.body.find('align').hidden, false);
  assert.equal(doc.body.find('align-moon').disabled, false);
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - (moon.azDeg - 6))) < 1e-6);
  assert.doesNotMatch(doc.body.find('orient-status').textContent, /Use my location/, 'GPS observer: no tip');
  click(doc.body.find('align-moon'));
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6, 'centre now on the Moon');
  assert.match(doc.body.find('orient-status').textContent, /Aligned on the Moon: heading moved \+6\.0°/);
  assert.match(doc.body.find('orient-status').textContent, /align offset \+6\.0°/);
  // later samples keep the offset
  win.fire('deviceorientationabsolute', portraitPose(moon.azDeg - 2 - 6, moon.elDeg + 1));
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6);
  // pointing 40 deg below the Moon: refused with a hint
  win.fire('deviceorientationabsolute', portraitPose(moon.azDeg - 2 - 6, moon.elDeg - 40));
  click(doc.body.find('align-moon'));
  assert.match(doc.body.find('orient-status').textContent, /in the centre circle first/);
  click(doc.body.find('align-reset'));
  assert.match(doc.body.find('orient-status').textContent, /Align offset cleared/);
  timers.flush(); // result lines are transient (8 s)
  assert.doesNotMatch(doc.body.find('orient-status').textContent, /Align offset cleared/);
  assert.match(doc.body.find('orient-status').textContent, /declination 2\.0° E/);
  handle.destroy();
  globalThis.localStorage?.removeItem?.('gev.sky.headingOffsetDeg');
});
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
