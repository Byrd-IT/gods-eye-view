import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOverlaysVoice,
  overlaysVoiceFor,
  OVERLAY_VOICE_ACTIONS,
} from './overlaysVoice.js';

/**
 * A stand-in for the overlay controller (src/byrdit/basemap/overlays.js) with
 * the same semantics: the stack runs bottom to top, a 3D build is a model
 * rather than an imagery layer, and every method refuses (returns false) for
 * an id it does not know or a move that has nowhere to go.
 */
function fakeController(entries) {
  const order = entries.map((entry) => entry.id);
  const byId = new Map(
    entries.map((entry) => [
      entry.id,
      { ...entry, enabled: false, opacity: 1 },
    ]),
  );
  const active = new Set();
  const controller = {
    phoneMode: false,
    setEnabled(id, on) {
      const entry = byId.get(id);
      if (!entry) return false;
      entry.enabled = Boolean(on);
      if (entry.enabled) active.add(id);
      else active.delete(id);
      return true;
    },
    setOpacity(id, value) {
      const entry = byId.get(id);
      const numeric = Number(value);
      if (!entry || !Number.isFinite(numeric)) return false;
      entry.opacity = Math.min(1, Math.max(0, numeric));
      return true;
    },
    moveLayer(id, direction) {
      const i = order.indexOf(id);
      if (i < 0 || byId.get(id)?.kind === '3d') return false;
      const step = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
      let j = i + step;
      while (step && byId.get(order[j])?.kind === '3d') j += step;
      if (!step || j < 0 || j >= order.length) return false;
      [order[i], order[j]] = [order[j], order[i]];
      return true;
    },
    setPhoneMode(on) {
      if (!order.some((id) => byId.get(id)?.kind === '3d')) return false;
      controller.phoneMode = Boolean(on);
      return true;
    },
    state() {
      return {
        // The panel lists the top of the stack first.
        layers: [...order].reverse().map((id) => {
          const entry = byId.get(id);
          return {
            id: entry.id,
            name: entry.name,
            kind: entry.kind,
            enabled: entry.enabled,
            opacity: entry.opacity,
            minzoom: 11,
            ...(entry.kind === '3d' ? { phoneMode: controller.phoneMode } : {}),
          };
        }),
        active: [...active],
        stack: [...order],
        credits: [],
        created: 0,
        destroyed: 0,
      };
    },
  };
  return controller;
}

const FLAT = [
  { id: 'ustopo', name: 'US Topo 7.5-minute (2022)', kind: 'raster' },
  { id: 'hillshade', name: 'Hillshade 1 m lidar', kind: 'raster' },
  { id: 'contours', name: 'Contours 5 ft / 25 ft major', kind: 'vector' },
];

const WITH_MODEL = [
  ...FLAT,
  { id: 'odm-barn', name: 'Byrd Ranch barn', kind: '3d' },
];

test('the adapter exposes exactly the actions the voice tool declares', () => {
  const voice = createOverlaysVoice(fakeController(FLAT));
  assert.deepEqual(
    Object.keys(voice).sort(),
    [...OVERLAY_VOICE_ACTIONS].sort(),
  );
  for (const action of OVERLAY_VOICE_ACTIONS)
    assert.equal(typeof voice[action], 'function', action);
});

test('the adapter is created once per controller', () => {
  const controller = fakeController(FLAT);
  assert.equal(overlaysVoiceFor(controller), overlaysVoiceFor(controller));
  const callable = Object.assign(() => {}, fakeController(FLAT));
  assert.ok(overlaysVoiceFor(callable));
  assert.equal(overlaysVoiceFor(null), null);
  assert.equal(overlaysVoiceFor(undefined), null);
});

