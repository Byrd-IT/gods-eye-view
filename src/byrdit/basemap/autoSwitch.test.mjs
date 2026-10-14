import test from 'node:test';
import assert from 'node:assert/strict';
import { MapSourceController } from '../../maps/controller.js';
import { createDefaultMapSources } from '../../maps/defaultSources.js';
import {
  createSwitchMachine,
  attachBasemapSwitching,
  cameraHeight,
} from './autoSwitch.js';
import {
  createGoogleSession,
  getGoogleRootCount,
  resetGoogleRootCount,
} from './googleSession.js';
import { createBasemapMapSource } from './stack.js';
import {
  createLazyGoogleRegistry,
  createNotifier,
  openBasemap,
} from './index.js';
import { normalizeBasemapConfig } from './config.js';
import { basemapCreditHtml } from './credits.js';
import { SERVED } from './fixtures/config.mjs';

const HOUR = 3_600_000;

test('hysteresis: ENTER <= 5,000 m, LEAVE >= 8,000 m', () => {
  let t = 0;
  const m = createSwitchMachine({ now: () => t });
  assert.equal(m.state, 'OPEN');
  assert.deepEqual(m.step(20_000_000), { action: null });
  assert.deepEqual(m.step(6_000), { action: null });
  assert.deepEqual(m.step(5_000), { action: 'GOOGLE' });
  m.commit('GOOGLE');
  t += 10_000;
  assert.deepEqual(m.step(7_999), { action: null }, 'inside the band');
  assert.deepEqual(m.step(8_000), { action: 'OPEN' });
});

test('dwell: no automatic switch within 5 s of the last one', () => {
  let t = 0;
  const m = createSwitchMachine({ now: () => t });
  m.commit('GOOGLE');
  t += 2_000;
  assert.deepEqual(m.step(50_000), { action: null, retryInMs: 3_000 });
  t += 3_000;
  assert.deepEqual(m.step(50_000), { action: 'OPEN' });
});

test('pinned modes ignore height and dwell; other stacks switch nothing', () => {
  let t = 0;
  const m = createSwitchMachine({ now: () => t });
  m.setMode('google');
  assert.deepEqual(m.step(1e7), { action: 'GOOGLE' });
  m.commit('GOOGLE');
  m.setMode('open');
  assert.deepEqual(m.step(10), { action: 'OPEN' });
  m.setMode('other');
  assert.deepEqual(m.step(10), { action: null });
  assert.equal(createSwitchMachine({ auto: false }).mode, 'open');
});

test('camera height is above terrain when the globe knows it', () => {
  const viewer = {
    camera: { positionCartographic: { height: 6_000 } },
    scene: { globe: { getHeight: () => 1_500 } },
  };
  assert.equal(cameraHeight(viewer), 4_500);
  viewer.scene.globe.getHeight = () => undefined;
  assert.equal(cameraHeight(viewer), 6_000);
});

// ---------------------------------------------------------------------------
// Integration with the real map controller (no network, fake scene).

function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise(value = {}) {
      for (const fn of [...listeners]) fn(value);
    },
  };
}

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) {
      pending.set(++id, { fn, ms, kind: 'timeout' });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    setInterval(fn, ms) {
      pending.set(++id, { fn, ms, kind: 'interval' });
      return id;
    },
    clearInterval(handle) {
      pending.delete(handle);
    },
    fireTimeouts() {
      for (const [handle, entry] of [...pending])
        if (entry.kind === 'timeout') {
          pending.delete(handle);
          entry.fn();
        }
    },
    count(kind) {
      return [...pending.values()].filter((e) => e.kind === kind).length;
    },
  };
}

const settle = async (rounds = 40) => {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * A fake frame loop with Cesium's tilesLoaded semantics: the value is only
 * recomputed while something is drawn, so a hidden tileset keeps the value
 * of its last drawn frame, and the globe needs `pendingFrames` frames after
 * new imagery before it is loaded again.
 */
function fakeFrames(scene, primitives) {
  let scheduled = false;
  scene.frames = 0;
  scene.postRender = event();
  const draw = (thing) => {
    if (!thing.show) return;
    if (thing.pendingFrames > 0) {
      thing.pendingFrames -= 1;
      thing.tilesLoaded = false;
    } else thing.tilesLoaded = true;
    thing.drawnFrames = (thing.drawnFrames ?? 0) + 1;
  };
  scene.requestRender = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      scene.frames += 1;
      draw(scene.globe);
      for (const p of primitives) draw(p);
      scene.postRender.raise();
    });
  };
}

