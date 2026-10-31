#!/usr/bin/env node
/**
 * Gate for the history store (server/history/store). No browser and no server:
 * it drives the real SQLite backend on a scratch directory.
 *
 *   npm run qa:history-store
 *   node scripts/qa-history-store.mjs --json   (machine-readable report)
 *
 * Proves, against a file store:
 *   1. a loaded store answers slice, coverage and snapshots within budget
 *   2. a writer killed with SIGKILL mid-run leaves a database that opens clean,
 *      passes SQLite's integrity check and holds only whole batches
 *   3. an open read transaction neither blocks a writer nor sees its commit (WAL)
 *   4. retention removes exactly what is older than the window
 *   5. unsupported settings stop the boot before any file is created
 * Exits non-zero on the first failed check; the report names each check.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRetention, createHistoryStore } from '../server/history/store/index.js';
import { createSqliteStore } from '../server/history/store/sqlite.js';

const SELF = fileURLToPath(import.meta.url);
const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const DAY = 24 * 3600 * 1000;
const BATCH = 500;

// Wall-clock limits; GEV_QA_BUDGET_SCALE=3 triples them on a slow or shared machine.
const SCALE = Number(process.env.GEV_QA_BUDGET_SCALE) > 0 ? Number(process.env.GEV_QA_BUDGET_SCALE) : 1;
const BUDGET_MS = { slice: 100 * SCALE, coverage: 1500 * SCALE, snapshots: 500 * SCALE };

function ms(since) {
  return Number(process.hrtime.bigint() - since) / 1e6;
}

async function timed(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: ms(start) };
}

function batch(index) {
  return Array.from({ length: BATCH }, (_, i) => ({
    t: T0 + index * MIN,
    key: `v${i}`,
    lat: ((i * 7) % 180) - 90,
    lon: ((i * 13) % 360) - 180,
    data: { n: index },
  }));
}

/** Child mode: append whole batches until killed. */
async function writerChild(file) {
  const store = createSqliteStore({ path: file });
  process.send?.('ready');
  for (let index = 0; ; index += 1) await store.append('aircraft', batch(index));
}

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!process.argv.includes('--json')) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-qa-history-'));
  try {
    // 1. load and budgets
    const file = path.join(directory, 'load.sqlite');
    const store = createSqliteStore({ path: file });
    for (let index = 0; index < 400; index += 1) await store.append('aircraft', batch(index));
    const rows = 400 * BATCH;
    const slice = await timed(() => store.slice('aircraft', { t: T0 + 200 * MIN, windowMs: 15 * MIN, bbox: { west: -60, south: -45, east: 60, north: 45 } }));
    record('slice budget', slice.ms <= BUDGET_MS.slice && slice.value.observations.length > 0, `${slice.ms.toFixed(0)} ms of ${BUDGET_MS.slice}, ${slice.value.observations.length} rows over ${rows}`);
    const coverage = await timed(() => store.coverage('aircraft', { maxGapMs: 2 * MIN }));
    record('coverage budget', coverage.ms <= BUDGET_MS.coverage && coverage.value.count === rows && coverage.value.spans.length === 1, `${coverage.ms.toFixed(0)} ms of ${BUDGET_MS.coverage}`);
    const snaps = await timed(() => store.snapshots('aircraft', { limit: 400 }));
    record('snapshots budget', snaps.ms <= BUDGET_MS.snapshots && snaps.value.snapshots.length === 400, `${snaps.ms.toFixed(0)} ms of ${BUDGET_MS.snapshots}`);

    // 3. a read transaction held open on a second connection neither blocks the
    //    writer nor sees its commit until it ends (WAL snapshot isolation)
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const journalMode = (await store.health()).journalMode;
    record('journal mode is WAL', journalMode === 'wal', String(journalMode));
    // Outside WAL the held read would stall the writer on a lock this same
    // thread holds, so the check is skipped; the run has already failed above.
    if (journalMode === 'wal') {
    const reader = new DatabaseSync(file);
    const countRows = () => Number(reader.prepare('SELECT COUNT(*) AS n FROM observations').get().n);
    reader.exec('BEGIN');
    const before = countRows();
    let writeMs = Infinity;
    try {
      const wrote = await timed(() => store.append('aircraft', batch(400)));
      writeMs = wrote.ms;
    } catch {
      // a blocked writer leaves writeMs infinite and fails the check below
    }
    const during = countRows();
    reader.exec('COMMIT');
    const after = countRows();
    reader.close();
    record(
      'open reader does not block the writer and keeps its snapshot',
      writeMs < 1000 * SCALE && during === before && after === before + BATCH,
      `write ${writeMs.toFixed(0)} ms, rows ${before} -> ${during} (reader open) -> ${after}`,
    );
    }

    // 4. retention
    const now = T0 + 400 * DAY;
    await store.append('vessels', [{ t: now - 40 * DAY, key: 'old' }, { t: now - 3 * DAY, key: 'new' }]);
    const deleted = await applyRetention(store, { feeds: { vessels: { retentionDays: 30 }, aircraft: { retentionDays: 0 } } }, now);
    record('retention removes only expired rows', deleted.vessels === 1 && !('aircraft' in deleted) && (await store.coverage('vessels')).count === 1);
    await store.close();

    // 2. SIGKILL durability
    const killed = path.join(directory, 'killed.sqlite');
    const child = spawn(process.execPath, [SELF, '--writer', killed], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('writer exited early')));
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const reopened = createSqliteStore({ path: killed });
    const count = (await reopened.coverage('aircraft')).count;
    record('database opens after SIGKILL', (await reopened.health()).ok);
    record('only whole batches survive SIGKILL', count > 0 && count % BATCH === 0, `${count} rows`);
    await reopened.close();
    const raw = new DatabaseSync(killed);
    record('integrity_check after SIGKILL', raw.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
    raw.close();

    // 5. unsupported settings stop the boot before disk is touched
    const never = path.join(directory, 'never', 'h.sqlite');
    let refused = false;
    try {
      createHistoryStore({ HISTORY_STORE_AIRCRAFT: 'elasticsearch', HISTORY_SQLITE_PATH: never });
    } catch (error) {
      refused = error.code === 'CONFIG';
    }
    record('unsupported setting refused before any file is created', refused && !existsSync(path.dirname(never)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const failed = checks.filter((check) => !check.ok);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  else console.log(failed.length ? `\n${failed.length} of ${checks.length} checks FAILED` : `\nAll ${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[2] === '--writer') {
  writerChild(process.argv[3]).catch(() => process.exit(2));
} else {
  main().catch((error) => {
    console.error(`qa-history-store crashed: ${error?.code ?? error?.name ?? 'error'}`);
    process.exit(2);
  });
}
