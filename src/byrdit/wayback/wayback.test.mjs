import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireImageryComparison } from '../../maps/imageryComparison.js';
import { attachWayback } from './index.js';
import { createWaybackImageryProvider } from './layer.js';
import { createWaybackPanel } from './panel.js';
import {
  DEFAULT_ATTRIBUTION,
  RELEASES_URL,
  clampIndex,
  createDebounce,
  describeCapture,
  normalizeReleaseDoc,
  tileTemplate,
  waybackFlagOn,
} from './model.js';

// ------------------------------------------------------------------ fakes

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  *walk() {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

function fakeDoc({ flag = true } = {}) {
  const doc = {
    createElement: (tag) => new FakeElement(doc, tag),
    querySelector: (selector) =>
      selector === 'meta[name="gev-wayback"]'
        ? { getAttribute: () => (flag ? '1' : '0') }
        : null,
  };
  doc.body = new FakeElement(doc, 'body');
  doc.getElementById = (id) =>
    [...doc.body.walk()].find((e) => e.id === id) ?? null;
  return doc;
}

class FakeTimers {
  constructor() {
    this.now = 0;
    this.items = new Map();
    this.next = 1;
  }
  setTimeout = (fn, ms) => {
    const id = this.next++;
    this.items.set(id, { fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (id) => {
    this.items.delete(id);
  };
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.items.entries()]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.items.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
}

class FakeProvider {
  constructor(options) {
    this.options = options;
  }
  requestImage() {
    return this.options.__reply?.() ?? Promise.resolve('image');
  }
}
class FakeLayer {
  constructor(provider, options) {
    this.provider = provider;
    this.options = options;
    this.destroyed = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
}
class FakeCollection {
  constructor() {
    this.items = [];
  }
  get length() {
    return this.items.length;
  }
  add(layer, index = this.items.length) {
    this.items.splice(index, 0, layer);
  }
  remove(layer, destroy) {
    const i = this.items.indexOf(layer);
    if (i >= 0) this.items.splice(i, 1);
    if (destroy) layer.destroyed = true;
    return i >= 0;
  }
  indexOf(layer) {
    return this.items.indexOf(layer);
  }
}
const FakeCesium = {
  ImageryLayer: FakeLayer,
  UrlTemplateImageryProvider: FakeProvider,
  Credit: class {
    constructor(html, show) {
      this.html = html;
      this.show = show;
    }
  },
};

/** A controller with the real lease (acquireImageryComparison) over fake stacks. */
function fakeController(initial = 'photoreal', { failSwitch = false } = {}) {
  const log = [];
  const subscribers = new Set();
  let active = initial;
  let generation = 0;
  const controller = {
    _imageryLayer: null,
    log,
    getActiveId: () => active,
    getSwitchGeneration: () => generation,
    async setStack(id) {
      log.push(id);
      generation += 1;
      await Promise.resolve();
      if (failSwitch && id === 'esri-imagery') return {};
      active = id;
      for (const fn of [...subscribers]) fn({});
      return {};
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    acquireImageryComparison: (options) =>
      acquireImageryComparison(controller, options),
    /** The operator picks a map. */
    async pick(id) {
      return controller.setStack(id);
    },
    subscribers,
  };
  return controller;
}

const DOC = {
  releases: [
    { release: 63116, date: '2026-09-24' },
    { release: 32337, date: '2018-05-16' },
    { release: 10, date: '2014-02-20' },
    { release: 777, date: '2020-01-01' },
  ],
  stale: false,
  info: false,
  attribution: DEFAULT_ATTRIBUTION,
};

function makeViewer(doc = fakeDoc()) {
  const added = [];
  const display = {
    credits: [],
    addStaticCredit(c) {
      this.credits.push(c);
    },
    removeStaticCredit(c) {
      this.credits = this.credits.filter((x) => x !== c);
    },
  };
  const base = new FakeLayer({}, {});
  const viewer = {
    container: doc.createElement('div'),
    imageryLayers: new FakeCollection(),
    scene: { frameState: { creditDisplay: display }, requestRender() {} },
    camera: {
      moveEnd: {
        listeners: [],
        addEventListener(fn) {
          this.listeners.push(fn);
          return () => {};
        },
      },
    },
  };
  viewer.imageryLayers.add(base);
  return { viewer, display, base, added };
}

async function setup({
  doc = fakeDoc(),
  docJson = DOC,
  controller = fakeController(),
  info,
  ...rest
} = {}) {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === RELEASES_URL)
      return {
        ok: true,
        json: async () => ({ ...docJson, info: info ?? docJson.info }),
      };
    if (String(url).startsWith('/api/byrdit/wayback/info'))
      return rest.infoReply
        ? rest.infoReply(url)
        : {
            ok: true,
            json: async () => ({
              captured: '2024-03-05',
              resolutionM: 0.5,
              source: 'Vivid',
              provider: 'Vantor',
            }),
          };
    return { ok: false };
  };
  const timers = new FakeTimers();
  const { viewer, display, base } = makeViewer(doc);
  controller._imageryLayer = base;
  const providers = [];
  const detach = await attachWayback({
    Cesium: FakeCesium,
    viewer,
    controller,
    doc,
    fetchImpl,
    timers,
    createProvider: (release) => {
      const p = new FakeProvider({ url: tileTemplate(release) });
      p.release = release;
      providers.push(p);
      return p;
    },
    viewOf: () => ({ lat: 32.5, lon: -94.9, z: 17 }),
    ...(rest.createPanel === undefined
      ? {}
      : { createPanel: rest.createPanel }),
    // the floating panel on the globe, unless a test hosts it in a menu
    timeTravel: rest.timeTravel === undefined ? null : rest.timeTravel,
  });
  return {
    detach,
    controller,
    viewer,
    display,
    base,
    fetchCalls,
    timers,
    providers,
    doc,
  };
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// ------------------------------------------------------------------ model

test('model: flag meta, tile template (z / row / col), clamp', () => {
  assert.equal(waybackFlagOn(fakeDoc({ flag: true })), true);
  assert.equal(waybackFlagOn(fakeDoc({ flag: false })), false);
  assert.equal(waybackFlagOn({ querySelector: () => null }), false);
  assert.equal(waybackFlagOn({}), false);
  assert.equal(
    tileTemplate(63116),
    '/api/byrdit/wayback/tile/63116/{z}/{y}/{x}',
  );
  for (const bad of [-1, 1.5, NaN, '5', undefined])
    assert.throws(() => tileTemplate(bad), RangeError);
  assert.equal(clampIndex(99, 4), 3);
  assert.equal(clampIndex(-5, 4), 0);
  assert.equal(clampIndex('x', 4), 0);
});

test('model: release document -> oldest first, duplicates and junk dropped, default credit', () => {
  const out = normalizeReleaseDoc({
    releases: [
      { release: 5, date: '2020-01-01' },
      { release: 5, date: '2021-01-01' },
      { release: 6, date: 'bad' },
      { release: 'x', date: '2019-01-01' },
      { release: 7, date: '2019-06-06' },
    ],
    attribution: '<script>',
    stale: true,
    info: true,
  });
  assert.deepEqual(out.releases, [
    { release: 7, date: '2019-06-06' },
    { release: 5, date: '2020-01-01' },
  ]);
  assert.equal(out.attribution, DEFAULT_ATTRIBUTION);
  assert.equal(out.stale, true);
  assert.equal(out.info, true);
  assert.equal(normalizeReleaseDoc({ releases: [] }), null);
  assert.equal(normalizeReleaseDoc(null), null);
  assert.equal(normalizeReleaseDoc({ releases: 'x' }), null);
});

test('model: debounce only fires for the last call; flush and cancel', async () => {
  const timers = new FakeTimers();
  const seen = [];
  const d = createDebounce((v) => seen.push(v), 300, timers);
  d(1);
  d(2);
  d(3);
  await timers.advance(299);
  assert.deepEqual(seen, []);
  await timers.advance(2);
  assert.deepEqual(seen, [3]);
  d(4);
  d.cancel();
  await timers.advance(1000);
  assert.deepEqual(seen, [3]);
  d(5);
  d.flush();
  assert.deepEqual(seen, [3, 5]);
  assert.equal(d.pending(), false);
});

test('model: capture description', () => {
  assert.equal(
    describeCapture({
      captured: '2024-03-05',
      resolutionM: 0.5,
      source: 'Vivid',
      provider: 'Vantor',
    }),
    '2024-03-05 · 50 cm · Vivid / Vantor',
  );
  assert.equal(
    describeCapture({
      captured: null,
      resolutionM: 15,
      source: 'TerraColor',
      provider: 'Earthstar',
    }),
    '15 m · TerraColor / Earthstar',
  );
  assert.equal(describeCapture({}), '');
  assert.equal(describeCapture(null), '');
});

// ------------------------------------------------------------------ provider

test('provider: same-origin URL template, level cap, failed tiles become transparent (no retry loop)', async () => {
  const blank = { blank: true };
  const calls = [];
  class P {
    constructor(o) {
      calls.push(o);
    }
    requestImage() {
      return this.mode === 'fail'
        ? Promise.reject(new Error('404'))
        : this.mode === 'undef'
          ? undefined
          : Promise.resolve('img');
    }
  }
  const provider = createWaybackImageryProvider(
    { UrlTemplateImageryProvider: P },
    63116,
    { blank: () => blank },
  );
  assert.equal(calls[0].url, '/api/byrdit/wayback/tile/63116/{z}/{y}/{x}');
  assert.equal(calls[0].maximumLevel, 19);
  assert.equal(calls[0].tileWidth, 256);
  assert.equal(await provider.requestImage(1, 1, 1), 'img');
  provider.mode = 'fail';
  assert.equal(await provider.requestImage(1, 1, 1), blank);
  provider.mode = 'undef';
  assert.equal(
    provider.requestImage(1, 1, 1),
    undefined,
    'Cesium throttle passes through',
  );
  assert.ok(
    !calls[0].url.includes('arcgis'),
    'the browser never talks to Esri directly',
  );
});

// ------------------------------------------------------------------ controller

test('attach: flag off -> nothing fetched, no panel', async () => {
  const doc = fakeDoc({ flag: false });
  let fetched = 0;
  const detach = await attachWayback({
    Cesium: FakeCesium,
    viewer: makeViewer(doc).viewer,
    controller: fakeController(),
    doc,
    fetchImpl: async () => (fetched++, { ok: true, json: async () => DOC }),
  });
  assert.equal(fetched, 0);
  assert.equal(typeof detach, 'function');
  assert.equal(doc.getElementById('gev-wayback'), null);
});

test('attach: release list missing, invalid or failing -> quietly no control', async () => {
  for (const reply of [
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ releases: [] }) }),
    async () => {
      throw new Error('down');
    },
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    }),
  ]) {
    const doc = fakeDoc();
    const viewer = makeViewer(doc).viewer;
    await attachWayback({
      Cesium: FakeCesium,
      viewer,
      controller: fakeController(),
      doc,
      fetchImpl: reply,
    });
    assert.equal(viewer.container.children.length, 0);
  }
});

