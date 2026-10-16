import test from 'node:test';
import assert from 'node:assert/strict';
import { composeNaip } from './naipProxy.js';
import { normalizeBasemapConfig } from './config.js';
import { SERVED } from './fixtures/config.mjs';
import { NAIP_PUBLISH, TYLER, GILMER } from './fixtures/naip.mjs';
import {
  attachNaip,
  createNaipImageryProvider,
  defaultSliderYear,
  layerOnScreen,
  naipCreditText,
  nearestStatewide,
  normalizeNaip,
  planYear,
  sliderYears,
  stepYear,
  zoomForHeight,
} from './naip.js';
import {
  createNaipSlider,
  createNaipSplit,
  NAIP_SLIDER_ID,
} from './naipSlider.js';
import { BYRDIT_OPEN_STACK_ID } from './stack.js';

/** The block the browser gets: composed by the proxy, validated by config.js. */
const served = (raw = NAIP_PUBLISH) => ({
  ...SERVED,
  naip: composeNaip(raw).browser,
});
const NAIP = normalizeBasemapConfig(served()).naip;

function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise(value = {}) {
      for (const fn of [...listeners]) fn(value);
    },
    get size() {
      return listeners.size;
    },
  };
}

/** Cesium pieces the NAIP layers use; records providers, layers, credits. */
function fakeCesium({
  fetchTile = () => Promise.resolve({ tile: true }),
} = {}) {
  const providers = [];
  const layersMade = [];
  class UrlTemplateImageryProvider {
    constructor(options) {
      this.options = options;
      providers.push(this);
    }
    requestImage(x, y, level) {
      return fetchTile(x, y, level, this.options.url);
    }
  }
  class ImageryLayer {
    constructor(imageryProvider, { show = true } = {}) {
      this.imageryProvider = imageryProvider;
      this.show = show;
      this.splitDirection = 0;
      this._destroyed = false;
      layersMade.push(this);
    }
    isDestroyed() {
      return this._destroyed;
    }
    destroy() {
      this._destroyed = true;
    }
  }
  class Credit {
    constructor(html, showOnScreen) {
      this.html = html;
      this.showOnScreen = showOnScreen;
    }
  }
  return {
    UrlTemplateImageryProvider,
    ImageryLayer,
    Credit,
    Rectangle: { fromDegrees: (w, s, e, n) => ({ w, s, e, n }) },
    SplitDirection: { LEFT: -1, NONE: 0, RIGHT: 1 },
    providers,
    layersMade,
  };
}

function fakeCollection() {
  const items = [];
  return {
    items,
    get length() {
      return items.length;
    },
    add(layer, index = items.length) {
      items.splice(index, 0, layer);
    },
    remove(layer, destroy = true) {
      const i = items.indexOf(layer);
      if (i < 0) return false;
      items.splice(i, 1);
      if (destroy) layer.destroy();
      return true;
    },
    indexOf(layer) {
      return items.indexOf(layer);
    },
  };
}

function fakeViewer() {
  const shown = new Set();
  const creditDisplay = {
    shown,
    addStaticCredit(credit) {
      shown.add(credit.html);
    },
    removeStaticCredit(credit) {
      shown.delete(credit.html);
    },
  };
  const imageryLayers = fakeCollection();
  return {
    imageryLayers,
    container: null,
    camera: { moveStart: event(), moveEnd: event() },
    scene: {
      frameState: { creditDisplay },
      preUpdate: event(),
      renders: 0,
      requestRender() {
        this.renders += 1;
      },
    },
  };
}

/** A controller that owns the base (Sentinel) layer at index 0 like the real one. */
function fakeController(viewer, base = { name: 'sentinel', destroy() {} }) {
  const subs = new Set();
  let active = BYRDIT_OPEN_STACK_ID;
  viewer.imageryLayers.add(base, 0);
  return {
    _imageryLayer: base,
    getActiveId: () => active,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    switchTo(id) {
      active = id;
      for (const fn of [...subs]) fn({ activeId: id });
    },
    subscribers: () => subs.size,
  };
}

