import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MARKERS,
  MISSION_COLORS,
  PASS_STYLES,
  batteryPauseEstimate,
  createDronePlanPreview,
  passStyle,
} from './preview.js';
import { batteryBreaks } from './batteryBreaks.js';
import { batteryPauseLabel } from './format.js';
import { assembleMissions, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';
import { suiteOptions } from './suite.js';
import {
  MAX_FOOTPRINTS,
  MAX_FRUSTUMS,
  MAX_REACH_M,
  footprintReachM,
  pointInFrame,
  photoFootprint,
  photoHeadingDeg,
  thinIndexes,
} from './checkGeometry.js';
import { getPreset } from './presets.js';
import {
  ALPHA_RANGE,
  DEFAULT_ALPHA,
  DEFAULT_CHECK_OPTIONS,
  footprintMode,
} from './checkLayer.js';

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
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    CornerType: { MITERED: 'mitered', BEVELED: 'beveled' },
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
function result(width, height, options = {}, extraGround = {}) {
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
    ...extraGround,
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
  // Rings come from viewing angles now (25, 40, 55 degrees down): three
  // heights, each above the one before.
  assert.equal(heights.size, 3, `three ring heights, got ${[...heights]}`);
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

// ------------------------------------------------------------ 3D check --
const FRAME = getPreset('dji-mini-4-pro');
const layerOf = (source, prefix) =>
  source.entities.values.filter((e) => e.name?.startsWith(prefix));
const zones = (source) => layerOf(source, '3D check zone');
const curtains = (source) => layerOf(source, '3D check curtain');
const footprints = (source) => layerOf(source, '3D check footprint');
const views = (source) => layerOf(source, '3D check view');
const checkEntities = (source) => layerOf(source, '3D check');
function checkRig(options = {}, planned = result(300, 200, { aglM: 80 })) {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  preview.setCheck({ enabled: true, frame: FRAME, ...options });
  preview.showPlan(planned);
  return { viewer, preview, source };
}

test('3D check: a bare preview draws nothing extra until the panel enables it', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  preview.showPlan(result(300, 200));
  assert.equal(checkEntities(viewer.dataSources.sources[0]).length, 0);
});

test('3D check: footprint maths - nadir is a rectangle of the expected size', () => {
  const wp = { lon: -97.77, lat: 30.27, aglM: 100, groundM: 0, pitchDeg: -90 };
  const fp = photoFootprint(wp, 90, FRAME);
  const across = (100 * FRAME.sensorWidthMm) / FRAME.focalMm;
  const along = (100 * FRAME.sensorHeightMm) / FRAME.focalMm;
  assert.ok(Math.abs(fp.widthNearM - across) < 0.5, `${fp.widthNearM}`);
  assert.ok(Math.abs(fp.widthFarM - across) < 0.5);
  assert.ok(Math.abs(fp.depthM - along) < 0.5, `${fp.depthM}`);
  assert.equal(fp.clipped, false);
  assert.equal(fp.corners.length, 4);
  // Heading east: the long side of the frame runs north-south.
  const m = metersPerDegree(30.27);
  const ns = Math.abs(fp.corners[0].lat - fp.corners[1].lat) * m.lat;
  assert.ok(Math.abs(ns - across) < 0.5, `north-south ${ns}`);
});

test('3D check: a tilted footprint is a trapezoid, wider and farther on the far side', () => {
  const wp = { lon: -97.77, lat: 30.27, aglM: 100, groundM: 0, pitchDeg: -45 };
  const fp = photoFootprint(wp, 0, FRAME);
  assert.ok(fp.widthFarM > fp.widthNearM * 1.5);
  // The frame's half height over the focal length is the half view angle.
  const half = Math.atan(FRAME.sensorHeightMm / 2 / FRAME.focalMm);
  const tilt = Math.PI / 4;
  const near = 100 / Math.tan(tilt + half);
  const far = 100 / Math.tan(tilt - half);
  assert.ok(Math.abs(fp.depthM - (far - near)) < 1, `${fp.depthM}`);
  // Facing north: the far edge is north of the drone, the near edge too.
  assert.ok(fp.corners[2].lat > fp.corners[0].lat);
});

test('3D check: a ray above the horizon is cut, not sent to infinity', () => {
  const wp = { lon: -97.77, lat: 30.27, aglM: 100, groundM: 0, pitchDeg: -20 };
  const fp = photoFootprint(wp, 0, FRAME);
  assert.equal(fp.clipped, true);
  assert.ok(fp.depthM <= 1001);
});

test('3D check: a waypoint without a heading faces along the flight', () => {
  const wps = [
    { lon: -97.77, lat: 30.27 },
    { lon: -97.769, lat: 30.27 },
  ];
  assert.ok(Math.abs(photoHeadingDeg(wps, 0) - 90) < 0.5);
  assert.ok(Math.abs(photoHeadingDeg(wps, 1) - 90) < 0.5, 'last looks back');
  assert.equal(photoHeadingDeg([{ lon: 1, lat: 1, headingDeg: 33 }], 0), 33);
  assert.deepEqual(thinIndexes(10, 4), [0, 3, 6, 9]);
  assert.equal(thinIndexes(3, 10).length, 3);
});

test('3D check: zone corridor half-width follows the slider and flies at the real height', () => {
  const { preview, source } = checkRig({ halfWidthM: 10, frustum: 'off' });
  const first = zones(source);
  assert.ok(first.length >= 1);
  const shape = first[0].polylineVolume.shape;
  assert.equal(shape[1].x - shape[0].x, 20, 'default 10 m each side');
  assert.equal(first[0].polylineVolume.cornerType, 'beveled');
  assert.equal(shape[2].y - shape[1].y, 20, 'above and below too');
  const heights = first[0].polylineVolume.positions.heights;
  const w0 = result(300, 200, { aglM: 80 }).missions[0].waypoints[0];
  assert.equal(heights[2], (w0.groundM ?? 0) + w0.aglM);
  preview.setCheck({ halfWidthM: 25 });
  const next = zones(source);
  assert.equal(
    next[0].polylineVolume.shape[1].x - next[0].polylineVolume.shape[0].x,
    50,
  );
  assert.equal(next.length, first.length);
  preview.setCheck({ halfWidthM: 500 });
  const clamped = zones(source)[0].polylineVolume.shape;
  assert.equal(clamped[1].x - clamped[0].x, 60, 'slider range is 2 to 30 m');
});

test('3D check: each toggle adds and removes only its own entities', () => {
  const { preview, source } = checkRig({ frustum: 'one', footprints: 'all' });
  assert.ok(zones(source).length && curtains(source).length);
  assert.ok(footprints(source).length && views(source).length);
  const keep = (list) => list.slice();
  const before = {
    zone: keep(zones(source)),
    curtain: keep(curtains(source)),
    foot: keep(footprints(source)),
    view: keep(views(source)),
    plan: source.entities.values.filter((e) => !e.name?.startsWith('3D check')),
  };
  const same = (a, b) => a.length === b.length && a.every((e, i) => e === b[i]);
  preview.setCheck({ curtain: false });
  assert.equal(curtains(source).length, 0);
  assert.ok(same(zones(source), before.zone), 'zone untouched');
  assert.ok(same(footprints(source), before.foot), 'footprints untouched');
  assert.ok(same(views(source), before.view), 'view untouched');
  preview.setCheck({ curtain: true, zone: false });
  assert.equal(zones(source).length, 0);
  assert.ok(curtains(source).length);
  assert.ok(same(footprints(source), before.foot));
  preview.setCheck({ zone: true, footprints: 'off' });
  assert.equal(footprints(source).length, 0);
  assert.ok(views(source).length, 'pyramid stays when footprints go');
  preview.setCheck({ frustum: 'off' });
  assert.equal(views(source).length, 0);
  assert.ok(zones(source).length && curtains(source).length);
  const plan = source.entities.values.filter(
    (e) => !e.name?.startsWith('3D check'),
  );
  assert.ok(same(plan, before.plan), 'path and markers never touched');
  preview.setCheck({ enabled: false });
  assert.equal(checkEntities(source).length, 0);
});

test('3D check: the curtain is a wall from the flight height down to the ground', () => {
  const { source } = checkRig(
    { frustum: 'off' },
    result(300, 200, { aglM: 80 }),
  );
  const wall = curtains(source)[0].wall;
  assert.equal(wall.minimumHeights.length, wall.positions.heights.length / 3);
  assert.ok(wall.material.a < 0.2, 'faint');
});

test('3D check: one pyramid by default; the index steps it; thinned shows many within the cap', () => {
  const { preview, source } = checkRig({ frustum: 'one', index: 0 });
  assert.equal(views(source).length, 5, '4 faces and an edge line');
  const apex = (e) =>
    e.polygon.hierarchy.heights?.slice(0, 3) ?? e.polygon.hierarchy;
  const at0 = views(source)[0].polygon.hierarchy.heights.slice(0, 3);
  preview.setCheck({ index: 7 });
  assert.equal(views(source).length, 5);
  const at7 = views(source)[0].polygon.hierarchy.heights.slice(0, 3);
  assert.notDeepEqual(at0, at7, 'the pyramid moved');
  assert.equal(preview.checkInfo().index, 7);
  assert.ok(preview.checkInfo().count > 8);
  preview.setCheck({ index: 99999 });
  assert.equal(preview.checkInfo().index, preview.checkInfo().count - 1);
  preview.setCheck({ frustum: 'thinned' });
  assert.ok(views(source).length > 5);
  assert.ok(views(source).length <= MAX_FRUSTUMS * 5);
  assert.ok(apex);
});

test('3D check: entity caps hold on a plan of about 600 photos or more', () => {
  const big = result(1500, 1200, { aglM: 60, batteryMin: 60 });
  const { preview, source } = checkRig(
    { frustum: 'thinned', footprints: 'all' },
    big,
  );
  assert.ok(preview.checkInfo().count > MAX_FOOTPRINTS);
  assert.ok(footprints(source).length <= MAX_FOOTPRINTS);
  assert.ok(views(source).length <= MAX_FRUSTUMS * 5);
  assert.equal(zones(source).length, big.missions.length);
});

test('3D check: a footprint is shaded on the ground, classified onto 3D tiles', () => {
  const { source } = checkRig({ frustum: 'off', footprints: 'all' });
  const poly = footprints(source)[0].polygon;
  assert.equal(poly.classificationType, 'both');
  assert.equal(poly.hierarchy.length, 8, 'four lon/lat corners');
  assert.ok(poly.material.a < 0.4, 'see-through');
});

test('3D check: it follows each pass checkbox and is coloured per pass', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  preview.setCheck({
    enabled: true,
    frame: FRAME,
    frustum: 'off',
    footprints: 'off',
  });
  preview.showSuite(suitePasses());
  const ids = (list) =>
    new Set(list.map((e) => e.name.split(': ')[1].split(' ')[0]));
  assert.deepEqual([...ids(zones(source))].sort(), [...SUITE_IDS].sort());
  const nadirZone = zones(source).find((e) => e.name.includes(': nadir'));
  assert.equal(nadirZone.polylineVolume.material.css, PASS_STYLES.nadir.color);
  preview.setSuiteHidden(['nadir', 'orbit']);
  assert.deepEqual([...ids(zones(source))].sort(), ['oblique45', 'oblique60']);
  assert.deepEqual([...ids(curtains(source))].sort(), [
    'oblique45',
    'oblique60',
  ]);
  preview.setSuiteHidden(SUITE_IDS);
  assert.equal(checkEntities(source).length, 0);
  preview.setSuiteHidden([]);
  assert.equal(ids(zones(source)).size, 4);
});

