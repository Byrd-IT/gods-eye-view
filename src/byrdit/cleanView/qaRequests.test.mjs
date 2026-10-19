import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRequest,
  classifyWindow,
} from '../../../scripts/qa-map-clear-view-requests.mjs';

test('requests are classified as asset, tile, layer or beacon', () => {
  const o = 'http://127.0.0.1:4391';
  assert.equal(classifyRequest('script', `${o}/src/main.js`), 'asset');
  assert.equal(classifyRequest('xhr', `${o}/cesium/Assets/x.json`), 'asset');
  assert.equal(classifyRequest('fetch', `${o}/logo.svg`), 'asset');
  assert.equal(
    classifyRequest(
      'xhr',
      `${o}/basemap/v/mh1/terrain/cesium-mesh?x=1&y=2&z=3`,
    ),
    'tile',
  );
  assert.equal(
    classifyRequest('image', `https://t.example/a/b.jpg?k=1`),
    'tile',
  );
  assert.equal(classifyRequest('fetch', `${o}/tiles/4/5/6.png`), 'tile');
  assert.equal(
    classifyRequest('fetch', `${o}/api/local-receivers/aircraft`),
    'layer',
  );
  assert.equal(classifyRequest('xhr', `${o}/basemap/health.json`), 'layer');
  assert.equal(
    classifyRequest('ping', `${o}/api/realtime/debug-log`),
    'beacon',
  );
});

const req = (t, cls, ep, id = `${ep}@${t}`) => ({ t, cls, ep, id });

test('a layer request on its earlier cadence is a scheduled poll', () => {
  const all = [
    req(0, 'layer', 'h/api/a'),
    req(10_000, 'layer', 'h/api/a'),
    req(20_000, 'layer', 'h/api/a'),
    req(30_100, 'layer', 'h/api/a'), // inside the window, on schedule
  ];
  const w = classifyWindow(all, 30_000, 34_000);
  assert.deepEqual(w.refetch, []);
  assert.equal(w.polls.length, 1);
});

test('an early, first or one-off layer request in the window is a refetch', () => {
  const all = [
    req(0, 'layer', 'h/api/a'),
    req(10_000, 'layer', 'h/api/a'),
    req(12_000, 'layer', 'h/api/a'), // 2 s after a 10 s poll: early
    req(12_100, 'layer', 'h/api/b'), // never requested before
    req(5_000, 'layer', 'h/api/c'),
    req(12_200, 'layer', 'h/api/c'), // only one earlier request: no cadence
  ];
  const w = classifyWindow(all, 11_000, 15_000);
  assert.deepEqual(w.refetch.map((r) => r.ep).sort(), [
    'h/api/a',
    'h/api/b',
    'h/api/c',
  ]);
});

test('a tile loaded before is a refetch; new tiles are refinement', () => {
  const all = [
    req(0, 'tile', 'h/t', 'tileA'),
    req(5_000, 'tile', 'h/t', 'tileA'), // same URL again
    req(5_100, 'tile', 'h/t', 'tileB'), // new tile
    req(5_200, 'asset', 'h/cesium/w.js'),
  ];
  const w = classifyWindow(all, 4_000, 8_000);
  assert.equal(w.refetch.length, 1);
  assert.equal(w.refetch[0].again, true);
  assert.equal(w.newTiles, 1);
  assert.deepEqual(w.counts, { tile: 2, asset: 1 });
});

test('an empty window has nothing to explain', () => {
  const w = classifyWindow([req(0, 'layer', 'h/api/a')], 1_000, 2_000);
  assert.deepEqual(w, {
    counts: {},
    refetch: [],
    polls: [],
    newTiles: 0,
    total: 0,
  });
});
