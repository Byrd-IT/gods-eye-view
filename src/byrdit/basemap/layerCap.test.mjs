import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS_CEILING, layerCap } from './layerCap.js';
import { DEFAULT_MAX_LAYERS, composeNaip } from './naipProxy.js';
import {
  DEFAULT_OVERLAY_MAX_LAYERS,
  composeOverlays,
} from './overlaysProxy.js';
import { basemapSettingsFromEnv } from './proxy.js';

const regional = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    year: 2020,
    status: 'live',
    minzoom: 10,
    maxzoom: 20,
    bounds: [-100, 30, -99, 31],
    archive: `hires/r${i}`,
  }));
const overlays = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    status: 'live',
    kind: 'overlay-raster',
    format: 'webp',
    minzoom: 0,
    maxzoom: 12,
    bounds: [-100, 30, -99, 31],
    archive: `overlays/o${i}`,
    name: `Overlay ${i}`,
  }));

test('layerCap: positive integers clamp to the ceiling, junk = fallback', () => {
  assert.equal(layerCap('300', 7), 300);
  assert.equal(layerCap(String(LAYERS_CEILING + 1), 7), LAYERS_CEILING);
  for (const bad of [undefined, '', '0', '-5', '1.5', 'abc', 'NaN'])
    assert.equal(layerCap(bad, 7), 7, String(bad));
});

test('composeNaip: default exposes more than the old 200 regional layers', () => {
  assert.ok(DEFAULT_MAX_LAYERS > 200);
  const out = composeNaip({ regional: regional(350) });
  assert.equal(out.browser.regional.length, 350);
});

test('composeNaip: maxLayers caps the list; junk falls back to the default', () => {
  const raw = { regional: regional(30) };
  assert.equal(composeNaip(raw, { maxLayers: 10 }).browser.regional.length, 10);
  assert.equal(
    composeNaip(raw, { maxLayers: 'x' }).browser.regional.length,
    30,
  );
});

test('composeOverlays: default exposes more than the old 50 layers', () => {
  assert.ok(DEFAULT_OVERLAY_MAX_LAYERS > 50);
  const all = composeOverlays({ layers: overlays(120) });
  assert.equal(all.browser.layers.length, 120);
  const few = composeOverlays({ layers: overlays(30) }, { maxLayers: 5 });
  assert.equal(few.browser.layers.length, 5);
});

test('settings: env tunes both caps; junk keeps the defaults', () => {
  const s = basemapSettingsFromEnv({
    GEV_BASEMAP_NAIP_MAX_LAYERS: '900',
    GEV_BASEMAP_OVERLAYS_MAX_LAYERS: '300',
  });
  assert.equal(s.naipMaxLayers, 900);
  assert.equal(s.overlaysMaxLayers, 300);
  const d = basemapSettingsFromEnv({ GEV_BASEMAP_NAIP_MAX_LAYERS: 'zz' });
  assert.equal(d.naipMaxLayers, DEFAULT_MAX_LAYERS);
  assert.equal(d.overlaysMaxLayers, DEFAULT_OVERLAY_MAX_LAYERS);
});