test('3D check: re-syncing the same plan does not rebuild the layers', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  preview.setCheck({ enabled: true, frame: FRAME });
  const passes = suitePasses();
  preview.showSuite(passes);
  const before = zones(source).slice();
  preview.showPlan(null);
  preview.showSuite(passes);
  const after = zones(source);
  assert.ok(before.length && before.every((e, i) => e === after[i]));
});

test('3D check: clear, replan and destroy remove every check entity', async () => {
  const { viewer, preview, source } = checkRig({ frustum: 'thinned' });
  assert.ok(checkEntities(source).length > 0);
  preview.showPlan(result(200, 200, { aglM: 70 }));
  assert.ok(checkEntities(source).length > 0, 'a new plan replaces the layers');
  const n = zones(source).length;
  assert.equal(n, result(200, 200, { aglM: 70 }).missions.length);
  preview.showPlan(null);
  assert.equal(checkEntities(source).length, 0, 'replan clears');
  preview.showPlan(result(200, 200));
  preview.showSuite(suitePasses());
  preview.clear();
  assert.equal(source.entities.values.length, 0, 'clear removes everything');
  preview.showPlan(result(200, 200));
  await preview.destroy();
  assert.equal(viewer.dataSources.sources.length, 0);
  assert.equal(source.entities.values.length, 0);
});

