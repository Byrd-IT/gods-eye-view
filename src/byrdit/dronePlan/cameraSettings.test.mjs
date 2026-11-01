import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedShutter,
  cameraChecklistLines,
  cameraPresetOrDefault,
  evText,
  shutterForPreset,
  DEFAULT_CAMERA_PRESET_ID,
} from './cameraSettings.js';

test('default preset is the 50 MP 4:3 mapping preset', () => {
  const p = cameraPresetOrDefault('nope');
  assert.equal(p.id, DEFAULT_CAMERA_PRESET_ID);
  assert.deepEqual([p.width, p.height, p.minShutterDenominator, p.ev], [8192, 6144, 500, -0.7]);
});
test('shutter is never slower than the preset; EV text', () => {
  const p = cameraPresetOrDefault('mapping-50mp');
  assert.equal(shutterForPreset(p, 250), 500);
  assert.equal(shutterForPreset(p, 2000), 2000);
  assert.equal(allowedShutter(500), 500);
  assert.equal(evText(-0.7), '-0.7');
  assert.equal(evText(0), '0');
});
test('checklist lines carry every setting', () => {
  const text = cameraChecklistLines('test-12mp', 1000).join('\n');
  for (const m of [/12 MP, 4:3 \(4096 x 3072\)/, /1\/1000 s or faster/, /fixed \(not auto\)/, /-0\.7/, /4096 x 3072\./])
    assert.match(text, m);
});
