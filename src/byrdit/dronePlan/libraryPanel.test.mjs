import test from 'node:test';
import assert from 'node:assert/strict';

import { warningText, displayLegacySpeedNotes } from './libraryPanel.js';
import { setUnitSystem, speedUnit, DEFAULT_UNIT_SYSTEM } from './units.js';

test.afterEach(() => setUnitSystem(DEFAULT_UNIT_SYSTEM));

test('the DJI speed-limit warning shows mph in the feet system', () => {
  setUnitSystem('ft');
  const text = warningText({ code: 'speed-range', args: { max: 15 } });
  assert.match(text, /33\.6 mph/);
  assert.ok(!text.includes('m/s'), text);
});

test('the DJI speed-limit warning shows m/s in the metric system', () => {
  setUnitSystem('m');
  assert.equal(speedUnit(), 'm/s');
  const text = warningText({ code: 'speed-range', args: { max: 15 } });
  assert.match(text, /15\.0 m\/s/);
});

test('legacy automatically generated notes show mph without changing other text', () => {
  const old =
    'Pilot note: 5 m/s.\nPlanned by GEV: 5 waypoints, 5 photos, 1 mission, speed 3.00 m/s.';
  assert.equal(
    displayLegacySpeedNotes(old, 'ft'),
    'Pilot note: 5 m/s.\nPlanned by GEV: 5 waypoints, 5 photos, 1 mission, speed 6.71 mph (3.00 m/s).',
  );
  assert.equal(displayLegacySpeedNotes(old, 'm'), old);
  assert.equal(
    displayLegacySpeedNotes('Free-form speed 3.00 m/s.'),
    'Free-form speed 3.00 m/s.',
  );
});

test('other DJI findings keep their sentences', () => {
  const text = warningText({
    code: 'drone-mismatch',
    args: { found: '3-1110', model: 'Mini 5 Pro', expected: '3-110' },
  });
  assert.match(text, /aircraft code 3-1110/);
  assert.match(text, /Mini 5 Pro/);
});
