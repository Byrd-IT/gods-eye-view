import { createRequire } from 'node:module';
import { HistoryStoreError } from './common.js';
import { createSqlStore } from './sqlStore.js';

export const mysqlDialect = Object.freeze({
  placeholder: () => '?',
  begin: 'START TRANSACTION',
  insertChunk: 2000,
  // GET_LOCK is per connection and is released with it; init holds one connection.
  lockAcquired: (rows) => Number(Object.values(rows[0] ?? {})[0]) === 1,
  lock: (prefix) => `SELECT GET_LOCK('gev_history_schema_${prefix}', 30)`,
  unlock: (prefix) => `SELECT RELEASE_LOCK('gev_history_schema_${prefix}')`,
  schema: ({ obs, feedsTable, metaTable }) => [
    // The key is VARBINARY: utf8mb4_bin and the other _bin collations pad with
    // spaces when comparing ('abc' equals 'abc '), VARBINARY does not, and its
    // byte order is the one SQLite and PostgreSQL ("C") use. 1024 bytes holds 256
    // characters of any width. Read keys back with decodeKey.
    `CREATE TABLE IF NOT EXISTS ${obs} (
       feed VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       t BIGINT NOT NULL,
       obs_key VARBINARY(1024) NOT NULL,
       lat DOUBLE NULL,
       lon DOUBLE NULL,
       data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
       PRIMARY KEY (feed, t, obs_key),
       KEY ${obs}_by_key (feed, obs_key, t)
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS ${feedsTable} (
       feed VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS ${metaTable} (
       name VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
       value VARCHAR(32) CHARACTER SET ascii NOT NULL
     ) ENGINE=InnoDB`,
  ],
  upsertMeta: (table) =>
    `INSERT INTO ${table} (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
  insertFeed: (table, placeholder) =>
    `INSERT IGNORE INTO ${table} (feed) VALUES (${placeholder})`,
  // VALUES(col) is deprecated since MySQL 8.0.20 (a warning on 8.4) but MariaDB has
  // no alias form, so it is kept on purpose; it works on both.
  upsertObservations: (table, tuples) =>
    `INSERT INTO ${table} (feed, t, obs_key, lat, lon, data) VALUES ${tuples}
     ON DUPLICATE KEY UPDATE lat = VALUES(lat), lon = VALUES(lon), data = VALUES(data)`,
});

/** Load the optional `mysql2` driver; a missing one is a boot-time CONFIG error. */
function loadDriver(load = createRequire(import.meta.url)) {
  try {
    return load('mysql2/promise');
  } catch {
    throw new HistoryStoreError(
      'CONFIG',
      'the mysql history backend needs the optional "mysql2" package; install it with: npm install mysql2',
    );
  }
}

/**
 * MySQL / MariaDB history backend (both speak the protocol `mysql2` implements).
 * The connection string comes from the caller and is never logged or put in an
 * error.
 *
 * @param {{ url: string, tablePrefix?: string, driver?: object, load?: Function, poolSize?: number, dialectOverrides?: object }} options
 */
export function createMysqlStore({
  url,
  tablePrefix,
  driver,
  load,
  poolSize = 4,
  dialectOverrides,
}) {
  if (typeof url !== 'string' || url.trim() === '')
    throw new HistoryStoreError(
      'CONFIG',
      'mysql connection string must be a non-empty string',
    );
  const { createPool } = driver ?? loadDriver(load);
  const pool = createPool({
    uri: url,
    connectionLimit: poolSize,
    connectTimeout: 10_000,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    waitForConnections: true,
  });
  const adapter = {
    async withConnection(fn) {
      const connection = await pool.getConnection();
      let discarded = false;
      try {
        return await fn({
          discard: () => {
            discarded = true;
          },
          query: async (sql, params) => {
            const [result] = await connection.query(sql, params);
            return Array.isArray(result)
              ? { rows: result, affected: 0 }
              : { rows: [], affected: result?.affectedRows ?? 0 };
          },
        });
      } finally {
        if (discarded) connection.destroy();
        else connection.release();
      }
    },
    end: () => pool.end(),
  };
  return createSqlStore({
    backend: 'mysql',
    dialect: dialectOverrides
      ? { ...mysqlDialect, ...dialectOverrides }
      : mysqlDialect,
    adapter,
    tablePrefix,
  });
}
