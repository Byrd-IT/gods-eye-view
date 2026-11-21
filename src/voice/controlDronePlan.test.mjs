import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import {
  DRONEPLAN_VOICE_ACTIONS,
  createDronePlanVoice,
} from '../byrdit/dronePlan/dronePlanVoice.js';
import { validateArgs } from '../../scripts/voice-bench/grade.mjs';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

const VIEWER = {
  clock: { onTick: { addEventListener: () => () => {} } },
  scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  // A Cesium viewer has its own canvas; upstream reads it there (#1760).
  get canvas() {
    return this.scene.canvas;
  },
  camera: { moveEnd: { addEventListener() {} } },
};

const SECRET = 'sk-ant-secret-Bearer-not-a-drone';

function harness(dronePlan) {
  const voice =
    dronePlan === undefined
      ? {
          async open() {
            return { ok: true, open: true };
          },
          async close() {
            return { ok: true, open: false, cleared: true };
          },
          async status() {
            return { ok: true, aircraft: 'DJI Mini 5 Pro' };
          },
          async download() {
            return { ok: true, downloaded: false };
          },
        }
      : dronePlan;
  const runner = createGevActionRunner({
    viewer: VIEWER,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    dronePlan: () => voice,
  });
  return { runner, voice };
}

test('control_droneplan stays before the appended view tools without reordering imagery', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  // The navigation, solunar and map overlay voice tools this release appends
  // land after the clean-view and opacity pair, so the tail is now ten
  // tools long.
  assert.deepEqual(names.slice(-10), [
    'control_history',
    'control_sky',
    'control_imagery',
    'control_droneplan',
    'set_clean_view',
    'set_layer_opacity',
    'control_nav',
    'control_solunar',
    'control_overlays',
    'control_ghostmaps',
  ]);
  const tool = GEV_REALTIME_TOOLS.find(
    (item) => item.name === 'control_droneplan',
  );
  assert.deepEqual(tool.parameters.properties.action.enum, [
    ...DRONEPLAN_VOICE_ACTIONS,
  ]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.match(tool.description, /NOT FLIGHT-TESTED/);
  assert.match(realtimeInstructions(), /control_droneplan/);
  assert.match(realtimeInstructions(), /NOT FLIGHT-TESTED/);
});

test('control_droneplan dispatches to the panel adapter and wraps the action', async () => {
  const { runner } = harness();
  assert.equal(
    (await runner('control_droneplan', { action: 'open' })).open,
    true,
  );
  assert.equal(
    (await runner('control_droneplan', { action: 'close' })).cleared,
    true,
  );
  assert.equal(
    (await runner('control_droneplan', { action: 'status' })).aircraft,
    'DJI Mini 5 Pro',
  );
  assert.equal(
    (
      await runner('control_droneplan', {
        action: 'download',
        which: 'mission',
      })
    ).downloaded,
    false,
  );
});

