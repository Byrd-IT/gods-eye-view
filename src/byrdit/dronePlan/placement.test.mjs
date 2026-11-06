/**
 * Where every Drone Flight Plan overlay sits on the globe, proved on sloping
 * ground, at changing flight heights, for generated plans and imported files,
 * with the terrain read and without it. Display only: no test here may see a
 * flight height, a waypoint or an exported value move.
 *
 * The intent of each overlay (displayHeights.js):
 *   waypoint marker / pyramid apex / corridor / curtain top  AIRBORNE
 *   ground track / footprint / takeoff / pyramid base          ON THE SURFACE
 *   obstacle column                                            ANCHORED at the obstruction
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDronePlanPreview } from './preview.js';
import { createObstacleLayer } from './obstacleLayer.js';
import {
  displayOffset,
  flightHeightM,
  shiftMission,
} from './displayHeights.js';
import { globeHeightM } from './globeHeight.js';
import { assembleMissions, planFlight } from './planner.js';
import { buildMissionFiles } from './wpml.js';
import { deriveImportShots, importCheckMission } from './importShots.js';
import { metersPerDegree } from './geo.js';
import { getPreset } from './presets.js';
import { parseDjiKmz } from './djiKmz.js';
import { east, kmz, mark, group, LAT } from './importKmzFixture.mjs';

// ------------------------------------------------------------- fakes ----
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
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat }) },
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
/** `globeHeight` is what the globe's own terrain says (null = cannot say). */
function fakeViewer(globeHeight = null) {
  const sources = [];
  return {
    scene: {
      requestRender() {},
      globe: {
        getHeight: (c) =>
          typeof globeHeight === 'function'
            ? globeHeight(c)
            : (globeHeight ?? undefined),
      },
    },
    dataSources: {
      sources,
      add: (s) => (sources.push(s), Promise.resolve(s)),
      remove: (s) => sources.splice(sources.indexOf(s), 1),
    },
  };
}

const FRAME = getPreset('dji-mini-4-pro');
const M = metersPerDegree(30.27);
const boxOf = (w, h) => ({
  west: -97.77 - w / 2 / M.lon,
  east: -97.77 + w / 2 / M.lon,
  south: 30.27 - h / 2 / M.lat,
  north: 30.27 + h / 2 / M.lat,
});

/**
 * A plan on a slope: the ground rises 0.1 m per waypoint id from 100 m, and
 * the takeoff is on the low side, so takeoff-relative and local heights differ.
 */
function slopedPlan(aglM, options = {}) {
  const plan = planFlight(boxOf(300, 200), { aglM, batteryMin: 60, ...options });
  const ids = plan.legs.flatMap((l) => l.waypoints.map((w) => w.id));
  const wpM = [];
  ids.forEach((id, i) => {
    wpM[id] = 100 + 0.1 * i;
  });
  return assembleMissions(plan, { known: true, takeoffM: 100, wpM });
}
function unknownPlan(aglM) {
  const plan = planFlight(boxOf(300, 200), { aglM, batteryMin: 60 });
  return assembleMissions(plan, { known: false });
}
const clone = (v) => JSON.parse(JSON.stringify(v));

function rig(globeHeight = null, checkOptions = {}) {
  const viewer = fakeViewer(globeHeight);
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  preview.setCheck({
    enabled: true,
    frame: FRAME,
    footprints: 'selected',
    frustum: 'one',
    ...checkOptions,
  });
  return { viewer, preview, source };
}
const named = (source, prefix) =>
  source.entities.values.filter((e) => (e.name ?? '').startsWith(prefix));
const markersOf = (source) =>
  source.entities.values.filter(
    (e) => e.point && !e.name && Array.isArray(e.position),
  );

// ------------------------------------------------- the pure height rules --
test('flightHeightM is the ground under the point plus its height above ground', () => {
  assert.equal(flightHeightM({ groundM: 130, aglM: 60 }), 190);
  assert.equal(flightHeightM({ groundM: 130, aglM: 60 }, 5), 195);
  assert.equal(flightHeightM({ aglM: 60 }), 60, 'no ground read: 0');
});

