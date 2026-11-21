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
      // The panel keeps the compact export beside its options, not in them.
      if (Object.hasOwn(patch, 'exportCompact'))
        state.exportCompact = patch.exportCompact === true;
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
    'edit',
    'obstacle',
    'target',
    'path',
    'preview',
    'library',
    'loadPlan',
    'photoCheck',
    'check',
    'units',
    'finish',
    'undo',
    'corner',
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
  assert.equal(
    calls.some((call) => call[0] === 'applyOptions'),
    false,
  );
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

test('voice options cannot forward intervalTriggerProven', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const onlyFlag = await voice.options({ intervalTriggerProven: true });
  assert.equal(onlyFlag.ok, false);
  assert.equal(
    calls.some((call) => call[0] === 'applyOptions'),
    false,
  );
  const spoken = await voice.options({ intervalTriggerProven: true, aglM: 80 });
  assert.equal(spoken.ok, true);
  const patch = calls.find((call) => call[0] === 'applyOptions')[1];
  assert.equal(Object.hasOwn(patch, 'intervalTriggerProven'), false);
  assert.equal(patch.aglM, 80);
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

test('status reports the speed in m/s and mph and the timed-shot interval in seconds', async () => {
  const { handle, state } = fakeHandle();
  state.options.speedMs = 6.7056;
  state.options.captureMode = 'timed';
  state.options.timedIntervalS = 7;
  const status = await createDronePlanVoice(handle).status();
  assert.equal(status.speedMs, 6.7056);
  assert.equal(status.speedMph, 15);
  assert.equal(status.captureMode, 'timed');
  assert.equal(status.timedIntervalS, 7);
  state.options.timedIntervalS = null;
  state.options.captureMode = undefined;
  const none = await createDronePlanVoice(handle).status();
  assert.equal(none.timedIntervalS, null);
  assert.equal(none.captureMode, 'stop');
});

test('options forwards a timed-shot interval in seconds and refuses an unusable one', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const ok = await voice.options({ timedIntervalS: 7 });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls.find((c) => c[0] === 'applyOptions')[1], {
    timedIntervalS: 7,
  });
  // The same rule as the panel field: a small positive number is usable.
  const small = await voice.options({ timedIntervalS: 0.05 });
  assert.equal(small.ok, true);
  // A null is ignored: the tool schema takes a number, so voice cannot clear it.
  const before = calls.length;
  await voice.options({ timedIntervalS: null });
  assert.equal(
    calls
      .slice(before)
      .filter((c) => c[0] === 'applyOptions' && 'timedIntervalS' in c[1])
      .length,
    0,
  );
  for (const bad of [0, -2, 'seven', 4000, NaN, true]) {
    const before = calls.length;
    const refused = await voice.options({ timedIntervalS: bad });
    assert.equal(refused.ok, false, String(bad));
    assert.equal(refused.error, 'That option is outside the panel range');
    assert.equal(calls.length, before);
  }
});

test('box sets coordinates and a refused box does not echo them', async () => {
  const good = fakeHandle();
  const voice = createDronePlanVoice(good.handle);
  const set = await voice.box({
    west: -97.8,
    south: 30.2,
    east: -97.7,
    north: 30.3,
  });
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
  assert.equal(
    calls.some((call) => call[0] === 'planSuite'),
    false,
  );
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

test('options that only affect the export or a file label do not replan', async () => {
  const { handle, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const compact = await voice.options({ exportCompact: true });
  assert.equal(compact.ok, true);
  assert.equal(compact.exportCompact, true);
  assert.equal(
    calls.some((call) => call[0] === 'replan'),
    false,
    'no plan was asked for',
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'applyOptions').at(-1)[2],
    { planNow: false },
    'the panel was told not to plan',
  );
  // The drone code is written into the file, not flown: same rule.
  const code = await voice.options({ droneEnumValue: 68 });
  assert.equal(code.ok, true);
  assert.equal(calls.some((call) => call[0] === 'replan'), false, 'still none');
  // A control the plan depends on still replans, alone or beside the export.
  const planned = await voice.options({ aglM: 90 });
  assert.equal(planned.ok, true);
  assert.equal(calls.filter((call) => call[0] === 'replan').length, 1);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'applyOptions').at(-1)[2],
    { planNow: true },
  );
  const mixed = await voice.options({ exportCompact: false, sideOverlap: 60 });
  assert.equal(mixed.ok, true);
  assert.equal(
    calls.filter((call) => call[0] === 'replan').length,
    2,
    'the export flag never suppresses the plan it rides with',
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'applyOptions').at(-1)[2],
    { planNow: true },
  );
});

test('status echoes no stored string from any option or state field', async () => {
  // A stored credential-shaped string in a field the panel would have written
  // as a number or from a fixed list: the read-back must drop it, never
  // repeat it verbatim, encoded or trimmed.
  const SECRET = 'sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQrStUvWxYz';
  const { handle, state } = panelHandle();
  Object.assign(state.options, {
    pattern: SECRET,
    photoMode: SECRET,
    aglM: SECRET,
    frontOverlap: SECRET,
    sideOverlap: SECRET,
    speedMs: SECRET,
    timedIntervalS: SECRET,
    direction: SECRET,
    orbitRingMode: SECRET,
  });
  state.jobGrouping = SECRET;
  const voice = createDronePlanVoice(handle);
  const summary = await voice.status();
  assert.equal(summary.ok, true);
  for (const key of [
    'pattern',
    'photoMode',
    'aglM',
    'frontOverlap',
    'sideOverlap',
    'speedMs',
    'speedMph',
    'timedIntervalS',
    'direction',
    'orbitRingMode',
    'jobs',
  ])
    assert.equal(summary[key], null, key);
  const text = JSON.stringify(await voice.replan());
  assert.equal(text.includes(SECRET), false, 'replan summary');
  assert.equal(text.includes(encodeURIComponent(SECRET)), false);
  assert.equal(text.includes(SECRET.slice(0, 8)), false);
  assert.equal(text.includes(SECRET.slice(-6)), false);
  // The same fields read back when they hold what the panel writes.
  Object.assign(state.options, {
    pattern: 'orbit',
    photoMode: 'interval',
    aglM: 80,
    frontOverlap: 75,
    sideOverlap: 65,
    speedMs: 4,
    timedIntervalS: 2,
    direction: 'ns',
    orbitRingMode: 'angles',
  });
  state.jobGrouping = 'whole';
  const good = await voice.status();
  assert.equal(good.pattern, 'orbit');
  assert.equal(good.photoMode, 'interval');
  assert.equal(good.aglM, 80);
  assert.equal(good.frontOverlap, 75);
  assert.equal(good.sideOverlap, 65);
  assert.equal(good.speedMs, 4);
  assert.equal(good.speedMph, 8.9);
  assert.equal(good.timedIntervalS, 2);
  assert.equal(good.direction, 'ns');
  assert.equal(good.orbitRingMode, 'angles');
  assert.equal(good.jobs, 'whole');
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
  assert.equal(
    calls.some((call) => call[0] === 'setTakeoff'),
    false,
  );
});