test('3D check: no footprints or pyramids without a camera', () => {
  const { source } = checkRig({ frame: null });
  assert.equal(footprints(source).length + views(source).length, 0);
  assert.ok(zones(source).length && curtains(source).length);
});

test('3D check: an interval-photo plan still shows footprints and pyramids at the photo spots', () => {
  const planned = result(300, 200, { aglM: 80, photoMode: 'interval' });
  const { preview, source } = checkRig(
    { frustum: 'one', footprints: 'all' },
    planned,
  );
  const info = preview.checkInfo();
  const expected = planned.totals.photoCount;
  assert.ok(info.count > 0, 'photos found');
  assert.ok(
    Math.abs(info.count - expected) <= planned.missions[0].legs.length + 1,
    `${info.count} vs ${expected}`,
  );
  assert.ok(footprints(source).length > 0);
  assert.equal(views(source).length, 5);
  assert.ok(info.current.footprint.depthM > 0);
  assert.ok(Number.isFinite(info.current.headingDeg));
  preview.setCheck({ index: 3 });
  assert.equal(preview.checkInfo().index, 3);
});

const tallTower = (over = {}) => ({
  id: 'faa-1',
  kind: 'tower',
  lon: -97.77,
  lat: 30.27,
  radiusM: 6,
  heightM: 150,
  source: 'faa',
  estimatedHeightM: 150,
  userEdited: false,
  ...over,
});

test('obstacles: columns are drawn with the plan, and a leg the cap cannot lift is red', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  // The planner clamps a column to 400 m, so the 1500 ft maximum is only out
  // of reach for a column standing on higher ground than the route.
  const planned = result(
    200,
    200,
    { aglM: 60, obstacles: [tallTower({ heightM: 380 })] },
    { obstacleM: { 'faa-1': 100 } },
  );
  preview.showPlan(planned);
  const red = source.entities.values.filter(
    (e) => e.name === 'Blocked by obstacle',
  );
  assert.ok(red.length >= 1, 'a blocked leg is drawn red');
  assert.equal(red[0].polyline.material.css, '#ff2d2d');
  preview.setObstacles([tallTower()]);
  assert.equal(preview.obstacleCount(), 1);
  assert.equal(source.entities.values.filter((e) => e.cylinder).length, 1);
  const clear = result(200, 200, {
    aglM: 60,
    obstacles: [tallTower({ heightM: 20 })],
  });
  preview.showPlan(clear);
  assert.equal(
    source.entities.values.filter((e) => e.name === 'Blocked by obstacle')
      .length,
    0,
    'a liftable obstacle leaves no red leg',
  );
  preview.clear();
  assert.equal(source.entities.values.length, 0);
  assert.equal(preview.obstacleCount(), 0);
});

// ----------------------------------------------- footprint = camera frame --
const groundXY = (wp, corner) => {
  const m = metersPerDegree(wp.lat);
  return {
    x: (corner.lon - wp.lon) * m.lon,
    y: (corner.lat - wp.lat) * m.lat,
  };
};

test('footprints: every corner and edge point of a tilted or orbit shot lies inside the camera frame', () => {
  for (const frame of [FRAME, getPreset('dji-air-3')]) {
    for (const pitchDeg of [-90, -80, -60, -45, -35, -30, -25, -20, -10]) {
      for (const heading of [0, 37, 90, 200, 315]) {
        for (const aglM of [15, 40, 100, 120]) {
          const wp = { lon: -97.77, lat: 30.27, aglM, groundM: 0, pitchDeg };
          const fp = photoFootprint(wp, heading, frame);
          const label = `${frame.id} pitch ${pitchDeg} hdg ${heading} agl ${aglM}`;
          if (fp.empty) {
            assert.equal(fp.corners.length, 0, label);
            continue;
          }
          assert.equal(fp.corners.length, 4, label);
          const pts = fp.corners.map((c) => groundXY(wp, c));
          for (let i = 0; i < 4; i += 1) {
            const a = pts[i];
            const b = pts[(i + 1) % 4];
            for (const k of [0, 0.25, 0.5, 0.75, 1]) {
              const x = a.x + (b.x - a.x) * k;
              const y = a.y + (b.y - a.y) * k;
              // Straight edges between ground points of the frame edge sit
              // a hair outside a curved frame edge only by rounding.
              assert.ok(
                pointInFrame(wp, heading, frame, x, y, 0.02) ||
                  Math.hypot(x, y) < 0.5,
                `${label}: edge ${i} at ${k} outside the frame`,
              );
            }
          }
          assert.ok(
            fp.depthM <= fp.reachM + 1e-6 + Math.hypot(fp.widthFarM, 0),
            label,
          );
          for (const p of pts) {
            assert.ok(
              Math.hypot(p.x, p.y) <= fp.reachM + 0.5,
              `${label}: reach`,
            );
          }
        }
      }
    }
  }
});

