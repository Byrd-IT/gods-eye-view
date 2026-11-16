import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipConvex,
  footprintOverlapPct,
  polygonAreaM2,
} from './footprintOverlap.js';
import { makeFrame } from './geo.js';

const frame = makeFrame(-97.77, 30.27);
/** Corners (lon/lat) of a metre polygon, near-left first like the layer. */
const ll = (pts) => pts.map(([x, y]) => frame.toLonLat(x, y));
const rect = (x, y, w, h) =>
  ll([
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]);

test('polygonAreaM2 is the shoelace area in square metres', () => {
  assert.equal(
    polygonAreaM2([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ]),
    12,
  );
  assert.equal(polygonAreaM2([{ x: 0, y: 0 }]), 0);
  assert.equal(polygonAreaM2(null), 0);
});

test('identical footprints overlap 100%', () => {
  const a = rect(0, 0, 40, 30);
  assert.ok(Math.abs(footprintOverlapPct(a, a) - 100) < 1e-6);
});

test('disjoint footprints overlap 0%', () => {
  const pct = footprintOverlapPct(rect(0, 0, 40, 30), rect(100, 0, 40, 30));
  assert.equal(pct, 0);
});

test('a rectangle shifted by a quarter of its width overlaps 75%', () => {
  const pct = footprintOverlapPct(rect(0, 0, 40, 30), rect(10, 0, 40, 30));
  assert.ok(Math.abs(pct - 75) < 1e-4, String(pct));
  // The other way round is the same share (equal areas).
  const back = footprintOverlapPct(rect(10, 0, 40, 30), rect(0, 0, 40, 30));
  assert.ok(Math.abs(back - 75) < 1e-4, String(back));
});

test('the share is of the SELECTED footprint, not of the neighbour', () => {
  // A 10x10 square fully inside a 20x20 square.
  const small = rect(5, 5, 10, 10);
  const big = rect(0, 0, 20, 20);
  assert.ok(Math.abs(footprintOverlapPct(small, big) - 100) < 1e-6);
  assert.ok(Math.abs(footprintOverlapPct(big, small) - 25) < 1e-4);
});

test('a square rotated 45 degrees about the same centre overlaps an octagon share', () => {
  const s = 20;
  const half = s / 2;
  const a = rect(-half, -half, s, s);
  const diamond = ll([
    [0, -half * Math.SQRT2],
    [half * Math.SQRT2, 0],
    [0, half * Math.SQRT2],
    [-half * Math.SQRT2, 0],
  ]);
  // The shared part is a regular octagon of inradius `half`.
  const octagon = 8 * Math.tan(Math.PI / 8) * half * half;
  const expected = (octagon / (s * s)) * 100;
  const pct = footprintOverlapPct(a, diamond);
  assert.ok(Math.abs(pct - expected) < 0.01, `${pct} vs ${expected}`);
});

test('winding order does not matter and a trapezoid works', () => {
  const trap = ll([
    [0, 0],
    [40, 0],
    [30, 30],
    [10, 30],
  ]);
  const reversed = [...trap].reverse();
  assert.ok(Math.abs(footprintOverlapPct(trap, reversed) - 100) < 1e-6);
  // Left half (x < 20) of the trapezoid, which is symmetric about x = 20.
  const half = ll([
    [-10, -10],
    [20, -10],
    [20, 40],
    [-10, 40],
  ]);
  assert.ok(Math.abs(footprintOverlapPct(trap, half) - 50) < 1e-4);
});

test('degenerate or unusable input is null, never a number', () => {
  const a = rect(0, 0, 40, 30);
  const line = ll([
    [0, 0],
    [10, 0],
    [20, 0],
    [30, 0],
  ]);
  assert.equal(footprintOverlapPct(a, line), null);
  assert.equal(footprintOverlapPct(line, a), null);
  assert.equal(footprintOverlapPct(a, []), null);
  assert.equal(footprintOverlapPct(a, undefined), null);
  assert.equal(footprintOverlapPct(null, a), null);
  assert.equal(footprintOverlapPct(a, a.slice(0, 2)), null);
  assert.equal(
    footprintOverlapPct(a, [...a.slice(0, 3), { lon: NaN, lat: 1 }]),
    null,
  );
  // A bow-tie is not a convex footprint.
  const bow = ll([
    [0, 0],
    [40, 30],
    [40, 0],
    [0, 30],
  ]);
  assert.equal(footprintOverlapPct(a, bow), null);
});

test('clipConvex returns the shared corners of two overlapping squares', () => {
  const sq = (x, y, s) => [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
  const out = clipConvex(sq(0, 0, 10), sq(5, 5, 10));
  assert.equal(polygonAreaM2(out), 25);
  assert.deepEqual(clipConvex(sq(0, 0, 10), sq(20, 20, 5)), []);
});
