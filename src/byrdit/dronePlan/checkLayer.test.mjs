import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_FILL_ALPHA,
  DEFAULT_ALPHA,
  FRUSTUM_MODES,
  NEIGHBOR_ALPHA_RATIO,
  VIEW_EDGE_PER_FILL,
  createCheckLayer,
} from './checkLayer.js';
import { getPreset } from './presets.js';
import { assembleMissions, linePhotoCount, planFlight } from './planner.js';
import { metersPerDegree } from './geo.js';

function surveyBox(width, height) {
  const m = metersPerDegree(30.27);
  return {
    west: -97.77 - width / 2 / m.lon,
    east: -97.77 + width / 2 / m.lon,
    south: 30.27 - height / 2 / m.lat,
    north: 30.27 + height / 2 / m.lat,
  };
}

function planned(captureMode, extra = {}) {
  const plan = planFlight(surveyBox(300, 200), {
    aglM: 80,
    batteryMin: 60,
    speedMs: 8,
    captureMode,
    ...extra,
  });
  assert.equal(plan.error, undefined);
  const ids = plan.legs.flatMap((leg) => leg.waypoints.map((w) => w.id));
  return assembleMissions(plan, {
    known: true,
    takeoffM: 0,
    wpM: ids.map(() => 0),
  });
}

function layerFor(result) {
  const layer = createCheckLayer({
    dataSource: { entities: { add() {}, remove() {} } },
    cesium: {},
    requestRender() {},
  });
  layer.setData(
    result.missions.map((mission, mi) => ({
      id: `mission-${mi + 1}`,
      color: '#39d0ff',
      missions: [mission],
    })),
  );
  return layer;
}

test('distance and timed lines derive stations; stop waypoint photos stay as they are', () => {
  const stop = planned('stop');
  const stopInfo = layerFor(stop).info();
  assert.equal(stopInfo.count, stop.totals.photoCount);
  assert.equal(stopInfo.current.estimated, false);
  assert.ok(stop.missions[0].legs[0].waypoints.length > 2);

  for (const mode of ['distance', 'timed']) {
    const result = planned(mode);
    const leg = result.missions[0].legs[0];
    assert.equal(leg.photoMode, 'waypoint');
    assert.equal(
      leg.waypoints.every((w) => w.photo === false),
      true,
    );
    const info = layerFor(result).info();
    assert.equal(
      info.count,
      result.totals.photoCount,
      `${mode} stations match the plan count`,
    );
    assert.ok(info.count > leg.waypoints.length, 'stations are along the line');
    assert.equal(info.current.estimated, mode === 'timed');
    assert.equal(info.current.captureMode, mode);
  }
});

test('a continued distance line does not count the shared start twice', () => {
  const result = planned('distance');
  const mission = structuredClone(result.missions[0]);
  const leg = mission.legs[0];
  leg.continued = true;
  leg.photoCount = linePhotoCount(leg.lengthM, leg.photoSpacingM, true);
  const layer = createCheckLayer({
    dataSource: { entities: { add() {}, remove() {} } },
    cesium: {},
    requestRender() {},
  });
  layer.setData([
    {
      id: 'mission-1',
      color: '#39d0ff',
      missions: [{ ...mission, legs: [leg] }],
    },
  ]);
  assert.equal(layer.info().count, leg.photoCount);
  assert.equal(
    layer.info().count,
    linePhotoCount(leg.lengthM, leg.photoSpacingM, false) - 1,
  );
});

test('legacy interval photo mode still samples the line and is not marked estimated', () => {
  const result = planned('stop', { photoMode: 'interval' });
  assert.ok(
    result.missions[0].legs.every((leg) => leg.photoMode === 'interval'),
  );
  const info = layerFor(result).info();
  assert.ok(info.count > 0);
  assert.ok(
    Math.abs(info.count - result.totals.photoCount) <=
      result.missions[0].legs.length + 1,
  );
  assert.equal(info.current.estimated, false);
});

// ---- Camera view 'Selected and neighbors' ----------------------------------

const FRAME = getPreset('dji-mini-4-pro');

