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
import {
  createOverlaysPanel,
  createOverlaysMenuPanel,
} from './overlaysPanel.js';
import { ensureMapLayersCard } from './mapLayersCard.js';
import {
  ALL_OVERLAY_GROUPS,
  groupOfOverlay,
  overlayMatches,
} from './overlayGroups.js';
import { LIVE_OVERLAY_LAYERS } from './fixtures/overlayManifest.mjs';
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

function setup({
  view = { viewBounds: [-95.7, 32.8, -95.5, 32.9], lat: 32.88 },
  height = 3000,
  session = { tileset: null },
} = {}) {
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
      return {
        update() {},
        setVisible() {},
        destroy() {
          panelCalls.destroyed = true;
        },
      };
    },
  });
  return { Cesium, viewer, controller, detach, panelCalls, session };
}

const ids = (viewer) =>
  viewer.imageryLayers.items.map((l) => l.imageryProvider?.entry?.id ?? l.name);

test('overlays: all offered, all OFF until toggled; fixed raster -> vector order', () => {
  const { viewer, detach } = setup();
  assert.deepEqual(detach.state().stack, [
    'ustopo',
    'hillshade',
    'relief',
    'terrain-rgb',
    'contours',
    'lake-depth',
  ]);
  assert.deepEqual(
    detach.state().layers.map((l) => l.id),
    ['lake-depth', 'contours', 'terrain-rgb', 'relief', 'hillshade', 'ustopo'],
    'panel lists the top of the stack first',
  );
  assert.deepEqual(ids(viewer), ['sentinel']);
  detach.setEnabled('lake-depth', true);
  detach.setEnabled('hillshade', true);
  detach.setEnabled('contours', true);
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'hillshade',
    'contours',
    'lake-depth',
  ]);
  assert.equal(detach.setEnabled('nope', true), false);
  assert.deepEqual(
    stackOrder(OVERLAYS)
      .map((l) => l.kind)
      .join(),
    'raster,raster,raster,raster,vector,vector',
  );
});

test('overlays: per-layer opacity (default from manifest, clamped), toggle off removes layer', () => {
  const { viewer, detach } = setup();
  assert.equal(
    detach.state().layers.find((l) => l.id === 'hillshade').opacity,
    0.5,
  );
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
  assert.equal(
    viewer.imageryLayers.items[1].alpha,
    0.0,
    'opacity kept across toggles',
  );
});

