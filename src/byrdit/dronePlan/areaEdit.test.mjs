import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boxCentre,
  boxCorners,
  boxFromCorner,
  edgeMidpoint,
  edgeMidpoints,
  insertVertexAtEdge,
  metricOffset,
  moveArea,
  moveAreaBy,
  moveVertex,
  removeVertex,
  shapeCentre,
  translatePoint,
  validateEditedShape,
} from './areaEdit.js';

// Reference numbers come from an independent implementation of the WGS84
// metres-per-degree series, run outside the repo (see the task log):
//   at 30.27 N: 96223.98731264126 m per degree of longitude,
//               110856.9873928434 m per degree of latitude.
const near = (actual, expected, eps = 1e-9, label = '') =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label} ${actual} is not within ${eps} of ${expected}`,
  );

// A 100 m x 100 m box centred on (-97.77, 30.27).
const BOX = {
  west: -97.77051962095311,
  south: 30.269548968439643,
  east: -97.76948037904688,
  north: 30.270451031560356,
};
const TRIANGLE = [
  { lon: 10.0, lat: 60.0 },
  { lon: 10.003, lat: 60.0 },
  { lon: 10.0015, lat: 60.002 },
];
// ~200 m square at 30.27 N.
const SQUARE = [
  { lon: -97.77, lat: 30.27 },
  { lon: -97.77 + 0.0020784838124633, lat: 30.27 },
  { lon: -97.77 + 0.0020784838124633, lat: 30.27 + 0.001804126241418 },
  { lon: -97.77, lat: 30.27 + 0.001804126241418 },
];

test('metricOffset and translatePoint measure metres, not degrees', () => {
  const { dxM, dyM } = metricOffset(
    { lon: -97.77, lat: 30.27 },
    { lon: -97.76, lat: 30.28 },
  );
  near(dxM, 962.2398731264126, 1e-6);
  near(dyM, 1108.569873928434, 1e-6);
  const moved = translatePoint({ lon: -97.77, lat: 30.27 }, 100, -50);
  near(moved.lon, -97.76896075809377, 1e-12);
  near(moved.lat, 30.269548968439643, 1e-12);
  assert.equal(translatePoint({ lon: 0, lat: 0 }, NaN, 1), null);
});

test('the same metres move farther in degrees of longitude at high latitude', () => {
  const south = moveArea({ kind: 'polygon', ring: SQUARE }, 100, 0).ring[0];
  const north = moveArea(
    {
      kind: 'polygon',
      ring: [
        { lon: 10, lat: 60 },
        { lon: 10.002, lat: 60 },
        { lon: 10.001, lat: 60.001 },
      ],
    },
    100,
    0,
  ).ring[0];
  const degSouth = south.lon - SQUARE[0].lon;
  const degNorth = north.lon - 10;
  assert.ok(degNorth > degSouth * 1.6, `${degNorth} vs ${degSouth}`);
});

test('moveArea moves a box by metres and keeps it an axis-aligned rectangle', () => {
  const moved = moveArea({ kind: 'rect', box: BOX }, 100, -50);
  assert.equal(moved.kind, 'rect');
  near(moved.box.west, -97.76948037904688, 1e-9, 'west');
  near(moved.box.east, -97.76844113714066, 1e-9, 'east');
  near(moved.box.south, 30.269097936879287, 1e-9, 'south');
  near(moved.box.north, 30.27, 1e-9, 'north');
  // The size is unchanged.
  near(moved.box.east - moved.box.west, BOX.east - BOX.west, 1e-12);
  near(moved.box.north - moved.box.south, BOX.north - BOX.south, 1e-12);
  // The input is not touched.
  assert.equal(BOX.west, -97.77051962095311);
});

test('moveArea moves every polygon corner by the same metres', () => {
  const moved = moveArea({ kind: 'polygon', ring: TRIANGLE }, 200, 300);
  const expected = [
    [10.003584302853957, 60.00269270206716],
    [10.006584302853957, 60.00269270206716],
    [10.005084302853957, 60.00469270206716],
  ];
  moved.ring.forEach((p, i) => {
    near(p.lon, expected[i][0], 1e-9, `lon ${i}`);
    near(p.lat, expected[i][1], 1e-9, `lat ${i}`);
  });
  assert.equal(TRIANGLE[0].lon, 10);
  assert.equal(moveArea({ kind: 'polygon', ring: TRIANGLE }, NaN, 0), null);
});

test('moveArea carries a box across the antimeridian', () => {
  const box = { west: 179.9995, east: -179.9995, south: 10, north: 10.001 };
  const moved = moveArea({ kind: 'rect', box }, 100, 0);
  near(moved.box.west, -179.9995879171563, 1e-9, 'west');
  near(moved.box.east, -179.99858791715633, 1e-9, 'east');
  near(moved.box.south, 10, 1e-12);
  near(moved.box.north, 10.001, 1e-12);
  near(boxCentre(box).lat, 10.0005, 1e-12);
  near(Math.abs(boxCentre(box).lon), 180, 1e-9);
});

test('moveAreaBy moves the shape so the grabbed point lands on the target', () => {
  const from = { lon: -97.77, lat: 30.27 };
  const to = { lon: -97.76896075809377, lat: 30.269548968439643 };
  const moved = moveAreaBy({ kind: 'rect', box: BOX }, from, to);
  near(moved.box.west, -97.76948037904688, 1e-8);
  near(moved.box.south, 30.269097936879287, 1e-8);
});

test('shapeCentre is the box centre or the ring mean', () => {
  const c = shapeCentre({ kind: 'rect', box: BOX });
  near(c.lon, -97.77, 1e-12);
  near(c.lat, 30.27, 1e-12);
  const p = shapeCentre({ kind: 'polygon', ring: TRIANGLE });
  near(p.lon, 10.0015, 1e-12);
  near(p.lat, 60.000666666666667, 1e-12);
});

test('boxFromCorner keeps the opposite corner and follows the dragged one', () => {
  const box = boxFromCorner(BOX, 'ne', { lon: -97.7685, lat: 30.2715 });
  assert.deepEqual(box, {
    west: BOX.west,
    south: BOX.south,
    east: -97.7685,
    north: 30.2715,
  });
  const sw = boxFromCorner(BOX, 'sw', { lon: -97.7725, lat: 30.2685 });
  assert.deepEqual(sw, {
    west: -97.7725,
    south: 30.2685,
    east: BOX.east,
    north: BOX.north,
  });
  const nw = boxFromCorner(BOX, 'nw', { lon: -97.772, lat: 30.2712 });
  assert.equal(nw.east, BOX.east);
  assert.equal(nw.south, BOX.south);
  assert.equal(nw.west, -97.772);
  assert.equal(nw.north, 30.2712);
});

test('dragging a corner past the opposite one flips the box', () => {
  const box = boxFromCorner(BOX, 'ne', { lon: -97.7715, lat: 30.2685 });
  assert.deepEqual(box, {
    west: -97.7715,
    south: 30.2685,
    east: BOX.west,
    north: BOX.south,
  });
});

test('boxFromCorner takes the short way across the antimeridian', () => {
  const box = { west: 179.9995, east: -179.9995, south: 10, north: 10.001 };
  const next = boxFromCorner(box, 'ne', { lon: -179.999, lat: 10.0015 });
  assert.deepEqual(next, {
    west: 179.9995,
    east: -179.999,
    south: 10,
    north: 10.0015,
  });
  assert.equal(boxFromCorner(box, 'xx', { lon: 0, lat: 0 }), null);
  assert.equal(boxFromCorner(box, 'ne', { lon: NaN, lat: 0 }), null);
});

test('boxCorners names the four corners', () => {
  const c = boxCorners(BOX);
  assert.deepEqual(c.sw, { lon: BOX.west, lat: BOX.south });
  assert.deepEqual(c.ne, { lon: BOX.east, lat: BOX.north });
  assert.deepEqual(c.se, { lon: BOX.east, lat: BOX.south });
  assert.deepEqual(c.nw, { lon: BOX.west, lat: BOX.north });
});

test('moveVertex returns a new ring and rejects bad input', () => {
  const next = moveVertex(SQUARE, 2, { lon: -97.766, lat: 30.273 });
  assert.deepEqual(next[2], { lon: -97.766, lat: 30.273 });
  assert.deepEqual(next[0], SQUARE[0]);
  assert.notEqual(next, SQUARE);
  assert.equal(SQUARE[2].lat, 30.27 + 0.001804126241418);
  assert.equal(moveVertex(SQUARE, 9, { lon: 0, lat: 0 }), null);
  assert.equal(moveVertex(SQUARE, -1, { lon: 0, lat: 0 }), null);
  assert.equal(moveVertex(SQUARE, 1, { lon: 0, lat: 95 }), null);
  assert.equal(moveVertex(SQUARE, 1, { lon: NaN, lat: 0 }), null);
});

test('edge midpoints sit halfway along each edge, closing edge included', () => {
  const mid = edgeMidpoints(SQUARE);
  assert.equal(mid.length, 4);
  near(mid[0].lon, -97.77 + 0.0020784838124633 / 2, 1e-12);
  near(mid[0].lat, 30.27, 1e-12);
  near(mid[3].lon, -97.77, 1e-12);
  near(mid[3].lat, 30.27 + 0.001804126241418 / 2, 1e-12);
  // Across the antimeridian the midpoint is on the meridian, not at 0.
  const across = edgeMidpoint(
    [
      { lon: 179.999, lat: 5 },
      { lon: -179.999, lat: 5 },
      { lon: 180, lat: 5.001 },
    ],
    0,
  );
  near(Math.abs(across.lon), 180, 1e-9);
});

test('insertVertexAtEdge adds a corner at the midpoint and reports its index', () => {
  const { ring, index } = insertVertexAtEdge(SQUARE, 1);
  assert.equal(index, 2);
  assert.equal(ring.length, 5);
  near(ring[2].lon, SQUARE[1].lon, 1e-12);
  near(ring[2].lat, (SQUARE[1].lat + SQUARE[2].lat) / 2, 1e-12);
  assert.deepEqual(ring[3], SQUARE[2]);
  const last = insertVertexAtEdge(SQUARE, 3);
  assert.equal(last.index, 4);
  assert.equal(last.ring.length, 5);
  assert.equal(SQUARE.length, 4);
  assert.equal(insertVertexAtEdge(SQUARE, 4), null);
  assert.equal(insertVertexAtEdge(SQUARE, 1.5), null);
});

test('removeVertex never leaves fewer than 3 corners', () => {
  const four = removeVertex(SQUARE, 1);
  assert.equal(four.length, 3);
  assert.deepEqual(four[1], SQUARE[2]);
  assert.equal(removeVertex(four, 0), null);
  assert.equal(removeVertex(SQUARE, 7), null);
  assert.equal(SQUARE.length, 4);
});

test('validateEditedShape applies the box limits', () => {
  const ok = validateEditedShape({ kind: 'rect', box: BOX });
  assert.equal(ok.ok, true);
  assert.equal(ok.shape.kind, 'rect');
  const tiny = validateEditedShape({
    kind: 'rect',
    box: { ...BOX, east: BOX.west + 0.00001 },
  });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.reason, 'degenerate');
  const huge = validateEditedShape({
    kind: 'rect',
    box: { ...BOX, east: BOX.west + 0.05 },
  });
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, 'too-large');
  assert.equal(validateEditedShape({ kind: 'rect', box: null }).ok, false);
});

test('validateEditedShape applies the polygon rules', () => {
  const ok = validateEditedShape({ kind: 'polygon', ring: SQUARE });
  assert.equal(ok.ok, true);
  assert.equal(ok.shape.kind, 'polygon');
  near(ok.shape.box.west, SQUARE[0].lon, 1e-12);
  near(ok.shape.box.north, SQUARE[2].lat, 1e-12);
  const bowtie = validateEditedShape({
    kind: 'polygon',
    ring: [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]],
  });
  assert.equal(bowtie.ok, false);
  assert.equal(bowtie.reason, 'self-intersecting');
  const two = validateEditedShape({
    kind: 'polygon',
    ring: SQUARE.slice(0, 2),
  });
  assert.equal(two.reason, 'too-few-corners');
  const bad = validateEditedShape({
    kind: 'polygon',
    ring: [SQUARE[0], SQUARE[1], { lon: NaN, lat: 1 }],
  });
  assert.equal(bad.reason, 'invalid');
  // 20 m is the smallest side the planner takes.
  const sliver = validateEditedShape({
    kind: 'polygon',
    ring: [
      { lon: -97.77, lat: 30.27 },
      { lon: -97.77 + 0.002, lat: 30.27 },
      { lon: -97.77 + 0.001, lat: 30.27 + 0.00005 },
    ],
  });
  assert.equal(sliver.ok, false);
  assert.equal(sliver.reason, 'degenerate');
});
