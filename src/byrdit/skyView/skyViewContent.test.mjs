import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { readFileSync } from 'node:fs';
import { mountSkyView } from './skyView.js';
import { parseBoundaries, parseSkyData } from './starData.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url)));
const DATA = parseSkyData(read('stars.json'), read('constellations.json'));
const EDGES = parseBoundaries(read('boundaries.json'));

// ── a very small DOM (same fakes as skyView.test.mjs) ───────────────────────────────────────────────────────
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
    this.checked = false;
    this.disabled = false;
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
    skyContentOptions: {
      loadData: () => DATA,
      loadBoundaryData: () => EDGES,
      createCanvas: () => null,
      reducedMotion: () => true,
      ...options.skyContentOptions,
    },
  });
  return { doc, viewer, timers, location, history, handle };
}

const click = (node) => node.dispatchEvent(new Event('click'));
const pointer = (type, props) => Object.assign(new Event(type), props);
const settle = () => new Promise((resolve) => setImmediate(resolve));

const change = (node, checked) => {
  node.checked = checked;
  node.dispatchEvent(new Event('change'));
};
const ORION_HREF =
  'https://gev.test/?sv=29.7604,-95.3698,145,52,90,2026-01-16T03:00:00Z#v=2';

async function enterOrion(extra = {}) {
  const env = setup({ href: ORION_HREF, ...extra });
  env.timers.flush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(env.handle.active, true);
  return env;
}

test('entering the sky shows the tools and draws stars, lines, names and planets', async () => {
  const { doc, handle } = await enterOrion();
  const tools = doc.body.find('tools');
  assert.equal(tools.hidden, false);
  assert.equal(handle.content.status, 'ready');
  handle.redraw();
  const stats = handle.content.lastStats;
  assert.ok(stats.stars > 100 && stats.segments > 10 && stats.names > 3);
  assert.ok(stats.bodies >= 1);
  handle.exit();
  assert.equal(tools.hidden, true);
});

test('ACCEPTANCE (svf round trip through the UI): every layer switch writes its bit and a link restores it', async () => {
  const { doc, timers, location, handle } = await enterOrion();
  const expected = {
    stars: [false, 4],
    lines: [false, 8],
    names: [false, 16],
    boundaries: [true, 32],
    planets: [false, 64],
    starNames: [false, 128],
    telescopic: [true, 256],
    grid: [true, 2],
  };
  for (const [name, [value, bit]] of Object.entries(expected)) {
    change(doc.body.find(`layer-${name}`), value);
    timers.flush();
    assert.equal(handle.flags[name], value, name);
    assert.match(location.href, new RegExp(`svf=${bit}(&|#|$)`), name);
    change(doc.body.find(`layer-${name}`), !value);
    timers.flush();
    assert.doesNotMatch(location.href, /svf=/, `${name} back to default`);
  }
  // the bar Grid button and the panel switch stay in step
  change(doc.body.find('layer-grid'), true);
  assert.equal(doc.body.find('grid').getAttribute('aria-pressed'), 'true');
  click(doc.body.find('grid'));
  assert.equal(doc.body.find('layer-grid').checked, false);
  // a combined link opens with exactly those switches
  for (const name of ['stars', 'boundaries', 'telescopic'])
    change(doc.body.find(`layer-${name}`), !handle.flags[name]);
  timers.flush();
  assert.match(location.href, /svf=292(&|#|$)/); // 4 + 32 + 256
  const reopened = await enterOrion({ href: location.href });
  assert.equal(reopened.handle.flags.stars, false);
  assert.equal(reopened.handle.flags.boundaries, true);
  assert.equal(reopened.handle.flags.telescopic, true);
  assert.equal(reopened.handle.flags.lines, true);
  assert.equal(reopened.doc.body.find('layer-stars').checked, false);
  assert.equal(reopened.doc.body.find('layer-boundaries').checked, true);
  reopened.handle.redraw();
  assert.equal(reopened.handle.content.lastStats.stars, 0);
});

test('search box: "Jupiter" turns the view to Jupiter and marks it', async () => {
  const { doc, handle } = await enterOrion();
  const query = doc.body.find('sky-search-query');
  query.value = 'jupi';
  query.dispatchEvent(new Event('input'));
  const results = doc.body.find('sky-search-results');
  assert.equal(results.hidden, false);
  assert.match(results.children[0].textContent, /^Jupiter/);
  doc.body.find('sky-search').dispatchEvent(new Event('submit'));
  const jupiter = handle.content.ephemeris.planets.find(
    (p) => p.name === 'Jupiter',
  );
  assert.ok(Math.abs(handle.view.azDeg - jupiter.azDeg) < 1e-9);
  assert.ok(Math.abs(handle.view.elDeg - jupiter.elDeg) < 1e-9);
  assert.match(
    doc.body.find('sky-search-status').textContent,
    /Jupiter: az [\d.]+°, alt [\d.]+°/,
  );
  assert.equal(handle.content.marker.label, 'Jupiter');
  assert.equal(doc.body.find('sky-search-clear').hidden, false);
  click(doc.body.find('sky-search-clear'));
  assert.equal(handle.content.marker, null);
  query.value = 'Crux';
  doc.body.find('sky-search').dispatchEvent(new Event('submit'));
  assert.match(
    doc.body.find('sky-search-status').textContent,
    /Crux is below the horizon/,
  );
  query.value = 'nothing-like-this';
  doc.body.find('sky-search').dispatchEvent(new Event('submit'));
  assert.match(
    doc.body.find('sky-search-status').textContent,
    /Nothing called/,
  );
});

test('magnitude limit: Auto by default; a user limit caps what is drawn', async () => {
  const { doc, handle } = await enterOrion();
  handle.redraw();
  const autoStars = handle.content.lastStats.stars;
  assert.equal(handle.content.lastStats.lim, 5); // fov 90 > 70: wide cap
  const auto = doc.body.find('mag-auto');
  const mag = doc.body.find('mag-limit');
  assert.equal(auto.checked, true);
  assert.equal(mag.disabled, true);
  change(auto, false);
  mag.value = '3';
  mag.dispatchEvent(new Event('input'));
  handle.redraw();
  assert.equal(handle.content.lastStats.lim, 3);
  assert.ok(handle.content.lastStats.stars < autoStars);
  assert.equal(doc.body.find('mag-text').textContent, '3.0');
});