function world({
  hasCredentials = true,
  failGoogle = () => false,
  served = SERVED,
} = {}) {
  resetGoogleRootCount();
  let t = 10_000_000;
  const credits = new Set();
  const primitives = [];
  const imagery = [];
  const camera = {
    positionCartographic: { height: 20_000_000 },
    moveStart: event(),
    moveEnd: event(),
  };
  const viewer = {
    camera,
    terrainProvider: null,
    scene: {
      globe: {
        show: true,
        tilesLoaded: true,
        pendingFrames: 0,
        getHeight: () => 0,
      },
      frameState: {
        creditDisplay: {
          addStaticCredit: (c) => credits.add(c),
          removeStaticCredit: (c) => credits.delete(c),
        },
      },
      primitives: {
        add: (p) => primitives.push(p),
        remove: (p) => {
          const i = primitives.indexOf(p);
          if (i < 0) return false;
          primitives.splice(i, 1);
          return true;
        },
      },
    },
    imageryLayers: {
      add: (layer) => {
        imagery.push(layer);
        // New imagery: the globe loads it over the next frames.
        viewer.scene.globe.pendingFrames = w.globeLoadFrames;
      },
      remove: (layer) => imagery.splice(imagery.indexOf(layer), 1),
    },
  };
  fakeFrames(viewer.scene, primitives);
  const config = normalizeBasemapConfig(served);
  const providers = new Map();
  const Cesium = {
    UrlTemplateImageryProvider: class {
      constructor(options) {
        this.options = options;
        this.errorEvent = event();
        providers.set('byrdit-open', this);
      }
    },
  };
  const basemapSource = createBasemapMapSource({
    Cesium,
    config,
    fallbackTerrain: async () => ({ provider: 'keyless' }),
  });
  basemapSource.terrain = {
    id: 'byrdit-open',
    create: async () => ({ provider: 'open-terrain' }),
  };
  let loads = 0;
  const session = createGoogleSession({
    hasCredentials,
    now: () => t,
    load: async () => {
      loads += 1;
      if (failGoogle(loads))
        return { tileset: null, errors: [new Error('403')] };
      return {
        tileset: {
          id: loads,
          show: true,
          tilesLoaded: false,
          pendingFrames: w.tilesetLoadFrames,
        },
      };
    },
    attach: (tileset) => {
      tileset.show = false;
      viewer.scene.primitives.add(tileset);
    },
    detach: (tileset) => viewer.scene.primitives.remove(tileset),
  });
  const base = createDefaultMapSources({
    googleTileset: null,
    googleApiKey: hasCredentials ? 'k' : '',
    basemapSource,
  });
  for (const source of base.sources)
    if (source.imagery && source.descriptor.id !== 'byrdit-open') {
      const provider = { id: source.descriptor.id, errorEvent: event() };
      providers.set(source.descriptor.id, provider);
      source.imagery = () => provider;
      source.terrain = {
        id: 'keyless',
        create: async () => ({ provider: 'k' }),
      };
    }
  const baseId = config.available ? 'byrdit-open' : 'esri-imagery';
  const registry = createLazyGoogleRegistry(base, session, baseId);
  const controller = new MapSourceController(viewer, {
    registry,
    initialStack: baseId,
    createImageryLayer: (provider) => ({ provider }),
  });
  const timers = fakeTimers();
  const machine = createSwitchMachine({ ...config.switch, now: () => t });
  const notes = [];
  const w = {
    viewer,
    controller,
    session,
    credits,
    primitives,
    imagery,
    timers,
    machine,
    providers,
    notes,
    config,
    globeLoadFrames: 0,
    tilesetLoadFrames: 0,
    /** A chip, the dropdown, voice or the API. */
    pick: (id) => controller.setStack(id, { intent: 'user' }),
    advance: (ms) => {
      t += ms;
    },
    async start() {
      await controller.setStack(baseId, { silent: true });
      w.detach = attachBasemapSwitching({
        controller,
        viewer,
        session,
        machine,
        timers,
        notify: (m) => notes.push(m),
      });
      await settle();
    },
    async fly(height) {
      camera.moveStart.raise();
      camera.positionCartographic = { height };
      camera.moveEnd.raise();
      await settle();
    },
    creditHtml: () => [...credits].map((c) => c.html),
  };
  return w;
}

