import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';
import { globeMapEngine } from '../../maps/globeEngine.js';
import { createGoogleSession } from './googleSession.js';
import {
  loadGooglePortHandle,
  releaseGooglePortHandle,
} from './googleHandle.js';

function scene(capabilities = ['photoreal']) {
  const renderer = createStubRenderer({ capabilities });
  const host = {};
  bindRenderer(host, renderer);
  return { host, renderer };
}

const photorealCalls = (renderer) =>
  renderer.testing.calls.filter(
    (call) => call.port === 'globe' && call.member === 'setPhotoreal',
  );

test('Google 3D loads as a globe-port handle the map stack can switch', async () => {
  const { host, renderer } = scene();
  const loaded = await loadGooglePortHandle(host, { googleApiKey: 'key' });
  const handle = loaded.tileset;
  assert.ok(handle, 'a handle, not null');
  // The fields upstream's switch (applyPhotoreal) reads: a Cesium tileset
  // built beside the port has no `globe`, and the switch threw on it.
  assert.equal(typeof handle.globe?.setPhotoreal, 'function');
  assert.equal(handle.spec.provider, 'google');
  assert.equal(handle.spec.key, 'key');
  assert.equal(handle.spec.fallback, false, 'no ion fallback for Google 3D');
  assert.equal(globeMapEngine.tilesetShown(handle), true);
  assert.equal(photorealCalls(renderer).length, 1);
});

test('the fork `show` flag switches through the engine and reads its state', async () => {
  const { host, renderer } = scene();
  const { tileset: handle } = await loadGooglePortHandle(host, {
    googleApiKey: 'key',
  });
  const spec = photorealCalls(renderer)[0].args[0];
  handle.show = false;
  assert.equal(handle.show, false);
  assert.equal(photorealCalls(renderer).at(-1).args[0], null, 'parked');
  await globeMapEngine.tilesetReady(handle);
  handle.show = true;
  assert.equal(handle.show, true);
  // The same spec object again: the renderer unparks the kept tileset, so
  // a hide and show costs no new Google root request.
  assert.equal(photorealCalls(renderer).at(-1).args[0], spec);
  // The controller's own switch is seen by the fork flag too.
  globeMapEngine.showTileset(handle, false);
  assert.equal(handle.show, false);
});

test('no credentials or no photoreal in the renderer gives no handle', async () => {
  const { host } = scene();
  assert.equal((await loadGooglePortHandle(host, {})).tileset, null);
  const bare = scene([]);
  const none = await loadGooglePortHandle(bare.host, { googleApiKey: 'key' });
  assert.equal(none.tileset, null);
  assert.equal(none.route, 'none');
});

test('the lazy Google session keeps the handle and hides it on attach', async () => {
  const { host, renderer } = scene();
  const session = createGoogleSession({
    hasCredentials: true,
    load: () => loadGooglePortHandle(host, { googleApiKey: 'key' }),
    attach: (handle) => {
      handle.show = false;
    },
    detach: (handle) => releaseGooglePortHandle(host, handle),
  });
  const handle = await session.ensure();
  assert.equal(session.tileset, handle);
  assert.equal(handle.show, false, 'attached hidden until the stack shows it');
  session.destroy();
  assert.equal(globeMapEngine.isDestroyed(handle), true, 'released');
  const count = photorealCalls(renderer).length;
  handle.show = true;
  assert.equal(photorealCalls(renderer).length, count, 'never shown again');
});
