import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlightSnapshotRenderer } from './snapshotRenderer.js';
import { createMotion } from './motion.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

/**
 * A flights snapshot renderer over the real motion part and fakes for the
 * rest: one contact per snapshot, the mesh floor probe and stale re-floor
 * recorded. The display delay is a spy so a history frame's effect on it is
 * visible directly.
 */
function harness() {
  const iconIds = new Set();
  const meshCalls = [];
  const presented = [];
  const delay = { notes: [], settles: [] };
  const flightState = {
    _viewer: null,
    _icons: {
      has: (id) => iconIds.has(id),
      ids: () => [...iconIds],
      get count() {
        return iconIds.size;
      },
    },
    _positionHistory: new Map(),
    _displayCourse: new Map(),
    _trailPositions: [],
    _trailFixes: [],
    _trailBackfillToken: 0,
    _groundSnap: { forget() {} },
    _grounded: new Set(),
    _floorPinned: new Map(),
    _models: new Map(),
    _trackedModel: null,
    _trackedIcao: null,
    _displayDelay: {
      noteReport: (...args) => delay.notes.push(args),
      settle: (...args) => delay.settles.push(args),
    },
    records: { data: new Map() },
  };
  const parts = {
    rendering: {
      _modelOwnsVisual: () => false,
      _syncModelToClass() {},
      _sampleMeshFloor: (points, lat, lon) =>
        meshCalls.push({ points, lat, lon }),
    },
    icons: {
      _iconIds: () => ['icon-primitive'],
      _addIcon: (id) => iconIds.add(id),
      _applyIconPresentation: (id) => presented.push(id),
      _planIcon() {},
      _forgetContact: (id) => iconIds.delete(id),
    },
  };
  const services = {
    camera: { trackedModelScaleForPixelCap: () => 1 },
    focus: {},
    groundFloor: {
      cachedGroundFloor: () => null,
      GROUND_FLOOR_LIFT_M: 0.5,
    },
    meshFloor: {},
  };
  parts.motion = createMotion({ flightState, services, parts, layer: {} });
  let fix = null;
  const records = {
    data: new Map(),
    beginSnapshot() {},
    beginHistoryFrame() {},
    forget(id) {
      this.data.delete(id);
    },
    receive(observation) {
      const meta = {
        rawLon: observation.lon,
        rawLat: observation.lat,
        renderAltitudeM: observation.altM,
        velocity: observation.speedMps,
        true_track: observation.track,
        onGround: false,
        klass: 'jet',
        category: null,
        typeCode: null,
      };
      flightState.records.data.set(observation.id, meta);
      return { prevMeta: null, meta, groundFlipped: false, fixEpochMs: fix };
    },
    absence: () => 'retain',
  };
  const apply = createFlightSnapshotRenderer({
    flightState,
    records,
    groundFloor: { warmGroundFloor() {}, cachedGroundFloor: () => null },
    militaryRegistry: {
      refreshMilitaryRegistryIfStale() {},
      isMilitaryIcao: () => false,
    },
    rendering: parts.rendering,
    tracking: {
      _militaryLayerSuppresses: () => false,
      _appendTrailFix() {},
      _startTrail() {},
      _clearTracking() {},
      _updateTrackedLabelModel() {},
    },
    motion: parts.motion,
    icons: parts.icons,
    enrichment: {
      _sweepAmbientEnrichment() {},
      _requestTypeEnrichment() {},
      _requestRouteEnrichment() {},
      _requestPhotoEnrichment() {},
    },
    queries: { _likelyLanded: () => false },
  });
  return {
    flightState,
    delay,
    meshCalls,
    presented,
    apply(observation, fixEpochMs, options = {}) {
      fix = fixEpochMs;
      return apply(
        {
          observedAtMs: fixEpochMs,
          records: [{ ...observation, positionTimeMs: fixEpochMs }],
          complete: true,
        },
        null,
        options,
      );
    },
  };
}

const CONTACT = Object.freeze({
  id: 'a1b2c3',
  lon: -97.5,
  lat: 30.25,
  altM: 3000,
  speedMps: 200,
  track: 90,
});

test('a live snapshot aims the display delay; a history frame leaves it alone', () => {
  const h = harness();
  const t0 = 1_700_000_000_000;
  h.apply(CONTACT, t0);
  assert.equal(h.delay.notes.length, 1, 'a live report is noted');
  assert.equal(h.delay.settles.length, 1, 'a live delivery settles the delay');

  h.delay.notes.length = 0;
  h.delay.settles.length = 0;
  // A history frame's reports are hours old by design: they must not be read
  // as a late live delivery and push the display delay around.
  h.flightState._historyFrameArmed = true;
  h.apply(CONTACT, t0 + 1_000);
  assert.equal(h.delay.notes.length, 0, 'history reports are not live notes');
  assert.equal(h.delay.settles.length, 0, 'history does not settle the delay');
});

test('an explicit replace frame also leaves the display delay alone', () => {
  const h = harness();
  const t0 = 1_700_000_000_000;
  h.apply(CONTACT, t0);
  h.delay.notes.length = 0;
  h.delay.settles.length = 0;
  // `replace` is how a world-clock jump replaces the scene: not a delivery.
  h.apply(CONTACT, t0 + 1_000, { replace: true });
  assert.equal(h.delay.notes.length, 0);
  assert.equal(h.delay.settles.length, 0);
});

test('a fix appends to the history only when it advances a whole millisecond', () => {
  const h = harness();
  const t0 = 1_700_000_000_000;
  h.apply(CONTACT, t0);
  const history = h.flightState._positionHistory.get(CONTACT.id);
  assert.equal(history.length, 1);
  const [entry] = history;
  assert.equal(entry.epochMs, t0);
  assert.equal(entry.velocity, CONTACT.speedMps);
  assert.equal(entry.track, CONTACT.track);
  const expected = fromDegrees(CONTACT.lon, CONTACT.lat, CONTACT.altM);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(entry.position[axis] - expected[axis]) < 1e-6, axis);
  h.apply(CONTACT, t0 + 0.4);
  assert.equal(history.length, 1);
  h.apply({ ...CONTACT, lon: CONTACT.lon + 0.01 }, t0 + 1_000);
  assert.equal(history.length, 2);
  assert.equal(history[1].epochMs, t0 + 1_000);
});
