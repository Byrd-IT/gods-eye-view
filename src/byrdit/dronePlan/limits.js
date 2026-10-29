/**
 * Box limits for the Drone Flight Plan tool. A DJI Mini flies a few hundred
 * metres from its pilot, so a box must be big enough to plan and small enough
 * to fly; anything larger needs several launch points, which is a different
 * job. Messages go through msg() so the catalogs carry them.
 */
import { msg } from '../../i18n/index.js';
import { lonSpanDeg, metersPerDegree, shorterLonEdges } from './geo.js';

export const MIN_BOX_SIDE_M = 20;
export const MAX_BOX_SIDE_M = 3000;

/**
 * @param {{west:number,south:number,east:number,north:number}} box Degrees.
 * @returns {{ok:true, box:object} | {ok:false, reason:string, message:string}}
 */
export function validateDroneBox(box) {
  const edges = [box?.west, box?.south, box?.east, box?.north].map(Number);
  if (!edges.every(Number.isFinite)) {
    return {
      ok: false,
      reason: 'invalid',
      message: msg('Box edges must be finite'),
    };
  }
  const lons = shorterLonEdges(edges[0], edges[2]);
  const normalized = {
    west: lons.west,
    east: lons.east,
    south: Math.min(edges[1], edges[3]),
    north: Math.max(edges[1], edges[3]),
  };
  const m = metersPerDegree((normalized.south + normalized.north) / 2);
  const width = lonSpanDeg(normalized.west, normalized.east) * m.lon;
  const height = (normalized.north - normalized.south) * m.lat;
  if (width < MIN_BOX_SIDE_M || height < MIN_BOX_SIDE_M) {
    return {
      ok: false,
      reason: 'degenerate',
      message: msg('Drag a bigger box (at least 20 m a side)'),
    };
  }
  if (width > MAX_BOX_SIDE_M || height > MAX_BOX_SIDE_M) {
    return {
      ok: false,
      reason: 'too-large',
      message: msg('Box is too big to fly (3 km a side at most)'),
    };
  }
  return { ok: true, box: normalized };
}