/** A fake Cesium and a data source that keeps what is drawn. */
function drawRig() {
  const paint = (css, a = 1) => ({ css, a, withAlpha: (x) => paint(css, x) });
  const values = [];
  const cesium = {
    Color: { fromCssColorString: (css) => paint(css) },
    Cartesian3: {
      fromDegreesArray: (v) => v,
      fromDegreesArrayHeights: (v) => ({ heights: v }),
      fromDegrees: (lon, lat, h) => [lon, lat, h],
    },
    Cartesian2: class {},
    CornerType: { BEVELED: 'beveled' },
    ClassificationType: { BOTH: 'both' },
  };
  const dataSource = {
    entities: {
      values,
      add: (e) => (values.push(e), e),
      remove: (e) => {
        const i = values.indexOf(e);
        if (i >= 0) values.splice(i, 1);
      },
    },
  };
  const named = (prefix) => values.filter((e) => e.name?.startsWith(prefix));
  return { cesium, dataSource, values, named };
}

function neighborLayer(result, options = {}) {
  const rig = drawRig();
  const layer = createCheckLayer({
    dataSource: rig.dataSource,
    cesium: rig.cesium,
    requestRender() {},
  });
  layer.setData(
    result.missions.map((mission, mi) => ({
      id: `mission-${mi + 1}`,
      color: '#39d0ff',
      missions: [mission],
    })),
  );
  layer.setOptions({
    enabled: true,
    zone: false,
    curtain: false,
    frame: FRAME,
    frustum: 'neighbors',
    ...options,
  });
  return { ...rig, layer };
}

/** The first photo with a neighbour on all four sides. */
function interiorIndex(layer) {
  const count = layer.info().count;
  for (let i = 0; i < count; i += 1) {
    layer.setOptions({ index: i });
    const n = layer.info().neighbors;
    if (n.front && n.back && n.left && n.right) return i;
  }
  assert.fail('no photo with four neighbours');
}

test("'neighbors' is a camera view mode and 'one' stays the default", () => {
  assert.deepEqual([...FRUSTUM_MODES], ['one', 'thinned', 'neighbors', 'off']);
  assert.ok(NEIGHBOR_ALPHA_RATIO > 0 && NEIGHBOR_ALPHA_RATIO < 1);
  const bare = createCheckLayer({
    dataSource: drawRig().dataSource,
    cesium: drawRig().cesium,
    requestRender() {},
  });
  assert.equal(bare.options().frustum, 'one');
});

test("'neighbors' draws the stepped photo and at most four neighbours, whatever Photo footprints says", () => {
  for (const footprints of ['selected', 'off', 'all']) {
    const { layer, named } = neighborLayer(planned('stop'), { footprints });
    const index = interiorIndex(layer);
    const info = layer.info();
    assert.equal(info.index, index);
    // 5 pyramids: 4 side faces + an edge line each.
    assert.equal(named('3D check view').length, 5, `${footprints}: strong`);
    assert.equal(named('3D check neighbor view').length, 4 * 5, footprints);
    // 5 footprints: the stepped one (fill + outline) and four neighbours.
    assert.equal(named('3D check current').length, 2, footprints);
    assert.equal(
      named('3D check neighbor footprint').filter((e) => e.polygon).length,
      4,
      footprints,
    );
    assert.equal(
      named('3D check neighbor footprint').filter((e) => e.polyline).length,
      4,
      footprints,
    );
    if (footprints === 'all') {
      // Not drawn a second time by the bulk layer.
      const polys = named('3D check footprint').length;
      const total = layer.info().count;
      assert.ok(polys <= total - 5, `${polys} of ${total}`);
    } else {
      assert.equal(named('3D check footprint').length, 0, footprints);
    }
  }
});

