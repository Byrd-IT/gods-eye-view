import {
  HistoryStoreError,
  assertFeed,
  assertTime,
  coverageResult,
  coverageSql,
  decodeRow,
  normalizeBatch,
  normalizeCoverageOptions,
  normalizeLatestBefore,
  normalizeSliceOptions,
  normalizeSnapshotOptions,
} from './common.js';

/** Bump when the table layout changes; open refuses a newer database. */
export const SQL_SCHEMA_VERSION = 1;
export const DEFAULT_TABLE_PREFIX = 'gev_history';
const TABLE_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * Only a short error code is ever surfaced from a driver error: the message of a
 * connection failure can carry the host, the user name or part of the URL.
 */
export function driverErrorCode(error) {
  const code = error?.code ?? error?.errno;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)
    ? code
    : typeof code === 'number'
      ? String(code)
      : 'unknown';
}

/** Split rows into statements of at most `max` rows and about 4 MiB of payload. */
function* chunksOf(rows, max) {
  let chunk = [];
  let bytes = 0;
  for (const row of rows) {
    chunk.push(row);
    bytes += Buffer.byteLength(row.json) + Buffer.byteLength(row.key) + 64;
    if (chunk.length >= max || bytes >= 4 * 1024 * 1024) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
  }
  if (chunk.length) yield chunk;
}

export function backendError(backend, action, error) {
  return new HistoryStoreError(
    'BACKEND',
    `${backend} ${action} failed (${driverErrorCode(error)})`,
  );
}

/**
 * Shared logic of the networked SQL backends (PostgreSQL, MySQL/MariaDB). A
 * backend supplies a dialect (placeholders and the few statements that differ)
 * and an adapter around its driver; everything the contract specifies lives here
 * once, so the two cannot drift apart.
 *
 * Observations live in `<prefix>_observations`, with the key column named
 * `obs_key` because KEY is reserved in MySQL. Keys compare byte-wise in both
 * databases (COLLATE "C" / utf8mb4_bin) so `slice` orders exactly as SQLite does.
 *
 * The tables are created on first use under an advisory lock, so two processes
 * starting together cannot race. `ready()` forces that early (a boot check).
 *
 * @param {{
 *   backend: string,
 *   dialect: object,
 *   adapter: { withConnection: Function, end: Function },
 *   tablePrefix?: string,
 * }} options
 */
