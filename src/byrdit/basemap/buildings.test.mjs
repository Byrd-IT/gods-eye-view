import test from 'node:test';
import assert from 'node:assert/strict';
import { MapSourceController } from '../../maps/controller.js';
import { createDefaultMapSources } from '../../maps/defaultSources.js';
import { attachBasemapSwitching, createSwitchMachine } from './autoSwitch.js';
import { createGoogleSession, resetGoogleRootCount } from './googleSession.js';
import { createBasemapMapSource } from './stack.js';
import { createLazyGoogleRegistry, openBasemap } from './index.js';
import { normalizeBasemapConfig, normalizeBuildings } from './config.js';
import { BUILDINGS_CREDIT_HTML, BUILDINGS_CREDIT_TEXT } from './credits.js';
import {
  attachBuildings,
  buildingPickInfo,
  createBuildingsVisibility,
  createPickCard,
} from './buildings.js';
import {
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { SERVED } from './fixtures/config.mjs';

const BUILDINGS_URL = '/basemap/v/ov2026-09-23.1-v5-add/buildings/tileset.json';

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
    get size() {
      return listeners.size;
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
    fireIntervals() {
      for (const entry of [...pending.values()])
        if (entry.kind === 'interval') entry.fn();
    },
    /** Fire (and drop) every pending timeout, whatever its delay. */
    fireTimeouts() {
      for (const [handle, entry] of [...pending.entries()])
        if (entry.kind === 'timeout') {
          pending.delete(handle);
          entry.fn();
        }
    },
    timeouts() {
      return [...pending.values()]
        .filter((e) => e.kind === 'timeout')
        .map((e) => e.ms);
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

/** Cesium's tilesLoaded semantics, as in autoSwitch.test.mjs. */
function fakeFrames(scene, primitives) {
  let scheduled = false;
  scene.postRender = event();
  scene.preUpdate = event();
  const draw = (thing) => {
    if (!thing.show) return;
    thing.tilesLoaded = true;
  };
  scene.requestRender = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      scene.preUpdate.raise();
      draw(scene.globe);
      for (const p of primitives) draw(p);
      scene.postRender.raise();
    });
  };
}

/** Fake Cesium pieces the buildings layer uses; records every tileset. */
function fakeCesium({ fail = () => false, delay = null } = {}) {
  const made = [];
  const handlers = [];
  const calls = [];
  const creditsMade = [];
  class Credit {
    constructor(html, showOnScreen) {
      creditsMade.push(this);
      this.html = html;
      this.showOnScreen = showOnScreen;
    }
  }
  class ScreenSpaceEventHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const Cesium = {
    Credit,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType: { LEFT_CLICK: 'LEFT_CLICK' },
    UrlTemplateImageryProvider: class {
      constructor(options) {
        this.options = options;
        this.errorEvent = event();
      }
    },
    Cesium3DTileset: {
      async fromUrl(url, options) {
        calls.push({ url, options });
        if (delay) await delay();
        if (fail(calls.length)) throw new Error('tileset.json 502');
        const tileset = {
          kind: 'buildings',
          url,
          options,
          show: true,
          destroyed: false,
          isDestroyed() {
            return this.destroyed;
          },
          destroy() {
            this.destroyed = true;
          },
        };
        made.push(tileset);
        return tileset;
      },
    },
  };
  return { Cesium, made, handlers, calls, creditsMade };
}

