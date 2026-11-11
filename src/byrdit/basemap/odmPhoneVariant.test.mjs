import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOverlays, resolveOdm3dFile } from './overlaysProxy.js';
import { normalizeOverlays } from './overlaysConfig.js';

const model = {
  id: 'odm-3d-9be42b4f',
  name: 'Shop',
  kind: 'overlay-3d',
  format: '3dtiles',
  archive: 'odm3d/odm-3d-9be42b4f',
  phone_archive: 'odm3d/odm-3d-9be42b4f-phone',
  bounds: [-95.1545, 32.6896, -95.1511, 32.6918],
  ground_m: 112,
  status: 'live-data',
};
test('a phone archive is routed separately but keeps a single layer row', () => {
  const c = composeOverlays({ layers: [model] });
  assert.equal(c.browser.layers.length, 1);
  const phoneUrl = '/basemap/odm3d/odm-3d-9be42b4f-phone/tileset.json';
  assert.equal(c.browser.layers[0].phoneUrl, phoneUrl);
  assert.equal(normalizeOverlays(c.browser).layers[0].phoneUrl, phoneUrl);
  assert.deepEqual(
    resolveOdm3dFile(phoneUrl, c.routes, {
      odm3dUrls: ['https://example.invalid'],
    }),
    {
      bases: ['https://example.invalid'],
      path: '/odm3d/odm-3d-9be42b4f-phone/tileset.json',
    },
  );
});
test('unsafe or mismatched phone archive never becomes a route', () => {
  for (const phone_archive of [
    '../evil',
    'odm3d/other',
    'https://evil.example/x',
  ]) {
    const c = composeOverlays({ layers: [{ ...model, phone_archive }] });
    assert.equal(c.browser.layers[0].phoneUrl, undefined);
    assert.equal(c.routes.size, 1);
  }
});
test('a real layer id is never shadowed by a phone alias', () => {
  const other = {
    ...model,
    id: 'odm-3d-9be42b4f-phone',
    archive: 'odm3d/odm-3d-9be42b4f-phone',
    phone_archive: undefined,
  };
  const c = composeOverlays({ layers: [model, other] });
  assert.equal(c.browser.layers.length, 2);
  assert.equal(c.browser.layers[0].phoneUrl, undefined);
  assert.equal(c.routes.get(other.id).archive, other.archive);
});
test('browser rejects cross-origin or other-id phone variant without dropping original', () => {
  const c = composeOverlays({ layers: [model] });
  for (const phoneUrl of [
    '//evil.example/x',
    '/basemap/odm3d/another/tileset.json',
  ]) {
    const raw = structuredClone(c.browser);
    raw.layers[0].phoneUrl = phoneUrl;
    const layer = normalizeOverlays(raw).layers[0];
    assert.equal(layer.url, '/basemap/odm3d/odm-3d-9be42b4f/tileset.json');
    assert.equal(layer.phoneUrl, undefined);
  }
});
