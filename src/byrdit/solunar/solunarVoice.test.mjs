import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { bindRenderer } from '../../render/rendererOf.js';
import {
  SOLUNAR_BODY_ID,
  SOLUNAR_ID,
  SPOT_MARKER_ID,
  mountSolunarForShell,
} from './solunarShell.js';
import {
  SOLUNAR_VOICE_ACTIONS,
  createSolunarVoice,
  readSpotArgs,
} from './solunarVoice.js';

const DEG = Math.PI / 180;
const onGlobe = (x, y) => ({ x, y, z: 7_000_000 });

function fakeViewer({ hit = onGlobe } = {}) {
  const added = [];
  const removed = [];
  const canvas = new Window().document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const ellipsoid = {
    cartesianToCartographic: (c) => ({
      latitude: (30 + c.y / 100) * DEG,
      longitude: (-100 + c.x / 100) * DEG,
    }),
  };
  const viewer = {
    added,
    removed,
    renders: { n: 0 },
    scene: {
      canvas,
      globe: { ellipsoid },
      requestRender() {
        this.owner.renders.n++;
      },
    },
    camera: {
      positionCartographic: { latitude: 10 * DEG, longitude: 20 * DEG },
      pickEllipsoid: (px) => hit(px.x, px.y),
    },
    entities: {
      add: (e) => {
        added.push(e);
        return e;
      },
      remove: (e) => removed.push(e),
    },
  };
  viewer.scene.owner = viewer;
  // The shell picks the ground through the renderer's query port.
  bindRenderer(viewer, {
    canvas,
    query: {
      pickPosition: () => null,
      pickEllipsoid: (x, y) => hit(x, y),
      pickRay: () => null,
      pickGlobe: () => null,
    },
  });
  return viewer;
}