test('an orbit height above the planner cap is refused', async () => {
  const { handle } = fakeHandle();
  const result = await createDronePlanVoice(handle).options({
    orbitHeightsM: [457.3],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'That option is outside the panel range');
});

test('heights up to the 1500 ft planning maximum (457.2 m) are accepted by voice, above it refused', async () => {
  for (const aglM of [120, 200, 457.2]) {
    const { handle, state } = fakeHandle();
    const result = await createDronePlanVoice(handle).options({ aglM });
    assert.equal(result.ok, true, `${aglM} m accepted`);
    assert.equal(state.options.aglM, aglM);
  }
  const { handle } = fakeHandle();
  const over = await createDronePlanVoice(handle).options({ aglM: 457.3 });
  assert.equal(over.ok, false);
  assert.equal(over.error, 'That option is outside the panel range');
  const rings = await createDronePlanVoice(fakeHandle().handle).options({
    orbitHeightsM: [200, 457.2],
  });
  assert.equal(rings.ok, true);
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

test('recommend takes the Mapping Grid (Timed) mode and refuses an unknown one', async () => {
  const { handle, calls } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const ok = await voice.recommend('mapping-grid-timed');
  assert.equal(ok.ok, true);
  assert.equal(
    calls.find((c) => c[0] === 'useRecommended')[1],
    'mapping-grid-timed',
  );
  const bad = await voice.recommend('mapping-grid-faster');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /mapping-grid-timed/);
  const patch = await voice.options({ mode: 'mapping-grid-timed' });
  assert.equal(patch.ok, true);
  assert.equal(
    calls.filter((c) => c[0] === 'applyOptions').at(-1)[1].mode,
    'mapping-grid-timed',
  );
});

/* ---- The controls the panel shows that status used to leave out ---- */

/**
 * The same panel double, with the handles the new actions call and the state
 * the new read-backs read.
 */
function panelHandle(over = {}) {
  const made = fakeHandle(over);
  const { handle, state, calls } = made;
  const obstacles = [];
  let nextObstacle = 1;
  state.options.orbitTargets = [
    { id: 'target-1', lat: 32.7, lon: -94.9, active: true },
  ];
  state.options.lookAtPaths = [{ id: 'path-1', points: [], active: true }];
  state.check = {
    enabled: true,
    zone: false,
    curtain: false,
    footprints: 'selected',
    frustum: 'one',
    index: 0,
    halfWidthM: 3,
  };
  state.surface = { enabled: false, status: 'idle', minM: 2, marginM: 1, ids: [] };
  // The path tool as the panel runs it: a draft stays open until the button
  // finishes it, and a start-only request never finishes it.
  const draft = { open: false };
  const startPath = ({ toggle = true } = {}) => {
    calls.push(['startDrawPath', { toggle }]);
    if (draft.open) {
      if (!toggle) return true;
      draft.open = false;
      return false;
    }
    draft.open = true;
    return true;
  };
  Object.assign(handle, {
    editArea(id, options) {
      calls.push(['editArea', id, options]);
      return true;
    },
    addOrbitTarget(point) {
      calls.push(['addOrbitTarget', point]);
      state.options.orbitTargets.push({
        id: `target-${state.options.orbitTargets.length + 1}`,
        lat: point.lat,
        lon: point.lon,
        active: true,
      });
      return true;
    },
    removeOrbitTarget(id) {
      calls.push(['removeOrbitTarget', id]);
      const before = state.options.orbitTargets.length;
      state.options.orbitTargets = state.options.orbitTargets.filter(
        (target) => target.id !== id,
      );
      return state.options.orbitTargets.length < before;
    },
    recommendTargets() {
      calls.push(['recommendTargets']);
      return state.options.orbitTargets.length;
    },
    addLookAtPath(points) {
      calls.push(['addLookAtPath', points]);
      state.options.lookAtPaths.push({
        id: `path-${state.options.lookAtPaths.length + 1}`,
        points,
        active: true,
      });
      return true;
    },
    removeLookAtPath(id) {
      calls.push(['removeLookAtPath', id]);
      const before = state.options.lookAtPaths.length;
      state.options.lookAtPaths = state.options.lookAtPaths.filter(
        (path) => path.id !== id,
      );
      return state.options.lookAtPaths.length < before;
    },
    startDrawPath: startPath,
    toggleDrawPath() {
      calls.push(['toggleDrawPath']);
      return startPath({ toggle: true });
    },
    checkInfo() {
      const count = Math.max(0, state.checkPhotoCount ?? 12);
      const index = Math.min(
        Math.max(0, state.check.index ?? 0),
        Math.max(0, count - 1),
      );
      return { count, index, current: count ? { passId: 'mission-1' } : null };
    },
    obstacles: {
      list: () => obstacles,
      add(point) {
        calls.push(['obstacleAdd', point]);
        const made = {
          id: `user-${nextObstacle++}`,
          kind: 'tree',
          heightM: point.heightM ?? 15,
          lat: point.lat,
          lon: point.lon,
        };
        obstacles.push(made);
        return made;
      },
      remove(id) {
        calls.push(['obstacleRemove', id]);
        const at = obstacles.findIndex((item) => item.id === id);
        if (at < 0) return false;
        obstacles.splice(at, 1);
        return true;
      },
      setHeight(id, heightM) {
        calls.push(['obstacleHeight', id, heightM]);
        const item = obstacles.find((one) => one.id === id);
        if (!item) return false;
        item.heightM = heightM;
        return true;
      },
      // A look-up that finishes later: the row only exists once it resolves,
      // so a count read before the await is the stale one.
      refresh() {
        calls.push(['obstacleRefresh']);
        return Promise.resolve().then(() => {
          obstacles.push({
            id: 'osm-1',
            kind: 'tree',
            heightM: 9,
            lat: 32.7,
            lon: -94.9,
          });
          return true;
        });
      },
    },
    downloadPreview(index) {
      calls.push(['downloadPreview', index]);
      return true;
    },
    loadPlan: async (plan) => {
      calls.push(['loadPlan', plan]);
      state.areas = [{ id: 'area-1', kind: 'rect' }];
      return true;
    },
    library: () => ({
      state: {
        scope: 'mine',
        trash: false,
        plans: [{}, {}],
        current: { readOnly: true },
        busy: false,
      },
      currentLabel: () => ({ no: 7, name: SECRET }),
    }),
    photoCheck: () => ({
      analysis: () => ({
        summary: {
          photoCount: 12,
          plannedCount: 15,
          coveredCount: 11,
          missingCount: 4,
          offPlanCount: 1,
          gapCount: 2,
          breakCount: 1,
        },
      }),
    }),
    setCheck(patch) {
      calls.push(['setCheck', patch]);
      Object.assign(state.check, patch);
      return true;
    },
    setSurface(patch) {
      calls.push(['setSurface', patch]);
      Object.assign(state.surface, patch);
      return true;
    },
    chooseUnits(system) {
      calls.push(['chooseUnits', system]);
    },
    finishPolygon() {
      calls.push(['finishPolygon']);
      return true;
    },
    undoPolygonCorner() {
      calls.push(['undoPolygonCorner']);
      return true;
    },
    removePolygonCorner() {
      calls.push(['removePolygonCorner']);
      return true;
    },
  });
  return { handle, state, calls, obstacles };
}

test('options sets every control the panel shows, inside its own range', async () => {
  const cases = [
    [{ captureMode: 'timed' }, 'captureMode', 'timed'],
    [{ photoSpacingM: 2.5 }, 'photoSpacingM', 2.5],
    // The panel keeps any positive spacing (cleanPhotoSpacingM): 0.05 m is a
    // legal spacing and must not be refused by a made-up 0.1 m floor.
    [{ photoSpacingM: 0.05 }, 'photoSpacingM', 0.05],
    [{ orbitAnglesDeg: [25, 40] }, 'orbitAnglesDeg', [25, 40]],
    [{ orbitOutward: true }, 'orbitOutward', true],
    [{ orbitOutwardPitchDeg: -5 }, 'orbitOutwardPitchDeg', -5],
    [{ orbitTargetHeightM: 12 }, 'orbitTargetHeightM', 12],
    [{ obstacleHeightM: 18 }, 'obstacleHeightM', 18],
    [{ maxWaypoints: 120 }, 'maxWaypoints', 120],
    [{ usableBatteryMin: 25 }, 'usableBatteryMin', 25],
    [{ continuousRoute: true }, 'continuousRoute', true],
    [{ cameraPresetId: 'mapping-50mp' }, 'cameraPresetId', 'mapping-50mp'],
    [{ minPhotoIntervalS: 2 }, 'minPhotoIntervalS', 2],
    [{ exportCompact: true }, 'exportCompact', true],
  ];
  for (const [patch, key, value] of cases) {
    const { handle, calls } = panelHandle();
    const result = await createDronePlanVoice(handle).options(patch);
    assert.equal(result.ok, true, key);
    const applied = calls.filter((call) => call[0] === 'applyOptions').at(-1);
    assert.deepEqual(applied[1][key], value, key);
  }
});

test('options refuses every control outside the panel range', async () => {
  const refused = [
    { captureMode: 'burst' },
    { photoSpacingM: 0 },
    { photoSpacingM: -1 },
    { photoSpacingM: '2' },
    { orbitAnglesDeg: [9] },
    { orbitAnglesDeg: [] },
    { orbitAnglesDeg: [10, 20, 30, 40, 50, 60, 70] },
    { orbitOutward: 'yes' },
    { orbitOutwardPitchDeg: -46 },
    { orbitTargetHeightM: 61 },
    { obstacleHeightM: -1 },
    { maxWaypoints: 19 },
    { maxWaypoints: 201 },
    { usableBatteryMin: 61 },
    { continuousRoute: 1 },
    { cameraPresetId: 'no-such-preset' },
    { minPhotoIntervalS: 0.05 },
    { minPhotoIntervalS: 61 },
    { exportCompact: 'true' },
  ];
  for (const patch of refused) {
    const { handle, calls } = panelHandle();
    const result = await createDronePlanVoice(handle).options(patch);
    const label = Object.keys(patch)[0];
    assert.equal(result.ok, false, label);
    assert.equal(result.error, 'That option is outside the panel range', label);
    assert.equal(
      calls.some((call) => call[0] === 'applyOptions'),
      false,
      label,
    );
  }
});

test('status reports every settable field the panel shows', async () => {
  const { handle, state } = panelHandle();
  Object.assign(state.options, {
    direction: 'ns',
    tiltPitchDeg: -60,
    orbitRadiusM: 40,
    orbitHeightsM: [40, 80],
    shutterDenominator: 1000,
    batteryMin: 20,
    photoSpacingM: 1.5,
    continuousRoute: true,
    maxWaypoints: 150,
    usableBatteryMin: 25,
    obstacleHeightM: 18,
    orbitTargetHeightM: 6,
    orbitRingMode: 'heights',
    orbitAnglesDeg: [25],
    orbitOutward: true,
    orbitOutwardPitchDeg: -5,
    cameraPresetId: 'mapping-50mp',
    minPhotoIntervalS: 2,
  });
  state.wpml = { droneEnumValue: 68 };
  state.exportCompact = true;
  const result = await createDronePlanVoice(handle).status();
  for (const key of [
    'direction',
    'tiltPitchDeg',
    'orbitRadiusM',
    'orbitHeightsM',
    'shutterDenominator',
    'batteryMin',
    'droneEnumValue',
    'photoSpacingM',
    'continuousRoute',
    'maxWaypoints',
    'usableBatteryMin',
    'obstacleHeightM',
    'orbitTargetHeightM',
    'orbitRingMode',
    'orbitAnglesDeg',
    'orbitOutward',
    'orbitOutwardPitchDeg',
    'cameraPresetId',
    'minPhotoIntervalS',
    'exportCompact',
    'orbitTargets',
    'lookAtPaths',
    'obstacles',
  ]) {
    assert.ok(Object.hasOwn(result, key), key);
  }
  assert.equal(result.direction, 'ns');
  assert.equal(result.photoSpacingM, 1.5);
  assert.equal(result.cameraPresetId, 'mapping-50mp');
  assert.equal(result.minPhotoIntervalS, 2);
  assert.equal(result.exportCompact, true);
  assert.deepEqual(result.orbitTargets, [
    { id: 'target-1', lat: 32.7, lon: -94.9, active: true },
  ]);
  assert.deepEqual(result.lookAtPaths, [
    { id: 'path-1', points: 0, active: true },
  ]);
});

test('edit starts corner editing on the area it names, without toggling', async () => {
  const { handle, state, calls } = panelHandle();
  state.areas = [
    { id: 'area-1', kind: 'rect' },
    { id: 'area-2', kind: 'polygon' },
  ];
  const voice = createDronePlanVoice(handle);
  const byIndex = await voice.edit({ index: 1 });
  assert.equal(byIndex.ok, true);
  assert.deepEqual(calls.at(-1), ['editArea', 'area-2', { toggle: false }]);
  const byId = await voice.edit({ areaId: 'area-1' });
  assert.equal(byId.ok, true);
  assert.equal(calls.at(-1)[1], 'area-1');
  const missing = await voice.edit({ areaId: 'area-9' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'No area matched.');
});

test('obstacle adds a point, re-heights one, removes one, and refreshes', async () => {
  const { handle, state, calls, obstacles } = panelHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  const voice = createDronePlanVoice(handle);
  const added = await voice.obstacle({ lat: 32.7, lon: -94.9, obstacleHeightM: 22 });
  assert.equal(added.ok, true);
  assert.equal(added.obstacleCount, 1);
  assert.equal(obstacles[0].heightM, 22);
  const raised = await voice.obstacle({ index: 0, obstacleHeightM: 30 });
  assert.equal(raised.ok, true);
  assert.equal(obstacles[0].heightM, 30);
  const refreshed = await voice.obstacle();
  assert.equal(refreshed.ok, true);
  assert.equal(calls.at(-1)[0], 'obstacleRefresh');
  // The look-up adds a row when it finishes: the count is the one after it.
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.obstacleCount, 2);
  const removed = await voice.obstacle({ index: 0 });
  assert.equal(removed.ok, true);
  assert.equal(removed.obstacleCount, 1);
  assert.equal((await voice.obstacle({ index: 5 })).error, 'No obstacle at that index');
  const gone = await voice.obstacle({ index: 0 });
  assert.equal(gone.ok, true);
  assert.equal((await voice.obstacle({ index: 0 })).error, 'No obstacle at that index');
  const badPoint = await voice.obstacle({ lat: 32.7 });
  assert.equal(badPoint.error, 'point needs lat and lon');
});

test('an obstacle height outside the panel range is refused, not swapped for a tree', async () => {
  const { handle, state, calls, obstacles } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const before = calls.length;
  const tooTall = await voice.obstacle({
    lat: 32.7,
    lon: -94.9,
    obstacleHeightM: 61,
  });
  assert.equal(tooTall.ok, false);
  assert.equal(tooTall.error, 'That option is outside the panel range');
  assert.equal(obstacles.length, 0, 'nothing was added');
  assert.equal(calls.length, before, 'the panel was not called');
  // The panel's own top of the range is still taken as given.
  const tallest = await voice.obstacle({
    lat: 32.7,
    lon: -94.9,
    obstacleHeightM: 60,
  });
  assert.equal(tallest.ok, true);
  assert.equal(obstacles[0].heightM, 60);
  assert.equal(state.areas.length, 0);
});

test('an obstacle refresh says it refreshed only when a look-up really ran', async () => {
  const { handle } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.obstacle();
  assert.equal(result.refreshed, true);
  // The panel returns null when there is nothing to look up (no area drawn).
  handle.obstacles.refresh = () => null;
  const none = await voice.obstacle();
  assert.equal(none.ok, true);
  assert.equal(none.refreshed, false);
});

test('an obstacle refresh answers with the count from after the look-up, not before', async () => {
  const { handle, obstacles } = panelHandle();
  // A look-up that finishes on a later tick and adds two rows: a count read
  // before the await would answer the list as it was.
  handle.obstacles.refresh = () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        obstacles.push({ id: 'osm-1' }, { id: 'osm-2' });
        resolve(true);
      }, 5),
    );
  };
  const result = await createDronePlanVoice(handle).obstacle();
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.obstacleCount, 2);
  // A look-up that finishes with nothing to add is not a refresh that ran.
  handle.obstacles.refresh = () => Promise.resolve(false);
  const none = await createDronePlanVoice(handle).obstacle();
  assert.equal(none.refreshed, false);
  assert.equal(none.obstacleCount, 2);
});

