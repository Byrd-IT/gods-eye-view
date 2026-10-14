import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASEMAP_HEALTH_URL,
  HEALTH_POLL_MS,
  UNKNOWN_HEALTH,
  basemapDegradedReason,
  createBasemapHealthMonitor,
  loadBasemapHealth,
  normalizeBasemapHealth,
} from './health.js';
import {
  BYRDIT_OPEN_STACK,
  byrditOpenDescriptor,
  createBasemapMapSource,
} from './stack.js';
import { openBasemap } from './index.js';
import { normalizeBasemapConfig } from './config.js';

/** /basemap/health.json as the proxy serves it (proxy.js composeHealth). */
const DEGRADED = {
  schema: 1,
  available: true,
  state: 'degraded',
  chip: 'OPEN (degraded)',
  warnings: [
    'terrain edge /healthz timed out (service active; busy?)',
    'disk 76% within 5 points of guard',
  ],
  generated: '2026-10-14T10:55:37Z',
};
const OK = { ...DEGRADED, state: 'ok', chip: 'OPEN', warnings: [] };

/** /basemap/config.json with the stack available. */
const SERVED = {
  schema: 1,
  terrain: {
    available: true,
    version: 'mh0.0.13-wm20261011',
    url: '/basemap/v/mh0.0.13-wm20261011/terrain/cesium-mesh/ellipsoid',
    minzoom: 0,
    maxzoom: 14,
    waterMask: true,
  },
  imagery: {
    available: true,
    archive: 'imagery-2025',
    url: '/basemap/imagery/imagery-2025/{z}/{x}/{y}.webp',
    baseMaxzoom: 8,
    maxzoom: 14,
    year: 2025,
    regions: [],
  },
  buildings: { available: false },
  switch: {},
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  body: { cancel: async () => {} },
});

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async fire() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of entries) await fn();
    },
  };
}

const settle = async () => {
  for (let k = 0; k < 5; k += 1) await new Promise((r) => setImmediate(r));
};

test('normalize: state, chip and the first warning only; junk is unknown', () => {
  assert.deepEqual(normalizeBasemapHealth(DEGRADED), {
    state: 'degraded',
    chip: 'OPEN (degraded)',
    warning: 'terrain edge /healthz timed out (service active; busy?)',
  });
  assert.deepEqual(normalizeBasemapHealth(OK), {
    state: 'ok',
    chip: 'OPEN',
    warning: null,
  });
  for (const raw of [
    null,
    undefined,
    'degraded',
    {},
    { state: 'broken' },
    { ...DEGRADED, available: false },
    { available: false, state: 'unknown' },
  ])
    assert.equal(normalizeBasemapHealth(raw), UNKNOWN_HEALTH);
  // Non-string and blank warnings are skipped, control characters removed,
  // length capped.
  const odd = normalizeBasemapHealth({
    state: 'degraded',
    warnings: [42, '   ', 'a\u0000b\nc', 'second'],
  });
  assert.equal(odd.warning, 'a b c');
  assert.equal(
    normalizeBasemapHealth({ state: 'degraded', warnings: ['x'.repeat(500)] })
      .warning.length,
    200,
  );
});

test('degraded reason: the first warning, else the chip text; null when ok/unknown', () => {
  assert.equal(
    basemapDegradedReason(normalizeBasemapHealth(DEGRADED)),
    'terrain edge /healthz timed out (service active; busy?)',
  );
  assert.equal(
    basemapDegradedReason(
      normalizeBasemapHealth({ state: 'degraded', chip: 'OPEN (degraded)' }),
    ),
    'OPEN (degraded)',
  );
  assert.equal(
    basemapDegradedReason({ state: 'degraded', chip: null, warning: null }),
    'Byrd-IT Open map service is degraded',
  );
  // "down" never greys out a stack config.json says is available.
  assert.equal(
    basemapDegradedReason(
      normalizeBasemapHealth({
        state: 'down',
        chip: 'UNAVAILABLE (GEV falls back to the standby edge, then Esri)',
        warnings: ['terrain edge /healthz not ok: HTTP 502'],
      }),
    ),
    'terrain edge /healthz not ok: HTTP 502',
  );
  assert.equal(basemapDegradedReason(normalizeBasemapHealth(OK)), null);
  assert.equal(basemapDegradedReason(UNKNOWN_HEALTH), null);
  assert.equal(basemapDegradedReason(null), null);
});