/** The card, mounted the way the shell mounts it, in its own window. */
function setup({ open = false, viewer = fakeViewer(), shell = {} } = {}) {
  const window = new Window();
  const doc = window.document;
  const root = doc.createElement('div');
  root.id = SOLUNAR_ID;
  root.className = open ? '' : 'collapsed';
  const body = doc.createElement('div');
  body.id = SOLUNAR_BODY_ID;
  root.append(body);
  doc.body.append(root);
  const previousWindow = globalThis.window;
  globalThis.window = window;
  const mount = mountSolunarForShell(
    {
      viewer,
      setPanelCollapsed: (_id, collapsed) =>
        root.classList.toggle('collapsed', collapsed),
      ...shell,
    },
    { document: doc, now: () => Date.UTC(2026, 10, 3, 18) },
  );
  return {
    window,
    doc,
    root,
    body,
    viewer,
    mount,
    restore: () => {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// ── the adapter on its own ────────────────────────────────────────────────

/** A fake card: the same functions the buttons call. */
function fakeCard({ spot = null, hour12 = true, open = false } = {}) {
  const state = {
    spot,
    hour12,
    open,
    calls: [],
    destroyed: false,
  };
  const voice = createSolunarVoice({
    open: () => {
      state.calls.push(['open']);
      state.open = true;
    },
    isOpen: () => state.open,
    setSpot: (latDeg, lonDeg) => {
      state.calls.push(['setSpot', latDeg, lonDeg]);
      if (state.destroyed) return false;
      state.spot = { latDeg, lonDeg, zone: 'UTC', source: 'voice' };
      return true;
    },
    getSpot: () => state.spot,
    useCenter: () => {
      state.calls.push(['useCenter']);
      if (state.destroyed) return false;
      state.spot = { latDeg: 1, lonDeg: 2, zone: 'UTC', source: 'center' };
      return true;
    },
    setHour12: (value) => {
      state.calls.push(['setHour12', value]);
      if (state.destroyed) return false;
      state.hour12 = value;
      return true;
    },
    getHour12: () => state.hour12,
    isDestroyed: () => state.destroyed,
    readToday: () => ({ date: '2026-11-03', phase: 'Waxing Crescent' }),
  });
  return { state, voice };
}

test('throwing lifecycle provider is contained for every action', async () => {
  const voice = createSolunarVoice({
    isDestroyed: () => {
      throw new Error('sensitive-fixture');
    },
  });
  for (const action of SOLUNAR_VOICE_ACTIONS) {
    const result = await voice[action]();
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture/);
  }
});

test('the adapter offers exactly the five card actions', () => {
  assert.deepEqual(
    [...SOLUNAR_VOICE_ACTIONS],
    ['open', 'spot', 'center', 'clock', 'status'],
  );
  const { voice } = fakeCard();
  for (const action of SOLUNAR_VOICE_ACTIONS)
    assert.equal(typeof voice[action], 'function', action);
});

test('readSpotArgs takes the degrees and refuses anything else', () => {
  assert.deepEqual(readSpotArgs({ latitude: 33.05, longitude: -95.1 }), {
    latDeg: 33.05,
    lonDeg: -95.1,
  });
  assert.deepEqual(readSpotArgs({ lat: 33.05, lon: -95.1 }), {
    latDeg: 33.05,
    lonDeg: -95.1,
  });
  for (const bad of [
    {},
    { latitude: 33.05 },
    { latitude: '33.05', longitude: -95.1 },
    { latitude: NaN, longitude: -95.1 },
    { latitude: Infinity, longitude: -95.1 },
    { latitude: 91, longitude: -95.1 },
    { latitude: -91, longitude: -95.1 },
    { latitude: 33.05, longitude: 181 },
    { latitude: 33.05, longitude: -181 },
    { latitude: null, longitude: null },
  ])
    assert.equal(readSpotArgs(bad), null, JSON.stringify(bad));
});

test('open opens the card and reads the state back', async () => {
  const { state, voice } = fakeCard();
  const result = await voice.open();
  assert.equal(result.ok, true);
  assert.equal(result.open, true);
  assert.equal(result.hour12, true);
  assert.deepEqual(state.calls, [['open']]);
});

test('spot puts the card on the given place and reads it back', async () => {
  const { state, voice } = fakeCard();
  const result = await voice.spot({ latitude: 33.05, longitude: -95.1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.spot, {
    latitude: 33.05,
    longitude: -95.1,
    zone: 'UTC',
    source: 'voice',
  });
  assert.ok(state.calls.some((c) => c[0] === 'setSpot'));
  // the card is opened for the answer, so the person sees it
  assert.ok(state.calls.some((c) => c[0] === 'open'));
});

test('spot refuses a place that is not on the globe, and changes nothing', async () => {
  const { state, voice } = fakeCard();
  const result = await voice.spot({ latitude: 120, longitude: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /latitude/);
  assert.equal(state.spot, null);
  assert.ok(!state.calls.some((c) => c[0] === 'setSpot'));
});

test('center goes back to the middle of the map', async () => {
  const { state, voice } = fakeCard();
  const result = await voice.center();
  assert.equal(result.ok, true);
  assert.equal(result.spot.source, 'center');
  assert.ok(state.calls.some((c) => c[0] === 'useCenter'));
});

test('clock switches between 12 h and 24 h and reads back', () => {
  const { state, voice } = fakeCard();
  const result = voice.clock({ hour12: false });
  assert.equal(result.ok, true);
  assert.equal(result.hour12, false);
  assert.equal(state.hour12, false);
});

test('clock refuses anything that is not a boolean and keeps the old choice', () => {
  const { state, voice } = fakeCard();
  for (const bad of ['true', 0, 1, null, undefined, {}, [], NaN]) {
    const result = voice.clock({ hour12: bad });
    assert.equal(result.ok, false, String(bad));
    assert.match(result.error, /12 hour|24 hour/);
  }
  assert.equal(state.hour12, true, 'the clock did not change');
  assert.ok(!state.calls.some((c) => c[0] === 'setHour12'));
});

test('status reports the card and the day without changing anything', () => {
  const { state, voice } = fakeCard({
    spot: {
      latDeg: 33.05,
      lonDeg: -95.1,
      zone: 'America/Chicago',
      source: 'click',
    },
  });
  const result = voice.status();
  assert.equal(result.ok, true);
  assert.equal(result.spot.zone, 'America/Chicago');
  assert.equal(result.today.phase, 'Waxing Crescent');
  assert.deepEqual(state.calls, []);
});

test('a missing card fails closed, and no caller value is echoed back', async () => {
  const voice = createSolunarVoice({});
  for (const action of SOLUNAR_VOICE_ACTIONS) {
    const result = await voice[action]();
    assert.equal(result.ok, false, action);
    assert.equal(result.error, 'Solunar is not available right now', action);
  }
  const spot = await voice.spot({ latitude: 33.05, longitude: -95.1 });
  assert.equal(spot.ok, false);
  assert.ok(!spot.error.includes('33.05'), 'no caller value in the error');
});

test('a card that throws is contained, not leaked', async () => {
  const voice = createSolunarVoice({
    open: () => {
      throw new Error('secret token abc123');
    },
    isOpen: () => false,
    setSpot: () => true,
    getSpot: () => null,
    useCenter: () => true,
    setHour12: () => true,
    getHour12: () => true,
    readToday: () => {
      throw new Error('key sk-live-1');
    },
  });
  const result = await voice.open();
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('abc123'));
  // a broken readback never fails the action that asked for it
  const status = voice.status();
  assert.equal(status.ok, true);
  assert.equal(status.today, null);
});

test('a destroyed card answers nothing', async () => {
  const { state, voice } = fakeCard();
  state.destroyed = true;
  for (const action of SOLUNAR_VOICE_ACTIONS) {
    const result = await voice[action]();
    assert.equal(result.ok, false, action);
  }
});

// ── the card through the shell mount ──────────────────────────────────────

test('the mounted card publishes a voice handle on the window', () => {
  const { window, mount, restore } = setup();
  try {
    assert.equal(window.__gevSolunar, mount);
    for (const action of SOLUNAR_VOICE_ACTIONS)
      assert.equal(typeof mount.voice[action], 'function', action);
  } finally {
    restore();
  }
});

test('destroy takes back only its own window handle', () => {
  const { window, mount, restore } = setup();
  try {
    mount.destroy();
    assert.equal(window.__gevSolunar, undefined);
    // a later card's handle is not taken with it
    const other = { voice: {} };
    window.__gevSolunar = other;
    mount.destroy();
    assert.equal(window.__gevSolunar, other);
  } finally {
    restore();
  }
});

test('voice reveals an already expanded card on a phone sheet', async () => {
  let reveals = 0;
  const { mount, restore } = setup({
    open: true,
    shell: {
      revealPanel: () => {
        reveals++;
      },
    },
  });
  try {
    assert.equal((await mount.voice.open()).ok, true);
    assert.equal(reveals, 1);
  } finally {
    mount.destroy();
    restore();
  }
});

test('voice spot reveals an already expanded card on a phone sheet', async () => {
  let reveals = 0;
  const { mount, restore } = setup({
    open: true,
    shell: {
      revealPanel: () => {
        reveals++;
      },
    },
  });
  try {
    assert.equal(
      (await mount.voice.spot({ latitude: 33.05, longitude: -95.1 })).ok,
      true,
    );
    assert.equal(reveals, 1);
  } finally {
    mount.destroy();
    restore();
  }
});

test('voice waits for asynchronous rail disclosure before reporting open', async () => {
  let root;
  const setupResult = setup({
    shell: {
      setPanelCollapsed: () =>
        queueMicrotask(() => root.classList.remove('collapsed')),
    },
  });
  root = setupResult.root;
  try {
    const result = await setupResult.mount.voice.open();
    assert.equal(result.ok, true);
    assert.equal(root.classList.contains('collapsed'), false);
  } finally {
    setupResult.mount.destroy();
    setupResult.restore();
  }
});

test('voice refuses opening when the rail cannot disclose the card', async () => {
  const { mount, root, restore } = setup({
    shell: { setPanelCollapsed: null },
  });
  try {
    assert.equal((await mount.voice.open()).ok, false);
    assert.equal(root.classList.contains('collapsed'), true);
  } finally {
    mount.destroy();
    restore();
  }
});

test('voice opens the closed card and shows the week', async () => {
  const { body, mount, restore } = setup();
  try {
    assert.equal(body.querySelectorAll('.gev-sl-day').length, 0);
    const result = await mount.voice.open();
    assert.equal(result.ok, true);
    await tick();
    assert.equal(body.querySelectorAll('.gev-sl-day').length, 7);
  } finally {
    restore();
  }
});

test('voice sets a spot, marks it and reads the day back', async () => {
  const { body, viewer, mount, restore } = setup({ open: true });
  try {
    await tick();
    const result = await mount.voice.spot({
      latitude: 33.05,
      longitude: -95.1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.spot.latitude, 33.05);
    assert.equal(result.spot.longitude, -95.1);
    assert.ok(result.spot.zone, 'the spot has a zone');
    assert.equal(result.today.date, '2026-11-03');
    assert.equal(typeof result.today.sunrise, 'string');
    // the gold dot marks the spot the voice asked for
    assert.ok(viewer.added.some((e) => e.id === SPOT_MARKER_ID));
    assert.match(
      body.querySelector('.gev-sl-spot').textContent,
      /33\.050°N 95\.100°W/,
    );
  } finally {
    restore();
  }
});

test('voice centre goes back to the middle of the map', async () => {
  const { body, mount, restore } = setup({ open: true });
  try {
    await tick();
    await mount.voice.spot({ latitude: 33.05, longitude: -95.1 });
    const result = await mount.voice.center();
    assert.equal(result.ok, true);
    assert.equal(result.spot.source, 'center');
    // the fake globe's middle is 33.0N 96.0W
    assert.match(
      body.querySelector('.gev-sl-spot').textContent,
      /33\.000°N 96\.000°W/,
    );
  } finally {
    restore();
  }
});

test('voice center refuses an unavailable map center even with an existing spot', async () => {
  const viewer = fakeViewer({ hit: () => null });
  const { mount, restore } = setup({ open: true, viewer });
  try {
    await mount.voice.spot({ latitude: 33.05, longitude: -95.1 });
    viewer.camera.positionCartographic = null;
    const result = await mount.voice.center();
    assert.equal(result.ok, false);
    assert.equal(mount.voice.status().spot.source, 'voice');
  } finally {
    mount.destroy();
    restore();
  }
});

test('voice clock switches the card to the 24 h clock', async () => {
  const { body, mount, restore } = setup({ open: true });
  try {
    await tick();
    await mount.voice.spot({ latitude: 33.05, longitude: -95.1 });
    const result = mount.voice.clock({ hour12: false });
    assert.equal(result.ok, true);
    assert.equal(result.hour12, false);
    const sunset = body.querySelector(
      '.gev-sl-day[data-date="2026-11-03"] .gev-sl-sunset .gev-sl-value',
    );
    assert.equal(sunset.textContent, '17:27');
    // the card's own chips show the same choice
    assert.equal(
      body.querySelector('.gev-sl-clock.active').dataset.hour12,
      'false',
    );
  } finally {
    restore();
  }
});

test('voice status reads the card back without touching it', async () => {
  const { body, mount, restore } = setup({ open: true });
  try {
    await tick();
    const before = body.querySelector('.gev-sl-spot').textContent;
    const result = mount.voice.status();
    assert.equal(result.ok, true);
    assert.equal(result.open, true);
    assert.equal(result.spot.source, 'center');
    assert.match(result.spot.zone, /America\/Chicago/);
    assert.ok(result.today.date);
    assert.equal(body.querySelector('.gev-sl-spot').textContent, before);
  } finally {
    restore();
  }
});

test('voice refuses a bad spot and a bad clock on the real card', async () => {
  const { mount, restore } = setup({ open: true });
  try {
    await tick();
    const spot = await mount.voice.spot({ latitude: 400, longitude: 0 });
    assert.equal(spot.ok, false);
    const clock = mount.voice.clock({ hour12: 'yes' });
    assert.equal(clock.ok, false);
    const status = mount.voice.status();
    assert.equal(status.ok, true);
    assert.equal(status.spot.source, 'center', 'the old spot stayed');
  } finally {
    restore();
  }
});

test('voice on a destroyed card answers nothing', async () => {
  const { mount, restore } = setup({ open: true });
  try {
    await tick();
    mount.destroy();
    const result = mount.voice.status();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Solunar is not available right now');
  } finally {
    restore();
  }
});