test('overlays: raise/lower changes the draw order, keeps toggles, ends return false', () => {
  const { viewer, detach } = setup();
  detach.setEnabled('hillshade', true);
  detach.setEnabled('contours', true);
  detach.setEnabled('lake-depth', true);
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'hillshade',
    'contours',
    'lake-depth',
  ]);
  // vector over raster by default; push hillshade above them all, one step at a time
  assert.equal(detach.moveLayer('hillshade', 'up'), true);
  assert.deepEqual(detach.state().stack.slice(0, 3), [
    'ustopo',
    'relief',
    'hillshade',
  ]);
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'hillshade',
    'contours',
    'lake-depth',
  ]);
  detach.moveLayer('hillshade', 'up');
  detach.moveLayer('hillshade', 'up');
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'contours',
    'hillshade',
    'lake-depth',
  ]);
  detach.moveLayer('hillshade', 'up');
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'contours',
    'lake-depth',
    'hillshade',
  ]);
  assert.equal(detach.moveLayer('hillshade', 'up'), false, 'already on top');
  assert.equal(detach.state().layers[0].id, 'hillshade');
  assert.equal(detach.moveLayer('hillshade', 'sideways'), false);
  assert.equal(detach.moveLayer('nope', 'up'), false);
  detach.moveLayer('lake-depth', 'down');
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'lake-depth',
    'contours',
    'hillshade',
  ]);
  // toggling a layer off and on keeps the chosen position
  detach.setEnabled('hillshade', false);
  detach.setEnabled('hillshade', true);
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'lake-depth',
    'contours',
    'hillshade',
  ]);
  // a newly enabled layer lands at its chosen slot, not on top
  detach.setEnabled('relief', true);
  assert.deepEqual(ids(viewer), [
    'sentinel',
    'relief',
    'lake-depth',
    'contours',
    'hillshade',
  ]);
  // bottom end
  for (let i = 0; i < 10; i++) detach.moveLayer('ustopo', 'down');
  assert.equal(detach.moveLayer('ustopo', 'down'), false);
  assert.equal(detach.state().stack[0], 'ustopo');
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
  assert.deepEqual([...shown].sort(), [
    'Texas Water Development Board',
    'USGS 3DEP',
  ]);
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
  const rec =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
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
      bathy_major: layerOf([
        line(
          [
            [0, 2048],
            [4096, 2048],
          ],
          { depth_ft: 12.4 },
        ),
      ]),
      bathy_contours: layerOf([
        line(
          [
            [0, 100],
            [4096, 100],
          ],
          { depth_ft: 3 },
        ),
      ]),
      unknown_layer: layerOf([
        line([
          [0, 0],
          [1, 1],
        ]),
      ]),
      contours_major: layerOf([
        line(
          [
            [0, 500],
            [4096, 500],
            [4096, 900],
          ],
          { elev_ft: 351.7 },
        ),
      ]),
    },
  };
  const drawn = drawVectorTile(ctx, tile);
  assert.equal(drawn.features, 3);
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepEqual(texts.sort(), ['12 ft', '352']);
  assert.ok(
    !ctx.calls.some((c) => c[0] === 'strokeText' && c[1] === '3 ft'),
    'minor has no label',
  );
  // scaled from extent 4096 to 256 px
  assert.deepEqual(
    ctx.calls.find((c) => c[0] === 'moveTo' && c[2] === 128),
    ['moveTo', 0, 128],
  );
});