function world({
  served = SERVED,
  cesium = fakeCesium(),
  withSwitch = true,
} = {}) {
  resetGoogleRootCount();
  let t = 50_000_000;
  const credits = new Set();
  const creditOps = { add: 0, remove: 0 };
  const primitives = [];
  const camera = {
    positionCartographic: { height: 20_000_000 },
    moveStart: event(),
    moveEnd: event(),
  };
  let pickResult = null;
  const viewer = {
    camera,
    container: null,
    terrainProvider: null,
    scene: {
      canvas: { id: 'canvas' },
      globe: { show: true, tilesLoaded: true, getHeight: () => 0 },
      pick: () => pickResult,
      frameState: {
        creditDisplay: {
          addStaticCredit: (c) => {
            creditOps.add += 1;
            credits.add(c);
          },
          removeStaticCredit: (c) => {
            creditOps.remove += 1;
            credits.delete(c);
          },
        },
      },
      primitives: {
        add: (p) => primitives.push(p),
        remove: (p) => {
          const i = primitives.indexOf(p);
          if (i < 0) return false;
          primitives.splice(i, 1);
          // Cesium's PrimitiveCollection destroys what it removes.
          p.destroy?.();
          return true;
        },
      },
    },
    imageryLayers: { add() {}, remove() {} },
  };
  fakeFrames(viewer.scene, primitives);
  const config = normalizeBasemapConfig(served);
  const basemapSource = createBasemapMapSource({
    Cesium: cesium.Cesium,
    config,
    fallbackTerrain: async () => ({ provider: 'keyless' }),
  });
  basemapSource.terrain = {
    id: 'byrdit-open',
    create: async () => ({ provider: 'open-terrain' }),
  };
  const session = createGoogleSession({
    hasCredentials: true,
    now: () => t,
    load: async () => ({
      tileset: { kind: 'google', show: true, tilesLoaded: false },
    }),
    attach: (tileset) => {
      tileset.show = false;
      viewer.scene.primitives.add(tileset);
    },
    detach: (tileset) => viewer.scene.primitives.remove(tileset),
  });
  const base = createDefaultMapSources({
    googleTileset: null,
    googleApiKey: 'k',
    basemapSource,
  });
  for (const source of base.sources)
    if (source.imagery && source.descriptor.id !== 'byrdit-open') {
      const provider = { id: source.descriptor.id, errorEvent: event() };
      source.imagery = () => provider;
      source.terrain = {
        id: 'keyless',
        create: async () => ({ provider: 'k' }),
      };
    }
  const registry = createLazyGoogleRegistry(base, session, 'byrdit-open');
  const controller = new MapSourceController(viewer, {
    registry,
    initialStack: 'byrdit-open',
    createImageryLayer: (provider) => ({ provider }),
  });
  const timers = fakeTimers();
  const cards = [];
  const warnings = [];
  const w = {
    ...cesium,
    viewer,
    controller,
    session,
    credits,
    creditOps,
    primitives,
    timers,
    cards,
    warnings,
    config,
    advance: (ms) => {
      t += ms;
    },
    setPick: (value) => {
      pickResult = value;
    },
    async start() {
      await controller.setStack('byrdit-open', { silent: true });
      if (withSwitch)
        w.detachSwitch = attachBasemapSwitching({
          controller,
          viewer,
          session,
          machine: createSwitchMachine({ ...config.switch, now: () => t }),
          timers,
        });
      w.detach = attachBuildings({
        Cesium: cesium.Cesium,
        viewer,
        controller,
        session,
        config: config.buildings,
        timers,
        now: () => t,
        pickCard: {
          show: (info, position) => cards.push({ info, position }),
          hide: () => cards.push(null),
        },
        warn: (...args) => warnings.push(args.join(' ')),
      });
      await settle();
    },
    async fly(height) {
      camera.moveStart.raise();
      camera.positionCartographic = { height };
      camera.moveEnd.raise();
      await settle();
    },
    buildings: () => primitives.filter((p) => p.kind === 'buildings'),
    google: () => session.tileset,
    creditHtml: () => [...credits].map((c) => c.html),
    hasBuildingsCredit: () =>
      [...credits].some((c) => c.html === BUILDINGS_CREDIT_HTML),
    click: (position = { x: 10, y: 20 }) =>
      cesium.handlers.at(-1).actions.get('LEFT_CLICK')({ position }),
  };
  return w;
}

const plain = (html) => html.replace(/<[^>]+>/g, '');

