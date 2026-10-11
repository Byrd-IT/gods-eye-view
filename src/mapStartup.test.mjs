import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPhotorealisticTileset,
  selectMapStartupRoute,
} from './mapStartup.js';

function fakeCesium(outcomes = []) {
  const calls = [];
  const next = () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return {
    calls,
    Ion: { defaultAccessToken: undefined },
    GoogleMaps: {
      defaultApiKey: undefined,
      mapTilesApiEndpoint: 'https://tile.googleapis.com/',
      getDefaultCredit: () => undefined,
    },
    Resource: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    async createGooglePhotorealistic3DTileset(options) {
      calls.push({ options, googleKey: options.key });
      return next();
    },
    IonResource: {
      async fromAssetId(assetId, options) {
        return { assetId, ...options };
      },
    },
    Cesium3DTileset: {
      async fromUrl(resource, options) {
        calls.push({
          options,
          resource,
          ionToken: resource.accessToken,
          assetId: resource.assetId,
        });
        return next();
      },
    },
  };
}

test('map startup route is Google direct with our key, otherwise the non-Google globe', () => {
  assert.equal(
    selectMapStartupRoute({
      googleApiKey: 'google-secret',
      cesiumToken: 'ion',
    }),
    'google-direct',
  );
  // A Cesium ion token alone must never select Google 3D.
  assert.equal(selectMapStartupRoute({ cesiumToken: 'ion' }), 'osm');
  assert.equal(selectMapStartupRoute(), 'osm');
});

test('no credentials skip photoreal loading and preserve keyless startup', async () => {
  const Cesium = fakeCesium();
  const result = await loadPhotorealisticTileset(Cesium);
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(Cesium.calls.length, 0);
});

test('a direct Google key loads Google 3D on our key, ignoring any ion token', async () => {
  const tileset = { id: 'direct' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-direct');
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
});

test('an ion-only setup does NOT load Google 3D through ion', async () => {
  const Cesium = fakeCesium([{ id: 'must-not-load' }]);
  const result = await loadPhotorealisticTileset(Cesium, {
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(Cesium.calls.length, 0);
});

test('a failed direct request never falls back to the ion Google asset', async () => {
  const Cesium = fakeCesium([new Error('direct denied'), { id: 'ion' }]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls.length, 1);
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(
    Cesium.calls.some((call) => call.assetId === 2275207),
    false,
  );
});

test('a failed direct-only request does not consume an implicit Cesium token', async () => {
  const Cesium = fakeCesium([new Error('direct denied')]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls.length, 1);
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(Cesium.GoogleMaps.defaultApiKey, undefined);
});

test('the attempt list never contains google-ion, whatever is configured', async () => {
  for (const credentials of [
    { googleApiKey: 'g', cesiumToken: 'ion' },
    { googleApiKey: 'g' },
    { cesiumToken: 'ion' },
    { googleTokens: tokenSource('t'), cesiumToken: 'ion' },
    {},
  ]) {
    // Every attempt fails so every route in the list is exercised and reported.
    const Cesium = fakeCesium([new Error('a'), new Error('b'), new Error('c')]);
    const result = await loadPhotorealisticTileset(Cesium, credentials);
    assert.notEqual(result.route, 'google-ion');
    assert.equal(result.tileset, null);
    assert.equal(result.route, 'osm');
    assert.equal(
      Cesium.calls.some((call) => call.assetId === 2275207),
      false,
    );
  }
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./maps/google3d.js', import.meta.url), 'utf8'),
  );
  assert.equal(src.includes('2275207'), false);
  assert.equal(src.includes("'google-ion'"), false);
});

test('independent source configurations never mutate shared SDK credentials', async () => {
  const Cesium = fakeCesium([{ id: 'a' }]);
  Cesium.Ion.defaultAccessToken = 'untouched-ion';
  Cesium.GoogleMaps.defaultApiKey = 'untouched-google';
  await loadPhotorealisticTileset(Cesium, { googleApiKey: 'source-a' });
  assert.equal(Cesium.calls[0].googleKey, 'source-a');
  assert.equal(Cesium.Ion.defaultAccessToken, 'untouched-ion');
  assert.equal(Cesium.GoogleMaps.defaultApiKey, 'untouched-google');
});

function tokenSource(...issued) {
  const requests = [];
  return {
    requests,
    async token(options = {}) {
      requests.push(options);
      return issued.shift() ?? null;
    },
  };
}

test('without a key, server tokens load Google 3D directly', async () => {
  const tileset = { id: 'token' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleTokens: tokenSource('short-lived'),
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-token');
  const { resource, options } = Cesium.calls[0];
  assert.equal(
    resource.url,
    'https://tile.googleapis.com/v1/3dtiles/root.json',
  );
  assert.equal(resource.headers.Authorization, 'Bearer short-lived');
  assert.equal(resource.queryParameters, undefined);
  assert.equal(options.enableCollision, true);
});

test('a tile refused for an expired token retries once with a renewed one', async () => {
  const Cesium = fakeCesium([{ id: 'token' }]);
  const tokens = tokenSource('first', 'second');
  await loadPhotorealisticTileset(Cesium, { googleTokens: tokens });
  const { resource } = Cesium.calls[0];
  const tile = { headers: { ...resource.headers } };
  assert.equal(await resource.retryCallback(tile, { statusCode: 401 }), true);
  assert.equal(tile.headers.Authorization, 'Bearer second');
  assert.deepEqual(tokens.requests.at(-1), { replacing: 'first' });
  assert.equal(resource.retryAttempts, 1);
  assert.equal(await resource.retryCallback(tile, { statusCode: 500 }), false);
});

test('a key takes precedence over server tokens', async () => {
  const Cesium = fakeCesium([{ id: 'direct' }]);
  const tokens = tokenSource('short-lived');
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    googleTokens: tokens,
  });
  assert.equal(result.route, 'google-direct');
  assert.equal(tokens.requests.length, 0);
});

test('a server without tokens falls back to the non-Google globe, not ion', async () => {
  const Cesium = fakeCesium([{ id: 'ion' }]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleTokens: tokenSource(),
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls.length, 0);
});
