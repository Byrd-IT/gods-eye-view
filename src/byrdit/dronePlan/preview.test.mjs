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
import { ALPHA_RANGE, DEFAULT_ALPHA } from './checkLayer.js';

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
  const { preview, source } = checkRig({ frustum: 'one' });
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
  preview.setCheck({ zone: true, footprints: false });
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
  const { preview, source } = checkRig({ frustum: 'thinned' }, big);
  assert.ok(preview.checkInfo().count > MAX_FOOTPRINTS);
  assert.ok(footprints(source).length <= MAX_FOOTPRINTS);
  assert.ok(views(source).length <= MAX_FRUSTUMS * 5);
  assert.equal(zones(source).length, big.missions.length);
});

test('3D check: a footprint is shaded on the ground, classified onto 3D tiles', () => {
  const { source } = checkRig({ frustum: 'off' });
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
    footprints: false,
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
  const { preview, source } = checkRig({ frustum: 'one' }, planned);
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
  const planned = result(200, 200, { aglM: 60, obstacles: [tallTower()] });
  preview.showPlan(planned);
  const red = source.entities.values.filter((e) => e.name === 'Blocked by obstacle');
  assert.ok(red.length >= 1, 'a blocked leg is drawn red');
  assert.equal(red[0].polyline.material.css, '#ff2d2d');
  preview.setObstacles([tallTower()]);
  assert.equal(preview.obstacleCount(), 1);
  assert.equal(source.entities.values.filter((e) => e.cylinder).length, 1);
  const clear = result(200, 200, { aglM: 60, obstacles: [tallTower({ heightM: 20 })] });
  preview.showPlan(clear);
  assert.equal(
    source.entities.values.filter((e) => e.name === 'Blocked by obstacle').length,
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
            assert.ok(Math.hypot(p.x, p.y) <= fp.reachM + 0.5, `${label}: reach`);
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

test('transparency: the defaults are today\'s values on every layer', () => {
  const { source } = checkRig({ frustum: 'one' });
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
  const { preview, source } = checkRig({ frustum: 'one' });
  preview.setCheck({ alpha: { ...DEFAULT_ALPHA, footprint: 0.3 } });
  assert.equal(alphaOf(footprints(source)[0]), 0.3);
  assert.equal(alphaOf(zones(source)[0]), 0.16);
  assert.equal(alphaOf(curtains(source)[0]), 0.1);
  preview.setCheck({ alpha: { ...DEFAULT_ALPHA, zone: 0.5, curtain: 0, view: 0.4 } });
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
  const { preview, source } = checkRig({ frustum: 'off' });
  preview.setCheck({ alpha: { ...DEFAULT_ALPHA, footprint: 7, zone: -1 } });
  assert.equal(alphaOf(footprints(source)[0]), ALPHA_RANGE.footprint.max);
  assert.equal(alphaOf(zones(source)[0]), 0);
});

// ------------------------------------------- the photo being stepped through --
const currents = (source) => layerOf(source, '3D check current photo');

test('current photo: its footprint is drawn stronger with an outline, and follows the stepper', () => {
  const { preview, source } = checkRig({ frustum: 'one', index: 0 });
  const fillOf = () => currents(source).find((e) => e.polygon);
  const lineOf = () => currents(source).find((e) => e.polyline);
  assert.ok(fillOf(), 'a highlighted footprint');
  assert.ok(lineOf(), 'and its outline');
  assert.ok(fillOf().polygon.material.a >= 0.3, 'stronger than the faint stack');
  assert.ok(fillOf().polygon.material.a > alphaOf(footprints(source)[0]));
  assert.ok(lineOf().polyline.material.a > 0.9);
  const first = fillOf().polygon.hierarchy.join(',');
  preview.setCheck({ index: 5 });
  assert.equal(currents(source).length, 2, 'still one photo highlighted');
  assert.notEqual(fillOf().polygon.hierarchy.join(','), first, 'it moved');
  assert.equal(preview.checkCounts().current, 2);
});

test('current photo: it is not drawn when the 3D check or footprints are off', () => {
  const { preview, source } = checkRig({ frustum: 'off', footprints: false });
  assert.equal(currents(source).length, 0);
  preview.setCheck({ footprints: true });
  assert.equal(currents(source).length, 2);
  preview.setCheck({ enabled: false });
  assert.equal(checkEntities(source).length, 0);
});
