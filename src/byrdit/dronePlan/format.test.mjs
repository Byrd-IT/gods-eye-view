import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalog } from '../../i18n/index.js';
import { setUnitSystem } from './units.js';
import {
  batteryPauseLabel,
  distanceText,
  durationText,
  heightText,
  lengthText,
  planErrorText,
  speedText,
  speedWithMphText,
  warningText,
  warningTone,
} from './format.js';

// The sentences below were written in metres; feet have their own tests.
setUnitSystem('m');

const CODES = [
  ['agl-capped', { requested: 200, cap: 120 }],
  ['agl-above-400ft', { maxAglM: 300, capM: 457.2 }],
  ['speed-camera-limited', { requested: 5, limited: 4 }],
  ['speed-exceeds-camera-limit', { requested: 15, limited: 4.2 }],
  ['speed-exceeds-blur-limit', { requested: 12, limited: 3.5, shutter: 500 }],
  ['line-end-split', { count: 3, maxWaypoints: 20 }],
  ['vlos', { distanceM: 640 }],
  ['terrain-unknown', {}],
  ['rel-height-over-limit', { maxRelM: 160, limitM: 120, terrainRangeM: 60 }],
  ['below-takeoff', { minRelM: 0.5 }],
  ['steep-segment', { count: 3 }],
  ['terrain-partial', { count: 3 }],
  ['mission-over-budget', {}],
  ['too-many-missions', { count: 60 }],
  ['takeoff-too-far', { distanceM: 2500, limitM: 1000 }],
];

test('every warning code has a sentence with its numbers filled in', () => {
  for (const [code, params] of CODES) {
    const text = warningText({ code, params });
    assert.ok(text.length > 10, code);
    assert.doesNotMatch(
      text,
      /\{[a-z]+\}/i,
      `${code} left a placeholder: ${text}`,
    );
  }
  assert.match(
    warningText({ code: 'agl-capped', params: { requested: 200, cap: 120 } }),
    /capped at 120 m above ground; you asked for 200 m/,
  );
  assert.match(
    warningText({ code: 'vlos', params: { distanceM: 640 } }),
    /640 m/,
  );
  const high = warningText({
    code: 'agl-above-400ft',
    params: { maxAglM: 300, capM: 457.2 },
  });
  assert.match(high, /up to 300 m above ground, higher than 400 ft/);
  assert.match(high, /457 m is only the most GEV will plan/);
  assert.match(
    high,
    /does not approve a flight and changes no limit in the aircraft/,
  );
  assert.match(
    high,
    /airspace authorization, local rules and your duties as pilot still apply/,
  );
  assert.equal(warningText({ code: 'mystery', params: {} }), '');
  assert.equal(warningTone('speed-exceeds-camera-limit'), 'bad');
  assert.equal(warningTone('speed-exceeds-blur-limit'), 'bad');
  assert.equal(warningTone('line-end-split'), 'warn');
  assert.equal(warningTone('vlos'), '');
  assert.match(
    warningText({
      code: 'speed-exceeds-camera-limit',
      params: { requested: 15, limited: 4 },
    }),
    /stays at 15\.0 m\/s, above the camera limit of 4\.0 m\/s/,
  );
  assert.match(
    warningText({
      code: 'speed-exceeds-blur-limit',
      params: { requested: 12, limited: 3.5, shutter: 500 },
    }),
    /1\/500 s shutter/,
  );
  assert.match(
    warningText({
      code: 'line-end-split',
      params: { count: 3, maxWaypoints: 20 },
    }),
    /split 3 times.*20 waypoints/,
  );
  assert.equal(
    batteryPauseLabel({ index: 2, groundM: 1234, durationS: 12 * 60 }),
    'Pause 2: 1.23 km · 12 min',
  );
});

test('warning sentences are translated in every catalog', () => {
  for (const locale of ['es', 'ru', 'zh-CN']) {
    const catalog = getCatalog(locale);
    for (const key of [
      'The box is too small to plan a flight',
      'Draw a box on the globe first',
      'A mission is longer than the battery time even after splitting',
    ]) {
      assert.ok(catalog[key] && catalog[key] !== key, `${locale}: ${key}`);
    }
  }
});

test('plan errors map to their own sentence', () => {
  assert.match(planErrorText('too-large'), /Too many waypoints/);
  assert.match(planErrorText('empty'), /too small/);
  assert.match(planErrorText('bad-box'), /Draw a box/);
});

test('number formatting', () => {
  assert.equal(heightText(120), '120 m');
  assert.equal(heightText(80), '80 m');
  assert.equal(distanceText(640), '640 m');
  assert.equal(distanceText(1234), '1.23 km');
  assert.equal(durationText(14 * 60), '14 min');
  assert.equal(durationText(65 * 60), '1 h 05 min');
});

test('speedWithMphText gives the unit chosen and miles per hour (15 mph = 6.7056 m/s)', () => {
  assert.equal(speedWithMphText(6.7056), '6.7 m/s · 15.0 mph');
  assert.equal(speedWithMphText(7.15264), '7.2 m/s · 16.0 mph');
  setUnitSystem('ft');
  try {
    // In the feet system the speed is shown as mph only, not ft/s.
    assert.equal(speedWithMphText(6.7056), '15.0 mph');
    // 15 ft/s is NOT 15 mph: it is about 10.2 mph.
    assert.equal(speedWithMphText(15 * 0.3048), '10.2 mph');
    // Metric behaviour is unchanged.
  } finally {
    setUnitSystem('m');
  }
  assert.equal(speedWithMphText(6.7056), '6.7 m/s · 15.0 mph');
});

test('feet: every length, speed and warning is in the chosen unit', () => {
  setUnitSystem('ft');
  try {
    assert.equal(heightText(120), '394 ft');
    assert.equal(lengthText(80), '262 ft');
    assert.equal(lengthText(1.5, 1), '4.9 ft');
    assert.equal(speedText(5), '11.2 mph');
    assert.equal(speedText(5, 2), '11.18 mph');
    assert.equal(distanceText(640), '2,100 ft');
    assert.equal(distanceText(2000), '1.24 mi');
    assert.match(
      warningText({ code: 'agl-capped', params: { requested: 200, cap: 120 } }),
      /capped at 394 ft above ground; you asked for 656 ft/,
    );
    assert.match(
      warningText({
        code: 'speed-camera-limited',
        params: { requested: 5, limited: 4 },
      }),
      /from 11\.2 mph to 8\.9 mph/,
    );
    for (const [code, params] of CODES) {
      const text = warningText({ code, params });
      assert.doesNotMatch(
        text,
        /\d\s?m\b(?!i)/,
        `${code} still says metres: ${text}`,
      );
      assert.doesNotMatch(text, /m\/s/, `${code} still says m/s: ${text}`);
    }
  } finally {
    setUnitSystem('m');
  }
});
