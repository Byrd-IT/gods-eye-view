import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RECORD_FIELDS, packFlags } from './satCore.js';
import {
  MAX_EXTRAPOLATE_MS,
  createSatSky,
  extrapolateAzEl,
  unpackRecords,
} from './satSky.js';
import { createSatWorkerHandler } from './satWorker.js';

const FIXTURE = readFileSync(
  new URL('./reference/satFixture200.csv', import.meta.url),
  'utf8',
);
const LINES = FIXTURE.trim().split(/\r?\n/);
const HEADER = LINES[0];
const ISS_ROW = LINES.find((l) => l.includes(',25544,'));
const STARLINK_ROWS = LINES.filter((l) => l.startsWith('STARLINK'));
const T0 = Date.parse('2026-10-11T03:00:00Z');

/** In-process stand-in for the module worker, running the real handler. */
class FakeWorker extends EventTarget {
  constructor({ auto = true } = {}) {
    super();
    this.auto = auto;
    this.posted = [];
    this.outbox = [];
    this.terminated = false;
    this.handle = createSatWorkerHandler((message) =>
      this.outbox.push(message),
    );
  }
  postMessage(message) {
    this.posted.push(message);
    this.handle(message);
    if (this.auto) queueMicrotask(() => this.deliver());
  }
  deliver() {
    for (const data of this.outbox.splice(0))
      this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  terminate() {
    this.terminated = true;
  }
  ticks() {
    return this.posted.filter((m) => m.type === 'tick');
  }
}

function fakeTimers() {
  const intervals = new Map();
  let id = 1;
  return {
    intervals,
    setInterval: (fn, ms) => {
      intervals.set(id, { fn, ms });
      return id++;
    },
    clearInterval: (handle) => intervals.delete(handle),
    fire() {
      for (const { fn } of [...intervals.values()]) fn();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function pump(worker, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await settle();
    worker.deliver();
  }
}

function setup({ auto = true, fail = [], ...options } = {}) {
  const worker = new FakeWorker({ auto });
  const fetched = [];
  const timers = fakeTimers();
  let time = T0;
  const sky = createSatSky({
    createWorker: () => worker,
    fetchText: async (path) => {
      fetched.push(path);
      if (fail.includes(path)) throw new Error('HTTP 503');
      if (path === 'active') return FIXTURE;
      if (path === 'stations') return `${HEADER}\r\n${ISS_ROW}\r\n`;
      if (path === 'starlink')
        return [HEADER, ...STARLINK_ROWS, ''].join('\r\n');
      return `${HEADER}\r\n`;
    },
    timers,
    getTime: () => time,
    ...options,
  });
  return {
    worker,
    fetched,
    timers,
    sky,
    setTime: (t) => {
      time = t;
    },
  };
}

const OBS = { latDeg: 29.7604, lonDeg: -95.3698 };

test('start: observer, core groups + active from /api/celestrak (Starlink off), objects with names', async () => {
  const { worker, fetched, sky } = setup();
  assert.equal(sky.start(OBS), true);
  assert.equal(sky.status, 'loading');
  await pump(worker);
  assert.deepEqual(fetched.sort(), [
    'active',
    'galileo',
    'geo',
    'glo-ops',
    'gps-ops',
    'stations',
    'visual',
  ]);
  assert.equal(sky.status, 'ready');
  assert.equal(worker.posted[0].type, 'observer');
  const objects = sky.objectsAt(T0);
  assert.ok(objects.length > 0);
  assert.ok(
    objects.every((o) => o.name && o.elDeg > -2 && o.set !== 'starlink'),
  );
  const iss = sky.meta.find((m) => m.noradId === 25544);
  assert.equal(iss.set, 'core');
  assert.equal(
    sky.stats.age.total,
    sky.meta.filter((m) => m.set !== 'starlink').length,
  );
  assert.ok(sky.stats.durationMs >= 0);
});

test('backlog never exceeds one tick: busy timer ticks are skipped, a forced tick waits', async () => {
  const { worker, timers, sky, setTime } = setup({ auto: false });
  sky.start(OBS);
  assert.equal(worker.ticks().length, 1);
  assert.equal(sky.pending, true);
  for (let i = 0; i < 3; i++) {
    setTime(T0 + (i + 1) * 1000);
    timers.fire();
  }
  assert.equal(worker.ticks().length, 1, 'still one in flight');
  assert.equal(sky.stats.skipped, 3);
  sky.timeChanged(); // forced while busy: remembered
  assert.equal(worker.ticks().length, 1);
  worker.deliver();
  assert.equal(worker.ticks().length, 2, 'forced tick sent on reply');
  assert.ok(sky.stats.maxBacklog <= 1);
  worker.deliver();
  assert.equal(sky.pending, false);
  // a fixed clock that did not move does not tick again
  timers.fire();
  assert.equal(worker.ticks().length, 2);
});

test('Starlink: off by default; on uses the rows already in `active`; without active it fetches the starlink group', async () => {
  const a = setup();
  a.sky.start(OBS);
  await pump(a.worker);
  a.sky.setSets({ starlink: true });
  await pump(a.worker);
  assert.ok(!a.fetched.includes('starlink'));
  const lastTick = a.worker.ticks().at(-1);
  assert.ok(lastTick.sets.includes('starlink'));

  const b = setup({ activeOn: false });
  b.sky.start(OBS);
  await pump(b.worker);
  assert.ok(!b.fetched.includes('active'));
  b.sky.setSets({ starlink: true });
  await pump(b.worker);
  assert.ok(b.fetched.includes('starlink'));

  const c = setup({ starlinkOn: true, fail: ['active'] });
  c.sky.start(OBS);
  await pump(c.worker);
  assert.equal(c.sky.loads.get('active'), 'error');
  assert.ok(c.fetched.includes('starlink'), 'falls back to the starlink group');
  assert.match(c.sky.lastError, /active: HTTP 503/);
});

test('a time jump keeps the old objects until the new tick answers (no blank sky)', async () => {
  const { worker, sky, setTime } = setup({ auto: false });
  sky.start(OBS);
  for (let i = 0; i < 4; i++) {
    await settle();
    worker.deliver();
  }
  await pump(worker);
  const before = sky.objectsAt(T0).length;
  assert.ok(before > 0);
  setTime(T0 + 6 * 3600_000);
  sky.timeChanged();
  assert.equal(sky.objectsAt(T0 + 6 * 3600_000).length, before, 'still drawn');
  worker.deliver();
  assert.equal(sky.stats.timeMs, T0 + 6 * 3600_000);
});

test('switching a set off removes its objects at once', async () => {
  const { worker, sky } = setup({ starlinkOn: true });
  sky.start(OBS);
  await pump(worker);
  const before = sky.objectsAt(T0).length;
  sky.setSets({ active: false, starlink: false });
  const after = sky.objectsAt(T0);
  assert.ok(after.every((o) => o.set === 'core'));
  assert.ok(after.length < before);
});

test('stop terminates the worker and forgets everything; late replies are ignored', async () => {
  const { worker, sky } = setup({ auto: false });
  sky.start(OBS);
  sky.stop();
  assert.equal(worker.terminated, true);
  assert.equal(sky.running, false);
  worker.deliver();
  assert.deepEqual(sky.meta, []);
  assert.deepEqual(sky.objectsAt(T0), []);
  assert.equal(sky.status, 'idle');
});

test('no Worker in this browser: status unavailable, nothing fetched', () => {
  const fetched = [];
  const sky = createSatSky({
    createWorker: () => null,
    fetchText: async (p) => fetched.push(p),
    timers: fakeTimers(),
  });
  assert.equal(sky.start(OBS), false);
  assert.equal(sky.status, 'unavailable');
  assert.deepEqual(fetched, []);
});

test('extrapolation: linear from the two newest samples, wraps azimuth, capped', () => {
  const prev = { timeMs: 0, azDeg: 359, elDeg: 10 };
  const cur = { timeMs: 2000, azDeg: 1, elDeg: 12 };
  assert.deepEqual(extrapolateAzEl(prev, cur, 3000), { azDeg: 2, elDeg: 13 });
  assert.deepEqual(extrapolateAzEl(null, cur, 3000), { azDeg: 1, elDeg: 12 });
  assert.deepEqual(
    extrapolateAzEl(prev, cur, 1000),
    { azDeg: 1, elDeg: 12 },
    'never backwards',
  );
  const far = extrapolateAzEl(prev, cur, 2000 + 10 * MAX_EXTRAPOLATE_MS);
  assert.ok(far.elDeg <= 12 + MAX_EXTRAPOLATE_MS / 1000 + 1e-9);
  const zenith = extrapolateAzEl(
    { timeMs: 0, azDeg: 0, elDeg: 89 },
    { timeMs: 1000, azDeg: 90, elDeg: 89.5 },
    2000,
  );
  assert.equal(zenith.azDeg, 100, 'azimuth step capped at 10 deg');
  assert.deepEqual(
    extrapolateAzEl(
      { timeMs: 0, azDeg: 0, elDeg: 0 },
      { timeMs: 60_000, azDeg: 50, elDeg: 5 },
      61_000,
    ),
    { azDeg: 50, elDeg: 5 },
    'samples too far apart',
  );
});

test('unpackRecords splits a packed tick by set', () => {
  const rec = new Float32Array(2 * RECORD_FIELDS);
  rec.set([3, 10, 20, 500, -1.5, packFlags({ setId: 0, state: 1 })], 0);
  rec.set(
    [9, 30, 40, 900, 2.5, packFlags({ setId: 2, state: 3 })],
    RECORD_FIELDS,
  );
  const bySet = unpackRecords(rec, 1234);
  assert.deepEqual([...bySet.keys()].sort(), ['core', 'starlink']);
  assert.equal(bySet.get('core').get(3).azDeg, 10);
  assert.equal(bySet.get('starlink').get(9).stateName, 'shadow');
  assert.equal(bySet.get('starlink').get(9).timeMs, 1234);
});