test('attach: panel starts off, newest release at the right end of the slider', async () => {
  const { detach, viewer } = await setup();
  const panel = viewer.container.children[0];
  assert.equal(panel.id, 'gev-wayback');
  const range = [...panel.walk()].find((e) => e.attributes.type === 'range');
  assert.equal(range.attributes.max, '3');
  assert.equal(range.value, '3', 'starts on the newest');
  assert.equal(detach.state().date, '2026-09-24');
  assert.equal(detach.state().on, false);
  assert.equal(
    viewer.imageryLayers.length,
    1,
    'no layer until it is switched on',
  );
  assert.equal(detach.state().layersCreated, 0);
});

test('turn on: leases Esri (hides Google 3D), draws the newest release above the base, shows the credit', async () => {
  const { detach, controller, viewer, display, base } = await setup({
    controller: fakeController('photoreal'),
  });
  assert.equal(await detach.enable(), true);
  assert.deepEqual(controller.log, ['esri-imagery']);
  assert.equal(controller.getActiveId(), 'esri-imagery');
  assert.equal(viewer.imageryLayers.length, 2);
  assert.equal(viewer.imageryLayers.indexOf(base), 0);
  const layer = viewer.imageryLayers.items[1];
  assert.equal(layer.provider.release, 63116);
  assert.equal(
    layer.provider.options.url,
    '/api/byrdit/wayback/tile/63116/{z}/{y}/{x}',
  );
  assert.equal(display.credits.length, 1);
  assert.match(
    display.credits[0].html,
    /^Esri, Maxar, Earthstar Geographics, and the GIS User Community · Wayback 2026-09-24$/,
  );
  assert.equal(detach.state().on, true);
  assert.equal(detach.state().ready, true);
});

