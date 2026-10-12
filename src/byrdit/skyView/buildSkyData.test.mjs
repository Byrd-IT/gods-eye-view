import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  MAG_LIMIT,
  buildConstellations,
  buildSkyData,
  buildStars,
  parseCsv,
} from '../../../scripts/build-sky-data.mjs';

const HEADER = 'id,hip,proper,mag,ci,pmra,pmdec,rarad,decrad,bf';
const csv = (rows) => `${[HEADER, ...rows].join('\n')}\n`;
const WESTERN = {
  constellations: [
    {
      iau: 'Zzz',
      common_name: { english: 'Last', native: 'Ultima' },
      lines: [[3, 1]],
    },
    {
      iau: 'Aaa',
      common_name: { english: 'First', native: 'Prima' },
      lines: [['thin', 1, 2], [2]],
    },
  ],
};
const ROWS = [
  '0,,Sol,-26.7,0.656,0,0,0,0,""',
  '1,1,"Star, One",1.5,0.5,10.25,-3.33,0.1,0.2,"1Alp Aaa"',
  '2,2,,6.4,,0,0,6.2,-1.5,""',
  '3,3,,7.9,1.1,0,0,3.0,0.5,""', // fainter than the limit but on a line
  '4,4,,8.0,1.2,0,0,4.0,0.6,""', // fainter and unused: dropped
  '5,,,0.5,0.1,0,0,1.0,0.1,""', // no HIP id
];

test('CSV parser handles quotes, doubled quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n1,,3\n'), [
    ['a', 'b,c', 'd"e'],
    ['1', '', '3'],
  ]);
});

test('constellations: sorted by IAU, style markers and one-star chains dropped', () => {
  const out = buildConstellations(WESTERN);
  assert.deepEqual(
    out.map((c) => c.iau),
    ['Aaa', 'Zzz'],
  );
  assert.deepEqual(out[0].lines, [[1, 2]]);
  assert.equal(out[0].native, 'Prima');
  assert.throws(() => buildConstellations({}), /no constellations/);
});

test('stars: mag <= 6.5 plus line stars, Sol dropped, sorted by magnitude', () => {
  const out = buildStars(parseCsv(csv(ROWS)), new Set([1, 2, 3]), MAG_LIMIT);
  assert.deepEqual(out.hip, [0, 1, 2, 3]);
  assert.deepEqual(out.mag, [0.5, 1.5, 6.4, 7.9]);
  assert.deepEqual(out.names, [[1, 'Star, One']]);
  assert.deepEqual(out.bf, [[1, '1Alp Aaa']]);
  assert.equal(out.bv[2], null);
  assert.equal(out.pmRa[1], 10.3); // 1 decimal
  assert.ok(Math.abs(out.ra[1] - 5.7296) < 1e-9); // 0.1 rad, 4 decimals
  assert.throws(
    () => buildStars(parseCsv(csv(ROWS)), new Set([1, 99])),
    /no row for line HIP ids: 99/,
  );
});

test('buildSkyData is deterministic and records checksums', () => {
  const hyg = gzipSync(Buffer.from(csv(ROWS)));
  const western = Buffer.from(JSON.stringify(WESTERN));
  const a = buildSkyData(hyg, western);
  const b = buildSkyData(hyg, western);
  assert.deepEqual(a, b);
  const manifest = JSON.parse(a['manifest.json']);
  assert.equal(manifest.counts.stars, 4);
  assert.equal(manifest.counts.lineStars, 3);
  assert.equal(manifest.counts.lineSegments, 2);
  assert.match(manifest.outputs['stars.json'].sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.inputs.hyg.sha256, /^[0-9a-f]{64}$/);
});
