// Fixtures for the vessels group: the snapshot /api/vessels serves from the AISStream cache.
// `build` returns the body object; variant 1 is a later snapshot with moved vessels and new report times.
const row = (mmsi, name, lat, lon, epochS, extra = {}) => ({
  lat,
  lon,
  name,
  mmsi,
  imo: '',
  type: '70',
  destination: 'ROTTERDAM',
  speed: 12.4,
  course: 271.5,
  heading: 270,
  last_position_UTC: new Date(epochS * 1000).toISOString(),
  last_position_epoch: epochS,
  ...extra,
});

const snapshot = (rows, clock, variant, extra = {}) => ({
  rows,
  source: 'AISStream',
  status: 'live',
  error: null,
  refreshing: false,
  newestPositionAt: rows[0]?.last_position_UTC ?? null,
  lastMessageAt: clock + variant * 15_000,
  silentForMs: 0,
  reconnectAttempt: 0,
  nextAttemptAt: null,
  staleAfterMs: 120_000,
  watchdog: 'armed',
  ...extra,
});

export const vesselsFixtures = [
  {
    feed: 'vessels',
    group: 'vessels',
    path: '/api/vessels',
    // The proxy sends no-store and never replays a snapshot, so there is no cache header.
    kind: 'json',
    expectedRows: 3,
    // The route still answers 200 from its cache while the websocket is down.
    notLive: { status: 'down' },
    // A worldwide snapshot: the cache holds up to 50 000 vessels.
    perf: (clock, variant = 0) => {
      const s = Math.floor(clock / 1000) + variant * 15;
      const move = variant * 0.01;
      return JSON.stringify(
        snapshot(
          Array.from({ length: 50_000 }, (_, i) =>
            row(
              String(200_000_000 + i),
              `VESSEL ${i}`,
              ((i * 7919) % 17000) / 100 - 85 + move,
              ((i * 104729) % 35000) / 100 - 175,
              s - (i % 120),
            ),
          ),
          clock,
          variant,
        ),
      );
    },
    build({ clock, variant = 0, noise = {}, status = 'live' }) {
      const s = Math.floor(clock / 1000) + variant * 15;
      const move = variant * 0.01;
      return snapshot(
        [
          row('366999001', 'EVER GIVEN', 29.7 + move, -94.9, s - 20, {
            imo: '9811000',
            ...noise,
          }),
          // Only the cache's placeholder name, and no motion reported.
          row('244123456', 'MMSI 244123456', 51.9 + move, 4.1, s - 45, {
            speed: null,
            course: null,
            heading: null,
            type: '',
            destination: '',
          }),
          row('538005000', 'MAERSK ALABAMA', -33.9 + move, 18.4, s - 90),
          // No position: kept out.
          row('311000999', 'NOPOS', null, null, s),
          // Not an MMSI: kept out.
          row('abc', 'BADID', 1, 1, s),
          // No report time: kept out.
          {
            ...row('219000111', 'NOTIME', 10, 10, s),
            last_position_epoch: null,
            last_position_UTC: null,
          },
        ],
        clock,
        variant,
        { status, ...noise },
      );
    },
  },
];
