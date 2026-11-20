import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOverlays, resolveOdm3dFile } from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';
import { createOverlaysPanel } from './overlaysPanel.js';

/**
 * Gaussian-splat 3D layers: the manifest's `splat` fact survives the proxy
 * and the browser validator, stays absent on ODM meshes, and the panel builds
 * no canopy or opacity controls for it.
 */

const SPLAT = {
  id: 'odm-3d-splat001',
  name: 'Byrd Ranch splat',
  kind: 'overlay-3d',
  format: '3dtiles',
  archive: 'odm3d/odm-3d-splat001',
  phone_archive: 'odm3d/odm-3d-splat001-phone',
  bounds: [-95.1545, 32.6896, -95.1511, 32.6918],
  ground_m: 112,
  status: 'live-data',
  splat: true,
};
const ODM = {
  ...SPLAT,
  id: 'odm-3d-9be42b4f',
  name: 'Byrd Ranch shop area 3D',
  archive: 'odm3d/odm-3d-9be42b4f',
  phone_archive: undefined,
  canopy_options_ft: [90, 120],
  canopy_default_ft: 90,
  splat: undefined,
};

test('composeOverlays: splat is true only when the manifest says so; ODM model keeps its exact shape', () => {
  const { browser } = composeOverlays({ layers: [SPLAT, ODM] });
  const splat = browser.layers.find((l) => l.id === SPLAT.id);
  const odm = browser.layers.find((l) => l.id === ODM.id);
  assert.equal(splat.model.splat, true);
  assert.equal(splat.model.groundM, 112);
  assert.deepEqual(odm.model, {
    groundM: 112,
    heightOffsetM: 0,
    canopyOptionsFt: [60, 90, 120],
    canopyDefaultFt: 90,
  });
  assert.equal('splat' in odm.model, false);
  // A manifest that nests the flag under model works too.
  const nested = composeOverlays({
    layers: [{ ...SPLAT, splat: undefined, model: { splat: true } }],
  }).browser.layers[0];
  assert.equal(nested.model.splat, true);
});

test('splat entries remain 3D routes with a phone variant', () => {
  const { browser, routes } = composeOverlays({ layers: [SPLAT] });
  const layer = browser.layers[0];
  assert.equal(layer.kind, '3d');
  assert.equal(layer.url, '/basemap/odm3d/odm-3d-splat001/tileset.json');
  assert.equal(
    layer.phoneUrl,
    '/basemap/odm3d/odm-3d-splat001-phone/tileset.json',
  );
  assert.equal(routes.get(SPLAT.id).format, '3dtiles');
  assert.deepEqual(
    resolveOdm3dFile(layer.phoneUrl, routes, {
      odm3dUrls: ['https://example.invalid'],
    }),
    {
      bases: ['https://example.invalid'],
      path: '/odm3d/odm-3d-splat001-phone/tileset.json',
    },
  );
});

test('splat still needs a usable ground height; a bad entry is dropped', () => {
  const { browser } = composeOverlays({
    layers: [
      { ...SPLAT, id: 'odm-3d-a', ground_m: 'x' },
      { ...SPLAT, id: 'odm-3d-b', ground_m: undefined },
      { ...SPLAT, id: 'odm-3d-c', format: 'webp' },
    ],
  });
  assert.deepEqual(browser, { available: false });
});

test('normalizeOverlays carries only a literal splat:true through the browser hop', () => {
  const served = composeOverlays({ layers: [SPLAT, ODM] }).browser;
  const back = normalizeOverlays(served);
  assert.equal(back.layers.find((l) => l.id === SPLAT.id).model.splat, true);
  assert.equal(
    'splat' in back.layers.find((l) => l.id === ODM.id).model,
    false,
  );
  for (const value of [false, 'true', 1, {}]) {
    const raw = structuredClone(served);
    raw.layers[0].model.splat = value;
    assert.equal(
      normalizeOverlays(raw).layers[0].model.splat,
      undefined,
      String(value),
    );
  }
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
  get ownerDocument() {
    return fakeDoc();
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
  insertBefore(n, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, n);
  }
  find(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
}
const fakeDoc = () => ({ createElement: (tag) => new Node(tag) });

const row3d = (overrides = {}) => ({
  id: SPLAT.id,
  name: SPLAT.name,
  kind: '3d',
  enabled: true,
  opacity: 1,
  canopyOptionsFt: [60, 90, 120],
  status: 'ready',
  phoneMode: false,
  ...overrides,
});

function panelFor(layer) {
  return createOverlaysPanel({
    container: new Node('div'),
    doc: fakeDoc(),
    state: { layers: [layer] },
    onEnabled() {},
    onOpacity() {},
    onCanopy() {},
    onPhone() {},
  });
}

const rowOf = (panel) => panel.element.find((n) => n.attrs['data-overlay'])[0];

test('panel: a splat row hides its opacity slider and canopy cut', () => {
  const panel = panelFor(row3d({ splat: true }));
  const row = rowOf(panel);
  assert.equal(row.attrs['data-splat'], 'true');
  const line = row.find((n) => /gev-ov-line/.test(n.className))[0];
  const range = row.find((n) => n.attrs.type === 'range')[0];
  assert.equal(line.hidden, true, 'opacity control hidden');
  assert.equal(range.hidden, true, 'opacity slider hidden');
  const cut = row.find((n) => /gev-ov-cut/.test(n.className))[0];
  assert.equal(cut.hidden, true, 'canopy control hidden');
  assert.equal(
    row.find((n) => n.attrs.type === 'checkbox').length,
    1,
    'still toggles',
  );
  assert.equal(
    row.find((n) => /gev-ov-3d-note/.test(n.className)).length,
    1,
    'still reports load/pressure state',
  );
  // The regular update path must not touch the controls it did not build.
  panel.update({ layers: [row3d({ splat: true, status: 'loading' })] });
  const note = row.find((n) => /gev-ov-3d-note/.test(n.className))[0];
  assert.match(note.textContent, /Loading/);
});

test('panel: a model.splat block also hides the controls; an ODM row keeps both', () => {
  const fromModel = rowOf(panelFor(row3d({ model: { splat: true } })));
  assert.equal(
    fromModel.find((n) => n.attrs.type === 'range')[0].hidden,
    true,
  );
  assert.equal(
    fromModel.find((n) => /gev-ov-cut/.test(n.className))[0].hidden,
    true,
  );

  const odm = rowOf(panelFor(row3d()));
  assert.notEqual(odm.find((n) => n.attrs.type === 'range')[0].hidden, true);
  assert.notEqual(
    odm.find((n) => /gev-ov-cut/.test(n.className))[0].hidden,
    true,
    'an ODM mesh keeps its canopy chips',
  );
  assert.equal('data-splat' in odm.attrs, false);

  const falseFlag = rowOf(panelFor(row3d({ splat: false })));
  assert.equal(falseFlag.find((n) => n.attrs.type === 'range').length, 1);
});