test('a spoken target request never rebuilds a list with hand work in it', async () => {
  const { handle, state, calls } = panelHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  state.options.orbitTargets.push({
    id: 'target-2',
    lat: 32.72,
    lon: -94.92,
    active: true,
    source: 'custom',
  });
  const voice = createDronePlanVoice(handle);
  const refused = await voice.target();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /by hand/);
  assert.equal(calls.some((call) => call[0] === 'recommendTargets'), false);
  assert.equal(state.options.orbitTargets.length, 2);
  // A hand-changed target counts too, even when its source is a footprint.
  state.options.orbitTargets = [
    { id: 'target-1', lat: 32.7, lon: -94.9, active: true, source: 'building' },
  ];
  state.orbitTargetsTouched = true;
  assert.equal((await voice.target()).ok, false);
  assert.equal(calls.some((call) => call[0] === 'recommendTargets'), false);
  // A list nothing has touched is rebuilt, as the panel button does.
  state.orbitTargetsTouched = false;
  const rebuilt = await voice.target();
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.recommended, true);
  assert.equal(calls.at(-1)[0], 'recommendTargets');
});

test('target adds a point and removes one by index', async () => {
  const { handle, state, calls } = panelHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  const voice = createDronePlanVoice(handle);
  const added = await voice.target({ lat: 32.71, lon: -94.91 });
  assert.equal(added.ok, true);
  assert.equal(added.targetCount, 2);
  const removed = await voice.target({ index: 0 });
  assert.equal(removed.ok, true);
  assert.equal(removed.targetCount, 1);
  assert.deepEqual(calls.find((call) => call[0] === 'removeOrbitTarget')[1], 'target-1');
  const gone = await voice.target({ index: 5 });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, 'No target at that index');
  const badPoint = await voice.target({ lat: 32.7 });
  assert.equal(badPoint.error, 'point needs lat and lon');
});

