import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MARKERS,
  MISSION_COLORS,
  PASS_STYLES,
  createDronePlanPreview,
  passStyle,
} from './preview.js';
import { assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';
import { suiteOptions } from './suite.js';

function fakeCesium() {
  const paint = (css, a = 1) => ({ css, a, withAlpha: (x) => paint(css, x) });
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
    Color: { fromCssColorString: (css) => paint(css) },
    Cartesian3: {
      fromDegreesArray: (v) => v,
      fromDegreesArrayHeights: (v) => ({ heights: v }),
      fromDegrees: (lon, lat, h) =>
        h === undefined ? [lon, lat] : [lon, lat, h],
    },
    PolylineDashMaterialProperty: class {
      constructor(options) {
        this.options = options;
      }
    },
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

// ---------------------------------------------------------- all passes --
const SUITE_IDS = ['nadir', 'oblique60', 'oblique45', 'orbit'];
function suitePasses({ groundM = 200, big = false } = {}) {
  const m = metersPerDegree(30.27);
  const w = big ? 1500 : 300;
  const h = big ? 1200 : 200;
  const box = {
    west: -97.77 - w / 2 / m.lon,
    east: -97.77 + w / 2 / m.lon,
    south: 30.27 - h / 2 / m.lat,
    north: 30.27 + h / 2 / m.lat,
  };
  return suiteOptions({ presetId: 'dji-mini-4-pro' }).map(
    ({ id, label, options }) => {
      const plan = planFlight(box, {
        ...options,
        ...(big ? { aglM: 60, maxWaypoints: 5000 } : {}),
      });
      const ids = plan.legs.flatMap((l) => l.waypoints.map((p) => p.id));
      return {
        id,
        label,
        error: null,
        result: assembleMissions(plan, {
          known: true,
          takeoffM: groundM,
          wpM: ids.map(() => groundM),
        }),
      };
    },
  );
}
const polylines = (source, prefix) =>
  source.entities.values.filter(
    (e) => e.polyline && e.name?.startsWith(`${prefix} mission`),
  );
const markers = (source) =>
  source.entities.values.filter((e) => e.point && e.name !== 'Takeoff');

test('PASS_STYLES: distinct colours, solid/dashed/dotted, only the orbit floats', () => {
  assert.deepEqual(Object.keys(PASS_STYLES), SUITE_IDS);
  const colors = SUITE_IDS.map((id) => PASS_STYLES[id].color);
  assert.equal(new Set(colors).size, 4);
  assert.equal(PASS_STYLES.nadir.dash, 0);
  assert.ok(PASS_STYLES.oblique60.dash > PASS_STYLES.oblique45.dash);
  assert.ok(PASS_STYLES.oblique45.dash > 0);
  assert.deepEqual(
    SUITE_IDS.filter((id) => PASS_STYLES[id].floating),
    ['orbit'],
  );
  assert.ok(passStyle('mystery', 1).color, 'unknown ids still get a style');
});

test('showSuite draws every pass in its own style; orbit rings float at two heights', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const passes = suitePasses({ groundM: 200 });
  preview.showSuite(passes);
  for (const id of SUITE_IDS) {
    assert.ok(polylines(source, id).length >= 1, `${id} has a path`);
  }
  const nadir = polylines(source, 'nadir')[0].polyline;
  assert.equal(nadir.material.css, PASS_STYLES.nadir.color, 'solid colour');
  assert.equal(nadir.clampToGround, true);
  const o60 = polylines(source, 'oblique60')[0].polyline;
  assert.equal(o60.material.options.dashLength, PASS_STYLES.oblique60.dash);
  assert.equal(o60.material.options.color.css, PASS_STYLES.oblique60.color);
  const o45 = polylines(source, 'oblique45')[0].polyline;
  assert.equal(o45.material.options.dashLength, PASS_STYLES.oblique45.dash);
  assert.notEqual(
    o60.material.options.dashLength,
    o45.material.options.dashLength,
  );
  const orbitLines = polylines(source, 'orbit');
  for (const e of orbitLines) {
    assert.equal(e.polyline.clampToGround, undefined, 'orbit is not clamped');
    assert.ok(e.polyline.positions.heights, 'orbit positions carry heights');
    assert.equal(e.polyline.material.css, PASS_STYLES.orbit.color);
  }
  const heights = new Set();
  for (const e of orbitLines) {
    const v = e.polyline.positions.heights;
    for (let i = 2; i < v.length; i += 3) heights.add(Math.round(v[i]));
  }
  assert.ok(heights.size >= 2, `two ring heights, got ${[...heights]}`);
  assert.ok(
    [...heights].every((h) => h > 200),
    'ground height plus AGL',
  );
  assert.equal(
    [...heights].includes(240) && [...heights].includes(280),
    true,
    `rings at 40 and 80 m AGL over 200 m ground: ${[...heights]}`,
  );
  assert.equal(
    source.entities.values.filter((e) => e.name === 'Takeoff').length,
    1,
  );
  assert.equal(
    markers(source).filter((e) => e.point.heightReference === undefined)
      .length > 0,
    true,
    'orbit markers float',
  );
});

test('hiding a pass removes only its entities; showing it brings them back', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const passes = suitePasses();
  preview.showSuite(passes);
  const before = Object.fromEntries(
    SUITE_IDS.map((id) => [id, polylines(source, id).length]),
  );
  const total = source.entities.values.length;
  preview.setSuiteHidden(['oblique60']);
  assert.equal(polylines(source, 'oblique60').length, 0);
  for (const id of SUITE_IDS.filter((i) => i !== 'oblique60')) {
    assert.equal(polylines(source, id).length, before[id], id);
  }
  assert.ok(source.entities.values.length < total);
  assert.equal(
    source.entities.values.filter((e) => e.name === 'Takeoff').length,
    1,
  );
  preview.setSuiteHidden([]);
  assert.equal(source.entities.values.length, total);
  preview.showSuite(passes, SUITE_IDS);
  assert.equal(
    source.entities.values.filter((e) => e.polyline).length,
    0,
    'everything hidden',
  );
});