test('displayOffset: 0 when the terrain was read; the globe surface when it was not; unverified when neither', () => {
  assert.deepEqual(displayOffset({ known: true }, 250), {
    offsetM: 0,
    verified: true,
  });
  assert.deepEqual(displayOffset({ known: false }, 250), {
    offsetM: 250,
    verified: true,
  });
  assert.deepEqual(displayOffset({ known: false }, 0), {
    offsetM: 0,
    verified: true,
  });
  assert.deepEqual(displayOffset({ known: false }, null), {
    offsetM: 0,
    verified: false,
  });
  assert.deepEqual(displayOffset(undefined, undefined), {
    offsetM: 0,
    verified: false,
  });
});

test('shiftMission moves only the drawn ground height and never edits its input', () => {
  const r = slopedPlan(80);
  const before = clone(r.missions[0]);
  const shifted = shiftMission(r.missions[0], 25);
  assert.deepEqual(r.missions[0], before, 'input untouched');
  shifted.waypoints.forEach((w, i) => {
    const o = r.missions[0].waypoints[i];
    assert.equal(w.groundM, o.groundM + 25);
    assert.equal(w.aglM, o.aglM, 'height above ground unchanged');
    assert.equal(w.relHeightM, o.relHeightM, 'takeoff-relative height unchanged');
  });
  assert.equal(shiftMission(r.missions[0], 0), r.missions[0]);
});

test('globeHeightM reads the terrain model and says null when the globe cannot', () => {
  const c = fakeCesium();
  assert.equal(globeHeightM(fakeViewer(312.5), c, -97, 30), 312.5);
  assert.equal(globeHeightM(fakeViewer(null), c, -97, 30), null);
  assert.equal(globeHeightM(fakeViewer(Number.NaN), c, -97, 30), null);
  assert.equal(globeHeightM({}, c, -97, 30), null);
  assert.equal(
    globeHeightM({ scene: { globe: { getHeight: () => 1 / 0 } } }, c, 1, 1),
    null,
  );
});

// ---------------------------------------------- generated plan overlays --
test('generated plan on a slope: markers are the aircraft position, the takeoff and ground track stay on the ground', () => {
  const { preview, source } = rig();
  const r = slopedPlan(80);
  preview.showPlan(r);
  const markers = markersOf(source);
  const wps = r.missions.flatMap((m) => m.waypoints);
  assert.equal(markers.length, wps.length);
  markers.forEach((e, i) => {
    const w = wps[i];
    assert.equal(e.position[2], w.groundM + w.aglM, 'ground + height above ground');
    assert.ok(e.position[2] > 150, 'in the air, not at the surface');
    assert.equal(e.point.heightReference, undefined, 'not clamped to the ground');
  });
  // Local ground differs along the slope, so the aircraft heights differ too.
  assert.ok(new Set(markers.map((e) => e.position[2])).size > 1);
  // Takeoff-relative: a marker's height above the takeoff ground is relHeightM.
  markers.forEach((e, i) =>
    assert.ok(Math.abs(e.position[2] - 100 - wps[i].relHeightM) < 0.06),
  );
  const takeoff = named(source, 'Takeoff')[0];
  assert.equal(takeoff.position.length, 2, 'no height: on the surface');
  assert.equal(takeoff.point.heightReference, 'clamp');
  for (const line of source.entities.values.filter(
    (e) => e.polyline && /^Mission/.test(e.name ?? ''),
  )) {
    assert.equal(line.polyline.clampToGround, true, 'ground track clamped');
    assert.equal(line.polyline.classificationType, 'both');
  }
});

test('changing the flight height moves markers, apex and corridor together and keeps the ground track on the ground', () => {
  const heights = {};
  for (const aglM of [60, 140]) {
    const { preview, source } = rig();
    preview.showPlan(slopedPlan(aglM));
    const marker = markersOf(source)[0].position[2];
    const apex = named(source, '3D check view')
      .find((e) => e.polyline)
      .polyline.positions[5][2];
    const zone = named(source, '3D check zone')[0].polylineVolume.positions
      .heights[2];
    assert.equal(apex, marker, `apex at the marker for ${aglM} m`);
    assert.equal(zone, marker, `corridor at the marker for ${aglM} m`);
    const tracks = source.entities.values.filter(
      (e) => e.polyline && /^Mission/.test(e.name ?? ''),
    );
    assert.ok(tracks.length > 0);
    for (const t of tracks) {
      assert.equal(t.polyline.clampToGround, true, 'ground track clamped');
      assert.ok(
        t.polyline.positions.every((v) => typeof v === 'number'),
        'a flat lon/lat line: no height in it',
      );
    }
    heights[aglM] = { marker };
  }
  assert.ok(Math.abs(heights[140].marker - heights[60].marker - 80) < 1e-9);
});

