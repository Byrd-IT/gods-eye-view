// Dedicated UI tests for phone mode on the ODM 3D overlay rows (no deploy
// path here: odm3d.js itself is tested by odm3d*.test.mjs). Phone mode is one
// switch for every 3D build: device detection picks the start value, the
// user's chip overrides it, it reaches a layer BEFORE its tileset is created,
// and both directions re-apply to live models at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOverlays } from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { OVERLAYS_PUBLISH } from './fixtures/overlays.mjs';
import { attachOverlays } from './overlays.js';
import { createOverlaysPanel } from './overlaysPanel.js';
import { DEFAULT_LOCALE } from '../../i18n/locale.js';
import { setLocale } from '../../i18n/index.js';
import { BYRDIT_OPEN_STACK_ID } from './stack.js';

const THREE_D = {
  id: 'odm-3d-9be42b4f',
  name: 'Byrd Ranch shop area 3D (2026-10-31)',
  kind: 'overlay-3d',
  format: '3dtiles',
  archive: 'odm3d/odm-3d-9be42b4f',
  bounds: [-95.1545, 32.6896, -95.1511, 32.6918],
  ground_m: 112,
  height_offset_m: 0,
  canopy_default_ft: 90,
  canopy_options_ft: [90, 120],
  default_opacity: 1,
  status: 'live-data',
  credit: 'Byrd-IT ODM drone survey',
  sha256: 'cd'.repeat(32),
  file: 'hires/odm3d/odm-3d-9be42b4f/tileset.json',
};
const raster = OVERLAYS_PUBLISH.layers[0];

const OVERLAYS = normalizeOverlays(
  composeOverlays({
    ...OVERLAYS_PUBLISH,
    layers: [raster, THREE_D],
  }).browser,
);

/** A fake Odm3dLayer: just enough for syncModel + the phone-mode contract. */
function fakeModel(entry) {
  const calls = [];
  const model = {
    entry,
    calls,
    status: 'idle',
    alignedM: 0,
    load: async () => {
      model.status = 'ready';
    },
    setOpacity() {},
    setCut() {},
    setPhoneMode(on) {
      // Like the real layer: no-op (and no cache churn) when unchanged.
      if (model.phoneMode === Boolean(on)) return;
      model.phoneMode = Boolean(on);
      calls.push(model.phoneMode);
    },
    destroy() {},
  };
  return model;
}

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
  class ImageryLayer {
    constructor(imageryProvider, { show = true, alpha = 1 } = {}) {
      Object.assign(this, { imageryProvider, show, alpha });
    }
  }
  class Credit {
    constructor(html) {
      this.html = html;
    }
  }
  return { ImageryLayer, Credit, Rectangle: { fromDegrees: () => ({}) } };
}

function setup({ createdPhone } = {}) {
  const models = [];
  const viewer = {
    imageryLayers: {
      items: [],
      add(l) {
        this.items.push(l);
      },
      remove(l) {
        const i = this.items.indexOf(l);
        if (i >= 0) this.items.splice(i, 1);
      },
      indexOf(l) {
        return this.items.indexOf(l);
      },
      raiseToTop(l) {
        this.items.splice(this.items.indexOf(l), 1);
        this.items.push(l);
      },
    },
    container: null,
    camera: { moveEnd: event() },
    scene: {
      frameState: {
        creditDisplay: {
          shown: new Set(),
          addStaticCredit() {},
          removeStaticCredit() {},
        },
      },
      preUpdate: event(),
      requestRender() {},
    },
  };
  const active = { id: BYRDIT_OPEN_STACK_ID };
  const detach = attachOverlays({
    Cesium: fakeCesium(),
    viewer,
    controller: {
      getActiveId: () => active.id,
      subscribe: () => () => {},
    },
    overlays: OVERLAYS,
    session: { tileset: null },
    createProvider: () => ({}),
    // Phone mode starts from device detection unless the test pins it.
    create3d: (entry) => {
      const model = fakeModel(entry);
      if (createdPhone !== undefined) model.setPhoneMode(createdPhone);
      models.push(model);
      return model;
    },
  });
  const row3d = () => detach.state().layers.find((l) => l.id === THREE_D.id);
  return { detach, models, row3d, viewer };
}

test('attachOverlays: enabling a 3D build applies phone mode BEFORE the tileset is created', async () => {
  const { detach, models, row3d } = setup();
  assert.equal(row3d().phoneMode, false, 'off on non-phone test run');
  detach.setEnabled(THREE_D.id, true);
  assert.equal(models.length, 1);
  // The chip's state landed on the model before load() even started.
  assert.deepEqual(models[0].calls, [false]);
  await models[0]._loading?.catch?.(() => {});
  assert.equal(row3d().phoneMode, false);
});

