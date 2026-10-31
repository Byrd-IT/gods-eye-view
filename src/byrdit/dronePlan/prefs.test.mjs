import assert from 'node:assert/strict';
import test from 'node:test';
import { ALPHA_RANGE, DEFAULT_ALPHA } from './checkLayer.js';
import {
  ALPHA_STORAGE_KEY,
  DEFAULT_STEPS_OPEN,
  STEPS_STORAGE_KEY,
  STEP_KEYS,
  readAlpha,
  readStepsOpen,
  writeAlpha,
  writeStepsOpen,
} from './prefs.js';

const memory = (initial) => {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
};

test("transparency defaults are today's values", () => {
  assert.deepEqual(DEFAULT_ALPHA, {
    zone: 0.16,
    curtain: 0.1,
    footprint: 0.05,
    view: 0.2,
  });
  assert.deepEqual(readAlpha(memory()), { ...DEFAULT_ALPHA });
});

test('transparency: saved levels come back, clamped, per layer', () => {
  const store = memory();
  assert.equal(
    writeAlpha(store, { ...DEFAULT_ALPHA, footprint: 0.3, zone: 0 }),
    true,
  );
  const back = readAlpha(store);
  assert.equal(back.footprint, 0.3);
  assert.equal(back.zone, 0);
  assert.equal(back.curtain, 0.1);
  assert.equal(back.view, 0.2);
  store.setItem(
    ALPHA_STORAGE_KEY,
    JSON.stringify({ zone: 9, curtain: -3, view: 'x', footprint: null }),
  );
  const clamped = readAlpha(store);
  assert.equal(clamped.zone, ALPHA_RANGE.zone.max);
  assert.equal(clamped.curtain, 0);
  assert.equal(clamped.view, DEFAULT_ALPHA.view);
  assert.equal(clamped.footprint, DEFAULT_ALPHA.footprint);
});

test('transparency and steps: junk or a blocked store gives the defaults', () => {
  for (const raw of ['not json', '[1,2]', '"x"', 'null', '']) {
    const store = memory({
      [ALPHA_STORAGE_KEY]: raw,
      [STEPS_STORAGE_KEY]: raw,
    });
    assert.deepEqual(readAlpha(store), { ...DEFAULT_ALPHA });
    assert.deepEqual(readStepsOpen(store), { ...DEFAULT_STEPS_OPEN });
  }
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readAlpha(broken), { ...DEFAULT_ALPHA });
  assert.deepEqual(readStepsOpen(broken), { ...DEFAULT_STEPS_OPEN });
  assert.equal(writeAlpha(broken, DEFAULT_ALPHA), false);
  assert.equal(writeStepsOpen(broken, DEFAULT_STEPS_OPEN), false);
});

test('steps: nine keys, remembered open state wins over the defaults', () => {
  assert.equal(STEP_KEYS.length, 9);
  const store = memory();
  writeStepsOpen(store, { ...DEFAULT_STEPS_OPEN, flight: true, area: false });
  const back = readStepsOpen(store);
  assert.equal(back.flight, true);
  assert.equal(back.area, false);
  assert.equal(back.plan, DEFAULT_STEPS_OPEN.plan);
});