test('global-view load: 0 Google roots, Byrd-IT Open shown with its credits', async () => {
  const w = world();
  await w.start();
  assert.equal(getGoogleRootCount(), 0);
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(w.viewer.scene.globe.show, true);
  assert.deepEqual(w.creditHtml(), [basemapCreditHtml(w.config)]);
  assert.equal(w.viewer.terrainProvider, 'open-terrain');
});

test('close-up (Austin) load: exactly 1 root, Google shown, open credits gone', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 1_200 };
  await w.start();
  assert.equal(getGoogleRootCount(), 1);
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.session.tileset.show, true);
  assert.equal(w.viewer.scene.globe.show, false);
  assert.deepEqual(w.creditHtml(), []);
});

test('20 zoom-in/zoom-out crossings = still 1 root; the tileset is reused, never recreated', async () => {
  const w = world();
  await w.start();
  let first = null;
  for (let i = 0; i < 20; i++) {
    w.advance(6_000);
    await w.fly(3_000);
    assert.equal(w.controller.getActiveId(), 'photoreal', `enter ${i}`);
    first ??= w.session.tileset;
    assert.equal(w.session.tileset, first);
    w.advance(6_000);
    await w.fly(12_000);
    assert.equal(w.controller.getActiveId(), 'byrdit-open', `leave ${i}`);
    assert.equal(first.show, false);
    assert.deepEqual(w.creditHtml(), [basemapCreditHtml(w.config)]);
  }
  assert.equal(getGoogleRootCount(), 1);
  assert.equal(w.primitives.filter((p) => p === first).length, 1);
});

test('after 2.6 h of session age one more entry = 2 roots', async () => {
  const w = world();
  await w.start();
  await w.fly(3_000);
  w.advance(6_000);
  await w.fly(12_000);
  assert.equal(getGoogleRootCount(), 1);
  const first = w.session.tileset;
  w.advance(2.6 * HOUR);
  await w.fly(3_000);
  assert.equal(getGoogleRootCount(), 2);
  assert.notEqual(w.session.tileset, first);
  assert.ok(!w.primitives.includes(first), 'the old tileset is released');
  assert.equal(w.controller.getActiveId(), 'photoreal');
});

test('dwell: a crossing within 5 s waits, then the timer completes it', async () => {
  const w = world();
  await w.start();
  await w.fly(3_000);
  assert.equal(w.controller.getActiveId(), 'photoreal');
  w.advance(1_000);
  await w.fly(12_000);
  assert.equal(w.controller.getActiveId(), 'photoreal', 'held by dwell');
  assert.equal(w.timers.count('timeout'), 1);
  w.advance(4_100);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
});

test('camera movement polls at 1 Hz between moveStart and moveEnd only', async () => {
  const w = world();
  await w.start();
  w.viewer.camera.moveStart.raise();
  assert.equal(w.timers.count('interval'), 1);
  w.viewer.camera.moveEnd.raise();
  await settle();
  assert.equal(w.timers.count('interval'), 0);
});

test('fallback chain: Google fails -> stays on Byrd-IT Open, no ion, backoff', async () => {
  const w = world({ failGoogle: () => true });
  await w.start();
  await w.fly(3_000);
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(getGoogleRootCount(), 1);
  assert.match(w.notes.join('\n'), /Google 3D unavailable \(403\)/);
  for (let i = 0; i < 10; i++) {
    w.advance(6_000);
    await w.fly(12_000);
    w.advance(6_000);
    await w.fly(3_000);
  }
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.ok(getGoogleRootCount() <= 3, `${getGoogleRootCount()} roots`);
});

test('fallback chain: open tiles failing -> Esri (last resort)', async () => {
  const w = world();
  await w.start();
  const open = w.providers.get('byrdit-open');
  for (let i = 0; i < 3; i++) open.errorEvent.raise({ timesRetried: 0 });
  await settle();
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
});

test('no Google key: the open stack stays, 0 roots', async () => {
  const w = world({ hasCredentials: false });
  await w.start();
  await w.fly(1_000);
  assert.equal(getGoogleRootCount(), 0);
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(w.controller.isStackAvailable('photoreal'), false);
});

