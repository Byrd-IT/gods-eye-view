import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerOpacity } from './index.js';

const empty = { length: 0, get() {} };
const viewer = { scene: { primitives: empty, groundPrimitives: empty, requestRender() {} }, dataSources: empty, imageryLayers: empty };
const dm = () => ({ layers: new Map([['wind', { module: {} }], ['recent-imagery', { module: {} }], ['flights', { module: {} }]]) });
function loc(href) {
  const l = { href };
  const h = { state: null, replaceState(_s, _t, next) { l.href = next; } };
  return [l, h];
}

test('restores ?lop and ignores layers with their own control or unknown ids', () => {
  const [l, h] = loc('https://x.test/?lop=wind:40,recent-imagery:10,ghost:5');
  const o = createLayerOpacity({ viewer, dataManager: dm(), locationRef: l, historyRef: h });
  assert.equal(o.model.get('wind'), 0.4);
  assert.equal(o.model.get('recent-imagery'), 1);
  assert.deepEqual(o.ids.sort(), ['flights', 'wind']);
  o.destroy();
});
test('changes are written to the address and reset removes the param', () => {
  const [l, h] = loc('https://x.test/?ht=5#v=2');
  const o = createLayerOpacity({ viewer, dataManager: dm(), locationRef: l, historyRef: h });
  o.model.set('flights', 0.5);
  assert.equal(l.href, 'https://x.test/?ht=5&lop=flights:50#v=2');
  o.model.reset();
  assert.equal(l.href, 'https://x.test/?ht=5#v=2');
  o.destroy();
});
test('a default view never rewrites the address', () => {
  const [l, h] = loc('https://x.test/?a=1');
  let calls = 0; h.replaceState = () => calls++;
  const o = createLayerOpacity({ viewer, dataManager: dm(), locationRef: l, historyRef: h });
  assert.equal(calls, 0);
  o.destroy();
});
