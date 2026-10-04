// Byrd-IT fork: upstream's satellite tools must read the GP CSV this fork's
// CelesTrak proxy serves (FORMAT=tle cannot carry 6-digit NORAD numbers).
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../tools/index.js';
import { isGpCsvText, parseGpCsvText } from '../sources/tle.js';

// Same element sets as upstream's space.test.mjs TLE fixture (2024-01-01 12Z).
const TLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  30270-3 0  9994
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432414
CSS (TIANHE)
1 48274U 21035A   24001.50000000  .00020137  00000-0  24481-3 0  9993
2 48274  41.4697 175.8913 0005643 312.8370 141.6893 15.61287398150000
`;
const HEADER =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
const CSV = [
  HEADER,
  'ISS (ZARYA),1998-067A,2024-01-01T12:00:00.000000,15.50377579,.0006703,51.6416,247.4627,130.5360,325.0288,0,U,25544,999,43241,.30270E-3,.16717E-3,0',
  'CSS (TIANHE),2021-035A,2024-01-01T12:00:00.000000,15.61287398,.0005643,41.4697,175.8913,312.8370,141.6893,0,U,48274,999,15000,.24481E-3,.20137E-3,0',
  'NEW 6-DIGIT SAT,2026-150A,2024-01-01T12:00:00.000000,15.10000000,.0001000,53.0000,10.0000,90.0000,270.0000,0,U,100123,999,1,.10000E-3,.10000E-4,0',
].join('\r\n');

const CLOCK = { now: () => Date.UTC(2024, 0, 1, 12) };
const catalogFor = (text) =>
  composeCatalog({
    tools: coreTools,
    services: {
      satellites: { readGroup: async () => ({ ok: true, status: 200, text }) },
      clock: CLOCK,
    },
  });

test('GP CSV (CRLF) is detected and parsed, including 6-digit catalog numbers', () => {
  assert.equal(isGpCsvText(CSV), true);
  assert.equal(isGpCsvText(TLE), false);
  const entries = parseGpCsvText(CSV);
  assert.deepEqual(
    entries.map((entry) => entry.norad),
    [25544, 48274, 100123],
  );
  assert.equal(entries[0].name, 'ISS (ZARYA)');
});

test('next pass from GP CSV matches the TLE answer for the same elements', async () => {
  const location = { lat: 40.7, lon: -74 };
  const fromTle = await catalogFor(TLE).call('next_satellite_pass', {
    location,
  });
  const fromCsv = await catalogFor(CSV).call('next_satellite_pass', {
    location,
  });
  assert.equal(fromCsv.data.satellite, 'ISS (ZARYA)');
  assert.equal(fromCsv.data.norad, 25544);
  const drift = Math.abs(
    Date.parse(fromCsv.data.pass.rise) - Date.parse(fromTle.data.pass.rise),
  );
  assert.ok(drift <= 60_000, `rise times differ by ${drift} ms`);
});

test('a 6-digit NORAD satellite is found by number from GP CSV', async () => {
  const result = await catalogFor(CSV).call('next_satellite_pass', {
    location: { lat: 0, lon: 0 },
    satellite: '100123',
  });
  assert.equal(result.data.satellite, 'NEW 6-DIGIT SAT');
  assert.equal(result.data.norad, 100123);
});