test('override chips: Google pin, Open pin, Auto', async () => {
  const w = world();
  await w.start();
  const ids = w.controller.getStacks().map((s) => s.id);
  assert.ok(ids.includes('basemap-auto'));
  assert.ok(ids.includes('byrdit-open'));
  await w.pick('photoreal');
  assert.equal(
    w.controller.getActiveId(),
    'photoreal',
    'pinned at global view',
  );
  assert.equal(w.machine.mode, 'google');
  w.advance(1_000);
  await w.fly(20_000_000);
  assert.equal(w.controller.getActiveId(), 'photoreal', 'pin ignores height');
  await w.pick('byrdit-open');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  await w.fly(1_000);
  assert.equal(w.controller.getActiveId(), 'byrdit-open', 'Open pin holds');
  w.advance(6_000);
  await w.pick('basemap-auto');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'photoreal', 'auto at 1,000 m');
  assert.equal(getGoogleRootCount(), 1);
});

test('share-link restore (no user intent) does not pin or root Google', async () => {
  const w = world();
  await w.start();
  await w.controller.setStack('photoreal', { intent: 'restore' });
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(getGoogleRootCount(), 0);
});

test('picking another stack turns auto off until Auto or Google/Open is chosen', async () => {
  const w = world();
  await w.start();
  await w.pick('osm');
  assert.equal(w.controller.getActiveId(), 'osm');
  await w.fly(1_000);
  assert.equal(w.controller.getActiveId(), 'osm');
  assert.equal(getGoogleRootCount(), 0);
  await w.pick('basemap-auto');
  assert.equal(w.controller.getActiveId(), 'photoreal');
});

test('detach restores the controller and stops listening', async () => {
  const w = world();
  const ownSetStack = w.controller.setStack;
  await w.start();
  assert.notEqual(w.controller.setStack, ownSetStack);
  w.detach();
  assert.equal(w.controller.setStack, ownSetStack);
  await w.fly(1_000);
  assert.equal(getGoogleRootCount(), 0);
  assert.ok(!w.controller.getStacks().some((s) => s.id === 'basemap-auto'));
});

test('openBasemap: flag OFF makes no request and returns null', async () => {
  let fetched = 0;
  const result = await openBasemap({
    Cesium: {},
    viewer: {},
    doc: { querySelector: () => null },
    fetchImpl: async () => {
      fetched += 1;
    },
  });
  assert.equal(result, null);
  assert.equal(fetched, 0);
});

test('openBasemap: flag ON + service down -> Google stays lazy, Esri is the base, greyed chip', async () => {
  resetGoogleRootCount();
  let fetched = 0;
  const result = await openBasemap({
    Cesium: {},
    viewer: { scene: { primitives: { add() {}, remove() {} } } },
    googleApiKey: 'k',
    doc: {
      querySelector: () => ({ getAttribute: () => '1' }),
    },
    fetchImpl: async () => {
      fetched += 1;
      return { ok: false, status: 502 };
    },
  });
  assert.equal(fetched, 1);
  assert.equal(result.lazy, true, 'no eager Google root at global view');
  assert.equal(result.initialStack, 'esri-imagery');
  const { registry } = result.controllerOptions;
  assert.equal(registry.defaultId, 'esri-imagery');
  assert.equal(registry.recoveryId, 'esri-imagery');
  const source = registry.sources.find(
    (s) => s.descriptor.id === 'byrdit-open',
  );
  assert.equal(source.available, false);
  assert.match(source.unavailableReason, /HTTP 502/);
  const google = registry.sources.find((s) => s.descriptor.id === 'photoreal');
  assert.equal(google.tileset, null);
  assert.equal(google.available, true);
  assert.equal(getGoogleRootCount(), 0);
  assert.equal(typeof result.attach, 'function');
});

test('openBasemap: flag ON + service up -> lazy registry, open default', async () => {
  resetGoogleRootCount();
  const result = await openBasemap({
    Cesium: { UrlTemplateImageryProvider: class {} },
    viewer: { scene: { primitives: { add() {}, remove() {} } } },
    googleApiKey: 'k',
    doc: { querySelector: () => ({ getAttribute: () => '1' }) },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => SERVED,
    }),
  });
  assert.equal(result.lazy, true);
  assert.equal(result.initialStack, 'byrdit-open');
  const { registry } = result.controllerOptions;
  assert.equal(registry.defaultId, 'byrdit-open');
  assert.equal(registry.recoveryId, 'byrdit-open');
  const google = registry.sources.find((s) => s.descriptor.id === 'photoreal');
  assert.equal(google.tileset, null);
  assert.equal(google.available, true);
  assert.equal(getGoogleRootCount(), 0);
});

