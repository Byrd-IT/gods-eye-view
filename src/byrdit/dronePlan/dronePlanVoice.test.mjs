import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRONEPLAN_VOICE_ACTIONS,
  createDronePlanVoice,
} from './dronePlanVoice.js';

const SECRET = 'sk-ant-secret-Bearer-not-a-drone';

function fakeHandle(over = {}) {
  const state = {
    open: false,
    areas: [],
    options: {
      presetId: 'dji-mini-5-pro',
      pattern: 'grid',
      photoMode: 'waypoint',
      aglM: 60,
      frontOverlap: 80,
      sideOverlap: 70,
      speedMs: 5,
    },
    jobGrouping: 'per-area',
    takeoff: null,
    result: null,
    busy: false,
    dirty: false,
    suite: null,
    suiteBusy: false,
    wpml: { droneEnumValue: null },
  };
  const calls = [];
  const handle = {
    calls,
    isOpen: () => state.open,
    getState: () => state,
    getResult: () => state.result,
    open(opts) {
      calls.push(['open', opts]);
      state.open = true;
    },
    close() {
      calls.push(['close']);
      state.open = false;
      state.areas = [];
      state.result = null;
    },
    drawBox(opts) {
      calls.push(['drawBox', opts]);
      return true;
    },
    drawPolygon() {
      calls.push(['drawPolygon']);
      return false;
    },
    setBox(box) {
      calls.push(['setBox', box]);
      state.areas = [{ id: 'area-1', kind: 'rect' }];
      return true;
    },
    setPolygon(ring) {
      calls.push(['setPolygon', ring]);
      state.areas = [{ id: 'area-1', kind: 'polygon' }];
      return true;
    },
    useRecommended(mode) {
      calls.push(['useRecommended', mode]);
      state.options.aglM = 45;
      return true;
    },
    applyOptions(patch, opts) {
      calls.push(['applyOptions', patch, opts]);
      if (patch.presetId) state.options.presetId = patch.presetId;
      if (patch.aglM != null) state.options.aglM = patch.aglM;
      return true;
    },
    clearTakeoff() {
      calls.push(['clearTakeoff']);
      state.takeoff = null;
      return true;
    },
    startTakeoffPick() {
      calls.push(['startTakeoffPick']);
      return true;
    },
    setTakeoff(point) {
      calls.push(['setTakeoff', point]);
      state.takeoff = point;
      return true;
    },
    removeArea(id) {
      calls.push(['removeArea', id]);
      state.areas = state.areas.filter((area) => area.id !== id);
      return true;
    },
    replan: async () => {
      calls.push(['replan']);
    },
    planSuite: async () => {
      calls.push(['planSuite']);
      state.suite = {
        passes: [{ id: 'nadir', result: { missions: [{}] }, error: null }],
      };
    },
    downloadMission(index) {
      calls.push(['downloadMission', index]);
      return true;
    },
    downloadAll() {
      calls.push(['downloadAll']);
      return true;
    },
    downloadSuite() {
      calls.push(['downloadSuite']);
      return true;
    },
    downloadsAllowed: () => state.result != null,
    suiteAllowed: () => state.suite != null,
    ...over,
  };
  return { handle, state, calls };
}

test('voice actions are the panel actions, in schema order', () => {
  assert.deepEqual(DRONEPLAN_VOICE_ACTIONS, [
    'open',
    'close',
    'status',
    'draw',
    'box',
    'polygon',
    'recommend',
    'options',
    'takeoff',
    'remove',
    'replan',
    'suite',
    'download',
  ]);
});

test('open shows the panel and does not start a draw', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.open();
  assert.deepEqual(result, { ok: true, open: true });
  assert.deepEqual(calls, [['open', { draw: false }]]);
});

test('close clears the plan', async () => {
  const { handle } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  await voice.open();
  const result = await voice.close();
  assert.deepEqual(result, { ok: true, open: false, cleared: true });
  assert.equal(handle.isOpen(), false);
});

