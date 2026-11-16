/**
 * Pure geometry for editing a survey area after it is drawn (no DOM, no
 * Cesium). An area is `{kind: 'polygon', ring: [{lon, lat}, ...]}` or a box
 * (`kind: 'rect'`) `{west, south, east, north}`. Every function returns a new
 * shape and leaves its input alone, so a drag can restart from the shape it
 * began with and never drifts. Moves are computed in the local east/north
 * frame in metres (see geo.js), not in raw degrees, so a drag at 60° N moves
 * the area by as many metres as the pointer travelled.
 */
import { msg } from '../../i18n/index.js';
import { bboxOfPoints, unwrapCenter } from './areas.js';
import {
  deltaLon,
  makeFrame,
  metersPerDegree,
  shorterLonEdges,
  wrapLon,
} from './geo.js';
import { validateDroneBox } from './limits.js';
import { selfIntersects } from './polygon.js';

export const MIN_POLYGON_CORNERS = 3;

/** The four corners of a box, by compass name. */
export const BOX_CORNERS = Object.freeze(['sw', 'se', 'ne', 'nw']);

const OPPOSITE = Object.freeze({ sw: 'ne', se: 'nw', ne: 'sw', nw: 'se' });

/** Longitude in (-180, 180], untouched (no rounding noise) when already there. */
const normLon = (lon) => (lon > 180 || lon <= -180 ? wrapLon(lon) : lon);

const finitePoint = (p) =>
  Number.isFinite(Number(p?.lon)) &&
  Number.isFinite(Number(p?.lat)) &&
  Math.abs(Number(p.lat)) <= 90;

/** @returns {boolean} true for a polygon, false for a box. */
export function isPolygonShape(shape) {
  return shape?.kind === 'polygon';
}

/** The corners of a box as {lon, lat}, keyed sw/se/ne/nw. */
export function boxCorners(box) {
  return {
    sw: { lon: box.west, lat: box.south },
    se: { lon: box.east, lat: box.south },
    ne: { lon: box.east, lat: box.north },
    nw: { lon: box.west, lat: box.north },
  };
}

/** Where the box centre is, the short way across the antimeridian. */
export function boxCentre(box) {
  return {
    lon: wrapLon(box.west + deltaLon(box.west, box.east) / 2),
    lat: (box.south + box.north) / 2,
  };
}

/** The point to hang the move handle on: the box centre or the ring's mean. */
export function shapeCentre(shape) {
  if (isPolygonShape(shape)) return unwrapCenter(shape.ring);
  return boxCentre(shape.box);
}

/** A local frame centred on the shape. */
function frameOf(shape) {
  const centre = shapeCentre(shape);
  return makeFrame(centre.lon, centre.lat);
}

/** Ring corner `index` set to `point`. Null when the index is out of range. */
export function moveVertex(ring, index, point) {
  if (!Array.isArray(ring) || !Number.isInteger(index)) return null;
  if (index < 0 || index >= ring.length) return null;
  if (!finitePoint(point)) return null;
  const next = ring.map((p) => ({ lon: p.lon, lat: p.lat }));
  next[index] = { lon: normLon(Number(point.lon)), lat: Number(point.lat) };
  return next;
}

/** The midpoint of edge `index` (corner `index` to the next), in metres. */
export function edgeMidpoint(ring, index) {
  const a = ring[index];
  const b = ring[(index + 1) % ring.length];
  const frame = makeFrame(a.lon, (a.lat + b.lat) / 2);
  const p = frame.toXY(a.lon, a.lat);
  const q = frame.toXY(b.lon, b.lat);
  return frame.toLonLat((p.x + q.x) / 2, (p.y + q.y) / 2);
}

/** The midpoint of every edge; entry i belongs to the edge from corner i. */
export function edgeMidpoints(ring) {
  return ring.map((_, i) => edgeMidpoint(ring, i));
}

/**
 * Add a corner at the midpoint of edge `edgeIndex`.
 * @returns {{ring: {lon:number,lat:number}[], index: number}|null} The new
 *   ring and the index of the corner just added.
 */
export function insertVertexAtEdge(ring, edgeIndex) {
  if (!Array.isArray(ring) || !Number.isInteger(edgeIndex)) return null;
  if (edgeIndex < 0 || edgeIndex >= ring.length || ring.length < 2) return null;
  const next = ring.map((p) => ({ lon: p.lon, lat: p.lat }));
  next.splice(edgeIndex + 1, 0, edgeMidpoint(ring, edgeIndex));
  return { ring: next, index: edgeIndex + 1 };
}

