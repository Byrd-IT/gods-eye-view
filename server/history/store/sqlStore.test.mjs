import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadHistoryConfig } from '../config.js';
import { createHistoryStore } from './index.js';
import { createMysqlStore } from './mysql.js';
import { createPostgresStore } from './postgres.js';
import { createSqlStore, driverErrorCode } from './sqlStore.js';

const SECRET = 'S3cr3t-pa55-w0rd';
const PG = `postgres://history_user:${SECRET}@db.internal.example:5432/gev`;
const MY = `mysql://history_user:${SECRET}@db.internal.example:3306/gev`;
const available = ['sqlite', 'mysql', 'postgres'];

const problems = (env) => {
  try {
    loadHistoryConfig(env, { available });
  } catch (error) {
    return error.problems;
  }
  return assert.fail('expected a HistoryConfigError');
};

/** A driver whose every connection fails, with a message that names the secrets. */
const failingPg = {
  Pool: class {
    on() {}
    async connect() {
      const error = new Error(`password authentication failed for ${PG}`);
      error.code = 'ECONNREFUSED';
      throw error;
    }
    async end() {}
  },
};
const failingMysql = {
  createPool: () => ({
    async getConnection() {
      const error = new Error(`Access denied for user 'history_user'@'db.internal.example' using ${SECRET}`);
      error.code = 'ER_ACCESS_DENIED_ERROR';
      throw error;
    },
    async end() {},
  }),
};

describe('sql backend settings', () => {
  it('accepts postgres, mysql and mariadb with their connection strings', () => {
    const config = loadHistoryConfig(
      {
        HISTORY_STORE: 'postgres',
        HISTORY_STORE_AIRCRAFT: 'mariadb',
        HISTORY_POSTGRES_URL: PG,
        HISTORY_MYSQL_URL: MY,
      },
      { available },
    );
    assert.equal(config.defaultStore, 'postgres');
    assert.equal(config.feeds.aircraft.store, 'mysql');
    assert.equal(config.feeds.vessels.store, 'postgres');
    assert.equal(config.postgresUrl, PG);
    assert.equal(config.mysqlUrl, MY);
    assert.equal(config.sqlTablePrefix, 'gev_history');
  });

  it('requires the connection string of a backend a feed uses', () => {
    assert.deepEqual(problems({ HISTORY_STORE: 'postgres' }), [
      'HISTORY_POSTGRES_URL must be set because a feed uses the postgres backend.',
    ]);
    assert.match(problems({ HISTORY_STORE_FIRMS: 'mysql' })[0], /HISTORY_MYSQL_URL must be set/);
  });

  it('rejects a connection string of the wrong kind without quoting it', () => {
    for (const [store, name, value] of [
      ['postgres', 'HISTORY_POSTGRES_URL', MY],
      ['mysql', 'HISTORY_MYSQL_URL', PG],
      ['postgres', 'HISTORY_POSTGRES_URL', `not a url ${SECRET}`],
      ['postgres', 'HISTORY_POSTGRES_URL', `postgres://u:${SECRET}@/db`],
      ['postgres', 'HISTORY_POSTGRES_URL', `postgres://u:${SECRET}@host`],
    ]) {
      const found = problems({ HISTORY_STORE: store, [name]: value });
      assert.equal(found.length, 1);
      assert.match(found[0], new RegExp(`${name} must look like`));
      assert.ok(!found[0].includes(SECRET));
    }
  });

  it('warns when a connection string is set but unused', () => {
    const config = loadHistoryConfig({ HISTORY_POSTGRES_URL: PG }, { available });
    assert.match(config.warnings[0], /HISTORY_POSTGRES_URL is set but no feed uses the postgres backend/);
    assert.equal(config.postgresUrl, undefined);
  });

  it('keeps the connection string out of anything that prints the config', async () => {
    const config = loadHistoryConfig({ HISTORY_STORE: 'postgres', HISTORY_POSTGRES_URL: PG }, { available });
    const util = await import('node:util');
    for (const shown of [JSON.stringify(config), util.inspect(config, { depth: 5 }), String(Object.keys(config))])
      assert.ok(!shown.includes(SECRET) && !shown.includes('db.internal'), shown);
  });

  it('validates the table prefix', () => {
    assert.match(problems({ HISTORY_SQL_TABLE_PREFIX: 'Bad-Prefix;' })[0], /HISTORY_SQL_TABLE_PREFIX must be/);
    assert.equal(loadHistoryConfig({ HISTORY_SQL_TABLE_PREFIX: 'gev2' }, { available }).sqlTablePrefix, 'gev2');
  });

  it('knows the new setting names, so a typo is still an error', () => {
    assert.match(problems({ HISTORY_POSTGRES_URI: PG })[0], /HISTORY_POSTGRES_URI is not a history setting/);
  });

  it('a build without these backends still rejects them at boot', () => {
    assert.throws(
      () => loadHistoryConfig({ HISTORY_STORE: 'postgres', HISTORY_POSTGRES_URL: PG }),
      (error) => error.code === 'CONFIG' && /does not provide/.test(error.message) && !error.message.includes(SECRET),
    );
  });
});