test('vector: label rules (short lines, tile edge, crowding) and polygon rings closed', () => {
  const ctx = fakeCtx();
  const tile = {
    layers: {
      bathy_major: layerOf([
        line(
          [
            [0, 100],
            [100, 100],
          ],
          { depth_ft: 1 },
        ), // too short
        line(
          [
            [0, 2048],
            [4096, 2048],
          ],
          { depth_ft: 2 },
        ),
        line(
          [
            [0, 2100],
            [4096, 2100],
          ],
          { depth_ft: 3 },
        ), // crowds the first
        line(
          [
            [0, 0],
            [4096, 0],
          ],
          { depth_ft: 4 },
        ), // mid on edge row
      ]),
      lake_pool: layerOf([
        line(
          [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          { pool_ft: 1 },
          3,
        ),
      ]),
    },
  };
  const drawn = drawVectorTile(ctx, tile);
  assert.equal(drawn.labels, 1);
  assert.ok(ctx.calls.some((c) => c[0] === 'closePath'));
  // a missing property gives no label and no throw
  assert.equal(
    drawVectorTile(fakeCtx(), {
      layers: {
        bathy_major: layerOf([
          line(
            [
              [0, 2048],
              [4096, 2048],
            ],
            {},
          ),
        ]),
      },
    }).labels,
    0,
  );
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
    decode: async () => ({
      layers: {
        bathy_major: layerOf([
          line(
            [
              [0, 2048],
              [4096, 2048],
            ],
            { depth_ft: 9 },
          ),
        ]),
      },
    }),
    makeCanvas: canvas,
  });
  assert.equal(provider.options.maximumLevel, 16);
  assert.deepEqual(provider.options.rectangle, {
    w: -96.13287,
    s: 32.55506,
    e: -94.48982,
    n: 33.10746,
  });
  await provider.requestImage(1, 2, 5); // below minzoom 9
  assert.deepEqual(urls, []);
  const ok = await provider.requestImage(7678, 13134, 15);
  assert.deepEqual(urls, ['/basemap/overlay/lake-depth/15/7678/13134.mvt']);
  assert.equal(ok.blank, true);
  mode = '204';
  const none = await provider.requestImage(1, 1, 12);
  assert.equal(none.blank, true);
  assert.equal(urls.at(-1), '/basemap/overlay/lake-depth/12/1/1.mvt');
  mode = 'throw';
  const failed = await provider.requestImage(1, 1, 12);
  assert.equal(failed.blank, true);
  assert.equal(failed, none, 'one shared blank canvas');
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
    this.dataset = {};
    this.className = '';
  }
  set type(v) {
    this.attrs.type = v;
  }
  get type() {
    return this.attrs.type;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  insertBefore(n, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, n);
  }
  get ownerDocument() {
    return fakeDoc();
  }
  append(...n) {
    this.children.push(...n);
  }
  prepend(n) {
    this.children.unshift(n);
  }
  remove() {
    this.removed = true;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(e, fn) {
    this.listeners[e] = fn;
  }
  find(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
}
function fakeDoc() {
  return { createElement: (tag) => new Node(tag) };
}

test('panel: a toggle and an opacity range per overlay; events call back; text via textContent', () => {
  const doc = fakeDoc();
  const container = new Node('div');
  const calls = [];
  const state = {
    layers: stackOrder(OVERLAYS).map((l) => ({
      id: l.id,
      name: l.name,
      enabled: false,
      opacity: l.defaultOpacity,
    })),
  };
  const panel = createOverlaysPanel({
    container,
    doc,
    state,
    onEnabled: (id, on) => calls.push(['on', id, on]),
    onOpacity: (id, v) => calls.push(['op', id, v]),
  });
  const boxes = panel.element.find((n) => n.attrs.type === 'checkbox');
  const ranges = panel.element.find((n) => n.attrs.type === 'range');
  assert.equal(boxes.length, 6);
  assert.equal(ranges.length, 6);
  assert.ok(
    ranges.every((r) => r.disabled === true),
    'opacity disabled while off',
  );
  boxes[1].checked = true;
  boxes[1].listeners.change();
  ranges[1].value = '35';
  ranges[1].listeners.input();
  assert.deepEqual(calls, [
    ['on', 'hillshade', true],
    ['op', 'hillshade', 0.35],
  ]);
  panel.update({ layers: [{ id: 'hillshade', enabled: true, opacity: 0.35 }] });
  assert.equal(ranges[1].disabled, false);
  assert.equal(ranges[1].value, '35');
  panel.destroy();
  assert.equal(panel.element.removed, true);
});

test('panel: raise/lower buttons call back; ends disabled; rows reorder on update', () => {
  const doc = fakeDoc();
  const container = new Node('div');
  const calls = [];
  const layers = ['a', 'b', 'c'].map((id) => ({
    id,
    name: id.toUpperCase(),
    enabled: false,
    opacity: 0.5,
  }));
  const panel = createOverlaysPanel({
    container,
    doc,
    state: { layers },
    onEnabled() {},
    onOpacity() {},
    onMove: (id, d) => calls.push([id, d]),
  });
  const btn = (id, d) =>
    panel.element.find(
      (n) =>
        n.attrs['data-move'] === d &&
        n.attrs['aria-label'].endsWith(`: ${id.toUpperCase()}`),
    )[0];
  assert.equal(btn('a', 'up').disabled, true, 'top row cannot go up');
  assert.equal(btn('c', 'down').disabled, true, 'bottom row cannot go down');
  assert.equal(btn('b', 'up').disabled, false);
  btn('b', 'up').listeners.click();
  btn('b', 'down').listeners.click();
  assert.deepEqual(calls, [
    ['b', 'up'],
    ['b', 'down'],
  ]);
  assert.equal(btn('b', 'up').textContent, '\u25B2');
  panel.update({ layers: [layers[1], layers[0], layers[2]] });
  assert.equal(btn('b', 'up').disabled, true);
  assert.equal(btn('a', 'up').disabled, false);
  const order = panel.element.children.map((r) => r.attrs['data-overlay']);
  assert.deepEqual(order.slice(-3), ['b', 'a', 'c']);
});

test('panel: styled by shared classes (chips, slider, value), no inline style, not toggles', () => {
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [{ id: 'a', name: 'A', enabled: false, opacity: 0.5 }] },
    onEnabled() {},
    onOpacity() {},
  });
  const root = panel.element;
  assert.match(root.className, /\bgev-ov-panel\b/);
  assert.deepEqual(root.style, {}, 'no inline style on the panel');
  const all = root.find(() => true);
  assert.ok(
    all.every((n) => Object.keys(n.style).length === 0),
    'no inline styles anywhere',
  );
  const chips = root.find((n) => n.attrs['data-move']);
  assert.equal(chips.length, 2);
  assert.ok(chips.every((c) => /\bdata-toggle-chip\b/.test(c.className)));
  assert.ok(
    chips.every(
      (c) => !('aria-pressed' in c.attrs) && !('aria-busy' in c.attrs),
    ),
  );
  assert.match(
    root.find((n) => n.attrs.type === 'range')[0].className,
    /\bgev-quantitative-slider\b/,
  );
  assert.equal(
    root.find((n) => n.tag === 'output')[0].className,
    'gev-slider-value',
  );
  panel.setVisible(false);
  assert.equal(root.hidden, true);
  assert.equal(
    root.style.display,
    undefined,
    'visibility is the hidden attribute only',
  );
  panel.setVisible(true);
  assert.equal(root.hidden, false);
  const floated = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [] },
    onEnabled() {},
    onOpacity() {},
  });
  assert.match(floated.element.className, /\bgev-ov-float\b/);
});

