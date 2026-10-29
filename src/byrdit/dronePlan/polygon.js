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

function distanceToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/**
 * Inside the ring, or within `margin` metres of an edge. This is the footprint
 * buffer when an offset ring would cross itself (a notch narrower than 2×margin).
 */
export function pointWithinMargin(p, ring, margin) {
  const pts = normalizeRing(ring);
  if (pts.length < 3) return false;
  if (pointInRing(p, pts)) return true;
  if (!(margin > 0)) return false;
  for (let i = 0; i < pts.length; i += 1) {
    if (distanceToSegment(p, pts[i], pts[(i + 1) % pts.length]) <= margin + 1e-4) {
      return true;
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

function ringSpec(ring) {
  if (Array.isArray(ring)) return { ring: normalizeRing(ring), margin: 0 };
  return {
    ring: normalizeRing(ring?.ring ?? []),
    margin: ring?.margin > 0 ? ring.margin : 0,
  };
}

function specContains(spec, p) {
  if (spec.margin > 0) return pointWithinMargin(p, spec.ring, spec.margin);
  return pointInRing(p, spec.ring);
}

function distanceToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(best, distanceToSegment(p, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

/** Index of the first ring that contains `point`, or -1. A ring may be `{ ring, margin }`. */
export function areaIndexForPoint(point, rings) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return -1;
  for (let i = 0; i < (rings ?? []).length; i += 1) {
    const spec = ringSpec(rings[i]);
    if (spec.ring.length < 3) continue;
    if (specContains(spec, point)) return i;
  }
  return -1;
}

/**
 * Where a→b crosses the margin boundary. The step is the distance to that
 * boundary, not 1 m: a straight line cannot cross sooner than that, and a
 * long line over empty ground used to sample every metre.
 */
function marginCrossings(a, b, spec) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 1e-9) || spec.ring.length < 3) return [];
  const pad = spec.margin > 0 ? spec.margin : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of spec.ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const misses =
    (a.x < minX - pad && b.x < minX - pad) ||
    (a.x > maxX + pad && b.x > maxX + pad) ||
    (a.y < minY - pad && b.y < minY - pad) ||
    (a.y > maxY + pad && b.y > maxY + pad);
  if (misses) return [];
  const hits = [];
  let t = 0;
  let prev = specContains(spec, a);
  let steps = 0;
  const maxSteps = 48 + spec.ring.length;
  while (t < 1 - 1e-12 && steps < maxSteps) {
    steps += 1;
    const p = at(a, b, t);
    const inside = pointInRing(p, spec.ring);
    const dist = distanceToRing(p, spec.ring);
    const slack = inside ? dist + pad : Math.abs(dist - pad);
    const nextT = Math.min(1, t + Math.max(0.5, slack) / length);
    if (nextT <= t + 1e-15) break;
    const now = specContains(spec, at(a, b, nextT));
    if (now === prev) {
      t = nextT;
      continue;
    }
    let lo = t;
    let hi = nextT;
    for (let k = 0; k < 24; k += 1) {
      const mid = (lo + hi) / 2;
      if (specContains(spec, at(a, b, mid)) === prev) lo = mid;
      else hi = mid;
    }
    hits.push(hi);
    prev = !prev;
    t = Math.min(1, hi + 0.05 / length);
  }
  if (steps >= maxSteps && t < 1 - 1e-12) {
    hits.push(...sampleMarginCrossings(a, b, spec, t, prev));
  }
  return hits;
}

/** 1 m fallback for the rest of a line the distance jump did not finish. */
function sampleMarginCrossings(a, b, spec, fromT, prevIn) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const hits = [];
  let prev = prevIn;
  for (let d = fromT * length + 1; d < length; d += 1) {
    const now = specContains(spec, at(a, b, d / length));
    if (now === prev) continue;
    let lo = (d - 1) / length;
    let hi = d / length;
    for (let k = 0; k < 20; k += 1) {
      const mid = (lo + hi) / 2;
      if (specContains(spec, at(a, b, mid)) === prev) lo = mid;
      else hi = mid;
    }
    hits.push(hi);
    prev = now;
  }
  return hits;
}

