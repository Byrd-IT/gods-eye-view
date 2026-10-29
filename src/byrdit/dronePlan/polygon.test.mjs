import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignSegmentToRings,
  clipSegmentToRing,
  clipSegmentToRings,
  offsetRing,
  pointInRing,
  ringsOverlap,
  selfIntersects,
  signedArea,
} from './polygon.js';

const near = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label ?? ''} expected ${expected} ±${tol}, got ${actual}`,
  );
const nearPt = (p, x, y, tol = 1e-6) => {
  near(p.x, x, tol, 'x');
  near(p.y, y, tol, 'y');
};

const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];
// Concave L: the full 100×100 square with the south-east 40×40 cut out.
// Vertices, counter-clockwise: (0,0) (60,0) (60,40) (100,40) (100,100) (0,100).
const ell = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 40 },
  { x: 100, y: 40 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

test('a bowtie is self-intersecting and a square or L is not', () => {
  const bowtie = [
    { x: 0, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
    { x: 2, y: 0 },
  ];
  // Edges (0,0)-(2,2) and (0,2)-(2,0) cross at (1,1).
  assert.equal(selfIntersects(bowtie), true);
  assert.equal(selfIntersects(square), false);
  assert.equal(selfIntersects(ell), false);
  assert.equal(selfIntersects(square.slice(0, 3)), false);
});

test('point-in-ring counts the interior and the boundary, not the outside', () => {
  assert.equal(pointInRing({ x: 50, y: 50 }, square), true);
  assert.equal(pointInRing({ x: 0, y: 50 }, square), true);
  assert.equal(pointInRing({ x: 100, y: 100 }, square), true);
  assert.equal(pointInRing({ x: -1, y: 50 }, square), false);
  // The missing south-east corner of the L.
  assert.equal(pointInRing({ x: 80, y: 20 }, ell), false);
  assert.equal(pointInRing({ x: 30, y: 20 }, ell), true);
  assert.equal(pointInRing({ x: 80, y: 70 }, ell), true);
});

test('a horizontal line through a square is clipped to the edges', () => {
  // Hand-worked: y=50 crosses x=0 and x=100.
  const pieces = clipSegmentToRing(
    { x: -10, y: 50 },
    { x: 110, y: 50 },
    square,
  );
  assert.equal(pieces.length, 1);
  nearPt(pieces[0].start, 0, 50);
  nearPt(pieces[0].end, 100, 50);
});

test('a convex triangle clips a line to the hand-worked edge crossings', () => {
  // Triangle (0,0) (100,0) (50,80). At y=40 the left edge is
  // x = 50 * 40/80 = 25 and the right edge is x = 100 - 25 = 75.
  const tri = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 80 },
  ];
  const pieces = clipSegmentToRing({ x: 0, y: 40 }, { x: 100, y: 40 }, tri);
  assert.equal(pieces.length, 1);
  nearPt(pieces[0].start, 25, 40);
  nearPt(pieces[0].end, 75, 40);
});

test('an L clips a line through the notch to the stem only', () => {
  // y=20 crosses the stem (x=0..60) and misses the notch (x=60..100, y<40).
  const low = clipSegmentToRing({ x: -10, y: 20 }, { x: 110, y: 20 }, ell);
  assert.equal(low.length, 1);
  nearPt(low[0].start, 0, 20);
  nearPt(low[0].end, 60, 20);
  // y=70 crosses the full width.
  const high = clipSegmentToRing({ x: -10, y: 70 }, { x: 110, y: 70 }, ell);
  assert.equal(high.length, 1);
  nearPt(high[0].start, 0, 70);
  nearPt(high[0].end, 100, 70);
});

test('a line that leaves and re-enters a concave ring comes back as two pieces', () => {
  // C shape, open to the east: the vertical line x=80 crosses the top and
  // bottom bars and misses the gap between y=40 and y=60.
  const cee = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 40 },
    { x: 40, y: 40 },
    { x: 40, y: 60 },
    { x: 100, y: 60 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  assert.equal(selfIntersects(cee), false);
  const pieces = clipSegmentToRing({ x: 80, y: -10 }, { x: 80, y: 110 }, cee);
  assert.equal(pieces.length, 2);
  nearPt(pieces[0].start, 80, 0);
  nearPt(pieces[0].end, 80, 40);
  nearPt(pieces[1].start, 80, 60);
  nearPt(pieces[1].end, 80, 100);
});

test('offsetting a square by 10 m grows each side by exactly 10 m', () => {
  const grown = offsetRing(square, 10);
  assert.equal(grown.length, 4);
  const xs = grown.map((p) => p.x).sort((a, b) => a - b);
  const ys = grown.map((p) => p.y).sort((a, b) => a - b);
  near(xs[0], -10, 1e-6, 'west');
  near(xs[3], 110, 1e-6, 'east');
  near(ys[0], -10, 1e-6, 'south');
  near(ys[3], 110, 1e-6, 'north');
  assert.ok(signedArea(grown) > signedArea(square));
});

test('overlapping rectangles union to one segment with no duplicate over the overlap', () => {
  const a = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const b = [
    { x: 50, y: 50 },
    { x: 150, y: 50 },
    { x: 150, y: 150 },
    { x: 50, y: 150 },
  ];
  assert.equal(ringsOverlap(a, b), true);
  // y=75 crosses A at x=0..100 and B at x=50..150. The union is x=0..150.
  const pieces = clipSegmentToRings({ x: -10, y: 75 }, { x: 200, y: 75 }, [
    a,
    b,
  ]);
  assert.equal(pieces.length, 1, 'the overlap must not be flown twice');
  nearPt(pieces[0].start, 0, 75);
  nearPt(pieces[0].end, 150, 75);
  const length = Math.hypot(
    pieces[0].end.x - pieces[0].start.x,
    pieces[0].end.y - pieces[0].start.y,
  );
  near(length, 150, 1e-6, 'union length');
});

test('disjoint rectangles stay two separate pieces', () => {
  const a = square;
  const b = [
    { x: 200, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 100 },
    { x: 200, y: 100 },
  ];
  assert.equal(ringsOverlap(a, b), false);
  const pieces = clipSegmentToRings({ x: -10, y: 50 }, { x: 400, y: 50 }, [
    a,
    b,
  ]);
  assert.equal(pieces.length, 2);
  nearPt(pieces[0].start, 0, 50);
  nearPt(pieces[0].end, 100, 50);
  nearPt(pieces[1].start, 200, 50);
  nearPt(pieces[1].end, 300, 50);
});

test('a line through two overlapping squares is split, and the overlap stays with the first', () => {
  const a = square;
  const b = [
    { x: 60, y: 0 },
    { x: 160, y: 0 },
    { x: 160, y: 100 },
    { x: 60, y: 100 },
  ];
  const pieces = assignSegmentToRings({ x: -10, y: 50 }, { x: 180, y: 50 }, [
    a,
    b,
  ]);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].owner, 0);
  assert.equal(pieces[1].owner, 1);
  nearPt(pieces[0].start, 0, 50);
  nearPt(pieces[0].end, 100, 50);
  nearPt(pieces[1].start, 100, 50);
  nearPt(pieces[1].end, 160, 50);
});

test('a sharp corner is bevelled so the offset stays within margin·√2 of the ring', () => {
  const acute = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 98, y: 6 },
  ];
  const margin = 40;
  const grown = offsetRing(acute, margin);
  for (const p of grown) {
    let best = Infinity;
    for (let i = 0; i < acute.length; i += 1) {
      const a = acute[i];
      const b = acute[(i + 1) % acute.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      const t = Math.min(
        1,
        Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2),
      );
      best = Math.min(
        best,
        Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)),
      );
    }
    assert.ok(
      best <= margin * Math.SQRT2 + 0.01,
      `offset point ${best.toFixed(1)} m from the ring`,
    );
  }
});
