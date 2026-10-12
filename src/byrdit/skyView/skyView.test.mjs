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
import { isNakedEyeCandidate } from './brightness.js';
import { ISS_NORAD, STATE } from './satCore.js';

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
    now: () => Date.parse('2026-10-12T03:30:00Z'),
    showToast: (m) => toasts.push(m),
    geolocation: options.geolocation,
    isSecureContext: options.isSecureContext ?? true,
    geocode: options.geocode,
    runNavigation: options.runNavigation,
    lifetime: options.lifetime,
    createSatWorker: options.createSatWorker,
    fetchCelestrak: options.fetchCelestrak,
    fetchRcs: options.fetchRcs ?? (async () => ({ rcs: {} })),
    nakedEyeDefault: options.nakedEyeDefault,
    requestFrame: options.requestFrame ?? (() => null),
    reducedMotion: options.reducedMotion,
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
      if (extra.groups?.[path]) return extra.groups[path];
      return path === 'active'
        ? SAT_FIXTURE
        : SAT_FIXTURE.split(/\r?\n/)[0] + '\r\n';
    },
    reducedMotion: () => true,
    // the P2a tests below look at every object above the horizon
    nakedEyeDefault: false,
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

// ── brightness, naked-eye filter, passes (P2b) ────────────────────────────
const FIXTURE_LINES = SAT_FIXTURE.split(/\r?\n/).filter(Boolean);
const ISS_STATIONS =
  FIXTURE_LINES[0] +
  '\r\n' +
  FIXTURE_LINES.find((l) => l.split(',')[11] === String(ISS_NORAD)) +
  '\r\n';
/** Every fixture object gets RCS 5 m2 (so many have estimates), ISS real. */
const FIXTURE_RCS = Object.fromEntries(
  FIXTURE_LINES.slice(1).map((l) => [l.split(',')[11], 5]),
);
FIXTURE_RCS[ISS_NORAD] = 399.0524;

async function waitFor(predicate, worker, tries = 400) {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    worker.deliver();
  }
  assert.ok(predicate(), 'condition reached');
}

