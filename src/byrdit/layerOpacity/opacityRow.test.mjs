import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpacityRow } from './opacityRow.js';
import { createOpacityModel } from './opacityModel.js';

function el(tag) {
  const listeners = {};
  return {
    tag, dataset: {}, children: [], attrs: {}, className: '', textContent: '',
    value: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { this.children.push(...c); },
    addEventListener(t, f) { (listeners[t] ||= new Set()).add(f); },
    removeEventListener(t, f) { listeners[t]?.delete(f); },
    fire(t) { for (const f of [...(listeners[t] || [])]) f({}); },
    count: (t) => listeners[t]?.size || 0,
  };
}
const documentRef = { createElement: el };

test('row shows the model, writes on input, resets on double click', () => {
  const model = createOpacityModel({ ids: ['wind'] });
  const { element, dispose } = createOpacityRow({ documentRef, model, layerId: 'wind' });
  const [label, slider, readout] = element.children;
  assert.equal(label.textContent, 'Opacity');
  assert.equal(String(slider.value), '100');
  assert.equal(readout.textContent, '100%');
  assert.equal(slider.type, 'range');
  slider.value = '40';
  slider.fire('input');
  assert.equal(model.get('wind'), 0.4);
  assert.equal(readout.textContent, '40%');
  slider.fire('dblclick');
  assert.equal(model.get('wind'), 1);
  assert.equal(String(slider.value), '100');
  dispose();
  assert.equal(slider.count('input'), 0);
});
test('row follows changes made elsewhere (URL restore, other control)', () => {
  const model = createOpacityModel({ ids: ['a', 'b'] });
  const { element } = createOpacityRow({ documentRef, model, layerId: 'a', label: 'Alpha' });
  const [label, slider, readout] = element.children;
  assert.equal(label.textContent, 'Opacity: Alpha');
  model.set('a', 0.25);
  assert.equal(slider.value, '25');
  assert.equal(readout.textContent, '25%');
  model.set('b', 0.5);
  assert.equal(slider.value, '25');
});
