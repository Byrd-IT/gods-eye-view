// Byrd-IT fork (upstream merge t_d7f5ae4c): upstream e5eac0c7 fetches the
// ion Bing endpoint document itself. With the fork's server-managed ion token
// that request must go to this app's /api/ion/ and carry no token at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createIonImagery } from '../maps/imagery.js';
import { ION_SERVER_MANAGED } from './serverKeys.js';

test('server-managed ion: Bing endpoint document comes from /api/ion/ with no token', async (t) => {
  const metadataCalls = [];
  t.mock.method(Cesium.Resource.prototype, 'fetchJson', async function () {
    metadataCalls.push({ url: this.url, query: { ...this.queryParameters } });
    return {
      type: 'IMAGERY',
      externalType: 'BING',
      options: { url: 'https://dev.virtualearth.net', key: 'ion-issued-bing' },
      attributions: [],
    };
  });
  t.mock.method(Cesium.IonImageryProvider, 'fromAssetId', () =>
    assert.fail('Bing styles use the HTTPS Bing path'),
  );
  t.mock.method(Cesium.BingMapsImageryProvider, 'fromUrl', async () => ({
    getTileCredits: () => [],
  }));
  for (const style of [
    Cesium.IonWorldImageryStyle.AERIAL,
    Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
  ]) {
    await createIonImagery(style, ION_SERVER_MANAGED);
    const { url, query } = metadataCalls.at(-1);
    const requested = new URL(url);
    assert.equal(requested.origin, 'http://localhost');
    assert.equal(requested.pathname, `/api/ion/v1/assets/${style}/endpoint`);
    assert.equal('access_token' in query, false, 'no token leaves the page');
    assert.ok(!url.includes(ION_SERVER_MANAGED), 'the marker is not sent');
  }
});

test('server-managed ion: other imagery styles keep the SDK factory on /api/ion/', async (t) => {
  const calls = [];
  t.mock.method(Cesium.IonImageryProvider, 'fromAssetId', (id, options) => {
    calls.push({ id, options });
    return {};
  });
  await createIonImagery(Cesium.IonWorldImageryStyle.ROAD, ION_SERVER_MANAGED);
  assert.deepEqual(calls, [
    {
      id: Cesium.IonWorldImageryStyle.ROAD,
      options: { accessToken: '', server: 'http://localhost/api/ion/' },
    },
  ]);
});