test('createDefaultMapSources without a basemap source is unchanged', () => {
  const plain = createDefaultMapSources({ googleTileset: null });
  assert.deepEqual(
    plain.sources.map((s) => s.descriptor.id),
    ['photoreal', 'bing-aerial', 'bing-labels', 'esri-imagery', 'osm'],
  );
});

test('Auto from Esri with Google down: back on Byrd-IT Open, not stuck on Esri', async () => {
  const w = world({ failGoogle: () => true });
  await w.start();
  await w.pick('esri-imagery');
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
  await w.fly(2_500);
  await w.pick('basemap-auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  await w.pick('esri-imagery');
  await w.pick('byrdit-open');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
});

test('status messages reach the user at most once a minute each', () => {
  let t = 0;
  const seen = [];
  const extra = [];
  const tell = createNotifier(
    (m) => seen.push(m),
    60_000,
    () => t,
  );
  assert.equal(
    tell('a', () => extra.push('a')),
    true,
  );
  assert.equal(
    tell('a', () => extra.push('a')),
    false,
  );
  assert.equal(tell('b'), true);
  t += 60_000;
  assert.equal(tell('a'), true);
  assert.deepEqual(seen, ['a', 'b', 'a']);
  assert.deepEqual(extra, ['a']);
});

// ---------------------------------------------------------------------------
// Review t_d9b79b50 repairs: the machine follows the controller, explicit
// intent, validation, render-readiness, and the /basemap-down path.

/** The machine says GOOGLE exactly when Google is what the controller shows. */
function assertInStep(w, message) {
  assert.equal(
    w.machine.state === 'GOOGLE',
    w.controller.getActiveId() === 'photoreal',
    `${message}: machine ${w.machine.state}/${w.machine.mode}, active ${w.controller.getActiveId()}`,
  );
}

test('Google -> Esri -> Google chip restores Google (real controller)', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  assert.equal(w.controller.getActiveId(), 'photoreal');
  await w.pick('esri-imagery');
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
  assert.equal(w.machine.mode, 'other');
  await w.pick('photoreal');
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.machine.mode, 'google');
  assert.equal(w.session.tileset.show, true);
  assert.equal(w.viewer.scene.globe.show, false);
  assertInStep(w, 'after the Google chip');
  assert.equal(getGoogleRootCount(), 1, 'the tileset is reused');
});

test('Google -> Esri -> Auto chip restores Google close in, Open high up', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  await w.pick('esri-imagery');
  await w.pick('basemap-auto');
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.machine.mode, 'auto');
  assertInStep(w, 'Auto close in');
  await w.pick('esri-imagery');
  await w.fly(50_000);
  await w.pick('basemap-auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assertInStep(w, 'Auto high up');
});

test('Google -> Esri -> programmatic restore of photoreal lands on the auto stack', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  await w.pick('esri-imagery');
  await w.controller.setStack('photoreal');
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.machine.mode, 'auto', 'a restore never pins');
  assertInStep(w, 'restore close in');
  // The same restore high up shows the base map and opens no new root.
  await w.pick('esri-imagery');
  await w.fly(50_000);
  await w.controller.setStack('photoreal', { intent: 'restore' });
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(w.machine.mode, 'auto');
  assertInStep(w, 'restore high up');
  assert.equal(getGoogleRootCount(), 1);
});

test('imagery comparison lease from Google: release restores Google and the auto switch', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  const lease = w.controller.acquireImageryComparison({
    owner: 'test',
    switchPolicy: 'esri-if-photoreal',
  });
  assert.deepEqual(await lease.ready, {
    status: 'ready',
    activeId: 'esri-imagery',
  });
  assert.equal(w.machine.mode, 'other');
  await w.fly(2_000);
  assert.equal(w.controller.getActiveId(), 'esri-imagery', 'lease holds');
  await lease.release();
  await settle();
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.machine.mode, 'auto');
  assertInStep(w, 'after release');
  assert.equal(w.viewer.scene.globe.show, false);
  // Auto works again: zooming out leaves Google.
  w.advance(6_000);
  await w.fly(12_000);
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assertInStep(w, 'auto after release');
});

