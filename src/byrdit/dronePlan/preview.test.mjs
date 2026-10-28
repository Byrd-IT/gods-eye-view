import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MARKERS,
  MISSION_COLORS,
  createDronePlanPreview,
} from './preview.js';
import { assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';

function fakeCesium() {
  const color = { withAlpha: (a) => ({ a }) };
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      const values = [];
      this.entities = {
        values,
        add: (e) => (values.push(e), e),
        remove: (e) => {
          const i = values.indexOf(e);
          if (i >= 0) values.splice(i, 1);
        },
        removeAll: () => values.splice(0),
      };
    }
  }
  return {
    CustomDataSource,
    Color: { fromCssColorString: () => color },
    Cartesian3: {
      fromDegreesArray: (v) => v,
      fromDegrees: (lon, lat) => [lon, lat],
    },
    PolylineDashMaterialProperty: class {},
    ClassificationType: { BOTH: 'both' },
    HeightReference: { CLAMP_TO_GROUND: 'clamp' },
  };
}
function fakeViewer() {
  const sources = [];
  return {
    renders: 0,
    scene: {
      requestRender() {
        this.renders = (this.renders ?? 0) + 1;
      },
    },
    dataSources: {
      sources,
      add: (s) => (sources.push(s), Promise.resolve(s)),
      remove: (s) => sources.splice(sources.indexOf(s), 1),
    },
  };
}
function result(width, height, options = {}) {
  const m = metersPerDegree(30.27);
  const box = {
    west: -97.77 - width / 2 / m.lon,
    east: -97.77 + width / 2 / m.lon,
    south: 30.27 - height / 2 / m.lat,
    north: 30.27 + height / 2 / m.lat,
  };
  const plan = planFlight(box, { aglM: 100, batteryMin: 60, ...options });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  return assembleMissions(plan, {
    known: true,
    takeoffM: 0,
    wpM: ids.map(() => 0),
  });
}

test('draws the box, one path per mission, waypoints and the takeoff point; clear removes them', async () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  assert.equal(source.name, 'gev-drone-plan');
  preview.showBox({ west: 1, south: 1, east: 2, north: 2 });
  assert.equal(source.entities.values.length, 1);
  const r = result(400, 200, { maxWaypoints: 50 });
  preview.showPlan(r);
  const lines = source.entities.values.filter((e) => e.polyline && e.name);
  assert.equal(lines.length, r.missions.length);
  const points = source.entities.values.filter(
    (e) => e.point && e.name !== 'Takeoff',
  );
  assert.equal(points.length, r.totals.waypointCount);
  const takeoff = source.entities.values.filter((e) => e.name === 'Takeoff');
  assert.equal(takeoff.length, 1);
  assert.equal(
    takeoff[0].label,
    undefined,
    'no Cesium label: the app forbids them',
  );
  assert.ok(MISSION_COLORS.length >= 3);
  preview.showPlan(null);
  assert.equal(source.entities.values.length, 1, 'only the box is left');
  preview.clear();
  assert.equal(source.entities.values.length, 0);
  await preview.destroy();
  assert.equal(viewer.dataSources.sources.length, 0);
});

test('very large plans thin the markers but keep every path', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const r = result(1500, 1200, { aglM: 60, batteryMin: 60 });
  assert.ok(r.totals.waypointCount > MAX_MARKERS);
  preview.showPlan(r);
  const source = viewer.dataSources.sources[0];
  const points = source.entities.values.filter(
    (e) => e.point && e.name !== 'Takeoff',
  );
  assert.ok(points.length <= MAX_MARKERS + r.missions.length);
  assert.equal(
    source.entities.values.filter((e) => e.polyline).length,
    r.missions.length,
  );
});
