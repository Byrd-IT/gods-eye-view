/**
 * Local-plane polygon ops for the Drone Flight Plan tool. Rings are open
 * lists of {x, y} in metres (first point is not repeated). No holes.
 * Pure functions, so the clip and union rules are unit-testable in node.
 */

const EPS = 1e-8;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const hypot = (a) => Math.hypot(a.x, a.y);

/** Signed area, positive when the ring is counter-clockwise. */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** A copy wound counter-clockwise, dropping a repeated closing point. */
export function normalizeRing(ring) {
  const pts = ring
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map((p) => ({ x: p.x, y: p.y }));
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) pts.pop();
  }
  if (signedArea(pts) < 0) pts.reverse();
  return pts;
}

function orient(a, b, c) {
  return cross(sub(b, a), sub(c, a));
}

function onSegment(p, a, b, eps = 1e-6) {
  const ab = sub(b, a);
  const len = hypot(ab);
  if (len < eps) return hypot(sub(p, a)) <= eps;
  if (Math.abs(orient(a, b, p)) > eps * len) return false;
  const t = dot(sub(p, a), ab) / (len * len);
  return t >= -eps / len && t <= 1 + eps / len;
}

/**
 * True when two segments properly cross, overlap collinearly, or a vertex of
 * one lies in the interior of the other. Shared endpoints alone do not count.
 */
function edgesCross(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const scale =
    Math.max(hypot(sub(b, a)), hypot(sub(d, c)), 1) * 1e-9;
  const s1 = Math.abs(o1) <= scale ? 0 : Math.sign(o1);
  const s2 = Math.abs(o2) <= scale ? 0 : Math.sign(o2);
  const s3 = Math.abs(o3) <= scale ? 0 : Math.sign(o3);
  const s4 = Math.abs(o4) <= scale ? 0 : Math.sign(o4);
  if (s1 * s2 < 0 && s3 * s4 < 0) return true;
  if (s1 === 0 && onSegment(c, a, b) && !samePoint(c, a) && !samePoint(c, b))
    return true;
  if (s2 === 0 && onSegment(d, a, b) && !samePoint(d, a) && !samePoint(d, b))
    return true;
  if (s3 === 0 && onSegment(a, c, d) && !samePoint(a, c) && !samePoint(a, d))
    return true;
  if (s4 === 0 && onSegment(b, c, d) && !samePoint(b, c) && !samePoint(b, d))
    return true;
  if (s1 === 0 && s2 === 0) {
    // Collinear: an overlap that is more than a shared endpoint.
    return rangesOverlap(a, b, c, d);
  }
  return false;
}

function samePoint(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-6;
}

function rangesOverlap(a, b, c, d) {
  const ab = sub(b, a);
  const axis = Math.abs(ab.x) >= Math.abs(ab.y) ? 'x' : 'y';
  const a0 = Math.min(a[axis], b[axis]);
  const a1 = Math.max(a[axis], b[axis]);
  const b0 = Math.min(c[axis], d[axis]);
  const b1 = Math.max(c[axis], d[axis]);
  return Math.min(a1, b1) - Math.max(a0, b0) > 1e-6;
}