test("'neighbors' strong vs light styles: stepped photo full, neighbours at the ratio", () => {
  const { layer, named } = neighborLayer(planned('stop'), {
    footprints: 'off',
  });
  interiorIndex(layer);
  const strong = named('3D check view').find((e) => e.polygon);
  const weak = named('3D check neighbor view').find((e) => e.polygon);
  assert.equal(strong.polygon.material.a, DEFAULT_ALPHA.view);
  assert.ok(
    Math.abs(weak.polygon.material.a - DEFAULT_ALPHA.view * NEIGHBOR_ALPHA_RATIO) <
      1e-12,
  );
  const edges = (list) => list.find((e) => e.polyline);
  assert.ok(
    Math.abs(
      edges(named('3D check view')).polyline.material.a -
        DEFAULT_ALPHA.view * VIEW_EDGE_PER_FILL,
    ) < 1e-12,
  );
  assert.ok(
    edges(named('3D check neighbor view')).polyline.material.a <
      edges(named('3D check view')).polyline.material.a,
  );
  const cur = named('3D check current').find((e) => e.polygon);
  const nf = named('3D check neighbor footprint').find((e) => e.polygon);
  assert.equal(cur.polygon.material.a, CURRENT_FILL_ALPHA);
  assert.ok(nf.polygon.material.a < cur.polygon.material.a);
  // Outlines read apart: white for the stepped photo, the pass colour for a neighbour.
  assert.equal(
    named('3D check current').find((e) => e.polyline).polyline.material.css,
    '#ffffff',
  );
  assert.equal(
    named('3D check neighbor footprint').find((e) => e.polyline).polyline
      .material.css,
    '#39d0ff',
  );
});

test("'neighbors' resolves ahead, behind, left and right on the right lines", () => {
  const result = planned('stop');
  const { layer } = neighborLayer(result);
  const index = interiorIndex(layer);
  const n = layer.info().neighbors;
  assert.equal(n.front.index, index + 1);
  assert.equal(n.back.index, index - 1);
  assert.ok(n.left.index !== index && n.right.index !== index);
  assert.notEqual(n.left.index, n.right.index);
  for (const side of ['front', 'back', 'left', 'right']) {
    assert.ok(Number.isFinite(n[side].overlapPct), side);
    assert.ok(n[side].overlapPct >= 0 && n[side].overlapPct <= 100, side);
  }
  // Photos on the next line sit in other legs: the neighbour on the next
  // line is not the one ahead.
  layer.setOptions({ index: 0 });
  const first = layer.info().neighbors;
  assert.equal(first.back, null);
  assert.equal(first.front.index, 1);
});

test("'neighbors' overlap is real: along-track spacing sets ahead/behind, line spacing sets left/right", () => {
  const result = planned('stop', { forwardOverlap: 80, sideOverlap: 70 });
  const { layer } = neighborLayer(result);
  interiorIndex(layer);
  const n = layer.info().neighbors;
  // Planned 80 % forward and 70 % side overlap of a nadir grid: the measured
  // overlaps are near those (corners and rounding keep it from being exact).
  assert.ok(Math.abs(n.front.overlapPct - 80) < 6, String(n.front.overlapPct));
  assert.ok(Math.abs(n.back.overlapPct - 80) < 6, String(n.back.overlapPct));
  assert.ok(Math.abs(n.left.overlapPct - 70) < 8, String(n.left.overlapPct));
  assert.ok(Math.abs(n.right.overlapPct - 70) < 8, String(n.right.overlapPct));
});

test("other camera views are unchanged by the new mode", () => {
  for (const [frustum, views, neighbors] of [
    ['one', 5, 0],
    ['off', 0, 0],
    ['bogus', 0, 0],
  ]) {
    const { layer, named } = neighborLayer(planned('stop'), {
      frustum,
      footprints: 'selected',
    });
    assert.equal(named('3D check view').length, views, frustum);
    assert.equal(named('3D check neighbor').length, neighbors, frustum);
    assert.equal(layer.counts().neighbors, 0, frustum);
    assert.equal(layer.info().neighbors, null, frustum);
    // The stepped photo's own footprint shows for 'selected', as before.
    assert.equal(named('3D check current').length, 2);
  }
  const off = neighborLayer(planned('stop'), {
    frustum: 'one',
    footprints: 'off',
  });
  assert.equal(off.named('3D check current').length, 0);
  const thinned = neighborLayer(planned('stop'), { frustum: 'thinned' });
  assert.ok(thinned.named('3D check view').length > 5);
  assert.equal(thinned.named('3D check neighbor').length, 0);
});