test('footprints: no stretch to the horizon, the reach is tied to the shot height', () => {
  const wp = { lon: -97.77, lat: 30.27, aglM: 100, groundM: 0, pitchDeg: -20 };
  const fp = photoFootprint(wp, 0, FRAME);
  assert.equal(fp.clipped, true);
  assert.equal(fp.reachM, footprintReachM(100));
  assert.ok(fp.reachM < MAX_REACH_M / 2, 'nowhere near 1000 m');
  assert.ok(fp.depthM <= fp.reachM);
  // Even the far side stays within the reach.
  const far = groundXY(wp, fp.corners[2]);
  assert.ok(Math.hypot(far.x, far.y) <= fp.reachM + 0.5);
  // The ceiling still holds for a very high shot.
  assert.equal(footprintReachM(5000), MAX_REACH_M);
  assert.ok(footprintReachM(1) >= 40, 'a low shot still shows ground');
});

test('footprints: 45 and 60 degree shots are whole frames, not clipped, and shorter than before', () => {
  for (const pitchDeg of [-45, -60]) {
    const wp = { lon: -97.77, lat: 30.27, aglM: 80, groundM: 0, pitchDeg };
    const fp = photoFootprint(wp, 90, FRAME);
    assert.equal(fp.clipped, false, `pitch ${pitchDeg}`);
    const half = Math.atan(FRAME.sensorHeightMm / 2 / FRAME.focalMm);
    const tilt = (-pitchDeg * Math.PI) / 180;
    const near = 80 / Math.tan(tilt + half);
    const far = 80 / Math.tan(tilt - half);
    assert.ok(Math.abs(fp.depthM - (far - near)) < 1, `${fp.depthM}`);
  }
});

test('footprints: a shot whose whole frame is beyond the reach draws nothing', () => {
  // Looking up: no ground at all.
  const up = photoFootprint(
    { lon: -97.77, lat: 30.27, aglM: 80, groundM: 0, pitchDeg: 30 },
    0,
    FRAME,
  );
  assert.equal(up.empty, true);
  assert.deepEqual(up.corners, []);
});

// ------------------------------------------------- per-layer transparency --
const alphaOf = (e) =>
  (e.polygon ?? e.polylineVolume ?? e.polyline ?? e.wall)?.material?.a;

test("transparency: the defaults are today's values on every layer", () => {
  const { source } = checkRig({ frustum: 'one', footprints: 'all' });
  assert.equal(zones(source).length > 0, true);
  assert.equal(alphaOf(zones(source)[0]), 0.16);
  assert.equal(alphaOf(curtains(source)[0]), 0.1);
  assert.equal(alphaOf(footprints(source)[0]), 0.05);
  const fills = views(source).filter((e) => e.polygon);
  assert.ok(fills.length > 0);
  assert.equal(alphaOf(fills[0]), 0.2);
  const edges = views(source).filter((e) => e.polyline);
  assert.ok(edges.length > 0);
  assert.ok(Math.abs(alphaOf(edges[0]) - 0.9) < 1e-9);
});

test('transparency: each layer follows its own level and the others stay put', () => {
  const { preview, source } = checkRig({ frustum: 'one', footprints: 'all' });
  preview.setCheck({ alpha: { ...DEFAULT_ALPHA, footprint: 0.3 } });
  assert.equal(alphaOf(footprints(source)[0]), 0.3);
  assert.equal(alphaOf(zones(source)[0]), 0.16);
  assert.equal(alphaOf(curtains(source)[0]), 0.1);
  preview.setCheck({
    alpha: { ...DEFAULT_ALPHA, zone: 0.5, curtain: 0, view: 0.4 },
  });
  assert.equal(alphaOf(zones(source)[0]), 0.5);
  assert.equal(alphaOf(curtains(source)[0]), 0);
  assert.equal(alphaOf(views(source).find((e) => e.polygon)), 0.4);
  assert.ok(
    Math.abs(alphaOf(views(source).find((e) => e.polyline)) - 1) < 1e-9,
    'edges keep their 4.5 : 1 ratio, capped at 1',
  );
  assert.equal(alphaOf(footprints(source)[0]), 0.05);
});

test('transparency: levels are clamped to the slider range', () => {
  const { preview, source } = checkRig({ frustum: 'off', footprints: 'all' });
  preview.setCheck({ alpha: { ...DEFAULT_ALPHA, footprint: 7, zone: -1 } });
  assert.equal(alphaOf(footprints(source)[0]), ALPHA_RANGE.footprint.max);
  assert.equal(alphaOf(zones(source)[0]), 0);
});

// ------------------------------------------- the photo being stepped through --
const currents = (source) => layerOf(source, '3D check current photo');

test('current photo: its footprint is drawn stronger with an outline, and follows the stepper', () => {
  const { preview, source } = checkRig({
    frustum: 'one',
    index: 0,
    footprints: 'all',
  });
  const fillOf = () => currents(source).find((e) => e.polygon);
  const lineOf = () => currents(source).find((e) => e.polyline);
  assert.ok(fillOf(), 'a highlighted footprint');
  assert.ok(lineOf(), 'and its outline');
  assert.ok(
    fillOf().polygon.material.a >= 0.3,
    'stronger than the faint stack',
  );
  assert.ok(fillOf().polygon.material.a > alphaOf(footprints(source)[0]));
  assert.ok(lineOf().polyline.material.a > 0.9);
  const first = fillOf().polygon.hierarchy.join(',');
  preview.setCheck({ index: 5 });
  assert.equal(currents(source).length, 2, 'still one photo highlighted');
  assert.notEqual(fillOf().polygon.hierarchy.join(','), first, 'it moved');
  assert.equal(preview.checkCounts().current, 2);
});

