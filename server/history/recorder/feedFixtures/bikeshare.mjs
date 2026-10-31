// Fixtures for the bikeshare group: the GBFS answers /api/gbfs serves for one system. Positions
// come from station_information, so each fixture primes the tee with it first.
import { createStationDirectory, statusInput } from '../adapters/bikeshare.js';

export const GBFS_BASE = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en';
export const GBFS_SYSTEM = 'gbfs.lyft.com/gbfs/2.3/bkn/en';
const proxied = (name) =>
  `/api/gbfs/${encodeURIComponent(`${GBFS_BASE}/${name}.json`)}`;

export const informationBody = ({ noise = {}, count = 3 } = {}) => ({
  last_updated: 1_700_000_000,
  ttl: 300,
  version: '2.3',
  data: {
    stations: Array.from({ length: count }, (_, i) => ({
      station_id: `S${i + 1}`,
      name: `Station ${i + 1}`,
      lat: 40.65 + ((i * 7919) % 1000) / 10_000,
      lon: -73.95 + ((i * 104729) % 1000) / 10_000,
      capacity: 30,
      ...noise,
    })),
  },
});

const station = (id, bikes, docks, reportedS, extra = {}) => ({
  station_id: id,
  num_bikes_available: bikes,
  num_ebikes_available: 1,
  num_docks_available: docks,
  num_bikes_disabled: 0,
  num_docks_disabled: 0,
  is_installed: true,
  is_renting: true,
  is_returning: true,
  last_reported: reportedS,
  ...extra,
});

export const bikeshareFixtures = [
  {
    feed: 'bikeshare',
    group: 'bikeshare',
    path: proxied('station_status'),
    prime: [
      {
        path: proxied('station_information'),
        body: informationBody({}),
      },
    ],
    kind: 'json',
    // Three located stations and one the directory has never heard of.
    expectedRows: 4,
    // Some thousand stations in one system.
    perf: (clock, variant = 0) => {
      const s = Math.floor(clock / 1000) + variant * 60;
      return JSON.stringify({
        last_updated: s,
        ttl: 60,
        version: '2.3',
        data: {
          stations: Array.from({ length: 3_000 }, (_, i) =>
            station(
              `S${i + 1}`,
              (i + variant) % 25,
              30 - ((i + variant) % 25),
              s - (i % 50),
            ),
          ),
        },
      });
    },
    perfPrime: [
      {
        path: proxied('station_information'),
        body: informationBody({ count: 3_000 }),
      },
    ],
    build({ clock, variant = 0, noise = {} }) {
      const s = Math.floor(clock / 1000) + variant * 60;
      return {
        last_updated: s,
        ttl: 60,
        version: '2.3',
        data: {
          stations: [
            station('S1', 8 - variant, 20 + variant, s - 20, { ...noise }),
            // GBFS 1.x writes the flags as 0 and 1.
            station('S2', 0, 30 - variant, s - 40, {
              is_renting: 0,
              is_installed: 1,
              num_ebikes_available: undefined,
            }),
            station('S3', 12 + variant, 18 - variant, s - 5),
            // Not in station_information: recorded without a position.
            station('S99', 3 - variant, 7 + variant, s - 9),
            // No id: kept out.
            { num_bikes_available: 2, last_reported: s },
          ],
        },
        ...noise,
      };
    },
    // What the route hands the adapter: the answer joined with the learned positions.
    adapterInput(payload) {
      const directory = createStationDirectory();
      directory.learn(GBFS_SYSTEM, informationBody({}));
      return statusInput(GBFS_SYSTEM, payload, directory);
    },
  },
];

export { proxied as gbfsProxyPath };
