#!/usr/bin/env node
/**
 * Check GEV KMZ files against the form DJI Fly writes when it re-saves them.
 *
 *   compare   <ours.kmz> <dji-resaved.kmz> [--their-count N]
 *       Structural diff (coordinates within 1 cm, everything else exact).
 *   rewrite   <gev.kmz> <out.kmz> [--created-ms N]
 *       Read the mission back out of a GEV KMZ (any writer version) and write
 *       it again with the current writer, in DJI Fly's form.
 *   selfcheck <gev.kmz>
 *       Read the mission back out of a KMZ and write it again with the current
 *       writer; the two must be identical. Proves the file is in the current
 *       writer's form (a live export of the running service).
 *
 * Exit 0 when there are no differences, 1 otherwise. Real DJI Fly files hold
 * real coordinates: keep them out of the repository.
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { planFlight } from '../src/byrdit/dronePlan/planner.js';
import { buildKmz, buildMissionFiles } from '../src/byrdit/dronePlan/wpml.js';
import {
  compareWaylines,
  missionFromWaylines,
} from '../src/byrdit/dronePlan/wpmlCompare.mjs';

// DJI Fly's own KMZ is deflated; GEV's zip reader only does stored entries.
const read = (file) =>
  execFileSync('unzip', ['-p', file, 'wpmz/waylines.wpml'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
const preset = planFlight(
  { west: -97.77, east: -97.769, south: 30.27, north: 30.271 },
  { aglM: 100 },
).preset;
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const missionOf = (xml) => {
  const input = missionFromWaylines(xml);
  const waypoints = input.legs.flatMap((l) => l.waypoints);
  return {
    mission: { legs: input.legs, waypoints, waypointCount: waypoints.length },
    plan: { preset, speedMs: input.speedMs },
  };
};
const report = (diffs) => {
  if (!diffs.length) {
    console.log('IDENTICAL: zero structural differences');
    return 0;
  }
  console.log(`${diffs.length} difference(s):`);
  for (const d of diffs.slice(0, 20)) console.log(`- ${d}`.slice(0, 1500));
  return 1;
};

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'compare') {
  const their = flag('--their-count');
  process.exit(
    report(
      compareWaylines(read(a), read(b), {
        theirCount: their ? Number(their) : undefined,
      }),
    ),
  );
} else if (cmd === 'rewrite') {
  const { mission, plan } = missionOf(read(a));
  const created = flag('--created-ms');
  writeFileSync(
    b,
    buildKmz(mission, plan, created ? { createdMs: Number(created) } : {}),
  );
  console.log(`wrote ${b}: ${mission.waypointCount} waypoints`);
} else if (cmd === 'selfcheck') {
  const xml = read(a);
  const { mission, plan } = missionOf(xml);
  process.exit(
    report(
      compareWaylines(
        // DJI Fly's own re-save has no gimbalRotate on every waypoint.
        buildMissionFiles(mission, plan, { explicitWaypointGimbal: false })
          .waylinesWpml,
        xml,
      ),
    ),
  );
} else {
  console.error('usage: compare | rewrite | selfcheck (see the file header)');
  process.exit(2);
}
