import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { createHistoryVoice } from '../byrdit/historyUi/historyVoice.js';
import { mountHistoryControl } from '../byrdit/historyUi/historyControl.js';
import {
  fakeClock,
  fakeDocument,
  fakeWindow,
} from '../byrdit/historyUi/fakeDom.mjs';
import { createLayerClocks } from '../byrdit/historyUi/layerClocks.js';
import { createSkyVoice } from '../byrdit/skyView/skyVoice.js';
import { createSkyClock } from '../byrdit/skyView/skyClock.js';
import { createRecentImageryLayer } from '../layers/recentImagery/index.js';
import { readHostViewState } from '../agent/worldPacket.js';
import { ALL_HISTORY_ADAPTERS } from '../byrdit/historyUi/historyEventAdapters.js';

const NOW = Date.parse('2026-10-14T16:00:00Z');
globalThis.window ??= { clearTimeout, setTimeout };

test('imagery mode uses the owner MODES mapping', () => {
  const source = readFileSync(
    new URL('./gevActions.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    /import\s*\{\s*MODES\s+as\s+RECENT_IMAGERY_MODES\s*\}\s*from\s*['"]\.\.\/layers\/recentImagery\/index\.js['"]/.test(
      source,
    ),
  );
  assert.ok(/RECENT_IMAGERY_MODES\[args\.mode\]/.test(source));
});

test('readback admits real feed ids and discards untrusted free text', async () => {
  const secret = 'SYNTHETIC_TOKEN_54e3e7';
  const feeds = ALL_HISTORY_ADAPTERS.map((entry) => entry.layerId);
  const state = await readHostViewState({
    history: {
      status: () => ({
        ok: true,
        playingFeeds: [...feeds, secret],
        time: secret,
      }),
    },
    sky: {
      status: () => ({
        ok: true,
        lookingAt: secret,
        time: secret,
        timeMode: secret,
      }),
    },
    dronePlan: {
      status: () => ({
        ok: true,
        presetId: secret,
        aircraft: secret,
        mode: secret,
        pattern: secret,
      }),
    },
  });
  assert.deepEqual(state.historyPlayback.playingFeeds, feeds);
  assert.equal(JSON.stringify(state).includes(secret), false);
});

test('executors reach real History, Sky clock and Recent Imagery owners', async () => {
  const timer = fakeClock(NOW);
  const control = mountHistoryControl({
    document: fakeDocument(),
    window: fakeWindow('https://example.invalid/', async () => {
      throw new Error('offline');
    }),
    now: timer.now,
    monotonic: timer.monotonic,
    timers: timer.timers,
  });
  const clocks = createLayerClocks({
    rows: [{ id: 'flights', label: 'Flights', adapterIds: ['flights'] }],
    now: timer.now,
  });
  const history = createHistoryVoice({
    getHandle: () => control,
    getClocks: () => clocks,
    now: timer.now,
  });
  const clock = createSkyClock({ now: () => NOW });
  const skyHandle = {
    active: true,
    clock,
    time: { provider: 'builtin', getTime: clock.getTime },
  };
  const sky = createSkyVoice({ getHandle: () => skyHandle });
  const recent = createRecentImageryLayer({
    renderer: { setAlpha() {} },
    thumbnails: {
      get() {
        return null;
      },
    },
  });
  const dataManager = {
    layers: new Map([['recent-imagery', { module: recent }]]),
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    get canvas() {
      return this.scene.canvas;
    },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const run = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager,
    history: () => history,
    sky: () => sky,
  });
  assert.equal(
    (await run('control_history', { action: 'preset', preset: '90d' })).ok,
    true,
  );
  assert.equal(control.getState().preset, '90d');
  assert.equal(
    (
      await run('control_history', {
        action: 'lock',
        historyRow: 'flights',
        locked: false,
      })
    ).ok,
    true,
  );
  assert.equal(clocks.isLocked('flights'), false);
  assert.equal(
    (await run('control_sky', { action: 'speed', rate: 3600 })).ok,
    true,
  );
  assert.equal(clock.rate, 3600);
  assert.equal(
    (await run('control_imagery', { action: 'mode', mode: 2 })).ok,
    true,
  );
  assert.equal(recent.getSnapshot().mode, 'ab');
  assert.equal(
    (await run('control_imagery', { action: 'opacity', opacityPct: 65 })).ok,
    true,
  );
  assert.equal(recent.getSnapshot().alpha, 0.65);
  control.destroy();
});