test('turn off restores the previous stack exactly (photoreal 3D)', async () => {
  const { detach, controller, viewer, display } = await setup({
    controller: fakeController('photoreal'),
  });
  await detach.enable();
  await detach.disable();
  assert.deepEqual(controller.log, ['esri-imagery', 'photoreal']);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(viewer.imageryLayers.length, 1, 'Wayback layer removed');
  assert.equal(display.credits.length, 0, 'credit removed');
  assert.equal(controller.subscribers.size, 0, 'no listener left behind');
  assert.equal(detach.state().on, false);
});

test('turn off restores Byrd-IT Open; from Esri nothing switches at all', async () => {
  const open = await setup({ controller: fakeController('byrdit-open') });
  await open.detach.enable();
  assert.equal(open.controller.getActiveId(), 'esri-imagery');
  await open.detach.disable();
  assert.equal(open.controller.getActiveId(), 'byrdit-open');
  assert.deepEqual(open.controller.log, ['esri-imagery', 'byrdit-open']);
  const esri = await setup({ controller: fakeController('esri-imagery') });
  await esri.detach.enable();
  await esri.detach.disable();
  assert.deepEqual(
    esri.controller.log,
    [],
    'already on Esri: no switch either way',
  );
  assert.equal(esri.controller.getActiveId(), 'esri-imagery');
});

