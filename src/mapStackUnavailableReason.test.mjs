import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MapStackController,
  photorealUnavailableReason,
} from './mapStackController.js';

test('missing photoreal credentials ask for the Google key, not a Cesium ion route', () => {
  assert.match(
    photorealUnavailableReason(false),
    /Needs GOOGLE_MAPS_API_KEY.*Provider Settings/,
  );
  assert.doesNotMatch(photorealUnavailableReason(false), /Cesium ion/);
});

test('a configured but failed photoreal route does not ask for another key', () => {
  const reason = photorealUnavailableReason(true);
  assert.match(reason, /unavailable.*restrictions, quota, or network/);
  assert.doesNotMatch(reason, /Needs|add it/);
});

test('controller credential detection needs the Google key; an ion token never counts', () => {
  const hasCredentials = MapStackController.prototype._hasPhotorealCredentials;
  assert.equal(hasCredentials.call({ _googleKeyPresent: true }), true);
  assert.equal(hasCredentials.call({ _googleKeyPresent: false }), false);
  assert.equal(hasCredentials.call({ cesiumToken: 'configured' }), false);
});