test('clear, showSuite(null) and a hidden-all suite remove suite entities; showPlan is independent', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const single = result(300, 200);
  preview.showPlan(single);
  const planCount = source.entities.values.length;
  preview.showSuite(suitePasses());
  assert.ok(source.entities.values.length > planCount);
  preview.showSuite(null);
  assert.equal(
    source.entities.values.length,
    planCount,
    'single plan untouched',
  );
  preview.showSuite(suitePasses());
  preview.showPlan(null);
  assert.ok(
    polylines(source, 'nadir').length > 0,
    'showPlan(null) keeps the suite',
  );
  preview.clear();
  assert.equal(source.entities.values.length, 0);
  preview.setSuiteHidden(['nadir']);
  assert.equal(
    source.entities.values.length,
    0,
    'cleared suite is not revived',
  );
  preview.showSuite(suitePasses());
  assert.ok(source.entities.values.length > 0);
});

test('a pass with no result is skipped and the others still draw', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const passes = suitePasses();
  passes[1] = { ...passes[1], result: null, error: { code: 'x' } };
  preview.showSuite(passes);
  assert.equal(polylines(source, 'oblique60').length, 0);
  assert.ok(polylines(source, 'nadir').length > 0);
});

test('MAX_MARKERS bounds the markers across all passes combined', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const passes = suitePasses({ big: true });
  const total = passes.reduce((n, p) => n + p.result.totals.waypointCount, 0);
  const missions = passes.reduce((n, p) => n + p.result.missions.length, 0);
  assert.ok(total > MAX_MARKERS * 2, `fixture is large enough: ${total}`);
  preview.showSuite(passes);
  // Each path keeps its last waypoint, so at most two extra markers per path.
  assert.ok(markers(source).length <= MAX_MARKERS + 2 * missions);
  assert.ok(
    markers(source).length > MAX_MARKERS / 2,
    'still drawn, only thinned',
  );
  assert.equal(
    source.entities.values.filter((e) => e.polyline).length,
    missions,
    'every path is kept',
  );
});

test('destroy removes the suite entities with the data source', async () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  preview.showSuite(suitePasses());
  await preview.destroy();
  assert.equal(source.entities.values.length, 0);
  preview.showSuite(suitePasses());
  assert.equal(source.entities.values.length, 0, 'no drawing after destroy');
});