test('on/off/on/off cycles leave no layers, listeners or credits', async () => {
  const { detach, controller, viewer, display } = await setup({
    controller: fakeController('photoreal'),
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(await detach.enable(), true);
    await detach.disable();
  }
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(display.credits.length, 0);
  assert.equal(controller.subscribers.size, 0);
});

test('toggling off while the switch is still pending leaves Google 3D in place', async () => {
  const { detach, controller } = await setup({
    controller: fakeController('photoreal'),
  });
  const pending = detach.enable();
  await detach.disable();
  await pending;
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(detach.state().on, false);
  assert.equal(detach.state().layersOnGlobe, 0);
});

test('lease held by another tool: explains and stays off', async () => {
  const controller = fakeController('photoreal');
  const held = controller.acquireImageryComparison({
    owner: 'recent-imagery',
    switchPolicy: 'esri-if-photoreal',
  });
  const { detach, viewer } = await setup({ controller });
  assert.equal(await detach.enable(), false);
  assert.equal(detach.state().on, false);
  assert.match(detach.state().notice, /another imagery tool/i);
  assert.equal(viewer.imageryLayers.length, 1);
  await held.release();
});

test('Esri unavailable: turns itself off with a notice and gives the map back', async () => {
  const { detach, controller, viewer } = await setup({
    controller: fakeController('photoreal', { failSwitch: true }),
  });
  assert.equal(await detach.enable(), false);
  assert.equal(detach.state().on, false);
  assert.match(detach.state().notice, /unavailable/i);
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(controller.getActiveId(), 'photoreal');
});

test('operator picks Google 3D while on: Wayback steps aside and the pick stands', async () => {
  const { detach, controller, viewer } = await setup({
    controller: fakeController('photoreal'),
  });
  await detach.enable();
  await controller.pick('photoreal');
  await tick();
  assert.equal(detach.state().on, false);
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.deepEqual(
    controller.log,
    ['esri-imagery', 'photoreal'],
    'no extra restore switch',
  );
});

test('operator picks OSM while on: Wayback keeps drawing over it', async () => {
  const { detach, controller } = await setup({
    controller: fakeController('photoreal'),
  });
  await detach.enable();
  await controller.pick('osm');
  await tick();
  assert.equal(detach.state().on, true);
  assert.equal(detach.state().layersOnGlobe, 1);
});

test('slider drag is debounced: tiles load only for the settled release', async () => {
  const { detach, viewer, timers, providers } = await setup();
  await detach.enable();
  assert.equal(detach.state().layersCreated, 1);
  for (const i of [2, 1, 0, 1, 2, 3, 0, 2]) {
    detach.setIndex(i);
    await timers.advance(100);
  }
  assert.equal(
    detach.state().layersCreated,
    1,
    'nothing loaded during the drag',
  );
  assert.equal(detach.state().index, 2);
  // the label follows the slider at once
  const label = [...viewer.container.children[0].walk()].find(
    (e) => e.tagName === 'OUTPUT',
  );
  assert.equal(label.textContent, detach.state().date);
  assert.equal(label.textContent, '2020-01-01');
  await timers.advance(400);
  assert.equal(detach.state().layersCreated, 2);
  assert.equal(detach.state().shownRelease, 777);
  assert.deepEqual(
    providers.map((p) => p.release),
    [63116, 777],
  );
});

test('slider order: oldest left, newest right; step/latest/prev/next', async () => {
  const { detach, timers } = await setup();
  await detach.enable();
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => (detach.setIndex(i), detach.state().date)),
    ['2014-02-20', '2018-05-16', '2020-01-01', '2026-09-24'],
  );
  assert.equal(detach.step(-1), true);
  assert.equal(detach.state().date, '2020-01-01');
  assert.equal(detach.step(+99), true, 'clamps at the newest');
  assert.equal(detach.state().index, 3);
  assert.equal(detach.step(1), false, 'cannot go past newest');
  detach.setIndex(0);
  assert.equal(detach.step(-1), false);
  detach.latest();
  assert.equal(detach.state().date, '2026-09-24');
  await timers.advance(2000);
});

