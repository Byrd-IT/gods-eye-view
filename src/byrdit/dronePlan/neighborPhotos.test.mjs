import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LATERAL_TIE_M,
  PARALLEL_TOLERANCE_DEG,
  neighborPhotos,
} from './neighborPhotos.js';
import { makeFrame } from './geo.js';

const frame = makeFrame(-97.77, 30.27);
const photo = (x, y, scope = 'm1', leg = 0, extra = {}) => ({
  ...frame.toLonLat(x, y),
  scope,
  leg,
  ...extra,
});

/**
 * A snaking survey: `lines` lines running north then south, `lineGap` metres
 * apart (east), `perLine` photos `step` metres apart. Step order = line by
 * line, like the planner.
 */
function snake({
  lines = 4,
  perLine = 5,
  lineGap = 30,
  step = 10,
  scope = 'm1',
} = {}) {
  const out = [];
  for (let l = 0; l < lines; l += 1) {
    for (let k = 0; k < perLine; k += 1) {
      const along = l % 2 === 0 ? k : perLine - 1 - k;
      out.push(photo(l * lineGap, along * step, scope, l));
    }
  }
  return out;
}
/** Index of the photo on line l, k-th in step order. */
const id = (l, k, perLine = 5) => l * perLine + k;

test('ahead and behind are the next and previous photo of the same line', () => {
  const photos = snake();
  const n = neighborPhotos(photos, id(1, 2));
  assert.equal(n.front, id(1, 3));
  assert.equal(n.back, id(1, 1));
});

test('left and right are the nearest photo on the lines beside, going north', () => {
  const photos = snake();
  // Lines sit at x = 0, 30, 60, 90 and odd lines run south: going SOUTH along
  // x = 30 the left hand is EAST.
  const n = neighborPhotos(photos, id(1, 2));
  // Photo (1,2) is at y = 20 (perLine-1-2 = 2 -> 20 m).
  assert.deepEqual(photos[n.left].leg, 2);
  assert.deepEqual(photos[n.right].leg, 0);
  assert.equal(n.left, id(2, 2)); // line 2 runs north: k = 2 is also y 20
  assert.equal(n.right, id(0, 2));
});

test('going north the left hand is west', () => {
  const photos = snake();
  const n = neighborPhotos(photos, id(2, 2));
  assert.equal(photos[n.left].leg, 1);
  assert.equal(photos[n.right].leg, 3);
  // Same y (20 m) on each side.
  assert.equal(n.left, id(1, 2));
  assert.equal(n.right, id(3, 2));
});

test('the first and last photo of a line use the line direction and have one end only', () => {
  const photos = snake();
  const first = neighborPhotos(photos, id(2, 0));
  assert.equal(first.back, null);
  assert.equal(first.front, id(2, 1));
  assert.equal(first.left, id(1, 4)); // y = 0 on the line to the west
  assert.equal(first.right, id(3, 4)); // line 3 runs south: its y = 0 end is last
  const last = neighborPhotos(photos, id(2, 4));
  assert.equal(last.front, null);
  assert.equal(last.back, id(2, 3));
  assert.equal(last.left, id(1, 0)); // y = 40
  assert.equal(last.right, id(3, 0));
});

test('the first line has nothing on one side; none is not guessed', () => {
  const photos = snake();
  const n = neighborPhotos(photos, id(0, 2));
  // Going north along x = 0: west (left) has no line.
  assert.equal(n.left, null);
  assert.equal(n.right, id(1, 2));
  const lastLine = neighborPhotos(photos, id(3, 2));
  // Line 3 runs south, so its east (nothing there) is the LEFT hand.
  assert.equal(lastLine.left, null);
  assert.equal(lastLine.right, id(2, 2));
});

test('a skipped line is not "beside": only the nearest line counts, ties go to the closest along the track', () => {
  // Photo at (0,0) going north; line 1 photos at x=30 are offset along the track.
  const photos = [
    photo(0, 0, 'm1', 0),
    photo(0, 10, 'm1', 0),
    photo(0, 20, 'm1', 0),
    photo(-30, 3, 'm1', 1),
    photo(-30, 13, 'm1', 1),
    photo(-30, 23, 'm1', 1),
    photo(-60, 0, 'm1', 2),
    photo(-60, 10, 'm1', 2),
  ];
  const n = neighborPhotos(photos, 1); // (0,10)
  assert.equal(n.left, 4); // (-30,13): along 3, beats (-30,3) along 7
  const near = neighborPhotos(photos, 0);
  assert.equal(near.left, 3); // (-30,3)
});

test('lateral ties within LATERAL_TIE_M pick the smaller along-track offset', () => {
  const off = LATERAL_TIE_M / 2;
  const photos = [
    photo(0, 0, 'm1', 0),
    photo(0, 10, 'm1', 0),
    // Slightly different sideways distance but nearer along: still wins.
    photo(-30 + off, 8, 'm1', 1),
    photo(-30, 10, 'm1', 1),
    photo(-30 - off, 12, 'm1', 1),
  ];
  const n = neighborPhotos(photos, 0);
  assert.equal(n.left, 2);
  // Further down the line the middle photo (along 0) wins.
  const mid = neighborPhotos(photos, 1);
  assert.equal(mid.left, 3);
});