test('path adds the ring points, removes one by index, and starts drawing', async () => {
  const { handle, state, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const added = await voice.path({
    ring: [
      { lon: -94.9, lat: 32.7 },
      { lon: -94.91, lat: 32.71 },
    ],
  });
  assert.equal(added.ok, true);
  assert.equal(added.pathCount, 2);
  const points = calls.find((call) => call[0] === 'addLookAtPath')[1];
  assert.deepEqual(points, [
    { lon: -94.9, lat: 32.7 },
    { lon: -94.91, lat: 32.71 },
  ]);
  const drawing = await voice.path();
  assert.equal(drawing.ok, true);
  assert.equal(drawing.drawing, true);
  const removed = await voice.path({ index: 0 });
  assert.equal(removed.ok, true);
  assert.equal(removed.pathCount, 1);
  const bad = await voice.path({ ring: [{ lon: 0, lat: 0 }, { lon: 999, lat: 0 }] });
  assert.equal(bad.ok, false);
});

test('a polygon takes every corner count the panel accepts, and still needs three', async () => {
  const { handle, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const circle = (n) =>
    Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return {
        lon: -94.9 + 0.001 * Math.cos(a),
        lat: 32.7 + 0.001 * Math.sin(a),
      };
    });
  // The panel's drawing tool and addPolygon() have no corner ceiling, so a
  // spoken polygon must not invent one either.
  const many = await voice.polygon(circle(120));
  assert.equal(many.ok, true);
  assert.equal(many.points, 120);
  assert.equal(calls.find((call) => call[0] === 'setPolygon')[1].length, 120);
  // Three corners is the real floor (polygon.js), and it is the adapter's job.
  const two = await voice.polygon(circle(2));
  assert.equal(two.ok, false);
  assert.equal(two.error, 'ring needs at least 3 points');
});

