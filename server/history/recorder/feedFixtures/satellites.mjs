// Fixtures for the satellites group: CelesTrak TLE text as /api/celestrak/<group> serves it.
import { fromText } from '../adapters/satellites.js';

// Lines are built with a real checksum so the adapter's own checks are exercised.
const checksum = (line) => {
  let sum = 0;
  for (const c of line.slice(0, 68)) {
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return sum % 10;
};
const seal = (line) => `${line.padEnd(68)}${checksum(line.padEnd(68))}`;

const epochOf = (ms) => {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const day = (ms - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  return `${String(year % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
};

/** One element set. `satnum` is the five-character catalogue field. */
export function tle({
  name,
  satnum,
  epochMs,
  anomaly = 325.0288,
  rev = 56353,
}) {
  const line1 = seal(
    `1 ${satnum}U 98067A   ${epochOf(epochMs)} -.00002182  00000-0 -11606-4 0  292`,
  );
  const line2 = seal(
    `2 ${satnum}  51.6416 247.4627 0006703 130.5360 ${anomaly.toFixed(4).padStart(8)} 15.72125391${String(rev).padStart(5)}`,
  );
  return { name, line1, line2, text: `${name}\n${line1}\n${line2}\n` };
}

export const satelliteFixtures = [
  {
    feed: 'satellites',
    group: 'satellites',
    path: '/api/celestrak/stations',
    kind: 'text',
    expectedRows: 3,
    // Catalogue-sized groups the recorder leaves alone.
    ignoredPaths: ['/api/celestrak/starlink', '/api/celestrak/active'],
    replay: ['X-TLE-Cache', 'HIT'],
    // The adapter's input for a text answer: what the route's payload hook builds.
    adapterInput: (text) => fromText(text),
    build({ clock, variant = 0, noise = {} }) {
      // A later poll carries newer epochs (about every 6 h).
      const at = (hoursAgo) =>
        clock - hoursAgo * 3_600_000 + variant * 6 * 3_600_000;
      const noisy = Object.values(noise).join(' ');
      const sets = [
        tle({ name: 'ISS (ZARYA)', satnum: '25544', epochMs: at(5) }),
        tle({ name: 'CSS (TIANHE)', satnum: '48274', epochMs: at(9) }),
        // Alpha-5 catalogue number 100000; with noise, the name field carries it.
        tle({
          name: noisy || 'FUTURE-SAT 1',
          satnum: 'A0000',
          epochMs: at(2),
        }),
      ];
      // Wrong checksum: kept out.
      const broken = tle({ name: 'BROKEN', satnum: '99999', epochMs: at(1) });
      const badLine = `${broken.line1.slice(0, 68)}${(Number(broken.line1[68]) + 1) % 10}`;
      return [
        ...sets.map((set) => set.text),
        `BROKEN\n${badLine}\n${broken.line2}\n`,
        // Text the parser does not take as a set: never stored.
        ...Object.values(noise).map((value) => `${value}\n`),
      ].join('');
    },
  },
];
