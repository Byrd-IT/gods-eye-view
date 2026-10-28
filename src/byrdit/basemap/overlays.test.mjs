import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOverlays } from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';
import { attachOverlays, stackOrder } from './overlays.js';
import {
  createVectorOverlayProvider,
  drawVectorTile,
} from './overlaysVector.js';
import { createOverlaysPanel, createOverlaysMenuPanel } from './overlaysPanel.js';
import { BYRDIT_OPEN_STACK_ID } from './stack.js';

const OVERLAYS = normalizeOverlays(composeOverlays(OVERLAYS_PUBLISH).browser);

function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise(v = {}) {
      for (const fn of [...listeners]) fn(v);
    },
    get size() {
      return listeners.size;
    },
  };
}

function fakeCesium() {
  class UrlTemplateImageryProvider {
    constructor(options) {
      this.options = options;
    }
    requestImage() {
      return Promise.resolve({ base: true });
    }
  }
  class ImageryLayer {
    constructor(imageryProvider, { show = true, alpha = 1 } = {}) {
      Object.assign(this, { imageryProvider, show, alpha, _destroyed: false });
    }
    isDestroyed() {
      return this._destroyed;
    }
    destroy() {
      this._destroyed = true;
    }
  }
  class Credit {
    constructor(html) {
      this.html = html;
    }
  }
  return {
    UrlTemplateImageryProvider,
    ImageryLayer,
    Credit,
    Rectangle: { fromDegrees: (w, s, e, n) => ({ w, s, e, n }) },
  };
}

function fakeViewer() {
  const items = [];
  const shown = new Set();
  return {
    imageryLayers: {
      items,
      get length() {
        return items.length;
      },
      add: (layer, i = items.length) => void items.splice(i, 0, layer),
      remove(layer, destroy = true) {
        const i = items.indexOf(layer);
        if (i < 0) return false;
        items.splice(i, 1);
        if (destroy) layer.destroy();
        return true;
      },
      indexOf: (layer) => items.indexOf(layer),
      raiseToTop(layer) {
        items.splice(items.indexOf(layer), 1);
        items.push(layer);
      },
    },
    container: null,
    camera: { moveEnd: event() },
    scene: {
      frameState: {
        creditDisplay: {
          shown,
          addStaticCredit: (c) => shown.add(c.html),
          removeStaticCredit: (c) => shown.delete(c.html),
        },
      },
      preUpdate: event(),
      requestRender() {},
    },
  };
}

function setup({ view = { viewBounds: [-95.7, 32.8, -95.5, 32.9], lat: 32.88 }, height = 3000, session = { tileset: null } } = {}) {
  const Cesium = fakeCesium();
  const viewer = fakeViewer();
  const subs = new Set();
  let active = BYRDIT_OPEN_STACK_ID;
  viewer.imageryLayers.add({ name: 'sentinel', destroy() {} });
  const controller = {
    getActiveId: () => active,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    switchTo(id) {
      active = id;
      subs.forEach((fn) => fn());
    },
    subs,
  };
  const panelCalls = [];
  const detach = attachOverlays({
    Cesium,
    viewer,
    controller,
    overlays: OVERLAYS,
    session,
    heightOf: () => height,
    viewOf: () => view,
    createProvider: (entry) => ({ entry }),
    createPanel: (opts) => {
      panelCalls.push(opts);
      return { update() {}, setVisible() {}, destroy() { panelCalls.destroyed = true; } };
    },
  });
  return { Cesium, viewer, controller, detach, panelCalls, session };
}

const ids = (viewer) =>
  viewer.imageryLayers.items.map((l) => l.imageryProvider?.entry?.id ?? l.name);