test('pyramid: apex at the aircraft, base and footprints on the surface, curtain from the route down to the ground', () => {
  const { preview, source } = rig(null, { curtain: true, zone: true });
  const r = slopedPlan(100);
  preview.showPlan(r);
  const wp = r.missions[0].waypoints[0];
  const edges = named(source, '3D check view').find((e) => e.polyline);
  const pts = edges.polyline.positions;
  const apex = pts[5];
  assert.equal(apex[2], wp.groundM + wp.aglM);
  for (const base of pts.slice(0, 4)) {
    assert.equal(base[2], wp.groundM, 'base corners on the ground under the aircraft');
  }
  // The shaded footprint polygons drape on the surface: no heights at all.
  for (const poly of named(source, '3D check current photo').filter(
    (e) => e.polygon,
  )) {
    assert.equal(poly.polygon.classificationType, 'both');
    assert.ok(
      poly.polygon.hierarchy.every((v) => typeof v === 'number'),
      'a flat lon/lat ring',
    );
    assert.equal(poly.polygon.perPositionHeight, undefined);
  }
  const wall = named(source, '3D check curtain')[0].wall;
  const top = wall.positions.heights.filter((_, i) => i % 3 === 2);
  const bottom = wall.minimumHeights;
  top.forEach((t, i) => assert.ok(t > bottom[i], 'curtain top above its ground'));
  assert.equal(bottom[0], wp.groundM);
});

test('display only: showing a plan changes no flight or export value', () => {
  const r = slopedPlan(120);
  const before = clone(r);
  const exportBefore = buildMissionFiles(r.missions[0], r.plan);
  const { preview } = rig(250);
  preview.showPlan(r);
  const u = unknownPlan(120);
  const ubefore = clone(u);
  preview.showPlan(u);
  assert.deepEqual(clone(r), before);
  assert.deepEqual(clone(u), ubefore);
  const exportAfter = buildMissionFiles(r.missions[0], r.plan);
  assert.equal(exportAfter.waylinesWpml, exportBefore.waylinesWpml);
  const stamp = (x) => x.replace(/<wpml:(create|update)Time>\d+</g, '<t><');
  assert.equal(stamp(exportAfter.templateKml), stamp(exportBefore.templateKml));
});

test('terrain not read: the aircraft stands on the globe surface at the takeoff plus its height, never under the map', () => {
  const { preview, source } = rig(250);
  const r = unknownPlan(100);
  preview.showPlan(r);
  assert.equal(r.ground.known, false);
  for (const e of markersOf(source)) {
    assert.equal(e.position[2], 250 + 100, 'globe surface + height above takeoff');
  }
  const apex = named(source, '3D check view')
    .find((e) => e.polyline)
    .polyline.positions[5][2];
  assert.equal(apex, 350);
  assert.equal(preview.displayVerified(), true);
});

test('terrain not read and the globe cannot say: nothing is invented, the drawing is flagged unverified', () => {
  const { preview, source } = rig(null);
  preview.showPlan(unknownPlan(100));
  for (const e of markersOf(source)) assert.equal(e.position[2], 100);
  assert.equal(preview.displayVerified(), false);
  preview.showPlan(slopedPlan(100));
  assert.equal(preview.displayVerified(), true, 'a read plan is verified');
});

test('all-passes plan: every pass is drawn at the aircraft position, ground tracks stay clamped', () => {
  const { preview, source } = rig();
  const nadir = slopedPlan(80);
  const orbit = slopedPlan(120, { pattern: 'orbit' });
  preview.showSuite([
    { id: 'nadir', result: nadir },
    { id: 'orbit', result: orbit },
  ]);
  const pts = source.entities.values.filter(
    (e) => e.point && !e.name && Array.isArray(e.position),
  );
  assert.ok(pts.length > 0);
  const heights = new Set(pts.map((e) => e.position[2]));
  for (const w of nadir.missions.flatMap((m) => m.waypoints)) {
    assert.ok(heights.has(w.groundM + w.aglM));
  }
  for (const e of pts) assert.equal(e.point.heightReference, undefined);
  const nadirLines = source.entities.values.filter(
    (e) => e.polyline && /^nadir mission/.test(e.name ?? ''),
  );
  assert.ok(nadirLines.length > 0);
  for (const l of nadirLines) assert.equal(l.polyline.clampToGround, true);
});