test('naked-eye filter: on by default (estimate wording), only candidates listed/drawn; slider and "all" switch', async () => {
  const fetchedRcs = [];
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: undefined, // the real default
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => {
      fetchedRcs.push(1);
      return { rcs: FIXTURE_RCS, withRcs: Object.keys(FIXTURE_RCS).length };
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(
    fetchedRcs.length,
    1,
    'RCS fetched once from the same-origin cache',
  );
  assert.equal(handle.satellites.rcs.status, 'ready');
  assert.deepEqual(handle.nakedEye, { on: true, limit: 5.5 });
  const button = doc.body.find('naked-eye');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.getAttribute('title'), /estimate/i);
  assert.match(
    doc.body.find('mag-limit-text').textContent,
    /^est\. mag <= 5\.5$/,
  );
  const objects = handle.satellites.objectsAt(handle.clock.getTime());
  assert.ok(
    objects.some((o) => o.estMag != null),
    'worker sent estimates',
  );
  const candidate = (o, limit = 5.5) =>
    isNakedEyeCandidate({
      visible: o.state === STATE.VISIBLE,
      klass: o.klass,
      estMag: o.estMag,
      limit,
    });
  handle.redraw();
  const drawn = new Set(handle.satelliteModel.dots.map((d) => d.index));
  for (const o of objects)
    if (drawn.has(o.index))
      assert.ok(candidate(o), `${o.name} drawn but not a candidate`);
  const onCount = Number(
    /\((\d+)\)/.exec(doc.body.find('sats-title').textContent)[1],
  );
  const above = objects.filter((o) => o.elDeg > 0);
  assert.ok(onCount < above.length, 'filter hides objects');
  // slider to 7: at least as many candidates
  const slider = doc.body.find('mag-limit');
  slider.value = '7';
  slider.dispatchEvent(new Event('input'));
  assert.equal(handle.nakedEye.limit, 7);
  const at7 = Number(
    /\((\d+)\)/.exec(doc.body.find('sats-title').textContent)[1],
  );
  assert.ok(at7 >= onCount);
  // "Naked-eye only" off: every object above the horizon
  click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(slider.disabled, true);
  const all = Number(
    /\((\d+)\)/.exec(doc.body.find('sats-title').textContent)[1],
  );
  assert.ok(all > at7, `${all} > ${at7}`);
  // card: estimate wording, never a bare number
  const withMag = objects.find((o) => o.elDeg > 0 && o.estMag != null);
  handle.selectSatellite(withMag.index);
  const lines = doc.body
    .find('sats-card')
    .children[1].children.map((n) => n.textContent);
  const k = lines.indexOf('Brightness');
  assert.ok(k >= 0);
  assert.match(lines[k + 1], /^est\. mag -?\d+\.\d \(estimate/);
});

test('RCS unavailable: no estimates, filter falls back to stations/visual, card says why', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => {
      throw new Error('HTTP 503');
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(handle.satellites.rcs.status, 'error');
  const objects = handle.satellites.objectsAt(handle.clock.getTime());
  assert.ok(objects.every((o) => o.estMag == null));
  handle.redraw();
  for (const d of handle.satelliteModel.dots) {
    const o = objects.find((x) => x.index === d.index);
    assert.ok(
      ['station', 'visual'].includes(o.klass) && o.state === STATE.VISIBLE,
    );
  }
  const other = objects.find((o) => o.elDeg > 0 && o.klass === 'other');
  handle.selectSatellite(other.index);
  const lines = doc.body
    .find('sats-card')
    .children[1].children.map((n) => n.textContent);
  assert.match(
    lines[lines.indexOf('Brightness') + 1],
    /no estimate \(catalogue sizes unavailable\)/,
  );
});

test('Next passes: progressive scan fills the panel, VISIBLE chip and est. mag; row draws the arc; Next ISS pass jumps the time', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => ({ rcs: FIXTURE_RCS }),
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  await waitFor(() => handle.satellites.passes.done, worker);
  const state = handle.satellites.passes;
  assert.ok(state.list.length > 0);
  assert.ok(state.list.every((p) => p.peakElevDeg >= 10));
  const rows = doc.body.find('passes-list').children;
  assert.ok(rows.length > 0, 'rows rendered');
  const first = rows[0].children[0];
  // visible only by default (naked-eye on): every row has the VISIBLE chip
  for (const li of rows) assert.equal(li.children[0].children[1].hidden, false);
  assert.match(first.children[3].textContent, /^est\. mag -?\d\.\d$/);
  assert.match(doc.body.find('passes-status').textContent, /estimates/);
  // row click: pass selected, its object selected, arc requested then drawn
  clickWithTarget(doc.body.find('passes-list'), first);
  const pass = handle.selectedPass;
  assert.ok(pass && pass.noradId === ISS_NORAD);
  assert.equal(handle.selectedSatellite, pass.index);
  assert.ok(
    Math.abs(handle.view.elDeg - pass.peakElevDeg) < 1e-6,
    'looked at the peak',
  );
  await waitFor(() => Array.isArray(handle.satellites.arcFor(pass)), worker);
  handle.redraw();
  assert.ok(handle.satelliteModel.arc.length > 0, 'arc drawn');
  assert.equal(doc.body.find('pass-go').disabled, false);
  // Next ISS pass: the P5 hook and the one-tap button
  const next = handle.nextIssPass();
  assert.equal(next.noradId, ISS_NORAD);
  assert.equal(next.visible, true);
  click(doc.body.find('next-iss'));
  assert.equal(handle.clock.mode, 'fixed');
  assert.equal(handle.clock.getTime(), next.peakMs);
  assert.equal(doc.body.find('time').value, toLocalInputValue(next.peakMs));
  // the card shows that object's next pass
  await pumpSats(worker);
  const lines = doc.body
    .find('sats-card')
    .children[1].children.map((n) => n.textContent);
  assert.ok(lines.includes('Next pass'));
});