test('a missing Drone Flight Plan host does not repeat the request', async () => {
  const { runner: bare } = harness(null);
  const missing = await bare('control_droneplan', {
    action: 'options',
    aircraft: SECRET,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not available in this host/);
  assert.equal(JSON.stringify(missing).includes(SECRET), false);
});

test('an unknown drone plan action never repeats the action text', async () => {
  const { runner } = harness();
  // An all-lower-case alphabetic secret used to pass the `[a-z]{1,20}` shape
  // check and be echoed back inside the refusal.
  const alphabetic = 'abcdefghijklmnop';
  for (const action of [SECRET, alphabetic, 'missing', 'options ']) {
    await assert.rejects(
      () => runner('control_droneplan', { action }),
      (err) => {
        assert.equal(err.message, 'Unknown drone plan action');
        assert.equal(err.code, 'UNKNOWN_ACTION');
        assert.equal(err.message.includes(action), false);
        assert.equal(err.message.includes(alphabetic), false);
        assert.equal(err.message.includes(SECRET), false);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------- failures --
// The host adapter is outside this action's trust boundary. Whatever it throws
// — a provider URL, an Authorization header, a token closed over by a throwing
// getter — must stop at `control_droneplan`: the voice controller copies
// `error.message` into the tool result the model reads.
const FIXED_FAILURE = 'Drone Flight Plan action failed';

/** Every string reachable from a thrown error: message, stack, props, cause. */
function leakText(error) {
  const parts = [];
  const seen = new Set();
  const walk = (value, depth) => {
    if (value == null || depth > 6) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      parts.push(key);
      try {
        walk(value[key], depth + 1);
      } catch {
        parts.push('[getter threw]');
      }
    }
  };
  walk(error, 0);
  parts.push(String(error?.stack ?? ''));
  try {
    parts.push(
      inspect(error, {
        depth: 8,
        getters: true,
        showHidden: true,
      }),
    );
  } catch {
    parts.push('[inspect threw]');
  }
  return parts.join('\n');
}

function runnerWithOptions(options) {
  return createGevActionRunner({
    viewer: VIEWER,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    ...options,
  });
}

const rejectsWithFixedFailure = async (call, expected = FIXED_FAILURE) => {
  await assert.rejects(call, (err) => {
    assert.equal(err.message, expected);
    assert.equal(err.cause, undefined);
    assert.equal(err.errors, undefined, 'no aggregate of the original errors');
    assert.equal(leakText(err).includes(SECRET), false, 'a secret survived');
    return true;
  });
};

test('a host that throws does not escape its message, cause or stack', async () => {
  const cause = new Error(`provider refused ${SECRET}`);
  cause.request = { headers: { authorization: `Bearer ${SECRET}` } };
  const thrown = new Error(`upstream said ${SECRET}`);
  thrown.cause = cause;
  thrown.providerUrl = `https://svc:${SECRET}@example.test/plan`;
  thrown.stack = `${thrown.stack}\n    at leak (${SECRET})`;
  const { runner } = harness({
    async options() {
      throw thrown;
    },
  });
  await rejectsWithFixedFailure(() =>
    runner('control_droneplan', { action: 'options' }),
  );
});

test('a throwing member getter on the host does not escape its message', async () => {
  const hostile = {};
  Object.defineProperty(hostile, 'options', {
    get() {
      throw new Error(`getter kept ${SECRET}`);
    },
  });
  const { runner } = harness(hostile);
  await rejectsWithFixedFailure(() =>
    runner('control_droneplan', { action: 'options' }),
  );
});

test('a caller action whose toString throws does not escape its message', async () => {
  const { runner } = harness();
  await rejectsWithFixedFailure(() =>
    runner('control_droneplan', {
      action: {
        toString() {
          throw new Error(`toString kept ${SECRET}`);
        },
      },
    }),
  );
});

test('a throwing action getter on the arguments does not escape its message', async () => {
  const { runner } = harness();
  const args = {
    get action() {
      throw new Error(`args getter kept ${SECRET}`);
    },
  };
  await rejectsWithFixedFailure(() => runner('control_droneplan', args));
});

test('a throwing host handle does not escape its message', async () => {
  const runner = runnerWithOptions({
    dronePlan: () => {
      throw new Error(`handle kept ${SECRET}`);
    },
  });
  await rejectsWithFixedFailure(() =>
    runner('control_droneplan', { action: 'status' }),
  );
});

test('a host error faking the unknown-action tag still cannot smuggle text', async () => {
  const forged = [
    `Unknown drone plan action: ${SECRET}`,
    'Unknown drone plan action: abcdefghijklmnop',
    'Unknown drone plan action',
  ];
  for (const message of forged) {
    const thrown = new Error(message);
    thrown.code = 'UNKNOWN_ACTION';
    const { runner } = harness({
      async status() {
        throw thrown;
      },
    });
    await rejectsWithFixedFailure(() =>
      runner('control_droneplan', { action: 'status' }),
    );
  }
});

test('a thrown object whose code or name getter throws stays a fixed failure', async () => {
  // Inspecting the thrown object for cancellation markers used to run those
  // getters, so a hostile object could replace the fixed text with its own.
  for (const key of ['name', 'code', 'cancelled', 'message']) {
    const hostile = {};
    Object.defineProperty(hostile, key, {
      get() {
        throw new Error(`getter ${key} kept ${SECRET}`);
      },
    });
    const { runner } = harness({
      async options() {
        throw hostile;
      },
    });
    await rejectsWithFixedFailure(() =>
      runner('control_droneplan', { action: 'options' }),
    );
  }
});

test('a getter that throws an AbortError shape still cannot fake a cancellation', async () => {
  const hostile = {};
  Object.defineProperty(hostile, 'name', {
    get() {
      throw new Error('not a cancellation');
    },
  });
  Object.defineProperty(hostile, 'cancelled', {
    get() {
      throw new Error('nor this one');
    },
  });
  const { runner } = harness({
    async options() {
      throw hostile;
    },
  });
  await assert.rejects(
    () => runner('control_droneplan', { action: 'options' }),
    (err) => {
      assert.equal(err.name, 'Error');
      assert.equal(err.message, FIXED_FAILURE);
      assert.equal(leakText(err).includes('not a cancellation'), false);
      return true;
    },
  );
});

test('a cancellation stays a cancellation and loses only its text', async () => {
  const aborted = new Error(`cancelled with ${SECRET}`);
  aborted.name = 'AbortError';
  const { runner } = harness({
    async status() {
      throw aborted;
    },
  });
  await assert.rejects(
    () => runner('control_droneplan', { action: 'status' }),
    (err) => {
      assert.equal(err.name, 'AbortError');
      assert.equal(err.code, 'ABORT_ERR');
      assert.equal(err.message, 'Drone Flight Plan action cancelled');
      assert.equal(leakText(err).includes(SECRET), false, 'a secret survived');
      return true;
    },
  );
});

test('a failed drone plan action still releases its serialized sibling', async () => {
  const order = [];
  const voice = {
    async status() {
      order.push('status');
      throw new Error(`panel kept ${SECRET}`);
    },
    async options() {
      order.push('options');
      return { ok: true, aglM: 60 };
    },
  };
  const { runner } = harness(voice);
  const group = { authorityGroup: 'reply-1' };
  const first = runner('control_droneplan', { action: 'status' }, group).then(
    () => 'ok',
    (err) => {
      assert.equal(leakText(err).includes(SECRET), false, 'a secret survived');
      return err.message;
    },
  );
  const second = runner('control_droneplan', { action: 'options' }, group);
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
  assert.equal(firstOutcome, FIXED_FAILURE);
  assert.equal(secondOutcome.ok, true);
  assert.deepEqual(order, ['status', 'options']);
});

test('control_droneplan option bounds are the panel sliders, not guesswork', async () => {
  const panel = readFileSync(
    new URL('../byrdit/dronePlan/panel.js', import.meta.url),
    'utf8',
  );
  // The four sliders the voice options mirror, as panel.js builds them.
  assert.match(panel, /slider\(t\('Front overlap'\), 50, 98, 0\.5\)/);
  assert.match(panel, /slider\(t\('Side overlap'\), 40, 95, 1\)/);
  assert.match(panel, /slider\(t\('Camera tilt'\), -80, -45, 5\)/);
  assert.match(panel, /minM: 10,\s*maxM: 300,/);

  const props = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_droneplan',
  ).parameters.properties;
  assert.equal(props.frontOverlap.minimum, 50);
  assert.equal(props.frontOverlap.maximum, 98);
  assert.equal(props.sideOverlap.minimum, 40);
  assert.equal(props.sideOverlap.maximum, 95);
  assert.equal(props.tiltPitchDeg.minimum, -80);
  assert.equal(props.tiltPitchDeg.maximum, -45);
  assert.equal(props.orbitRadiusM.minimum, 10);
  assert.equal(props.orbitRadiusM.maximum, 300);

  // The voice validation uses the same ends: 98% is a panel value, 98.1 is not.
  const state = {
    open: true,
    areas: [],
    options: { presetId: 'dji-mini-5-pro', frontOverlap: 80 },
  };
  const calls = [];
  const voice = createDronePlanVoice({
    isOpen: () => true,
    getState: () => state,
    open() {},
    applyOptions(patch) {
      calls.push(patch);
      Object.assign(state.options, patch);
      return true;
    },
    replan: async () => {},
  });
  assert.equal((await voice.options({ frontOverlap: 98 })).ok, true);
  assert.equal(calls.at(-1).frontOverlap, 98);
  assert.equal((await voice.options({ frontOverlap: 98.1 })).ok, false);
});

test('the drone plan schema states no bound the panel does not have', () => {
  const params = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'control_droneplan',
  ).parameters;
  const { ring, index } = params.properties;
  // One ring argument serves polygon and path. A path is two or more points
  // (panel.js addLookAtPath), a polygon three or more (polygon.js, enforced
  // by the adapter); the panel's drawing tool has no upper corner count.
  assert.equal(ring.minItems, 2);
  assert.equal(ring.maxItems, undefined);
  const twoPoints = [
    { lon: -94.9, lat: 32.7 },
    { lon: -94.91, lat: 32.71 },
  ];
  assert.deepEqual(
    validateArgs(params, { action: 'path', ring: twoPoints }),
    [],
    'a two-point path is a real panel action',
  );
  assert.ok(
    validateArgs(params, { action: 'path', ring: twoPoints.slice(0, 1) }).length >
      0,
    'one point is not a path',
  );
  const many = Array.from({ length: 120 }, (_, i) => ({
    lon: -94.9 + i * 0.00001,
    lat: 32.7,
  }));
  assert.deepEqual(validateArgs(params, { action: 'polygon', ring: many }), []);
  // A list index is bounded by that list, which the panel reports at call
  // time: a plan with more than sixty missions or photos makes index 60 real.
  assert.equal(index.minimum, 0);
  assert.equal(index.maximum, undefined);
  assert.deepEqual(validateArgs(params, { action: 'preview', index: 60 }), []);
  assert.deepEqual(validateArgs(params, { action: 'check', index: 60 }), []);
  assert.ok(
    validateArgs(params, { action: 'preview', index: -1 }).length > 0,
    'a negative position is not a list index',
  );
});
