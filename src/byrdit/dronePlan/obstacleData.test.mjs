import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LOOKUP_BOXES,
  buildingObstacles,
  fetchOpenObstacles,
  lookupBoxes,
} from './obstacleData.js';
import { createObstacleLayer, OBSTACLE_POINTER_OWNER } from './obstacleLayer.js';
import {
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';

const AREA = {
  id: 'a1',
  kind: 'box',
  box: { west: -95.02, south: 32.58, east: -94.99, north: 32.6 },
};

const faaRow = {
  id: 'faa-48-1',
  kind: 'tower',
  source: 'faa',
  lon: -95.01,
  lat: 32.59,
  radiusM: 6,
  estimatedHeightM: 61,
  heightM: 61,
};
const treeRow = {
  id: 'chm-1',
  kind: 'tree',
  source: 'canopy',
  lon: -95.0,
  lat: 32.59,
  radiusM: 20,
  estimatedHeightM: 18,
  heightM: 18,
};

test('lookupBoxes: capped, small and inside the area', () => {
  const boxes = lookupBoxes([AREA]);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].west >= AREA.box.west - 1e-9);
  const huge = lookupBoxes([
    { ...AREA, box: { west: -96, south: 31, east: -94, north: 33 } },
  ]);
  assert.ok(huge.length <= MAX_LOOKUP_BOXES);
  for (const b of huge) {
    assert.ok(b.east - b.west <= 0.05 + 1e-9);
    assert.ok(b.north - b.south <= 0.05 + 1e-9);
  }
  assert.deepEqual(lookupBoxes([]), []);
});

test('fetchOpenObstacles: towers and trees from the proxy, no live network', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const rows = String(url).includes('/faa?') ? [faaRow] : [treeRow];
    return { ok: true, json: async () => ({ obstacles: rows }) };
  };
  const out = await fetchOpenObstacles([AREA], { fetchImpl });
  assert.deepEqual(out.status, { faa: 'ok', canopy: 'ok' });
  assert.equal(out.obstacles.length, 2);
  assert.equal(out.obstacles[0].id, 'faa-48-1', 'towers first');
  assert.ok(urls.every((u) => u.startsWith('/api/obstacles/')));
});

test('fetchOpenObstacles: a failing source is reported and the other still works', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/canopy?')) throw new Error('down');
    return { ok: true, json: async () => ({ obstacles: [faaRow] }) };
  };
  const out = await fetchOpenObstacles([AREA], { fetchImpl });
  assert.equal(out.status.canopy, 'failed');
  assert.equal(out.status.faa, 'ok');
  assert.equal(out.obstacles.length, 1);
  const bad = await fetchOpenObstacles([AREA], {
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.deepEqual(bad.obstacles, []);
  assert.deepEqual(bad.status, { faa: 'failed', canopy: 'failed' });
  const none = await fetchOpenObstacles([AREA], {
    fetchImpl: async () => ({ ok: true, json: async () => ({ obstacles: [] }) }),
  });
  assert.deepEqual(none.status, { faa: 'none', canopy: 'none' });
  const skipped = await fetchOpenObstacles([], { fetchImpl });
  assert.deepEqual(skipped.status, { faa: 'skipped', canopy: 'skipped' });
});

test('fetchOpenObstacles: a slow source times out instead of blocking the plan', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  const out = await fetchOpenObstacles([AREA], { fetchImpl, timeoutMs: 20 });
  assert.deepEqual(out.status, { faa: 'failed', canopy: 'failed' });
});

test('buildingObstacles: OSM height tags become columns, buildings with no height are left out', () => {
  const sq = (lon, lat, d) => [
    { lon: lon - d, lat: lat - d },
    { lon: lon + d, lat: lat - d },
    { lon: lon + d, lat: lat + d },
    { lon: lon - d, lat: lat + d },
  ];
  const out = buildingObstacles([
    { osmId: 'way/12', heightM: 24, ring: sq(-95, 32.59, 0.0002) },
    { osmId: 'way/13', ring: sq(-95, 32.59, 0.0002) },
    { osmId: 'way/14', heightM: 10, ring: [{ lon: 1, lat: 1 }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'osm-way-12');
  assert.equal(out[0].kind, 'building');
  assert.equal(out[0].source, 'osm');
  assert.equal(out[0].estimatedHeightM, 24);
  assert.ok(out[0].radiusM > 15 && out[0].radiusM < 40);
  assert.deepEqual(buildingObstacles(null), []);
});

// ------------------------------------------------------------ the globe --
function fakeLayer(overrides = {}) {
  const values = [];
  const dataSource = {
    entities: {
      values,
      add: (e) => (values.push(e), e),
      remove: (e) => {
        const i = values.indexOf(e);
        if (i >= 0) values.splice(i, 1);
      },
    },
  };
  const calls = { ground: [], sky: 0 };
  const cesium = {
    Color: {
      fromCssColorString: (css) => ({ css, withAlpha: (a) => ({ css, a }) }),
    },
    Cartesian3: {
      fromDegrees: (lon, lat, h) => ({ lon, lat, h }),
      subtract: (a, b) => ({ lon: a.lon - b.lon, lat: a.lat - b.lat, h: a.h - b.h }),
      dot: () => 0,
    },
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat }) },
  };
  const viewer = {
    scene: {
      globe: {
        getHeight: (c) => {
          calls.ground.push(c);
          return 100;
        },
      },
      canvas: {},
    },
    camera: {},
  };
  const set = [];
  const layer = createObstacleLayer({
    dataSource,
    cesium,
    viewer,
    requestRender: () => {},
    overlay: { set: (l) => set.push(l), clear: () => set.push(null) },
    ...overrides,
  });
  return { layer, values, set, calls };
}

test('globe: one see-through column and one handle per obstacle, labelled "<kind> <h> m"', () => {
  const { layer, values, set } = fakeLayer();
  layer.set([
    { id: 'a', kind: 'tower', lon: -95, lat: 32.5, radiusM: 6, heightM: 60, source: 'faa', estimatedHeightM: 60, userEdited: false },
    { id: 'b', kind: 'tree', lon: -95.1, lat: 32.5, radiusM: 12, heightM: 18, source: 'user', estimatedHeightM: null, userEdited: true },
  ]);
  assert.equal(layer.count(), 2);
  const cyl = values.filter((e) => e.cylinder);
  assert.equal(cyl.length, 2);
  assert.equal(cyl[0].cylinder.length, 60);
  assert.equal(cyl[0].cylinder.topRadius, 6);
  assert.equal(cyl[0].position.h, 100 + 30, 'sits on the terrain model ground');
  assert.ok(cyl[0].cylinder.material.a < 0.5, 'see-through');
  assert.equal(values.filter((e) => e.point).length, 2);
  assert.deepEqual(set.at(-1).map((l) => l.title), ['tower 60 m', 'tree 18 m']);
  layer.set([]);
  assert.equal(values.length, 0);
  assert.equal(set.at(-1), null);
  layer.destroy();
});

test('globe: a drag only starts when the pointer is free, and gives the pointer back', () => {
  resetPointerOwnership();
  const lease = claimPointer('someone-else');
  assert.ok(lease);
  const { layer } = fakeLayer();
  layer.set([{ id: 'a', kind: 'tower', lon: -95, lat: 32.5, radiusM: 6, heightM: 60, source: 'user', estimatedHeightM: null, userEdited: true }]);
  assert.equal(layer.isDragging(), false);
  releasePointer(lease);
  assert.equal(OBSTACLE_POINTER_OWNER, 'drone-plan-obstacle-drag');
  layer.destroy();
});
