// Fixtures for the hazards group: cyclones, fire perimeters, launches.
// `build` returns the body the proxy route serves; variant 1 is a later poll.
// `replay` says how a proxy marks an answer it serves again (a header, or build options).
const HOUR = 3_600_000;

const storm = (id, name, lat, lon, positionAt, extra = {}) => ({
  id,
  name,
  classification: 'HU',
  basin: id.slice(0, 2).toUpperCase(),
  position: { latitude: lat, longitude: lon },
  positionAt: new Date(positionAt).toISOString(),
  advisoryNumber: '12',
  issuedAt: new Date(positionAt).toISOString(),
  windKt: 85,
  pressureHpa: 975,
  movement: { directionDegrees: 310, speedKt: 9 },
  advisoryUrl: null,
  geometryStatus: 'current',
  forecastPoints: [
    {
      position: { latitude: lat + 0.5, longitude: lon - 0.5 },
      tauHours: 12,
      windKt: 90,
      gustKt: 110,
    },
    {
      position: { latitude: lat + 1, longitude: lon - 1 },
      tauHours: 24,
      windKt: 95,
      gustKt: 115,
    },
  ],
  // Geometry the adapter must leave out.
  track: {
    type: 'LineString',
    coordinates: [
      [lon, lat],
      [lon - 1, lat + 1],
    ],
  },
  cone: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  ...extra,
});

const ring = (west, south, east, north, steps = 4) => {
  const points = [];
  for (let i = 0; i < steps; i++)
    points.push([west + ((east - west) * i) / steps, south]);
  for (let i = 0; i < steps; i++)
    points.push([east, south + ((north - south) * i) / steps]);
  for (let i = 0; i < steps; i++)
    points.push([east - ((east - west) * i) / steps, north]);
  for (let i = 0; i < steps; i++)
    points.push([west, north - ((north - south) * i) / steps]);
  points.push(points[0]);
  return points;
};

const fire = (stableId, name, acres, updatedTime, box, extra = {}) => ({
  stableId,
  name,
  acres,
  containedPct: 20,
  state: 'US-CA',
  category: 'WF',
  discoveredTime: updatedTime - 5 * 24 * HOUR,
  updatedTime,
  cause: 'Human',
  behavior: null,
  personnel: 120,
  county: 'Shasta',
  costToDate: 1_500_000,
  complexity: 'Type 3',
  complexName: null,
  polygons: [[ring(...box)]],
  ...extra,
});

const launch = (id, name, lastUpdated, extra = {}) => ({
  id,
  name,
  last_updated: new Date(lastUpdated).toISOString(),
  status: { id: 1, name: 'Go for Launch', abbrev: 'Go' },
  net: new Date(lastUpdated + 2 * HOUR).toISOString(),
  window_start: new Date(lastUpdated + 2 * HOUR).toISOString(),
  window_end: new Date(lastUpdated + 4 * HOUR).toISOString(),
  launch_service_provider: { name: 'SpaceX' },
  rocket: {
    configuration: { name: 'Falcon 9', full_name: 'Falcon 9 Block 5' },
  },
  mission: {
    name: 'Starlink 10-1',
    type: 'Communications',
    orbit: { abbrev: 'LEO' },
    description: 'x'.repeat(2000),
  },
  pad: {
    name: 'Space Launch Complex 40',
    latitude: '28.56194122',
    longitude: '-80.57735736',
    location: { name: 'Cape Canaveral SFS, FL, USA' },
  },
  probability: 80,
  webcast_live: false,
  // Detail the adapter must leave out.
  timeline: Array.from({ length: 50 }, (_, i) => ({
    relative_time: `PT${i}S`,
  })),
  trajectory: [[1, 2, 3]],
  ...extra,
});

export const hazardFixtures = [
  {
    feed: 'cyclones',
    group: 'hazards',
    path: '/api/cyclones',
    kind: 'json',
    expectedRows: 2,
    // A body the proxy marks stale is the old fetch served again.
    replay: { options: { stale: true } },
    build({ clock, variant = 0, noise = {}, stale = false }) {
      const at = clock - HOUR + variant * 3 * HOUR;
      return {
        schemaVersion: 1,
        source: 'NOAA NHC / CPHC',
        fetchedAt: clock + variant * 15_000,
        stale,
        unavailable: false,
        storms: [
          storm('al092026', 'IAN', 24.5 + variant * 0.4, -83.2, at, {
            ...noise,
          }),
          storm('ep052026', 'ELIDA', 15.2, -110.3 - variant, at),
          // No position: kept out.
          {
            id: 'cp012026',
            name: 'NOPOS',
            positionAt: new Date(at).toISOString(),
          },
          // Not an NHC id: kept out.
          storm('xx000000', 'BAD', 1, 1, at),
        ],
        ...noise,
      };
    },
  },
  {
    feed: 'perimeters',
    group: 'hazards',
    path: '/api/fire-perimeters',
    kind: 'json',
    expectedRows: 2,
    replay: { header: ['X-Data-Stale', 'true'] },
    build({ clock, variant = 0, noise = {} }) {
      const updated = clock - 6 * HOUR + variant * HOUR;
      return {
        fetchedAt: clock + variant * HOUR,
        rows: [
          fire(
            '2026-CASHF-000123',
            'Pine Fire',
            4200 + variant * 300,
            updated,
            [-122.5, 40.5, -122.1, 40.9],
            { ...noise },
          ),
          fire(
            '2026-OROR-000456',
            'Ridge Fire',
            90 + variant * 10,
            updated,
            [-121.9, 44.1, -121.8, 44.2],
            { complexName: 'Ridge Complex' },
          ),
          // No geometry: kept out.
          {
            ...fire('2026-WAWA-000789', 'Empty', 1, updated, [0, 0, 1, 1]),
            polygons: [],
          },
          // Not a string id: kept out.
          { ...fire('x', 'Bad', 1, updated, [0, 0, 1, 1]), stableId: 5 },
        ],
        ...noise,
      };
    },
  },
  {
    feed: 'launches',
    group: 'hazards',
    path: '/api/launches',
    kind: 'json',
    expectedRows: 2,
    replay: { header: ['X-GEV-Cache', 'HIT'] },
    build({ clock, variant = 0, noise = {} }) {
      const updated = clock - HOUR + variant * 20 * 60_000;
      return {
        count: 3,
        results: [
          launch(
            '11111111-aaaa-bbbb-cccc-000000000001',
            'Falcon 9 Block 5 | Starlink 10-1',
            updated,
            { ...noise },
          ),
          launch(
            '11111111-aaaa-bbbb-cccc-000000000002',
            'Electron | Test',
            updated,
            {
              pad: {
                name: 'LC-1A',
                latitude: -39.26,
                longitude: 177.86,
                location: { name: 'Mahia, NZ' },
              },
            },
          ),
          // No id: kept out.
          { name: 'No id', last_updated: new Date(updated).toISOString() },
        ],
        ...noise,
      };
    },
  },
];
