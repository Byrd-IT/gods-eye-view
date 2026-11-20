import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureMapLayersCard } from './mapLayersCard.js';
test('independent card users release only their own visibility claim', () => {
  const root = { hidden: true, classList: { contains: () => true } },
    body = {};
  const doc = {
    getElementById: (id) =>
      id === 'map-layers-panel'
        ? root
        : id === 'gev-map-layers-body'
          ? body
          : null,
  };
  const coverage = ensureMapLayersCard(doc),
    overlays = ensureMapLayersCard(doc);
  coverage.show();
  coverage.show();
  overlays.show();
  assert.equal(root.hidden, false);
  overlays.hide();
  overlays.hide();
  assert.equal(root.hidden, false);
  coverage.hide();
  assert.equal(root.hidden, true);
});
