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
  add(x) { this.items.push(x); return x; }
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
test('overlapping calls: a layer left at 100% is never dimmed by another layer slider', async () => {
  const w = world();
  let release;
  const gate = new Promise((r) => (release = r));
  const colB = new BillboardCollection();
  colB.add();
  w.add('a', { enable: async () => { await gate; } });
  w.add('b', { enable: async (v) => { v.scene.primitives.items.push(colB); } });
  const model = createOpacityModel({ ids: ['a', 'b'] });
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  const slowA = w.dataManager.layers.get('a').module.enable(w.viewer);
  await w.dataManager.layers.get('b').module.enable(w.viewer); // B's object appears while A is in flight
  release();
  await slowA;
  assert.equal(h.ownedCount('b'), 1);
  model.set('a', 0.5);
  await new Promise((r) => setTimeout(r, 1100)); // 1 s tick re-applies A
  assert.equal(colB.items[0].color.alpha, 1, 'B stays at 100%');
  model.set('b', 0.3);
  assert.equal(colB.items[0].color.alpha, 0.5, 'ambiguous object: highest candidate (A=0.5, B=0.3)');
  model.set('a', 0.2);
  assert.equal(colB.items[0].color.alpha, 0.3, 'no flicker: both owners write the same value');
  model.set('a', 1);
  model.set('b', 1);
  assert.equal(colB.items[0].color.alpha, 1);
  h.destroy();
});
test('replacing entities while keeping the same count is re-scanned after the call', async () => {
  const w = world();
  const mk = () => ({ point: { color: { v: new Color(1, 0, 0, 1), getValue() { return this.v; }, setValue(n) { this.v = n; } } } });
  const store = { values: [mk(), mk()], suspendEvents() {}, resumeEvents() {} };
  const ds = { entities: store };
  w.add('e', {
    enable: async (v) => { v.dataSources.items.push(ds); },
    update: async () => { store.values = [mk(), mk()]; },
  });
  const model = createOpacityModel();
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  await w.dataManager.layers.get('e').module.enable(w.viewer);
  model.set('e', 0.5);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(store.values.every((e) => e.point.color.v.alpha === 0.5));
  await w.dataManager.layers.get('e').module.update(w.viewer);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(store.values.every((e) => e.point.color.v.alpha === 0.5), 'fresh entities dimmed');
  h.destroy();
});
test('a collectionChanged event marks a source for re-scan on the next tick', async () => {
  const w = world();
  const mk = () => ({ point: { color: { v: new Color(1, 0, 0, 1), getValue() { return this.v; }, setValue(n) { this.v = n; } } } });
  let fire;
  const store = {
    values: [mk()], suspendEvents() {}, resumeEvents() {},
    collectionChanged: { addEventListener(f) { fire = f; return () => {}; } },
  };
  w.add('e', { enable: async (v) => { v.dataSources.items.push({ entities: store }); } });
  const model = createOpacityModel();
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model });
  await w.dataManager.layers.get('e').module.enable(w.viewer);
  model.set('e', 0.5);
  await new Promise((r) => setTimeout(r, 60));
  store.values = [mk(), mk()];
  fire();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(store.values.every((e) => e.point.color.v.alpha === 0.5));
  h.destroy();
});
test('add() attribution: after a directory is learned, an overlapped add goes to its own layer only', async () => {
  const w = world();
  let key = null;
  const mkCol = () => { const c = new BillboardCollection(); c.add(); return c; };
  const colA = mkCol(), colA2 = mkCol(), colB = mkCol(), colB0 = mkCol();
  let release;
  const gate = new Promise((r) => (release = r));
  let aRun = 0;
  w.add('a', { enable: async (v) => {
    key = 'layers/a';
    v.scene.primitives.add(aRun++ === 0 ? colA : colA2);
    if (aRun === 2) { release(); await new Promise((r) => setTimeout(r, 5)); }
  } });
  let bRuns = 0;
  w.add('b', { enable: async (v) => { if (bRuns++ > 0) await gate; key = 'layers/b'; v.scene.primitives.add(bRuns === 1 ? colB0 : colB); } });
  const model = createOpacityModel({ ids: ['a', 'b'] });
  const h = installLayerOpacity({ viewer: w.viewer, dataManager: w.dataManager, model, sourceKeyOf: () => key });
  const a = w.dataManager.layers.get('a').module;
  const b = w.dataManager.layers.get('b').module;
  await a.enable(w.viewer); // exclusive: learns layers/a -> a
  await b.enable(w.viewer); // exclusive: learns layers/b -> b
  const bRun = b.enable(w.viewer); // waits at the gate
  await a.enable(w.viewer); // overlaps b; its add is attributed to a alone
  await bRun; // b's add overlaps a's tail: its directory says b alone
  assert.equal(h.ownedCount('a'), 2);
  assert.equal(h.ownedCount('b'), 2);
  model.set('a', 0.5);
  assert.equal(colA.items[0].color.alpha, 0.5);
  assert.equal(colA2.items[0].color.alpha, 0.5, 'overlapped add credited to a only, so dimmed');
  assert.equal(colB.items[0].color.alpha, 1, 'b object never dimmed by a');
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