test('same-line photos are never left or right', () => {
  const photos = [photo(0, 0), photo(0, 10), photo(0, 20)];
  const n = neighborPhotos(photos, 1);
  assert.equal(n.left, null);
  assert.equal(n.right, null);
  assert.equal(n.front, 2);
  assert.equal(n.back, 0);
});

test('other missions and passes are never neighbours, whatever the distance', () => {
  const a = snake({ scope: 'pass-a#0' });
  const b = snake({ scope: 'pass-b#0' }).map((p) => ({
    ...p,
    leg: p.leg + 10,
  }));
  const c = snake({ scope: 'pass-a#1' }).map((p) => ({
    ...p,
    leg: p.leg + 20,
  }));
  const all = [...a, ...b, ...c];
  const n = neighborPhotos(all, id(2, 2));
  for (const side of ['front', 'back', 'left', 'right']) {
    if (n[side] !== null) assert.equal(all[n[side]].scope, 'pass-a#0', side);
  }
  // A lone mission has no sideways neighbour at all.
  const lone = neighborPhotos(
    [...b.slice(0, 5)].map((p) => ({ ...p, leg: 0 })),
    2,
  );
  assert.equal(lone.left, null);
  assert.equal(lone.right, null);
});

test('non-parallel lines are not sideways candidates; slightly tilted ones are', () => {
  const east = (y, leg) => [photo(0, y, 'm1', leg), photo(30, y, 'm1', leg)];
  // P on a line running north; the other line runs EAST (90 degrees off).
  const cross = [
    photo(0, 0, 'm1', 0),
    photo(0, 10, 'm1', 0),
    photo(0, 20, 'm1', 0),
    ...east(10, 1).map((p) => ({ ...p, lon: p.lon + 0.0001 })),
  ];
  const n = neighborPhotos(cross, 1);
  assert.equal(n.left, null);
  assert.equal(n.right, null);

  const tilt = (deg) => {
    const dx = Math.tan((deg * Math.PI) / 180) * 40;
    return [
      photo(0, 0, 'm1', 0),
      photo(0, 10, 'm1', 0),
      photo(0, 20, 'm1', 0),
      photo(30, 0, 'm1', 1),
      photo(30 + dx, 40, 'm1', 1),
    ];
  };
  assert.equal(neighborPhotos(tilt(PARALLEL_TOLERANCE_DEG - 5), 1).left, null);
  assert.ok(neighborPhotos(tilt(PARALLEL_TOLERANCE_DEG - 5), 1).right !== null);
  assert.equal(neighborPhotos(tilt(PARALLEL_TOLERANCE_DEG + 5), 1).right, null);
});

test('an orbit has ahead and behind around the ring but no left or right', () => {
  const ring = [];
  for (let k = 0; k < 12; k += 1) {
    const a = (k / 12) * 2 * Math.PI;
    ring.push(
      photo(40 * Math.cos(a), 40 * Math.sin(a), 'm1', 0, { kind: 'orbit' }),
    );
  }
  // A grid leg of the same mission next to it must not become left/right.
  const grid = [photo(60, -20, 'm1', 1), photo(60, 20, 'm1', 1)];
  const all = [...ring, ...grid];
  const n = neighborPhotos(all, 3);
  assert.equal(n.front, 4);
  assert.equal(n.back, 2);
  assert.equal(n.left, null);
  assert.equal(n.right, null);
  // And an orbit is never a candidate for a grid photo beside it.
  const g = neighborPhotos(all, 12);
  assert.equal(g.left, null);
  assert.equal(g.right, null);
});

test('degenerate cases: single photo, empty list, bad index, coincident photos', () => {
  assert.deepEqual(neighborPhotos([], 0), {
    front: null,
    back: null,
    left: null,
    right: null,
  });
  assert.deepEqual(neighborPhotos([photo(0, 0)], 0), {
    front: null,
    back: null,
    left: null,
    right: null,
  });
  assert.equal(neighborPhotos([photo(0, 0)], 5).front, null);
  assert.equal(neighborPhotos(null, 0).front, null);
  // Two shots at one place on a line (an outward photo): direction falls back
  // to the line's overall direction, no NaN.
  const photos = [
    photo(0, 0, 'm1', 0),
    photo(0, 0, 'm1', 0),
    photo(0, 20, 'm1', 0),
    photo(-30, 0, 'm1', 1),
    photo(-30, 20, 'm1', 1),
  ];
  const n = neighborPhotos(photos, 1);
  assert.equal(n.front, 2);
  assert.equal(n.back, 0);
  assert.equal(n.left, 3);
  // A line whose photos all sit at one point has no direction: no sides.
  const stuck = neighborPhotos(
    [photo(0, 0, 'm1', 0), photo(0, 0, 'm1', 0), photo(30, 0, 'm1', 1)],
    0,
  );
  assert.equal(stuck.left, null);
  assert.equal(stuck.right, null);
  assert.equal(stuck.front, 1);
});

test('antiparallel lines (a snaking grid) count as parallel', () => {
  const photos = [
    photo(0, 0, 'm1', 0),
    photo(0, 20, 'm1', 0),
    photo(30, 20, 'm1', 1),
    photo(30, 0, 'm1', 1),
  ];
  const n = neighborPhotos(photos, 0);
  assert.equal(n.right, 3); // east of a north-going line is its right
  assert.equal(n.left, null);
});