/** The ring without corner `index`, or null when that would leave fewer than 3. */
export function removeVertex(ring, index) {
  if (!Array.isArray(ring) || !Number.isInteger(index)) return null;
  if (ring.length <= MIN_POLYGON_CORNERS) return null;
  if (index < 0 || index >= ring.length) return null;
  return ring.filter((_, i) => i !== index).map((p) => ({ ...p }));
}

/**
 * Metres east and north from `from` to `to`, measured in the local frame at
 * `from`, the short way across the antimeridian.
 */
export function metricOffset(from, to) {
  const frame = makeFrame(from.lon, from.lat);
  const q = frame.toXY(to.lon, to.lat);
  return { dxM: q.x, dyM: q.y };
}

/** `point` moved `dxM` east and `dyM` north (metres, local frame at the point). */
export function translatePoint(point, dxM, dyM) {
  if (!(Number.isFinite(dxM) && Number.isFinite(dyM))) return null;
  const frame = makeFrame(point.lon, point.lat);
  return frame.toLonLat(dxM, dyM);
}

/**
 * The shape moved by `dxM` east and `dyM` north. A polygon moves corner by
 * corner through the local frame; a box moves its edges by the equivalent
 * degrees at its centre, so it stays an axis-aligned rectangle.
 * @returns {{kind:string, ring?:object[], box?:object}}
 */
export function moveArea(shape, dxM, dyM) {
  if (!(Number.isFinite(dxM) && Number.isFinite(dyM))) return null;
  if (isPolygonShape(shape)) {
    const frame = frameOf(shape);
    const ring = shape.ring.map((p) => {
      const xy = frame.toXY(p.lon, p.lat);
      return frame.toLonLat(xy.x + dxM, xy.y + dyM);
    });
    return { kind: 'polygon', ring };
  }
  const centre = boxCentre(shape.box);
  const m = metersPerDegree(centre.lat);
  const dLon = dxM / m.lon;
  const dLat = dyM / m.lat;
  const { west, south, east, north } = shape.box;
  return {
    kind: shape.kind ?? 'rect',
    box: {
      west: normLon(west + dLon),
      east: normLon(east + dLon),
      south: south + dLat,
      north: north + dLat,
    },
  };
}

/** The shape moved so the point `from` lands on `to`. */
export function moveAreaBy(shape, from, to) {
  const { dxM, dyM } = metricOffset(from, to);
  return moveArea(shape, dxM, dyM);
}

/**
 * Drag one corner of an axis-aligned box: the opposite corner stays, the
 * dragged corner goes to `point`. Dragging past the opposite corner flips the
 * box rather than refusing, and a box across ±180° stays on the short arc.
 * @param {{west:number,south:number,east:number,north:number}} box
 * @param {'sw'|'se'|'ne'|'nw'} corner
 * @param {{lon:number,lat:number}} point
 * @returns {{west:number,south:number,east:number,north:number}|null}
 */
export function boxFromCorner(box, corner, point) {
  const opposite = OPPOSITE[corner];
  if (!opposite || !finitePoint(point)) return null;
  const fixed = boxCorners(box)[opposite];
  const lons = shorterLonEdges(fixed.lon, normLon(Number(point.lon)));
  return {
    west: lons.west,
    east: lons.east,
    south: Math.min(fixed.lat, Number(point.lat)),
    north: Math.max(fixed.lat, Number(point.lat)),
  };
}

/**
 * The existing validators, applied to an edited shape: finite corners, at
 * least 3 of them, no self-crossing, and the same 20 m to 3 km size limits a
 * newly drawn box or polygon must meet.
 * @returns {{ok:true, shape:object} | {ok:false, reason:string, message:string}}
 */
export function validateEditedShape(shape) {
  if (isPolygonShape(shape)) {
    const ring = shape.ring;
    if (!Array.isArray(ring) || ring.length < MIN_POLYGON_CORNERS) {
      return {
        ok: false,
        reason: 'too-few-corners',
        message: msg('A polygon needs at least 3 corners'),
      };
    }
    if (!ring.every(finitePoint)) {
      return {
        ok: false,
        reason: 'invalid',
        message: msg('Box edges must be finite'),
      };
    }
    const centre = unwrapCenter(ring);
    const frame = makeFrame(centre.lon, centre.lat);
    if (selfIntersects(ring.map((p) => frame.toXY(p.lon, p.lat)))) {
      return {
        ok: false,
        reason: 'self-intersecting',
        message: msg(
          'That polygon crosses itself. Remove a corner or draw it again.',
        ),
      };
    }
    const checked = validateDroneBox(bboxOfPoints(ring));
    if (!checked.ok) return checked;
    return { ok: true, shape: { kind: 'polygon', ring, box: checked.box } };
  }
  const checked = validateDroneBox(shape?.box);
  if (!checked.ok) return checked;
  return { ok: true, shape: { kind: shape.kind ?? 'rect', box: checked.box } };
}