test('imagery comparison lease from Open: release restores Open without drawing Google', async () => {
  const w = world();
  await w.start();
  // Create the (hidden) Google tileset once.
  await w.fly(3_000);
  w.advance(6_000);
  await w.fly(12_000);
  const tileset = w.session.tileset;
  assert.equal(tileset.show, false);
  let shown = 0;
  let show = tileset.show;
  Object.defineProperty(tileset, 'show', {
    get: () => show,
    set: (v) => {
      if (v) shown += 1;
      show = v;
    },
  });
  const lease = w.controller.acquireImageryComparison({
    owner: 'test',
    switchPolicy: 'esri',
  });
  assert.equal((await lease.ready).activeId, 'esri-imagery');
  await lease.release();
  await settle();
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(w.machine.mode, 'auto');
  assertInStep(w, 'after release');
  assert.equal(shown, 0, 'Google never shown while going Esri -> Open');
});

test('a leave superseded by the Google chip does not strand GOOGLE with Open shown', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  assert.equal(w.controller.getActiveId(), 'photoreal');
  w.advance(6_000);
  w.viewer.camera.positionCartographic = { height: 12_000 };
  w.viewer.camera.moveEnd.raise(); // the leave starts ...
  const pin = w.pick('photoreal'); // ... and the user pins Google mid-way
  await pin;
  await settle();
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.machine.mode, 'google');
  assertInStep(w, 'pin during leave');
});

test('a leave superseded by another map commits what the controller shows', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  w.advance(6_000);
  w.viewer.camera.positionCartographic = { height: 12_000 };
  w.viewer.camera.moveEnd.raise();
  await w.pick('osm');
  await settle();
  assert.equal(w.controller.getActiveId(), 'osm');
  assertInStep(w, 'other during leave');
  await w.pick('basemap-auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assertInStep(w, 'Auto afterwards');
});

test('unknown id: no mode change, no Google root, the base stays', async () => {
  const w = world();
  await w.start();
  await w.pick('no-such-stack');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(getGoogleRootCount(), 0);
  assertInStep(w, 'unknown id');
});

test('unavailable id: reported, nothing switches, auto stays on', async () => {
  const w = world();
  await w.start();
  const errors = [];
  w.controller._onError = (m) => errors.push(m);
  const state = await w.pick('bing-aerial'); // needs a Cesium ion token
  assert.equal(state.activeId, 'byrdit-open');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(errors.length, 1);
  await w.fly(3_000);
  assert.equal(w.controller.getActiveId(), 'photoreal', 'auto still switches');
});

test('Google chip without Google credentials: reported, no pin, no root', async () => {
  const w = world({ hasCredentials: false });
  await w.start();
  const errors = [];
  w.controller._onError = (m) => errors.push(m);
  await w.pick('photoreal');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(errors.length, 1);
  assert.equal(getGoogleRootCount(), 0);
});

test('recipe restore during a user activation does not pin (intent, not navigator.userActivation)', async () => {
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...nav, userActivation: { isActive: true, hasBeenActive: true } },
    configurable: true,
    writable: true,
  });
  try {
    const w = world();
    await w.start();
    // visualSettings/sharelink restores go through select(..., {syncShare: false}).
    const { createMapSourceControls } =
      await import('../../ui/mapSourceControls.js');
    const el = () => ({
      children: [],
      classList: { toggle() {} },
      appendChild(c) {
        this.children.push(c);
      },
      set innerHTML(_) {
        this.children.length = 0;
      },
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      dataset: {},
    });
    const container = el();
    container.ownerDocument = { createElement: el };
    const controls = createMapSourceControls({
      container,
      statusElement: null,
      controller: w.controller,
      subscribe: (fn) => w.controller.subscribe(fn),
    });
    await controls.select('photoreal', { syncShare: false });
    assert.equal(w.machine.mode, 'auto', 'a restore never pins');
    assert.equal(w.controller.getActiveId(), 'byrdit-open');
    assert.equal(getGoogleRootCount(), 0, 'no root at global view');
    // The same id from a chip/API is a pin.
    await controls.select('photoreal');
    assert.equal(w.machine.mode, 'google');
    assert.equal(w.controller.getActiveId(), 'photoreal');
    controls.destroy();
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
});

