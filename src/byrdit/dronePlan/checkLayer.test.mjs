import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckLayer } from './checkLayer.js';
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