describe('sql backend boot checks', () => {
  it('rejects a missing connection string before touching a driver', () => {
    assert.throws(() => createHistoryStore({ HISTORY_STORE: 'mysql' }), (error) => error.code === 'CONFIG');
  });

  it('names the missing optional driver and how to install it', () => {
    const missing = () => {
      throw Object.assign(new Error(`Cannot find module at ${PG}`), { code: 'MODULE_NOT_FOUND' });
    };
    assert.throws(
      () => createPostgresStore({ url: PG, load: missing }),
      (error) => error.code === 'CONFIG' && /npm install pg/.test(error.message) && !error.message.includes(SECRET),
    );
    assert.throws(
      () => createMysqlStore({ url: MY, load: missing }),
      (error) => error.code === 'CONFIG' && /npm install mysql2/.test(error.message),
    );
  });

  it('rejects an empty connection string', () => {
    assert.throws(() => createPostgresStore({ url: '' }), (error) => error.code === 'CONFIG');
    assert.throws(() => createMysqlStore({ url: ' ' }), (error) => error.code === 'CONFIG');
  });

  it('rejects an unsafe table prefix', () => {
    for (const tablePrefix of ['x; DROP TABLE y', 'A', '1abc', 'a'.repeat(25), '']) {
      assert.throws(
        () => createSqlStore({ backend: 'x', dialect: {}, adapter: {}, tablePrefix }),
        (error) => error.code === 'CONFIG',
        tablePrefix,
      );
    }
  });
});