test('status reports catalog aircraft and counts, not a typed area name', async () => {
  const { handle, state } = fakeHandle();
  state.open = true;
  state.areas = [{ id: 'area-1', kind: 'rect', name: SECRET }];
  state.result = {
    totals: { missionCount: 2, photoCount: 40, durationS: 90 },
    terrainComplete: false,
    warnings: [{ code: 'battery-low', text: SECRET }],
    error: null,
  };
  const voice = createDronePlanVoice(handle);
  const result = await voice.status();
  assert.equal(result.ok, true);
  assert.equal(result.aircraft, 'DJI Mini 5 Pro');
  assert.equal(result.areaCount, 1);
  assert.equal(result.areas[0].id, 'area-1');
  assert.equal(result.plan.missionCount, 2);
  assert.equal(result.plan.terrainComplete, false);
  assert.deepEqual(result.plan.warningCodes, ['battery-low']);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('a secret aircraft string is not repeated', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.options({ aircraft: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'No aircraft matched.');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(calls.some((call) => call[0] === 'applyOptions'), false);
});

test('options sets a catalog aircraft and a height inside the slider range', async () => {
  const { handle, calls, state } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.options({ aircraft: 'phantom 4', aglM: 80 });
  assert.equal(result.ok, true);
  assert.equal(result.aircraft, 'DJI Phantom 4 (original)');
  assert.equal(state.options.aglM, 80);
  assert.equal(calls[0][0], 'open');
  assert.deepEqual(calls[1], [
    'applyOptions',
    { presetId: 'dji-phantom-4', aglM: 80 },
    { planNow: true },
  ]);
});

test('an out-of-range height is refused without the bad value', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.options({ aglM: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'That option is outside the panel range');
  assert.equal(JSON.stringify(result).includes('5000'), false);
  assert.equal(calls.length, 0);
});

test('box sets coordinates and a refused box does not echo them', async () => {
  const good = fakeHandle();
  const voice = createDronePlanVoice(good.handle);
  const set = await voice.box({ west: -97.8, south: 30.2, east: -97.7, north: 30.3 });
  assert.equal(set.ok, true);
  assert.equal(set.areaCount, 1);
  const refused = fakeHandle({
    setBox() {
      return false;
    },
  });
  const bad = await createDronePlanVoice(refused.handle).box({
    west: -97.8,
    south: 30.2,
    east: -97.7,
    north: 30.3,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'That box cannot be flown');
  assert.equal(JSON.stringify(bad).includes('-97.8'), false);
});

test('download does not claim a file when downloads are not allowed', async () => {
  const { handle } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.download({ which: 'mission', index: 0 });
  assert.deepEqual(result, {
    ok: false,
    error: 'Downloads are not available yet',
  });
});

test('download reports downloaded only after the panel method runs', async () => {
  const { handle, state, calls } = fakeHandle();
  state.result = { missions: [{}, {}] };
  const voice = createDronePlanVoice(handle);
  const result = await voice.download({ which: 'mission', index: 1 });
  assert.deepEqual(result, {
    ok: true,
    downloaded: true,
    which: 'mission',
    index: 1,
  });
  assert.deepEqual(calls.at(-1), ['downloadMission', 1]);
});

test('suite refuses to start with no area', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.suite();
  assert.equal(result.error, 'Draw an area first');
  assert.equal(calls.some((call) => call[0] === 'planSuite'), false);
});

test('remove does not echo an area id that is not on the panel', async () => {
  const { handle, state } = fakeHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  const voice = createDronePlanVoice(handle);
  const result = await voice.remove({ areaId: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'No area matched.');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(state.areas.length, 1);
});

test('options reports the plan after replan, not the counts from before', async () => {
  const { handle, state } = fakeHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  state.result = {
    totals: { missionCount: 1, photoCount: 10, durationS: 20 },
    terrainComplete: true,
    warnings: [],
  };
  handle.replan = async () => {
    state.dirty = false;
    state.result = {
      totals: { missionCount: 2, photoCount: 40, durationS: 90 },
      terrainComplete: true,
      warnings: [],
    };
  };
  const voice = createDronePlanVoice(handle);
  const result = await voice.options({ aglM: 80 });
  assert.equal(result.plan.photoCount, 40);
  assert.equal(result.dirty, false);
  assert.equal(result.plan.missionCount, 2);
});

test('status reports the panel plan error, not a field the plan never sets', async () => {
  const { handle, state } = fakeHandle();
  state.error = 'too-large';
  state.result = null;
  const result = await createDronePlanVoice(handle).status();
  assert.equal(result.plan, null);
  assert.equal(result.planError, 'too-large');
});

test('draw does not toggle an active tool off', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  await voice.draw('box');
  assert.deepEqual(calls.at(-1), ['drawBox', { toggle: false }]);
});

test('a takeoff point needs an area', async () => {
  const { handle, calls } = fakeHandle();
  const result = await createDronePlanVoice(handle).takeoff({
    takeoff: 'point',
    lat: 32.7,
    lon: -94.9,
  });
  assert.equal(result.error, 'Draw an area first');
  assert.equal(calls.some((call) => call[0] === 'setTakeoff'), false);
});

test('an orbit height above the planner cap is refused', async () => {
  const { handle } = fakeHandle();
  const result = await createDronePlanVoice(handle).options({
    orbitHeightsM: [200],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'That option is outside the panel range');
});

test('suite replans a dirty area before the passes', async () => {
  const { handle, state, calls } = fakeHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  state.dirty = true;
  state.result = {
    totals: { missionCount: 1, photoCount: 4, durationS: 10 },
    terrainComplete: true,
    warnings: [],
  };
  const result = await createDronePlanVoice(handle).suite();
  assert.equal(result.ok, true);
  const names = calls.map((call) => call[0]);
  assert.ok(names.indexOf('replan') < names.indexOf('planSuite'));
});

test('spoken names match one catalog aircraft, including Air 3 beside Air 3S', async () => {
  const { handle, state } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  for (const [spoken, id] of [
    ['Air 3', 'dji-air-3'],
    ['Air 3S', 'dji-air-3s'],
    ['Mavic 3', 'dji-mavic-3'],
  ]) {
    const result = await voice.options({ aircraft: spoken });
    assert.equal(result.ok, true, spoken);
    assert.equal(state.options.presetId, id, spoken);
  }
});

test('a missing panel does not throw', async () => {
  const voice = createDronePlanVoice(null);
  const result = await voice.status();
  assert.deepEqual(result, {
    ok: false,
    error: 'Drone Flight Plan is not available right now',
  });
});
