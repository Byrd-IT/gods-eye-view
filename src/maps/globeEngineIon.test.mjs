import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ionEndpointUrl } from './globeEngine.js';
import { ION_SERVER_MANAGED } from '../byrdit/serverKeys.js';

// Byrd-IT: the server-managed ion marker must never reach api.cesium.com as a
// token (ion answers 401 "Invalid access token" and every map stack with
// world terrain refuses to switch).
test('the server-managed marker asks this app’s ion stand-in, with no token', () => {
  const url = new URL(ionEndpointUrl(1, ION_SERVER_MANAGED));
  assert.equal(url.pathname, '/api/ion/v1/assets/1/endpoint');
  assert.notEqual(url.hostname, 'api.cesium.com');
  assert.equal(url.searchParams.has('access_token'), false);
  assert.equal(String(url).includes(ION_SERVER_MANAGED), false);
});

test('an explicit token still goes to Cesium ion with that token', () => {
  const url = new URL(ionEndpointUrl(2, 'explicit-test-token'));
  assert.equal(url.origin, 'https://api.cesium.com');
  assert.equal(url.pathname, '/v1/assets/2/endpoint');
  assert.equal(url.searchParams.get('access_token'), 'explicit-test-token');
});