test('visibility rule: open stack only, never with Google, hysteresis', () => {
  const v = createBuildingsVisibility({ showBelowM: 8000, hideAboveM: 10000 });
  const open = { openShown: true, googleShown: false };
  assert.equal(v.next(false, { ...open, heightM: 20_000 }), false);
  assert.equal(v.next(false, { ...open, heightM: 8000 }), true);
  assert.equal(v.next(false, { ...open, heightM: 9000 }), false);
  assert.equal(v.next(true, { ...open, heightM: 9000 }), true);
  assert.equal(v.next(true, { ...open, heightM: 10_001 }), false);
  assert.equal(v.next(true, { ...open, heightM: NaN }), true);
  assert.equal(
    v.next(true, { openShown: true, googleShown: true, heightM: 100 }),
    false,
  );
  assert.equal(
    v.next(true, { openShown: false, googleShown: false, heightM: 100 }),
    false,
  );
});

test('config: buildings block validated; threshold, SSE and memory limits from config', () => {
  const b = normalizeBasemapConfig(SERVED).buildings;
  assert.deepEqual(b, {
    available: true,
    url: BUILDINGS_URL,
    version: 'ov2026-09-23.1-v5-add',
    bounds: [-106.65, 25.84, -93.51, 36.5],
    showBelowM: 8000,
    hideAboveM: 10000,
    maximumScreenSpaceError: 16,
    cacheBytes: 268435456,
    maximumCacheOverflowBytes: 134217728,
  });
  // Missing block: layer off, stack still available.
  const none = normalizeBasemapConfig({ ...SERVED, buildings: undefined });
  assert.equal(none.available, true);
  assert.equal(none.buildings.available, false);
  // Not same-origin, traversal or not a tileset.json: off.
  for (const url of [
    'https://evil.example/buildings/tileset.json',
    '/basemap/v/../../etc/tileset.json',
    '/basemap/v/x/buildings/7/1/1.glb',
    '/basemap/v/x/buildings/tileset.json?key=1',
  ])
    assert.equal(normalizeBuildings({ available: true, url }).available, false);
  // Bad numbers fall back; hide is always above show; cache capped at 1 GiB.
  const odd = normalizeBuildings({
    available: true,
    url: BUILDINGS_URL,
    showBelowM: 6000,
    hideAboveM: 5000,
    maximumScreenSpaceError: 1e6,
    cacheBytes: 1e12,
    maximumCacheOverflowBytes: -1,
  });
  assert.equal(odd.showBelowM, 6000);
  assert.equal(odd.hideAboveM, 7500);
  assert.equal(odd.maximumScreenSpaceError, 256);
  assert.equal(odd.cacheBytes, 1024 * 1024 * 1024);
  assert.equal(odd.maximumCacheOverflowBytes, 128 * 1024 * 1024);
});

test('global view: no buildings request, no credit', async () => {
  const w = world();
  await w.start();
  assert.equal(w.calls.length, 0);
  assert.equal(w.buildings().length, 0);
  assert.equal(w.hasBuildingsCredit(), false);
});

test('Open pinned, below the threshold: one tileset with the config limits, shown, credited', async () => {
  const w = world();
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await w.fly(3000);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.calls[0], {
    url: BUILDINGS_URL,
    options: {
      maximumScreenSpaceError: 16,
      cacheBytes: 268435456,
      maximumCacheOverflowBytes: 134217728,
      preloadWhenHidden: false,
      showCreditsOnScreen: false,
    },
  });
  assert.equal(w.buildings().length, 1);
  assert.equal(w.buildings()[0].show, true);
  assert.equal(w.hasBuildingsCredit(), true);
  assert.equal(w.google(), null, 'pinned Open: no Google root');
  // Open-stack credits are still there next to the buildings credit.
  assert.equal(w.credits.size, 2);
});

