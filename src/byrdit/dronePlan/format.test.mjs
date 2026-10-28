import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalog } from '../../i18n/index.js';
import {
  distanceText,
  durationText,
  heightText,
  planErrorText,
  warningText,
} from './format.js';

const CODES = [
  ['agl-capped', { requested: 200, cap: 120 }],
  ['speed-camera-limited', { requested: 5, limited: 4 }],
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
    /120 m \(394 ft\)/,
  );
  assert.match(
    warningText({ code: 'vlos', params: { distanceM: 640 } }),
    /640 m/,
  );
  assert.equal(warningText({ code: 'mystery', params: {} }), '');
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
  assert.equal(heightText(120), '120 m · 394 ft');
  assert.equal(heightText(80), '80 m · 262 ft');
  assert.equal(distanceText(640), '640 m');
  assert.equal(distanceText(1234), '1.23 km');
  assert.equal(durationText(14 * 60), '14 min');
  assert.equal(durationText(65 * 60), '1 h 05 min');
});
