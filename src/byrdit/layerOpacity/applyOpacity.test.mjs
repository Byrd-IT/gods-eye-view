import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyToPrimitive, applyToDataSource, applyToImagery, applyToOwned,
} from './applyOpacity.js';

class Color {
  constructor(r, g, b, a) { Object.assign(this, { red: r, green: g, blue: b, alpha: a }); }
  clone() { return new Color(this.red, this.green, this.blue, this.alpha); }
}
class BillboardCollection {
  constructor(items) { this.items = items; }
  get length() { return this.items.length; }
  get(i) { return this.items[i]; }
}
class PrimitiveCollection extends BillboardCollection {}
class PolylineCollection extends BillboardCollection {}
const bb = (a = 1) => {
  let c = new Color(1, 0.5, 0, a);
  return { get color() { return c; }, set color(v) { c = v.clone(); } };
};

test('billboards scale to 50% and restore exactly at 100%', () => {
  const items = [bb(1), bb(0.8)];
  const col = new BillboardCollection(items);
  assert.equal(applyToPrimitive(col, 0.5), 2);
  assert.equal(items[0].color.alpha, 0.5);
  assert.ok(Math.abs(items[1].color.alpha - 0.4) < 1e-9);
  assert.equal(items[0].color.red, 1);
  applyToPrimitive(col, 1);
  assert.equal(items[0].color.alpha, 1);
  assert.equal(items[1].color.alpha, 0.8);
});
test('re-applying the same opacity does not compound', () => {
  const item = bb(1);
  const col = new BillboardCollection([item]);
  applyToPrimitive(col, 0.5);
  applyToPrimitive(col, 0.5);
  applyToPrimitive(col, 0.5);
  assert.equal(item.color.alpha, 0.5);
  applyToPrimitive(col, 0.25);
  assert.equal(item.color.alpha, 0.25);
});
test("a colour the layer wrote itself becomes the new base", () => {
  const item = bb(1);
  const col = new BillboardCollection([item]);
  applyToPrimitive(col, 0.5);
  item.color = new Color(0, 1, 0, 1); // layer recolours
  applyToPrimitive(col, 0.5);
  assert.deepEqual([item.color.green, item.color.alpha], [1, 0.5]);
  applyToPrimitive(col, 1);
  assert.deepEqual([item.color.green, item.color.alpha], [1, 1]);
});
test('at 100% with no prior write nothing is touched', () => {
  let writes = 0;
  let c = new Color(1, 1, 1, 1);
  const item = { get color() { return c; }, set color(v) { writes++; c = v; } };
  applyToPrimitive(new BillboardCollection([item]), 1);
  assert.equal(writes, 0);
});
test('polyline material uniforms and nested collections', () => {
  const line = { material: { uniforms: { color: new Color(1, 0, 0, 1) } } };
  const nested = new PrimitiveCollection([new PolylineCollection([line])]);
  assert.equal(applyToPrimitive(nested, 0.3), 1);
  assert.equal(line.material.uniforms.color.alpha, 0.3);
  applyToPrimitive(nested, 1);
  assert.equal(line.material.uniforms.color.alpha, 1);
});
test('destroyed and unknown containers are ignored', () => {
  assert.equal(applyToPrimitive({ isDestroyed: () => true }, 0.5), 0);
  assert.equal(applyToPrimitive(null, 0.5), 0);
  assert.equal(applyToPrimitive({}, 0.5), 0);
});
const prop = (v) => ({ getValue: () => v, setValue: (n) => { v = n.clone(); } });
test('entity graphics with constant colours and material colours', () => {
  const entity = {
    point: { color: prop(new Color(1, 0, 0, 1)), outlineColor: prop(new Color(0, 0, 0, 1)) },
    polyline: { material: { color: prop(new Color(0, 0, 1, 1)) } },
    label: { fillColor: { getValue: () => { throw new Error('dynamic'); }, setValue() {} } },
  };
  const ds = { entities: { values: [entity] } };
  assert.equal(applyToDataSource(ds, 0.5), 1);
  assert.equal(entity.point.color.getValue().alpha, 0.5);
  assert.equal(entity.point.outlineColor.getValue().alpha, 0.5);
  assert.equal(entity.polyline.material.color.getValue().alpha, 0.5);
  applyToDataSource(ds, 1);
  assert.equal(entity.point.color.getValue().alpha, 1);
  assert.equal(applyToDataSource({}, 0.5), 0);
});
test('imagery alpha keeps the layer base and restores it', () => {
  const layer = { alpha: 0.8 };
  applyToImagery(layer, 0.5);
  assert.ok(Math.abs(layer.alpha - 0.4) < 1e-9);
  applyToImagery(layer, 0.5);
  assert.ok(Math.abs(layer.alpha - 0.4) < 1e-9);
  applyToImagery(layer, 1);
  assert.equal(layer.alpha, 0.8);
  const plain = { alpha: 1 };
  applyToImagery(plain, 1);
  assert.equal(plain.alpha, 1);
});
test('applyToOwned covers all three kinds', () => {
  const item = bb(1);
  const img = { alpha: 1 };
  const n = applyToOwned({ prims: [new BillboardCollection([item])], sources: [], imagery: [img] }, 0.5);
  assert.equal(n, 2);
  assert.equal(item.color.alpha, 0.5);
  assert.equal(img.alpha, 0.5);
});

class GroundPolylinePrimitive {
  constructor(color) { this.appearance = { material: { uniforms: { color } } }; }
}
test('material-appearance primitives scale uniforms; colour-attribute ones are left alone', () => {
  const p = new GroundPolylinePrimitive(new Color(1, 0, 0, 0.8));
  applyToPrimitive(p, 0.5);
  assert.ok(Math.abs(p.appearance.material.uniforms.color.alpha - 0.4) < 1e-9);
  applyToPrimitive(p, 1);
  assert.equal(p.appearance.material.uniforms.color.alpha, 0.8);
  class Primitive { constructor() { this.appearance = {}; } }
  assert.equal(applyToPrimitive(new Primitive(), 0.5), 0);
});

test('an imagery alpha the layer rewrites becomes the new base', () => {
  const layer = { alpha: 1 };
  applyToImagery(layer, 0.5);
  assert.equal(layer.alpha, 0.5);
  layer.alpha = 0.8; // layer fades itself
  applyToImagery(layer, 0.5);
  assert.ok(Math.abs(layer.alpha - 0.4) < 1e-9);
  applyToImagery(layer, 1);
  assert.equal(layer.alpha, 0.8);
});

test('data source changes are batched between suspendEvents and resumeEvents', () => {
  const log = [];
  const entity = { point: { color: prop(new Color(1, 0, 0, 1)) } };
  const ds = { entities: { values: [entity], suspendEvents: () => log.push('s'), resumeEvents: () => log.push('r') } };
  applyToDataSource(ds, 0.5);
  assert.deepEqual(log, ['s', 'r']);
});