// ----------------------------------------------------------- imports ----
const importFile = async (marks) =>
  parseDjiKmz(kmz(marks), { fileName: 'x.kmz' });

test('import shots: heights are above the start; the aircraft is ground-at-start + height, not under or on the ground', async () => {
  const m = await importFile([
    mark(0, east(0), LAT, { h: 50, groups: group(1, 0, 0, 'reachPoint') }),
    mark(1, east(40), LAT, { h: 50, groups: group(2, 1, 1, 'reachPoint') }),
    mark(2, east(80), LAT, { h: 50, groups: group(3, 2, 2, 'reachPoint') }),
  ]);
  const s = deriveImportShots(m);
  assert.equal(s.heightMode, 'relativeToStartPoint');
  assert.ok(s.path.every((p) => p.waypoint === true));
  // Start on the low ground (100); the ground under the third waypoint is 190.
  const out = importCheckMission(s, {
    known: true,
    takeoffM: 100,
    wpM: [100, 140, 190],
  });
  assert.deepEqual(
    out.waypoints.map((w) => flightHeightM(w)),
    [150, 150, 150],
    'start surface + 50 m, whatever the ground under each waypoint',
  );
  assert.deepEqual(
    out.waypoints.map((w) => w.aglM),
    [50, 10, -40],
    'local height above ground; negative = the file flies under the terrain',
  );
  assert.equal(out.verified, true);
});

test('import shots without a terrain read use the globe surface at the start, else flat 0, and say which', async () => {
  const m = await importFile([
    mark(0, east(0), LAT, { h: 30, groups: group(1, 0, 0, 'reachPoint') }),
    mark(1, east(40), LAT, { h: 30, groups: group(2, 1, 1, 'reachPoint') }),
  ]);
  const s = deriveImportShots(m);
  const onGlobe = importCheckMission(s, null, { displayGroundM: 210 });
  assert.deepEqual(onGlobe.waypoints.map((w) => flightHeightM(w)), [240, 240]);
  assert.equal(onGlobe.verified, true);
  const blind = importCheckMission(s, { known: false });
  assert.deepEqual(blind.waypoints.map((w) => flightHeightM(w)), [30, 30]);
  assert.equal(blind.verified, false, 'assumed flat at 0 is flagged, not hidden');
});

test('import shots: WGS84 heights are absolute, follow-surface heights ride the ground, sea-level heights are not guessed', () => {
  const path = [
    { lon: -97, lat: 30, heightM: 400, pitchDeg: -90, headingDeg: 0, photo: false, waypoint: true },
    { lon: -97.001, lat: 30, heightM: 400, pitchDeg: -90, headingDeg: 0, photo: false, waypoint: true },
  ];
  const ground = { known: true, takeoffM: 120, wpM: [120, 200] };
  const abs = importCheckMission({ path, heightMode: 'WGS84' }, ground);
  assert.deepEqual(abs.waypoints.map((w) => flightHeightM(w)), [400, 400]);
  const follow = importCheckMission(
    { path, heightMode: 'realTimeFollowSurface' },
    ground,
  );
  assert.deepEqual(follow.waypoints.map((w) => flightHeightM(w)), [520, 600]);
  const msl = importCheckMission({ path, heightMode: 'EGM96' }, ground);
  assert.deepEqual(msl.waypoints, []);
  assert.equal(msl.verified, false);
  assert.equal(msl.unsupportedHeightMode, 'EGM96');
});

function importRig(globeHeight = null) {
  const viewer = fakeViewer(globeHeight);
  const preview = createDronePlanPreview({ viewer, cesium: fakeCesium() });
  const source = viewer.dataSources.sources[0];
  return { preview, source };
}
const lineItem = (id = 'imp') => ({
  id,
  color: '#ff00ff',
  lines: [
    [
      { lon: -97, lat: 30 },
      { lon: -96.999, lat: 30 },
      { lon: -96.998, lat: 30 },
    ],
  ],
});
const importPass = (id = 'imp', checkable = true) => {
  const path = [0, 1, 2].map((i) => ({
    lon: -97 + i * 0.001,
    lat: 30,
    heightM: 60,
    pitchDeg: -90,
    headingDeg: 90,
    photo: true,
    waypoint: true,
  }));
  return {
    id,
    color: '#ff00ff',
    checkable,
    missions: [
      importCheckMission({ path }, { known: true, takeoffM: 100, wpM: [100, 130, 160] }),
    ],
  };
};

