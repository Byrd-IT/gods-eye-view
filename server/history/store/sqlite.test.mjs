import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { createSqliteStore, SQLITE_SCHEMA_VERSION } from './sqlite.js';

const directory = mkdtempSync(path.join(tmpdir(), 'gev-history-sqlite-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const T0 = Date.UTC(2026, 0, 1);

describe('sqlite history store', () => {
  it('uses the WAL journal and records the schema version', async () => {
    const store = createSqliteStore({ path: path.join(directory, 'wal.sqlite') });
    const health = await store.health();
    assert.equal(health.journalMode, 'wal');
    assert.equal(health.schemaVersion, SQLITE_SCHEMA_VERSION);
    await store.close();
  });

  it('keeps data across a close and reopen', async () => {
    const file = path.join(directory, 'persist.sqlite');
    const first = createSqliteStore({ path: file });
    await first.append('aircraft', [{ t: T0, key: 'a', lat: 1, lon: 2, data: { n: 1 } }]);
    await first.close();
    const second = createSqliteStore({ path: file });
    assert.equal((await second.latestBefore('aircraft', { t: T0, key: 'a' })).data.n, 1);
    await second.close();
  });

  it('creates the missing directory for a nested path', async () => {
    const store = createSqliteStore({ path: path.join(directory, 'a', 'b', 'nested.sqlite') });
    assert.equal((await store.health()).ok, true);
    await store.close();
  });

  it('lets a second connection read while the first writes (WAL)', async () => {
    const file = path.join(directory, 'concurrent.sqlite');
    const writer = createSqliteStore({ path: file });
    await writer.append('aircraft', [{ t: T0, key: 'a', lat: 0, lon: 0 }]);
    const reader = createSqliteStore({ path: file });
    db: {
      const raw = new DatabaseSync(file);
      raw.exec('BEGIN');
      raw.prepare('SELECT COUNT(*) FROM observations').get();
      await writer.append('aircraft', [{ t: T0 + 1, key: 'a', lat: 0, lon: 0 }]);
      raw.exec('COMMIT');
      raw.close();
      break db;
    }
    assert.equal((await reader.coverage('aircraft')).count, 2);
    await reader.close();
    await writer.close();
  });

  it('refuses a database written by a newer schema', async () => {
    const file = path.join(directory, 'newer.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => createSqliteStore({ path: file }), (error) => {
      assert.equal(error.code, 'BACKEND');
      assert.ok(!error.message.includes(directory));
      return true;
    });
  });

  it('reports an unreadable file without quoting its path', () => {
    const file = path.join(directory, 'not-a-database.sqlite');
    writeFileSync(file, 'this is not a sqlite file, '.repeat(200));
    assert.throws(() => createSqliteStore({ path: file }), (error) => {
      assert.equal(error.code, 'BACKEND');
      assert.ok(!error.message.includes(directory), error.message);
      assert.ok(!error.message.includes('not-a-database'), error.message);
      return true;
    });
  });

  it('rejects an empty path', () => {
    assert.throws(() => createSqliteStore({ path: ' ' }), (error) => error.code === 'CONFIG');
  });

  it('upserts a large batch in one transaction', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ t: T0, key: `k${i}`, lat: (i % 180) - 90, lon: (i % 360) - 180 }));
    assert.deepEqual(await store.append('aircraft', rows), { written: 20_000 });
    assert.equal((await store.coverage('aircraft')).count, 20_000);
    await store.close();
  });
});
