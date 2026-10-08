import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveCatalogCap } from '../../server/providers/cctv/cap.js';
import { CCTV_MAX_SOURCES_CEILING } from '../../server/providers/cctv/constants.js';

// Byrd-IT: all Texas cameras (4,154 TxDOT + 820 Austin on 2026-10-08) must fit.
test('catalog cap allows a 9000-camera catalog', () => {
  assert.equal(CCTV_MAX_SOURCES_CEILING, 10000);
  assert.equal(resolveCatalogCap('9000'), 9000);
});

test('TxDOT and Austin per-pack clamps allow every Texas camera', () => {
  const src = fs.readFileSync(new URL('../../server/providers/cctv/sources.js', import.meta.url), 'utf8');
  const clampAfter = (envName) => {
    const at = src.indexOf(`process.env.${envName}`);
    assert.ok(at > 0, envName);
    return Number(src.slice(at).match(/Math\.min\((\d+), Math\.floor\(maxRaw\)\)/)[1]);
  };
  assert.ok(clampAfter('CCTV_TXDOT_MAX_SOURCES') >= 5000, 'TxDOT clamp');
  assert.ok(clampAfter('CCTV_AUSTIN_MAX_SOURCES') >= 1000, 'Austin clamp');
});