test('current photo: it is not drawn when the 3D check or footprints are off', () => {
  const { preview, source } = checkRig({ frustum: 'off', footprints: 'off' });
  assert.equal(currents(source).length, 0);
  preview.setCheck({ footprints: 'selected' });
  assert.equal(currents(source).length, 2);
  preview.setCheck({ enabled: false });
  assert.equal(checkEntities(source).length, 0);
});

// ----------------------------------------------------- imported files --
function importPasses(count = 12) {
  const m = metersPerDegree(30.27);
  const waypoints = Array.from({ length: count }, (_, i) => ({
    lon: -97.77 + (i * 10) / m.lon,
    lat: 30.27,
    groundM: 0,
    aglM: 60,
    pitchDeg: -55,
    headingDeg: 90,
    photo: true,
  }));
  return [{ id: 'import-1', color: '#ff8800', missions: [{ waypoints }] }];
}

test('imported files: setImportCheck feeds the 3D check with one footprint and pyramid per station', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  preview.setCheck({
    enabled: true,
    frame: FRAME,
    frustum: 'thinned',
    footprints: 'all',
  });
  assert.equal(checkEntities(source).length, 0);
  preview.setImportCheck(importPasses(12));
  assert.equal(preview.checkInfo().count, 12);
  assert.equal(footprints(source).length, 12);
  assert.equal(views(source).length, 12 * 5);
  assert.ok(zones(source).length && curtains(source).length);
  preview.setImportCheck(null);
  assert.equal(checkEntities(source).length, 0);
  assert.equal(preview.checkInfo().count, 0);
});

test('imported files: a plan built in the panel wins, and the import returns when it goes', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  preview.setCheck({ enabled: true, frame: FRAME, frustum: 'off' });
  preview.setImportCheck(importPasses(6));
  assert.equal(preview.checkInfo().count, 6);
  const planned = result(300, 200, { aglM: 80 });
  preview.showPlan(planned);
  const total = planned.missions.reduce((n, mi) => n + mi.waypoints.length, 0);
  assert.equal(
    preview.checkInfo().count,
    total,
    'the panel plan is checked, not the import',
  );
  preview.showPlan(null);
  assert.equal(
    preview.checkInfo().count,
    6,
    'import back once there is no plan',
  );
  preview.clear();
  assert.equal(preview.checkInfo().count, 0, 'clear removes it');
});

// ------------------------------------------- photo footprints: 3 settings --
const currentLayer = (source) => layerOf(source, '3D check current photo');
const polygonsOf = (list) => list.filter((e) => e.polygon);
const outlinesOf = (list) => list.filter((e) => e.polyline);

test('footprints: the default is the selected photo only - one fill, one outline, no bulk footprints', () => {
  const { source } = checkRig({});
  assert.equal(footprints(source).length, 0, 'no bulk footprints');
  const cur = currentLayer(source);
  assert.equal(polygonsOf(cur).length, 1, 'one filled footprint');
  assert.equal(outlinesOf(cur).length, 1, 'one outline');
});

test('footprints: all draws the bulk footprints and the photo in view', () => {
  const { source } = checkRig({ footprints: 'all' });
  assert.ok(footprints(source).length > 1);
  assert.equal(polygonsOf(currentLayer(source)).length, 1);
  assert.equal(outlinesOf(currentLayer(source)).length, 1);
});

test('footprints: off draws neither the bulk nor the photo in view', () => {
  const { source } = checkRig({ footprints: 'off' });
  assert.equal(footprints(source).length, 0);
  assert.equal(currentLayer(source).length, 0);
});

test('footprints: the photo in view shows with Camera view one, thinned and off', () => {
  for (const frustum of ['one', 'thinned', 'off']) {
    for (const mode of ['selected', 'all']) {
      const { source } = checkRig({ frustum, footprints: mode });
      assert.equal(
        polygonsOf(currentLayer(source)).length,
        1,
        `${frustum}/${mode}`,
      );
    }
    const { source } = checkRig({ frustum, footprints: 'off' });
    assert.equal(currentLayer(source).length, 0, `${frustum}/off`);
  }
});

test('footprints: stepping the photo moves the one shaded footprint', () => {
  const { preview, source } = checkRig({ index: 0 });
  const at = () => currentLayer(source)[0].polygon.hierarchy.join(',');
  const first = at();
  preview.setCheck({ index: 7 });
  assert.equal(polygonsOf(currentLayer(source)).length, 1);
  assert.notEqual(at(), first);
});

test('footprints: switching between the settings adds and removes only the footprint layers', () => {
  const { preview, source } = checkRig({});
  const zone = zones(source).slice();
  preview.setCheck({ footprints: 'all' });
  assert.ok(footprints(source).length > 1);
  preview.setCheck({ footprints: 'selected' });
  assert.equal(footprints(source).length, 0);
  assert.equal(polygonsOf(currentLayer(source)).length, 1);
  preview.setCheck({ footprints: 'off' });
  assert.equal(currentLayer(source).length, 0);
  assert.ok(
    zones(source).every((e, i) => e === zone[i]),
    'zone untouched',
  );
});

test('footprints: the old tick box values migrate - true to selected, false to off, unknown to selected', () => {
  assert.equal(footprintMode(true), 'selected');
  assert.equal(footprintMode(false), 'off');
  for (const v of ['selected', 'all', 'off']) assert.equal(footprintMode(v), v);
  for (const v of [undefined, null, 'bogus', 1, 0, {}]) {
    assert.equal(footprintMode(v), 'selected', String(v));
  }
  const old = checkRig({ footprints: true });
  assert.equal(footprints(old.source).length, 0);
  assert.equal(polygonsOf(currentLayer(old.source)).length, 1);
  assert.ok(old.preview.checkInfo().count > 0);
  old.preview.setCheck({ footprints: false });
  assert.equal(
    currentLayer(old.source).length,
    0,
    'a later boolean false is off',
  );
  old.preview.setCheck({ footprints: true });
  assert.equal(
    polygonsOf(currentLayer(old.source)).length,
    1,
    'a later true is selected',
  );
  assert.equal(footprints(old.source).length, 0);
  const off = checkRig({ footprints: false });
  assert.equal(currentLayer(off.source).length, 0);
  assert.equal(DEFAULT_CHECK_OPTIONS.footprints, 'selected');
});