test('loadBasemapHealth: same-origin GET, never throws', async () => {
  const seen = [];
  const got = await loadBasemapHealth({
    fetchImpl: async (url, init) => {
      seen.push([url, init.credentials, init.headers.Accept]);
      return json(DEGRADED);
    },
  });
  assert.deepEqual(seen, [[BASEMAP_HEALTH_URL, 'same-origin', 'application/json']]);
  assert.equal(got.state, 'degraded');

  for (const fetchImpl of [
    async () => {
      throw new TypeError('Failed to fetch');
    },
    async () => json({ error: 'x' }, 502),
    async () => ({ ok: true, status: 200, json: async () => JSON.parse('{') }),
    async () => json('not an object'),
  ])
    assert.equal(await loadBasemapHealth({ fetchImpl }), UNKNOWN_HEALTH);

  // An abort (page torn down) is also just unknown, not a rejection.
  const ac = new AbortController();
  ac.abort();
  assert.equal(
    await loadBasemapHealth({
      signal: ac.signal,
      fetchImpl: async (_url, init) => {
        init.signal.throwIfAborted();
        return json(OK);
      },
    }),
    UNKNOWN_HEALTH,
  );
});

test('loadBasemapHealth: a hung health fetch gives up at its timeout', async () => {
  const started = Date.now();
  const got = await loadBasemapHealth({
    timeoutMs: 30,
    fetchImpl: (_url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      ),
  });
  assert.equal(got, UNKNOWN_HEALTH);
  assert.ok(Date.now() - started < 2_000);
});

test('monitor: polls every 5 min, onChange only when the reason changes, stop ends it', async () => {
  const timers = fakeTimers();
  const answers = [DEGRADED, DEGRADED, OK, null, DEGRADED];
  let loads = 0;
  const changes = [];
  const monitor = createBasemapHealthMonitor({
    load: async () => normalizeBasemapHealth(answers[loads++]),
    timers,
    onChange: (reason) => changes.push(reason),
  });
  assert.equal(monitor.degradedReason, null);
  monitor.start();
  monitor.start(); // idempotent
  await settle();
  assert.equal(loads, 1);
  assert.equal(monitor.health.state, 'degraded');
  assert.equal(
    monitor.degradedReason,
    'terrain edge /healthz timed out (service active; busy?)',
  );
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [HEALTH_POLL_MS]);
  await timers.fire(); // same reason again: no change event
  await timers.fire(); // ok
  await timers.fire(); // junk -> unknown: still no badge, no event
  await timers.fire(); // degraded again
  assert.equal(loads, 5);
  assert.deepEqual(changes, [
    'terrain edge /healthz timed out (service active; busy?)',
    null,
    'terrain edge /healthz timed out (service active; busy?)',
  ]);
  monitor.stop();
  assert.equal(timers.pending.size, 0);
  monitor.start();
  await settle();
  assert.equal(loads, 5, 'a stopped monitor never polls again');
});

test('monitor: a load that throws, or a listener that throws, never breaks polling', async () => {
  const timers = fakeTimers();
  let n = 0;
  const monitor = createBasemapHealthMonitor({
    load: async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return normalizeBasemapHealth(DEGRADED);
    },
    timers,
    onChange: () => {
      throw new Error('listener boom');
    },
  });
  monitor.start();
  await settle();
  assert.equal(monitor.health, UNKNOWN_HEALTH);
  assert.equal(timers.pending.size, 1);
  await timers.fire();
  assert.equal(monitor.health.state, 'degraded');
  assert.equal(timers.pending.size, 1);
  monitor.stop();
});

test('monitor: a result that lands after stop is dropped', async () => {
  let resolve;
  const changes = [];
  const monitor = createBasemapHealthMonitor({
    load: () => new Promise((r) => (resolve = r)),
    timers: fakeTimers(),
    onChange: (reason) => changes.push(reason),
  });
  monitor.start();
  monitor.stop();
  resolve(normalizeBasemapHealth(DEGRADED));
  await settle();
  assert.deepEqual(changes, []);
  assert.equal(monitor.degradedReason, null);
});

test('stack: with a health source the descriptor carries a live degradedReason', () => {
  const health = { degradedReason: null };
  const descriptor = byrditOpenDescriptor(health);
  assert.notEqual(descriptor, BYRDIT_OPEN_STACK);
  assert.ok(Object.isFrozen(descriptor));
  assert.deepEqual(
    { ...descriptor, degradedReason: undefined },
    { ...BYRDIT_OPEN_STACK, degradedReason: undefined },
  );
  assert.equal({ ...descriptor }.degradedReason, null);
  health.degradedReason = 'disk 81% over guard 80%';
  // The controller spreads descriptors in getStacks(): the spread sees it.
  assert.equal({ ...descriptor }.degradedReason, 'disk 81% over guard 80%');
  assert.equal(byrditOpenDescriptor(null), BYRDIT_OPEN_STACK);

  const config = normalizeBasemapConfig(SERVED);
  const source = createBasemapMapSource({
    Cesium: {},
    config,
    fallbackTerrain: async () => ({}),
    health,
  });
  assert.equal(source.available, true);
  assert.equal(source.descriptor.degradedReason, 'disk 81% over guard 80%');
  // Unavailable config: health is irrelevant (chip greyed by config).
  const down = createBasemapMapSource({
    Cesium: {},
    config: normalizeBasemapConfig(null),
    fallbackTerrain: async () => ({}),
    health,
  });
  assert.equal(down.available, false);
  assert.equal(down.descriptor, BYRDIT_OPEN_STACK);
});