test('imported file: waypoints are the aircraft in the air once heights exist, on the ground track before', () => {
  const { preview, source } = importRig();
  preview.showImports([lineItem()]);
  const clamped = source.entities.values.filter((e) => e.point);
  assert.equal(clamped.length, 3);
  assert.ok(clamped.every((e) => e.point.heightReference === 'clamp'));
  preview.setImportCheck([importPass()]);
  const pts = source.entities.values.filter((e) => e.point);
  assert.equal(pts.length, 3, 'the clamped dots are replaced, not doubled');
  assert.deepEqual(
    pts.map((e) => e.position[2]),
    [160, 160, 160],
    'start surface 100 + 60 above it, over ground of 100 / 130 / 160',
  );
  assert.ok(pts.every((e) => e.point.heightReference === undefined));
  const track = source.entities.values.find((e) => e.polyline && e.name === 'imp');
  assert.equal(track.polyline.clampToGround, true, 'the ground track stays on the surface');
  // The 3D check of the file: corridor and curtain at the same height.
  preview.setCheck({ enabled: true, frame: FRAME, frustum: 'one' });
  const zone = named(source, '3D check zone')[0];
  assert.equal(zone.polylineVolume.positions.heights[2], 160);
  const apex = named(source, '3D check view').find((e) => e.polyline).polyline
    .positions[5];
  assert.equal(apex[2], 160);
});

test('imported file with no photo action is still placed in the air but gives the 3D check nothing', () => {
  const { preview, source } = importRig();
  preview.showImports([lineItem()]);
  preview.setImportCheck([importPass('imp', false)]);
  preview.setCheck({ enabled: true, frame: FRAME, frustum: 'one' });
  assert.equal(
    source.entities.values.filter((e) => e.point && e.position[2] === 160).length,
    3,
  );
  assert.equal(named(source, '3D check').length, 0);
});

test('imported file: a hidden item draws no marker, clearing the check puts the ground dots back', () => {
  const { preview, source } = importRig();
  preview.showImports([lineItem()], ['imp']);
  preview.setImportCheck([importPass()]);
  assert.equal(source.entities.values.filter((e) => e.point).length, 0);
  preview.showImports([lineItem()]);
  assert.equal(
    source.entities.values.filter((e) => e.point && e.position[2] === 160).length,
    3,
  );
  preview.setImportCheck(null);
  const back = source.entities.values.filter((e) => e.point);
  assert.equal(back.length, 3);
  assert.ok(back.every((e) => e.point.heightReference === 'clamp'));
});

test('a generated plan wins the 3D check over an import; both stay on their own heights', () => {
  const { preview, source } = importRig();
  preview.showImports([lineItem()]);
  preview.setImportCheck([importPass()]);
  preview.setCheck({ enabled: true, frame: FRAME, frustum: 'one' });
  preview.showPlan(slopedPlan(80));
  const zone = named(source, '3D check zone');
  assert.ok(zone.length > 0);
  assert.ok(
    zone.every((z) => z.name.includes('mission-')),
    'the generated plan, not the import',
  );
  assert.equal(
    source.entities.values.filter((e) => e.name === 'imp waypoint').length,
    3,
    'the imported aircraft markers are still where the file puts them',
  );
});

// ------------------------------------------------------ obstacle zones --
function obstacleRig({ globe, sampled, hint }) {
  const values = [];
  const cesium = {
    Color: { fromCssColorString: (css) => ({ withAlpha: (a) => ({ css, a }) }) },
    Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) },
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat }) },
  };
  const layer = createObstacleLayer({
    dataSource: {
      entities: {
        add: (e) => (values.push(e), e),
        remove: (e) => values.splice(values.indexOf(e), 1),
      },
    },
    cesium,
    viewer: { scene: { globe: { getHeight: () => globe }, canvas: {} }, camera: {} },
    requestRender: () => {},
  });
  if (hint !== undefined) layer.setGroundHint(hint);
  if (sampled) layer.setSampledGrounds(sampled);
  return { layer, values };
}
const TOWER = {
  id: 'a',
  kind: 'tower',
  lon: -95,
  lat: 32.5,
  radiusM: 6,
  heightM: 60,
  source: 'faa',
  estimatedHeightM: 60,
  userEdited: false,
};