test('the 3D check steps to any photo the plan has, not a fixed index ceiling', async () => {
  const { handle, state } = panelHandle();
  state.checkPhotoCount = 8400;
  const voice = createDronePlanVoice(handle);
  const at60 = await voice.check({ index: 60 });
  assert.equal(at60.ok, true);
  assert.equal(at60.check.index, 60);
  assert.equal((await voice.status()).check.index, 60);
  // The list length is the only ceiling: one past the last photo is refused…
  const past = await voice.check({ index: 8400 });
  assert.equal(past.ok, false);
  assert.equal(past.error, 'That flight index cannot be shown');
  // …and a negative index or a fraction is not a list position at all.
  for (const bad of [-1, 1.5, '3']) {
    const refused = await voice.check({ index: bad });
    assert.equal(refused.ok, false, String(bad));
    assert.equal(refused.error, 'index must be zero or more', String(bad));
  }
});

test('a path a spoken request adds is active, and switching one off keeps it in the list', async () => {
  const { handle, state } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const added = await voice.path({
    ring: [
      { lon: -94.9, lat: 32.7 },
      { lon: -94.91, lat: 32.71 },
    ],
  });
  assert.equal(added.ok, true);
  // The panel flies only the paths it has switched on; a path added by voice
  // must be one of them, not a listed path the planner drops.
  const paths = state.options.lookAtPaths;
  assert.equal(paths.at(-1).active, true);
  assert.equal(added.pathCount, paths.length);
  // The panel's list keeps a path switched off and shows it in place: an
  // index counts every path, on or off, so voice removes the one it names.
  paths[0].active = false;
  const read = await voice.path({ index: 0 });
  assert.equal(read.ok, true);
  assert.equal(state.options.lookAtPaths.some((x) => x.id === 'path-1'), false);
  assert.equal(read.pathCount, 1);
});

test('a spoken path start never finishes the draft a person is placing', async () => {
  const { handle, calls } = panelHandle();
  let draft = [{ lat: 32.7, lon: -94.9 }];
  handle.startDrawPath = (options) => {
    calls.push(['startDrawPath', options]);
    // The panel button toggles; a start-only request leaves the draft alone.
    if (draft) {
      if (options?.toggle === false) return true;
      draft = null;
      return false;
    }
    draft = [{ lat: 32.71, lon: -94.91 }];
    return true;
  };
  const voice = createDronePlanVoice(handle);
  const first = await voice.path();
  assert.equal(first.ok, true);
  assert.equal(first.drawing, true);
  const again = await voice.path();
  assert.equal(again.ok, true);
  assert.equal(again.drawing, true);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'startDrawPath').map((c) => c[1].toggle),
    [false, false],
  );
  assert.equal(draft.length, 1, 'the corners already placed are still there');
  // Nothing is committed: the path list is the one the panel started with.
  assert.equal(handle.getState().options.lookAtPaths.length, 1);
});