function setup({
  naip = NAIP,
  height = 3_000,
  view = { viewBounds: [-95.4, 32.3, -95.2, 32.4], lat: TYLER.lat },
  session = { tileset: null },
  createSlider = null,
  createSplit = null,
} = {}) {
  const Cesium = fakeCesium();
  const viewer = fakeViewer();
  const controller = fakeController(viewer);
  const cam = { height, view };
  const detach = attachNaip({
    Cesium,
    viewer,
    controller,
    naip,
    session,
    heightOf: () => cam.height,
    viewOf: () => cam.view,
    createProvider: (entry) => ({ entry }),
    createSlider,
    createSplit,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  return { Cesium, viewer, controller, detach, cam, session };
}

const keys = (viewer) =>
  viewer.imageryLayers.items.map((l) =>
    l.imageryProvider ? l.imageryProvider.entry.key : l.name,
  );

// ---------------------------------------------------------------- discovery

test('naip: years and regions are discovered from config (live only, sorted)', () => {
  assert.equal(NAIP.available, true);
  assert.deepEqual(
    NAIP.years.map((y) => y.year),
    [2024],
  );
  assert.deepEqual(
    NAIP.regional.map((r) => [r.id, r.year]),
    [
      ['hist-upshur-1939', 1939],
      ['hires-2018', 2018],
      ['hires-2024', 2024],
    ],
  );
  assert.deepEqual(sliderYears(NAIP), [1939, 2018, 2024]);
  assert.equal(defaultSliderYear(NAIP), 2024);
  // A newly published year shows up with no code change.
  const more = structuredClone(NAIP_PUBLISH);
  more.years[1].status = 'live';
  more.years.push({
    ...more.years[0],
    year: 2010,
    archive: '2010/naip-tx-2010',
  });
  const naip = normalizeBasemapConfig(served(more)).naip;
  assert.deepEqual(sliderYears(naip), [1939, 2010, 2018, 2022, 2024]);
});

test('naip: default year is the newest tick unless config names a tick', () => {
  const raw = structuredClone(NAIP_PUBLISH);
  raw.default_year = 2018;
  assert.equal(
    defaultSliderYear(normalizeBasemapConfig(served(raw)).naip),
    2018,
  );
  raw.default_year = 1999; // not a tick
  assert.equal(
    defaultSliderYear(normalizeBasemapConfig(served(raw)).naip),
    2024,
  );
});

test('naip: zoom bounds come from config per layer (z12-18 NAIP, z14-20 regional)', () => {
  const state = NAIP.years[0];
  assert.equal(state.minzoom, 12);
  assert.equal(state.maxzoom, 18);
  assert.deepEqual(state.bounds, [-106.69922, 25.79989, -93.42773, 36.59789]);
  assert.equal(state.url, '/basemap/naip/2024/{z}/{x}/{y}.webp');
  const hires = NAIP.regional.find((r) => r.id === 'hires-2024');
  assert.equal(hires.minzoom, 14);
  assert.equal(hires.maxzoom, 20);
  assert.equal(hires.url, '/basemap/naip/regional/hires-2024/{z}/{x}/{y}.webp');
  assert.equal(NAIP.regional[0].greyscale, true);
});

test('naip: flag off / missing / broken block = not offered', () => {
  assert.equal(normalizeBasemapConfig(SERVED).naip.available, false);
  assert.equal(normalizeNaip({ available: false }).available, false);
  const bad = normalizeNaip({
    available: true,
    years: [
      {
        year: 2024,
        url: 'https://evil.example/{z}/{x}/{y}.webp',
        minzoom: 12,
        maxzoom: 18,
        bounds: [-106, 25, -93, 36],
      },
      {
        year: 2022,
        url: '/basemap/naip/2022/{z}/{x}/{y}.webp',
        minzoom: 18,
        maxzoom: 12,
        bounds: [-106, 25, -93, 36],
      },
    ],
    regional: [
      {
        id: 'a',
        year: 2020,
        url: '/basemap/naip/regional/b/{z}/{x}/{y}.webp',
        minzoom: 1,
        maxzoom: 2,
        bounds: [0, 0, 1, 1],
      },
    ],
  });
  assert.equal(bad.available, false);
  assert.deepEqual(bad.years, []);
});

test('naip: a regional-only year uses the nearest statewide NAIP outside the counties', () => {
  assert.equal(nearestStatewide(NAIP, 1939).year, 2024);
  const p = planYear(NAIP, 1939);
  assert.equal(p.nearest, true);
  assert.deepEqual(
    p.layers.map((l) => l.key),
    ['naip-2024', 'regional-hist-upshur-1939'],
  );
  assert.match(
    p.label,
    /^1939: Upshur 1939 .* elsewhere NAIP 2024 \(nearest\)$/,
  );
  const same = planYear(NAIP, 2024);
  assert.equal(same.nearest, false);
  assert.deepEqual(
    same.layers.map((l) => l.key),
    ['naip-2024', 'regional-hires-2024'],
  );
  assert.equal(same.label, '2024: NAIP 2024 · Wood+Upshur 2024 15 cm');
  // Tie between two statewide years: the newer one.
  const tie = { years: [{ year: 2016 }, { year: 2020 }], regional: [] };
  assert.equal(nearestStatewide(tie, 2018).year, 2020);
});

test('naip: keyboard step stays on ticks and stops at the ends', () => {
  const t = [1939, 2018, 2024];
  assert.equal(stepYear(t, 2024, 1), 2024);
  assert.equal(stepYear(t, 2024, -1), 2018);
  assert.equal(stepYear(t, 1939, -1), 1939);
  assert.equal(stepYear(t, 1999, -1), 2024);
});

test('naip: credit text and on-screen rule', () => {
  assert.equal(naipCreditText(2024), 'USDA NAIP 2024 via TxGIO');
  const state = NAIP.years[0];
  const tyler = [
    TYLER.lon - 0.1,
    TYLER.lat - 0.1,
    TYLER.lon + 0.1,
    TYLER.lat + 0.1,
  ];
  assert.equal(layerOnScreen(state, { viewBounds: tyler, zoom: 15 }), true);
  // Too far out: NAIP draws nothing below z12.
  assert.equal(layerOnScreen(state, { viewBounds: tyler, zoom: 9 }), false);
  // Paris at z15: not over Texas.
  assert.equal(
    layerOnScreen(state, { viewBounds: [2.2, 48.8, 2.4, 48.9], zoom: 15 }),
    false,
  );
  assert.ok(zoomForHeight(1_000, 32) > zoomForHeight(100_000, 32));
  assert.ok(zoomForHeight(2_500, 32) > 13 && zoomForHeight(2_500, 32) < 14);
});

// ---------------------------------------------------------------- provider

test('naip provider: rectangle, zooms, no request below minzoom, 204/failure transparent', async () => {
  const fetched = [];
  const Cesium = fakeCesium({
    fetchTile: (x, y, level) => {
      fetched.push(level);
      return level === 17
        ? Promise.reject(new Error('204'))
        : Promise.resolve({ ok: level });
    },
  });
  const blank = { blank: true };
  const provider = createNaipImageryProvider(Cesium, NAIP.years[0], {
    blank: () => blank,
  });
  assert.deepEqual(provider.options.rectangle, {
    w: -106.69922,
    s: 25.79989,
    e: -93.42773,
    n: 36.59789,
  });
  assert.equal(provider.options.minimumLevel, 0);
  assert.equal(provider.options.maximumLevel, 18);
  assert.equal(provider.options.hasAlphaChannel, true);
  assert.equal(provider.options.url, '/basemap/naip/2024/{z}/{x}/{y}.webp');
  assert.equal(await provider.requestImage(0, 0, 8), blank);
  assert.equal(await provider.requestImage(0, 0, 11), blank);
  assert.deepEqual(fetched, []);
  assert.deepEqual(await provider.requestImage(1, 1, 12), { ok: 12 });
  assert.equal(await provider.requestImage(1, 1, 17), blank);
  assert.deepEqual(fetched, [12, 17]);
});

test('naip provider: Cesium throttle (undefined) passes through', () => {
  const Cesium = fakeCesium({ fetchTile: () => undefined });
  const provider = createNaipImageryProvider(Cesium, NAIP.years[0], {
    blank: () => ({}),
  });
  assert.equal(provider.requestImage(1, 1, 14), undefined);
});

// ---------------------------------------------------------------- layers

test('naip layers: default newest year, above the base layer, regional above NAIP', () => {
  const { viewer, detach } = setup();
  assert.deepEqual(keys(viewer), [
    'sentinel',
    'naip-2024',
    'regional-hires-2024',
  ]);
  assert.equal(detach.state().year, 2024);
  // Another overlay added later (labels, weather) stays above NAIP when the
  // year changes.
  viewer.imageryLayers.add({ name: 'labels', destroy() {} });
  detach.setYear(2018);
  assert.deepEqual(keys(viewer), [
    'sentinel',
    'naip-2024',
    'regional-hires-2018',
    'labels',
  ]);
  detach();
  assert.deepEqual(keys(viewer), ['sentinel', 'labels']);
});

test('naip layers: 20 slider switches do not leak layers or credits', () => {
  const { viewer, detach } = setup();
  const ticks = detach.state().ticks;
  const before = viewer.imageryLayers.length;
  for (let i = 0; i < 20; i++) {
    detach.setYear(ticks[i % ticks.length]);
    // base + statewide + one regional layer for every tick of this config
    assert.equal(viewer.imageryLayers.length, before);
    assert.equal(viewer.imageryLayers.length, 3);
  }
  const s = detach.state();
  assert.equal(s.created - s.destroyed, 2);
  assert.ok(viewer.imageryLayers.items.every((l) => !l.isDestroyed?.()));
  assert.ok(viewer.scene.frameState.creditDisplay.shown.size <= 2);
  detach();
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(viewer.scene.frameState.creditDisplay.shown.size, 0);
});

test('naip layers: unchanged statewide layer is kept across regional-only years', () => {
  const { viewer, detach } = setup();
  const naipLayer = viewer.imageryLayers.items[1];
  detach.setYear(1939);
  detach.setYear(2018);
  assert.equal(viewer.imageryLayers.items[1], naipLayer);
  assert.equal(naipLayer.isDestroyed(), false);
});

test('naip credits: only for layers on screen', () => {
  const { viewer, detach, cam } = setup({
    view: {
      viewBounds: [
        TYLER.lon - 0.05,
        TYLER.lat - 0.05,
        TYLER.lon + 0.05,
        TYLER.lat + 0.05,
      ],
      lat: TYLER.lat,
    },
  });
  const shown = viewer.scene.frameState.creditDisplay.shown;
  // Tyler: statewide NAIP only; the Wood+Upshur layer is not in view.
  assert.deepEqual([...shown], ['USDA NAIP 2024 via TxGIO']);
  // Gilmer: inside Upshur, both.
  cam.view = {
    viewBounds: [
      GILMER.lon - 0.05,
      GILMER.lat - 0.05,
      GILMER.lon + 0.05,
      GILMER.lat + 0.05,
    ],
    lat: GILMER.lat,
  };
  viewer.camera.moveEnd.raise();
  assert.deepEqual([...shown].sort(), [
    'TxGIO / ETCOG 2024',
    'USDA NAIP 2024 via TxGIO',
  ]);
  detach.setYear(2018);
  assert.deepEqual([...shown].sort(), [
    'TxGIO / StratMap East Texas 2018',
    'USDA NAIP 2024 via TxGIO',
  ]);
  // Global view: nothing of NAIP is drawn, so no NAIP credit.
  cam.height = 12_000_000;
  cam.view = { viewBounds: null, lat: 0 };
  viewer.camera.moveEnd.raise();
  assert.deepEqual([...shown], []);
  // Turned off by the user: none.
  cam.height = 3_000;
  cam.view = { viewBounds: [-95.4, 32.3, -95.2, 32.4], lat: TYLER.lat };
  detach.setEnabled(false);
  assert.deepEqual([...shown], []);
  assert.ok(viewer.imageryLayers.items.slice(1).every((l) => l.show === false));
  detach.setEnabled(true);
  assert.deepEqual([...shown], ['USDA NAIP 2024 via TxGIO']);
});

test('naip: Google 3D drawn hides the layers and credits; switch away destroys them', () => {
  const session = { tileset: { show: false } };
  const { viewer, controller, detach } = setup({ session });
  const shown = viewer.scene.frameState.creditDisplay.shown;
  assert.equal(shown.size, 1);
  // P3 hand-over: Google drawn over the open globe before the switch.
  session.tileset.show = true;
  viewer.scene.preUpdate.raise();
  assert.ok(viewer.imageryLayers.items.slice(1).every((l) => l.show === false));
  assert.equal(shown.size, 0);
  // The controller settles on Google: layers destroyed, nothing leaks.
  const made = viewer.imageryLayers.items.slice(1);
  controller.switchTo('photoreal');
  assert.equal(viewer.imageryLayers.length, 1);
  assert.ok(made.every((l) => l.isDestroyed()));
  // Back to Byrd-IT Open: same year comes back.
  session.tileset.show = false;
  viewer.scene.preUpdate.raise();
  controller.switchTo(BYRDIT_OPEN_STACK_ID);
  assert.deepEqual(keys(viewer), [
    'sentinel',
    'naip-2024',
    'regional-hires-2024',
  ]);
  assert.equal(shown.size, 1);
  // 20 stack round trips: still exactly one set of layers.
  for (let i = 0; i < 20; i++) {
    controller.switchTo('esri-imagery');
    controller.switchTo(BYRDIT_OPEN_STACK_ID);
  }
  assert.equal(viewer.imageryLayers.length, 3);
  detach();
  assert.equal(controller.subscribers(), 0);
  assert.equal(viewer.scene.preUpdate.size, 0);
  assert.equal(viewer.camera.moveEnd.size, 0);
});

test('naip compare: year A left, year B right, divider follows, off restores', () => {
  const splits = [];
  const createSplit = (options) => {
    const s = {
      options,
      value: options.initialValue,
      destroyed: false,
      getValue: () => s.value,
      destroy: () => {
        s.destroyed = true;
      },
    };
    splits.push(s);
    return s;
  };
  const { viewer, detach, Cesium } = setup({ createSplit });
  detach.setCompare(true, 2018);
  const items = viewer.imageryLayers.items.slice(1);
  assert.deepEqual(
    items.map((l) => [l.imageryProvider.entry.key, l.splitDirection]),
    [
      ['naip-2024', Cesium.SplitDirection.LEFT],
      ['regional-hires-2024', Cesium.SplitDirection.LEFT],
      ['naip-2024', Cesium.SplitDirection.RIGHT],
      ['regional-hires-2018', Cesium.SplitDirection.RIGHT],
    ],
  );
  assert.equal(splits.length, 1);
  assert.equal(splits[0].options.beforeLabel, '2024');
  assert.equal(splits[0].options.afterLabel, '2018');
  splits[0].value = 0.3;
  detach.setYearB(1939);
  assert.equal(splits[0].destroyed, true);
  assert.equal(splits[1].options.initialValue, 0.3);
  assert.equal(splits[1].options.afterLabel, '1939');
  detach.setCompare(false);
  assert.equal(splits[1].destroyed, true);
  assert.deepEqual(keys(viewer), [
    'sentinel',
    'naip-2024',
    'regional-hires-2024',
  ]);
  assert.ok(
    viewer.imageryLayers.items
      .slice(1)
      .every((l) => l.splitDirection === Cesium.SplitDirection.NONE),
  );
});

// ---------------------------------------------------------------- slider DOM

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
  prepend(n) {
    n.parent = this;
    this.children.unshift(n);
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

function fakeDoc() {
  const doc = {
    createElement: (tag) => new FakeElement(doc, tag),
  };
  doc.body = new FakeElement(doc, 'body');
  doc.getElementById = (id) =>
    [...doc.body.walk()].find((e) => e.id === id) ?? null;
  return doc;
}

test('naip slider: ticks only for years present, keyboard arrows move by tick', () => {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  doc.body.append(container);
  const { detach } = setup({
    createSlider: (options) => createNaipSlider({ ...options, container, doc }),
  });
  const panel = doc.getElementById(NAIP_SLIDER_ID);
  assert.ok(panel);
  const ticks = [...panel.walk()]
    .find((e) => e.attributes.class === 'gev-naip-ticks')
    .children.map((c) => c.textContent);
  assert.deepEqual(ticks, ['1939', '2018', '2024']);
  const ranges = [...panel.walk()].filter((e) => e.attributes.type === 'range');
  const range = ranges[0];
  assert.equal(range.attributes.max, '2');
  assert.equal(range.value, '2');
  assert.equal(range.attributes['aria-valuetext'], '2024');
  const out = [...panel.walk()].find((e) => e.tagName === 'OUTPUT');
  assert.equal(out.textContent, '2024: NAIP 2024 · Wood+Upshur 2024 15 cm');
  let prevented = 0;
  const key = (k) =>
    range.fire('keydown', { key: k, preventDefault: () => (prevented += 1) });
  key('ArrowLeft');
  assert.equal(detach.state().year, 2018);
  assert.equal(range.value, '1');
  key('ArrowLeft');
  key('ArrowLeft'); // stays at the oldest
  assert.equal(detach.state().year, 1939);
  assert.match(out.textContent, /\(nearest\)$/);
  key('End');
  assert.equal(detach.state().year, 2024);
  key('Home');
  assert.equal(detach.state().year, 1939);
  key('ArrowRight');
  assert.equal(detach.state().year, 2018);
  assert.equal(prevented, 6);
  key('a'); // other keys are not taken
  assert.equal(prevented, 6);
  // Dragging the range picks the tick at that index.
  range.value = '2';
  range.fire('input');
  assert.equal(detach.state().year, 2024);
  // Compare row hidden until the box is ticked.
  assert.equal(ranges[1].parent.parent.style.display, 'none');
  const boxes = [...panel.walk()].filter(
    (e) => e.attributes.type === 'checkbox',
  );
  boxes[1].checked = true;
  boxes[1].fire('change');
  assert.equal(detach.state().compare, true);
  assert.equal(detach.state().yearB, 2018);
  assert.equal(ranges[1].parent.parent.style.display, 'flex');
  // The Aerial box turns the layers off.
  boxes[0].checked = false;
  boxes[0].fire('change');
  assert.equal(detach.state().enabled, false);
  detach();
  assert.equal(doc.getElementById(NAIP_SLIDER_ID), null);
});

test('naip slider: never wider than its container on a phone; rows wrap and the range shrinks (t_37cf1f79)', () => {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  doc.body.append(container);
  setup({
    createSlider: (options) => createNaipSlider({ ...options, container, doc }),
  });
  const panel = doc.getElementById(NAIP_SLIDER_ID);
  // centred, sized to its content but capped by the container (an 824 px
  // panel on a 412 px phone grew the mobile layout viewport to 618 px)
  assert.equal(panel.style.position, 'absolute');
  assert.equal(panel.style.left, '50%');
  assert.equal(panel.style.transform, 'translateX(-50%)');
  assert.equal(panel.style.width, 'max-content');
  assert.equal(panel.style.maxWidth, 'calc(100% - 16px)');
  assert.equal(panel.style.boxSizing, 'border-box');
  // every row wraps instead of pushing the panel wider
  const rows = panel.children;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.style.flexWrap, 'wrap');
    assert.equal(row.style.minWidth, '0');
  }
  const ranges = [...panel.walk()].filter((e) => e.attributes.type === 'range');
  assert.equal(ranges.length, 2);
  for (const range of ranges) {
    // the range follows its column; the column keeps the preferred width
    // but never exceeds the row
    assert.equal(range.style.width, '100%');
    const column = range.parent;
    assert.match(column.style.width, /^\d+px$/);
    assert.equal(column.style.maxWidth, '100%');
    assert.equal(column.style.minWidth, '0');
    assert.equal(column.parent.style.flexWrap, 'wrap');
    assert.equal(column.parent.style.maxWidth, '100%');
  }
  const out = [...panel.walk()].find((e) => e.tagName === 'OUTPUT');
  assert.equal(out.style.maxWidth, 'min(340px, 100%)');
  const ticks = [...panel.walk()].find(
    (e) => e.attributes.class === 'gev-naip-ticks',
  );
  assert.equal(ticks.style.overflow, 'hidden');
  // no fixed pixel width anywhere above the column
  for (const e of panel.walk())
    if (e !== panel && !e.children.some((c) => c.attributes.type === 'range'))
      assert.doesNotMatch(String(e.style.width ?? ''), /px$/, e.tagName);
});

test('naip slider: hidden while another stack is on screen', () => {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  doc.body.append(container);
  const { controller } = setup({
    createSlider: (options) => createNaipSlider({ ...options, container, doc }),
  });
  const panel = doc.getElementById(NAIP_SLIDER_ID);
  assert.equal(panel.hidden, false);
  controller.switchTo('photoreal');
  assert.equal(panel.hidden, true);
  assert.equal(panel.style.display, 'none');
  controller.switchTo(BYRDIT_OPEN_STACK_ID);
  assert.equal(panel.hidden, false);
});

test('naip split: shared divider with its own id and inline line style', () => {
  const doc = fakeDoc();
  const parent = doc.createElement('div');
  doc.body.append(parent);
  let got = null;
  const split = createNaipSplit({ parent, scene: {} }, (options) => {
    got = options;
    const line = doc.createElement('div');
    line.setAttribute('id', options.id);
    parent.append(line);
    return { destroy() {} };
  });
  assert.ok(split);
  assert.equal(got.id, 'gev-naip-split-line');
  assert.equal(got.cssProperty, '--gev-naip-split');
  const line = doc.getElementById('gev-naip-split-line');
  assert.equal(line.style.position, 'absolute');
  assert.equal(line.style.left, 'var(--gev-naip-split, 50%)');
});