/** True when a non-adjacent pair of edges crosses. A triangle cannot. */
export function selfIntersects(ring) {
  const pts = normalizeRing(ring);
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const adjacent =
        Math.abs(i - j) <= 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      // Edges (i, i+1) and (j, j+1). The closing edge is (n-1, 0).
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (edgesCross(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Boundary counts as inside, so a flight line ending on the edge is kept. */
export function pointInRing(p, ring, eps = 1e-6) {
  const pts = normalizeRing(ring);
  const n = pts.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i += 1) {
    if (onSegment(p, pts[i], pts[(i + 1) % n], eps)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = pts[i];
    const b = pts[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (!crosses) continue;
    const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (x > p.x) inside = !inside;
  }
  return inside;
}

function segmentEdgeHits(a, b, c, d) {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  const qp = sub(c, a);
  if (Math.abs(denom) <= EPS * Math.max(hypot(r), hypot(s), 1)) {
    if (Math.abs(orient(a, b, c)) > 1e-6 * Math.max(hypot(r), 1)) return [];
    const hits = [];
    for (const p of [c, d]) {
      if (!onSegment(p, a, b)) continue;
      const len2 = dot(r, r);
      const t = len2 < EPS ? 0 : dot(sub(p, a), r) / len2;
      if (t >= -EPS && t <= 1 + EPS) hits.push(Math.min(1, Math.max(0, t)));
    }
    return hits;
  }
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
    return [Math.min(1, Math.max(0, t))];
  }
  return [];
}

function at(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The parts of segment a→b that lie inside `ring`, including the boundary.
 * A concave ring can return more than one piece.
 */
export function clipSegmentToRing(a, b, ring) {
  const pts = normalizeRing(ring);
  if (pts.length < 3) return [];
  const ts = [0, 1];
  for (let i = 0; i < pts.length; i += 1) {
    for (const t of segmentEdgeHits(a, b, pts[i], pts[(i + 1) % pts.length])) {
      ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  const uniq = [];
  for (const t of ts) {
    if (!uniq.length || t - uniq[uniq.length - 1] > 1e-8) uniq.push(t);
  }
  const pieces = [];
  for (let i = 0; i < uniq.length - 1; i += 1) {
    const t0 = uniq[i];
    const t1 = uniq[i + 1];
    if (t1 - t0 < 1e-7) continue;
    const mid = at(a, b, (t0 + t1) / 2);
    if (!pointInRing(mid, pts)) continue;
    pieces.push({ start: at(a, b, t0), end: at(a, b, t1) });
  }
  return pieces;
}

function project(p, origin, dir) {
  return dot(sub(p, origin), dir);
}

/**
 * Merge overlapping or touching pieces of one straight segment so ground that
 * two areas both cover is flown once.
 */
export function mergeCollinearSegments(segments, eps = 1e-4) {
  const usable = segments.filter(
    (s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > eps,
  );
  if (!usable.length) return [];
  let dir = { x: 1, y: 0 };
  let best = 0;
  for (const s of usable) {
    const d = sub(s.end, s.start);
    const len = hypot(d);
    if (len > best) {
      best = len;
      dir = mul(d, 1 / len);
    }
  }
  const origin = usable[0].start;
  const keyed = usable
    .map((s) => {
      const t0 = project(s.start, origin, dir);
      const t1 = project(s.end, origin, dir);
      return {
        lo: Math.min(t0, t1),
        hi: Math.max(t0, t1),
        start: t0 <= t1 ? s.start : s.end,
        end: t0 <= t1 ? s.end : s.start,
      };
    })
    .sort((p, q) => p.lo - q.lo);
  const merged = [{ ...keyed[0] }];
  for (const s of keyed.slice(1)) {
    const last = merged[merged.length - 1];
    if (s.lo <= last.hi + eps) {
      if (s.hi > last.hi) {
        last.hi = s.hi;
        last.end = s.end;
      }
    } else {
      merged.push({ ...s });
    }
  }
  return merged.map((m) => ({ start: m.start, end: m.end }));
}

/** Clip a→b to the union of the rings (inside any of them), with no overlap. */
export function clipSegmentToRings(a, b, rings) {
  const pieces = [];
  for (const ring of rings) pieces.push(...clipSegmentToRing(a, b, ring));
  return mergeCollinearSegments(pieces);
}

function lineHit(p, d, q, e) {
  const denom = cross(d, e);
  if (Math.abs(denom) < 1e-12) return null;
  const s = cross(sub(q, p), e) / denom;
  return add(p, mul(d, s));
}

/**
 * Offset a ring outward by `margin` metres (0 returns a copy). A square grows
 * by exactly `margin` on each side. The result is counter-clockwise.
 */
export function offsetRing(ring, margin) {
  const pts = normalizeRing(ring);
  if (!(margin > 0) || pts.length < 3) return pts;
  const edges = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = sub(b, a);
    const len = hypot(d);
    if (len < 1e-9) continue;
    const ox = (d.y / len) * margin;
    const oy = (-d.x / len) * margin;
    edges.push({ p: { x: a.x + ox, y: a.y + oy }, d });
  }
  if (edges.length < 3) return pts;
  const out = [];
  for (let i = 0; i < edges.length; i += 1) {
    const prev = edges[(i + edges.length - 1) % edges.length];
    const cur = edges[i];
    out.push(lineHit(prev.p, prev.d, cur.p, cur.d) ?? { ...cur.p });
  }
  return normalizeRing(out);
}

/** True when the rings cross, one contains a point of the other, or they touch. */
export function ringsOverlap(a, b) {
  const pa = normalizeRing(a);
  const pb = normalizeRing(b);
  if (pa.length < 3 || pb.length < 3) return false;
  for (let i = 0; i < pa.length; i += 1) {
    for (let j = 0; j < pb.length; j += 1) {
      if (
        edgesCross(
          pa[i],
          pa[(i + 1) % pa.length],
          pb[j],
          pb[(j + 1) % pb.length],
        )
      ) {
        return true;
      }
    }
  }
  return pointInRing(pa[0], pb) || pointInRing(pb[0], pa);
}

/** Evenly spaced points along a segment, no further apart than `maxStepM`. */
export function sampleSegment(start, end, maxStepM, minPoints = 2) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const pieces = Math.max(
    minPoints - 1,
    Math.ceil(length / Math.max(maxStepM, 1e-6) - 1e-9),
  );
  const points = [];
  for (let k = 0; k <= pieces; k += 1) {
    const f = pieces === 0 ? 0 : k / pieces;
    points.push({
      x: start.x + (end.x - start.x) * f,
      y: start.y + (end.y - start.y) * f,
    });
  }
  return { points, length };
}