test('attachOverlays: setPhoneMode reaches live models both ways and shapes later builds', async () => {
  const { detach, models, row3d } = setup();
  detach.setEnabled(THREE_D.id, true);
  await Promise.resolve();
  assert.equal(detach.setPhoneMode(true), true);
  assert.deepEqual(models[0].calls, [false, true], 'turned ON on the fly');
  assert.equal(row3d().phoneMode, true);
  // Take the layer away and rebuild: the new model opens with the new value.
  detach.setEnabled(THREE_D.id, false);
  detach.setEnabled(THREE_D.id, true);
  assert.equal(models.length, 2);
  assert.deepEqual(
    models[1].calls,
    [true],
    'a rebuilt layer starts in phone mode',
  );
  assert.equal(detach.setPhoneMode(false), true);
  assert.deepEqual(models[1].calls, [true, false], 'turned OFF again');
  assert.equal(row3d().phoneMode, false);
});

test('attachOverlays: setPhoneMode answers false when there is no 3D layer', () => {
  const overlays = normalizeOverlays(
    composeOverlays({ ...OVERLAYS_PUBLISH, layers: [raster] }).browser,
  );
  const viewer = {
    imageryLayers: {
      items: [],
      add() {},
      remove() {},
      indexOf() {
        return -1;
      },
      raiseToTop() {},
    },
    container: null,
    camera: { moveEnd: event() },
    scene: {
      frameState: { creditDisplay: { shown: new Set() } },
      preUpdate: event(),
      requestRender() {},
    },
  };
  const detach = attachOverlays({
    Cesium: fakeCesium(),
    viewer,
    controller: {
      getActiveId: () => BYRDIT_OPEN_STACK_ID,
      subscribe: () => () => {},
    },
    overlays,
    session: { tileset: null },
    createProvider: () => ({}),
  });
  assert.equal(detach.setPhoneMode(true), false);
  assert.equal(detach.setPhoneMode(false), false);
});

// ---------------------------------------------------------------- panel UI

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
  get ownerDocument() {
    return fakeDoc();
  }
  insertBefore(n, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, n);
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
  return {
    createElement: (tag) => {
      const node = new Node(tag);
      if (tag === 'button') node.type = 'button';
      return node;
    },
  };
}

const stateThreeD = (phoneMode) =>
  stackRow({
    id: THREE_D.id,
    name: THREE_D.name,
    kind: '3d',
    enabled: true,
    opacity: 1,
    canopyFt: 90,
    canopyOptionsFt: [60, 90, 120],
    phoneMode,
    status: 'ready',
    alignedM: 0,
  });
function stackRow(layer = null) {
  return { layers: layer ? [rasterRow(), layer] : [rasterRow()] };
}
function rasterRow() {
  return {
    id: raster.id,
    name: raster.name,
    kind: 'raster',
    enabled: false,
    opacity: 1,
  };
}

test('panel: the 3D row shows the phone mode toggle and note; toggling flips it', () => {
  const phoneCalls = [];
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [{ ...stateThreeD(true).layers[1] }] },
    onEnabled() {},
    onOpacity() {},
    onPhone: (id, on) => phoneCalls.push([id, on]),
  });
  const phoneButton = panel.element.find((n) =>
    /gev-ov-phone/.test(n.className),
  )[0];
  assert.ok(phoneButton, 'phone toggle on the 3D row');
  assert.equal(phoneButton.getAttribute('aria-pressed'), 'true');
  assert.equal(phoneButton.textContent, 'Phone mode');
  assert.match(
    phoneButton.getAttribute('title'),
    /softer model to save memory/,
  );
  const note = panel.element.find((n) => /gev-ov-3d-note/.test(n.className))[0];
  assert.match(note.textContent, /Phone mode: softer model to save memory/);

  // The toggle flips by itself: pressed -> click asks to switch off.
  phoneButton.listeners.click();
  assert.deepEqual(phoneCalls, [[THREE_D.id, false]], 'off when active');

  // After the state flips, the note goes quiet and the button un-presses.
  panel.update({
    layers: [{ ...stateThreeD(false).layers[1] }],
  });
  assert.equal(phoneButton.getAttribute('aria-pressed'), 'false');
  assert.equal(note.textContent, '');
  phoneButton.listeners.click();
  assert.deepEqual(phoneCalls, [
    [THREE_D.id, false],
    [THREE_D.id, true],
  ]);
});

test('panel: a stale chip click still reads the latest phone mode of the row', () => {
  const phoneCalls = [];
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [{ ...stateThreeD(false).layers[1] }] },
    onEnabled() {},
    onOpacity() {},
    onPhone: (id, on) => phoneCalls.push([id, on]),
  });
  const button = panel.element.find((n) => /gev-ov-phone/.test(n.className))[0];
  button.listeners.click();
  assert.deepEqual(phoneCalls, [[THREE_D.id, true]], 'off -> on from the chip');
  // The user toggles from elsewhere (device change); the chip then reports on.
  panel.update({ layers: [{ ...stateThreeD(true).layers[1] }] });
  button.listeners.click();
  assert.deepEqual(phoneCalls, [
    [THREE_D.id, true],
    [THREE_D.id, false],
  ]);
});