test('recipe restore while Google is being entered: no pin, ends on Google', async () => {
  const w = world();
  await w.start();
  w.tilesetLoadFrames = 4; // Google's first view takes a few frames
  w.viewer.camera.positionCartographic = { height: 3_000 };
  w.viewer.camera.moveEnd.raise(); // entry in flight
  await w.controller.setStack('photoreal', { intent: 'restore' });
  await settle();
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assertInStep(w, 'restore during entry');
  assert.equal(getGoogleRootCount(), 1);
});

test('no flash on ENTER: a hidden tileset with a stale tilesLoaded=true waits for the current view', async () => {
  const w = world();
  await w.start();
  await w.fly(3_000);
  w.advance(6_000);
  await w.fly(12_000);
  const tileset = w.session.tileset;
  assert.equal(tileset.show, false);
  assert.equal(tileset.tilesLoaded, true, 'stale value from its last frame');
  tileset.pendingFrames = 3; // the new view is not loaded yet
  let atSwitch = null;
  const off = w.controller.subscribe((state) => {
    if (state.activeId === 'photoreal' && !atSwitch)
      atSwitch = {
        pending: tileset.pendingFrames,
        loaded: tileset.tilesLoaded,
        drawn: tileset.drawnFrames,
      };
  });
  const drawnBefore = tileset.drawnFrames;
  w.advance(6_000);
  await w.fly(3_000);
  off();
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.ok(atSwitch, 'switched');
  assert.equal(atSwitch.pending, 0, 'the current view had loaded');
  assert.equal(atSwitch.loaded, true);
  assert.ok(atSwitch.drawn - drawnBefore >= 4, 'drawn before the globe went');
});

test('no flash on LEAVE: Google stays until the globe has drawn the new open imagery', async () => {
  const w = world();
  w.viewer.camera.positionCartographic = { height: 3_000 };
  await w.start();
  const tileset = w.session.tileset;
  const globe = w.viewer.scene.globe;
  assert.equal(globe.tilesLoaded, true, 'stale value from before Google');
  w.globeLoadFrames = 3;
  let atHide = null;
  let show = tileset.show;
  Object.defineProperty(tileset, 'show', {
    get: () => show,
    set: (v) => {
      if (show && !v && globe.show && !atHide)
        atHide = { pending: globe.pendingFrames, loaded: globe.tilesLoaded };
      show = v;
    },
  });
  w.advance(6_000);
  await w.fly(12_000);
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(tileset.show, false);
  assert.ok(atHide, 'Google was hidden over the globe');
  assert.equal(atHide.pending, 0, 'the globe had loaded the new imagery');
  assert.equal(atHide.loaded, true);
});

test('/basemap down (flag ON): Esri base, lazy Google, 0 roots global, 1 close-up, 1 after 20 crossings', async () => {
  const w = world({ served: null });
  assert.equal(w.config.available, false);
  await w.start();
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
  assert.equal(w.controller.isStackAvailable('byrdit-open'), false);
  assert.equal(getGoogleRootCount(), 0, 'global view');
  for (let i = 0; i < 20; i++) {
    w.advance(6_000);
    await w.fly(3_000);
    assert.equal(w.controller.getActiveId(), 'photoreal', `enter ${i}`);
    w.advance(6_000);
    await w.fly(12_000);
    assert.equal(w.controller.getActiveId(), 'esri-imagery', `leave ${i}`);
    assertInStep(w, `crossing ${i}`);
  }
  assert.equal(getGoogleRootCount(), 1);
  // The greyed Open chip cannot pin; Auto and Esri still work.
  await w.pick('byrdit-open');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
});

test('/basemap down and Google failing: stays on Esri, at most 3 roots an hour', async () => {
  const w = world({ served: null, failGoogle: () => true });
  await w.start();
  for (let i = 0; i < 10; i++) {
    w.advance(6_000);
    await w.fly(3_000);
    assert.equal(w.controller.getActiveId(), 'esri-imagery');
    w.advance(6_000);
    await w.fly(12_000);
  }
  assert.ok(getGoogleRootCount() <= 3, `${getGoogleRootCount()} roots`);
  assertInStep(w, 'failing Google');
});