describe('sql backend errors never carry connection details', () => {
  const probe = async (store) => {
    const seen = [];
    for (const call of [
      () => store.ready(),
      () => store.append('aircraft', [{ t: 1, key: 'a' }]),
      () => store.slice('aircraft', { t: 1 }),
      () => store.coverage('aircraft'),
      () => store.prune('aircraft', { before: 1 }),
    ]) {
      try {
        await call();
        assert.fail('must fail');
      } catch (error) {
        assert.equal(error.code, 'BACKEND');
        seen.push(error.message, String(error.stack), JSON.stringify(error));
      }
    }
    seen.push(JSON.stringify(await store.health()));
    const shown = seen.join('\n');
    for (const secret of [SECRET, 'history_user', 'db.internal', 'example']) {
      assert.ok(!shown.includes(secret), `leaked ${secret}`);
    }
    assert.match(shown, /failed \((ECONNREFUSED|ER_ACCESS_DENIED_ERROR)\)/);
    await store.close();
  };

  it('postgres', async () => probe(createPostgresStore({ url: PG, driver: failingPg })));
  it('mysql', async () => probe(createMysqlStore({ url: MY, driver: failingMysql })));

  it('shows only a plain code from a driver error', () => {
    assert.equal(driverErrorCode({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
    assert.equal(driverErrorCode({ code: 1045 }), '1045');
    assert.equal(driverErrorCode({ code: `bad ${PG}` }), 'unknown');
    assert.equal(driverErrorCode(new Error(PG)), 'unknown');
    assert.equal(driverErrorCode(null), 'unknown');
  });

  it('a closed store answers CLOSED and reports not ok', async () => {
    const store = createPostgresStore({ url: PG, driver: failingPg });
    await store.close();
    await assert.rejects(store.append('aircraft', []), (error) => error.code === 'CLOSED');
    assert.equal((await store.health()).ok, false);
  });
});

describe('sql backend schema lock', () => {
  /** A MySQL driver scripted by statement; records how each connection ends. */
  function scriptedMysql(reply) {
    const ended = [];
    const driver = {
      createPool: () => ({
        async getConnection() {
          return {
            async query(sql) {
              const answer = reply(sql);
              if (answer instanceof Error) throw answer;
              return [answer];
            },
            release: () => ended.push('release'),
            destroy: () => ended.push('destroy'),
          };
        },
        async end() {},
      }),
    };
    return { driver, ended };
  }

  it('fails the start when MySQL does not grant the schema lock', async () => {
    for (const granted of [0, null]) {
      const { driver, ended } = scriptedMysql((sql) =>
        /GET_LOCK/.test(sql) ? [{ 'GET_LOCK(...)': granted }] : [],
      );
      const store = createMysqlStore({ url: MY, driver });
      await assert.rejects(store.ready(), (error) => {
        assert.equal(error.code, 'BACKEND');
        assert.match(error.message, /could not take the schema lock/);
        return true;
      });
      assert.deepEqual(ended, ['release']);
      await store.close();
    }
  });

  it('creates the tables when the lock is granted', async () => {
    const seen = [];
    const { driver } = scriptedMysql((sql) => {
      seen.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/GET_LOCK/.test(sql)) return [{ lock: 1 }];
      if (/SELECT value/.test(sql)) return [];
      return { affectedRows: 0 };
    });
    const store = createMysqlStore({ url: MY, driver });
    await store.ready();
    assert.ok(seen.some((sql) => sql.startsWith('CREATE TABLE IF')));
    assert.ok(seen.at(-1).includes('RELEASE_LOCK'));
    await store.close();
  });

  it('destroys, rather than pools, a MySQL connection whose lock cannot be released', async () => {
    const { driver, ended } = scriptedMysql((sql) => {
      if (/RELEASE_LOCK/.test(sql)) return new Error('connection lost');
      if (/GET_LOCK/.test(sql)) return [{ lock: 1 }];
      if (/SELECT value/.test(sql)) return [];
      return { affectedRows: 0 };
    });
    const store = createMysqlStore({ url: MY, driver });
    await store.ready();
    assert.deepEqual(ended, ['destroy']);
    await store.close();
  });

  it('destroys a PostgreSQL connection whose lock cannot be released', async () => {
    const released = [];
    const driver = {
      Pool: class {
        on() {}
        async connect() {
          return {
            async query(sql) {
              if (/pg_advisory_unlock/.test(sql)) throw new Error('connection lost');
              return { rows: /SELECT value/.test(sql) ? [] : [{}], rowCount: 0 };
            },
            release: (destroy) => released.push(destroy),
          };
        }
        async end() {}
      },
    };
    const store = createPostgresStore({ url: PG, driver });
    await store.ready();
    assert.deepEqual(released, [true]);
    await store.close();
  });

  it('returns a healthy PostgreSQL connection to the pool', async () => {
    const released = [];
    const driver = {
      Pool: class {
        on() {}
        async connect() {
          return {
            async query(sql) {
              return { rows: /SELECT value/.test(sql) ? [] : [{}], rowCount: 0 };
            },
            release: (destroy) => released.push(destroy),
          };
        }
        async end() {}
      },
    };
    const store = createPostgresStore({ url: PG, driver });
    await store.ready();
    assert.deepEqual(released, [false]);
    await store.close();
  });
});

describe('sql backend failed transactions', () => {
  function scripted(rollbackFails) {
    const ended = [];
    const driver = {
      createPool: () => ({
        async getConnection() {
          return {
            async query(sql) {
              if (/GET_LOCK/.test(sql)) return [[{ lock: 1 }]];
              if (/^\s*INSERT INTO \S+_observations/.test(sql)) throw new Error('disk full');
              if (/ROLLBACK/.test(sql) && rollbackFails) throw new Error('connection lost');
              if (/SELECT value/.test(sql)) return [[]];
              return [{ affectedRows: 0 }];
            },
            release: () => ended.push('release'),
            destroy: () => ended.push('destroy')
          };
        },
        async end() {}
      })
    };
    return { driver, ended };
  }

  it('keeps a connection after a clean rollback', async () => {
    const { driver, ended } = scripted(false);
    const store = createMysqlStore({ url: MY, driver });
    await assert.rejects(store.append('aircraft', [{ t: 1, key: 'a' }]), (error) => error.code === 'BACKEND');
    assert.deepEqual(ended.slice(1), ['release']);
    await store.close();
  });

  it('destroys a connection whose rollback failed', async () => {
    const { driver, ended } = scripted(true);
    const store = createMysqlStore({ url: MY, driver });
    await assert.rejects(store.append('aircraft', [{ t: 1, key: 'a' }]), (error) => error.code === 'BACKEND');
    assert.deepEqual(ended.slice(1), ['destroy']);
    await store.close();
  });
});

describe('sql backend settings: sockets', () => {
  it('accepts a PostgreSQL socket directory through the host parameter', () => {
    const config = loadHistoryConfig(
      {
        HISTORY_STORE: 'postgres',
        HISTORY_POSTGRES_URL: 'postgres://history@localhost/gev?host=%2Frun%2Fpostgresql',
      },
      { available },
    );
    assert.equal(config.feeds.aircraft.store, 'postgres');
  });
});