test('above the threshold: hidden and uncredited but kept; back down reuses it', async () => {
  const w = world();
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await w.fly(3000);
  const [tileset] = w.buildings();
  await w.fly(9000); // inside the hysteresis band: stays
  assert.equal(tileset.show, true);
  await w.fly(12_000);
  assert.equal(tileset.show, false);
  assert.equal(w.hasBuildingsCredit(), false);
  assert.equal(w.buildings().length, 1);
  await w.fly(9000); // band from above: stays hidden
  assert.equal(tileset.show, false);
  await w.fly(7000);
  assert.equal(tileset.show, true);
  assert.equal(w.hasBuildingsCredit(), true);
  assert.equal(w.calls.length, 1, 'never recreated while Open stays');
});

test('auto mode: shown on the way down, destroyed when Google takes over, recreated after', async () => {
  const w = world();
  await w.start();
  await w.fly(7000); // above ENTER (5,000 m), below the buildings threshold
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(w.buildings()[0]?.show, true);
  const first = w.buildings()[0];
  w.advance(10_000);
  await w.fly(3000); // ENTER: Google
  assert.equal(w.controller.getActiveId(), 'photoreal');
  assert.equal(w.google().show, true);
  assert.equal(w.buildings().length, 0, 'destroyed on the stack switch');
  assert.equal(first.destroyed, true);
  assert.equal(w.hasBuildingsCredit(), false);
  w.advance(10_000);
  await w.fly(9000); // LEAVE: back to the open globe, inside the band
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  assert.equal(w.google().show, false);
  assert.equal(w.buildings().length, 0, 'band from above: not shown');
  await w.fly(7500);
  assert.equal(w.buildings().length, 1);
  assert.equal(w.buildings()[0].show, true);
  assert.equal(w.calls.length, 2);
});

test('hidden while Google is drawn over the open stack (no-flash hand-over)', async () => {
  const w = world({ withSwitch: false });
  await w.start();
  await w.fly(3000);
  const [tileset] = w.buildings();
  assert.equal(tileset.show, true);
  // The P3 switch shows Google first and switches the controller later.
  const google = { kind: 'google', show: true };
  w.session.ensure = async () => google;
  Object.defineProperty(w.session, 'tileset', { get: () => google });
  w.viewer.scene.requestRender();
  await settle();
  assert.equal(tileset.show, false, 'per-frame check hid it');
  assert.equal(w.hasBuildingsCredit(), false);
  google.show = false;
  w.viewer.scene.requestRender();
  await settle();
  assert.equal(tileset.show, true, 'shown again once Google is gone');
});

test('switch to Esri / OSM destroys the tileset; back to Open recreates it on demand', async () => {
  const w = world();
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await w.fly(3000);
  const [first] = w.buildings();
  await w.controller.setStack('esri-imagery', { intent: 'user' });
  await settle();
  assert.equal(w.controller.getActiveId(), 'esri-imagery');
  assert.equal(w.buildings().length, 0);
  assert.equal(first.destroyed, true);
  assert.equal(w.hasBuildingsCredit(), false);
  assert.equal(w.handlers.at(-1).destroyed, true, 'pick handler removed');
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await settle();
  assert.equal(w.buildings().length, 1);
  assert.notEqual(w.buildings()[0], first);
  assert.equal(w.hasBuildingsCredit(), true);
});

test('a tileset that finishes loading after a switch away is destroyed, never added', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const w = world({ cesium: fakeCesium({ delay: () => gate }) });
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await w.fly(3000);
  assert.equal(w.calls.length, 1);
  await w.controller.setStack('osm', { intent: 'user' });
  await settle();
  release();
  await settle();
  assert.equal(w.buildings().length, 0);
  assert.equal(w.made[0].destroyed, true);
  assert.equal(w.hasBuildingsCredit(), false);
});

test('tileset.json failure: warned once, the stack stays, retried after a minute', async () => {
  const w = world({ cesium: fakeCesium({ fail: (n) => n === 1 }) });
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await w.fly(3000);
  assert.equal(w.calls.length, 1);
  assert.equal(w.warnings.length, 1);
  assert.match(w.warnings[0], /buildings tileset unavailable/);
  assert.equal(w.controller.getActiveId(), 'byrdit-open');
  await w.fly(2900);
  assert.equal(w.calls.length, 1, 'no retry inside a minute');
  w.advance(60_000);
  await w.fly(2800);
  assert.equal(w.calls.length, 2);
  assert.equal(w.buildings().length, 1);
});