test('Latest returns to the newest release and loads it after the settle', async () => {
  const { detach, timers, providers } = await setup();
  await detach.enable();
  detach.setIndex(0);
  await timers.advance(400);
  assert.equal(providers.at(-1).release, 10);
  detach.latest();
  await timers.advance(400);
  assert.equal(providers.at(-1).release, 63116);
  assert.equal(detach.state().shownRelease, 63116);
});

test('swapping releases removes the old layer after the cleanup delay and updates the credit', async () => {
  const { detach, viewer, timers, display } = await setup();
  await detach.enable();
  detach.setIndex(0);
  await timers.advance(400);
  assert.equal(
    viewer.imageryLayers.length,
    3,
    'old layer stays under the new one while it loads',
  );
  await timers.advance(1600);
  assert.equal(viewer.imageryLayers.length, 2);
  assert.equal(display.credits.length, 1);
  assert.match(display.credits[0].html, /Wayback 2014-02-20$/);
});

test('turn off cancels a pending settle: no layer appears afterwards', async () => {
  const { detach, viewer, timers } = await setup();
  await detach.enable();
  detach.setIndex(1);
  await detach.disable();
  await timers.advance(5000);
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(detach.state().layersCreated, 1);
});

test('turning on again uses the slider position the user left', async () => {
  const { detach, timers, providers } = await setup();
  await detach.enable();
  detach.setIndex(1);
  await timers.advance(400);
  await detach.disable();
  await detach.enable();
  assert.equal(providers.at(-1).release, 32337);
});