// ------------------------------------------------------- battery pauses --
const PAUSE_NAME = 'Battery pause';
const pauseMarks = (source) =>
  source.entities.values.filter((e) => e.name === PAUSE_NAME);

function surveyBox(width, height) {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - width / 2 / m.lon,
    east: -97.77 + width / 2 / m.lon,
    south: 30.27 - height / 2 / m.lat,
    north: 30.27 + height / 2 / m.lat,
  };
}

/** A real planFlight result. The planner keeps usableBatteryMin on the
 * normalized options (default 20). `stamp` can still force the field onto
 * the assemble result, or `none` leaves only what planFlight wrote. */
function continuousPlan({
  width = 600,
  height = 300,
  usableBatteryMin = 12,
  stamp = 'options',
  captureMode = 'distance',
  continuousRoute = true,
  takeoffM = 40,
  extra = {},
} = {}) {
  const plan = planFlight(surveyBox(width, height), {
    aglM: 80,
    captureMode,
    continuousRoute,
    usableBatteryMin,
    batteryMin: 25,
    speedMs: 8,
    ...extra,
  });
  assert.equal(plan.error, undefined);
  const ids = plan.legs.flatMap((leg) => leg.waypoints.map((w) => w.id));
  const built = assembleMissions(plan, {
    known: true,
    takeoffM,
    wpM: ids.map(() => takeoffM),
  });
  if (stamp === 'options')
    built.plan.options.usableBatteryMin = usableBatteryMin;
  else if (stamp === 'result') built.usableBatteryMin = usableBatteryMin;
  return built;
}

function routeOf(mission) {
  return mission.waypoints.map((w) => ({
    lon: w.lon,
    lat: w.lat,
    relHeightM: w.relHeightM,
    ...(Number.isFinite(w.dwellS) ? { dwellS: w.dwellS } : {}),
  }));
}

function expectedPauses(result, usableMin) {
  const speedMs = result.plan.speedMs;
  const takeoff = {
    lon: result.plan.takeoff.lon,
    lat: result.plan.takeoff.lat,
  };
  return result.missions.flatMap((mission, missionIndex) =>
    batteryBreaks(mission.waypoints, {
      takeoff,
      speedMs,
      usableMin,
      legs: mission.legs,
    }).breaks.map((mark) => ({ missionIndex, mark })),
  );
}

test('a real continuous plan shows pause markers from the normalized 20 minute default', () => {
  const labels = [];
  const labelOverlay = {
    set(entries) {
      labels.splice(0, labels.length, ...entries);
    },
    clear() {
      labels.splice(0, labels.length);
    },
  };
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({
    viewer,
    cesium: fakeCesium(),
    labelOverlay,
  });
  const source = viewer.dataSources.sources[0];
  const plan = planFlight(surveyBox(1000, 600), {
    aglM: 80,
    captureMode: 'distance',
    continuousRoute: true,
    speedMs: 8,
  });
  assert.equal(plan.error, undefined);
  assert.equal(plan.options.usableBatteryMin, 20);
  const ids = plan.legs.flatMap((leg) => leg.waypoints.map((w) => w.id));
  const planned = assembleMissions(plan, {
    known: true,
    takeoffM: 40,
    wpM: ids.map(() => 40),
  });
  assert.equal(planned.plan.options.usableBatteryMin, 20);
  assert.equal(planned.usableBatteryMin, undefined);
  const expected = expectedPauses(planned, 20);
  assert.ok(expected.length > 0, 'the normalized default places pauses');
  const before = JSON.stringify(planned.missions.map((m) => m.waypoints));
  preview.showPlan(planned);
  const drawn = pauseMarks(source);
  assert.equal(drawn.length, expected.length);
  assert.equal(labels.length, expected.length);
  for (const [i, entity] of drawn.entries()) {
    const text = batteryPauseLabel(expected[i].mark);
    assert.equal(entity.label, undefined, 'no Cesium label');
    assert.equal(entity.pauseLabel, text);
    assert.equal(labels[i].title, text);
    assert.match(text, /Pause /);
  }
  assert.equal(
    JSON.stringify(planned.missions.map((m) => m.waypoints)),
    before,
  );
  preview.showPlan(null);
  assert.equal(labels.length, 0);
  preview.clear();
  assert.equal(source.entities.values.length, 0);
});

