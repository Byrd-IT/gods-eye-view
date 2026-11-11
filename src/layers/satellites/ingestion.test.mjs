import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGP } from '../../byrdit/gpCsv.js';
import {
  SATCAT_KEEP_MS,
  SATCAT_WAIT_MS,
  createIngestion,
} from './ingestion.js';
import { createOrbits } from './orbits.js';
import { createControls } from './controls.js';

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

// A one-satellite GP CSV catalog (the shape the fork's proxy serves) for the
// upstream SATCAT / class tests that were written against a TLE triplet.
function gpSet(name, noradId, objectId = '1998-067A') {
  return [HEADER, gpRow(name, noradId, objectId)].join('\r\n');
}

function ingestionFor(catalogText, { source: sourceExtras = {} } = {}) {
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
    _satcat: new Map(),
    _ucs: null,
    now: Date.now,
    coverageChanged() {},
  };
  const parts = {
    orbits: {
      parseGP,
      // The real designator reader, so launch years follow production.
      gpLaunchYear: createOrbits({ state }).gpLaunchYear,
      propagatePosition: () => ({ longitude: 0, latitude: 0, altitude: 4e5 }),
    },
    labels: { _syncIssOverlay() {} },
    controls: {
      _pointStyleFor: () => ({}),
      _classVisible: () => true,
      _syncIssOrbit() {},
      _applyClassVisibility() {
        state.visibilityApplied = (state.visibilityApplied || 0) + 1;
      },
      _notifyRowControls() {
        state.rowNotified = (state.rowNotified || 0) + 1;
      },
    },
    rendering: { _showOrbitPath() {} },
    tracking: {
      async _reconcileTrackedSubjectContext() {},
      _applyPendingTrackingRestore() {},
    },
    catalog: {},
  };
  const source = {
    async readGroup(path) {
      const text =
        typeof catalogText === 'function' ? catalogText(path) : catalogText;
      return { ok: true, text };
    },
    ...sourceExtras,
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

test('a hanging SATCAT read neither holds the catalog nor is lost when it lands', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  const satcatAnswer = new Promise((resolve) => {
    answer = resolve;
  });
  const { state, update } = ingestionFor(
    (path) => (path === 'stations' ? gpSet('OLD STAGE', 40115) : ''),
    { source: { readSatcat: () => satcatAnswer } },
  );
  state._enabled = true;
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const rebuilt = update();
  await settle();
  t.mock.timers.tick(SATCAT_WAIT_MS);
  await rebuilt;
  // Built without SATCAT: neither name nor group says what it is (the
  // stations group alone makes no station).
  assert.equal(state._catalog.get(40115).satelliteClass, 'probes');
  const revision = state._catalogRevision;
  // SATCAT lands late: a rocket body.
  answer({
    ok: true,
    stale: true,
    text: 'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\nOLD STAGE,2014-048B,40115,R/B,,US',
  });
  await settle();
  assert.equal(state._catalog.get(40115).satelliteClass, 'debris');
  assert.equal(state._catalogRevision, revision + 1, 'the legend refreshes');
  assert.ok(state.visibilityApplied >= 1 && state.rowNotified >= 1);
  assert.equal(state._satcatState, 'stale', 'its staleness is kept');
});

test('a satellite in visual and resource is imaging, whichever group shows it', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // A name no pattern knows, no UCS record and no SATCAT: only its groups.
  const { state, update } = ingestionFor((path) =>
    path === 'visual' || path === 'resource' ? gpSet('ZZ TESTSAT', 50001) : '',
  );
  await update();
  const sat = state._catalog.get(50001);
  assert.equal(sat.group, 'visual', 'shown under the first group');
  assert.deepEqual(sat.groups, ['visual', 'resource']);
  assert.equal(sat.satelliteClass, 'imaging');
});

test('a stale SATCAT copy never overrules a current read of the same object', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const header =
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\n';
  const { state, update } = ingestionFor(gpSet('ZZ TESTSAT', 50002), {
    source: {
      // visual is current and says it died; resource, a cached copy, still
      // says it works.
      readSatcat: async (path) =>
        path === 'visual'
          ? { ok: true, text: `${header}ZZ TESTSAT,2015-001A,50002,PAY,-,US` }
          : path === 'resource'
            ? {
                ok: true,
                stale: true,
                text: `${header}ZZ TESTSAT,2015-001A,50002,PAY,+,US`,
              }
            : { ok: true, text: header },
    },
  });
  await update();
  assert.equal(state._catalog.get(50002).satelliteClass, 'debris');
});

test('a failed SATCAT read is told on the layer row, not only the console', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(gpSet('OLD STAGE', 40115), {
    source: { readSatcat: async () => ({ ok: false, text: '' }) },
  });
  await update();
  assert.equal(state._satcatState, 'unavailable');
  assert.ok(state.rowNotified >= 1, 'the row repaints');
  const controls = createControls({
    state: {
      ...state,
      _params: { ...state._params, showPoints: true },
      _classTallyCache: {},
    },
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {},
    source: {},
  });
  const row = controls.methods.getRowControls();
  assert.equal(row.info, 'Classes may lag: SATCAT unavailable');
  assert.match(row.infoTitle, /SATCAT/);
  const current = createControls({
    state: {
      ...state,
      _satcatState: 'current',
      _params: { ...state._params, showPoints: true },
      _classTallyCache: {},
    },
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {},
    source: {},
  });
  assert.equal(current.methods.getRowControls().info, '');
});

test('a current SATCAT read is kept between updates; a failed one is asked again', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const header =
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE\n';
  let reads = 0;
  let ok = true;
  const { state, update } = ingestionFor(gpSet('ZZ TESTSAT', 50003), {
    source: {
      readSatcat: async () => {
        reads++;
        return ok
          ? { ok: true, text: `${header}ZZ TESTSAT,2015-001A,50003,PAY,-` }
          : { ok: false, text: '' };
      },
    },
  });
  await update();
  const perUpdate = reads;
  assert.ok(perUpdate > 0);
  await update();
  assert.equal(reads, perUpdate, 'a fresh read is not asked again');
  assert.equal(
    state._catalog.get(50003).satelliteClass,
    'debris',
    'the held records still class the rebuilt catalog',
  );

  state._satcatReadAtMs -= SATCAT_KEEP_MS;
  ok = false;
  await update();
  assert.equal(reads, 2 * perUpdate, 'an old read is asked again');
  assert.equal(state._satcatState, 'unavailable');
  await update();
  assert.equal(reads, 3 * perUpdate, 'a failed read is asked again');
});

test('a failed imaging-sensor pack is warned about, as the UCS pack is', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(gpSet('OLD STAGE', 40115), {
    source: {
      readSensors: async () => {
        throw new Error('chunk failed');
      },
    },
  });
  await update();
  assert.ok(
    warn.mock.calls.some((call) =>
      /sensor pack unavailable/i.test(call.arguments[0]),
    ),
    'the failure is not swallowed',
  );
  assert.equal(state._catalog.get(40115).sensor, null, 'base zoom steps');
});