test('obstacle column stands on the ground at the obstruction and rises its own height, not the flight height', () => {
  const { layer, values } = obstacleRig({ globe: 180 });
  layer.set([TOWER]);
  const cyl = values.find((e) => e.cylinder);
  assert.equal(cyl.position.h, 180 + 30, 'terrain 180 + half its 60 m');
  const handle = values.find((e) => e.name === 'Obstacle handle a');
  assert.equal(handle.position.h, 180 + 60);
  layer.destroy();
});

test('obstacle ground: the globe first, then the plan own terrain read for that obstacle, then the takeoff ground', () => {
  const sampled = { a: 205 };
  const a = obstacleRig({ globe: undefined, sampled, hint: 100 });
  a.layer.set([TOWER]);
  assert.equal(a.values.find((e) => e.cylinder).position.h, 205 + 30);
  const b = obstacleRig({ globe: undefined, sampled: {}, hint: 100 });
  b.layer.set([TOWER]);
  assert.equal(b.values.find((e) => e.cylinder).position.h, 100 + 30);
  const c = obstacleRig({ globe: 300, sampled, hint: 100 });
  c.layer.set([TOWER]);
  assert.equal(c.values.find((e) => e.cylinder).position.h, 300 + 30, 'the globe wins');
  // A later terrain read moves the column to its own ground.
  b.layer.setSampledGrounds({ a: 140 });
  assert.equal(b.values.find((e) => e.cylinder).position.h, 140 + 30);
  for (const r of [a, b, c]) r.layer.destroy();
});

// ------------------------- terrain not read, globe terrain varies by point --
test('terrain not read on a sloping globe: apex at takeoff surface + height, base and curtain on the surface under each point', () => {
  // The globe rises 10 m per 0.001 degree of latitude; the takeoff is at 30.27.
  const surface = (c) => 200 + Math.round((c.lat - 30.27) * 1e4);
  const { preview, source } = rig(surface);
  const r = unknownPlan(100);
  preview.showPlan(r);
  const wp = r.missions[0].waypoints[0];
  const under = surface({ lat: wp.lat });
  assert.notEqual(under, 200, 'the first waypoint is not at the takeoff height');
  const marker = markersOf(source)[0].position[2];
  assert.equal(marker, 200 + 100, 'takeoff surface + height above takeoff: what DJI flies');
  const edges = named(source, '3D check view').find((e) => e.polyline);
  assert.equal(edges.polyline.positions[5][2], marker, 'apex at the aircraft');
  for (const base of edges.polyline.positions.slice(0, 4)) {
    assert.equal(base[2], under, 'base on the surface under the aircraft');
  }
  const wall = named(source, '3D check curtain')[0].wall;
  assert.equal(wall.minimumHeights[0], under, 'curtain reaches the surface');
  assert.equal(wall.positions.heights[2], marker, 'and rises to the aircraft');
  // Nothing about the plan itself moved.
  assert.equal(wp.aglM, 100);
  assert.equal(wp.groundM, 0);
});

test('imported file without a terrain read: aircraft at start surface + height, surface under each point from the globe', async () => {
  const m = await importFile([
    mark(0, east(0), LAT, { h: 40, groups: group(1, 0, 0, 'reachPoint') }),
    mark(1, east(40), LAT, { h: 40, groups: group(2, 1, 1, 'reachPoint') }),
  ]);
  const s = deriveImportShots(m);
  const out = importCheckMission(s, { known: false }, {
    displayGroundM: 300,
    groundAt: (lon) => (lon === s.path[0].lon ? 300 : 320),
  });
  assert.deepEqual(out.waypoints.map((w) => flightHeightM(w)), [340, 340]);
  assert.deepEqual(out.waypoints.map((w) => w.groundM), [300, 320]);
  assert.deepEqual(out.waypoints.map((w) => w.aglM), [40, 20]);
  assert.equal(out.verified, true);
});

test('terrain read: the globe is never asked, a read plan is drawn from its own ground even if the globe disagrees', () => {
  const { preview, source } = rig(999);
  const r = slopedPlan(80);
  preview.showPlan(r);
  const wps = r.missions.flatMap((m) => m.waypoints);
  markersOf(source).forEach((e, i) =>
    assert.equal(e.position[2], wps[i].groundM + wps[i].aglM),
  );
  const edges = named(source, '3D check view').find((e) => e.polyline);
  for (const base of edges.polyline.positions.slice(0, 4)) {
    assert.equal(base[2], wps[0].groundM, 'base on the plan ground, not the globe');
  }
});