test('showPlan draws every interpolated pause for a continuous route, with distance and minutes, and does not add KMZ waypoints', () => {
  const labels = [];
  const labelOverlay = {
    set(entries) {
      labels.splice(0, labels.length, ...entries);
    },
    clear() {
      labels.splice(0, labels.length);
    },
  };
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({
    viewer,
    cesium: fakeCesium(),
    labelOverlay,
  });
  const source = viewer.dataSources.sources[0];
  const planned = continuousPlan({ usableBatteryMin: 12, takeoffM: 40 });
  const expected = expectedPauses(planned, 12);
  assert.ok(expected.length >= 1);
  assert.ok(
    expected.some(
      (item) => item.mark.fraction > 0.001 && item.mark.fraction < 0.999,
    ),
    'fixture includes a mark between vertices',
  );
  const waypointRefs = planned.missions.map((m) => m.waypoints);
  const waypointCount = planned.missions.map((m) => m.waypoints.length);
  const snapshot = JSON.stringify(planned.missions.map((m) => m.waypoints));
  preview.showPlan(planned);
  const drawn = pauseMarks(source);
  assert.equal(
    drawn.length,
    expected.length,
    'every helper mark, none invented',
  );
  assert.ok(
    drawn.some(
      (e) => e.batteryBreak.fraction > 0.001 && e.batteryBreak.fraction < 0.999,
    ),
    'interpolated marks are drawn, not dropped',
  );
  for (const [i, entity] of drawn.entries()) {
    const { missionIndex, mark } = expected[i];
    const info = entity.batteryBreak;
    assert.equal(info.missionIndex, missionIndex);
    assert.equal(info.index, mark.index);
    assert.equal(info.groundM, mark.groundM);
    assert.equal(info.routeM, mark.routeM);
    assert.equal(info.minutes, mark.minutes);
    assert.equal(info.durationS, mark.durationS);
    assert.equal(info.turnS, mark.turnS);
    assert.equal(info.photoCount, mark.photoCount);
    assert.equal(info.fraction, mark.fraction);
    assert.equal(info.addedWaypoint, false);
    assert.equal(info.disclaimer, undefined);
    assert.equal(entity.label, undefined, 'no Cesium label');
    assert.equal(entity.pauseLabel, batteryPauseLabel(mark));
    assert.equal(labels[i].title, entity.pauseLabel);
    assert.equal(labels[i].accessibilityLabel, entity.pauseLabel);
    assert.equal(entity.position[0], mark.lon);
    assert.equal(entity.position[1], mark.lat);
    assert.equal(entity.position[2], 40 + mark.relHeightM);
    assert.equal(
      entity.point.heightReference,
      undefined,
      'airborne, not clamped',
    );
    const onVertex = planned.missions[missionIndex].waypoints.some(
      (w) => w.lon === mark.lon && w.lat === mark.lat,
    );
    if (mark.fraction > 0.001 && mark.fraction < 0.999) {
      assert.equal(
        onVertex,
        false,
        'interpolated mark is not snapped to a waypoint',
      );
    }
  }
  const blob = JSON.stringify(drawn);
  assert.equal(/estimate only/i.test(blob), false);
  assert.equal(/\bwind\b/i.test(blob), false);
  assert.equal(
    JSON.stringify(planned.missions.map((m) => m.waypoints)),
    snapshot,
  );
  planned.missions.forEach((mission, i) => {
    assert.equal(mission.waypoints, waypointRefs[i]);
    assert.equal(mission.waypoints.length, waypointCount[i]);
  });
  preview.showPlan(planned);
  assert.equal(
    pauseMarks(source).length,
    expected.length,
    'redraw does not stack marks',
  );
  preview.showPlan(null);
  assert.equal(pauseMarks(source).length, 0);
  preview.clear();
  assert.equal(source.entities.values.length, 0);
});

test('usableBatteryMin on the assemble result is enough; a stop plan and a missing actual speed draw nothing', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const carried = continuousPlan({ stamp: 'result', usableBatteryMin: 12 });
  delete carried.plan.options.usableBatteryMin;
  assert.equal(carried.plan.options.usableBatteryMin, undefined);
  assert.equal(carried.usableBatteryMin, 12);
  preview.showPlan(carried);
  assert.equal(pauseMarks(source).length, expectedPauses(carried, 12).length);

  const stopped = continuousPlan({
    captureMode: 'stop',
    continuousRoute: false,
    usableBatteryMin: 12,
  });
  assert.equal(stopped.plan.options.continuousRoute, false);
  preview.showPlan(stopped);
  assert.equal(pauseMarks(source).length, 0);

  const noSpeed = continuousPlan({ usableBatteryMin: 12 });
  delete noSpeed.plan.speedMs;
  delete noSpeed.totals.speedMs;
  assert.ok(noSpeed.plan.options.speedMs > 0, 'requested speed is still there');
  preview.showPlan(noSpeed);
  assert.equal(
    pauseMarks(source).length,
    0,
    'requested speed is not the flown speed',
  );
});

test('a waypoint-capped continuous route pauses each file, not a route joined across files', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const planned = continuousPlan({
    width: 900,
    height: 700,
    captureMode: 'timed',
    usableBatteryMin: 10,
    extra: { maxWaypoints: 20, aglM: 70 },
  });
  assert.ok(planned.missions.length > 1);
  const perFile = expectedPauses(planned, 10);
  const joined = batteryBreaks(
    planned.missions.flatMap((mission) => routeOf(mission)),
    {
      takeoff: planned.plan.takeoff,
      speedMs: planned.plan.speedMs,
      usableMin: 10,
    },
  );
  assert.notEqual(perFile.length, joined.breaks.length);
  const before = planned.missions.map((m) => m.waypointCount);
  preview.showPlan(planned);
  assert.equal(pauseMarks(source).length, perFile.length);
  assert.deepEqual(
    planned.missions.map((m) => m.waypointCount),
    before,
    'pause marks are not KMZ waypoints',
  );
  preview.clear();
  assert.equal(pauseMarks(source).length, 0);
});

test('an unreachable round trip and a bad point draw no invented pause and do not throw', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const far = { lon: -95, lat: 30, relHeightM: 80 };
  const unreachable = {
    plan: {
      options: { continuousRoute: true, usableBatteryMin: 1 },
      speedMs: 5,
      takeoff: { lon: -97, lat: 30 },
    },
    missions: [
      {
        waypoints: [far, { lon: far.lon + 0.001, lat: 30, relHeightM: 80 }],
      },
    ],
    totals: { speedMs: 5 },
    ground: { known: true, takeoffM: 0 },
  };
  const helper = batteryBreaks(unreachable.missions[0].waypoints, {
    takeoff: unreachable.plan.takeoff,
    speedMs: 5,
    usableMin: 1,
  });
  assert.equal(helper.breaks.length, 0);
  assert.equal(helper.unreachable.reason, 'round-trip-exceeds-usable-minutes');
  assert.doesNotThrow(() => preview.showPlan(unreachable));
  assert.equal(pauseMarks(source).length, 0);

  const bad = continuousPlan({ usableBatteryMin: 12 });
  bad.missions[0].waypoints[0] = {
    ...bad.missions[0].waypoints[0],
    lon: Number.NaN,
  };
  assert.doesNotThrow(() => preview.showPlan(bad));
  assert.equal(pauseMarks(source).length, 0);
  assert.ok(source.entities.values.some((e) => e.name === 'Takeoff'));
});