test('enabling an overlay changes the controller and is read back', () => {
  const controller = fakeController(FLAT);
  const voice = createOverlaysVoice(controller);
  const on = voice.enable({ overlayId: 'hillshade', enabled: true });
  assert.equal(on.ok, true);
  assert.equal(on.overlayId, 'hillshade');
  assert.equal(on.enabled, true);
  assert.equal(on.drawn, true);
  assert.equal(
    controller.state().layers.find((l) => l.id === 'hillshade').enabled,
    true,
  );
  const off = voice.enable({ overlayId: 'hillshade', enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(
    controller.state().layers.find((l) => l.id === 'hillshade').enabled,
    false,
  );
});

test('partial overlay names require exact confirmation, even for one match', () => {
  const controller = fakeController(FLAT);
  const result = createOverlaysVoice(controller).enable({
    overlayId: 'hill',
    enabled: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.overlays[0].id, 'hillshade');
  assert.equal(
    controller.state().layers.find((row) => row.id === 'hillshade').enabled,
    false,
  );
});

test('a registered 3D model is not claimed visible while loading or failed', () => {
  const controller = fakeController(WITH_MODEL);
  const state = controller.state;
  controller.state = () => {
    const value = state();
    value.layers.find((row) => row.id === 'odm-barn').status = 'failed';
    return value;
  };
  const result = createOverlaysVoice(controller).enable({
    overlayId: 'odm-barn',
    enabled: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.drawn, null);
  assert.equal(result.modelStatus, 'failed');
  assert.match(result.say, /unconfirmed/);
});

test('an overlay is named by its name as well as its id', () => {
  const voice = createOverlaysVoice(fakeController(FLAT));
  const byName = voice.enable({
    overlayId: 'Hillshade 1 m lidar',
    enabled: true,
  });
  assert.equal(byName.ok, true);
  assert.equal(byName.overlayId, 'hillshade');
});

test('an overlay that is on but not drawn says so', () => {
  const controller = fakeController(FLAT);
  // The overlay is on, but the map beneath it is another basemap, so the
  // layer is not created.
  controller.setEnabled('contours', true);
  const report = controller.state.bind(controller);
  controller.state = () => ({ ...report(), active: [] });
  const voice = createOverlaysVoice(controller);
  const result = voice.enable({ overlayId: 'contours', enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.drawn, false);
  assert.match(result.say, /not drawn/);
});

test('an unknown overlay is refused with the catalogue and without the request', () => {
  const voice = createOverlaysVoice(fakeController(FLAT));
  const result = voice.enable({ overlayId: 'no-such-layer', enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /no map overlay/i);
  assert.equal(JSON.stringify(result.error).includes('no-such-layer'), false);
  assert.deepEqual(
    result.overlays.map((row) => row.id),
    // The panel lists the top of the stack first.
    ['contours', 'hillshade', 'ustopo'],
  );
});

test('a missing overlay name is refused', () => {
  const voice = createOverlaysVoice(fakeController(FLAT));
  const result = voice.enable({ enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /which map overlay/i);
  assert.ok(result.overlays.length);
});

test('enable without a boolean is refused rather than read as off', () => {
  const controller = fakeController(FLAT);
  const voice = createOverlaysVoice(controller);
  const result = voice.enable({ overlayId: 'hillshade' });
  assert.equal(result.ok, false);
  assert.match(result.error, /enabled true or false/i);
  assert.equal(
    controller.state().layers.find((l) => l.id === 'hillshade').enabled,
    false,
  );
});

test('a controller that refuses the change is reported as a failure', () => {
  const controller = fakeController(FLAT);
  controller.setEnabled = () => false;
  const voice = createOverlaysVoice(controller);
  const result = voice.enable({ overlayId: 'hillshade', enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be turned on/i);
});

test('a controller that returns success without changing state is refused', () => {
  const controller = fakeController(WITH_MODEL);
  controller.setEnabled = () => true;
  controller.setOpacity = () => true;
  controller.moveLayer = () => true;
  controller.setPhoneMode = () => true;
  const voice = createOverlaysVoice(controller);
  assert.equal(
    voice.enable({ overlayId: 'hillshade', enabled: true }).ok,
    false,
  );
  assert.equal(
    voice.opacity({ overlayId: 'hillshade', opacityPct: 25 }).ok,
    false,
  );
  assert.equal(voice.raise({ overlayId: 'hillshade' }).ok, false);
  assert.equal(voice.phone_mode({ enabled: true }).ok, false);
});

test('opacity is set as a percentage and read back', () => {
  const controller = fakeController(FLAT);
  const voice = createOverlaysVoice(controller);
  const known = voice.opacity({ overlayId: 'hillshade', opacityPct: 40 });
  assert.equal(known.ok, true);
  assert.equal(known.opacityPct, 40);
  assert.equal(
    controller.state().layers.find((l) => l.id === 'hillshade').opacity,
    0.4,
  );
});

test('an unknown overlay is refused rather than faded', () => {
  const controller = fakeController(FLAT);
  const voice = createOverlaysVoice(controller);
  const result = voice.opacity({ overlayId: 'relief', opacityPct: 40 });
  assert.equal(result.ok, false);
  assert.match(result.error, /no map overlay/i);
  assert.equal(
    controller.state().layers.find((l) => l.id === 'hillshade').opacity,
    1,
  );
});

test('an opacity outside 0 to 100 is refused without repeating the value', () => {
  const voice = createOverlaysVoice(fakeController(FLAT));
  for (const opacityPct of [-1, 101, 12.5]) {
    const result = voice.opacity({ overlayId: 'hillshade', opacityPct });
    assert.equal(result.ok, false, `opacityPct ${opacityPct}`);
    assert.match(result.error, /0 to 100/i);
    assert.equal(result.error.includes(String(opacityPct)), false);
  }
});

test('raising and lowering move the overlay in the stack', () => {
  const controller = fakeController(FLAT);
  const voice = createOverlaysVoice(controller);
  // The stack runs bottom to top: ustopo, hillshade, contours.
  const raised = voice.raise({ overlayId: 'hillshade' });
  assert.equal(raised.ok, true);
  assert.deepEqual(raised.position, {
    index: 3,
    of: 3,
    scope: 'imagery overlays only, bottom to top',
  });
  assert.deepEqual(controller.state().stack, [
    'ustopo',
    'contours',
    'hillshade',
  ]);
  const lowered = voice.lower({ overlayId: 'hillshade' });
  assert.equal(lowered.ok, true);
  assert.deepEqual(controller.state().stack, [
    'ustopo',
    'hillshade',
    'contours',
  ]);
});

test('an overlay at the end of the stack cannot move further', () => {
  const controller = fakeController(FLAT);
  const voice = createOverlaysVoice(controller);
  const top = voice.raise({ overlayId: 'contours' });
  assert.equal(top.ok, false);
  assert.match(top.error, /already at the top/i);
  const bottom = voice.lower({ overlayId: 'ustopo' });
  assert.equal(bottom.ok, false);
  assert.match(bottom.error, /already at the bottom/i);
});

test('a 3D build is not part of the stack and cannot be raised', () => {
  const voice = createOverlaysVoice(fakeController(WITH_MODEL));
  const result = voice.raise({ overlayId: 'odm-barn' });
  assert.equal(result.ok, false);
  assert.match(result.error, /3D model/i);
});

test('phone mode switches the 3D builds and reads back', () => {
  const controller = fakeController(WITH_MODEL);
  const voice = createOverlaysVoice(controller);
  const on = voice.phone_mode({ enabled: true });
  assert.equal(on.ok, true);
  assert.equal(on.phoneMode, true);
  const off = voice.phone_mode({ enabled: false });
  assert.equal(off.phoneMode, false);
});

test('phone mode without a 3D build is refused', () => {
  const voice = createOverlaysVoice(fakeController(FLAT));
  const result = voice.phone_mode({ enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /no 3D build/i);
});

test('phone mode without a boolean is refused', () => {
  const voice = createOverlaysVoice(fakeController(WITH_MODEL));
  const result = voice.phone_mode({});
  assert.equal(result.ok, false);
  assert.match(result.error, /enabled true or false/i);
});

test('status lists every overlay with its state', () => {
  const controller = fakeController(WITH_MODEL);
  const voice = createOverlaysVoice(controller);
  voice.enable({ overlayId: 'contours', enabled: true });
  voice.opacity({ overlayId: 'hillshade', opacityPct: 35 });
  const result = voice.status();
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.overlays.map((row) => row.id),
    ['odm-barn', 'contours', 'hillshade', 'ustopo'],
  );
  const contours = result.overlays.find((row) => row.id === 'contours');
  assert.equal(contours.enabled, true);
  assert.equal(contours.drawn, true);
  assert.equal(
    result.overlays.find((row) => row.id === 'hillshade').opacityPct,
    35,
  );
  assert.equal(result.phoneMode, false);
});

test('a controller that cannot be read reports the overlays as unavailable', () => {
  const voice = createOverlaysVoice({
    state() {
      throw new Error('the map is gone');
    },
  });
  const result = voice.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable/i);
});

test('a controller error never reaches the model', () => {
  const secret = 'sk-ant-secret-Bearer-not-an-overlay';
  const voice = createOverlaysVoice({
    state() {
      throw new Error(secret);
    },
    setEnabled() {
      throw new Error(secret);
    },
    setOpacity() {
      throw new Error(secret);
    },
    moveLayer() {
      throw new Error(secret);
    },
    setPhoneMode() {
      throw new Error(secret);
    },
  });
  for (const call of [
    () => voice.status(),
    () => voice.enable({ overlayId: 'x', enabled: true }),
    () => voice.opacity({ overlayId: 'x', opacityPct: 50 }),
    () => voice.raise({ overlayId: 'x' }),
    () => voice.phone_mode({ enabled: true }),
  ]) {
    const result = call();
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});
