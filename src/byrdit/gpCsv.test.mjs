import assert from 'node:assert/strict';
import test from 'node:test';
import { GP_CSV_HEADER, parseGP } from './gpCsv.js';
import { createOrbits } from '../layers/satellites/orbits.js';

const HEADER =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
const ISS =
  'ISS (ZARYA),1998-067A,2026-10-11T04:13:59.875680,15.48821882,.00067135,51.6312,86.0933,248.1316,111.8959,0,U,25544,999,58973,.1801405E-3,.943E-4,0';
const SIX_DIGIT =
  'NEW OBJECT,2026-150A,2026-10-10T01:00:00.000000,15.1,.0001,53.0,10,20,30,0,U,123456,999,10,.0001,.0001,0';

test('parses CRLF (CelesTrak) and LF bodies alike, 6-digit NORAD ids included', () => {
  for (const eol of ['\r\n', '\n']) {
    const rows = parseGP([HEADER, ISS, SIX_DIGIT, ''].join(eol));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'ISS (ZARYA)');
    assert.equal(rows[0].gp.NORAD_CAT_ID, '25544');
    assert.equal(rows[0].gp.MEAN_MOTION_DDOT, '0', 'last column has no \\r');
    assert.equal(rows[1].gp.NORAD_CAT_ID, '123456');
  }
  assert.ok(HEADER.startsWith(GP_CSV_HEADER));
});

test('rejects a non-GP body, a header-only body and rows without a name or id', () => {
  assert.deepEqual(parseGP(''), []);
  assert.deepEqual(parseGP(null), []);
  assert.deepEqual(parseGP('<html>error</html>\r\nx'), []);
  assert.deepEqual(parseGP(HEADER), []);
  const rows = parseGP(
    [HEADER, ',1998-067A,2026-10-11,1,0,0,0,0,0,0,U,1', ISS].join('\r\n'),
  );
  assert.equal(rows.length, 1);
});

test('the satellites layer parses with the same shared function (no fork)', () => {
  const orbits = createOrbits({
    state: {},
    services: {},
    parts: {},
    source: {},
  });
  assert.equal(orbits.parseGP, parseGP);
});