test('overlays: all offered, all OFF until toggled; fixed raster -> vector order', () => {
  const { viewer, detach } = setup();
  assert.deepEqual(detach.state().layers.map((l) => l.id), [
    'ustopo', 'hillshade', 'relief', 'terrain-rgb', 'contours', 'lake-depth',
  ]);
  assert.deepEqual(ids(viewer), ['sentinel']);
  detach.setEnabled('lake-depth', true);
  detach.setEnabled('hillshade', true);
  detach.setEnabled('contours', true);
  assert.deepEqual(ids(viewer), ['sentinel', 'hillshade', 'contours', 'lake-depth']);
  assert.equal(detach.setEnabled('nope', true), false);
  assert.deepEqual(stackOrder(OVERLAYS).map((l) => l.kind).join(), 'raster,raster,raster,raster,vector,vector');
});

test('overlays: per-layer opacity (default from manifest, clamped), toggle off removes layer', () => {
  const { viewer, detach } = setup();
  assert.equal(detach.state().layers.find((l) => l.id === 'hillshade').opacity, 0.5);
  detach.setEnabled('hillshade', true);
  detach.setEnabled('relief', true);
  const [, hill, relief] = viewer.imageryLayers.items;
  assert.equal(hill.alpha, 0.5);
  assert.equal(relief.alpha, 0.6);
  detach.setOpacity('hillshade', 0.25);
  assert.equal(hill.alpha, 0.25);
  assert.equal(relief.alpha, 0.6, 'other layers untouched');
  detach.setOpacity('hillshade', 7);
  assert.equal(hill.alpha, 1);
  detach.setOpacity('hillshade', -1);
  assert.equal(hill.alpha, 0);
  assert.equal(detach.setOpacity('hillshade', 'x'), false);
  detach.setEnabled('hillshade', false);
  assert.deepEqual(ids(viewer), ['sentinel', 'relief']);
  assert.equal(hill.isDestroyed(), true);
  detach.setEnabled('hillshade', true);
  assert.equal(viewer.imageryLayers.items[1].alpha, 0.0, 'opacity kept across toggles');
});

test('overlays: removed with another stack or Google 3D, user choices kept', () => {
  const { viewer, controller, detach, session } = setup();
  detach.setEnabled('contours', true);
  detach.setOpacity('contours', 0.4);
  controller.switchTo('photoreal');
  assert.deepEqual(ids(viewer), ['sentinel']);
  controller.switchTo(BYRDIT_OPEN_STACK_ID);
  assert.deepEqual(ids(viewer), ['sentinel', 'contours']);
  assert.equal(viewer.imageryLayers.items[1].alpha, 0.4);
  session.tileset = { show: true };
  viewer.scene.preUpdate.raise();
  assert.deepEqual(ids(viewer), ['sentinel']);
  session.tileset.show = false;
  viewer.scene.preUpdate.raise();
  assert.deepEqual(ids(viewer), ['sentinel', 'contours']);
});

test('overlays: credits only for enabled layers in view; detach cleans up', () => {
  const { viewer, detach, controller, panelCalls } = setup();
  const shown = viewer.scene.frameState.creditDisplay.shown;
  assert.equal(shown.size, 0);
  detach.setEnabled('hillshade', true);
  detach.setEnabled('lake-depth', true);
  assert.deepEqual([...shown].sort(), ['Texas Water Development Board', 'USGS 3DEP']);
  detach.setEnabled('hillshade', false);
  assert.deepEqual([...shown], ['Texas Water Development Board']);
  detach();
  assert.equal(shown.size, 0);
  assert.deepEqual(ids(viewer), ['sentinel']);
  assert.equal(controller.subs.size, 0);
  assert.equal(viewer.camera.moveEnd.size, 0);
  assert.equal(viewer.scene.preUpdate.size, 0);
  assert.equal(panelCalls.destroyed, true);
});

test('overlays: panel callbacks drive the layers', () => {
  const { viewer, panelCalls } = setup();
  const [panel] = panelCalls;
  assert.equal(panel.state.layers.length, 6);
  panel.onEnabled('relief', true);
  panel.onOpacity('relief', 0.3);
  assert.equal(viewer.imageryLayers.items[1].alpha, 0.3);
});

// ----------------------------------------------------------------- vector