export function createSqlStore({
  backend,
  dialect,
  adapter,
  tablePrefix = DEFAULT_TABLE_PREFIX,
}) {
  if (
    typeof tablePrefix !== 'string' ||
    !TABLE_PREFIX_PATTERN.test(tablePrefix)
  ) {
    throw new HistoryStoreError(
      'CONFIG',
      'history table prefix must be lowercase letters, digits and _ (starts with a letter; at most 24 characters)',
    );
  }
  const obs = `${tablePrefix}_observations`;
  const feedsTable = `${tablePrefix}_feeds`;
  const metaTable = `${tablePrefix}_meta`;
  const ph = dialect.placeholder;
  let closed = false;
  let readyPromise = null;

  const query = (sql, params = []) =>
    adapter.withConnection((connection) => connection.query(sql, params));

  async function applySchema(connection) {
    for (const statement of dialect.schema({ obs, feedsTable, metaTable }))
      await connection.query(statement, []);
    const found = await connection.query(
      `SELECT value FROM ${metaTable} WHERE name = ${ph(1)}`,
      ['schema_version'],
    );
    const version = found.rows.length ? Number(found.rows[0].value) : 0;
    if (version > SQL_SCHEMA_VERSION) {
      throw new HistoryStoreError(
        'BACKEND',
        `history database schema ${version} is newer than this build supports (${SQL_SCHEMA_VERSION})`,
      );
    }
    if (version !== SQL_SCHEMA_VERSION)
      await connection.query(dialect.upsertMeta(metaTable), [
        'schema_version',
        String(SQL_SCHEMA_VERSION),
      ]);
  }

  async function initialise() {
    await adapter.withConnection(async (connection) => {
      // A transaction-scoped lock (PostgreSQL) is held by one transaction, so
      // it also works behind PgBouncer in transaction-pooling mode, where two
      // statements of a session may run on different server connections.
      if (dialect.transactionLock) {
        await connection.query(dialect.begin, []);
        let rolledBack = true;
        try {
          await connection.query(dialect.lock(tablePrefix), []);
          await applySchema(connection);
          await connection.query('COMMIT', []);
        } catch (error) {
          try {
            await connection.query('ROLLBACK', []);
          } catch {
            rolledBack = false;
          }
          if (!rolledBack) connection.discard();
          throw error;
        }
        return;
      }
      const locked = await connection.query(dialect.lock(tablePrefix), []);
      // A timed-out or failed lock request raises nothing in MySQL; without the
      // lock two starting processes could race on creating the tables.
      if (dialect.lockAcquired && !dialect.lockAcquired(locked.rows))
        throw new HistoryStoreError(
          'BACKEND',
          `${backend} could not take the schema lock`,
        );
      let unlocked = false;
      try {
        await applySchema(connection);
      } finally {
        try {
          await connection.query(dialect.unlock(tablePrefix), []);
          unlocked = true;
        } catch {
          /* handled below */
        }
        // A lock that could not be released lives as long as its session, so
        // that connection must not go back into the pool.
        if (!unlocked) connection.discard();
      }
    });
  }

  function ready() {
    if (closed)
      return Promise.reject(
        new HistoryStoreError('CLOSED', 'history store is closed'),
      );
    if (!readyPromise) {
      readyPromise = initialise().catch((error) => {
        readyPromise = null; // a later call retries once the database is back
        throw error instanceof HistoryStoreError
          ? error
          : backendError(backend, 'open', error);
      });
    }
    return readyPromise;
  }

  const guard = async (action, fn) => {
    if (closed)
      throw new HistoryStoreError('CLOSED', 'history store is closed');
    await ready();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HistoryStoreError) throw error;
      throw backendError(backend, action, error);
    }
  };

  function rangeClause(range, params) {
    let clause = '';
    if (range.from !== undefined) {
      params.push(range.from);
      clause += ` AND t >= ${ph(params.length)}`;
    }
    if (range.to !== undefined) {
      params.push(range.to);
      clause += ` AND t <= ${ph(params.length)}`;
    }
    return clause;
  }

  const decodeObservation = (row) =>
    decodeRow({
      ...row,
      key: Buffer.isBuffer(row.obs_key)
        ? row.obs_key.toString('utf8')
        : row.obs_key,
    });

  /** Rows of one batch with a repeated (t, key) collapsed to the last one. */
  function dedupe(rows) {
    const byId = new Map();
    for (const row of rows) byId.set(`${row.t}\u0000${row.key}`, row);
    return [...byId.values()];
  }

  return {
    backend,
    ready,

    async append(feed, observations) {
      assertFeed(feed);
      const rows = dedupe(normalizeBatch(observations));
      return guard('append', async () => {
        if (rows.length === 0) return { written: 0 };
        await adapter.withConnection(async (connection) => {
          await connection.query(dialect.begin, []);
          let rolledBack = true;
          try {
            await connection.query(dialect.insertFeed(feedsTable, ph(1)), [
              feed,
            ]);
            for (const chunk of chunksOf(rows, dialect.insertChunk)) {
              const params = [];
              const tuples = chunk.map((row) => {
                const first = params.length;
                params.push(feed, row.t, row.key, row.lat, row.lon, row.json);
                return `(${params
                  .slice(first)
                  .map((_, n) => ph(first + n + 1))
                  .join(', ')})`;
              });
              await connection.query(
                dialect.upsertObservations(obs, tuples.join(', ')),
                params,
              );
            }
            await connection.query('COMMIT', []);
          } catch (error) {
            try {
              await connection.query('ROLLBACK', []);
            } catch {
              /* handled below */
              rolledBack = false;
            }
            // A connection that may still hold an open transaction must not be
            // reused: on MySQL the next START TRANSACTION would commit it.
            if (!rolledBack) connection.discard();
            throw error;
          }
        });
        return { written: rows.length };
      });
    },

    async slice(feed, options) {
      assertFeed(feed);
      const { t, windowMs, limit, bbox } = normalizeSliceOptions(options);
      return guard('slice', async () => {
        // Newest observation per key inside the window, chosen by feed and time
        // alone; the box is applied to that newest row afterwards, so a key whose
        // latest position is outside the box never shows an older one inside it.
        const params = [feed, Math.max(0, t - windowMs), t, feed];
        let inBox = '';
        if (bbox) {
          params.push(bbox.south, bbox.north);
          inBox = ` AND o.lat >= ${ph(params.length - 1)} AND o.lat <= ${ph(params.length)}`;
          params.push(bbox.west, bbox.east);
          const west = ph(params.length - 1);
          const east = ph(params.length);
          inBox +=
            bbox.west <= bbox.east
              ? ` AND o.lon >= ${west} AND o.lon <= ${east}`
              : ` AND (o.lon >= ${west} OR o.lon <= ${east})`;
        }
        params.push(limit + 1);
        const { rows } = await query(
          `SELECT o.t, o.obs_key, o.lat, o.lon, o.data
           FROM (SELECT obs_key, MAX(t) AS t FROM ${obs}
                 WHERE feed = ${ph(1)} AND t >= ${ph(2)} AND t <= ${ph(3)} GROUP BY obs_key) newest
           JOIN ${obs} o ON o.feed = ${ph(4)} AND o.t = newest.t AND o.obs_key = newest.obs_key
           WHERE 1 = 1${inBox}
           ORDER BY o.obs_key
           LIMIT ${ph(params.length)}`,
          params,
        );
        return {
          observations: rows.slice(0, limit).map(decodeObservation),
          truncated: rows.length > limit,
        };
      });
    },

    async latestBefore(feed, options) {
      assertFeed(feed);
      const { t, key } = normalizeLatestBefore(options);
      return guard('latestBefore', async () => {
        const { rows } = await query(
          `SELECT t, obs_key, lat, lon, data FROM ${obs}
           WHERE feed = ${ph(1)} AND obs_key = ${ph(2)} AND t <= ${ph(3)}
           ORDER BY t DESC LIMIT 1`,
          [feed, key, t],
        );
        return rows.length ? decodeObservation(rows[0]) : null;
      });
    },

    async snapshots(feed, options) {
      assertFeed(feed);
      const { from, to, limit } = normalizeSnapshotOptions(options);
      return guard('snapshots', async () => {
        const params = [feed];
        const clause = rangeClause({ from, to }, params);
        params.push(limit + 1);
        const { rows } = await query(
          `SELECT t, COUNT(*) AS n FROM ${obs} WHERE feed = ${ph(1)}${clause}
           GROUP BY t ORDER BY t LIMIT ${ph(params.length)}`,
          params,
        );
        return {
          snapshots: rows
            .slice(0, limit)
            .map((row) => ({ t: Number(row.t), count: Number(row.n) })),
          truncated: rows.length > limit,
        };
      });
    },

    async coverage(feed, options) {
      assertFeed(feed);
      const { from, to, maxGapMs } = normalizeCoverageOptions(options);
      return guard('coverage', async () => {
        // The gap comes first: `?` placeholders bind in text order.
        const params = [maxGapMs, feed];
        const clause = rangeClause({ from, to }, params);
        const { rows } = await query(
          coverageSql({
            table: obs,
            feedPlaceholder: ph(2),
            clause,
            gapPlaceholder: ph(1),
          }),
          params,
        );
        return coverageResult(feed, maxGapMs, rows);
      });
    },

    async prune(feed, options) {
      assertFeed(feed);
      const before = assertTime(options?.before, 'before');
      return guard('prune', async () => {
        const result = await query(
          `DELETE FROM ${obs} WHERE feed = ${ph(1)} AND t < ${ph(2)}`,
          [feed, before],
        );
        return { deleted: Number(result.affected) };
      });
    },

    async health() {
      if (closed) return { backend, ok: false, reason: 'closed', feeds: {} };
      try {
        await ready();
        const { rows } = await query(
          `SELECT f.feed AS feed, MIN(o.t) AS first_t, MAX(o.t) AS last_t
           FROM ${feedsTable} f LEFT JOIN ${obs} o ON o.feed = f.feed
           GROUP BY f.feed ORDER BY f.feed`,
        );
        const feeds = {};
        for (const row of rows) {
          feeds[row.feed] = {
            firstT: row.first_t === null ? null : Number(row.first_t),
            lastT: row.last_t === null ? null : Number(row.last_t),
          };
        }
        return { backend, ok: true, schemaVersion: SQL_SCHEMA_VERSION, feeds };
      } catch (error) {
        const failure =
          error instanceof HistoryStoreError
            ? error
            : backendError(backend, 'health', error);
        return { backend, ok: false, reason: failure.message, feeds: {} };
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        await adapter.end();
      } catch {
        /* nothing left to release */
      }
    },
  };
}