test('per-location info: off by default (zero requests)', async () => {
  const { detach, timers, fetchCalls } = await setup();
  await detach.enable();
  await timers.advance(3000);
  assert.equal(fetchCalls.filter((u) => u.includes('/info')).length, 0);
  assert.equal(detach.state().detail, 'Wayback release 2026-09-24');
});

test('per-location info: one request after the settle (>= 1 s), stale answers ignored', async () => {
  const { detach, timers, fetchCalls } = await setup({ info: true });
  await detach.enable();
  const infos = () => fetchCalls.filter((u) => u.includes('/info'));
  await timers.advance(900);
  assert.equal(infos().length, 0, 'not before the quiet second');
  await timers.advance(200);
  await tick();
  assert.equal(infos().length, 1);
  assert.match(infos()[0], /release=63116&lat=32\.5000&lon=-94\.9000&z=17/);
  assert.match(
    detach.state().detail,
    /Captured 2024-03-05 · 50 cm · Vivid \/ Vantor/,
  );
  // dragging: no request until quiet
  for (const i of [2, 1, 0]) {
    detach.setIndex(i);
    await timers.advance(300);
  }
  assert.equal(infos().length, 1);
  await timers.advance(400 + 1100);
  await tick();
  assert.equal(
    infos().length,
    2,
    'exactly one request for the settled release',
  );
  assert.match(infos()[1], /release=10&/);
});

test('per-location info failure falls back to the release date', async () => {
  const { detach, timers } = await setup({
    info: true,
    infoReply: async () => ({ ok: false }),
  });
  await detach.enable();
  await timers.advance(1200);
  await tick();
  assert.equal(detach.state().detail, 'Wayback release 2026-09-24');
});

// ------------------------------------------------------------------ panel

test('panel: toggle, slider input, older/newer, Latest, disabled ends, aria', async () => {
  const { detach, viewer, timers } = await setup();
  const panel = viewer.container.children[0];
  const all = [...panel.walk()];
  const toggle = all.find((e) => e.attributes.type === 'checkbox');
  const range = all.find((e) => e.attributes.type === 'range');
  const [older, newer, latest] = all.filter((e) => e.tagName === 'BUTTON');
  const out = all.find((e) => e.tagName === 'OUTPUT');
  assert.equal(panel.attributes.role, 'group');
  assert.equal(panel.attributes['aria-label'], 'Time travel');
  assert.equal(range.attributes['aria-label'], 'Imagery date');
  assert.equal(older.attributes['aria-label'], 'Older imagery');
  assert.equal(newer.disabled, true, 'newest: nothing newer');
  assert.equal(latest.disabled, true);
  assert.equal(out.attributes['aria-live'], 'polite');
  toggle.checked = true;
  toggle.fire('change', {});
  await tick(20);
  assert.equal(detach.state().on, true);
  older.fire('click');
  assert.equal(detach.state().date, '2020-01-01');
  assert.equal(range.value, '2');
  assert.equal(out.textContent, '2020-01-01');
  assert.equal(range.attributes['aria-valuetext'], '2020-01-01');
  assert.equal(newer.disabled, false);
  range.value = '0';
  range.fire('input');
  assert.equal(detach.state().date, '2014-02-20');
  assert.equal(older.disabled, true);
  latest.fire('click');
  assert.equal(detach.state().date, '2026-09-24');
  newer.fire('click');
  assert.equal(detach.state().index, 3);
  toggle.checked = false;
  toggle.fire('change', {});
  await timers.advance(100);
  await tick(20);
  assert.equal(detach.state().on, false);
});

