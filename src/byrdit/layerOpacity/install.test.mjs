import test from 'node:test';
import assert from 'node:assert/strict';
import { installLayerOpacity } from './install.js';
import { createOpacityModel } from './opacityModel.js';

class Color {
  constructor(r, g, b, a) { Object.assign(this, { red: r, green: g, blue: b, alpha: a }); }
  clone() { return new Color(this.red, this.green, this.blue, this.alpha); }
}
class BillboardCollection {
  constructor() { this.items = []; }
  get length() { return this.items.length; }
  get(i) { return this.items[i]; }
  add() { const it = { color: new Color(1, 1, 1, 1) }; this.items.push(it); return it; }
}
class List {
  constructor() { this.items = []; }
  get length() { return this.items.length; }
  get(i) { return this.items[i]; }
}
function world() {
  const viewer = {
    scene: { primitives: new List(), groundPrimitives: new List(), requestRender() { this.n = (this.n || 0) + 1; } },
    dataSources: new List(),
    imageryLayers: new List(),
  };
  const layers = new Map();
  const dataManager = { layers };
  const add = (id, module) => layers.set(id, { module });
  return { viewer, dataManager, add };
}

test('objects added during enable are owned and follow the slider', async () => {
  const w = world();
  let col;
  w.add('a', { enable: async (v) => { col = new BillboardCollection(); col.add(); v.scene.primitives.items.push(col); } });
  w.add('b', { enable: async () => {} });
  const model = createOpacityModel({ ids: ['a', 'b'] });
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  await w.dataManager.layers.get('a').module.enable(w.viewer);
  assert.equal(h.ownedCount('a'), 1);
  assert.equal(h.ownedCount('b'), 0);
  assert.equal(col.items[0].color.alpha, 1);
  model.set('a', 0.4);
  assert.equal(col.items[0].color.alpha, 0.4);
  model.set('b', 0.1);
  assert.equal(col.items[0].color.alpha, 0.4);
  model.set('a', 1);
  assert.equal(col.items[0].color.alpha, 1);
  h.destroy();
});
test('items added in a later update take the current opacity', async () => {
  const w = world();
  const col = new BillboardCollection();
  w.add('a', {
    enable: async (v) => { v.scene.primitives.items.push(col); },
    update: async () => { col.add(); },
  });
  const model = createOpacityModel();
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  const m = w.dataManager.layers.get('a').module;
  await m.enable(w.viewer);
  model.set('a', 0.5);
  await m.update(w.viewer);
  assert.equal(col.items[0].color.alpha, 0.5);
  h.destroy();
});
test('layer with setOpacity hook uses it, not the generic writer', async () => {
  const w = world();
  const seen = [];
  w.add('s', { setOpacity: (v) => seen.push(v), update: async () => {} });
  const model = createOpacityModel();
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  model.set('s', 0.25);
  model.set('s', 1);
  assert.deepEqual(seen, [0.25, 1]);
  h.destroy();
});
test('overlapping calls credit every layer in flight', async () => {
  const w = world();
  let release;
  const gate = new Promise((r) => (release = r));
  const col = new BillboardCollection();
  w.add('slow', { enable: async (v) => { await gate; v.scene.primitives.items.push(col); } });
  w.add('fast', { enable: async () => {} });
  const model = createOpacityModel();
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  const slow = w.dataManager.layers.get('slow').module.enable(w.viewer);
  await w.dataManager.layers.get('fast').module.enable(w.viewer);
  release();
  await slow;
  assert.equal(h.ownedCount('slow'), 1);
  assert.equal(h.ownedCount('fast'), 1); // ambiguous: credited to both, documented
  h.destroy();
});
test('failed enable still propagates and destroy restores the methods', async () => {
  const w = world();
  const original = async () => { throw new Error('boom'); };
  const module = { enable: original };
  w.add('x', module);
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model: createOpacityModel() });
  assert.notEqual(module.enable, original);
  await assert.rejects(() => module.enable(w.viewer), /boom/);
  h.destroy();
  assert.equal(module.enable, original);
});
test('frozen module does not break install', () => {
  const w = world();
  w.add('f', Object.freeze({ update: async () => {} }));
  const warn = console.warn; console.warn = () => {};
  try {
    const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model: createOpacityModel() });
    h.destroy();
  } finally { console.warn = warn; }
});

test('a big data source is written in slices that never run long, and re-scans only on change', async () => {
  const w = world();
  const entities = Array.from({ length: 400 }, () => ({
    point: { color: { v: { red: 1, green: 0, blue: 0, alpha: 1, clone() { return { ...this, clone: this.clone }; } }, getValue() { return this.v; }, setValue(n) { this.v = n; } } },
  }));
  let suspended = 0;
  const ds = { entities: { values: entities, suspendEvents: () => suspended++, resumeEvents() {} } };
  w.add('big', { enable: async (v) => { v.dataSources.items.push(ds); } });
  w.viewer.dataSources.items = [];
  Object.defineProperty(w.viewer.dataSources, 'length', { get() { return this.items.length; } });
  w.viewer.dataSources.get = function (i) { return this.items[i]; };
  const model = createOpacityModel();
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  await w.dataManager.layers.get('big').module.enable(w.viewer);
  model.set('big', 0.5);
  assert.equal(entities[0].point.color.v.alpha, 1, 'nothing synchronous for entities');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(entities.every((e) => e.point.color.v.alpha === 0.5));
  assert.ok(suspended >= 1);
  const before = suspended;
  h.reapply('big'); // forced
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(suspended > before);
  h.destroy();
});

test('synthetic-secret probe: a failing hook or frozen module never puts the error text in the log', () => {
  const nonce = Math.random().toString(36).slice(2, 10);
  const secrets = [
    `Bearer tok_${nonce}_ABC123`,
    `https://user:pw${nonce}@host.example/x`,
    `key_${nonce}_SUFFIX99`,
    `?api_key=k${nonce}`,
  ];
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    const w = world();
    w.add('s', { setOpacity() { throw new Error(secrets.join(' ')); }, update: async () => {} });
    const frozen = Object.freeze({ update: async () => {} });
    w.add('f', frozen);
    const model = createOpacityModel();
    const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
    model.set('s', 0.5);
    h.destroy();
  } finally {
    console.warn = warn;
  }
  assert.ok(lines.length >= 2, 'both failure paths ran');
  const text = lines.join('\n');
  for (const secret of secrets) {
    for (const form of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), secret.slice(-6), secret.slice(0, 8)])
      assert.ok(!text.includes(form), `leaked ${form.length} chars`);
  }
});
