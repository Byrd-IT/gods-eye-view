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

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

function world({ hasCredentials = true, failGoogle = () => false } = {}) {
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
      globe: { show: true, tilesLoaded: true, getHeight: () => 0 },
      requestRender() {},
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
      add: (layer) => imagery.push(layer),
      remove: (layer) => imagery.splice(imagery.indexOf(layer), 1),
    },
  };
  const config = normalizeBasemapConfig(SERVED);
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
      return { tileset: { id: loads, show: true, tilesLoaded: true } };
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
  const registry = createLazyGoogleRegistry(base, session);
  const controller = new MapSourceController(viewer, {
    registry,
    initialStack: 'byrdit-open',
    createImageryLayer: (provider) => ({ provider }),
  });
  const timers = fakeTimers();
  const machine = createSwitchMachine({ ...config.switch, now: () => t });
  let gesture = false;
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
    get gesture() {
      return gesture;
    },
    set gesture(v) {
      gesture = v;
    },
    advance: (ms) => {
      t += ms;
    },
    async start() {
      await controller.setStack('byrdit-open', { silent: true });
      w.detach = attachBasemapSwitching({
        controller,
        viewer,
        session,
        machine,
        timers,
        isUserGesture: () => gesture,
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
  w.gesture = true;
  await w.controller.setStack('photoreal');
  assert.equal(
    w.controller.getActiveId(),
    'photoreal',
    'pinned at global view',
  );
  assert.equal(w.machine.mode, 'google');
  w.advance(1_000);
  await w.fly(20_000_000);
  assert.equal(w.controller.getActiveId(), 'photoreal', 'pin ignores height');
  await w.controller.setStack('byrdit-open');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  await w.fly(1_000);
  assert.equal(w.controller.getActiveId(), 'byrdit-open', 'Open pin holds');
  w.advance(6_000);
  await w.controller.setStack('basemap-auto');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'photoreal', 'auto at 1,000 m');
  assert.equal(getGoogleRootCount(), 1);
});

test('share-link restore without a user gesture does not pin or root Google', async () => {
  const w = world();
  await w.start();
  w.gesture = false;
  await w.controller.setStack('photoreal');
  assert.equal(w.machine.mode, 'auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(getGoogleRootCount(), 0);
});

test('picking another stack turns auto off until Auto or Google/Open is chosen', async () => {
  const w = world();
  await w.start();
  w.gesture = true;
  await w.controller.setStack('osm');
  assert.equal(w.controller.getActiveId(), 'osm');
  await w.fly(1_000);
  assert.equal(w.controller.getActiveId(), 'osm');
  assert.equal(getGoogleRootCount(), 0);
  await w.controller.setStack('basemap-auto');
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

test('openBasemap: flag ON + service down -> legacy path with a greyed chip', async () => {
  const result = await openBasemap({
    Cesium: {},
    viewer: { scene: {} },
    doc: {
      querySelector: () => ({ getAttribute: () => '1' }),
    },
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(result.lazy, false);
  assert.equal(result.initialStack, null);
  const source = result.controllerOptions.basemapSource;
  assert.equal(source.available, false);
  assert.match(source.unavailableReason, /HTTP 502/);
  const registry = createDefaultMapSources({
    googleTileset: { show: true },
    basemapSource: source,
  });
  assert.equal(registry.defaultId, 'photoreal');
  assert.equal(registry.sources.at(-1).descriptor.id, 'byrdit-open');
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
  w.gesture = true;
  await w.controller.setStack('esri-imagery');
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
  await w.fly(2_500);
  await w.controller.setStack('basemap-auto');
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  await w.controller.setStack('esri-imagery');
  await w.controller.setStack('byrdit-open');
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
