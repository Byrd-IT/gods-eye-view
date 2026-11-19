import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { createGevActionRunner, controlCctv } from './gevActions.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';
import { CCTV_FOCUS_RESULT } from '../layers/cctv/policy.js';
import { createSkyVoice } from '../byrdit/skyView/skyVoice.js';
import { readHostViewState } from '../agent/worldPacket.js';

test('Sky controls never return untrusted clock or observer fields', async () => {
  const secret = `SYNTHETIC_${crypto.randomUUID()}`;
  const sky = {
    active: true,
    observer: { latDeg: secret, lonDeg: secret },
    content: { flags: {} },
    clock: { mode: secret, rate: 1, playing: false, play: () => true },
    time: { provider: 'builtin', getTime: () => Date.now() },
  };
  const voice = createSkyVoice({ getHandle: () => sky });
  const { runner } = harness({ adapters: { sky: () => voice } });
  const result = await runner('control_sky', { action: 'play' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Sky playback never returns untrusted marker text', async () => {
  const secret = 'SYNTHETIC_SKY_MARKER_SECRET_8731';
  const sky = {
    active: true,
    content: { marker: { label: secret }, flags: {} },
    clock: { rate: 1, playing: false, play: () => true },
    time: { provider: 'builtin', getTime: () => Date.now() },
  };
  const voice = createSkyVoice({ getHandle: () => sky });
  const { runner } = harness({ adapters: { sky: () => voice } });
  const result = await runner('control_sky', { action: 'play' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Sky playback never returns an untrusted opening error', async () => {
  const secret = 'SYNTHETIC_SKY_OPEN_SECRET_7312';
  const sky = {
    active: false,
    openHere: async () => ({ ok: false, error: secret }),
  };
  const voice = createSkyVoice({ getHandle: () => sky });
  const { runner } = harness({ adapters: { sky: () => voice } });
  const result = await runner('control_sky', { action: 'play' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('imagery readback retains every available year', async () => {
  const years = Array.from({ length: 40 }, (_, i) => 1980 + i);
  const state = await readHostViewState({
    imagery: { status: () => ({ years }) },
  });
  assert.deepEqual(state.imagery.years, years);
});

test('CCTV never echoes an untrusted feed type', async () => {
  const secret = 'SYNTHETIC_FEEDTYPE_SECRET_49d8a1';
  const module = {
    getUIState: () => ({
      activeCamera: { id: 'cam', feedType: secret, noFeed: false },
      count: 1,
    }),
    cycleCamera: () => true,
    focusCamera: () => true,
  };
  const manager = {
    layers: new Map([['cctv', { module }]]),
    isEnabled: () => true,
  };
  const result = await controlCctv(manager, { action: 'next' });
  assert.equal(result.feedType, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

// The adapters below answer exactly as the live ones do: Sky and History
// answer synchronously, the imagery and the Drone Flight Plan answer with a
// promise. The read-back has to honour both.
const SKY_ADAPTER = {
  status: () => ({
    ok: true,
    open: true,
    time: '2026-10-26T04:00:00.000Z',
    timeMode: 'live',
    lines: true,
    lookingAt: 'Jupiter',
  }),
};

const HISTORY_ADAPTER = {
  status: () => ({
    ok: true,
    mode: 'history',
    time: '2026-10-17T12:00:00.000Z',
    playing: true,
    rate: 60,
    unavailable: false,
    playingFeeds: ['flights'],
  }),
};

const DRONE_PLAN_ADAPTER = {
  status: async () => ({
    ok: true,
    open: true,
    aircraft: 'DJI Mini 5 Pro',
    presetId: 'dji-mini-5-pro',
    mode: 'mapping-grid',
    pattern: 'grid',
    aglM: 120,
    speedMs: 8,
    areaCount: 2,
    busy: false,
    plan: { missionCount: 3, photoCount: 120, durationS: 900 },
  }),
};

const IMAGERY_ADAPTER = {
  status: async () => ({
    ok: true,
    year: 2018,
    enabled: true,
    years: [2015, 2018, 2024],
  }),
};

// The map stack controller answers with its own state; `autoMode` is the
// automatic basemap switch's mode ('auto', 'google', 'open' or 'other').
const MAP_STACK_CONTROLLER = {
  getState: () => ({
    activeId: 'byrdit-open',
    autoMode: 'auto',
    stacks: [{ id: 'photoreal' }, { id: 'byrdit-open' }],
  }),
};

const OPACITY_MODEL = {
  entries: () => [['flights', 0.4]],
  get: (id) => (id === 'flights' ? 0.4 : 1),
};

function harness({
  adapters = {},
  layerOpacity = null,
  dataManager: extra = {},
} = {}) {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 500);
  const viewer = {
    trackedEntity: undefined,
    clock: { onTick: { addEventListener: () => () => {} } },
    get canvas() {
      return this.scene.canvas;
    },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { getHeight: () => 0 },
      tweens: [],
    },
    camera: {
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: 0,
      pitch: Cesium.Math.toRadians(-45),
      moveEnd: { addEventListener: () => () => {} },
      cancelFlight() {},
      lookAtTransform() {},
    },
  };
  const rows = [
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      stats: { count: 3, source: 'fixture', lastUpdate: null },
    },
  ];
  const dataManager = {
    layers: new Map([['traffic', { module: null }]]),
    getAll: () => rows,
    ...extra,
  };
  const styleManager = {
    activeStyle: 'normal',
    getContextModeState: () => ({ mode: 'flights' }),
    getCockpitState: () => null,
    getControlState: () => ({ hud: { visible: 'auto' } }),
  };
  // The packet reads the eye from the camera port of the renderer bound to
  // the scene object.
  const renderer = createStubRenderer();
  renderer.camera.setView({
    destination: { lon: -97.74, lat: 30.26, height: 500 },
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
  });
  bindRenderer(viewer, renderer);
  const runner = createGevActionRunner({
    viewer,
    dataManager,
    styleManager,
    layerOpacity,
    ...adapters,
  });
  return { runner, viewer, dataManager, styleManager };
}

test('the view state carries the sky, history and drone plan state the live handles report', async () => {
  const { runner } = harness({
    adapters: {
      sky: () => SKY_ADAPTER,
      history: () => HISTORY_ADAPTER,
      dronePlan: () => DRONE_PLAN_ADAPTER,
    },
  });
  const packet = await runner('get_current_view_state');

  assert.deepEqual(packet.sky, {
    open: true,
    lines: true,
    timeMode: 'live',
    time: '2026-10-26T04:00:00.000Z',
  });
  assert.deepEqual(packet.historyPlayback, {
    playing: true,
    mode: 'history',
    rate: 60,
    time: '2026-10-17T12:00:00.000Z',
    playingFeeds: ['flights'],
  });
  assert.deepEqual(packet.dronePlan, {
    open: true,
    busy: false,
    areaCount: 2,
    aircraft: 'DJI Mini 5 Pro',
    presetId: 'dji-mini-5-pro',
    mode: 'mapping-grid',
    pattern: 'grid',
    aglM: 120,
    speedMs: 8,
    plan: { missionCount: 3, photoCount: 120, durationS: 900 },
  });
});

test('an absent, destroyed or failing handle contributes nothing and leaks no error text', async () => {
  const failing = {
    status: () => {
      throw new Error('secret-adapter-token');
    },
  };
  const destroyed = {
    status: () => ({ ok: false, error: 'Sky view is not available right now' }),
  };
  const { runner } = harness({
    adapters: {
      sky: () => failing,
      history: () => destroyed,
      dronePlan: () => null,
      imagery: () => {
        throw new Error('secret-provider-token');
      },
    },
  });
  const packet = await runner('get_current_view_state');

  assert.equal('sky' in packet, false);
  assert.equal('historyPlayback' in packet, false);
  assert.equal('dronePlan' in packet, false);
  const json = JSON.stringify(packet);
  assert.equal(json.includes('secret-adapter-token'), false);
  assert.equal(json.includes('secret-provider-token'), false);
  assert.equal(json.includes('not available right now'), false);
});

test('the read-back only asks the handles for their status', async () => {
  const calls = [];
  const { runner } = harness({
    adapters: {
      sky: () => ({
        status: () => {
          calls.push('status');
          return { ok: true, open: true };
        },
        open: () => {
          calls.push('open');
          return { ok: true };
        },
        close: () => {
          calls.push('close');
          return { ok: true };
        },
      }),
    },
  });
  await runner('get_current_view_state');
  assert.deepEqual(calls, ['status']);
});

test('the control state reports the map stack mode, the imagery year and the per-layer opacity', async () => {
  const { runner } = harness({
    adapters: {
      imagery: () => IMAGERY_ADAPTER,
      mapStack: () => MAP_STACK_CONTROLLER,
    },
    layerOpacity: OPACITY_MODEL,
  });
  const packet = await runner('get_current_view_state');

  assert.equal(packet.controls.mapStackAuto, true);
  assert.equal(packet.controls.imageryYear, 2018);
  assert.deepEqual(packet.controls.imageryYears, [2015, 2018, 2024]);
  assert.deepEqual(packet.controls.layerOpacity, { flights: 40 });
  // The packet's own layer opacity keeps its place.
  assert.deepEqual(packet.layerOpacity, { flights: 40 });
});

test('a pinned map stack is not automatic', async () => {
  const { runner } = harness({
    adapters: {
      mapStack: () => ({
        getState: () => ({ activeId: 'photoreal', autoMode: 'google' }),
      }),
    },
  });
  const packet = await runner('get_current_view_state');
  assert.equal(packet.controls.mapStackAuto, false);
});

test('a host whose owners cannot say reports no map stack mode, imagery year or opacity', async () => {
  const { runner } = harness({
    adapters: {
      imagery: () => null,
      // A controller without the automatic switch says nothing about it.
      mapStack: () => ({ getState: () => ({ activeId: 'osm' }) }),
    },
  });
  const packet = await runner('get_current_view_state');
  assert.equal('mapStackAuto' in packet.controls, false);
  assert.equal('imageryYear' in packet.controls, false);
  assert.equal('imageryYears' in packet.controls, false);
  assert.equal('layerOpacity' in packet.controls, false);
});

test('control_cctv reports the camera feed type and whether it has a public feed', async () => {
  const module = {
    getUIState: () => ({
      activeCameraId: 'harbour-1',
      activeCamera: {
        id: 'harbour-1',
        name: 'Harbour Cam',
        feedType: 'none',
        noFeed: true,
      },
      count: 1,
      showCoverage: false,
      coverageMode: 'off',
    }),
    focusCamera: () => CCTV_FOCUS_RESULT.FOCUSED,
  };
  const { runner } = harness({
    dataManager: {
      layers: new Map([['cctv', { module }]]),
      getAll: () => [],
      isEnabled: (id) => id === 'cctv',
    },
  });
  const result = await runner('control_cctv', { action: 'focus' });
  assert.equal(result.feedType, 'none');
  assert.equal(result.noFeed, true);
  assert.equal(result.activeCamera, 'Harbour Cam');
});

test('control_cctv reports a camera that carries a feed, and never claims it is live', async () => {
  const module = {
    getUIState: () => ({
      activeCameraId: 'pier-2',
      activeCamera: {
        id: 'pier-2',
        name: 'Pier Cam',
        feedType: 'mjpeg',
        noFeed: false,
      },
      count: 1,
      showCoverage: true,
      coverageMode: 'on',
    }),
    focusCamera: () => CCTV_FOCUS_RESULT.FOCUSED,
  };
  const { runner } = harness({
    dataManager: {
      layers: new Map([['cctv', { module }]]),
      getAll: () => [],
      isEnabled: (id) => id === 'cctv',
    },
  });
  const result = await runner('control_cctv', { action: 'focus' });
  assert.equal(result.feedType, 'mjpeg');
  assert.equal(result.noFeed, false);
  assert.equal('live' in result, false);
});

test('control_cctv without an active camera claims no feed type', async () => {
  const module = {
    getUIState: () => ({
      activeCameraId: null,
      activeCamera: null,
      count: 0,
    }),
    focusCamera: () => CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA,
  };
  const { runner } = harness({
    dataManager: {
      layers: new Map([['cctv', { module }]]),
      getAll: () => [],
      isEnabled: (id) => id === 'cctv',
    },
  });
  const result = await runner('control_cctv', { action: 'focus' });
  assert.equal(result.feedType, null);
  assert.equal(result.noFeed, null);
});

test('the stories-open refusal still comes before the view state is read', async () => {
  const previous = globalThis.document;
  globalThis.document = {
    body: { classList: { contains: (name) => name === 'stories-mode' } },
  };
  try {
    let asked = 0;
    const { runner } = harness({
      adapters: {
        sky: () => {
          asked += 1;
          return SKY_ADAPTER;
        },
      },
    });
    const result = await runner('get_current_view_state');
    assert.equal(result.ok, false);
    assert.equal(result.refused, 'stories-open');
    assert.equal(asked, 0, 'the handles are not read while Stories is open');
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