test('preview draws the picture of the flight index it names', async () => {
  const { handle, state, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const none = await voice.preview();
  assert.equal(none.ok, false);
  state.result = {
    missions: [{}, {}],
    totals: { missionCount: 2, photoCount: 8, durationS: 60 },
  };
  const drawn = await voice.preview({ index: 1 });
  assert.equal(drawn.ok, true);
  assert.deepEqual(calls.at(-1), ['downloadPreview', 1]);
  const out = await voice.preview({ index: 2 });
  assert.equal(out.ok, false);
  state.result = null;
  const refused = await voice.preview();
  assert.equal(refused.error, 'Downloads are not available yet');
});

test('library reads the counts and never repeats a plan name', async () => {
  const { handle } = panelHandle();
  const result = await createDronePlanVoice(handle).library();
  assert.equal(result.ok, true);
  assert.equal(result.planCount, 2);
  assert.equal(result.currentPlanNo, 7);
  assert.equal(result.readOnly, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('loadPlan restores a document and reports the replanned state', async () => {
  const { handle, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const missing = await voice.loadPlan();
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'loadPlan needs a plan document');
  const loaded = await voice.loadPlan({ plan: { areas: [] } });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.areaCount, 1);
  assert.deepEqual(calls.find((call) => call[0] === 'loadPlan')[1], {
    areas: [],
  });
});

test('a refused plan document is reported as invalid, not as an unavailable panel', async () => {
  const { handle } = panelHandle();
  const voice = createDronePlanVoice(handle);
  handle.loadPlan = async () => {
    throw Object.assign(new Error('not-a-plan'), { gevPlanRejected: true });
  };
  const refused = await voice.loadPlan({ plan: { schema: 'nope' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'That is not a valid Drone Flight Plan document');
  // The reader's own reason is never repeated to the caller.
  assert.equal(JSON.stringify(refused).includes('not-a-plan'), false);
  // A panel failure that is not a refused document keeps the unavailable note.
  handle.loadPlan = async () => {
    throw new Error('terrain');
  };
  const failed = await voice.loadPlan({ plan: { schema: 'nope' } });
  assert.equal(failed.error, 'Drone Flight Plan is not available right now');
});

test('photoCheck reports the coverage numbers, not the photo names', async () => {
  const { handle } = panelHandle();
  const result = await createDronePlanVoice(handle).photoCheck();
  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.equal(result.photoCount, 12);
  assert.equal(result.missingCount, 4);
  assert.equal(result.gapCount, 2);
});

test('check reads the 3D check state and shows the flight it names', async () => {
  const { handle, state } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const read = await voice.check();
  assert.equal(read.ok, true);
  assert.equal(read.check.enabled, true);
  assert.equal(read.surface.status, 'idle');
  const set = await voice.check({ index: 2 });
  assert.equal(set.ok, true);
  assert.equal(set.check.index, 2);
  assert.equal(state.check.index, 2);
  const bad = await voice.check({ index: 60 });
  assert.equal(bad.ok, false);
});

test('check sets the panel check switches and reads them back', async () => {
  const { handle, state, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.check({
    checkEnabled: false,
    checkZone: true,
    checkCurtain: true,
    checkFootprints: 'all',
    checkFrustum: 'neighbors',
    // The Zone half-width slider: checkGeometry.js runs 2 to 30 m.
    zoneHalfWidthM: 20,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1), [
    'setCheck',
    {
      enabled: false,
      zone: true,
      curtain: true,
      footprints: 'all',
      frustum: 'neighbors',
      halfWidthM: 20,
    },
  ]);
  assert.equal(result.check.enabled, false);
  assert.equal(result.check.zone, true);
  assert.equal(result.check.footprints, 'all');
  assert.equal(result.check.frustum, 'neighbors');
  assert.equal(result.check.halfWidthM, 20);
  assert.equal(state.check.halfWidthM, 20);
  // Both ends of the slider are panel values.
  assert.equal((await voice.check({ zoneHalfWidthM: 2 })).ok, true);
  assert.equal((await voice.check({ zoneHalfWidthM: 30 })).ok, true);
});

test('check turns the surface model on and sets its two sliders', async () => {
  const { handle, state, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  const result = await voice.check({
    surfaceEnabled: true,
    surfaceMinM: 5,
    surfaceMarginM: 2.5,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1), [
    'setSurface',
    { enabled: true, minM: 5, marginM: 2.5 },
  ]);
  assert.equal(result.surface.enabled, true);
  assert.equal(result.surface.minM, 5);
  assert.equal(result.surface.marginM, 2.5);
  assert.equal(state.surface.enabled, true);
  // The slider ends: 0 and CLEARANCE_MAX_M (61 m).
  assert.equal((await voice.check({ surfaceMinM: 0 })).ok, true);
  assert.equal((await voice.check({ surfaceMinM: 61 })).ok, true);
  assert.equal((await voice.check({ surfaceMarginM: 61 })).ok, true);
});

test('check and surface are one step: a surface refusal puts the check switches back', async () => {
  const { handle, state, calls } = panelHandle();
  const before = { ...state.surface };
  // The panel takes the check and then refuses the surface values: without a
  // rollback the switches would stay flipped behind a refusal.
  handle.setSurface = (patch) => {
    calls.push(['setSurface', patch]);
    return false;
  };
  const voice = createDronePlanVoice(handle);
  const refused = await voice.check({
    checkZone: true,
    surfaceEnabled: true,
    surfaceMinM: 5,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'That option is outside the panel range');
  assert.equal(state.check.zone, false, 'the check switch is back as it was');
  assert.deepEqual(state.surface, before, 'no surface value was applied');
  // The check landed, the surface was refused, and only then was the check
  // put back — one request, one visible outcome.
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['setCheck', 'setSurface', 'setCheck'],
  );
  assert.deepEqual(calls[0][1], { zone: true });
  assert.deepEqual(calls[2][1], { zone: false });
});

test('check and surface are one step: a check refusal never touches the surface', async () => {
  const { handle, state, calls } = panelHandle();
  const before = { ...state.surface };
  handle.setCheck = (patch) => {
    calls.push(['setCheck', patch]);
    return false;
  };
  const voice = createDronePlanVoice(handle);
  const refused = await voice.check({ checkZone: true, surfaceEnabled: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'That option is outside the panel range');
  assert.equal(
    calls.some((call) => call[0] === 'setSurface'),
    false,
    'the surface was never asked',
  );
  assert.deepEqual(state.surface, before);
});

test('check index: refused at apply time, and the surface settings stay as they were', async () => {
  const { handle, state, calls } = panelHandle();
  // The count the voice read says 12 flights; the panel's own stepper is over
  // the 3 photos that exist by the time the patch lands.
  handle.checkInfo = () => ({ count: 12, index: 0, current: {} });
  const real = handle.setCheck;
  handle.setCheck = (patch) => {
    calls.push(['setCheck', patch]);
    if (Object.hasOwn(patch, 'index')) return false;
    return real.call(handle, patch);
  };
  const voice = createDronePlanVoice(handle);
  const refused = await voice.check({ index: 5, surfaceEnabled: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'That flight index cannot be shown');
  assert.equal(state.check.index, 0);
  assert.equal(state.surface.enabled, false, 'no surface switch was flipped');
  assert.equal(calls.some((call) => call[0] === 'setSurface'), false);
});

test('check and surface are one step: a switch the panel never held is not claimed back', async () => {
  const { handle, state } = panelHandle();
  // This panel has no curtain value to restore: the setter cannot unset it, so
  // the request cannot be undone. It says so instead of claiming a clean
  // refusal, and the surface half is still untouched.
  delete state.check.curtain;
  handle.setSurface = () => false;
  const voice = createDronePlanVoice(handle);
  const refused = await voice.check({ checkCurtain: true, surfaceEnabled: true });
  assert.equal(refused.ok, false);
  assert.equal(
    refused.error,
    'The check and surface settings could not be changed together',
  );
  assert.equal(state.check.curtain, true, 'the caveat, stated not hidden');
  assert.equal(state.surface.enabled, false);
});

test('check refuses a switch or slider outside the panel bounds, changing nothing', async () => {
  const { handle, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  for (const bad of [
    { checkEnabled: 'yes' },
    { checkZone: 1 },
    { checkFootprints: 'few' },
    { checkFrustum: 'many' },
    { zoneHalfWidthM: 1 },
    { zoneHalfWidthM: 31 },
    { zoneHalfWidthM: '20' },
    { surfaceEnabled: 1 },
    { surfaceMinM: -1 },
    { surfaceMinM: 62 },
    { surfaceMarginM: 62 },
    { surfaceMarginM: NaN },
  ]) {
    const before = calls.length;
    const refused = await voice.check(bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
    assert.equal(
      refused.error,
      'That option is outside the panel range',
      JSON.stringify(bad),
    );
    assert.equal(calls.length, before, JSON.stringify(bad));
  }
});

test('a panel without the check or surface handle refuses instead of guessing', async () => {
  const { handle } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  const check = await voice.check({ checkZone: true });
  assert.equal(check.ok, false);
  assert.match(check.error, /not available/);
  const surface = await voice.check({ surfaceEnabled: true });
  assert.equal(surface.ok, false);
  assert.match(surface.error, /not available/);
});

test('units switches the panel between feet and metres', async () => {
  const { handle, calls } = panelHandle();
  const voice = createDronePlanVoice(handle);
  assert.deepEqual(await voice.units({ units: 'm' }), { ok: true, units: 'm' });
  assert.deepEqual(calls.at(-1), ['chooseUnits', 'm']);
  const bad = await voice.units({ units: 'km' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'units must be ft or m');
});

test('finish, undo and corner call the polygon buttons', async () => {
  const { handle, state, calls } = panelHandle();
  state.areas = [{ id: 'area-1', kind: 'polygon' }];
  const voice = createDronePlanVoice(handle);
  assert.deepEqual(await voice.undo(), { ok: true, undone: true });
  assert.deepEqual(await voice.corner(), { ok: true, removed: true });
  const finished = await voice.finish();
  assert.equal(finished.ok, true);
  assert.equal(finished.areaCount, 1);
  const names = calls.map((call) => call[0]);
  assert.deepEqual(names, [
    'undoPolygonCorner',
    'removePolygonCorner',
    'finishPolygon',
  ]);
});

test('a secret typed into a new action is never repeated', async () => {
  const { handle } = panelHandle();
  const voice = createDronePlanVoice(handle);
  for (const result of [
    await voice.units({ units: SECRET }),
    await voice.obstacle({ lat: SECRET, lon: 0 }),
    await voice.target({ index: SECRET }),
    await voice.path({ index: SECRET }),
    await voice.check({ index: SECRET }),
    await voice.check({ checkFootprints: SECRET }),
    await voice.check({ zoneHalfWidthM: SECRET }),
    await voice.check({ surfaceMinM: SECRET }),
    await voice.edit({ areaId: SECRET }),
    await voice.preview({ index: SECRET }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('the check and surface settings are in the tool schema and reach the panel', async () => {
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  // The shipped tool payload: the bounds are the panel's own, not guesswork.
  const { GEV_REALTIME_TOOLS } = await import(
    '../../../server/providers/openai/tools.js'
  );
  const tool = GEV_REALTIME_TOOLS.find(
    (item) => item.name === 'control_droneplan',
  );
  const props = tool.parameters.properties;
  for (const key of [
    'checkEnabled',
    'checkZone',
    'checkCurtain',
    'checkFootprints',
    'checkFrustum',
    'zoneHalfWidthM',
    'surfaceEnabled',
    'surfaceMinM',
    'surfaceMarginM',
  ]) {
    assert.ok(Object.hasOwn(props, key), key);
  }
  assert.equal(props.checkEnabled.type, 'boolean');
  assert.equal(props.surfaceEnabled.type, 'boolean');
  assert.deepEqual(props.checkFootprints.enum, ['selected', 'all', 'off']);
  assert.deepEqual(props.checkFrustum.enum, [
    'one',
    'thinned',
    'neighbors',
    'off',
  ]);
  // checkGeometry.js: MIN_ZONE_HALF_WIDTH_M / MAX_ZONE_HALF_WIDTH_M.
  assert.equal(props.zoneHalfWidthM.minimum, 2);
  assert.equal(props.zoneHalfWidthM.maximum, 30);
  // prefs.js CLEARANCE_MAX_M.
  assert.equal(props.surfaceMinM.minimum, 0);
  assert.equal(props.surfaceMinM.maximum, 61);
  assert.equal(props.surfaceMarginM.minimum, 0);
  assert.equal(props.surfaceMarginM.maximum, 61);

  // Through the real dispatcher: the model's fields land on the panel handle.
  const { createGevActionRunner } = await import('../../voice/gevActions.js');
  const { handle, calls } = panelHandle();
  const scene = {
    canvas: { addEventListener() {}, removeEventListener() {} },
  };
  const runner = createGevActionRunner({
    // A Cesium viewer has its own canvas; cameraVerbs reads it there.
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene,
      get canvas() {
        return scene.canvas;
      },
      camera: { moveEnd: { addEventListener() {} } },
    },
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    dronePlan: () => createDronePlanVoice(handle),
  });
  const result = await runner('control_droneplan', {
    action: 'check',
    checkZone: false,
    checkFootprints: 'all',
    zoneHalfWidthM: 20,
    surfaceEnabled: true,
    surfaceMinM: 5,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-2), [
    'setCheck',
    { zone: false, footprints: 'all', halfWidthM: 20 },
  ]);
  assert.deepEqual(calls.at(-1), ['setSurface', { enabled: true, minM: 5 }]);
  assert.equal(result.check.zone, false);
  assert.equal(result.check.footprints, 'all');
  assert.equal(result.check.halfWidthM, 20);
  assert.equal(result.surface.enabled, true);
  assert.equal(result.surface.minM, 5);
});

test('a panel without the new handles refuses instead of throwing', async () => {
  const { handle } = fakeHandle();
  const voice = createDronePlanVoice(handle);
  for (const result of [
    await voice.finish(),
    await voice.undo(),
    await voice.corner(),
    await voice.units({ units: 'ft' }),
    await voice.library(),
    await voice.photoCheck(),
  ]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /not available/);
  }
  // The obstacle store is missing: adding a point is refused, not guessed.
  const obstacle = await voice.obstacle({ lat: 32.7, lon: -94.9 });
  assert.equal(obstacle.ok, false);
});

// ------------------------------------------------- false success / failure --
// A download that is still being compressed or drawn is not a refusal: the
// voice used to check a synchronous `true`, so every compact export and every
// labelled zip was reported as "not available" while the file was written.
const after = (value, log, delayMs = 5) =>
  new Promise((resolve) =>
    setTimeout(() => {
      log.push(value);
      resolve(value);
    }, delayMs),
  );

test('download waits for a panel that answers with a promise, and keeps the file', async () => {
  const done = [];
  const { handle, state } = fakeHandle({
    downloadMission: () => after(true, done),
    downloadAll: () => after(true, done),
    downloadSuite: () => after(true, done),
  });
  state.result = { missions: [{}] };
  state.suite = { passes: [{ id: 'nadir', result: { missions: [{}] } }] };
  const voice = createDronePlanVoice(handle);

  const mission = voice.download({ which: 'mission', index: 0 });
  assert.equal(done.length, 0, 'the answer is not in yet');
  assert.deepEqual(await mission, {
    ok: true,
    downloaded: true,
    which: 'mission',
    index: 0,
  });
  assert.deepEqual(done, [true]);

  assert.equal((await voice.download({ which: 'all' })).ok, true);
  assert.equal((await voice.download({ which: 'suite' })).ok, true);
  assert.equal(done.length, 3);
});

test('download never claims a file the panel did not write', async () => {
  const { handle, state } = fakeHandle({
    downloadMission: async () => false,
    downloadAll: async () => false,
    downloadSuite: async () => false,
  });
  state.result = { missions: [{}] };
  state.suite = { passes: [{ id: 'nadir', result: { missions: [{}] } }] };
  const voice = createDronePlanVoice(handle);
  for (const args of [
    { which: 'mission', index: 0 },
    { which: 'all' },
    { which: 'suite' },
  ]) {
    assert.deepEqual(await voice.download(args), {
      ok: false,
      error: 'The file could not be saved',
    });
  }
  // A panel that throws while compressing is not a saved file either.
  const broken = fakeHandle({
    downloadAll: async () => {
      throw new Error('out of memory');
    },
  });
  broken.state.result = { missions: [{}] };
  const crashed = await createDronePlanVoice(broken.handle).download({
    which: 'all',
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.error, 'Drone Flight Plan is not available right now');
});

test('download refuses a plan the panel will not export, before it tries', async () => {
  const tried = [];
  const { handle } = fakeHandle({
    downloadMission: () => {
      tried.push('mission');
      return true;
    },
    downloadAll: () => {
      tried.push('all');
      return true;
    },
    downloadSuite: () => {
      tried.push('suite');
      return true;
    },
  });
  const voice = createDronePlanVoice(handle);
  for (const args of [{ which: 'mission' }, { which: 'all' }]) {
    assert.deepEqual(await voice.download(args), {
      ok: false,
      error: 'Downloads are not available yet',
    });
  }
  // No suite was planned: the all-passes zip is refused, not attempted.
  assert.deepEqual(await voice.download({ which: 'suite' }), {
    ok: false,
    error: 'Downloads are not available yet',
  });
  assert.deepEqual(tried, []);
});

test('finish, undo and corner report the real refusal, not ok with false', async () => {
  const called = [];
  const drafts = {
    box: false,
    polygon: false,
    corners: 0,
    editAreaId: null,
    editKind: null,
    selectedCorner: null,
    canRemoveCorner: false,
  };
  const { handle } = panelHandle();
  handle.drafts = () => ({ ...drafts });
  handle.finishPolygon = () => {
    called.push('finish');
    return false;
  };
  handle.undoPolygonCorner = () => {
    called.push('undo');
    return false;
  };
  handle.removePolygonCorner = () => {
    called.push('corner');
    return false;
  };
  const voice = createDronePlanVoice(handle);

  // FINISH: no draft, then a draft too short, then a shape the panel refuses.
  assert.deepEqual(await voice.finish(), {
    ok: false,
    error: 'No polygon is being drawn',
  });
  drafts.polygon = true;
  drafts.corners = 2;
  assert.deepEqual(await voice.finish(), {
    ok: false,
    error: 'A polygon needs at least three corners',
  });
  assert.deepEqual(called, [], 'the panel button is not pressed for a refusal');
  drafts.corners = 3;
  assert.deepEqual(await voice.finish(), {
    ok: false,
    error: 'The polygon could not be added',
  });
  assert.deepEqual(called, ['finish']);

  // UNDO: nothing drawn, then nothing left to take back.
  drafts.polygon = false;
  assert.deepEqual(await voice.undo(), {
    ok: false,
    error: 'No polygon is being drawn',
  });
  drafts.polygon = true;
  drafts.corners = 0;
  assert.deepEqual(await voice.undo(), {
    ok: false,
    error: 'No corner to take back',
  });
  drafts.corners = 2;
  assert.deepEqual(await voice.undo(), {
    ok: false,
    error: 'No corner to take back',
  });
  assert.deepEqual(called, ['finish', 'undo']);

  // CORNER: no area is being edited, a rectangle, nothing selected, a
  // triangle, then a removal the panel itself refused.
  assert.deepEqual(await voice.corner(), {
    ok: false,
    error: 'Edit an area first',
  });
  drafts.editAreaId = 'area-1';
  drafts.editKind = 'rect';
  assert.deepEqual(await voice.corner(), {
    ok: false,
    error: 'Only a polygon has corners to remove',
  });
  drafts.editKind = 'polygon';
  assert.deepEqual(await voice.corner(), {
    ok: false,
    error: 'Click a corner first',
  });
  drafts.selectedCorner = 2;
  assert.deepEqual(await voice.corner(), {
    ok: false,
    error: 'A polygon needs at least three corners',
  });
  drafts.canRemoveCorner = true;
  assert.deepEqual(await voice.corner(), {
    ok: false,
    error: 'The corner could not be removed',
  });
  assert.deepEqual(called, ['finish', 'undo', 'corner']);
});

test('corner removes the selected corner of a polygon and says so', async () => {
  const { handle, state } = panelHandle({
    drafts: () => ({
      box: false,
      polygon: false,
      corners: 0,
      editAreaId: 'area-1',
      editKind: 'polygon',
      selectedCorner: 1,
      canRemoveCorner: true,
    }),
  });
  state.areas = [{ id: 'area-1', kind: 'polygon' }];
  assert.deepEqual(await createDronePlanVoice(handle).corner(), {
    ok: true,
    removed: true,
  });
});

test('edit says why the editor did not start', async () => {
  const { handle, state, calls } = panelHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  handle.editArea = () => false;
  const voice = createDronePlanVoice(handle);

  // A draw is running: the panel refuses the editor, and names that reason.
  handle.drafts = () => ({ box: true, polygon: false });
  assert.deepEqual(await voice.edit({ areaId: 'area-1' }), {
    ok: false,
    error: 'Finish drawing first',
  });
  handle.drafts = () => ({ box: false, polygon: true });
  assert.equal((await voice.edit({ areaId: 'area-1' })).error, 'Finish drawing first');
  // Nothing is drawing: another tool holds the pointer.
  handle.drafts = () => ({ box: false, polygon: false });
  assert.deepEqual(await voice.edit({ areaId: 'area-1' }), {
    ok: false,
    error: 'Another tool is using the pointer. Close it first',
  });
  // The editor starts: editing is claimed.
  handle.editArea = () => true;
  const started = await voice.edit({ areaId: 'area-1' });
  assert.equal(started.ok, true);
  assert.equal(started.editing, true);
  assert.equal(calls.some((call) => call[0] === 'editArea'), false);
});

test('suite names a suite that never arrived instead of blaming the plan', async () => {
  const { handle, state } = panelHandle();
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  state.result = {
    totals: { missionCount: 1, photoCount: 4, durationS: 10 },
    terrainComplete: true,
    warnings: [],
  };
  handle.planSuite = async () => {
    // The panel refuses while it is busy or out of date: no suite is set.
    state.suite = null;
  };
  assert.deepEqual(await createDronePlanVoice(handle).suite(), {
    ok: false,
    error: 'Could not plan all passes',
  });
  // A plan that did not build is not "plan the area first" either.
  state.result = null;
  state.error = 'too-large';
  assert.deepEqual(await createDronePlanVoice(handle).suite(), {
    ok: false,
    error: 'The plan has an error; fix it in the panel first',
  });
  state.error = null;
  assert.deepEqual(await createDronePlanVoice(handle).suite(), {
    ok: false,
    error: 'Plan the area first',
  });
});

test('target names the real refusal: no area, too many, or outside', async () => {
  const added = [];
  const { handle, state } = panelHandle();
  handle.addOrbitTarget = (point) => {
    added.push(point);
    return false;
  };
  const voice = createDronePlanVoice(handle);
  state.areas = [];
  assert.deepEqual(await voice.target({ lat: 32.7, lon: -94.9 }), {
    ok: false,
    error: 'Draw an area first',
  });
  state.areas = [{ id: 'area-1', kind: 'rect' }];
  state.options.orbitTargets = Array.from({ length: 12 }, (_, i) => ({
    id: `target-${i + 1}`,
    lat: 32.7,
    lon: -94.9,
    active: true,
  }));
  assert.deepEqual(await voice.target({ lat: 32.7, lon: -94.9 }), {
    ok: false,
    error: 'At most 12 orbit targets',
  });
  state.options.orbitTargets = [];
  assert.deepEqual(await voice.target({ lat: 32.7, lon: -94.9 }), {
    ok: false,
    error: 'That point is not inside the survey area',
  });
  assert.equal(added.length, 1, 'the panel is only asked when it can say yes');
});

test('options names the change the panel refused', async () => {
  const { handle } = panelHandle({ applyOptions: () => false });
  const voice = createDronePlanVoice(handle);
  assert.deepEqual(await voice.options({ cameraPresetId: 'mapping-50mp' }), {
    ok: false,
    error: 'That camera preset is not available in this panel',
  });
  assert.deepEqual(await voice.options({ aglM: 80 }), {
    ok: false,
    error: 'The panel did not accept those options',
  });
});

test('preview names the missing M number, not "downloads not available"', async () => {
  const { handle, state } = panelHandle();
  handle.library = () => ({ currentLabel: () => null });
  state.result = { missions: [{}], totals: { missionCount: 1 } };
  assert.deepEqual(await createDronePlanVoice(handle).preview(), {
    ok: false,
    error:
      'Save the plan in the plan library first, so each flight has its M number',
  });
  // With a labelled plan, a picture the browser could not draw says that.
  handle.downloadPreview = () => false;
  handle.library = () => ({ currentLabel: () => ({ no: 3, name: 'P' }) });
  assert.deepEqual(await createDronePlanVoice(handle).preview(), {
    ok: false,
    error: 'The picture could not be drawn in this browser',
  });
});