test('panel: phone mode is one global control for multiple models', () => {
  const first = stateThreeD(true).layers[1];
  const second = { ...first, id: 'second-model', name: 'Second model' };
  const calls = [];
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [first, second] },
    onEnabled() {},
    onOpacity() {},
    onPhone: (id, on) => calls.push([id, on]),
  });
  const buttons = panel.element.find((n) => /gev-ov-phone/.test(n.className));
  assert.equal(buttons.length, 1);
  buttons[0].listeners.click();
  assert.deepEqual(calls, [[first.id, false]]);
  assert.match(buttons[0].className, /active/);
});

test('panel: a flat overlay row has no phone toggle and no load/phone note', () => {
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: stackRow(),
    onEnabled() {},
    onOpacity() {},
  });
  assert.equal(
    panel.element.find((n) => /gev-ov-phone/.test(n.className)).length,
    0,
  );
  assert.equal(
    panel.element.find((n) => /gev-ov-3d-note/.test(n.className)).length,
    0,
  );
});

test('panel: missing phone copy has a specific safe message', () => {
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: {
      layers: [
        {
          ...stateThreeD(true).layers[1],
          status: 'failed',
          phoneVariantMissing: true,
        },
      ],
    },
    onEnabled() {},
    onOpacity() {},
  });
  const note = panel.element.find((n) => /gev-ov-3d-note/.test(n.className))[0];
  assert.match(
    note.textContent,
    /^Phone mode: The 3D model could not be loaded$/,
  );
});

test('panel: the loading note wins over the phone note until the model settles', () => {
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: {
      layers: [{ ...stateThreeD(true).layers[1], status: 'loading' }],
    },
    onEnabled() {},
    onOpacity() {},
  });
  const note = panel.element.find((n) => /gev-ov-3d-note/.test(n.className))[0];
  assert.match(note.textContent, /Loading/);
});

// -------------------------------------------------- paused / stalled / gate

function viewerPreUpdate(viewer) {
  viewer.scene.preUpdate.raise();
}

test('attachOverlays: a 3D row carries the model pressure state (paused, stalled, gate error)', async () => {
  const { detach, models, row3d, viewer } = setup();
  detach.setEnabled(THREE_D.id, true);
  await models[0]._loading?.catch?.(() => {});
  assert.equal(row3d().pressurePaused, false);
  assert.equal(row3d().pressureStalled, false);
  assert.equal(row3d().gateError, null);
  // The layer's own pump tick flips its pressure state; the panel must show
  // it after the next preUpdate without any other change.
  models[0].pressurePaused = true;
  models[0].pressureStalled = true;
  viewerPreUpdate(viewer);
  assert.equal(row3d().pressureStalled, true, 'stall surfaced dynamically');
  models[0].gateError = 'The 3D request gate could not be created';
  models[0].pressurePaused = false;
  models[0].pressureStalled = false;
  viewerPreUpdate(viewer);
  assert.match(row3d().gateError, /gate could not be created/);
  models[0].error = 'Phone 3D variant unavailable';
  viewerPreUpdate(viewer);
  assert.equal(row3d().phoneVariantMissing, true);
  models[0].error = 'untrusted upstream detail';
  viewerPreUpdate(viewer);
  assert.equal(row3d().phoneVariantMissing, false);
});

test('panel: the note names paused and stalled pressure and gate failures, translated at update', async () => {
  const mk = (extra) => ({ ...stateThreeD(true).layers[1], ...extra });
  const panel = createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [mk({ pressurePaused: true, pressureStalled: false })] },
    onEnabled() {},
    onOpacity() {},
  });
  const note = () =>
    panel.element.find((n) => /gev-ov-3d-note/.test(n.className))[0];
  assert.match(note().textContent, /Paused under memory pressure/i);

  // A stalled pause says so distinctly; the panel re-renders from the state.
  panel.update({
    layers: [mk({ pressurePaused: true, pressureStalled: true })],
  });
  assert.match(note().textContent, /Stalled/i);
  panel.update({ layers: [mk({ status: 'failed', gateError: 'gate boom' })] });
  assert.match(note().textContent, /gate/i);
  panel.update({
    layers: [mk({ status: 'failed', gateError: null })],
  });
  assert.match(note().textContent, /could not be loaded/);
  panel.update({ layers: [stateThreeD(false).layers[1]] });
  assert.equal(note().textContent, '');

  // Translation happens NOW (at update), not at module import: importing
  // while English, then switching, the same update path re-translates.
  setLocale('ru');
  panel.update({ layers: [mk({ pressurePaused: true })] });
  const ru = note().textContent;
  setLocale(DEFAULT_LOCALE);
  panel.update({ layers: [mk({ pressurePaused: true })] });
  const en = note().textContent;
  assert.notEqual(ru, en, 'locale switch re-translates at update time');
  assert.match(en, /Paused under memory pressure/i);
  assert.notEqual(ru, '', 'ru catalog carries the paused note');
});