/** A gate the fake fromUrl awaits, released per call. */
function gates() {
  const open = [];
  return {
    delay: () =>
      new Promise((resolve) => {
        open.push(resolve);
      }),
    release: () => open.shift()?.(),
    get waiting() {
      return open.length;
    },
  };
}

test('R1 stationary camera: a failed root is retried by timer alone, no camera or controller event', async () => {
  const w = world({
    withSwitch: false,
    cesium: fakeCesium({ fail: (n) => n === 1 }),
  });
  await w.start();
  await w.fly(3000); // the last camera event in this test
  assert.equal(w.calls.length, 1);
  assert.equal(w.warnings.length, 1);
  assert.equal(w.detach.state().retryPending, true);
  assert.deepEqual(w.timers.timeouts(), [60_000], 'one timer at retryMs');
  // A timer that fires early (clock not advanced) respects the backoff and
  // re-arms for the rest of it instead of requesting.
  w.advance(20_000);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 1, 'no request inside the backoff');
  assert.deepEqual(w.timers.timeouts(), [40_000]);
  w.advance(40_000);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 2, 'recovered with no external event');
  assert.equal(w.buildings().length, 1);
  assert.equal(w.buildings()[0].show, true);
  assert.equal(w.hasBuildingsCredit(), true);
  assert.equal(w.detach.state().retryPending, false);
  assert.deepEqual(w.timers.timeouts(), []);
});

test('R1 repeated failure keeps the backoff; never two requests in flight', async () => {
  const g = gates();
  const w = world({
    withSwitch: false,
    cesium: fakeCesium({ fail: (n) => n <= 2, delay: g.delay }),
  });
  await w.start();
  await w.fly(3000);
  g.release();
  await settle();
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.timers.timeouts(), [60_000]);
  w.advance(60_000);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 2, 'retry started');
  assert.equal(w.detach.state().creating, true);
  // While it is in flight nothing else starts a request or arms a timer.
  for (let i = 0; i < 10; i++) w.detach.evaluate();
  await w.fly(2900);
  w.advance(120_000);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 2, 'no overlap');
  assert.deepEqual(w.timers.timeouts(), []);
  g.release(); // second failure
  await settle();
  assert.equal(w.warnings.length, 2);
  assert.deepEqual(w.timers.timeouts(), [60_000], 'backoff restarts');
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 2, 'early fire still waits');
  w.advance(60_000);
  w.timers.fireTimeouts();
  await settle();
  g.release();
  await settle();
  assert.equal(w.calls.length, 3);
  assert.equal(w.buildings().length, 1);
});

test('R1 retry timer cancelled on detach', async () => {
  const w = world({
    withSwitch: false,
    cesium: fakeCesium({ fail: () => true }),
  });
  await w.start();
  await w.fly(3000);
  assert.deepEqual(w.timers.timeouts(), [60_000]);
  w.detach();
  assert.deepEqual(w.timers.timeouts(), []);
  w.advance(600_000);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 1);
});

test('R1 retry timer cancelled on switch away; back to Open retries once due', async () => {
  const w = world({
    withSwitch: false,
    cesium: fakeCesium({ fail: (n) => n === 1 }),
  });
  await w.start();
  await w.fly(3000);
  assert.deepEqual(w.timers.timeouts(), [60_000]);
  await w.controller.setStack('osm', { intent: 'user' });
  await settle();
  assert.deepEqual(w.timers.timeouts(), [], 'cancelled with the stack');
  w.advance(60_000);
  w.timers.fireTimeouts();
  await settle();
  assert.equal(w.calls.length, 1, 'no request while another stack shows');
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await settle();
  assert.equal(w.calls.length, 2);
  assert.equal(w.buildings().length, 1);
});