function basemapWorld({ health = DEGRADED, healthHangs = false } = {}) {
  const seen = [];
  let releaseHealth = null;
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === '/basemap/config.json') return json(SERVED);
    if (url === BASEMAP_HEALTH_URL) {
      if (healthHangs)
        return new Promise((r) => (releaseHealth = () => r(json(health))));
      return health instanceof Error
        ? Promise.reject(health)
        : json(health);
    }
    throw new Error(`unexpected ${url}`);
  };
  return {
    seen,
    release: () => releaseHealth?.(),
    open: (extra = {}) =>
      openBasemap({
        Cesium: { UrlTemplateImageryProvider: class {} },
        viewer: { scene: { primitives: { add() {}, remove() {} } } },
        doc: { querySelector: () => ({ getAttribute: () => '1' }) },
        fetchImpl,
        ...extra,
      }),
  };
}

const openSource = (result) =>
  result.controllerOptions.registry.sources.find(
    (s) => s.descriptor.id === 'byrdit-open',
  );

test('openBasemap: health is fetched in the background and never blocks the stack', async () => {
  const w = basemapWorld({ healthHangs: true });
  const result = await w.open();
  // The stack is ready while the health request is still pending.
  assert.equal(result.initialStack, 'byrdit-open');
  assert.deepEqual(w.seen, ['/basemap/config.json', BASEMAP_HEALTH_URL]);
  assert.equal(openSource(result).available, true);
  assert.equal(openSource(result).descriptor.degradedReason, null);
  w.release();
  await settle();
  assert.equal(
    openSource(result).descriptor.degradedReason,
    'terrain edge /healthz timed out (service active; busy?)',
  );
  result.destroy();
});

test('openBasemap: a failed health fetch leaves the chip as it was', async () => {
  for (const health of [new TypeError('Failed to fetch'), { error: 'x' }]) {
    const w = basemapWorld({ health });
    const result = await w.open();
    await settle();
    assert.equal(result.initialStack, 'byrdit-open');
    assert.equal(openSource(result).available, true);
    assert.equal(openSource(result).descriptor.degradedReason, null);
    result.destroy();
  }
});

test('openBasemap: config down -> no health request at all', async () => {
  const seen = [];
  const result = await openBasemap({
    Cesium: {},
    viewer: { scene: { primitives: { add() {}, remove() {} } } },
    doc: { querySelector: () => ({ getAttribute: () => '1' }) },
    fetchImpl: async (url) => {
      seen.push(url);
      return json({}, 502);
    },
  });
  await settle();
  assert.deepEqual(seen, ['/basemap/config.json']);
  assert.equal(result.health, null);
  result.destroy();
});

test('openBasemap attach: a reason change re-announces controller state; detach and destroy stop it', async () => {
  const timers = fakeTimers();
  const answers = [OK, DEGRADED];
  let i = 0;
  const w = basemapWorld();
  const result = await w.open({
    createHealthMonitor: ({ load }) =>
      createBasemapHealthMonitor({
        load: async () => {
          await load(); // the real same-origin request still happens
          return normalizeBasemapHealth(answers[i++] ?? DEGRADED);
        },
        timers,
      }),
  });
  await settle();
  let emits = 0;
  const controller = {
    getActiveId: () => 'byrdit-open',
    setStack: async () => ({}),
    getStacks: () => [],
    isStackAvailable: () => true,
    getStack: () => ({}),
    getState: () => ({}),
    subscribe: () => () => {},
    _emitChange: () => {
      emits += 1;
    },
  };
  const detach = result.attach(controller);
  assert.equal(emits, 0, 'ok -> no change');
  await timers.fire();
  await settle();
  assert.equal(emits, 1, 'ok -> degraded announces once');
  assert.equal(
    openSource(result).descriptor.degradedReason,
    'terrain edge /healthz timed out (service active; busy?)',
  );
  detach();
  answers.push(OK);
  await timers.fire();
  await settle();
  assert.equal(emits, 1, 'after detach the controller is not touched');
  result.destroy();
  assert.equal(timers.pending.size, 0, 'destroy stops polling');
});