/**
 * The parts of a→b that lie inside the ring, or within `margin` metres of it.
 * Used when the offset ring would cross itself.
 */
export function clipSegmentToMargin(a, b, ring, margin) {
  const spec = { ring: normalizeRing(ring), margin };
  if (spec.ring.length < 3) return [];
  const ts = [0, 1, ...marginCrossings(a, b, spec)];
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
    if (!specContains(spec, at(a, b, (t0 + t1) / 2))) continue;
    pieces.push({ start: at(a, b, t0), end: at(a, b, t1) });
  }
  return pieces;
}

/**
 * Clip a→b to a list of rings. A spec with margin > 0 uses the footprint
 * buffer instead of an offset ring. An array ring is clipped exactly.
 */
export function clipSegmentCovered(a, b, rings) {
  const pieces = [];
  for (const raw of rings) {
    const spec = ringSpec(raw);
    if (spec.ring.length < 3) continue;
    if (spec.margin > 0) pieces.push(...clipSegmentToMargin(a, b, spec.ring, spec.margin));
    else pieces.push(...clipSegmentToRing(a, b, spec.ring));
  }
  return mergeCollinearSegments(pieces);
}

/**
 * Split a→b where it crosses any ring. Each piece is given to the first ring
 * that contains its midpoint, so an overlap is not given to two owners.
 * A `{ ring, margin }` entry contains points within that many metres of the
 * ring, which is how a self-crossing offset is avoided. Pieces outside every
 * ring are dropped.
 */
export function assignSegmentToRings(a, b, rings) {
  const ready = rings
    .map((ring) => ringSpec(ring))
    .filter((spec) => spec.ring.length >= 3);
  const ts = [0, 1];
  for (const spec of ready) {
    if (spec.margin > 0) {
      ts.push(...marginCrossings(a, b, spec));
      continue;
    }
    for (let i = 0; i < spec.ring.length; i += 1) {
      for (const t of segmentEdgeHits(
        a,
        b,
        spec.ring[i],
        spec.ring[(i + 1) % spec.ring.length],
      )) {
        ts.push(t);
      }
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
    let owner = -1;
    for (let r = 0; r < ready.length; r += 1) {
      if (specContains(ready[r], mid)) {
        owner = r;
        break;
      }
    }
    if (owner < 0) continue;
    const last = pieces[pieces.length - 1];
    if (last && last.owner === owner && Math.abs(last.t1 - t0) < 1e-6) {
      last.t1 = t1;
      last.end = at(a, b, t1);
    } else {
      pieces.push({
        owner,
        t0,
        t1,
        start: at(a, b, t0),
        end: at(a, b, t1),
      });
    }
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
 * by exactly `margin` on each side. A corner sharper than a square is bevelled,
 * so the new point stays within margin·√2 of the ring (no farther than a
 * square corner). The result is counter-clockwise.
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
    edges.push({
      p: { x: a.x + ox, y: a.y + oy },
      d,
      ox,
      oy,
      vertex: a,
    });
  }
  if (edges.length < 3) return pts;
  const limit = margin * Math.SQRT2;
  const out = [];
  for (let i = 0; i < edges.length; i += 1) {
    const prev = edges[(i + edges.length - 1) % edges.length];
    const cur = edges[i];
    const hit = lineHit(prev.p, prev.d, cur.p, cur.d);
    const vertex = cur.vertex;
    const spiked =
      !hit || Math.hypot(hit.x - vertex.x, hit.y - vertex.y) > limit + 1e-4;
    if (spiked) {
      out.push({ x: vertex.x + prev.ox, y: vertex.y + prev.oy });
      out.push({ x: vertex.x + cur.ox, y: vertex.y + cur.oy });
    } else {
      out.push(hit);
    }
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
