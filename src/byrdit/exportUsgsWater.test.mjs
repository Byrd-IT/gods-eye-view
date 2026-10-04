// Byrd-IT: the USGS exporter must write ONE feature per gauge carrying all of
// its readings (schema 2). One feature per reading stacked duplicate labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts',
);
const python = spawnSync('python3', ['--version']);
const skip = python.status === 0 ? false : 'python3 not available';

function groupSites(docs) {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import export_usgs_water as e',
    'print(json.dumps(e.group_sites(json.load(sys.stdin))))',
  ].join('\n');
  const run = spawnSync('python3', ['-c', code], {
    input: JSON.stringify(docs),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const doc = (over) => ({
  site_id: 'USGS-08019500',
  site_name: 'Big Sandy Ck nr Big Sandy, TX',
  site_type_code: 'ST',
  state_name: 'Texas',
  location: { lat: 32.604, lon: -95.0916 },
  ...over,
});

test(
  'readings for one gauge become one feature, most useful first',
  { skip },
  () => {
    const features = groupSites([
      doc({
        parameter_code: '00060',
        value: 19.6,
        unit: 'ft^3/s',
        observed_time: '2026-10-04T10:00:00+00:00',
      }),
      doc({
        parameter_code: '00065',
        value: 3.97,
        unit: 'ft',
        observed_time: '2026-10-04T09:45:00+00:00',
      }),
      doc({
        site_id: 'USGS-1',
        site_name: 'Other',
        parameter_code: '00065',
        value: 1,
        unit: 'ft',
        observed_time: '2026-10-04T08:00:00+00:00',
      }),
    ]);
    assert.equal(features.length, 2);
    const big = features.find(
      (f) => f.properties.usgs_site_id === 'USGS-08019500',
    );
    assert.deepEqual(big.geometry.coordinates, [-95.0916, 32.604]);
    assert.deepEqual(
      big.properties.readings.map((r) => [r.parameter_name, r.value, r.unit]),
      [
        ['Gage height', 3.97, 'ft'],
        ['Discharge', 19.6, 'ft^3/s'],
      ],
    );
    assert.equal(big.properties.observed_time, '2026-10-04T10:00:00+00:00');
    // Primary reading stays top-level for schema-1 readers.
    assert.equal(big.properties.parameter_name, 'Gage height');
    assert.equal(big.properties.value, 3.97);
  },
);

test('lake elevation codes 62614 and 62615 get names', { skip }, () => {
  const [lake] = groupSites([
    doc({
      site_type_code: 'LK',
      parameter_code: '62614',
      value: 263.02,
      unit: 'ft',
      observed_time: '2026-10-04T10:00:00Z',
    }),
    doc({
      site_type_code: 'LK',
      parameter_code: '62615',
      value: 263.9,
      unit: 'ft',
      observed_time: '2026-10-04T10:00:00Z',
    }),
  ]);
  assert.deepEqual(
    lake.properties.readings.map((r) => r.parameter_name),
    ['Lake elevation above NGVD29', 'Lake elevation above NAVD88'],
  );
});

test(
  'a gauge with no located reading is dropped; a located one is kept',
  { skip },
  () => {
    const features = groupSites([
      doc({
        location: null,
        parameter_code: '00065',
        value: 1,
        unit: 'ft',
        observed_time: '2026-10-04T10:00:00Z',
      }),
      doc({
        site_id: 'USGS-2',
        location: '30.5,-97.5',
        parameter_code: '00065',
        value: 2,
        unit: 'ft',
        observed_time: '2026-10-04T10:00:00Z',
      }),
    ]);
    assert.deepEqual(
      features.map((f) => f.properties.usgs_site_id),
      ['USGS-2'],
    );
    assert.deepEqual(features[0].geometry.coordinates, [-97.5, 30.5]);
  },
);