test('panel: keys stay inside the panel; PageUp/PageDown move 10 (clamped)', async () => {
  const { detach, viewer } = await setup();
  const panel = viewer.container.children[0];
  let stopped = 0;
  let prevented = 0;
  const key = (k) =>
    panel.fire('keydown', {
      key: k,
      stopPropagation: () => stopped++,
      preventDefault: () => prevented++,
    });
  key('v');
  key('ArrowLeft');
  assert.equal(stopped, 2, 'globe shortcuts (V, arrows) never see these keys');
  key('Tab');
  key('Escape');
  assert.equal(stopped, 2, 'Tab and Escape still reach the page');
  key('PageDown');
  assert.equal(detach.state().index, 0, 'clamped to the oldest');
  key('PageUp');
  assert.equal(detach.state().index, 3);
  assert.equal(prevented, 2);
});

test('panel: touch targets are at least 44 px and it never exceeds the screen width', async () => {
  const { viewer } = await setup();
  const panel = viewer.container.children[0];
  const buttons = [...panel.walk()].filter((e) => e.tagName === 'BUTTON');
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    assert.ok(parseInt(b.style.minHeight, 10) >= 44);
    assert.ok(parseInt(b.style.minWidth, 10) >= 44);
  }
  assert.match(panel.style.maxWidth, /calc\(100% - 16px\)/);
  assert.equal(panel.style.position, 'absolute');
});

test('panel: strings go through t() (Spanish catalog applies)', async () => {
  const { setLocale } = await import('../../i18n/index.js');
  setLocale('es');
  try {
    const doc = fakeDoc();
    const container = doc.createElement('div');
    const panel = createWaybackPanel({
      container,
      count: 3,
      onToggle() {},
      onIndex() {},
      onStep() {},
      onLatest() {},
      doc,
    });
    assert.notEqual(panel.element.attributes['aria-label'], 'Time travel');
  } finally {
    setLocale('en');
  }
});

test('detach removes the panel, layers and listeners', async () => {
  const { detach, viewer, controller } = await setup({
    controller: fakeController('photoreal'),
  });
  await detach.enable();
  detach();
  await tick(10);
  assert.equal(viewer.container.children.length, 0);
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(controller.getActiveId(), 'photoreal');
});

// ------------------------------------------- hosted in the Time travel menu

test('hosted in the Time travel menu: Imagery section, flow layout, released on detach', async () => {
  const doc = fakeDoc();
  const slot = doc.createElement('div');
  const calls = [];
  const timeTravel = {
    claim: (name) => (calls.push(['claim', name]), slot),
    release: (name) => calls.push(['release', name]),
  };
  const { detach, viewer } = await setup({ doc, timeTravel });
  assert.deepEqual(calls, [['claim', 'imagery']]);
  assert.equal(viewer.container.children.length, 0, 'not on the globe');
  const panel = slot.children[0];
  assert.equal(panel.id, 'gev-wayback');
  assert.equal(panel.style.position, 'static');
  assert.equal(panel.style.left, undefined);
  assert.equal(panel.style.transform, undefined);
  assert.equal(panel.attributes['aria-label'], 'Esri Wayback imagery');
  detach();
  assert.deepEqual(calls.at(-1), ['release', 'imagery']);
  assert.equal(slot.children.length, 0);
});

test('flag off: nothing is claimed and no panel is made', async () => {
  const calls = [];
  const { viewer } = await setup({
    doc: fakeDoc({ flag: false }),
    timeTravel: { claim: (n) => calls.push(n), release() {} },
  });
  assert.deepEqual(calls, []);
  assert.equal(viewer.container.children.length, 0);
});