test('map layers card: adopted by id, shown and hidden, null without the static card', () => {
  const root = {
    hidden: true,
    classList: { contains: (c) => c === 'collapsed' },
  };
  const body = {};
  const doc = {
    getElementById: (id) =>
      ({ 'map-layers-panel': root, 'gev-map-layers-body': body })[id] ?? null,
  };
  const card = ensureMapLayersCard(doc);
  assert.equal(card.root, root);
  assert.equal(card.body, body);
  card.show();
  assert.equal(root.hidden, false);
  card.hide();
  assert.equal(root.hidden, true);
  assert.equal(card.isOpen(), false, 'collapsed launcher');
  assert.equal(ensureMapLayersCard({ getElementById: () => null }), null);
  assert.equal(ensureMapLayersCard({}), null);
  assert.equal(ensureMapLayersCard(null), null);
});

test('panel: hosted in the Map layers card when there is one, shown only while visible', () => {
  const log = [];
  const body = {};
  const card = {
    body,
    show: () => log.push(['show']),
    hide: () => log.push(['hide']),
  };
  const inner = {
    element: {},
    update() {},
    setVisible() {},
    destroy() {
      log.push(['destroy']);
    },
  };
  let seen;
  const panel = createOverlaysMenuPanel(
    { container: {}, doc: {} },
    { ensureCard: () => card, create: (o) => ((seen = o), inner) },
  );
  assert.equal(seen.container, body);
  assert.equal(seen.embedded, true);
  assert.equal(seen.grouped, true);
  panel.setVisible(true);
  panel.setVisible(true);
  panel.setVisible(false);
  panel.setVisible(true);
  panel.destroy();
  assert.deepEqual(log, [['show'], ['hide'], ['show'], ['hide'], ['destroy']]);
  // no card: floats, flat list
  let floated;
  createOverlaysMenuPanel(
    { container: {}, doc: {} },
    { ensureCard: () => null, create: (o) => ((floated = o), inner) },
  );
  assert.equal(floated.embedded, undefined);
  assert.equal(floated.grouped, undefined);
});