test('a valid route whose legs do not match draws no invented pause and keeps the read error', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const planned = continuousPlan({ usableBatteryMin: 12 });
  const mission = planned.missions[0];
  mission.legs = [
    {
      waypoints: [
        mission.waypoints[0],
        { lon: 0, lat: 0, relHeightM: mission.waypoints[0].relHeightM },
      ],
      captureMode: 'distance',
      photoSpacingM: 25,
    },
  ];
  const estimate = batteryPauseEstimate(planned, 12);
  assert.equal(estimate.breaks.length, 0);
  assert.equal(estimate.covered, false);
  assert.match(estimate.errors[0].message, /match|flatten/);
  assert.doesNotThrow(() => preview.showPlan(planned));
  assert.equal(pauseMarks(source).length, 0);
});

test('showSuite draws pauses only on continuous passes, and hiding or clearing removes them', () => {
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  const passes = suiteOptions({
    presetId: 'dji-mini-4-pro',
    captureMode: 'distance',
    continuousRoute: true,
    usableBatteryMin: 15,
  }).map(({ id, label, options }) => {
    const plan = planFlight(surveyBox(500, 280), options);
    assert.equal(plan.error, undefined);
    const ids = plan.legs.flatMap((leg) => leg.waypoints.map((w) => w.id));
    const result = assembleMissions(plan, {
      known: true,
      takeoffM: 25,
      wpM: ids.map(() => 25),
    });
    result.usableBatteryMin = 15;
    return { id, label, error: null, result };
  });
  const orbit = passes.find((p) => p.id === 'orbit');
  assert.equal(orbit.result.plan.options.continuousRoute, false);
  const continuous = passes.filter(
    (p) => p.result.plan.options.continuousRoute === true,
  );
  assert.ok(continuous.length >= 1);
  assert.ok(continuous.every((p) => p.id !== 'orbit'));
  const expected = continuous.reduce(
    (n, p) => n + expectedPauses(p.result, 15).length,
    0,
  );
  assert.ok(expected > 0);
  preview.showSuite(passes);
  const drawn = pauseMarks(source);
  assert.equal(drawn.length, expected);
  assert.ok(drawn.every((e) => e.batteryBreak.passId !== 'orbit'));
  assert.ok(
    drawn.every((e) => continuous.some((p) => p.id === e.batteryBreak.passId)),
  );
  assert.ok(drawn.every((e) => Number.isFinite(e.batteryBreak.groundM)));
  assert.ok(drawn.every((e) => Number.isFinite(e.batteryBreak.minutes)));
  assert.equal(drawn[0].position[2], 25 + drawn[0].batteryBreak.relHeightM);
  const hiddenId = continuous[0].id;
  const hiddenCount = drawn.filter(
    (e) => e.batteryBreak.passId === hiddenId,
  ).length;
  assert.ok(hiddenCount > 0);
  preview.showSuite(passes, [hiddenId]);
  assert.equal(
    pauseMarks(source).filter((e) => e.batteryBreak.passId === hiddenId).length,
    0,
  );
  assert.equal(pauseMarks(source).length, expected - hiddenCount);
  preview.showSuite(null);
  assert.equal(pauseMarks(source).length, 0);
  preview.showSuite(passes);
  preview.showPlan(null);
  assert.equal(
    pauseMarks(source).length,
    expected,
    'showPlan(null) keeps suite pauses',
  );
  preview.clear();
  assert.equal(pauseMarks(source).length, 0);
  assert.equal(source.entities.values.length, 0);
});

test('pause labels receive a getter when production entity.position is a ConstantPositionProperty', () => {
  const labels = [];
  class ConstantPositionProperty {
    constructor(value) {
      this.value = value;
    }
    getValue() {
      return this.value;
    }
  }
  const base = fakeCesium();
  const cesium = {
    ...base,
    JulianDate: { now: () => 'tick' },
    Cartesian3: {
      ...base.Cartesian3,
      fromDegrees: (lon, lat, h = 0) => ({ x: lon, y: lat, z: h }),
    },
    CustomDataSource: class extends base.CustomDataSource {
      constructor(name) {
        super(name);
        const rawAdd = this.entities.add;
        this.entities.add = (entity) => {
          if (
            entity?.position &&
            typeof entity.position.getValue !== 'function'
          ) {
            return rawAdd({
              ...entity,
              position: new ConstantPositionProperty(entity.position),
            });
          }
          return rawAdd(entity);
        };
      }
    },
  };
  const viewer = fakeViewer();
  const preview = createDronePlanPreview({
    viewer,
    cesium,
    labelOverlay: {
      set(entries) {
        labels.splice(0, labels.length, ...entries);
      },
      clear() {
        labels.splice(0, labels.length);
      },
    },
  });
  const planned = continuousPlan({ usableBatteryMin: 12, takeoffM: 40 });
  const expected = expectedPauses(planned, 12);
  assert.ok(expected.length >= 1);
  preview.showPlan(planned);
  const drawn = pauseMarks(viewer.dataSources.sources[0]);
  assert.equal(drawn.length, expected.length);
  assert.equal(typeof drawn[0].position.getValue, 'function');
  assert.equal(labels.length, expected.length);
  for (const [i, entry] of labels.entries()) {
    const mark = expected[i].mark;
    const resolved =
      typeof entry.position === 'function' ? entry.position() : entry.position;
    assert.equal(typeof entry.position.getValue, 'undefined');
    assert.equal(Number.isFinite(resolved.x), true);
    assert.equal(Number.isFinite(resolved.y), true);
    assert.equal(Number.isFinite(resolved.z), true);
    assert.equal(resolved.x, mark.lon);
    assert.equal(resolved.y, mark.lat);
    assert.equal(resolved.z, 40 + mark.relHeightM);
  }
  preview.clear();
});
