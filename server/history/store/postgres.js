import { createRequire } from 'node:module';
import { HistoryStoreError } from './common.js';
import { createSqlStore } from './sqlStore.js';

const dialect = Object.freeze({
  placeholder: (i) => `$${i}`,
  begin: 'BEGIN',
  insertChunk: 5000, // six parameters a row; the protocol allows 65535
  lock: (prefix) =>
    `SELECT pg_advisory_lock(hashtext('gev_history_schema_${prefix}'))`,
  unlock: (prefix) =>
    `SELECT pg_advisory_unlock(hashtext('gev_history_schema_${prefix}'))`,
  schema: ({ obs, feedsTable, metaTable }) => [
    `CREATE TABLE IF NOT EXISTS ${obs} (
       feed TEXT COLLATE "C" NOT NULL,
       t BIGINT NOT NULL,
       obs_key TEXT COLLATE "C" NOT NULL,
       lat DOUBLE PRECISION,
       lon DOUBLE PRECISION,
       data TEXT NOT NULL,
       PRIMARY KEY (feed, t, obs_key))`,
    `CREATE INDEX IF NOT EXISTS ${obs}_by_key ON ${obs} (feed, obs_key, t)`,
    `CREATE TABLE IF NOT EXISTS ${feedsTable} (feed TEXT COLLATE "C" PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS ${metaTable} (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
  upsertMeta: (table) =>
    `INSERT INTO ${table} (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
  insertFeed: (table, placeholder) =>
    `INSERT INTO ${table} (feed) VALUES (${placeholder}) ON CONFLICT DO NOTHING`,
  upsertObservations: (table, tuples) =>
    `INSERT INTO ${table} (feed, t, obs_key, lat, lon, data) VALUES ${tuples}
     ON CONFLICT (feed, t, obs_key) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, data = EXCLUDED.data`,
});

/** Load the optional `pg` driver; a missing one is a boot-time CONFIG error. */
function loadDriver(load = createRequire(import.meta.url)) {
  try {
    return load('pg');
  } catch {
    throw new HistoryStoreError(
      'CONFIG',
      'the postgres history backend needs the optional "pg" package; install it with: npm install pg',
    );
  }
}

/**
 * PostgreSQL history backend. The connection string comes from the caller and is
 * never logged or put in an error.
 *
 * @param {{ url: string, tablePrefix?: string, driver?: object, load?: Function, poolSize?: number }} options
 */
export function createPostgresStore({
  url,
  tablePrefix,
  driver,
  load,
  poolSize = 4,
}) {
  if (typeof url !== 'string' || url.trim() === '')
    throw new HistoryStoreError(
      'CONFIG',
      'postgres connection string must be a non-empty string',
    );
  const { Pool } = driver ?? loadDriver(load);
  const pool = new Pool({
    connectionString: url,
    max: poolSize,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
    application_name: 'gev-history',
  });
  // An idle connection dropped by the server is replaced on demand; the event
  // must be handled or it would crash the process.
  pool.on('error', () => {});
  const adapter = {
    async withConnection(fn) {
      const client = await pool.connect();
      try {
        return await fn({
          query: async (sql, params) => {
            const result = await client.query(sql, params);
            return { rows: result.rows ?? [], affected: result.rowCount ?? 0 };
          },
        });
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
  return createSqlStore({
    backend: 'postgres',
    dialect,
    adapter,
    tablePrefix,
  });
}