test('groups: every live overlay lands in a named group, Lakes holds all lake and bay depth layers', () => {
  const byGroup = new Map();
  for (const [id] of LIVE_OVERLAY_LAYERS) {
    const g = groupOfOverlay(id).id;
    byGroup.set(g, [...(byGroup.get(g) ?? []), id]);
  }
  assert.equal(LIVE_OVERLAY_LAYERS.length, 63);
  assert.equal(byGroup.get('other'), undefined, 'nothing falls into Other');
  assert.deepEqual(byGroup.get('lakes').sort(), [
    'gc-bay-depth',
    'lake-depth',
    'r1a-lake-depth',
    'r1b-lake-depth',
    'r2a-lake-depth',
    'r2b-lake-depth',
    'rm-lake-depth',
  ]);
  assert.equal(groupOfOverlay('ustopo-wu').id, 'topo');
  assert.equal(groupOfOverlay('rm-hillshade').id, 'hillshade');
  assert.equal(groupOfOverlay('terrain-rgb-wu').id, 'relief');
  assert.equal(groupOfOverlay('r2a-relief').id, 'relief');
  assert.equal(groupOfOverlay('gc-contours').id, 'contours');
  assert.equal(groupOfOverlay('wetlands').id, 'water');
  assert.equal(groupOfOverlay('parcels').id, 'land');
  assert.equal(groupOfOverlay('brand-new-layer').id, 'other');
  assert.equal(ALL_OVERLAY_GROUPS[0].id, 'lakes', 'Lakes is listed first');
  assert.equal(ALL_OVERLAY_GROUPS.at(-1).id, 'other');
  const total = [...byGroup.values()].reduce((n, ids) => n + ids.length, 0);
  assert.equal(total, 63);
});

test('search: every word must match name, id or group title; empty matches all', () => {
  const layer = {
    id: 'r1a-lake-depth',
    name: 'TWDB lake depth contours (R1A)',
  };
  assert.equal(overlayMatches(layer, 'Lakes', ''), true);
  assert.equal(overlayMatches(layer, 'Lakes', '  '), true);
  assert.equal(overlayMatches(layer, 'Lakes', 'LAKE'), true);
  assert.equal(overlayMatches(layer, 'Lakes', 'twdb r1a'), true);
  assert.equal(overlayMatches(layer, 'Lakes', 'twdb hillshade'), false);
  assert.equal(
    overlayMatches({ id: 'x', name: 'X' }, 'Lakes and bays', 'bays'),
    true,
    'group title counts',
  );
});

function groupedPanel(extra = {}) {
  const calls = [];
  const layers = LIVE_OVERLAY_LAYERS.map(([id, name]) => ({
    id,
    name,
    enabled: false,
    opacity: 0.8,
  }));
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers },
    grouped: true,
    embedded: true,
    onEnabled: (id, on) => calls.push(['on', id, on]),
    onOpacity: (id, v) => calls.push(['op', id, v]),
    onMove: (id, d) => calls.push(['move', id, d]),
    ...extra,
  });
  const group = (id) =>
    panel.element.find((n) => n.attrs['data-group'] === id)[0];
  const visibleRows = (g) =>
    group(g)
      .find((n) => n.attrs['data-overlay'] && !n.hidden)
      .map((n) => n.attrs['data-overlay']);
  return { panel, calls, layers, group, visibleRows };
}

test('groups: layers added to the live manifest after 2026-11-03 (historic topo sheets, RRC / TCEQ / TxDOT data) are grouped, not dumped in Other', () => {
  for (const id of [
    'htmc-24k-1958',
    'htmc-100k-1985',
    'htmc-250k-1953',
    'htmc-62k-1959',
  ]) {
    assert.equal(groupOfOverlay(id).id, 'topo', id);
  }
  for (const id of [
    'land-surveys-rrc',
    'rrc-oil-gas',
    'tceq-sites',
    'txdot-transport',
  ]) {
    assert.equal(groupOfOverlay(id).id, 'land', id);
  }
});

