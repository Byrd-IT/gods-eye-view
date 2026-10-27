import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_EVENT, createHistoryProvider } from './historyTime.js';

const HT = Date.parse('2026-10-05T21:00:00Z');

/**
 * A fake History control with the B11 shape (DESIGN.md 4.5): it owns `ht`,
 * plays at its own speeds, can seek, and (B12) hands out GP element sets.
 */
function fakeHistoryControl() {
  const listeners = new Set();
  const control = {
    state: { active: false, timeMs: HT, playing: false, rate: 60 },
    seeks: [],
    getState() {
      return {
        ...control.state,
        seek: (ms) => {
          control.seeks.push(ms);
          control.set({ timeMs: ms });
        },
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(patch) {
      Object.assign(control.state, patch);
      for (const fn of [...listeners]) fn();
    },
  };
  return control;
}

test('object control: inactive -> null time; active -> ht; seek goes to the control', () => {
  const control = fakeHistoryControl();
  const provider = createHistoryProvider({ control, now: () => 0 });
  assert.equal(provider.active, false);
  assert.equal(provider.getTime(), null);
  const seen = [];
  provider.subscribe(() => seen.push(provider.active));
  control.set({ active: true });
  assert.equal(provider.active, true);
  assert.equal(provider.getTime(), HT);
  assert.equal(provider.canSeek, true);
  assert.equal(provider.seek(HT + 60_000), true);
  assert.deepEqual(control.seeks, [HT + 60_000]);
  assert.equal(provider.getTime(), HT + 60_000);
  assert.deepEqual(seen, [true, true]);
  control.set({ active: false });
  assert.equal(provider.seek(HT), false, 'no seek while History is off');
});

test('object control playing: time advances between updates at the History rate', () => {
  let wall = 1000;
  const control = fakeHistoryControl();
  const provider = createHistoryProvider({ control, now: () => wall });
  control.set({ active: true, playing: true, rate: 600 });
  assert.equal(provider.playing, true);
  assert.equal(provider.rate, 600);
  wall += 2000;
  assert.equal(provider.getTime(), HT + 1_200_000);
  control.set({ playing: false });
  assert.equal(provider.getTime(), HT, 'paused: the control time');
});

test('a control getTime() is authoritative when it has one', () => {
  const control = fakeHistoryControl();
  control.getTime = () => HT + 5;
  const provider = createHistoryProvider({ control, now: () => 0 });
  control.set({ active: true, playing: true });
  assert.equal(provider.getTime(), HT + 5);
});

test('window event hook (B11): gev:history-time detail drives the provider; destroy removes the listener', () => {
  const target = new EventTarget();
  let wall = 0;
  const provider = createHistoryProvider({ target, now: () => wall });
  let calls = 0;
  provider.subscribe(() => calls++);
  const send = (detail) =>
    target.dispatchEvent(Object.assign(new Event(HISTORY_EVENT), { detail }));
  send({ active: true, timeMs: HT, playing: true, rate: 10 });
  wall = 3000;
  assert.equal(provider.getTime(), HT + 30_000);
  send({ active: true, timeMs: HT + 1, playing: false, rate: 10 });
  assert.equal(provider.getTime(), HT + 1);
  assert.equal(calls, 2);
  provider.destroy();
  send({ active: false });
  assert.equal(provider.active, true, 'no events after destroy');
});

test('History unavailable (error) or no time -> inactive, Sky keeps its own clock', () => {
  const target = new EventTarget();
  const provider = createHistoryProvider({ target });
  const send = (detail) =>
    target.dispatchEvent(Object.assign(new Event(HISTORY_EVENT), { detail }));
  send({ active: true, timeMs: HT, error: 'history unavailable' });
  assert.equal(provider.active, false);
  assert.equal(provider.error, 'history unavailable');
  send({ active: true, timeMs: 'not a time' });
  assert.equal(provider.active, false);
});

test('satellite elements nearest t (B12 hook): source per time, null when absent or broken', async () => {
  const control = fakeHistoryControl();
  control.getState = () => ({
    ...control.state,
    satelliteSource: (t) => ({
      key: new Date(t).toISOString().slice(0, 10),
      fetchText: async (path) => `gp ${path} @ ${t}`,
    }),
  });
  const provider = createHistoryProvider({ control });
  assert.equal(provider.satelliteSourceAt(HT), null, 'inactive: none');
  control.set({ active: true });
  const src = provider.satelliteSourceAt(HT);
  assert.equal(src.key, '2026-10-05');
  assert.equal(await src.fetchText('stations'), `gp stations @ ${HT}`);
  control.getState = () => ({
    ...control.state,
    satelliteSource: () => {
      throw new Error('boom');
    },
  });
  control.set({});
  assert.equal(provider.satelliteSourceAt(HT), null);
});
