import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_UNIT_SYSTEM,
  FT_PER_M,
  MPH_PER_MS,
  UNITS_STORAGE_KEY,
  browserStorage,
  getUnitSystem,
  lengthFromM,
  lengthToM,
  lengthUnit,
  normalizeUnitSystem,
  readUnitSystem,
  setUnitSystem,
  sliderRange,
  speedFromMs,
  speedMphFromMs,
  speedMphToMs,
  speedToMs,
  speedUnit,
  writeUnitSystem,
} from './units.js';

const memory = (initial) => {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
};

test('feet are the default and anything unknown falls back to them', () => {
  assert.equal(DEFAULT_UNIT_SYSTEM, 'ft');
  for (const v of [undefined, null, '', 'yards', 5, {}]) {
    assert.equal(normalizeUnitSystem(v), 'ft');
  }
  assert.equal(normalizeUnitSystem('m'), 'm');
});

test('conversion: 1 ft is exactly 0.3048 m and the round trip comes back', () => {
  assert.equal(FT_PER_M, 1 / 0.3048);
  assert.ok(Math.abs(lengthFromM(0.3048, 'ft') - 1) < 1e-12);
  assert.equal(lengthFromM(80, 'm'), 80);
  assert.equal(lengthToM(262.5, 'm'), 262.5);
  // A whole-foot height typed in feet maps to centimetre metres...
  assert.equal(lengthToM(100, 'ft'), 30.48);
  // ...and every metre value used by the planner survives m -> ft -> m
  // to the centimetre.
  for (let m = 0; m <= 500; m += 0.25) {
    assert.ok(
      Math.abs(lengthToM(lengthFromM(m, 'ft'), 'ft') - m) <= 0.005 + 1e-9,
      `${m} m`,
    );
  }
  // 15 mph is 6.7056 m/s: display mph converts back to internal metres/second
  // to the millimetre per second.
  assert.equal(speedToMs(15, 'ft'), 6.706);
  assert.equal(speedToMs(10, 'm'), 10);
  // speedFromMs/speedToMs are the DISPLAY converters: mph in the feet system.
  assert.equal(speedToMs(speedFromMs(6.7056, 'ft'), 'ft'), 6.706);
  assert.deepEqual(speedFromMs(6.7056, 'ft'), speedMphFromMs(6.7056));
  assert.ok(Math.abs(speedMphFromMs(6.7056) - 15) < 1e-9);
  assert.equal(speedMphToMs(speedMphFromMs(2.2352), 'ft'), 2.235);
  // Metric stays m/s with no mph conversion at all.
  assert.equal(speedToMs(5, 'm'), 5);
  assert.equal(speedFromMs(5, 'm'), 5);
  // The pure m/s <-> mph converters do not look at the display system.
  assert.ok(Math.abs(speedMphFromMs(5) - 5 * MPH_PER_MS) < 1e-12);
  assert.equal(speedMphToMs(5), 2.235);
});

test('labels follow the current system', () => {
  assert.equal(lengthUnit('ft'), 'ft');
  assert.equal(lengthUnit('m'), 'm');
  // Speed display is mph in the feet system: the ft/s label is gone.
  assert.equal(speedUnit('ft'), 'mph');
  assert.equal(speedUnit('m'), 'm/s');
  setUnitSystem('m');
  assert.equal(getUnitSystem(), 'm');
  assert.equal(lengthUnit(), 'm');
  assert.equal(setUnitSystem('nonsense'), 'ft');
  assert.equal(lengthUnit(), 'ft');
});

test('slider ranges in feet stay inside the metre range, on the foot step', () => {
  const spec = { minM: 10, maxM: 300, stepM: 5, stepFt: 10 };
  assert.deepEqual(sliderRange(spec, 'm'), { min: 10, max: 300, step: 5 });
  const ft = sliderRange(spec, 'ft');
  assert.equal(ft.step, 10);
  assert.ok(ft.min % 10 === 0 && ft.max % 10 === 0);
  assert.ok(lengthToM(ft.min, 'ft') >= 10 - 0.01);
  assert.ok(lengthToM(ft.max, 'ft') <= 300 + 0.01);
  const speed = sliderRange(
    { minM: 1, maxM: 15, stepM: 0.1, stepFt: 0.5, kind: 'speed' },
    'ft',
  );
  assert.ok(speedToMs(speed.min, 'ft') >= 1 - 0.01);
  assert.ok(speedToMs(speed.max, 'ft') <= 15 + 0.01);
});

test('the choice is remembered, and a broken store never throws', () => {
  const store = memory();
  assert.equal(readUnitSystem(store), 'ft');
  assert.equal(writeUnitSystem(store, 'm'), true);
  assert.equal(store.getItem(UNITS_STORAGE_KEY), 'm');
  assert.equal(readUnitSystem(store), 'm');
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readUnitSystem(broken), 'ft');
  assert.equal(writeUnitSystem(broken, 'm'), false);
  assert.equal(readUnitSystem(null), 'ft');
  assert.equal(browserStorage({}), null);
  assert.equal(
    browserStorage({
      get localStorage() {
        throw new Error('denied');
      },
    }),
    null,
  );
});
