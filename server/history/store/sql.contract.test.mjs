/**
 * The shared contract, run against real PostgreSQL, MySQL and MariaDB servers.
 *
 * Each server is reached through a GEV_TEST_*_URL variable; CI starts them as
 * service containers. A backend whose variable is unset is skipped, unless
 * GEV_REQUIRE_SQL_BACKENDS=1 (set in CI), which turns a missing server into a
 * failure so the suite cannot pass by skipping everything.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { defineHistoryStoreContract } from './contract.mjs';
import { createMysqlStore } from './mysql.js';
import { createPostgresStore } from './postgres.js';
import { SQL_SCHEMA_VERSION } from './sqlStore.js';

const require = createRequire(import.meta.url);
const T0 = Date.UTC(2026, 0, 1);
const required = process.env.GEV_REQUIRE_SQL_BACKENDS === '1';

const BACKENDS = [
  {
    label: 'postgres',
    variable: 'GEV_TEST_POSTGRES_URL',
    create: createPostgresStore,
    placeholder: (i) => `$${i}`,
    async raw(url) {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: url, max: 1 });
      return {
        run: (sql, params = []) => pool.query(sql, params),
        close: () => pool.end(),
      };
    },
  },
  {
    label: 'mysql',
    variable: 'GEV_TEST_MYSQL_URL',
    create: createMysqlStore,
    placeholder: () => '?',
    raw: rawMysql,
  },
  {
    label: 'mariadb',
    variable: 'GEV_TEST_MARIADB_URL',
    create: createMysqlStore,
    placeholder: () => '?',
    raw: rawMysql,
  },
];

async function rawMysql(url) {
  const { createPool } = require('mysql2/promise');
  const pool = createPool({ uri: url, connectionLimit: 1 });
  return {
    run: (sql, params = []) => pool.query(sql, params),
    close: () => pool.end(),
  };
}

let counter = 0;
const unique = () =>
  `t${process.pid}_${Date.now().toString(36)}_${counter++}`.slice(0, 24);

for (const backend of BACKENDS) {
  const url = process.env[backend.variable];
  if (!url) {
    describe(`history store contract: ${backend.label}`, () => {
      it(`needs ${backend.variable}`, { skip: !required }, () => {
        assert.fail(`${backend.variable} is not set but GEV_REQUIRE_SQL_BACKENDS=1`);
      });
    });
    continue;
  }

  /** A store on its own table set, dropped when closed. */
  const makeStore = (prefix = unique(), options = {}) => {
    const store = backend.create({ url, tablePrefix: prefix, ...options });
    const close = store.close;
    store.close = async () => {
      await close();
      const raw = await backend.raw(url);
      try {
        for (const table of ['observations', 'feeds', 'meta'])
          await raw.run(`DROP TABLE IF EXISTS ${prefix}_${table}`);
      } finally {
        await raw.close();
      }
    };
    store.prefix = prefix;
    return store;
  };

  defineHistoryStoreContract(backend.label, () => makeStore());

  describe(`${backend.label} specifics`, () => {
    it('keeps data across a close and reopen of the same tables', async () => {
      const prefix = unique();
      const first = backend.create({ url, tablePrefix: prefix });
      await first.append('aircraft', [
        { t: T0, key: 'a', lat: 1.5, lon: -2.25, data: { n: 1 } },
      ]);
      await first.close();
      const second = makeStore(prefix);
      try {
        const found = await second.latestBefore('aircraft', { t: T0, key: 'a' });
        assert.deepEqual(found, {
          t: T0,
          key: 'a',
          lat: 1.5,
          lon: -2.25,
          data: { n: 1 },
        });
      } finally {
        await second.close();
      }
    });

    it('lets several stores start on one empty database at once', async () => {
      const prefix = unique();
      const stores = Array.from({ length: 4 }, () =>
        backend.create({ url, tablePrefix: prefix }),
      );
      try {
        await Promise.all(stores.map((store) => store.ready()));
        await Promise.all(
          stores.map((store, i) =>
            store.append('aircraft', [{ t: T0 + i, key: `k${i}`, lat: 0, lon: 0 }]),
          ),
        );
        assert.equal((await stores[0].coverage('aircraft')).count, 4);
      } finally {
        const last = stores.pop();
        for (const store of stores) await store.close();
        last.prefix = prefix;
        const close = last.close;
        await close();
        const raw = await backend.raw(url);
        for (const table of ['observations', 'feeds', 'meta'])
          await raw.run(`DROP TABLE IF EXISTS ${prefix}_${table}`);
        await raw.close();
      }
    });

    it('refuses a database written by a newer schema', async () => {
      const store = makeStore();
      try {
        await store.ready();
        const raw = await backend.raw(url);
        await raw.run(
          `UPDATE ${store.prefix}_meta SET value = ${backend.placeholder(1)} WHERE name = 'schema_version'`,
          [String(SQL_SCHEMA_VERSION + 1)],
        );
        await raw.close();
        const second = backend.create({ url, tablePrefix: store.prefix });
        await assert.rejects(second.ready(), (error) => {
          assert.equal(error.code, 'BACKEND');
          assert.match(error.message, /newer than this build supports/);
          return true;
        });
        await second.close();
      } finally {
        await store.close();
      }
    });

    it('round-trips four-byte characters and keeps byte order of keys', async () => {
      const store = makeStore();
      try {
        const keys = ['Z', 'a', 'é', '😀', '東'];
        await store.append(
          'aircraft',
          keys.map((key) => ({ t: T0, key, lat: 0, lon: 0, data: { key } })),
        );
        const { observations } = await store.slice('aircraft', { t: T0 });
        assert.deepEqual(
          observations.map((row) => row.key),
          [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
        );
        for (const row of observations) assert.equal(row.data.key, row.key);
      } finally {
        await store.close();
      }
    });

    it('treats keys that differ only in case as different keys', async () => {
      const store = makeStore();
      try {
        await store.append('aircraft', [
          { t: T0, key: 'abc', lat: 0, lon: 0 },
          { t: T0, key: 'ABC', lat: 0, lon: 0 },
        ]);
        assert.equal((await store.slice('aircraft', { t: T0 })).observations.length, 2);
      } finally {
        await store.close();
      }
    });

    it('collapses a repeated time and key inside one batch to the last one', async () => {
      const store = makeStore();
      try {
        const result = await store.append('aircraft', [
          { t: T0, key: 'a', lat: 1, lon: 1, data: { v: 1 } },
          { t: T0, key: 'a', lat: 2, lon: 2, data: { v: 2 } },
        ]);
        assert.deepEqual(result, { written: 1 });
        const { observations } = await store.slice('aircraft', { t: T0 });
        assert.deepEqual(observations.map((row) => row.data.v), [2]);
      } finally {
        await store.close();
      }
    });

    it('writes a large batch in several statements', async () => {
      const store = makeStore();
      try {
        const rows = Array.from({ length: 12_000 }, (_, i) => ({
          t: T0,
          key: `k${i}`,
          lat: (i % 180) - 90,
          lon: (i % 360) - 180,
        }));
        assert.deepEqual(await store.append('aircraft', rows), { written: 12_000 });
        assert.equal((await store.coverage('aircraft')).count, 12_000);
      } finally {
        await store.close();
      }
    });

    it('a rejected batch leaves nothing behind (rolls back)', async () => {
      const store = makeStore();
      try {
        await store.append('aircraft', [{ t: T0, key: 'keep', lat: 0, lon: 0 }]);
        const oversized = 'x'.repeat(300);
        await assert.rejects(
          store.append('aircraft', [
            { t: T0 + 1, key: 'good', lat: 0, lon: 0 },
            { t: T0 + 1, key: oversized, lat: 0, lon: 0 },
          ]),
          (error) => error.code === 'INVALID_ARGUMENT',
        );
        assert.equal((await store.coverage('aircraft')).count, 1);
      } finally {
        await store.close();
      }
    });

    it('reports a wrong password without the password, user, host or url', async () => {
      const parsed = new URL(url);
      parsed.password = 'definitely-wrong-SECRET-9f3a';
      const store = backend.create({ url: parsed.href, tablePrefix: unique() });
      try {
        let failure;
        try {
          await store.ready();
        } catch (error) {
          failure = error;
        }
        assert.ok(failure, 'a wrong password must fail');
        assert.equal(failure.code, 'BACKEND');
        const health = await store.health();
        assert.equal(health.ok, false);
        const shown = JSON.stringify([failure.message, health, failure.stack]);
        for (const secret of [
          'definitely-wrong',
          'SECRET-9f3a',
          parsed.hostname,
          // A user named like the backend ("postgres") would match the backend name.
          ['postgres', 'mysql', 'mariadb'].includes(parsed.username) ? '' : parsed.username,
          parsed.href,
        ])
          if (secret) assert.ok(!shown.includes(secret), `leaked ${secret}`);
      } finally {
        await store.close();
      }
    });
  });
}