test('grouped panel: Lakes open first, other groups collapsed, 63 rows, search box', () => {
  const { panel, group, visibleRows } = groupedPanel();
  assert.equal(panel.element.find((n) => n.attrs['data-overlay']).length, 63);
  assert.equal(panel.element.find((n) => n.attrs.type === 'search').length, 1);
  const order = panel.element
    .find((n) => n.attrs['data-group'])
    .map((n) => n.attrs['data-group']);
  assert.deepEqual(order, [
    'lakes',
    'byrd-ranch',
    'topo',
    'hillshade',
    'relief',
    'contours',
    'water',
    'land',
    'other',
  ]);
  assert.equal(
    group('lakes').find(
      (n) => n.tag === 'div' && /gev-ov-group-body/.test(n.className),
    )[0].hidden,
    false,
  );
  assert.equal(
    group('topo').find((n) => /gev-ov-group-body/.test(n.className))[0].hidden,
    true,
  );
  assert.equal(
    group('lakes').find((n) => /gev-ov-group-head/.test(n.className))[0].attrs[
      'aria-expanded'
    ],
    'true',
  );
  assert.equal(
    group('topo').find((n) => /gev-ov-group-head/.test(n.className))[0].attrs[
      'aria-expanded'
    ],
    'false',
  );
  assert.equal(group('other').hidden, true, 'an empty group is not listed');
  assert.equal(visibleRows('lakes').length, 7);
  assert.equal(
    group('lakes').find((n) => /gev-ov-group-count/.test(n.className))[0]
      .textContent,
    '7',
  );
});

test('grouped panel: group heads open and close; toggles, opacity and raise/lower still call back', () => {
  const { panel, calls, group } = groupedPanel();
  const head = (g) =>
    group(g).find((n) => /gev-ov-group-head/.test(n.className))[0];
  const body = (g) =>
    group(g).find((n) => /gev-ov-group-body/.test(n.className))[0];
  head('topo').listeners.click();
  assert.equal(body('topo').hidden, false);
  assert.equal(head('topo').attrs['aria-expanded'], 'true');
  head('topo').listeners.click();
  assert.equal(body('topo').hidden, true);
  const lake = panel.element.find(
    (n) => n.attrs['data-overlay'] === 'lake-depth',
  )[0];
  const box = lake.find((n) => n.attrs.type === 'checkbox')[0];
  box.checked = true;
  box.listeners.change();
  const range = lake.find((n) => n.attrs.type === 'range')[0];
  range.value = '40';
  range.listeners.input();
  lake.find((n) => n.attrs['data-move'] === 'up')[0].listeners.click();
  assert.deepEqual(calls, [
    ['on', 'lake-depth', true],
    ['op', 'lake-depth', 0.4],
    ['move', 'lake-depth', 'up'],
  ]);
});

test('grouped panel: a group-head click during a search changes nothing, and the badge counts the shown rows', () => {
  const { panel, layers, group, visibleRows } = groupedPanel();
  const input = panel.element.find((n) => n.attrs.type === 'search')[0];
  const head = (g) =>
    group(g).find((n) => /gev-ov-group-head/.test(n.className))[0];
  const body = (g) =>
    group(g).find((n) => /gev-ov-group-body/.test(n.className))[0];
  const count = (g) =>
    group(g).find((n) => /gev-ov-group-count/.test(n.className))[0].textContent;
  const type = (v) => {
    input.value = v;
    input.listeners.input();
  };
  assert.equal(body('lakes').hidden, false, 'Lakes starts open');
  assert.equal(body('topo').hidden, true, 'Topo starts closed');
  type('lake');
  head('lakes').listeners.click();
  assert.equal(body('lakes').hidden, false, 'still open while searching');
  type('');
  assert.equal(
    body('lakes').hidden,
    false,
    'the click during the search did not close Lakes',
  );
  assert.equal(body('topo').hidden, true, 'Topo is still closed');
  // Badge: turn one lake layer on, then search for a different lake layer.
  panel.update({
    layers: layers.map((l) => ({ ...l, enabled: l.id === 'lake-depth' })),
  });
  assert.equal(count('lakes'), `1/${visibleRows('lakes').length}`);
  type('(gc)');
  assert.equal(
    count('lakes'),
    `${visibleRows('lakes').length}`,
    'the enabled lake-depth row is hidden by the search, so it is not counted',
  );
});

