import { normalizeAdsbLolPointResponse } from '../../../../src/data/adsbLolFallback.js';

// Fixtures for the aircraft group: payloads shaped like what the proxy routes serve.
// `build` returns the body object; variant 1 is a later poll with moved aircraft.
const state = (hex, callsign, lat, lon, seenS, extra = []) => [
  hex,
  callsign,
  'United States',
  seenS,
  seenS,
  lon,
  lat,
  10668,
  false,
  230.5,
  271.2,
  0,
  null,
  10700,
  '1200',
  false,
  0,
  4,
  ...extra,
];

export const aircraftFixtures = [
  {
    feed: 'aircraft',
    group: 'aircraft',
    path: '/api/flights',
    replayHeader: 'X-OpenSky-Cache',
    kind: 'json',
    replay: { header: ['X-OpenSky-Cache', 'HIT'] },
    expectedRows: 3,
    // A world-wide poll: about twelve thousand aircraft.
    perf: (clock, variant = 0) => {
      const s = Math.floor(clock / 1000) + variant * 10;
      const move = variant * 0.05;
      return JSON.stringify({
        time: s,
        states: Array.from({ length: 12_000 }, (_, i) =>
          state(
            (0x100000 + i).toString(16),
            `FLT${i}`,
            ((i * 7919) % 17000) / 100 - 85 + move,
            ((i * 104729) % 35000) / 100 - 175,
            s - (i % 30),
          ),
        ),
      });
    },
    build({ clock, variant = 0, noise = {} }) {
      const s = Math.floor(clock / 1000) + variant * 10;
      const move = variant * 0.05;
      return {
        time: s,
        states: [
          state('a1b2c3', 'UAL123  ', 30.1 + move, -97.7, s - 2, [
            { ...noise },
          ]),
          state('abcdef', 'DAL45', 40.7 + move, -74.0, s - 5),
          state('00ff10', null, -33.9 + move, 151.2, s - 9),
          // No position: kept out.
          [
            '123456',
            'NOPOS',
            'X',
            s,
            s,
            null,
            null,
            null,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            false,
            0,
            0,
          ],
          // Not a 24-bit address: kept out.
          state('zzzz', 'BAD', 1, 1, s),
        ],
        // Keys the adapter does not know must never be stored.
        ...noise,
      };
    },
  },
  {
    feed: 'military',
    group: 'aircraft',
    path: '/api/military',
    replayHeader: 'X-Feed-Cache',
    kind: 'json',
    replay: { header: ['X-Feed-Cache', 'HIT'] },
    expectedRows: 2,
    build({ clock, variant = 0, noise = {} }) {
      const now = clock + variant * 15_000;
      const move = variant * 0.05;
      return {
        now,
        total: 3,
        ac: [
          {
            hex: 'ae1234',
            flight: 'RCH401  ',
            r: '08-8190',
            t: 'C17',
            lat: 38.9 + move,
            lon: -77.0,
            alt_baro: 31000,
            gs: 440,
            track: 90,
            squawk: '4301',
            dbFlags: 1,
            seen_pos: 1.5,
            ...noise,
          },
          {
            hex: 'ae5678',
            flight: 'REACH12',
            lat: 32.7 + move,
            lon: -96.8,
            alt_baro: 'ground',
            gs: 0,
            seen_pos: 4,
          },
          { hex: 'ae9999', flight: 'NOPOS' },
        ],
        ...noise,
      };
    },
  },
];

/**
 * What /api/flights serves when OpenSky is down: an adsb.lol v2 point answer
 * rewritten into the OpenSky shape by the proxy's own normaliser, so the fixture
 * cannot drift from it. `nowMs` is adsb.lol's clock; `hexes` are the aircraft
 * around the caller's view.
 */
export function adsbLolFallbackBody({ nowMs, hexes = ['a1b2c3'], lat = 30.1 }) {
  return normalizeAdsbLolPointResponse({
    now: nowMs,
    total: hexes.length,
    ac: hexes.map((hex, i) => ({
      hex,
      flight: `FALL${i}   `,
      lat: lat + i * 0.01,
      lon: -97.7,
      alt_baro: 12000,
      alt_geom: 12100,
      gs: 250,
      track: 90,
      seen: 1,
      seen_pos: 1.5,
      category: 'A3',
    })),
  });
}
