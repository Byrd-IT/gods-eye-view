import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE,
  MODES,
  modeFor,
  modeOptions,
  modeSelectionPatch,
  recommend,
  recommendedOptions,
} from './recommend.js';
import { getPreset } from './presets.js';
import { timedIntervalOptions } from './cameraLimits.js';

const mini = getPreset('dji-mini-5-pro');

test('the mode list: Waypoints, Timed, Splat orbit, Fast survey; the default is Waypoints', () => {
  assert.deepEqual([...MODES], [
    'mapping-grid',
    'mapping-grid-timed',
    'splat-orbit',
    'fast-survey',
  ]);
  assert.equal(DEFAULT_MODE, 'mapping-grid');
});

test('modeFor: orbit and interval photos win, then Timed capture, else Waypoints', () => {
  assert.equal(modeFor({ pattern: 'orbit', captureMode: 'timed' }), 'splat-orbit');
  assert.equal(modeFor({ photoMode: 'interval', captureMode: 'timed' }), 'fast-survey');
  assert.equal(modeFor({ pattern: 'grid', captureMode: 'timed' }), 'mapping-grid-timed');
  assert.equal(modeFor({ pattern: 'double', captureMode: 'timed' }), 'mapping-grid-timed');
  assert.equal(modeFor({ pattern: 'grid', captureMode: 'stop' }), 'mapping-grid');
  assert.equal(modeFor({ pattern: 'grid', captureMode: 'distance' }), 'mapping-grid');
  assert.equal(modeFor({}), 'mapping-grid');
});

test('modeOptions names the capture mode only for Timed', () => {
  assert.deepEqual(modeOptions('mapping-grid-timed'), {
    pattern: 'grid',
    photoMode: 'waypoint',
    captureMode: 'timed',
  });
  assert.equal('captureMode' in modeOptions('mapping-grid'), false);
  assert.equal('captureMode' in modeOptions('splat-orbit'), false);
  assert.equal('captureMode' in modeOptions('fast-survey'), false);
});

test('picking a mode patches only what selects it', () => {
  assert.deepEqual(modeSelectionPatch({ pattern: 'grid', captureMode: 'stop' }, 'mapping-grid'), {});
  const toTimed = modeSelectionPatch({ pattern: 'double', captureMode: 'stop', photoMode: 'waypoint' }, 'mapping-grid-timed');
  assert.deepEqual(toTimed, { pattern: 'double', photoMode: 'waypoint', captureMode: 'timed' });
  const back = modeSelectionPatch({ pattern: 'grid', captureMode: 'timed', photoMode: 'waypoint' }, 'mapping-grid');
  assert.deepEqual(back, { pattern: 'grid', photoMode: 'waypoint', captureMode: 'stop' });
  const fromOrbit = modeSelectionPatch({ pattern: 'orbit', photoMode: 'waypoint', captureMode: 'stop' }, 'mapping-grid-timed');
  assert.equal(fromOrbit.pattern, 'grid');
  assert.equal(fromOrbit.captureMode, 'timed');
  assert.deepEqual(modeSelectionPatch({}, 'nonsense'), {});
});

test('Timed recommends the Waypoints numbers plus an interval from the camera list', () => {
  const grid = recommend(mini, 'mapping-grid', {});
  const timed = recommend(mini, 'mapping-grid-timed', { cameraPresetId: 'mapping-50mp' });
  for (const k of ['aglM', 'frontOverlap', 'sideOverlap']) {
    assert.equal(timed[k], grid[k], k);
  }
  assert.ok(timedIntervalOptions(mini, 'mapping-50mp').includes(timed.timedIntervalS));
  assert.equal(grid.timedIntervalS ?? null, null);
  const opts = recommendedOptions(timed);
  assert.equal(opts.timedIntervalS, timed.timedIntervalS);
  const t12 = recommend(mini, 'mapping-grid-timed', { cameraPresetId: 'test-12mp' });
  assert.ok(timedIntervalOptions(mini, 'test-12mp').includes(t12.timedIntervalS));
});

test('Splat orbit and Fast survey recommendations are unchanged by the photo size', () => {
  for (const mode of ['splat-orbit', 'fast-survey']) {
    const a = recommend(mini, mode, { cameraPresetId: 'mapping-50mp' });
    assert.deepEqual(a.photoMode, recommend(mini, mode, {}).photoMode);
  }
});