function fakeCtx() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    stroke: rec('stroke'),
    strokeText: rec('strokeText'),
    fillText: rec('fillText'),
  };
}

const line = (pts, props = {}, type = 2) => ({
  type,
  properties: props,
  loadGeometry: () => [pts.map(([x, y]) => ({ x, y }))],
});
const layerOf = (features, extent = 4096) => ({
  extent,
  length: features.length,
  feature: (i) => features[i],
});

test('vector: draws minor under major, labels depth_ft / elev_ft, skips unknown layers', () => {
  const ctx = fakeCtx();
  const tile = {
    layers: {
      bathy_major: layerOf([line([[0, 2048], [4096, 2048]], { depth_ft: 12.4 })]),
      bathy_contours: layerOf([line([[0, 100], [4096, 100]], { depth_ft: 3 })]),
      unknown_layer: layerOf([line([[0, 0], [1, 1]])]),
      contours_major: layerOf([line([[0, 500], [4096, 500], [4096, 900]], { elev_ft: 351.7 })]),
    },
  };
  const drawn = drawVectorTile(ctx, tile);
  assert.equal(drawn.features, 3);
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepEqual(texts.sort(), ['12 ft', '352']);
  assert.ok(!ctx.calls.some((c) => c[0] === 'strokeText' && c[1] === '3 ft'), 'minor has no label');
  // scaled from extent 4096 to 256 px
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'moveTo' && c[2] === 128), ['moveTo', 0, 128]);
});

test('vector: label rules (short lines, tile edge, crowding) and polygon rings closed', () => {
  const ctx = fakeCtx();
  const tile = {
    layers: {
      bathy_major: layerOf([
        line([[0, 100], [100, 100]], { depth_ft: 1 }), // too short
        line([[0, 2048], [4096, 2048]], { depth_ft: 2 }),
        line([[0, 2100], [4096, 2100]], { depth_ft: 3 }), // crowds the first
        line([[0, 0], [4096, 0]], { depth_ft: 4 }), // mid on edge row
      ]),
      lake_pool: layerOf([line([[0, 0], [10, 0], [10, 10]], { pool_ft: 1 }, 3)]),
    },
  };
  const drawn = drawVectorTile(ctx, tile);
  assert.equal(drawn.labels, 1);
  assert.ok(ctx.calls.some((c) => c[0] === 'closePath'));
  // a missing property gives no label and no throw
  assert.equal(drawVectorTile(fakeCtx(), { layers: { bathy_major: layerOf([line([[0, 2048], [4096, 2048]], {})]) } }).labels, 0);
  assert.deepEqual(drawVectorTile(fakeCtx(), null), { features: 0, labels: 0 });
});

