// Seed the "Suggested rerun" / "Suggested test" plans into a GEV plan library.
//
//   node scripts/seed-suggested-reruns.mjs --spec <spec.json> [--user byrdit]
//        [--root <plan dir>] [--kmz-dir <dir of reference KMZs>]
//        [--backup-dir <dir>] [--dry-run]
//
// The spec (site, centre, plans) is not in the repository: it holds a real
// location. Idempotent: re-running neither duplicates nor touches other plans.
// The plan directory is backed up first (--backup-dir, default
// <root>-backup-<time>); --dry-run writes nothing. When --kmz-dir is given,
// every plan with `reference` is checked against that KMZ and the run fails
// (before anything is written) if one is outside the tolerance.
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDjiKmz } from '../src/byrdit/dronePlan/djiKmz.js';
import {
  buildItem,
  compareToReference,
  planStats,
  referenceStats,
  seedLibrary,
} from '../src/byrdit/dronePlan/rerunSeed.js';
import {
  createStore,
  defaultRoot,
  cleanDetails,
} from '../server/byrdit/planLibrary/store.js';

function args(argv) {
  const out = { user: 'byrdit' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--'))
      out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
        argv[++i];
  }
  return out;
}

const opt = args(process.argv.slice(2));
if (!opt.spec) {
  console.error(
    'usage: seed-suggested-reruns.mjs --spec <spec.json> [options]',
  );
  process.exit(2);
}
let spec;
try {
  spec = JSON.parse(readFileSync(opt.spec, 'utf8'));
} catch {
  console.error('the spec file could not be read as JSON');
  process.exit(2);
}
if (
  !Array.isArray(spec?.plans) ||
  !spec.plans.length ||
  !Number.isFinite(spec.center?.lat) ||
  !Number.isFinite(spec.center?.lon) ||
  !Number.isFinite(spec.takeoff?.lat) ||
  !Number.isFinite(spec.takeoff?.lon)
) {
  console.error(
    'the spec needs center {lat, lon}, takeoff {lat, lon} and plans[]',
  );
  process.exit(2);
}
const root = opt.root ?? defaultRoot();

const failures = [];
for (const entry of spec.plans) {
  const stats = planStats(spec, entry);
  if (stats.error) {
    failures.push(`${entry.name}: ${stats.error}`);
    continue;
  }
  let line = `${entry.name}: ${stats.waypointCount} wp, ${stats.photoCount} photos, speed ${stats.speedMs.toFixed(2)}`;
  if (opt.kmzDir && entry.reference) {
    // Errors name the plan, never the path or the system message.
    let mission;
    try {
      const file = path.join(opt.kmzDir, entry.reference);
      mission = await parseDjiKmz(new Uint8Array(readFileSync(file)), {
        fileName: path.basename(entry.reference),
      });
    } catch {
      failures.push(`${entry.name}: reference KMZ could not be read`);
      continue;
    }
    if (mission.error) {
      failures.push(`${entry.name}: reference KMZ unusable (${mission.error})`);
      continue;
    }
    const problems = compareToReference(
      stats,
      referenceStats(mission, spec.center),
    );
    line += problems.length
      ? `  MISMATCH ${problems.join('; ')}`
      : '  matches reference';
    if (problems.length) failures.push(`${entry.name}: ${problems.join('; ')}`);
  }
  console.log(line);
}
if (failures.length) {
  console.error(
    `\n${failures.length} plan(s) failed; nothing written:\n  ${failures.join('\n  ')}`,
  );
  process.exit(1);
}

const items = spec.plans.map((e) =>
  buildItem(spec, e, (d) => cleanDetails(d, { requireName: true })),
);
if (!opt.dryRun && existsSync(root)) {
  const backup =
    opt.backupDir ??
    `${root}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  cpSync(root, backup, { recursive: true });
  console.log(`backup: ${backup}`);
}
const results = seedLibrary(createStore({ root }), opt.user, items, {
  dryRun: opt.dryRun,
});
for (const r of results)
  console.log(`${r.action.padEnd(9)} ${r.id ?? ''} ${r.name}`);