test('R1 no retry while hidden: above the threshold or Google drawn', async () => {
  const w = world({
    withSwitch: false,
    cesium: fakeCesium({ fail: (n) => n === 1 }),
  });
  await w.start();
  await w.fly(3000);
  await w.fly(12_000);
  assert.deepEqual(w.timers.timeouts(), [], 'above the threshold: no timer');
  w.advance(60_000);
  await settle();
  assert.equal(w.calls.length, 1);
  await w.fly(3000);
  assert.equal(w.calls.length, 2, 'due on the way back down');
  // Fresh failure, then Google drawn over the open stack: timer cancelled.
  const v = world({
    withSwitch: false,
    cesium: fakeCesium({ fail: (n) => n === 1 }),
  });
  await v.start();
  await v.fly(3000);
  assert.deepEqual(v.timers.timeouts(), [60_000]);
  const google = { kind: 'google', show: true };
  Object.defineProperty(v.session, 'tileset', { get: () => google });
  v.viewer.scene.requestRender();
  await settle();
  assert.deepEqual(v.timers.timeouts(), [], 'Google drawn: cancelled');
  v.advance(60_000);
  v.timers.fireTimeouts();
  await settle();
  assert.equal(v.calls.length, 1, 'no buildings root while Google shows');
  google.show = false;
  v.viewer.scene.requestRender();
  await settle();
  assert.equal(v.calls.length, 2);
  assert.equal(v.buildings()[0].show, true);
});

test('R1 in-flight races: failure landing after detach or switch-away arms no timer', async () => {
  for (const leave of ['detach', 'switch']) {
    const g = gates();
    const w = world({
      withSwitch: false,
      cesium: fakeCesium({ fail: () => true, delay: g.delay }),
    });
    await w.start();
    await w.fly(3000);
    assert.equal(w.detach.state().creating, true);
    if (leave === 'detach') w.detach();
    else {
      await w.controller.setStack('osm', { intent: 'user' });
      await settle();
    }
    g.release();
    await settle();
    assert.deepEqual(w.timers.timeouts(), [], `${leave}: no timer`);
    assert.equal(w.warnings.length, 0, `${leave}: stale failure ignored`);
    w.advance(600_000);
    w.timers.fireTimeouts();
    await settle();
    assert.equal(w.calls.length, 1, `${leave}: no retry`);
  }
});

test('R2 credit idempotent: unchanged evaluations construct/add/remove nothing', async () => {
  const w = world({ withSwitch: false });
  await w.start();
  assert.equal(w.creditsMade.length, 0);
  await w.fly(3000);
  const buildingsCredits = () =>
    w.creditsMade.filter((c) => c.html === BUILDINGS_CREDIT_HTML).length;
  assert.equal(buildingsCredits(), 1);
  const ops = { ...w.creditOps };
  for (let i = 0; i < 100; i++) w.detach.evaluate();
  assert.equal(buildingsCredits(), 1, 'no new Credit');
  assert.deepEqual(w.creditOps, ops, 'no add/remove');
  // Hide and show again: one remove, one add, the same Credit object.
  await w.fly(12_000);
  for (let i = 0; i < 50; i++) w.detach.evaluate();
  assert.equal(w.creditOps.remove, ops.remove + 1);
  assert.equal(w.hasBuildingsCredit(), false);
  await w.fly(3000);
  for (let i = 0; i < 50; i++) w.detach.evaluate();
  assert.equal(w.creditOps.add, ops.add + 1);
  assert.equal(w.creditOps.remove, ops.remove + 1);
  assert.equal(buildingsCredits(), 1, 'Credit reused');
  assert.equal(w.hasBuildingsCredit(), true);
  assert.equal(w.detach.state().credit, true);
  w.detach();
  assert.equal(w.creditOps.remove, ops.remove + 2);
  assert.equal(w.detach.state().credit, false);
});