test('grouped panel: search filters rows, opens matching groups, shows a note when nothing matches', () => {
  const { panel, group, visibleRows } = groupedPanel();
  const input = panel.element.find((n) => n.attrs.type === 'search')[0];
  const empty = panel.element.find((n) => /gev-ov-empty/.test(n.className))[0];
  const type = (v) => {
    input.value = v;
    input.listeners.input();
  };
  type('lake');
  assert.equal(visibleRows('lakes').length, 7);
  assert.equal(group('topo').hidden, true, 'no lake in Topo');
  assert.equal(empty.hidden, true);
  type('hillshade 1 m lidar');
  assert.ok(visibleRows('hillshade').length >= 7);
  assert.equal(group('lakes').hidden, true);
  assert.equal(
    group('hillshade').find((n) => /gev-ov-group-body/.test(n.className))[0]
      .hidden,
    false,
    'a matching group opens while searching',
  );
  type('r1a');
  assert.ok(visibleRows('lakes').includes('r1a-lake-depth'));
  assert.equal(visibleRows('lakes').length, 1);
  type('zzz-no-such-layer');
  assert.equal(empty.hidden, false);
  type('');
  assert.equal(empty.hidden, true);
  assert.equal(visibleRows('lakes').length, 7);
  assert.equal(
    group('topo').find((n) => /gev-ov-group-body/.test(n.className))[0].hidden,
    true,
    'back to the collapsed default',
  );
});

test('grouped panel: counts show enabled layers; rows reorder inside their group', () => {
  const { panel, layers, group, visibleRows } = groupedPanel();
  const next = layers.map((l) =>
    l.id === 'lake-depth' ? { ...l, enabled: true } : l,
  );
  panel.update({ layers: next });
  assert.equal(
    group('lakes').find((n) => /gev-ov-group-count/.test(n.className))[0]
      .textContent,
    '1/7',
  );
  // lift r1b-lake-depth to the top of the whole stack: it leads its group
  const reordered = [
    next.find((l) => l.id === 'r1b-lake-depth'),
    ...next.filter((l) => l.id !== 'r1b-lake-depth'),
  ];
  panel.update({ layers: reordered });
  // the fake DOM append does not move a node, so read the tail like the flat test
  assert.equal(visibleRows('lakes').slice(-7)[0], 'r1b-lake-depth');
  assert.equal(
    panel.element
      .find((n) => n.attrs['data-overlay'] === 'r1b-lake-depth')[0]
      .find((n) => n.attrs['data-move'] === 'up')[0].disabled,
    true,
  );
});

test('grouped panel: the aerial shortcut appears only when given and calls back', () => {
  assert.equal(
    groupedPanel().panel.element.find((n) => /gev-ov-aerial/.test(n.className))
      .length,
    0,
  );
  let opened = 0;
  const { panel } = groupedPanel({
    onOpenAerial: () => {
      opened += 1;
    },
  });
  const [btn] = panel.element.find((n) => /gev-ov-aerial/.test(n.className));
  btn.listeners.click();
  assert.equal(opened, 1);
});

test('vector: a real gzipped TWDB lake-depth tile (z15 7678/13211) decodes and draws depth labels', async () => {
  const { readFileSync } = await import('node:fs');
  const { decodeMvt } = await import('./overlaysVector.js');
  const bytes = readFileSync(
    new URL(
      './fixtures/overlay-lake-depth-z15-7678-13211.mvt.gz',
      import.meta.url,
    ),
  );
  const tile = await decodeMvt(bytes);
  assert.deepEqual(Object.keys(tile.layers).sort(), [
    'bathy_contours',
    'bathy_major',
    'lake_pool',
  ]);
  const ctx = fakeCtx();
  const drawn = drawVectorTile(ctx, tile);
  assert.ok(drawn.features > 50);
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(
    texts.length >= 1 && texts.every((x) => /^\d+ ft$/.test(x)),
    texts.join(),
  );
});
