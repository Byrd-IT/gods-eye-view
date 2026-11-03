import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGP } from '../../byrdit/gpCsv.js';
import { createIngestion } from './ingestion.js';
import { createOrbits } from './orbits.js';

// Byrd-IT fork: the CelesTrak proxy serves GP CSV (OMM columns), not TLE, so
// this upstream Alpha-5 test drives the fork parser (parts.orbits.parseGP).
// GP CSV carries catalog numbers above 99999 as plain digits; the satellites
// TLE spells A0000 / B0001 / Z9999 are 100000 / 110001 / 339999.
const HEADER =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';

// The ISS elements (1 January 2024) with the catalog number swapped per row.
function gpRow(name, noradId, objectId = '1998-067A') {
  return `${name},${objectId},2024-01-01T12:00:00.000000,15.50377579,.0006703,51.6416,247.4627,130.5360,325.0288,0,U,${noradId},999,43232,.30370E-3,.16717E-3,0`;
}

function ingestionFor(catalogText) {
  const state = {
    _trackingRefreshEpoch: 0,
    _activeUpdateControllers: new Set(),
    _pointCollection: {
      removeAll() {},
      add: (point) => point,
    },
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map(),
    _detectionObjects: new Map(),
    _denseLoadToken: 0,
    _catalogRevision: 0,
    _params: { catalog: 'core', showOrbits: false },
  };
  const parts = {
    orbits: {
      parseGP,
      // The real designator reader, so launch years follow production.
      gpLaunchYear: createOrbits({ state }).gpLaunchYear,
      propagatePosition: () => ({ longitude: 0, latitude: 0, altitude: 4e5 }),
    },
    labels: { _syncIssOverlay() {} },
    controls: { _pointStyleFor: () => ({}) },
    rendering: { _showOrbitPath() {} },
    tracking: {
      async _reconcileTrackedSubjectContext() {},
      _applyPendingTrackingRestore() {},
    },
    catalog: {},
  };
  const source = {
    async readGroup() {
      return { ok: true, text: catalogText };
    },
  };
  const { methods } = createIngestion({ state, services: {}, parts, source });
  return { state, update: () => methods.update({ scene: {} }) };
}

test('every 6-digit (Alpha-5 range) satellite keeps its own catalog entry through dedupe', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(
    [
      HEADER,
      gpRow('FIRST', 100000),
      gpRow('SECOND', 110001),
      gpRow('THIRD', 339999),
    ].join('\r\n'),
  );
  await update();
  assert.deepEqual(
    [...state._catalog].map(([id, entry]) => [id, entry.name]),
    [
      [100000, 'FIRST'],
      [110001, 'SECOND'],
      [339999, 'THIRD'],
    ],
  );
  assert.deepEqual([...state._points.keys()], [100000, 110001, 339999]);
  assert.equal(state._count, 3);
});

test('a mission payload does not match a loaded satellite from another launch year', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // SXM-11, international designator 2026-148A (read from the CSV OBJECT_ID).
  const { state, update } = ingestionFor(
    [HEADER, gpRow('SXM-11', 69728, '2026-148A')].join('\r\n'),
  );
  await update();
  const { getSatelliteOrbitTrack } = createOrbits({ state });
  const track = (launchTime) =>
    getSatelliteOrbitTrack('Sirius SXM-11', { launchTime });
  assert.equal(track('2026-06-29T02:25:00Z')?.noradId, 69728);
  assert.equal(track('2030-06-29T02:25:00Z'), null);
});

test('a satellite with a blank designator keeps matching by name', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(
    [HEADER, gpRow('SXM-11', 69728, '')].join('\r\n'),
  );
  await update();
  const { getSatelliteOrbitTrack, gpLaunchYear } = createOrbits({ state });
  assert.equal(gpLaunchYear({ OBJECT_ID: '' }), null);
  assert.equal(
    getSatelliteOrbitTrack('Sirius SXM-11', {
      launchTime: '2030-06-29T02:25:00Z',
    })?.noradId,
    69728,
  );
});