test('camera polling: 1 Hz only between moveStart and moveEnd', async () => {
  const w = world({ withSwitch: false });
  await w.start();
  assert.equal(w.timers.count('interval'), 0);
  w.viewer.camera.moveStart.raise();
  assert.equal(w.timers.count('interval'), 1);
  w.viewer.camera.positionCartographic = { height: 4000 };
  w.timers.fireIntervals();
  await settle();
  assert.equal(w.buildings().length, 1, 'the poll evaluated mid-flight');
  w.viewer.camera.moveEnd.raise();
  assert.equal(w.timers.count('interval'), 0);
});

test('pick: a building of this tileset opens the card; anything else closes it', async () => {
  resetPointerOwnership();
  const w = world();
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  await w.fly(3000);
  const [tileset] = w.buildings();
  const props = {
    name: 'Texas State Capitol',
    class: 'government',
    subtype: 'civic',
    height: 92.3,
    height_method: 'explicit',
    num_floors: 4,
    ground_elev: 165.2,
    gers_id: '08b2a1',
  };
  w.setPick({ tileset, getProperty: (n) => props[n] });
  w.click({ x: 100, y: 50 });
  const last = w.cards.at(-1);
  assert.equal(last.info.title, 'Texas State Capitol');
  assert.deepEqual(last.position, { x: 100, y: 50 });
  assert.deepEqual(last.info.rows[1], ['Height', '92.3 m']);
  // A Google feature or empty space closes the card.
  w.setPick({ tileset: { kind: 'other' }, getProperty: () => 1 });
  w.click();
  assert.equal(w.cards.at(-1), null);
  // A tool owns the pointer: the click is not ours.
  w.setPick({ tileset, getProperty: (n) => props[n] });
  const before = w.cards.length;
  const lease = claimPointer('draw');
  w.click();
  assert.equal(w.cards.length, before);
  releasePointer(lease);
  // An open card closes when the layer hides; a hidden layer opens none.
  w.click();
  assert.ok(w.cards.at(-1)?.info);
  await w.fly(12_000);
  assert.equal(w.cards.at(-1), null);
  const hiddenCount = w.cards.length;
  w.click();
  assert.equal(w.cards.length, hiddenCount);
});

test('pick info: explicit height plain, any other method shown as estimated', () => {
  const info = (props) => buildingPickInfo((n) => props[n]);
  const explicit = info({ height: 26.7, height_method: 'explicit' });
  assert.equal(explicit.heightEstimated, false);
  assert.deepEqual(explicit.rows, [['Height', '26.7 m']]);
  assert.equal(explicit.title, 'Building');
  for (const [method, label] of [
    ['num_floors', 'floor count'],
    ['class', 'building class'],
    ['subtype', 'building type'],
    ['footprint', 'footprint size'],
    ['density', 'local building density'],
    ['', 'an unknown method'],
    [undefined, 'an unknown method'],
  ]) {
    const r = info({ height: 9, height_method: method });
    assert.equal(r.heightEstimated, true, String(method));
    assert.deepEqual(r.rows, [['Height', `~9.0 m (estimated from ${label})`]]);
  }
  // noData values and broken getters are skipped, not shown as 0.
  const sparse = buildingPickInfo((n) => {
    if (n === 'gers_id') throw new Error('no property');
    return {
      height: 5,
      height_method: 'class',
      num_floors: 0,
      ground_elev: 0,
      class: 'house',
      subtype: 'house',
    }[n];
  });
  assert.deepEqual(sparse.rows, [
    ['Type', 'house'],
    ['Height', '~5.0 m (estimated from building class)'],
  ]);
  assert.equal(info({ num_floors: 3n }).rows[0][1], '3');
});

