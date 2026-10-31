// Fixtures for the transit group: the snapshot /api/transit/vehicles/<operator> serves.
// `build` returns the body object; variant 1 is a later fetch with moved vehicles.
const vehicle = (id, lat, lon, timestamp, source, extra = {}) => ({
  id,
  lat,
  lon,
  bearing: 90,
  speedMps: 7.5,
  timestamp,
  timestampSource: source,
  routeId: '10',
  tripId: `trip-${id}`,
  directionId: 1,
  label: `Bus ${id}`,
  stopId: 'S100',
  status: 'IN_TRANSIT_TO',
  occupancy: 'FEW_SEATS_AVAILABLE',
  ...extra,
});

const snapshot = (feedId, vehicles, clock, variant, extra = {}) => ({
  feedId,
  name: 'Fixture Transit',
  fetchedAt: clock + variant * 15_000,
  feedTimestamp: Math.floor(clock / 1000) + variant * 15 - 4,
  version: '2.0',
  entityCount: vehicles.length,
  truncated: false,
  count: vehicles.length,
  vehicles,
  ...extra,
});

export const transitFixtures = [
  {
    feed: 'transit',
    group: 'transit',
    path: '/api/transit/vehicles/ttc-toronto',
    replayHeader: 'X-GEV-Cache',
    kind: 'json',
    expectedRows: 3,
    // Every operator at once: about twelve thousand vehicles.
    perf: (clock, variant = 0) => {
      const s = Math.floor(clock / 1000) + variant * 15;
      return JSON.stringify(
        snapshot(
          'ttc-toronto',
          Array.from({ length: 12_000 }, (_, i) =>
            vehicle(
              `V${i}`,
              43 + ((i * 7919) % 1000) / 1000 + variant * 0.001,
              -79.5 + ((i * 104729) % 1000) / 1000,
              s - (i % 20),
              'vehicle',
            ),
          ),
          clock,
          variant,
        ),
      );
    },
    build({ clock, variant = 0, noise = {} }) {
      const s = Math.floor(clock / 1000) + variant * 15;
      const move = variant * 0.001;
      return snapshot(
        'ttc-toronto',
        [
          vehicle('1001', 43.65 + move, -79.38, s - 3, 'vehicle', { ...noise }),
          // No timestamp of its own: the proxy used the feed header's.
          vehicle('1002', 43.7 + move, -79.4, s - 4, 'header', {
            speedMps: null,
            bearing: null,
          }),
          // Neither: the proxy used its own fetch time, which is a guess.
          vehicle('1003', 43.6 + move, -79.5, s, 'fetch', { stopId: null }),
          // Null island and no position: kept out.
          vehicle('ghost', 0, 0, s, 'vehicle'),
          vehicle('lost', null, null, s, 'vehicle'),
        ],
        clock,
        variant,
        { ...noise },
      );
    },
  },
];