test("'neighbors' follows the Step photos index and rebuilds only what moves", () => {
  const { layer, named } = neighborLayer(planned('stop'));
  const index = interiorIndex(layer);
  const before = named('3D check neighbor view').slice();
  layer.setOptions({ footprints: 'all' });
  assert.deepEqual(named('3D check neighbor view'), before, 'view kept');
  layer.setOptions({ index: index + 1 });
  assert.equal(layer.info().index, index + 1);
  assert.notDeepEqual(named('3D check neighbor view'), before);
  assert.equal(named('3D check neighbor view').length, 20);
  layer.setOptions({ frustum: 'off', footprints: 'selected' });
  assert.equal(named('3D check neighbor').length, 0);
  assert.equal(layer.counts().neighbors, 0);
});

test("'neighbors' works on Distance and Timed stations and keeps an estimate flag", () => {
  for (const mode of ['distance', 'timed']) {
    const { layer, named } = neighborLayer(planned(mode), {
      footprints: 'off',
    });
    const index = interiorIndex(layer);
    const info = layer.info();
    assert.equal(info.current.estimated, mode === 'timed');
    assert.equal(info.neighbors.front.index, index + 1, mode);
    assert.equal(info.neighbors.back.index, index - 1, mode);
    assert.equal(named('3D check neighbor view').length, 20, mode);
  }
});

test("'neighbors' never reaches into another pass or mission", () => {
  const a = planned('stop');
  const b = planned('stop');
  const rig = drawRig();
  const layer = createCheckLayer({
    dataSource: rig.dataSource,
    cesium: rig.cesium,
    requestRender() {},
  });
  layer.setData([
    { id: 'pass-a', color: '#39d0ff', missions: [a.missions[0]] },
    { id: 'pass-b', color: '#ff9a3c', missions: [b.missions[0]] },
  ]);
  layer.setOptions({ enabled: true, frame: FRAME, frustum: 'neighbors' });
  const perPass = a.missions[0].photoCount;
  // The last photo of pass a: nothing ahead (pass b starts next).
  layer.setOptions({ index: perPass - 1 });
  const info = layer.info();
  assert.equal(info.current.passId, 'pass-a');
  assert.equal(info.neighbors.front, null);
  // The first of pass b: nothing behind.
  layer.setOptions({ index: perPass });
  const second = layer.info();
  assert.equal(second.current.passId, 'pass-b');
  assert.equal(second.neighbors.back, null);
  for (const e of rig.named('3D check neighbor')) {
    assert.match(e.name, /pass-b( outline| edges)?$/, e.name);
  }
});

test("'neighbors' on a file without flight lines gives ahead and behind only", () => {
  const wps = [0, 1, 2, 3].map((k) => ({
    lon: -97.77 + k * 0.0002,
    lat: 30.27,
    groundM: 0,
    aglM: 60,
    pitchDeg: -90,
    photo: true,
  }));
  const rig = drawRig();
  const layer = createCheckLayer({
    dataSource: rig.dataSource,
    cesium: rig.cesium,
    requestRender() {},
  });
  layer.setData([
    { id: 'import-1', color: '#39d0ff', missions: [{ waypoints: wps }] },
  ]);
  layer.setOptions({ enabled: true, frame: FRAME, frustum: 'neighbors', index: 1 });
  const n = layer.info().neighbors;
  assert.equal(n.front.index, 2);
  assert.equal(n.back.index, 0);
  assert.equal(n.left, null);
  assert.equal(n.right, null);
  assert.equal(rig.named('3D check neighbor view').length, 10);
});

test("'neighbors' overlap is null (n/a) for a clipped footprint, with the footprint still drawn", () => {
  const wps = [0, 1, 2].map((k) => ({
    lon: -97.77 + k * 0.0002,
    lat: 30.27,
    groundM: 0,
    aglM: 100,
    pitchDeg: -20,
    headingDeg: 0,
    photo: true,
  }));
  const rig = drawRig();
  const layer = createCheckLayer({
    dataSource: rig.dataSource,
    cesium: rig.cesium,
    requestRender() {},
  });
  layer.setData([
    { id: 'import-1', color: '#39d0ff', missions: [{ waypoints: wps }] },
  ]);
  layer.setOptions({ enabled: true, frame: FRAME, frustum: 'neighbors', index: 1 });
  const info = layer.info();
  assert.equal(info.current.footprint.clipped, true);
  assert.equal(info.neighbors.front.overlapPct, null);
  assert.equal(info.neighbors.back.overlapPct, null);
});