test('pick card renders text only (no markup from tile metadata)', () => {
  const made = [];
  const listeners = new Map();
  const el = (tag) => {
    const node = {
      tag,
      children: [],
      attrs: {},
      style: {},
      textContent: '',
      setAttribute: (k, v) => {
        node.attrs[k] = v;
      },
      append: (...c) => node.children.push(...c),
      addEventListener: () => {},
      remove: () => {
        node.removed = true;
      },
    };
    made.push(node);
    return node;
  };
  const doc = {
    createElement: el,
    addEventListener: (k, fn) => listeners.set(k, fn),
    removeEventListener: (k) => listeners.delete(k),
  };
  const container = el('container');
  const card = createPickCard(container, doc);
  card.show(
    { title: '<img src=x onerror=alert(1)>', rows: [['Height', '<b>9</b>']] },
    { x: 1, y: 2 },
  );
  const shown = card.element;
  assert.equal(container.children[0], shown);
  assert.equal(shown.attrs.role, 'dialog');
  assert.equal(shown.children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(shown.children[2].textContent, 'Height: <b>9</b>');
  assert.ok(!('innerHTML' in shown));
  listeners.get('keydown')({ key: 'Escape' });
  assert.equal(shown.removed, true);
  assert.equal(card.element, null);
});

test('credit: the BASEMAP.md 4.4 buildings string, present exactly while buildings show', async () => {
  assert.equal(
    BUILDINGS_CREDIT_TEXT,
    '© OpenStreetMap contributors, Overture Maps Foundation (ODbL)',
  );
  assert.equal(
    plain(BUILDINGS_CREDIT_HTML),
    'Buildings © OpenStreetMap contributors, Overture Maps Foundation (ODbL)',
  );
  const w = world();
  await w.start();
  await w.controller.setStack('byrdit-open', { intent: 'user' });
  const seen = [];
  for (const h of [20_000, 3000, 9000, 12_000, 2000]) {
    await w.fly(h);
    seen.push(w.hasBuildingsCredit() === (w.buildings()[0]?.show === true));
  }
  assert.deepEqual(seen, [true, true, true, true, true]);
  assert.equal(
    w.creditHtml().filter((h) => plain(h).includes(BUILDINGS_CREDIT_TEXT))
      .length,
    1,
  );
});

test('detach: tileset destroyed, credit and listeners gone', async () => {
  const w = world({ withSwitch: false });
  await w.start();
  await w.fly(3000);
  const [tileset] = w.buildings();
  w.detach();
  assert.equal(tileset.destroyed, true);
  assert.equal(w.buildings().length, 0);
  assert.equal(w.hasBuildingsCredit(), false);
  assert.equal(w.viewer.camera.moveEnd.size, 0);
  assert.equal(w.viewer.scene.preUpdate.size, 0);
  await w.fly(2000);
  assert.equal(w.calls.length, 1);
});

test('openBasemap attach: buildings only when the config offers them', async () => {
  const run = async (served) => {
    const { Cesium, calls } = fakeCesium();
    const doc = { querySelector: () => ({ getAttribute: () => '1' }) };
    const viewer = {
      camera: {
        positionCartographic: { height: 7000 },
        moveStart: event(),
        moveEnd: event(),
      },
      scene: {
        globe: { getHeight: () => 0 },
        primitives: { add() {}, remove: () => true },
        preUpdate: event(),
      },
    };
    const result = await openBasemap({
      Cesium,
      viewer,
      googleApiKey: 'k',
      doc,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => served,
      }),
    });
    let listener = null;
    const controller = {
      getActiveId: () => 'byrdit-open',
      setStack: async () => ({}),
      getStacks: () => [],
      isStackAvailable: () => true,
      getStack: () => ({}),
      getState: () => ({}),
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    };
    const detach = result.attach(controller);
    await settle();
    const out = { calls: calls.length, buildings: detach.buildings, listener };
    detach();
    out.after = listener;
    return out;
  };
  const on = await run(SERVED);
  assert.equal(typeof on.buildings, 'function');
  assert.equal(on.calls, 1);
  assert.equal(typeof on.listener, 'function');
  assert.equal(on.after, null, 'detach unsubscribes');
  const off = await run({ ...SERVED, buildings: undefined });
  assert.equal(off.buildings, null);
  assert.equal(off.calls, 0);
});
