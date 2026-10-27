import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basemapCreditHtml,
  basemapCredits,
  sentinelCredit,
  GIBS_CREDIT,
  TERRAIN_CREDIT_HTML,
  WATER_MASK_CREDIT,
} from './credits.js';
import { normalizeBasemapConfig } from './config.js';
import { SERVED } from './fixtures/config.mjs';

test('BASEMAP.md 4.4 credit strings, exactly', () => {
  assert.equal(
    sentinelCredit(2025),
    'Contains modified Copernicus Sentinel data 2025',
  );
  assert.equal(GIBS_CREDIT, 'NASA GIBS / EOSDIS');
  assert.equal(
    TERRAIN_CREDIT_HTML,
    'Terrain: <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Mapterhorn</a>' +
      ' - open data from US Geological Survey (public domain), Copernicus, CC BY national mapping agencies,' +
      ' and others; heights adjusted with EGM2008 (NGA)',
  );
  assert.equal(
    WATER_MASK_CREDIT,
    '© OpenStreetMap contributors via Protomaps (ODbL)',
  );
});

test('every layer in use is credited, in a fixed order', () => {
  const config = normalizeBasemapConfig(SERVED);
  assert.deepEqual(basemapCredits(config), [
    'Contains modified Copernicus Sentinel data 2025',
    'NASA GIBS / EOSDIS',
    TERRAIN_CREDIT_HTML,
    '© OpenStreetMap contributors via Protomaps (ODbL)',
  ]);
  assert.equal(
    basemapCreditHtml(config),
    [
      'Contains modified Copernicus Sentinel data 2025',
      'NASA GIBS / EOSDIS',
      TERRAIN_CREDIT_HTML,
      '© OpenStreetMap contributors via Protomaps (ODbL)',
    ].join(' | '),
  );
});

test('no Sentinel credit without Sentinel regions; no water credit without the mask; no NAIP or buildings credit', () => {
  const config = normalizeBasemapConfig({
    ...SERVED,
    imagery: { ...SERVED.imagery, regions: [] },
    terrain: { ...SERVED.terrain, waterMask: false },
  });
  assert.deepEqual(basemapCredits(config), [
    'NASA GIBS / EOSDIS',
    TERRAIN_CREDIT_HTML,
  ]);
  const all = basemapCreditHtml(normalizeBasemapConfig(SERVED));
  assert.doesNotMatch(all, /NAIP|Overture|buildings/i);
});

test('an unavailable stack has no credit', () => {
  assert.equal(basemapCreditHtml(normalizeBasemapConfig(null)), null);
});
