/**
 * Fixture Overpass answers for the building-lookup tests. Generated, never
 * fetched: no test may reach the network. Buildings are rectangles placed in
 * metres east/north of CENTRE, in the shape `out tags geom;` returns.
 */
import { metersPerDegree } from './geo.js';

export const CENTRE = Object.freeze({ lon: -97.77, lat: 30.27 });

/** Degrees box `w` x `h` metres around CENTRE. */
export function boxAround(w, h, centre = CENTRE) {
  const m = metersPerDegree(centre.lat);
  return {
    west: centre.lon - w / 2 / m.lon,
    east: centre.lon + w / 2 / m.lon,
    south: centre.lat - h / 2 / m.lat,
    north: centre.lat + h / 2 / m.lat,
  };
}

/** A rect panel area (`kind: 'rect'`) around CENTRE. */
export const rectArea = (w, h, id = 'a1') => ({
  id,
  name: id,
  kind: 'rect',
  box: boxAround(w, h),
});

/** Closed rectangle geometry centred dx, dy metres from CENTRE. */
export function rectGeometry(dx, dy, w, h, centre = CENTRE) {
  const m = metersPerDegree(centre.lat);
  const at = (x, y) => ({
    lon: centre.lon + (dx + x) / m.lon,
    lat: centre.lat + (dy + y) / m.lat,
  });
  const ring = [
    at(-w / 2, -h / 2),
    at(w / 2, -h / 2),
    at(w / 2, h / 2),
    at(-w / 2, h / 2),
  ];
  return [...ring, ring[0]];
}

export const way = (id, dx, dy, w, h, tags = {}) => ({
  type: 'way',
  id,
  tags: { building: 'yes', ...tags },
  geometry: rectGeometry(dx, dy, w, h),
});

export const relation = (id, dx, dy, w, h, tags = {}) => ({
  type: 'relation',
  id,
  tags: { building: 'yes', type: 'multipolygon', ...tags },
  members: [
    {
      type: 'way',
      ref: id * 10,
      role: 'outer',
      geometry: rectGeometry(dx, dy, w, h),
    },
    {
      type: 'way',
      ref: id * 10 + 1,
      role: 'inner',
      geometry: rectGeometry(dx, dy, w / 3, h / 3),
    },
  ],
});

/** What a 300 x 200 m area at CENTRE returns (see the comments per element). */
export function downtownPayload() {
  return {
    version: 0.6,
    generator: 'fixture',
    elements: [
      way(101, -60, 0, 30, 20, { name: 'Hall', height: '12' }),
      way(102, 60, 0, 20, 20, { 'building:levels': '4' }),
      way(103, 0, 50, 10, 10),
      way(104, 100, 80, 3, 3),
      // Two adjoining buildings: their orbits overlap, so they merge.
      way(105, 0, -60, 15, 15, { height: '9' }),
      way(106, 20, -60, 15, 15, { height: '6 m' }),
      // Centroid far outside a 300 x 200 m area.
      way(107, 800, 0, 20, 20),
      // Multipolygon building (inner ring ignored), height in feet.
      relation(201, -60, -60, 25, 25, { height: "30'" }),
      // Not a building at all.
      {
        type: 'way',
        id: 999,
        tags: { highway: 'service' },
        geometry: rectGeometry(0, 0, 5, 5),
      },
    ],
  };
}

export const okResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});