test('vector provider: url substitution, no request below minzoom, 204/error = blank', async () => {
  const Cesium = fakeCesium();
  const entry = OVERLAYS.layers.find((l) => l.id === 'lake-depth');
  const urls = [];
  const canvas = () => ({ getContext: () => fakeCtx(), blank: true });
  let mode = 'ok';
  const provider = createVectorOverlayProvider(Cesium, entry, {
    fetchImpl: async (url) => {
      urls.push(url);
      if (mode === 'throw') throw new Error('down');
      return {
        status: mode === 'ok' ? 200 : 204,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
    decode: async () => ({ layers: { bathy_major: layerOf([line([[0, 2048], [4096, 2048]], { depth_ft: 9 })]) } }),
    makeCanvas: canvas,
  });
  assert.equal(provider.options.maximumLevel, 16);
  assert.deepEqual(provider.options.rectangle, { w: -96.13287, s: 32.55506, e: -94.48982, n: 33.10746 });
  await provider.requestImage(1, 2, 5); // below minzoom 9
  assert.deepEqual(urls, []);
  const ok = await provider.requestImage(7678, 13134, 15);
  assert.deepEqual(urls, ['/basemap/overlay/lake-depth/15/7678/13134.mvt']);
  assert.equal(ok.blank, true);
  mode = '204';
  await provider.requestImage(1, 1, 12);
  mode = 'throw';
  assert.equal((await provider.requestImage(1, 1, 12)).blank, true);
});

// ------------------------------------------------------------------- panel

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.textContent = '';
    this.checked = false;
    this.value = '';
  }
  append(...n) { this.children.push(...n); }
  prepend(n) { this.children.unshift(n); }
  remove() { this.removed = true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(e, fn) { this.listeners[e] = fn; }
  find(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
}
const fakeDoc = () => ({ createElement: (tag) => new Node(tag) });

test('panel: a toggle and an opacity range per overlay; events call back; text via textContent', () => {
  const doc = fakeDoc();
  const container = new Node('div');
  const calls = [];
  const state = { layers: stackOrder(OVERLAYS).map((l) => ({ id: l.id, name: l.name, enabled: false, opacity: l.defaultOpacity })) };
  const panel = createOverlaysPanel({
    container, doc, state,
    onEnabled: (id, on) => calls.push(['on', id, on]),
    onOpacity: (id, v) => calls.push(['op', id, v]),
  });
  const boxes = panel.element.find((n) => n.attrs.type === 'checkbox');
  const ranges = panel.element.find((n) => n.attrs.type === 'range');
  assert.equal(boxes.length, 6);
  assert.equal(ranges.length, 6);
  assert.ok(ranges.every((r) => r.disabled === true), 'opacity disabled while off');
  boxes[1].checked = true;
  boxes[1].listeners.change();
  ranges[1].value = '35';
  ranges[1].listeners.input();
  assert.deepEqual(calls, [['on', 'hillshade', true], ['op', 'hillshade', 0.35]]);
  panel.update({ layers: [{ id: 'hillshade', enabled: true, opacity: 0.35 }] });
  assert.equal(ranges[1].disabled, false);
  assert.equal(ranges[1].value, '35');
  panel.destroy();
  assert.equal(panel.element.removed, true);
});

test('panel: hosted in the menu slot when there is one, claimed only while visible', () => {
  const log = [];
  const slot = {};
  const menu = { slot: (n) => (n === 'overlays' ? slot : null), claim: (n) => log.push(['claim', n]), release: (n) => log.push(['release', n]) };
  const inner = { element: {}, update() {}, setVisible() {}, destroy() { log.push(['destroy']); } };
  let seen;
  const panel = createOverlaysMenuPanel({ container: {}, doc: {} }, { ensureMenu: () => menu, create: (o) => ((seen = o), inner) });
  assert.equal(seen.container, slot);
  assert.equal(seen.embedded, true);
  panel.setVisible(true);
  panel.setVisible(true);
  panel.setVisible(false);
  panel.setVisible(true);
  panel.destroy();
  assert.deepEqual(log, [['claim', 'overlays'], ['release', 'overlays'], ['claim', 'overlays'], ['release', 'overlays'], ['destroy']]);
  // no card: floats
  let floated;
  createOverlaysMenuPanel({ container: {}, doc: {} }, { ensureMenu: () => null, create: (o) => ((floated = o), inner) });
  assert.equal(floated.embedded, undefined);
});

test('vector: a real gzipped TWDB lake-depth tile (z15 7678/13211) decodes and draws depth labels', async () => {
  const { readFileSync } = await import('node:fs');
  const { decodeMvt } = await import('./overlaysVector.js');
  const bytes = readFileSync(
    new URL('./fixtures/overlay-lake-depth-z15-7678-13211.mvt.gz', import.meta.url),
  );
  const tile = await decodeMvt(bytes);
  assert.deepEqual(Object.keys(tile.layers).sort(), ['bathy_contours', 'bathy_major', 'lake_pool']);
  const ctx = fakeCtx();
  const drawn = drawVectorTile(ctx, tile);
  assert.ok(drawn.features > 50);
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts.length >= 1 && texts.every((x) => /^\d+ ft$/.test(x)), texts.join());
});
