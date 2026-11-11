import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allocateSourceCap,
  resolveCatalogCap,
} from '../../server/providers/cctv/cap.js';
import { CCTV_MAX_SOURCES_CEILING } from '../../server/providers/cctv/constants.js';

// Byrd-IT: all Texas cameras (4,154 TxDOT + 820 Austin on 2026-10-08) must fit.
test('catalog cap allows a 15000-camera catalog', () => {
  assert.equal(CCTV_MAX_SOURCES_CEILING, 15000);
  assert.equal(resolveCatalogCap('15000'), 15000);
  assert.equal(resolveCatalogCap('9000'), 9000);
});

// Pack sizes the live server offered on 2026-11-11 (after each pack's own
// cap), once upstream added the World, Québec, Taiwan and Iceland packs.
const PACK_SIZES_20261111 = {
  quebec: 1120,
  world: 2230,
  txdot: 2517,
  austin: 823,
  hk: 1013,
  vegvesen: 881,
  taiwan: 600,
  toronto: 336,
  caltrans: 300,
  fintraffic: 300,
  deldot: 300,
  tallinn: 255,
  wsdot: 250,
  tfl: 250,
  iceland: 250,
  drivebc: 250,
  nsw: 249,
  calgary: 219,
  kingcounty: 58,
  catalonia: 36,
  a22: 13,
  warendorf: 1,
};
const RESERVED_20261111 = { quebec: 1120, world: 2230 };

function packsOf(sizes) {
  return Object.entries(sizes).map(([name, count]) => ({
    name,
    reservedCount: RESERVED_20261111[name] || 0,
    sources: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}` })),
  }));
}

function keptByPack(cap) {
  const { packs } = allocateSourceCap(packsOf(PACK_SIZES_20261111), cap);
  return Object.fromEntries(packs.map((pack) => [pack.name, pack.kept]));
}

test('the ceiling serves every camera of the 2026-11-11 catalog, Texas included', () => {
  const offered = Object.values(PACK_SIZES_20261111).reduce((a, b) => a + b, 0);
  assert.equal(offered, 12251);
  assert.ok(offered <= CCTV_MAX_SOURCES_CEILING, 'the catalog fits under the ceiling');
  const kept = keptByPack(resolveCatalogCap(String(CCTV_MAX_SOURCES_CEILING)));
  assert.deepEqual(kept, PACK_SIZES_20261111, 'no pack is thinned');
  assert.equal(kept.txdot, 2517);
  assert.equal(kept.austin, 823);
});

test('negative control: the old 10000 ceiling thinned Texas on the same catalog', () => {
  const kept = keptByPack(10000);
  assert.ok(kept.txdot < PACK_SIZES_20261111.txdot, `TxDOT kept ${kept.txdot}`);
  assert.ok(kept.austin < PACK_SIZES_20261111.austin, `Austin kept ${kept.austin}`);
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
